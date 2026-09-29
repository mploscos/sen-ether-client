/**
 * @fileoverview High-level state machine for one joined Sen bus.
 *
 * `SenBus` associates interests, owner-scoped objects, TypeSpecs, state
 * requests and method calls. It consumes validated events from `EtherClient`.
 */

import { EventEmitter } from 'node:events';
import { decodeValue, encodeArguments } from './values.js';
import { senTypeHash } from './type-hash.js';
import { resourceLimitError } from './limits.js';
import { SenInterest } from './sen-interest.js';
import { SenRemoteObject } from './sen-remote-object.js';
import {
    RUNTIME_EVENT_DEDUPE_LIMIT,
    STATE_RESYNC_DELAYS_MS,
    STATE_RESYNC_INTERVAL_MS,
    collectReferencedTypeNames,
    eventOwnerId,
    findTypeSpec,
    remoteObjectKey,
    runtimeEventDedupeKey,
    stateRequestKey
} from './sen-object-helpers.js';

/** Owns high-level objects and interests for one native bus participant. */
export class SenBus extends EventEmitter {
    /**
     * Create high-level state for a joined native bus.
     * @param {import('./sen.js').Sen} sen
     * @param {string} name
     * @param {number} id
     */
    constructor(sen, name, id) {
        super();
        this.sen = sen;
        this.name = name;
        this.id = id;
        this.objectsById = new Map();
        this.typeRegistry = new Map();
        this.typeRegistryByHash = new Map();
        this.requestedTypeHashes = new Set();
        this.stateRequestedObjectIds = new Set();
        this.stateResyncTimers = new Set();
        this.stateResyncInterval = undefined;
        this.interests = new Map();
        this.pendingCalls = new Map();
        this.nextTicketId = 1;
        this.reconnectPrepared = false;
        this.seenRuntimeEvents = new Map();
    }

    /**
     * Start and register a high-level interest.
     * @param {string} query
     * @param {import('../index.js').SenInterestOptions} [options]
     * @returns {SenInterest}
     */
    startInterest(query, options = {}) {
        const started = this.sen.client.startInterest(this.name, query, { id: options.id });
        const interest = new SenInterest(this, started.id, query, options);
        this.interests.set(interest.id, interest);
        return interest;
    }

    /**
     * Stop an interest and detach every object visible only through it.
     * @param {number|SenInterest} id
     */
    stopInterest(id) {
        const interestId = typeof id === 'object' ? id.id : id;
        this.sen.client?.stopInterest(this.id ?? this.name, interestId);
        const interest = this.interests.get(interestId);
        this.#detachInterestObjects(interestId, interest);
        this.interests.delete(interestId);
        if (!this.interests.size) {
            this.#clearStateResyncTimers();
        }
        interest?.closeLocal();
        interest?.emit('close');
    }

    /** Close all interests and leave the native bus. */
    close() {
        const error = new Error('SEN bus closed before method response');
        error.code = 'SEN_BUS_CLOSED';
        this.rejectPendingCalls(error);
        for (const interest of [...this.interests.values()]) {
            try {
                this.stopInterest(interest.id);
            } catch (error) {
                this.#detachInterestObjects(interest.id, interest);
                this.interests.delete(interest.id);
                interest.closeLocal();
                interest.emit('close');
                this.sen.emit('warning', error);
            }
        }
        try {
            this.sen.client?.leaveBus(this.id ?? this.name);
        } catch (error) {
            this.sen.emit('warning', error);
        }
    }

