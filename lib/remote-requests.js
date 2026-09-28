/**
 * @fileoverview Tracks owner-scoped Sen type and object-state requests.
 *
 * A response is accepted only when its owner, connection generation and
 * interest generation still match the request that created it. This module is
 * the implementation boundary for those routing invariants.
 */

import { resourceLimitError } from './limits.js';

/** Coordinates bounded requests to remote bus participants. */
export class RemoteRequests {
    #emit;
    #limit;
    #resolveParticipant;
    #sendControl;
    #trace;

    /**
     * @param {object} options
     * @param {() => number} options.limit Returns the current maximum pending requests per bus.
     * @param {(bus:object, ownerId:number|undefined, operation:string) => object} options.resolveParticipant
     * @param {(bus:object, connection:object, message:object, routing?:object) => void} options.sendControl
     * @param {(record:object) => void} options.trace
     * @param {(name:string, detail:object) => void} options.emit
     */
    constructor(options) {
        this.#limit = options.limit;
        this.#resolveParticipant = options.resolveParticipant;
        this.#sendControl = options.sendControl;
        this.#trace = options.trace;
        this.#emit = options.emit;
    }

    /** Request TypeSpecs from one explicit or unambiguous owner. */
    requestTypes(bus, typeHashes, options = {}) {
        const requests = [...new Set([...typeHashes].map(value => value >>> 0))];
        if (!requests.length) {
            return { busName: bus.busName, busId: bus.busId, requests };
        }

        const participant = this.#resolveParticipant(bus, options.ownerId, 'type request');
        const additions = requests.filter(typeHash => (
            !bus.pendingTypeRequests.has(`${participant.id}:${typeHash}`)
        )).length;
        this.#assertCapacity(bus.pendingTypeRequests, additions, 'pending type request count per bus');
        this.#sendControl(bus, participant.connection, {
            type: 'TypesInfoRequest',
            value: { ownerId: participant.id, requests }
        }, { reason: 'type-owner', ownerId: participant.id, typeHashes: requests });
        for (const typeHash of requests) {
            bus.pendingTypeRequests.set(`${participant.id}:${typeHash}`, {
                typeHash,
                ownerId: participant.id,
                connection: participant.connection,
                generation: participant.connection.generation
            });
        }
        const result = { busName: bus.busName, busId: bus.busId, ownerId: participant.id, requests };
        this.#emit('typesInfoRequested', result);
        return result;
    }

    /** Request current object state, grouped by local interest. */
    requestObjectStates(bus, requests, options = {}) {
        const normalized = requests
            .map(request => ({
                interestId: request.interestId >>> 0,
                objectIds: [...new Set((request.objectIds ?? []).map(value => value >>> 0))]
            }))
            .filter(request => request.objectIds.length);
        if (!normalized.length) {
            return { busName: bus.busName, busId: bus.busId, requests: normalized };
        }

        const participant = this.#resolveParticipant(bus, options.ownerId, 'object state request');
        const additions = normalized.reduce((total, request) => total + request.objectIds.filter(objectId => (
            !bus.pendingStateRequests.has(`${request.interestId}:${participant.id}:${objectId}`)
        )).length, 0);
        this.#assertCapacity(bus.pendingStateRequests, additions, 'pending object state request count per bus');
        this.#sendControl(bus, participant.connection, {
            type: 'ObjectsStateRequest',
            value: { ownerId: participant.id, requests: normalized }
        }, { reason: 'object-owner', ownerId: participant.id });
        for (const request of normalized) {
            const interest = bus.interests.get(request.interestId);
            for (const objectId of request.objectIds) {
                bus.pendingStateRequests.set(`${request.interestId}:${participant.id}:${objectId}`, {
                    ownerId: participant.id,
                    connection: participant.connection,
                    connectionGeneration: participant.connection.generation,
                    interestGeneration: interest?.generation
                });
            }
        }
        const result = { busName: bus.busName, busId: bus.busId, ownerId: participant.id, requests: normalized };
        this.#emit('objectsStateRequested', result);
        return result;
    }

    /** Validate and emit an `ObjectsStateResponse`. */
    acceptObjectStates(bus, frame, value, connection) {
        const providerId = frame.to >>> 0;
        const responses = [];
        for (const response of value.responses ?? []) {
            const interest = bus.interests.get(response.interestId >>> 0);
            if (!interest) {
                this.#traceDiscardedState(bus, connection, providerId, value, response);
                continue;
            }
            const objectStates = [];
            for (const state of response.objectStates ?? []) {
                const key = `${response.interestId >>> 0}:${providerId}:${state.id >>> 0}`;
                const pending = bus.pendingStateRequests.get(key);
                const current = pending
                    && pending.connection === connection
                    && pending.connectionGeneration === connection?.generation
                    && pending.interestGeneration === interest.generation;
                if (!current) {
                    this.#traceDiscardedState(bus, connection, providerId, value, {
                        interestId: response.interestId,
                        objectStates: [state]
                    });
                    continue;
                }
                bus.pendingStateRequests.delete(key);
                objectStates.push(state);
            }
            if (objectStates.length) {
                responses.push({ ...response, objectStates });
            }
        }
        if (responses.length) {
            this.#emit('objectsStateResponse', {
                bus,
                connection,
                ...value,
                responses,
                requestOwnerId: value.ownerId,
                ownerId: providerId,
                providerId,
                generation: connection?.generation
            });
        }
    }

    /** Validate and emit a `TypesInfoResponse`. */
    acceptTypes(bus, frame, value, connection) {
        const providerId = frame.to >>> 0;
        const current = [...bus.pendingTypeRequests.values()].some(pending => (
            pending.ownerId === providerId
            && pending.connection === connection
            && pending.generation === connection?.generation
        ));
        if (!current) {
            this.#trace({
                direction: 'in',
                connection,
                message: 'TypesInfoResponse',
                busId: bus.busId,
                participantId: providerId,
                ownerId: value.ownerId,
                generation: connection?.generation,
                reason: 'stale-or-unrequested-types',
                discarded: true
            });
            return;
        }
        for (const type of value.types ?? []) {
            if (type.classHash !== undefined) {
                bus.pendingTypeRequests.delete(`${providerId}:${type.classHash >>> 0}`);
            }
        }
        this.#emit('typesInfoResponse', {
            bus,
            connection,
            ...value,
            requestOwnerId: value.ownerId,
            ownerId: providerId,
            providerId,
            generation: connection?.generation
        });
    }

    /** Validate and emit a `TypesInfoRejection`. */
    acceptTypeRejections(bus, frame, value, connection) {
        const providerId = frame.to >>> 0;
        const rejections = (value.rejections ?? []).filter(rejection => {
            const key = `${providerId}:${Number(rejection) >>> 0}`;
            const pending = bus.pendingTypeRequests.get(key);
            const current = pending
                && pending.ownerId === providerId
                && pending.connection === connection
                && pending.generation === connection?.generation;
            if (current) {
                bus.pendingTypeRequests.delete(key);
            }
            return current;
        });
        if (rejections.length) {
            this.#emit('typesInfoRejection', {
                bus,
                connection,
                ...value,
                rejections,
                requestOwnerId: value.ownerId,
                ownerId: providerId,
                providerId,
                generation: connection?.generation
            });
        }
    }

    #assertCapacity(map, additions, resource) {
        const limit = this.#limit();
        if (map.size + additions > limit) {
            throw resourceLimitError(resource, limit, map.size + additions);
        }
    }

    #traceDiscardedState(bus, connection, providerId, value, response) {
        this.#trace({
            direction: 'in',
            connection,
            message: 'ObjectsStateResponse',
            busId: bus.busId,
            participantId: providerId,
            ownerId: value.ownerId,
            interestId: response.interestId,
            objectIds: (response.objectStates ?? []).map(state => state.id),
            generation: connection?.generation,
            reason: 'stale-or-unrequested-state',
            discarded: true
        });
    }
}
