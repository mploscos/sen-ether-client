/**
 * @fileoverview Local Sen object publication lifecycle for one Ether client.
 *
 * The registry owns object state, local TypeSpec responses, matching against
 * remote interests, property updates, events and incoming method calls. It is
 * intentionally separate from connection routing: callers provide the four
 * transport operations needed to send already encoded messages.
 */
/**
 * Coordinates JavaScript objects published on joined Sen buses.
 *
 * @param {object} transport
 * @param {(name:string, detail:object) => void} transport.emit
 * @param {(bus:object, connection:object|undefined, message:object, routing?:object) => void} transport.sendControl
 * @param {(bus:object, connection:object|undefined, payload:Buffer) => void} transport.sendMessage
 * @param {(bus:object, payload:Buffer) => Promise<void>} transport.sendMulticast
 * @param {(bus:object, payload:Buffer) => Promise<boolean>} transport.sendUnicast
 */
export declare class LocalPublications {
    #private;
    constructor(transport: any);
    /**
     * Add objects and their optional external TypeSpecs to a joined bus.
     *
     * @param {object} bus Bus state owned by `EtherClient`.
     * @param {object|object[]} objects Publication descriptors.
     * @param {{types?:Map<string, object>|Record<string, object>|object[]}} [options]
     * @returns {object[]} Normalized local object records.
     */
    publish(bus: object, objects: object | object[], options?: {
        types?: Map<string, object> | Record<string, object> | object[];
    }): object[];
    /** Update object state and notify matching remote participants. */
    update(bus: any, selector: any, patch: any): any;
    /** Encode and transmit one declared object event. */
    emitEvent(bus: any, selector: any, eventName: any, args?: any[], options?: {}): Promise<{
        busName: any;
        busId: any;
        object: any;
        event: any;
        args: any[];
        creationTime: any;
        creationTimeNs: bigint;
        transportMode: any;
    }>;
    /** Remove local objects and withdraw them from every matching interest. */
    remove(bus: any, selectors: any): any[];
    /** Execute a method call addressed to a locally published object. */
    handleMethodCall(bus: any, call: any, connection: any): Promise<void>;
    /** Answer an `ObjectsStateRequest` for locally owned objects. */
    respondToStateRequest(bus: any, frame: any, value: any, connection: any): void;
    /** Answer a `TypesInfoRequest` from the bus-local TypeSpec cache. */
    respondToTypesRequest(bus: any, frame: any, value: any, connection: any): void;
    /** Re-evaluate local objects for selected or all remote interests. */
    publishForInterests(bus: any, objects: any, keys?: undefined, changesOnly?: boolean): void;
}
