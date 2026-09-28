/**
 * @fileoverview Codec for kernel control messages carried inside a Sen bus.
 *
 * Interests, publication discovery, state exchange and TypeSpec exchange are
 * handled here. Runtime updates, events and method calls live separately.
 */
/**
 * @param {{ type: string, value?: object }} message
 */
export declare function encodeKernelControlMessage(message: {
    type: string;
    value?: object;
}): Buffer<ArrayBuffer>;
/**
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export declare function decodeKernelControlMessage(buffer: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    type: string;
    value: {};
    bytesRead: number;
};
export declare function encodeBusControlMessage(message: any): Buffer<ArrayBuffer>;
