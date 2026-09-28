/**
 * @fileoverview Codec for Sen runtime bus envelopes and process bus frames.
 *
 * Remote-controlled lengths are validated by `SenBinaryReader` and the shared
 * resource limits before slices or collections are created.
 */
/** Decode concatenated property-id, size and value records. */
export declare function decodePropertyUpdateBuffer(buffer: any, limits?: {}): {
    id: number;
    size: number;
    value: Buffer<ArrayBufferLike>;
}[];
/**
 * Decode process-level bus payload from ProcessHandler TCP category `busMessage`.
 *
 * Payload layout:
 * u32 to; u32 busId; bytes busMessage
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeConfirmedBusFrame(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    to: number;
    busId: number;
    message: Buffer<ArrayBufferLike>;
};
/**
 * Encode a confirmed process-level bus payload.
 *
 * @param {object} frame
 * @param {number} frame.to
 * @param {number} frame.busId
 * @param {Buffer | Uint8Array | ArrayBuffer} frame.message
 */
export declare function encodeConfirmedBusFrame(frame: {
    to: number;
    busId: number;
    message: Buffer | Uint8Array | ArrayBuffer;
}): Buffer<ArrayBuffer>;
/**
 * Decode sen::kernel::impl bus message envelope.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeBusMessage(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    category: 0;
    categoryName: string;
    control: {
        type: string;
        value: {};
        bytesRead: number;
    };
    update?: undefined;
    call?: undefined;
    response?: undefined;
    events?: undefined;
    payload?: undefined;
} | {
    control?: undefined;
    category: 1;
    categoryName: string;
    update: {
        objectId: any;
        time: any;
        propertiesSize: any;
        properties: any;
        propertyUpdates: {
            id: number;
            size: number;
            value: Buffer<ArrayBufferLike>;
        }[];
    };
    call?: undefined;
    response?: undefined;
    events?: undefined;
    payload?: undefined;
} | {
    control?: undefined;
    update?: undefined;
    category: 2 | 3;
    categoryName: string;
    call: {
        ownerId: any;
        objectId: any;
        methodId: any;
        ticketId: any;
        confirmed: any;
        argumentsSize: any;
        argumentsBuffer: any;
    };
    response?: undefined;
    events?: undefined;
    payload?: undefined;
} | {
    control?: undefined;
    update?: undefined;
    call?: undefined;
    category: 4;
    categoryName: string;
    response: {
        resultCode: any;
        result: any;
        objectId: any;
        ticketId: any;
        returnValue: any;
        error?: undefined;
    } | {
        returnValue?: undefined;
        resultCode: any;
        result: any;
        objectId: any;
        ticketId: any;
        error: any;
    };
    events?: undefined;
    payload?: undefined;
} | {
    control?: undefined;
    update?: undefined;
    call?: undefined;
    response?: undefined;
    category: 5;
    categoryName: string;
    events: {
        producerId: any;
        eventId: any;
        creationTime: any;
        argumentsSize: any;
        argumentsBuffer: any;
    }[];
    payload: Buffer<ArrayBufferLike>;
} | {
    control?: undefined;
    update?: undefined;
    call?: undefined;
    response?: undefined;
    events?: undefined;
    category: number;
    categoryName: string;
    payload: Buffer<ArrayBufferLike>;
};
/**
 * Encode a SEN runtime object update bus message.
 *
 * @param {object} update
 * @param {number} update.objectId
 * @param {bigint|number} [update.time]
 * @param {Buffer | Uint8Array | ArrayBuffer} [update.propertiesBuffer]
 */
export declare function encodeRuntimeObjectUpdate(update: {
    objectId: number;
    time?: bigint | number;
    propertiesBuffer?: Buffer | Uint8Array | ArrayBuffer;
}): Buffer<ArrayBuffer>;
/**
 * Encode one or more SEN runtime events in their native bus-message layout.
 *
 * @param {Array<{
 *   producerId: number,
 *   eventId: number,
 *   creationTime?: bigint|number,
 *   argumentsBuffer?: Buffer|Uint8Array|ArrayBuffer
 * }>} events
 */
export declare function encodeRuntimeEvents(events?: Array<{
    producerId: number;
    eventId: number;
    creationTime?: bigint | number;
    argumentsBuffer?: Buffer | Uint8Array | ArrayBuffer;
}>): Buffer<ArrayBuffer>;
/**
 * Encode a SEN runtime method call bus message.
 *
 * Source implementation:
 * libs/kernel/src/bus/remote_participant.cpp::makeMethodCallHeader
 *
 * @param {object} call
 * @param {boolean} [call.confirmed]
 * @param {number} call.ownerId Local participant id that should receive the response.
 * @param {number} call.objectId Remote object id.
 * @param {number} call.methodId SEN method member hash.
 * @param {number} call.ticketId Local call id.
 * @param {Buffer | Uint8Array | ArrayBuffer} [call.argumentsBuffer]
 */
export declare function encodeRuntimeMethodCall(call: {
    confirmed?: boolean;
    ownerId: number;
    objectId: number;
    methodId: number;
    ticketId: number;
    argumentsBuffer?: Buffer | Uint8Array | ArrayBuffer;
}): Buffer<ArrayBuffer>;
/**
 * Encode a SEN runtime method response bus message.
 *
 * @param {object} response
 * @param {'success'|'objectNotFound'|'runtimeError'|'logicError'|'unknownException'} response.result
 * @param {number} response.objectId
 * @param {number} response.ticketId
 * @param {Buffer | Uint8Array | ArrayBuffer} [response.returnValue]
 * @param {string} [response.error]
 */
export declare function encodeRuntimeMethodResponse(response: {
    result: 'success' | 'objectNotFound' | 'runtimeError' | 'logicError' | 'unknownException';
    objectId: number;
    ticketId: number;
    returnValue?: Buffer | Uint8Array | ArrayBuffer;
    error?: string;
}): Buffer<ArrayBuffer>;
