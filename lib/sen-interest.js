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
        this.bus.stopInterest(this.id);
    }

    /** Release only local batching resources during reconnect or shutdown. */
    closeLocal() {
        this.batcher?.close();
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
}
