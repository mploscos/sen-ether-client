/** @fileoverview Public interest collection, waiting and change delivery API. */
import { EventEmitter } from 'node:events';
import { ChangeBatcher } from './change-batcher.js';
/** Represents one active native Sen interest and its visible remote objects. */
export declare class SenInterest extends EventEmitter {
    bus: import("./sen-bus.js").SenBus;
    id: number;
    query: string;
    ownerId: any;
    ownerIds: Set<any>;
    options: {
        bus?: string;
        query?: string;
        forceBus?: boolean;
        timeout?: number;
        id?: number;
        properties?: string[] | string;
        changeMode?: 'individual' | 'batch' | 'both';
        batchIntervalMs?: number;
        batchMaxSize?: number;
        maxQueuedChanges?: number;
        backpressure?: 'drop-oldest' | 'drop-newest' | 'error';
        coalesce?: boolean;
    };
    propertyNames: Set<string> | undefined;
    changeMode: "batch" | "both" | "individual";
    batcher: ChangeBatcher | undefined;
    objectsById: Map<any, any>;
    /**
   * @param {import('./sen-bus.js').SenBus} bus
   * @param {number} id
   * @param {string} query
   * @param {import('../index.js').SenInterestOptions} [options]
   */
    constructor(bus: import('./sen-bus.js').SenBus, id: number, query: string, options?: import('../index.js').SenInterestOptions);
    /** @returns {import('./sen-remote-object.js').SenRemoteObject[]} */
    objects(): import('./sen-remote-object.js').SenRemoteObject[];
    /**
   * @param {import('../index.js').SenObjectSelector} selector
   * @returns {import('./sen-remote-object.js').SenRemoteObject|undefined}
   */
    get(selector: import('../index.js').SenObjectSelector): import('./sen-remote-object.js').SenRemoteObject | undefined;
    /**
   * @param {import('../index.js').SenObjectSelector} selector
   * @param {{timeout?:number}} [options]
   * @returns {Promise<import('./sen-remote-object.js').SenRemoteObject>}
   */
    waitFor(selector: import('../index.js').SenObjectSelector, options?: {
        timeout?: number;
    }): Promise<import('./sen-remote-object.js').SenRemoteObject>;
    /** Stop the native interest and close local batching state. */
    close(): void;
    /** Release only local batching resources during reconnect or shutdown. */
    closeLocal(): void;
    /** Recreate batching state after an interest restart. */
    resetLocal(): void;
    /** Return property filtering and resource limits for value decoding. */
    decodeOptions(): {
        propertyNames: Set<string> | undefined;
        resourceLimits: import("../index.js").SenResourceLimits | undefined;
    };
    /** Deliver one decoded change according to the configured change mode. */
    publishChange(change: any): void;
}
