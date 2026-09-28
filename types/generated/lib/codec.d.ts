import { ETHER_CONTROL_MESSAGE_KEY, ETHER_PROTOCOL_VERSION, KERNEL_PROTOCOL_VERSION } from './protocol/generated.js';
export { ETHER_CONTROL_MESSAGE_KEY, ETHER_PROTOCOL_VERSION, KERNEL_PROTOCOL_VERSION };
export declare const PROCESS_MESSAGE_CATEGORY: Readonly<{
    busMessage: 0;
    controlMessage: 1;
}>;
/**
 * Minimal little-endian reader compatible with SEN InputStream.
 */
export declare class SenBinaryReader {
    buffer: Buffer<ArrayBufferLike>;
    offset: number;
    limits: Readonly<{
        [k: string]: number;
    }>;
    /**
     * @param {Buffer | Uint8Array | ArrayBuffer} buffer
     * @param {object} [limits]
     */
    constructor(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: object);
    remaining(): number;
    ensure(size: any): void;
    readCount(label?: string): number;
    readUInt8(): number;
    readUInt16(): number;
    readInt16(): number;
    readUInt32(): number;
    readInt32(): number;
    readUInt64(): bigint;
    readInt64(): bigint;
    readFloat32(): number;
    readFloat64(): number;
    readBool(): boolean;
    readString(): string;
    readBuffer(): Buffer<ArrayBufferLike>;
}
/**
 * Minimal little-endian writer compatible with SEN OutputStream.
 */
export declare class SenBinaryWriter {
    chunks: any[];
    constructor();
    writeUInt8(value: any): void;
    writeUInt16(value: any): void;
    writeInt16(value: any): void;
    writeUInt32(value: any): void;
    writeInt32(value: any): void;
    writeUInt64(value: any): void;
    writeInt64(value: any): void;
    writeFloat32(value: any): void;
    writeFloat64(value: any): void;
    writeBool(value: any): void;
    writeString(value: any): void;
    writeBuffer(value: any): void;
    toBuffer(): Buffer<ArrayBuffer>;
}
/**
 * @param {number} value
 * @returns {string}
 */
export declare function uint32ToIpString(value: number): string;
/**
 * @param {string} value
 * @returns {number}
 */
export declare function ipStringToUint32(value: string): number;
export declare function readProcessInfo(reader: any): {
    hostId: any;
    processId: any;
    sessionId: any;
    sessionName: any;
    appName: any;
    hostName: any;
    osKindCode: any;
    osKind: string;
    osName: any;
    cpuArchCode: any;
    cpuArch: string;
};
export declare function writeProcessInfo(writer: any, info: any): void;
/**
 * Encode sen.components.ether.ControlMessage.
 *
 * Source schema:
 * components/ether/stl/runtime.stl
 *
 * SEN generated serialization writes a u32 alternative key followed by the
 * selected struct payload.
 *
 * @param {{ type: 'Hello' | 'Ready' | 'BusJoined' | 'BusLeft', value?: object } | { Hello: object } | { Ready: object } | { BusJoined: object } | { BusLeft: object }} message
 */
export declare function encodeEtherControlMessage(message: {
    type: 'Hello' | 'Ready' | 'BusJoined' | 'BusLeft';
    value?: object;
} | {
    Hello: object;
} | {
    Ready: object;
} | {
    BusJoined: object;
} | {
    BusLeft: object;
}): Buffer<ArrayBuffer>;
/**
 * Decode sen.components.ether.ControlMessage.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeEtherControlMessage(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    type: "BusJoined" | "BusLeft" | "Hello" | "Ready";
    value: {};
    bytesRead: number;
};
/**
 * Encode the 5-byte ProcessHandler TCP frame header plus payload.
 *
 * Source implementation:
 * components/ether/src/process_handler.cpp
 *
 * @param {number} category
 * @param {Buffer | Uint8Array | ArrayBuffer} payload
 */
export declare function encodeProcessTcpFrame(category: number, payload: Buffer | Uint8Array | ArrayBuffer): Buffer<ArrayBuffer>;
/**
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeProcessTcpHeader(buffer: Buffer | Uint8Array | ArrayBuffer): {
    category: number;
    payloadSize: number;
};
/**
 * Decode sen.components.ether.SessionPresenceBeam.
 *
 * Source schema:
 * components/ether/stl/discovery.stl
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeSessionPresenceBeam(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    protocolVersion: number;
    info: {
        hostId: any;
        processId: any;
        sessionId: any;
        sessionName: any;
        appName: any;
        hostName: any;
        osKindCode: any;
        osKind: string;
        osName: any;
        cpuArchCode: any;
        cpuArch: string;
    };
    beamPeriodNs: bigint;
    beamPeriodMs: number;
    endpoints: {
        ip: any;
        host: string;
        port: any;
    }[];
    bytesRead: number;
};
/**
 * Encode sen.components.ether.SessionPresenceBeam. Mostly used by tests and
 * future active discovery mode.
 *
 * @param {object} beam
 */
export declare function encodeSessionPresenceBeam(beam: object): Buffer<ArrayBuffer>;
