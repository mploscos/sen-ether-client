/**
 * @fileoverview Stable facade for native Sen bus codecs.
 *
 * Control, runtime and TypeSpec codecs live in focused modules; this file keeps
 * the historical `lib/bus.js` imports working without adding runtime wrappers.
 */

export { KERNEL_CONTROL_MESSAGE_KEY } from './protocol/generated.js';
export { BUS_MESSAGE_CATEGORY } from './bus-protocol.js';
export {
    decodeKernelControlMessage,
    encodeBusControlMessage,
    encodeKernelControlMessage
} from './bus-control.js';
export {
    decodeBusMessage,
    decodeConfirmedBusFrame,
    decodePropertyUpdateBuffer,
    encodeConfirmedBusFrame,
    encodeRuntimeEvents,
    encodeRuntimeMethodCall,
    encodeRuntimeMethodResponse,
    encodeRuntimeObjectUpdate
} from './bus-runtime.js';
