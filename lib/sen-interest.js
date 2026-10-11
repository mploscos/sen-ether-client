/** @fileoverview Public interest collection, waiting and change delivery API. */

import { EventEmitter } from 'node:events';
import { ChangeBatcher } from './change-batcher.js';
import { normalizePropertyNames, selectorDescription } from './sen-object-helpers.js';

/** Represents one active native Sen interest and its visible remote objects. */
export class SenInterest extends EventEmitter {
    /**
   * @param {import('./sen-bus.js').SenBus} bus
   * @param {number} id
   * @param {string} query
   * @param {import('../index.js').SenInterestOptions} [options]
   */
    constructor(bus, id, query, options = {}) {
        super();
        this.bus = bus;
        this.id = id;
        this.query = query;
        this.ownerId = undefined;
        this.ownerIds = new Set();
        this.state = 'active';
        this.options = { ...options };
        this.propertyNames = normalizePropertyNames(options.properties ?? options.propertyNames);
        this.changeMode = options.changeMode ?? (options.batch ? 'batch' : 'individual');
        if (!['individual', 'batch', 'both'].includes(this.changeMode)) {
            throw new Error(`invalid SEN interest changeMode: ${this.changeMode}`);
        }
        this.batcher = this.changeMode === 'individual' ? undefined : new ChangeBatcher(this, options);
        this.objectsById = new Map();
    }

    /** @returns {import('./sen-remote-object.js').SenRemoteObject[]} */
    objects() {
        return [...this.objectsById.values()];
    }

    /**
     * Look up one currently visible object by its SEN name.
     * @param {string} name
     * @returns {import('./sen-remote-object.js').SenRemoteObject|undefined}
     */
    objectByName(name) {
        return this.get(name);
    }

    /**
     * Subscribe to the live object collection and replay current objects.
     * The returned cancel function is idempotent.
     */
    /** @param {(object: import('./sen-remote-object.js').SenRemoteObject) => void} handler @returns {import('../index.js').SenCancel} */
    onObjectAdded(handler) {
        this.on('object', handler);
        for (const object of this.objects()) {
            handler(object);
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.off('object', handler);
        };
    }

    /** Subscribe to removals from the live object collection. */
    /** @param {(object: import('./sen-remote-object.js').SenRemoteObject, detail: {reason?: string, ownerId?: number, previousOwnerId?: number}) => void} handler @returns {import('../index.js').SenCancel} */
    onObjectRemoved(handler) {
        this.on('remove', handler);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.off('remove', handler);
        };
    }

    /** Subscribe to exact object commits rather than interval-based batches. */
    /** @param {(commit: import('../index.js').SenCommit) => void} handler @returns {import('../index.js').SenCancel} */
    onChanges(handler) {
        this.on('commit', handler);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.off('commit', handler);
        };
    }

    /**
     * Read snapshots for many visible objects without issuing per-property calls.
     * Native Ether objects are emitted only after their initial state is decoded,
     * so their local snapshots are authoritative for this operation.
     */
    /**
     * @param {{objectNames?: string[], propertyNames?: string[]}} [options]
     * @returns {Promise<import('../index.js').SenObjectBatchState[]>}
     */
    async getObjectsBatchState(options = {}) {
        const objectNames = options.objectNames ? new Set(options.objectNames.map(String)) : undefined;
        const propertyNames = options.propertyNames ? new Set(options.propertyNames.map(String)) : undefined;
        return this.objects()
            .filter(object => !objectNames || objectNames.has(object.name))
            .map(object => {
                const properties = {};
                for (const [name, value] of Object.entries(object.snapshot)) {
                    if (!propertyNames || propertyNames.has(name)) properties[name] = value;
                }
                return {
                    key: object.key,
                    name: object.name,
                    className: object.className,
                    properties,
                    errors: {}
                };
            });
    }

    /**
   * @param {import('../index.js').SenObjectSelector} selector
   * @returns {import('./sen-remote-object.js').SenRemoteObject|undefined}
   */
    get(selector) {
        return this.objects().find(object => object.matches(selector));
    }

    /**
   * @param {import('../index.js').SenObjectSelector} selector
   * @param {{timeout?:number}} [options]
   * @returns {Promise<import('./sen-remote-object.js').SenRemoteObject>}
   */
    async waitFor(selector, options = {}) {
        const existing = this.get(selector);
        if (existing) {
            return existing;
        }

        const timeoutMs = options.timeout ?? this.bus.sen.options.timeout ?? 3000;
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.off('object', onObject);
                reject(new Error(`timeout waiting for SEN object ${selectorDescription(selector)}`));
            }, timeoutMs);
            const onObject = object => {
                if (!object.matches(selector)) {
                    return;
                }
                clearTimeout(timeout);
                this.off('object', onObject);
                resolve(object);
            };
            this.on('object', onObject);
        });
    }

    /** Stop the native interest and close local batching state. */
    close() {
        if (this.state === 'released') return;
        this.bus.stopInterest(this.id);
    }

    /** Alias used by handle-oriented consumers. */
    async release() {
        this.close();
    }

    /** Release only local batching resources during reconnect or shutdown. */
    closeLocal() {
        this.batcher?.close();
    }

    /** Mark this handle terminal after its owning bus stops the native interest. */
    markReleased() {
        if (this.state === 'released') return false;
        this.state = 'released';
        this.closeLocal();
        return true;
    }

    /** Recreate batching state after an interest restart. */
    resetLocal() {
        this.batcher?.close();
        this.batcher = this.changeMode === 'individual' ? undefined : new ChangeBatcher(this, this.options);
    }

    /** Return property filtering and resource limits for value decoding. */
    decodeOptions() {
        return {
            propertyNames: this.propertyNames,
            resourceLimits: this.bus.sen.options?.resourceLimits
        };
    }

    /** Deliver one decoded change according to the configured change mode. */
    publishChange(change) {
        if (this.changeMode === 'individual' || this.changeMode === 'both') {
            change.object.emit('change', change);
            change.object.emit(`change:${change.name}`, change);
            this.emit('change', change);
            this.bus.emit('change', change);
            this.bus.sen.emit('change', change);
        }
        if (this.batcher) {
            this.batcher.push(change);
        }
    }

    /** Deliver all value changes decoded from one native object commit. */
    /** @param {import('../index.js').SenCommit} commit */
    publishCommit(commit) {
        this.emit('commit', commit);
    }
}
