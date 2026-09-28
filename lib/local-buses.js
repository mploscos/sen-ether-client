/**
 * @fileoverview Lifecycle of buses joined by the local JavaScript participant.
 *
 * This registry owns bus state and local interest IDs. It does not decode or
 * route incoming frames; encoded control messages are handed to the transport
 * callbacks supplied by `EtherClient`.
 */

import { crc32 } from './crc32.js';
import { randomUInt32 } from './ether-network.js';
import { resourceLimitError } from './limits.js';

/** Owns locally joined buses and interests. */
export class LocalBuses {
    #buses;
    #emit;
    #isStarted;
    #nextInterestId;
    #openMulticast;
    #options;
    #participants;
    #sendBusControl;
    #sendProcessControl;

    /**
     * @param {object} context
     * @param {Map<number, object>} context.buses Shared public bus-state map.
     * @param {() => object} context.options Returns current client options and limits.
     * @param {() => boolean} context.isStarted Whether a listener or connection exists.
     * @param {(bus:object) => Promise<void>} context.openMulticast Opens native bus multicast.
     * @param {(message:object) => void} context.sendProcessControl Sends Ether control to all peers.
     * @param {(bus:object, connection:object, message:object, routing?:object) => void} context.sendBusControl
     * @param {(busId:number) => object[]} context.participants Returns remote bus participants.
     * @param {(name:string, detail:object) => void} context.emit Emits an `EtherClient` event.
     */
    constructor(context) {
        this.#buses = context.buses;
        this.#options = context.options;
        this.#isStarted = context.isStarted;
        this.#openMulticast = context.openMulticast;
        this.#sendProcessControl = context.sendProcessControl;
        this.#sendBusControl = context.sendBusControl;
        this.#participants = context.participants;
        this.#emit = context.emit;
        this.#nextInterestId = randomUInt32();
    }

