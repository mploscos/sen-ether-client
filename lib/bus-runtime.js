/**
 * @fileoverview Codec for Sen runtime bus envelopes and process bus frames.
 *
 * Remote-controlled lengths are validated by `SenBinaryReader` and the shared
 * resource limits before slices or collections are created.
 */

import { SenBinaryReader, SenBinaryWriter } from './codec.js';
import { resourceLimitError } from './limits.js';
import { BUS_MESSAGE_CATEGORY, REMOTE_CALL_RESULT } from './bus-protocol.js';
import { decodeKernelControlMessage } from './bus-control.js';

function enumName(values, code, label) {
    const name = values[code];
    if (name === undefined) {
        throw new RangeError(`unknown SEN ${label} value: ${code}`);
    }
    return name;
}

/** Decode concatenated property-id, size and value records. */
export function decodePropertyUpdateBuffer(buffer, limits = {}) {
    const reader = new SenBinaryReader(buffer, limits);
    const updates = [];

    while (reader.remaining() > 0) {
        const id = reader.readUInt32();
        const size = reader.readUInt32();
        if (size > reader.limits.maxBufferBytes) {
            throw resourceLimitError('property value byte length', reader.limits.maxBufferBytes, size);
        }
        reader.ensure(size);
        const value = reader.buffer.subarray(reader.offset, reader.offset + size);
        reader.offset += size;
        updates.push({ id, size, value });
    }

    return updates;
}

function readRuntimeObjectUpdate(reader) {
    const objectId = reader.readUInt32();
    const time = reader.readInt64();
    const propertiesSize = reader.readUInt32();
    if (propertiesSize > reader.limits.maxBufferBytes) {
        throw resourceLimitError('property update byte length', reader.limits.maxBufferBytes, propertiesSize);
    }
    reader.ensure(propertiesSize);
    const properties = reader.buffer.subarray(reader.offset, reader.offset + propertiesSize);
    reader.offset += propertiesSize;
    return {
        objectId,
        time,
        propertiesSize,
        properties,
        propertyUpdates: decodePropertyUpdateBuffer(properties, reader.limits)
    };
}

function readRuntimeMethodCall(reader, confirmed) {
    const ownerId = reader.readUInt32();
    const objectId = reader.readUInt32();
    const methodId = reader.readUInt32();
    const ticketId = reader.readUInt32();
    const argumentsSize = reader.readUInt32();
    if (argumentsSize > reader.limits.maxBufferBytes) {
        throw resourceLimitError('method argument byte length', reader.limits.maxBufferBytes, argumentsSize);
    }
    reader.ensure(argumentsSize);
    const argumentsBuffer = reader.buffer.subarray(reader.offset, reader.offset + argumentsSize);
    reader.offset += argumentsSize;
    return {
        ownerId,
        objectId,
        methodId,
        ticketId,
        confirmed,
        argumentsSize,
        argumentsBuffer
    };
}

function readRuntimeMethodResponse(reader) {
    const resultCode = reader.readUInt8();
    const result = enumName(REMOTE_CALL_RESULT, resultCode, 'RemoteCallResult');
    const objectId = reader.readUInt32();
    const ticketId = reader.readUInt32();

    if (result === 'success') {
        const returnSize = reader.readUInt32();
        if (returnSize > reader.limits.maxBufferBytes) {
            throw resourceLimitError('method return byte length', reader.limits.maxBufferBytes, returnSize);
        }
        reader.ensure(returnSize);
        const returnValue = reader.buffer.subarray(reader.offset, reader.offset + returnSize);
        reader.offset += returnSize;
        return {
            resultCode,
            result,
            objectId,
            ticketId,
            returnValue
        };
    }

    const error = result === 'runtimeError' || result === 'logicError'
        ? reader.readString()
        : result;

    return {
        resultCode,
        result,
        objectId,
        ticketId,
        error
    };
}

function readRuntimeEvents(reader) {
    const events = [];

    while (reader.remaining() > 0) {
        if (events.length >= reader.limits.maxSequenceLength) {
            throw resourceLimitError('runtime event sequence length', reader.limits.maxSequenceLength, events.length + 1);
        }
        const producerId = reader.readUInt32();
        const eventId = reader.readUInt32();
        const creationTime = reader.readInt64();
        const argumentsSize = reader.readUInt32();
        if (argumentsSize > reader.limits.maxBufferBytes) {
            throw resourceLimitError('event argument byte length', reader.limits.maxBufferBytes, argumentsSize);
        }
        reader.ensure(argumentsSize);
        const argumentsBuffer = reader.buffer.subarray(reader.offset, reader.offset + argumentsSize);
        reader.offset += argumentsSize;
        events.push({
            producerId,
            eventId,
            creationTime,
            argumentsSize,
            argumentsBuffer
        });
    }

    return events;
}

/**
 * Decode process-level bus payload from ProcessHandler TCP category `busMessage`.
 *
 * Payload layout:
 * u32 to; u32 busId; bytes busMessage
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeConfirmedBusFrame(buffer, limits = {}) {
    const reader = new SenBinaryReader(buffer, limits);
    const to = reader.readUInt32();
    const busId = reader.readUInt32();
    const message = reader.buffer.subarray(reader.offset);
    return { to, busId, message };
}

/**
 * Encode a confirmed process-level bus payload.
 *
 * @param {object} frame
 * @param {number} frame.to
 * @param {number} frame.busId
 * @param {Buffer | Uint8Array | ArrayBuffer} frame.message
 */
