/**
 * @fileoverview Persistent high-level publication handles and reconnect state.
 *
 * This registry sits above `EtherClient`: it preserves descriptors across a
 * transport replacement and republishes them exactly once after rejoin.
 */

import { makeObjectId } from './object-id.js';
import { SenBus } from './sen-bus.js';
import { mergedTypeDefinitions, selectorDescription } from './sen-object-helpers.js';

function publicationKey(busName, object) {
    const id = object?.id;
    if (id === undefined || id === null) {
        throw new TypeError('published SEN object key requires an id');
    }
    return `${busName}\u0000${id >>> 0}`;
}

function publicationDescriptor(object) {
    const properties = object?.state ?? object?.snapshot ?? object?.properties ?? {};
    return {
        ...object,
        properties: { ...properties }
    };
}

function isRecoverablePublicationError(error) {
    const message = String(error?.message || error);
    return message.includes('SEN bus is not joined')
        || message.includes('SEN published object not found')
        || message.includes('EtherClient is not connected or started')
        || message.includes('Sen is not connected');
}

/**
 * Persistent handle for an object published through {@link Sen#publish}.
 * The handle remains valid when its owning SEN session reconnects.
 */
export class SenPublishedObject {
    /**
     * @param {import('./sen.js').Sen} sen
     * @param {string} busName
     * @param {{id:number, descriptor:import('../index.js').SenPublishedObjectDescriptor}} record
     */
    constructor(sen, busName, record) {
        this.sen = sen;
        this.busName = busName;
        this.record = record;
    }

    get id() {
        return this.record.id;
    }

    get name() {
        return this.record.descriptor.name;
    }

    get className() {
        return this.record.descriptor.className;
    }

    get snapshot() {
        return this.record.descriptor.properties;
    }

    get properties() {
        return this.snapshot;
    }

    get methods() {
        return this.record.descriptor.methods ?? {};
    }

    /** @param {Record<string, unknown>} patch */
    async update(patch) {
        return await this.sen.updatePublishedObject(this.busName, this.id, patch);
    }

    /**
     * @param {string} name
     * @param {unknown[]} [args]
     * @param {{ creationTime?: bigint|number }} [options]
     */
    async emit(name, args = [], options = {}) {
        return await this.sen.emitPublishedEvent(this.busName, this.id, name, args, options);
    }

    async remove() {
        await this.sen.removePublishedObjects(this.busName, this.id);
    }
}

/** Owns session-local publications and their reconnect lifecycle. */
export class PublicationRegistry {
    #sen;

    /** Create a reconnect-aware registry for one session-local `Sen`. */
    constructor(sen) {
        this.#sen = sen;
        this.records = new Map();
    }

    /** Publish descriptors and retain normalized records for restoration. */
    async publishObjects(bus, objects, options = {}) {
        const list = Array.isArray(objects) ? objects : [objects];
        const descriptors = list.map(object => object.id === undefined || object.id === null
            ? { ...object, id: makeObjectId(object.name) }
            : object);
        const published = await this.#run(bus, async () => {
            await this.#ensureBus(bus, options);
            const types = mergedTypeDefinitions(this.#sen.options.types, options.types);
            return this.#sen.client.publishObjects(bus, descriptors, types ? { ...options, types } : options);
        });
        for (let index = 0; index < descriptors.length; index += 1) {
            this.#remember(bus, { ...descriptors[index], id: published[index].id }, options);
        }
        return published;
    }

    /** Publish one object and return its persistent public handle. */
    async publish(bus, object, options = {}) {
        const [published] = await this.publishObjects(bus, object, options);
        return this.records.get(publicationKey(bus, published)).handle;
    }

    /** Update a publication and its reconnect snapshot. */
    async update(bus, object, patch, options = {}) {
        const record = this.#find(bus, object);
        const updated = await this.#run(bus, async () => {
            await this.#ensureBus(bus, options);
            return this.#sen.client.updatePublishedObject(bus, object, patch);
        });
        if (record) {
            Object.assign(record.descriptor.properties, patch);
        }
        return updated;
    }

    /** Emit a declared event from a retained publication. */
    async emit(bus, object, eventName, args = [], options = {}) {
        const record = this.#find(bus, object);
        if (!record) {
            throw new Error(`SEN published object not found: ${selectorDescription(object)}`);
        }
        return await this.#run(bus, async () => {
            await this.#ensureBus(bus, options);
            return await this.#sen.client.emitPublishedEvent(bus, record.id, eventName, args, options);
        });
    }

    /** Remove publications from the transport and restoration registry. */
    async remove(bus, objects) {
        const selectors = Array.isArray(objects) ? objects : [objects];
        const records = selectors.map(selector => this.#find(bus, selector)).filter(Boolean);
        for (const record of records) {
            this.records.delete(record.key);
        }
        try {
            await this.#waitForReconnect();
            return this.#sen.client.removePublishedObjects(bus, objects);
        } catch (error) {
            if (isRecoverablePublicationError(error)) {
                return records.map(record => record.id);
            }
            throw error;
        }
    }

    /** Republish all retained records after buses have rejoined. */
    async restoreAll() {
        for (const record of this.records.values()) {
            await this.#publishRecord(record);
        }
    }

    #remember(bus, object, options) {
        const descriptor = publicationDescriptor(object);
        const key = publicationKey(bus, descriptor);
        const existing = this.records.get(key);
        if (existing) {
            existing.descriptor = descriptor;
            existing.options = { ...options };
            return existing;
        }
        const record = {
            key,
            bus,
            id: descriptor.id >>> 0,
            descriptor,
            options: { ...options },
            handle: undefined
        };
        record.handle = new SenPublishedObject(this.#sen, bus, record);
        this.records.set(key, record);
        return record;
    }

    #find(bus, selector) {
        if (selector && typeof selector === 'object' && selector.record?.bus === bus) {
            return selector.record;
        }
        const id = typeof selector === 'number'
            ? selector >>> 0
            : typeof selector === 'object' && selector.id !== undefined && selector.id !== null
                ? selector.id >>> 0
                : undefined;
        if (id !== undefined) {
            return this.records.get(`${bus}\u0000${id}`);
        }
        const name = String(selector ?? '');
        return [...this.records.values()].find(record => record.bus === bus && record.descriptor.name === name);
    }

    async #waitForReconnect() {
        if (this.#sen.reconnectPromise) {
            await this.#sen.reconnectPromise;
        }
        if (!this.#sen.client) {
            throw new Error('Sen is not connected');
        }
    }

    async #run(bus, operation) {
        try {
            await this.#waitForReconnect();
            return await operation();
        } catch (error) {
            if (!isRecoverablePublicationError(error) || this.#sen.manualClose) {
                throw error;
            }
            await this.#waitForReconnect();
            await this.#restoreBus(bus);
            return await operation();
        }
    }

    async #ensureBus(bus, options = {}) {
        if (this.#sen.buses.has(bus)) {
            return;
        }
        const joined = await this.#sen.client.joinBus(bus, options);
        this.#sen.buses.set(bus, new SenBus(this.#sen, bus, joined.busId));
    }

    async #restoreBus(bus) {
        this.#sen.buses.delete(bus);
        await this.#ensureBus(bus);
        for (const record of this.records.values()) {
            if (record.bus === bus) {
                await this.#publishRecord(record);
            }
        }
    }

    async #publishRecord(record) {
        await this.#ensureBus(record.bus, record.options);
        const types = mergedTypeDefinitions(this.#sen.options.types, record.options.types);
        return this.#sen.client.publishObjects(
            record.bus,
            record.descriptor,
            types ? { ...record.options, types } : record.options
        );
    }
}