    /** Join and announce one bus, returning the local participant identity. */
    async join(busName, options = {}) {
        if (!this.#isStarted()) {
            throw new Error('EtherClient is not connected or started');
        }

        const busId = crc32(busName);
        const existing = this.#buses.get(busId);
        if (existing) {
            return this.#summary(existing);
        }
        const bus = {
            busName,
            busId,
            participantId: options.participantId ?? randomUInt32(),
            nextInterestGeneration: 1,
            readyRemoteParticipants: new Set(),
            interests: new Map(),
            sentInterestGenerations: new Map(),
            remoteInterests: new Map(),
            pendingStateRequests: new Map(),
            pendingTypeRequests: new Map(),
            forwardedObjectRoutes: new Map(),
            forwardedObjectConsumers: new Map(),
            pendingTransitCalls: new Map(),
            publishedObjects: new Map(),
            localTypeRegistry: new Map(),
            localTypeResponsesByHash: new Map(),
            multicastSocket: undefined,
            multicastGroup: undefined
        };
        this.#buses.set(busId, bus);
        try {
            if (this.#options().busMulticast !== false) {
                await this.#openMulticast(bus);
            }
        } catch (error) {
            this.#buses.delete(busId);
            throw error;
        }

        this.#sendProcessControl({
            type: 'BusJoined',
            value: { participantId: bus.participantId, busId, busName }
        });
        for (const participant of this.#participants(busId)) {
            this.#sendBusControl(bus, participant.connection, {
                type: 'RemoteParticipantReady',
                value: { id: participant.id }
            });
        }

        const summary = this.#summary(bus);
        this.#emit('busJoinedLocal', summary);
        return summary;
    }

    /** Start one idempotent native interest on a joined bus. */
    start(bus, query, options = {}) {
        bus.nextInterestGeneration ??= 1;
        bus.sentInterestGenerations ??= new Map();
        bus.pendingStateRequests ??= new Map();
        const id = options.id ?? this.#allocateInterestId(bus, crc32(query));
        const existing = bus.interests.get(id);
        if (existing?.query === query) {
            return { busName: bus.busName, busId: bus.busId, id, query };
        }
        if (existing) {
            throw new Error(`SEN interest id ${id} is already used by a different query`);
        }
        const limit = this.#options().resourceLimits.maxInterestsPerBus;
        if (bus.interests.size >= limit) {
            throw resourceLimitError('local interest count per bus', limit, bus.interests.size + 1);
        }
        const interest = { id, query, generation: bus.nextInterestGeneration++ };
        bus.interests.set(id, interest);
        for (const participant of this.#participants(bus.busId)) {
            this.sendInterest(bus, participant.connection, interest);
        }
        this.#emit('interestStarted', { busName: bus.busName, busId: bus.busId, id, query });
        return { busName: bus.busName, busId: bus.busId, id, query };
    }

    /** Stop one interest and invalidate its pending state requests. */
    stop(bus, id) {
        bus.interests.delete(id);
        for (const key of [...(bus.sentInterestGenerations?.keys() ?? [])]) {
            if (key.endsWith(`:${id >>> 0}`)) {
                bus.sentInterestGenerations.delete(key);
            }
        }
        for (const key of [...(bus.pendingStateRequests?.keys() ?? [])]) {
            if (key.startsWith(`${id >>> 0}:`)) {
                bus.pendingStateRequests.delete(key);
            }
        }
        for (const participant of this.#participants(bus.busId)) {
            this.#sendBusControl(bus, participant.connection, {
                type: 'InterestStopped',
                value: { id }
            });
        }
    }

    /** Leave a bus after stopping all local interests. */
    leave(bus) {
        for (const id of [...bus.interests.keys()]) {
            this.stop(bus, id);
        }
        this.#sendProcessControl({
            type: 'BusLeft',
            value: {
                participantId: bus.participantId,
                busId: bus.busId,
                busName: bus.busName
            }
        });
        this.#buses.delete(bus.busId);
        if (bus.multicastSocket) {
            bus.multicastSocket.close();
            bus.multicastSocket = undefined;
        }
        this.#emit('busLeftLocal', {
            busName: bus.busName,
            busId: bus.busId,
            participantId: bus.participantId
        });
    }

    /** Send all current interests to every known participant for a bus. */
    restartForRemote(bus) {
        for (const participant of this.#participants(bus.busId)) {
            this.restartForConnection(bus, participant.connection);
        }
    }

    /** Send all current interests to one newly ready connection. */
    restartForConnection(bus, connection) {
        for (const interest of bus.interests.values()) {
            this.sendInterest(bus, connection, interest);
        }
    }

    /** Send an interest once per connection generation. */
    sendInterest(bus, connection, interest) {
        if (!connection) {
            return;
        }
        const key = `${connection.generation}:${interest.generation}:${interest.id}`;
        if (bus.sentInterestGenerations.get(key)) {
            return;
        }
        bus.sentInterestGenerations.set(key, true);
        this.#sendBusControl(bus, connection, {
            type: 'InterestStarted',
            value: { query: interest.query, id: interest.id }
        }, {
            reason: 'interest-owner',
            interestId: interest.id,
            generation: interest.generation
        });
    }

    #allocateInterestId(bus, preferredId) {
        const preferred = preferredId >>> 0;
        if (preferred && !bus.interests.has(preferred)) {
            this.#nextInterestId = preferred;
            return preferred;
        }
        for (let attempts = 0; attempts < 0xffff_ffff; attempts += 1) {
            this.#nextInterestId = (this.#nextInterestId + 1) >>> 0;
            const id = this.#nextInterestId || 1;
            if (!bus.interests.has(id)) {
                return id;
            }
        }
        throw new Error('could not allocate a SEN interest id');
    }

    #summary(bus) {
        return {
            busName: bus.busName,
            busId: bus.busId,
            participantId: bus.participantId,
            multicastGroup: bus.multicastGroup,
            multicastPort: this.#options().busMulticastPort
        };
    }
}