    /** Mark remote state stale and clear connection-bound pending work. */
    prepareReconnect() {
        if (this.reconnectPrepared) {
            return;
        }
        this.reconnectPrepared = true;
        const detail = { reason: 'reconnect' };
        const error = new Error('SEN connection closed before method response');
        error.code = 'SEN_CONNECTION_CLOSED';
        this.rejectPendingCalls(error);
        for (const object of [...this.objectsById.values()]) {
            object.stale = true;
            object.emit('stale', detail);
            this.#removeObjectFromAllInterests(object, detail);
        }
        this.objectsById.clear();
        this.typeRegistry.clear();
        this.typeRegistryByHash.clear();
        this.requestedTypeHashes.clear();
        this.stateRequestedObjectIds.clear();
        this.seenRuntimeEvents.clear();
        this.#clearStateResyncTimers();
        for (const interest of this.interests.values()) {
            interest.closeLocal();
            interest.objectsById.clear();
            interest.emit('stale', detail);
        }
    }

    /**
     * Rejoin the bus and restart existing interests after transport recovery.
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    async rejoin(timeoutMs) {
        const busReadyTimeoutMs = Math.min(timeoutMs, this.sen.options.participantReadyTimeoutMs ?? 1000);
        await this.sen.waitForRemoteBus(this.name, busReadyTimeoutMs).catch(error => {
            this.sen.emit('warning', error);
        });
        const participantReadyTimeoutMs = Math.min(timeoutMs, this.sen.options.participantReadyTimeoutMs ?? 1000);
        const ready = this.sen.createBusParticipantReadyWait(this.name, participantReadyTimeoutMs);
        let joined;
        try {
            joined = await this.sen.client.joinBus(this.name);
        } catch (error) {
            ready.cancel();
            await ready.promise;
            throw error;
        }
        this.id = joined.busId;
        this.reconnectPrepared = false;
        await ready.promise.catch(error => {
            if (error.code === 'SEN_CLIENT_CLOSED') throw error;
            this.sen.emit('warning', error);
        });

        const interests = [...this.interests.values()];
        this.interests.clear();
        for (const interest of interests) {
            const started = this.sen.client.startInterest(this.name, interest.query, { id: interest.options.id ?? interest.id });
            interest.id = started.id;
            interest.resetLocal();
            this.interests.set(interest.id, interest);
            interest.emit('restart', interest);
        }
    }

    /** @returns {SenRemoteObject[]} Current owner-scoped remote objects. */
    objects() {
        return [...this.objectsById.values()];
    }

    /**
     * Find the first remote object matching a public selector.
     * @param {import('../index.js').SenObjectSelector} selector
     * @returns {SenRemoteObject|undefined}
     */
    getObject(selector) {
        return this.objects().find(object => object.matches(selector));
    }

    /** Apply a validated remote publication announcement. */
    handleObjectsPublished(event) {
        const ownerId = eventOwnerId(event);
        const newTypeHashes = new Set();
        for (const discovery of event.discoveries ?? []) {
            const interest = this.interests.get(discovery.interestId);
            if (!interest) {
                continue;
            }
            if (ownerId !== undefined) {
                interest.ownerId ??= ownerId;
                interest.ownerIds.add(ownerId >>> 0);
            }

            for (const info of discovery.objects ?? []) {
                let object = this.#objectByOwnerAndId(ownerId, info.id);
                const isNewObject = !object;
                if (!object) {
                    object = new SenRemoteObject(this, {
                        ...info,
                        ownerId,
                        interestId: discovery.interestId
                    });
                    this.objectsById.set(object.key, object);
                } else {
                    object.attachInterest(discovery.interestId);
                    object.updateDiscoveryInfo({
                        ...info,
                        ownerId
                    });
                }
                this.#attachKnownType(object);
                interest?.objectsById.set(object.key, object);
                object.applyState(info.state?.length ? info.state : Buffer.alloc(0), 'state', info.time, { interestId: discovery.interestId });
                if (!this.requestedTypeHashes.has(info.typeHash)) {
                    this.requestedTypeHashes.add(info.typeHash);
                    newTypeHashes.add(info.typeHash);
                }
                this.#emitObjectWhenReady(interest, object, isNewObject);
            }
        }
        if (newTypeHashes.size) {
            this.sen.client.requestTypes(this.name, newTypeHashes, { ownerId });
        }
        this.#requestReadyObjectStates();
        this.#scheduleStateResyncs();
    }