export function encodeConfirmedBusFrame(frame) {
    const writer = new SenBinaryWriter();
    writer.writeUInt32(frame.to);
    writer.writeUInt32(frame.busId);
    writer.chunks.push(Buffer.from(frame.message ?? []));
    return writer.toBuffer();
}

/**
 * Decode sen::kernel::impl bus message envelope.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeBusMessage(buffer, limits = {}) {
    const reader = new SenBinaryReader(buffer, limits);
    const category = reader.readUInt8();
    const payload = reader.buffer.subarray(reader.offset);

    if (category === BUS_MESSAGE_CATEGORY.controlMessage) {
        return {
            category,
            categoryName: 'controlMessage',
            control: decodeKernelControlMessage(payload, reader.limits)
        };
    }

    if (category === BUS_MESSAGE_CATEGORY.runtimeObjectUpdate) {
        return {
            category,
            categoryName: 'runtimeObjectUpdate',
            update: readRuntimeObjectUpdate(reader)
        };
    }

    if (
        category === BUS_MESSAGE_CATEGORY.runtimeMethodCallBestEffort
    || category === BUS_MESSAGE_CATEGORY.runtimeMethodCallConfirmed
    ) {
        return {
            category,
            categoryName: category === BUS_MESSAGE_CATEGORY.runtimeMethodCallConfirmed
                ? 'runtimeMethodCallConfirmed'
                : 'runtimeMethodCallBestEffort',
            call: readRuntimeMethodCall(reader, category === BUS_MESSAGE_CATEGORY.runtimeMethodCallConfirmed)
        };
    }

    if (category === BUS_MESSAGE_CATEGORY.runtimeMethodResponse) {
        return {
            category,
            categoryName: 'runtimeMethodResponse',
            response: readRuntimeMethodResponse(reader)
        };
    }

    if (category === BUS_MESSAGE_CATEGORY.runtimeEvents) {
        return {
            category,
            categoryName: 'runtimeEvents',
            events: readRuntimeEvents(reader),
            payload
        };
    }

    return {
        category,
        categoryName: Object.entries(BUS_MESSAGE_CATEGORY).find(([, value]) => value === category)?.[0] ?? `unknown:${category}`,
        payload
    };
}

/**
 * Encode a SEN runtime object update bus message.
 *
 * @param {object} update
 * @param {number} update.objectId
 * @param {bigint|number} [update.time]
 * @param {Buffer | Uint8Array | ArrayBuffer} [update.propertiesBuffer]
 */
export function encodeRuntimeObjectUpdate(update) {
    const properties = Buffer.isBuffer(update.propertiesBuffer)
        ? update.propertiesBuffer
        : Buffer.from(update.propertiesBuffer ?? []);
    const writer = new SenBinaryWriter();
    writer.writeUInt8(BUS_MESSAGE_CATEGORY.runtimeObjectUpdate);
    writer.writeUInt32(update.objectId);
    writer.writeInt64(update.time ?? BigInt(Date.now()) * 1_000_000n);
    writer.writeUInt32(properties.length);
    if (properties.length) {
        writer.chunks.push(properties);
    }
    return writer.toBuffer();
}

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
export function encodeRuntimeEvents(events = []) {
    const writer = new SenBinaryWriter();
    writer.writeUInt8(BUS_MESSAGE_CATEGORY.runtimeEvents);
    for (const event of events) {
        const args = Buffer.isBuffer(event.argumentsBuffer)
            ? event.argumentsBuffer
            : Buffer.from(event.argumentsBuffer ?? []);
        writer.writeUInt32(event.producerId);
        writer.writeUInt32(event.eventId);
        writer.writeInt64(event.creationTime ?? BigInt(Date.now()) * 1_000_000n);
        writer.writeUInt32(args.length);
        if (args.length) writer.chunks.push(args);
    }
    return writer.toBuffer();
}

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
export function encodeRuntimeMethodCall(call) {
    const args = Buffer.isBuffer(call.argumentsBuffer)
        ? call.argumentsBuffer
        : Buffer.from(call.argumentsBuffer ?? []);
    const writer = new SenBinaryWriter();
    writer.writeUInt8(call.confirmed ? BUS_MESSAGE_CATEGORY.runtimeMethodCallConfirmed : BUS_MESSAGE_CATEGORY.runtimeMethodCallBestEffort);
    writer.writeUInt32(call.ownerId);
    writer.writeUInt32(call.objectId);
    writer.writeUInt32(call.methodId);
    writer.writeUInt32(call.ticketId);
    writer.writeUInt32(args.length);
    if (args.length) {
        writer.chunks.push(args);
    }
    return writer.toBuffer();
}

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
export function encodeRuntimeMethodResponse(response) {
    const result = response.result || 'success';
    const resultCode = REMOTE_CALL_RESULT.indexOf(result);
    if (resultCode < 0) {
        throw new RangeError(`unknown SEN RemoteCallResult: ${result}`);
    }
    const writer = new SenBinaryWriter();
    writer.writeUInt8(BUS_MESSAGE_CATEGORY.runtimeMethodResponse);
    writer.writeUInt8(resultCode);
    writer.writeUInt32(response.objectId);
    writer.writeUInt32(response.ticketId);
    if (result === 'success') {
        const returnValue = Buffer.isBuffer(response.returnValue)
            ? response.returnValue
            : Buffer.from(response.returnValue ?? []);
        writer.writeUInt32(returnValue.length);
        if (returnValue.length) writer.chunks.push(returnValue);
    } else if (result === 'runtimeError' || result === 'logicError') {
        writer.writeString(response.error || result);
    }
    return writer.toBuffer();
}
