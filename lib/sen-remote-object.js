/**
 * @fileoverview Public proxy for one owner-scoped remote Sen object.
 *
 * The proxy decodes typed state, preserves timestamp ordering and exposes
 * property setters, methods and runtime events without owning transport logic.
 */

import { EventEmitter } from 'node:events';
import { decodeArguments, decodePropertyValues } from './values.js';
import { methodHash } from './hash32.js';
import { resourceLimitError } from './limits.js';
import {
    collectClassMembers,
    findByName,
    normalizeTimestampNs,
    remoteObjectKey,
    senValuesEqual,
    setterName
} from './sen-object-helpers.js';

/** Typed, event-emitting view of a remotely owned Sen object. */
export class SenRemoteObject extends EventEmitter {
    /**
   * @param {import('./sen-bus.js').SenBus} bus
   * @param {{id:number,name:string,className:string,typeHash:number,ownerId?:number,interestId?:number}} info
   */
    constructor(bus, info) {
        super();
        this.bus = bus;
        this.id = info.id;
        this.name = info.name;
        this.className = info.className;
        this.typeHash = info.typeHash;
        this.ownerId = info.ownerId;
        this.interestId = info.interestId;
        this.interestIds = new Set();
        if (info.interestId !== undefined) {
            this.interestIds.add(info.interestId);
        }
        /** @type {Record<string, unknown>} */
        this.snapshot = {};
        this.spec = undefined;
        this.typePromise = undefined;
        this.pendingState = undefined;
        this.pendingStates = [];
        this.readyInterestIds = new Set();
        this.emittedInterestObjectIds = new Set();
        this.emittedGlobalObject = false;
        /** @type {bigint|undefined} */
        this.timestamp = undefined;
        /** @type {bigint|undefined} */
        this.timestampNs = undefined;
        /** @type {bigint|undefined} */
        this.lastObservedTimestamp = undefined;
        /** @type {bigint|undefined} */
        this.lastObservedTimestampNs = undefined;
        /** @type {bigint|undefined} */
        this.lastStateTimestamp = undefined;
        /** @type {bigint|undefined} */
        this.lastStateTimestampNs = undefined;
        /** @type {bigint|undefined} */
        this.lastUpdateTimestamp = undefined;
        /** @type {bigint|undefined} */
        this.lastUpdateTimestampNs = undefined;
        /** @type {Map<string, bigint>} */
        this.propertyTimestamps = new Map();
        /** @type {Map<string, bigint>} */
        this.propertyObservedTimestamps = new Map();
    }

    /** @param {import('../index.js').SenObjectSelector} selector */
    matches(selector) {
        if (typeof selector === 'function') {
            return Boolean(selector(this));
        }
        if (typeof selector === 'number') {
            return this.id === selector;
        }
        return this.name === selector || this.className === selector || String(this.id) === String(selector);
    }

    /** Associate this owner-scoped object with another interest. */
    attachInterest(interestId) {
        if (interestId !== undefined) {
            this.interestIds.add(interestId);
            this.interestId = interestId;
        }
    }

    /** Remove one interest association and its ready/emitted markers. */
    detachInterest(interestId) {
        if (interestId !== undefined) {
            const normalizedInterestId = interestId >>> 0;
            this.interestIds.delete(normalizedInterestId);
            this.readyInterestIds.delete(normalizedInterestId);
            this.emittedInterestObjectIds.delete(normalizedInterestId);
            if (this.interestId === interestId) {
                this.interestId = this.interestIds.values().next().value;
            }
        }
    }

    /** Refresh mutable discovery metadata without replacing object identity. */
    updateDiscoveryInfo(info) {
        this.name = info.name ?? this.name;
        this.className = info.className ?? this.className;
        this.typeHash = info.typeHash ?? this.typeHash;
        this.ownerId = info.ownerId ?? this.ownerId;
    }

