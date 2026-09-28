/**
 * @fileoverview Persistent high-level publication handles and reconnect state.
 *
 * This registry sits above `EtherClient`: it preserves descriptors across a
 * transport replacement and republishes them exactly once after rejoin.
 */
/**
 * Persistent handle for an object published through {@link Sen#publish}.
 * The handle remains valid when its owning SEN session reconnects.
 */
export declare class SenPublishedObject {
    sen: import("./sen.js").Sen;
    busName: string;
    record: {
        id: number;
        descriptor: import('../index.js').SenPublishedObjectDescriptor;
    };
    /**
     * @param {import('./sen.js').Sen} sen
     * @param {string} busName
     * @param {{id:number, descriptor:import('../index.js').SenPublishedObjectDescriptor}} record
     */
    constructor(sen: import('./sen.js').Sen, busName: string, record: {
        id: number;
        descriptor: import('../index.js').SenPublishedObjectDescriptor;
    });
    get id(): number;
    get name(): string;
    get className(): string;
    get snapshot(): object | undefined;
    get properties(): object | undefined;
    get methods(): object;
    /** @param {Record<string, unknown>} patch */
    update(patch: Record<string, unknown>): Promise<object>;
    /**
     * @param {string} name
     * @param {unknown[]} [args]
     * @param {{ creationTime?: bigint|number }} [options]
     */
    emit(name: string, args?: unknown[], options?: {
        creationTime?: bigint | number;
    }): Promise<any>;
    remove(): Promise<void>;
}
/** Owns session-local publications and their reconnect lifecycle. */
export declare class PublicationRegistry {
    #private;
    records: Map<any, any>;
    /** Create a reconnect-aware registry for one session-local `Sen`. */
    constructor(sen: any);
    /** Publish descriptors and retain normalized records for restoration. */
    publishObjects(bus: any, objects: any, options?: {}): Promise<any>;
    /** Publish one object and return its persistent public handle. */
    publish(bus: any, object: any, options?: {}): Promise<any>;
    /** Update a publication and its reconnect snapshot. */
    update(bus: any, object: any, patch: any, options?: {}): Promise<any>;
    /** Emit a declared event from a retained publication. */
    emit(bus: any, object: any, eventName: any, args?: any[], options?: {}): Promise<any>;
    /** Remove publications from the transport and restoration registry. */
    remove(bus: any, objects: any): Promise<any>;
    /** Republish all retained records after buses have rejoined. */
    restoreAll(): Promise<void>;
}