    /** Remove objects withdrawn for one or more interests. */
    handleObjectsRemoved(event) {
        const ownerId = eventOwnerId(event);
        for (const removal of event.removals ?? []) {
            const interest = this.interests.get(removal.interestId);
            if (!interest) {
                continue;
            }
            for (const id of removal.ids ?? []) {
                const object = this.#objectByOwnerAndId(ownerId, id);
                if (object) {
                    this.#removeObjectFromInterest(object, removal.interestId, interest);
                }
            }
        }
    }

    /** Remove every object owned by a participant that left the bus. */
    handleParticipantLeft(event) {
        const ownerId = event?.participantId;
        if (ownerId === undefined || ownerId === null) {
            return;
        }
        const normalizedOwnerId = ownerId >>> 0;
        const error = new Error('SEN participant left before method response');
        error.code = event?.reason === 'connectionClose'
            ? 'SEN_CONNECTION_CLOSED'
            : 'SEN_PARTICIPANT_LEFT';
        this.rejectPendingCalls(error, pending => pending.ownerId === normalizedOwnerId);
        const detail = { reason: event?.reason ?? 'busLeft', ownerId: normalizedOwnerId };
        for (const object of [...this.objectsById.values()]) {
            if (object.ownerId === normalizedOwnerId) {
                this.#removeObjectFromAllInterests(object, detail);
            }
        }
    }

    #detachInterestObjects(interestId, interest) {
        const normalizedInterestId = interestId >>> 0;
        const keyPrefix = `${normalizedInterestId}:`;
        for (const key of [...this.stateRequestedObjectIds]) {
            if (key.startsWith(keyPrefix)) {
                this.stateRequestedObjectIds.delete(key);
            }
        }

        if (!interest) {
            return;
        }

