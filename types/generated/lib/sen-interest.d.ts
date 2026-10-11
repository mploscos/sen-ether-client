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
    state: string;
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
     * Look up one currently visible object by its SEN name.
     * @param {string} name
     * @returns {import('./sen-remote-object.js').SenRemoteObject|undefined}
     */
    objectByName(name: string): import('./sen-remote-object.js').SenRemoteObject | undefined;
    /**
     * Subscribe to the live object collection and replay current objects.
     * The returned cancel function is idempotent.
     */
    /** @param {(object: import('./sen-remote-object.js').SenRemoteObject) => void} handler @returns {import('../index.js').SenCancel} */
    onObjectAdded(handler: (object: import('./sen-remote-object.js').SenRemoteObject) => void): import('../index.js').SenCancel;
    /** Subscribe to removals from the live object collection. */
    /** @param {(object: import('./sen-remote-object.js').SenRemoteObject, detail: {reason?: string, ownerId?: number, previousOwnerId?: number}) => void} handler @returns {import('../index.js').SenCancel} */
    onObjectRemoved(handler: (object: import('./sen-remote-object.js').SenRemoteObject, detail: {
        reason?: string;
        ownerId?: number;
        previousOwnerId?: number;
    }) => void): import('../index.js').SenCancel;
    /** Subscribe to exact object commits rather than interval-based batches. */
    /** @param {(commit: import('../index.js').SenCommit) => void} handler @returns {import('../index.js').SenCancel} */
    onChanges(handler: (commit: import('../index.js').SenCommit) => void): import('../index.js').SenCancel;
    /**
     * Read snapshots for many visible objects without issuing per-property calls.
     * Native Ether objects are emitted only after their initial state is decoded,
     * so their local snapshots are authoritative for this operation.
     */
    /**
     * @param {{objectNames?: string[], propertyNames?: string[]}} [options]
     * @returns {Promise<import('../index.js').SenObjectBatchState[]>}
     */
    getObjectsBatchState(options?: {
        objectNames?: string[];
        propertyNames?: string[];
    }): Promise<import('../index.js').SenObjectBatchState[]>;
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
    /** Alias used by handle-oriented consumers. */
    release(): Promise<void>;
    /** Release only local batching resources during reconnect or shutdown. */
    closeLocal(): void;
    /** Mark this handle terminal after its owning bus stops the native interest. */
    markReleased(): boolean;
    /** Recreate batching state after an interest restart. */
    resetLocal(): void;
    /** Return property filtering and resource limits for value decoding. */
    decodeOptions(): {
        propertyNames: Set<string> | undefined;
        resourceLimits: import("../index.js").SenResourceLimits | undefined;
    };
    /** Deliver one decoded change according to the configured change mode. */
    publishChange(change: any): void;
    /** Deliver all value changes decoded from one native object commit. */
    /** @param {import('../index.js').SenCommit} commit */
    publishCommit(commit: import('../index.js').SenCommit): void;
}