    /** Find a declared or inherited property by name. */
    property(name) {
        return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'properties'), name);
    }

    /** Find a declared or inherited method by name. */
    method(name) {
        return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'methods'), name);
    }

    /** Find a declared or inherited event by name. */
    event(name) {
        return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'events'), name);
    }

    /**
   * @param {{timeout?:number}} [options]
   * @returns {Promise<object>}
   */
    async waitForType(options = {}) {
        if (this.spec) {
            return this.spec;
        }

        const timeoutMs = options.timeout ?? 3000;
        let timeout;
        try {
            return await Promise.race([
                this.#waitForTypeReady(),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => {
                        reject(new Error(`timeout waiting for SEN type ${this.className}`));
                    }, timeoutMs);
                    timeout.unref?.();
                })
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }

    #waitForTypeReady() {
        if (this.spec) {
            return Promise.resolve(this.spec);
        }
        if (this.typePromise) {
            return this.typePromise;
        }
        this.typePromise = new Promise(resolve => {
            const onType = spec => {
                this.off('type', onType);
                this.typePromise = undefined;
                resolve(spec);
            };
            this.on('type', onType);
        });
        return this.typePromise;
    }

    /**
   * @param {string} name
   * @returns {Promise<unknown>}
   */
    async get(name) {
        return this.snapshot[name];
    }

    /** Return the timestamp of the last value-changing update for a property. */
    getPropertyTimestamp(name) {
        return this.propertyTimestamps.get(name);
    }

    /** Return the newest observed timestamp, including unchanged values. */
    getPropertyObservedTimestamp(name) {
        return this.propertyObservedTimestamps.get(name);
    }

    get key() {
        return remoteObjectKey(this.ownerId, this.id);
    }

    isReadyForInterest(interestId) {
        return this.readyInterestIds.has(interestId >>> 0);
    }

    markInterestObjectEmitted(interestId) {
        const normalizedInterestId = interestId >>> 0;
        if (this.emittedInterestObjectIds.has(normalizedInterestId)) {
            return false;
        }
        this.emittedInterestObjectIds.add(normalizedInterestId);
        return true;
    }

    markGlobalObjectEmitted() {
        if (this.emittedGlobalObject) {
            return false;
        }
        this.emittedGlobalObject = true;
        return true;
    }

    /**
   * @param {string} name
   * @param {unknown} value
   * @param {{timeout?:number}} [options]
   * @returns {Promise<void>}
   */
    async set(name, value, options = {}) {
        await this.waitForType(options);
        const property = this.property(name);
        if (!property) {
            throw new Error(`SEN property not found: ${name}`);
        }
        if (!property.category?.endsWith('RW')) {
            throw new Error(`SEN property is read-only: ${this.className}.${name}`);
        }

        const methodName = setterName(property.name);
        await this.bus.callObjectMethod(this, {
            id: methodHash(methodName),
            name: methodName,
            args: [{ name: 'value', type: property.type }],
            returnType: 'void',
            transportMode: property.transportMode
        }, [value], options);
        this.snapshot[name] = value;
    }

    /**
   * @param {string} name
   * @param {unknown[]} [args]
   * @param {{timeout?:number}} [options]
   * @returns {Promise<unknown>}
   */
    async call(name, args = [], options = {}) {
        await this.waitForType(options);
        const method = this.method(name);
        if (!method) {
            throw new Error(`SEN method not found: ${this.className}.${name}`);
        }
        if (method.localOnly) {
            throw new Error(`SEN method is localOnly and cannot be called remotely: ${this.className}.${name}`);
        }
        await this.bus.waitForReferencedTypes([
            ...(method.args ?? []).map(arg => arg.type),
            method.returnType
        ], options);
        return await this.bus.callObjectMethod(this, method, args, options);
    }

    /** Decode and apply a full state or incremental property update buffer. */
    applyState(buffer, source, timestamp, options = {}) {
        const timestampNs = normalizeTimestampNs(timestamp);
        this.#rememberObservationTimestamp(source, timestampNs);

        if (!this.spec) {
            this.#queuePendingState({ buffer, source, timestampNs, interestId: options.interestId });
            return;
        }

        const interests = this.#targetInterests(options.interestId);
        const decodeInterest = options.interestId !== undefined || interests.length === 1 ? interests[0] : undefined;
        const values = decodePropertyValues(buffer, this.spec, this.bus.typeRegistry, decodeInterest?.decodeOptions());
        const appliedInThisState = new Set();
        let complete = true;
        for (const value of values) {
            if (!value.decoded) {
                complete = false;
                continue;
            }
            const previousTimestamp = this.propertyObservedTimestamps.get(value.name);
            if (
                !appliedInThisState.has(value.name)
        && timestampNs !== undefined
        && previousTimestamp !== undefined
        && timestampNs <= previousTimestamp
            ) {
                continue;
            }
            appliedInThisState.add(value.name);
            if (timestampNs !== undefined) {
                this.propertyObservedTimestamps.set(value.name, timestampNs);
            }
            const hadPrevious = Object.prototype.hasOwnProperty.call(this.snapshot, value.name);
            const previous = this.snapshot[value.name];
            if (hadPrevious && senValuesEqual(previous, value.value)) {
                continue;
            }
            this.#rememberChangeTimestamp(timestampNs);
            this.snapshot[value.name] = value.value;
            if (timestampNs !== undefined) {
                this.propertyTimestamps.set(value.name, timestampNs);
            }
            const change = {
                object: this,
                source,
                timestamp: timestampNs,
                timestampNs,
                name: value.name,
                type: value.type,
                value: value.value,
                previous,
                property: value.property
            };
            for (const interest of interests) {
                interest.publishChange(change);
            }
            if (!interests.length) {
                this.emit('change', change);
                this.emit(`change:${value.name}`, change);
                this.bus.emit('change', change);
                this.bus.sen.emit('change', change);
            }
        }

        if (complete) {
            if (source === 'state') {
                this.#markReady(options.interestId);
            }
            if (!this.pendingStates.length) this.pendingState = undefined;
        } else {
            this.#queuePendingState({ buffer, source, timestampNs, interestId: options.interestId });
        }
    }

    #markReady(interestId) {
        if (interestId !== undefined) {
            const normalizedInterestId = interestId >>> 0;
            this.readyInterestIds.add(normalizedInterestId);
            this.emit('ready', { interestId: normalizedInterestId });
            return;
        }
        for (const id of this.interestIds) {
            this.readyInterestIds.add(id >>> 0);
            this.emit('ready', { interestId: id >>> 0 });
        }
    }

    #queuePendingState(state) {
        const limit = this.bus.sen.options?.resourceLimits?.maxPendingStatesPerObject ?? 64;
        if (this.pendingStates.length >= limit) {
            this.pendingStates.shift();
            const error = resourceLimitError('pending state count per object', limit, limit + 1, this.key);
            this.bus.emit?.('warning', error);
            this.bus.sen.emit?.('warning', error);
        }
        this.pendingStates.push(state);
        this.pendingState = state;
    }

    #targetInterests(interestId) {
        if (interestId !== undefined) {
            const interest = this.bus.interests.get(interestId);
            return interest ? [interest] : [];
        }

        const interests = [];
        for (const interest of this.bus.interests.values()) {
            if (interest.objectsById.has(this.key) || interest.objectsById.has(this.id)) {
                interests.push(interest);
            }
        }
        return interests;
    }

    #rememberObservationTimestamp(source, timestampNs) {
        if (timestampNs === undefined) {
            return;
        }
        if (this.lastObservedTimestampNs === undefined || timestampNs > this.lastObservedTimestampNs) {
            this.lastObservedTimestamp = timestampNs;
            this.lastObservedTimestampNs = timestampNs;
        }
        if (source === 'state') {
            if (this.lastStateTimestampNs === undefined || timestampNs > this.lastStateTimestampNs) {
                this.lastStateTimestamp = timestampNs;
                this.lastStateTimestampNs = timestampNs;
            }
        } else if (source === 'update') {
            if (this.lastUpdateTimestampNs === undefined || timestampNs > this.lastUpdateTimestampNs) {
                this.lastUpdateTimestamp = timestampNs;
                this.lastUpdateTimestampNs = timestampNs;
            }
        }
    }

    #rememberChangeTimestamp(timestampNs) {
        if (timestampNs === undefined) {
            return;
        }
        if (this.timestampNs === undefined || timestampNs > this.timestampNs) {
            this.timestamp = timestampNs;
            this.timestampNs = timestampNs;
        }
    }

    /** Decode and dispatch one runtime event to object, interest, bus and Sen. */
    emitRuntimeEvent(item) {
        const eventSpec = collectClassMembers(this.spec, this.bus.typeRegistry, 'events')
            .find(candidate => candidate.id === item.eventId);
        const args = eventSpec
            ? decodeArguments(
                item.argumentsBuffer,
                eventSpec.args,
                this.bus.typeRegistry,
                { resourceLimits: this.bus.sen.options?.resourceLimits }
            )
            : undefined;
        const event = {
            object: this,
            id: item.eventId,
            name: eventSpec?.name,
            creationTime: item.creationTime,
            creationTimeNs: normalizeTimestampNs(item.creationTime),
            args,
            raw: item.argumentsBuffer
        };
        this.emit('event', event);
        if (event.name) {
            this.emit(event.name, event);
        }
        for (const interestId of this.interestIds) {
            this.bus.interests.get(interestId)?.emit('event', event);
        }
        this.bus.emit('event', event);
        this.bus.sen.emit('event', event);
    }
}
