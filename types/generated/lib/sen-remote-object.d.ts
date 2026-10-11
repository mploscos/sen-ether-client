/**
 * @fileoverview Public proxy for one owner-scoped remote Sen object.
 *
 * The proxy decodes typed state, preserves timestamp ordering and exposes
 * property setters, methods and runtime events without owning transport logic.
 */
import { EventEmitter } from 'node:events';
/** Typed, event-emitting view of a remotely owned Sen object. */
export declare class SenRemoteObject extends EventEmitter {
    #private;
    bus: import("./sen-bus.js").SenBus;
    id: number;
    name: string;
    className: string;
    typeHash: number;
    ownerId: number | undefined;
    interestId: number | undefined;
    interestIds: Set<any>;
    /** @type {Record<string, unknown>} */
    snapshot: Record<string, unknown>;
    spec: any;
    typePromise: Promise<any> | undefined;
    pendingState: any;
    pendingStates: any[];
    readyInterestIds: Set<any>;
    emittedInterestObjectIds: Set<any>;
    emittedGlobalObject: boolean;
    /** @type {bigint|undefined} */
    timestamp: bigint | undefined;
    /** @type {bigint|undefined} */
    timestampNs: bigint | undefined;
    /** @type {bigint|undefined} */
    lastObservedTimestamp: bigint | undefined;
    /** @type {bigint|undefined} */
    lastObservedTimestampNs: bigint | undefined;
    /** @type {bigint|undefined} */
    lastStateTimestamp: bigint | undefined;
    /** @type {bigint|undefined} */
    lastStateTimestampNs: bigint | undefined;
    /** @type {bigint|undefined} */
    lastUpdateTimestamp: bigint | undefined;
    /** @type {bigint|undefined} */
    lastUpdateTimestampNs: bigint | undefined;
    /** @type {Map<string, bigint>} */
    propertyTimestamps: Map<string, bigint>;
    /** @type {Map<string, bigint>} */
    propertyObservedTimestamps: Map<string, bigint>;
    /**
   * @param {import('./sen-bus.js').SenBus} bus
   * @param {{id:number,name:string,className:string,typeHash:number,ownerId?:number,interestId?:number}} info
   */
    constructor(bus: import('./sen-bus.js').SenBus, info: {
        id: number;
        name: string;
        className: string;
        typeHash: number;
        ownerId?: number;
        interestId?: number;
    });
    /** @param {import('../index.js').SenObjectSelector} selector */
    matches(selector: import('../index.js').SenObjectSelector): boolean;
    /** Associate this owner-scoped object with another interest. */
    attachInterest(interestId: any): void;
    /** Remove one interest association and its ready/emitted markers. */
    detachInterest(interestId: any): void;
    /** Refresh mutable discovery metadata without replacing object identity. */
    updateDiscoveryInfo(info: any): void;
    /** Find a declared or inherited property by name. */
    property(name: any): any;
    /** Find a declared or inherited method by name. */
    method(name: any): any;
    /** Find a declared or inherited event by name. */
    event(name: any): any;
    /** Return every declared and inherited property in parent-first order. */
    properties(): any[];
    /** Return every declared and inherited method in parent-first order. */
    methods(): any[];
    /** Return every declared and inherited event in parent-first order. */
    events(): any[];
    /** Return the parent-first qualified class lineage. */
    classLineage(): any;
    /**
     * Return the known TypeSpecs required to describe this object. The map is
     * detached from the mutable bus registry and is safe for adapter traversal.
     */
    typeDefinitions(): Map<any, any>;
    /**
   * @param {{timeout?:number}} [options]
   * @returns {Promise<object>}
   */
    waitForType(options?: {
        timeout?: number;
    }): Promise<object>;
    /**
   * @param {string} name
   * @returns {Promise<unknown>}
   */
    get(name: string): Promise<unknown>;
    /**
     * Subscribe to one property using the callback shape shared with the
     * JSON-RPC client. The current value is not replayed; read it with get().
     */
    /**
     * @param {string} name
     * @param {(value: unknown, info: import('../index.js').SenDeliveryInfo) => void} handler
     * @returns {import('../index.js').SenCancel}
     */
    onPropertyChanged(name: string, handler: (value: unknown, info: import('../index.js').SenDeliveryInfo) => void): import('../index.js').SenCancel;
    /** Subscribe to the properties changed by each exact native commit. */
    /**
     * @param {(values: Map<string, unknown>, info: import('../index.js').SenDeliveryInfo) => void} handler
     * @returns {import('../index.js').SenCancel}
     */
    onAnyChange(handler: (values: Map<string, unknown>, info: import('../index.js').SenDeliveryInfo) => void): import('../index.js').SenCancel;
    /** Subscribe to one declared runtime event. */
    /**
     * @param {string} name
     * @param {(args: unknown[], info: import('../index.js').SenDeliveryInfo) => void} handler
     * @returns {import('../index.js').SenCancel}
     */
    onEventTriggered(name: string, handler: (args: unknown[], info: import('../index.js').SenDeliveryInfo) => void): import('../index.js').SenCancel;
    /** Return the timestamp of the last value-changing update for a property. */
    getPropertyTimestamp(name: any): bigint | undefined;
    /** Return the newest observed timestamp, including unchanged values. */
    getPropertyObservedTimestamp(name: any): bigint | undefined;
    get key(): string;
    isReadyForInterest(interestId: any): boolean;
    markInterestObjectEmitted(interestId: any): boolean;
    markGlobalObjectEmitted(): boolean;
    /**
   * @param {string} name
   * @param {unknown} value
   * @param {import('../index.js').SenMethodCallOptions} [options]
   * @returns {Promise<void>}
   */
    set(name: string, value: unknown, options?: import('../index.js').SenMethodCallOptions): Promise<void>;
    /**
   * @param {string} name
   * @param {unknown[]} [args]
   * @param {import('../index.js').SenMethodCallOptions} [options]
   * @returns {Promise<unknown>}
   */
    call(name: string, args?: unknown[], options?: import('../index.js').SenMethodCallOptions): Promise<unknown>;
    /** Decode and apply a full state or incremental property update buffer. */
    applyState(buffer: any, source: any, timestamp: any, options?: {}): void;
    /** Decode and dispatch one runtime event to object, interest, bus and Sen. */
    emitRuntimeEvent(item: any): void;
}