        for (const object of interest.objectsById.values()) {
            this.#removeObjectFromInterest(object, normalizedInterestId, interest);
        }
        interest.objectsById.clear();
    }

    #resetInterestForOwner(interest, ownerId) {
        const previousOwnerId = interest.ownerId;
        const detail = { reason: 'ownerChanged', ownerId, previousOwnerId };
        for (const object of [...interest.objectsById.values()]) {
            this.#removeObjectFromAllInterests(object, detail);
        }
        interest.objectsById.clear();
        interest.ownerId = ownerId;
        interest.resetLocal();
        interest.emit('stale', detail);
        this.emit('stale', { interest, ...detail });
        this.sen.emit('stale', { bus: this, interest, ...detail });
    }

    #removeObjectFromAllInterests(object, detail = {}) {
        for (const interestId of [...object.interestIds]) {
            this.#removeObjectFromInterest(object, interestId, this.interests.get(interestId), detail);
        }
    }

    #removeObjectFromInterest(object, interestId, interest, detail = {}) {
        const normalizedInterestId = interestId >>> 0;
        this.stateRequestedObjectIds.delete(stateRequestKey(normalizedInterestId, object.ownerId, object.id));
        interest?.objectsById.delete(object.key);
        object.detachInterest(normalizedInterestId);
        object.emit('remove', { interestId: normalizedInterestId, ...detail });
        interest?.emit('remove', object);
        if (object.interestIds.size === 0) {
            this.objectsById.delete(object.key);
            if (![...this.objectsById.values()].some(item => item.typeHash === object.typeHash)) {
                this.requestedTypeHashes.delete(object.typeHash);
            }
            this.emit('remove', object);
            this.sen.emit('remove', object);
        }
    }

    #emitObjectWhenReady(interest, object, emitGlobal) {
        if (!interest) {
            return;
        }
        const publish = () => {
            if (!object.isReadyForInterest(interest.id)) {
                return false;
            }
            if (object.markInterestObjectEmitted(interest.id)) {
                interest.emit('object', object);
            }
            if (emitGlobal && object.markGlobalObjectEmitted()) {
                this.emit('object', object);
                this.sen.emit('object', object);
            }
            return true;
        };

        if (publish()) {
            return;
        }

        const onReady = () => {
            if (publish()) {
                object.off('ready', onReady);
            }
        };
        object.on('ready', onReady);
    }

    /** Cache TypeSpecs and resume objects waiting for their schema. */
    handleTypesInfoResponse(event) {
        const ownerId = eventOwnerId(event);
        const dependentTypeHashes = new Set();
        for (const type of event.types ?? []) {
            this.typeRegistry.set(type.spec.qualifiedName, type.spec);
            if (type.classHash !== undefined) {
                this.typeRegistryByHash.set(type.classHash >>> 0, type.spec);
                for (const object of this.objectsById.values()) {
                    if (object.typeHash === type.classHash) {
                        object.spec = type.spec;
                        object.emit('type', type.spec);
                    }
                }
            }
            for (const hash of type.dependentTypes ?? []) {
                if (!this.requestedTypeHashes.has(hash)) {
                    this.requestedTypeHashes.add(hash);
                    dependentTypeHashes.add(hash);
                }
            }
            this.emit('type', type);
        }
        for (const spec of this.typeRegistry.values()) {
            try {
                this.typeRegistryByHash.set(senTypeHash(spec, this.typeRegistry), spec);
            } catch {
                // A response may arrive before one of its structural dependencies.
            }
        }
        if (dependentTypeHashes.size) {
            this.sen.client.requestTypes(this.name, dependentTypeHashes, { ownerId });
        }
        this.#retryPendingStates();
        this.#requestReadyObjectStates();
        this.#scheduleStateResyncs();
    }

    /** Apply validated full-state responses to their matching interest. */
    handleObjectsStateResponse(event) {
        const ownerId = eventOwnerId(event);
        for (const response of event.responses ?? []) {
            const interest = this.interests.get(response.interestId);
            if (!interest) {
                continue;
            }
            for (const state of response.objectStates ?? []) {
                const object = this.#objectByOwnerAndId(ownerId, state.id);
                if (!object || !interest.objectsById.has(object.key)) {
                    continue;
                }
                object.applyState(state.state, 'state', state.timestamp, { interestId: response.interestId });
            }
        }
    }

    /** Apply a runtime property update to an unambiguous remote object. */
    handleRuntimeObjectUpdate(event) {
        const object = this.#objectByOwnerAndId(eventOwnerId(event), event.update.objectId)
      ?? this.#singleObjectById(event.update.objectId);
        if (!object) {
            return;
        }
        object.applyState(event.update.properties, 'update', event.update.time);
    }

    /** Deduplicate and dispatch runtime events to their producer object. */
    handleRuntimeEvents(event) {
        const ownerId = eventOwnerId(event);
        for (const item of event.events ?? []) {
            if (this.#isDuplicateRuntimeEvent(ownerId, item)) {
                continue;
            }
            const object = this.#objectByOwnerAndId(ownerId, item.producerId)
        ?? this.#singleObjectById(item.producerId);
            if (!object) {
                continue;
            }
            object.emitRuntimeEvent(item);
        }
    }

    #isDuplicateRuntimeEvent(ownerId, item) {
        const key = runtimeEventDedupeKey(ownerId, item);
        if (!key) {
            return false;
        }
        if (this.seenRuntimeEvents.has(key)) {
            return true;
        }
        this.seenRuntimeEvents.set(key, true);
        if (this.seenRuntimeEvents.size > RUNTIME_EVENT_DEDUPE_LIMIT) {
            this.seenRuntimeEvents.delete(this.seenRuntimeEvents.keys().next().value);
        }
        return false;
    }

    /** Resolve or reject the pending call identified by a response ticket. */
    handleRuntimeMethodResponse(event) {
        const response = event.response;
        const pending = this.#takePendingCall(response.ticketId);
        if (!pending) {
            return;
        }

        if (response.result !== 'success') {
            const error = new Error(response.error || response.result);
            error.code = `SEN_${response.result}`;
            pending.reject(error);
            return;
        }

        try {
            if (!pending.method.returnType || pending.method.returnType === 'void') {
                pending.resolve(undefined);
                return;
            }
            pending.resolve(decodeValue(
                response.returnValue,
                pending.method.returnType,
                this.typeRegistry,
                { resourceLimits: this.sen.options.resourceLimits }
            ));
        } catch (error) {
            pending.reject(error);
        }
    }

    /**
     * Wait until all structural TypeSpecs needed by a method are available.
     * @param {Iterable<string>} typeNames
     * @param {{timeout?:number}} [options]
     * @returns {Promise<void>}
     */
    async waitForReferencedTypes(typeNames, options = {}) {
        const timeoutMs = options.timeout ?? 3000;
        const missingTypeNames = () => {
            const required = collectReferencedTypeNames(typeNames, this.typeRegistry);
            return [...required].filter(typeName => !findTypeSpec(this.typeRegistry, typeName));
        };
        let missing = missingTypeNames();
        if (!missing.length) return;

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.off('type', onType);
                reject(new Error(`timeout waiting for SEN type dependencies: ${missing.join(', ')}`));
            }, timeoutMs);
            const onType = () => {
                missing = missingTypeNames();
                if (!missing.length) {
                    clearTimeout(timeout);
                    this.off('type', onType);
                    resolve();
                    return;
                }
            };
            this.on('type', onType);
        });
    }

    /** Encode and send one remote method call with a bounded pending ticket. */
    callObjectMethod(object, method, args, options = {}) {
        const maxPending = this.sen.options.resourceLimits?.maxPendingMethodCallsPerBus ?? 16_384;
        if (this.pendingCalls.size >= maxPending) {
            throw resourceLimitError('pending method call count per bus', maxPending, this.pendingCalls.size + 1);
        }
        const ticketId = this.nextTicketId++ >>> 0;
        const timeoutMs = options.timeout ?? this.sen.options.methodTimeout ?? 5000;
        const argumentsBuffer = encodeArguments(args, method.args, this.typeRegistry);

        return new Promise((resolve, reject) => {
            const pending = { resolve, reject, timeout: undefined, timeoutMs, method, ownerId: object.ownerId };
            if (timeoutMs !== 0) {
                pending.timeout = setTimeout(() => {
                    if (this.pendingCalls.get(ticketId) !== pending) {
                        return;
                    }
                    this.pendingCalls.delete(ticketId);
                    const error = new Error(`timeout waiting for SEN method ${method.name} response`);
                    error.code = 'SEN_METHOD_TIMEOUT';
                    error.method = method.name;
                    error.timeout = timeoutMs;
                    reject(error);
                }, timeoutMs);
                pending.timeout.unref?.();
            }
            this.pendingCalls.set(ticketId, pending);
            try {
                this.sen.client.sendRuntimeMethodCall(this.name, {
                    to: object.ownerId,
                    objectId: object.id,
                    methodId: method.id,
                    ticketId,
                    confirmed: method.transportMode === 'confirmed' || options.confirmed,
                    argumentsBuffer
                });
            } catch (error) {
                this.#takePendingCall(ticketId);
                reject(error);
            }
        });
    }

    #takePendingCall(ticketId) {
        const pending = this.pendingCalls.get(ticketId);
        if (!pending) {
            return undefined;
        }
        clearTimeout(pending.timeout);
        this.pendingCalls.delete(ticketId);
        return pending;
    }

    /**
     * Reject and remove matching method calls still waiting for a response.
     * @param {Error} error
     * @param {(pending:object) => boolean} [predicate]
     */
    rejectPendingCalls(error, predicate = () => true) {
        const pendingCalls = [...this.pendingCalls.keys()]
            .filter(ticketId => predicate(this.pendingCalls.get(ticketId)))
            .map(ticketId => this.#takePendingCall(ticketId));
        for (const pending of pendingCalls) {
            pending.reject(error);
        }
    }

    #requestReadyObjectStates(options = {}) {
        const force = options.force === true;
        const requestsByOwner = new Map();
        for (const interest of this.interests.values()) {
            for (const object of interest.objectsById.values()) {
                if (!object.spec) {
                    continue;
                }
                const key = stateRequestKey(interest.id, object.ownerId, object.id);
                if (!force && this.stateRequestedObjectIds.has(key)) {
                    continue;
                }
                this.stateRequestedObjectIds.add(key);
                const requestsByInterest = requestsByOwner.get(object.ownerId) ?? new Map();
                requestsByOwner.set(object.ownerId, requestsByInterest);
                const ids = requestsByInterest.get(interest.id) ?? [];
                ids.push(object.id);
                requestsByInterest.set(interest.id, ids);
            }
        }

        if (requestsByOwner.size && this.sen.client) {
            for (const [ownerId, requestsByInterest] of requestsByOwner) {
                try {
                    this.sen.client.requestObjectStates(
                        this.name,
                        [...requestsByInterest].map(([interestId, objectIds]) => ({ interestId, objectIds })),
                        { ownerId }
                    );
                } catch (error) {
                    this.sen.emit('warning', error);
                }
            }
        }
    }

    #scheduleStateResyncs() {
        if (!this.interests.size || this.stateResyncTimers.size) {
            return;
        }

        for (const delayMs of STATE_RESYNC_DELAYS_MS) {
            const timer = setTimeout(() => {
                this.stateResyncTimers.delete(timer);
                try {
                    this.#requestReadyObjectStates({ force: true });
                } catch (error) {
                    this.sen.emit('warning', error);
                }
            }, delayMs);
            timer.unref?.();
            this.stateResyncTimers.add(timer);
        }
        const interval = setInterval(() => {
            try {
                this.#requestReadyObjectStates({ force: true });
            } catch (error) {
                this.sen.emit('warning', error);
            }
        }, STATE_RESYNC_INTERVAL_MS);
        interval.unref?.();
        this.stateResyncInterval = interval;
        this.stateResyncTimers.add(interval);
    }

    #clearStateResyncTimers() {
        for (const timer of this.stateResyncTimers) {
            clearTimeout(timer);
        }
        this.stateResyncTimers.clear();
        this.stateResyncInterval = undefined;
    }

    #retryPendingStates() {
        for (const object of this.objectsById.values()) {
            const pendingStates = object.pendingStates.splice(0);
            for (const pendingState of pendingStates) {
                object.applyState(
                    pendingState.buffer,
                    pendingState.source,
                    pendingState.timestampNs,
                    { interestId: pendingState.interestId }
                );
            }
        }
    }

    #attachKnownType(object) {
        if (object.spec) {
            return;
        }
        const specByHash = this.typeRegistryByHash.get(object.typeHash >>> 0);
        if (specByHash) {
            object.spec = specByHash;
            object.emit('type', specByHash);
            return;
        }
        for (const spec of this.typeRegistry.values()) {
            try {
                const hash = senTypeHash(spec, this.typeRegistry);
                if (hash === object.typeHash) {
                    this.typeRegistryByHash.set(hash, spec);
                    object.spec = spec;
                    object.emit('type', spec);
                    return;
                }
            } catch {
                // Keep waiting until all structural dependencies are registered.
            }
        }
    }

    #objectByOwnerAndId(ownerId, objectId) {
        if (ownerId !== undefined && ownerId !== null) {
            return this.objectsById.get(remoteObjectKey(ownerId, objectId));
        }
        const id = objectId >>> 0;
        return [...this.objectsById.values()].find(object => object.id === id);
    }

    #singleObjectById(objectId) {
        const id = objectId >>> 0;
        const matches = [...this.objectsById.values()].filter(object => object.id === id);
        return matches.length === 1 ? matches[0] : undefined;
    }
}
