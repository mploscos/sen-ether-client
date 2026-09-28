/**
 * @fileoverview Tracks owner-scoped Sen type and object-state requests.
 *
 * A response is accepted only when its owner, connection generation and
 * interest generation still match the request that created it. This module is
 * the implementation boundary for those routing invariants.
 */
/** Coordinates bounded requests to remote bus participants. */
export declare class RemoteRequests {
    #private;
    /**
     * @param {object} options
     * @param {() => number} options.limit Returns the current maximum pending requests per bus.
     * @param {(bus:object, ownerId:number|undefined, operation:string) => object} options.resolveParticipant
     * @param {(bus:object, connection:object, message:object, routing?:object) => void} options.sendControl
     * @param {(record:object) => void} options.trace
     * @param {(name:string, detail:object) => void} options.emit
     */
    constructor(options: {
        limit: () => number;
        resolveParticipant: (bus: object, ownerId: number | undefined, operation: string) => object;
        sendControl: (bus: object, connection: object, message: object, routing?: object) => void;
        trace: (record: object) => void;
        emit: (name: string, detail: object) => void;
    });
    /** Request TypeSpecs from one explicit or unambiguous owner. */
    requestTypes(bus: any, typeHashes: any, options?: {}): {
        busName: any;
        busId: any;
        requests: number[];
    } | {
        busName: any;
        busId: any;
        ownerId: any;
        requests: number[];
    };
    /** Request current object state, grouped by local interest. */
    requestObjectStates(bus: any, requests: any, options?: {}): {
        busName: any;
        busId: any;
        requests: any;
    } | {
        busName: any;
        busId: any;
        ownerId: any;
        requests: any;
    };
    /** Validate and emit an `ObjectsStateResponse`. */
    acceptObjectStates(bus: any, frame: any, value: any, connection: any): void;
    /** Validate and emit a `TypesInfoResponse`. */
    acceptTypes(bus: any, frame: any, value: any, connection: any): void;
    /** Validate and emit a `TypesInfoRejection`. */
    acceptTypeRejections(bus: any, frame: any, value: any, connection: any): void;
}
