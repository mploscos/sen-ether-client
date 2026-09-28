/**
 * @fileoverview Codec for kernel control messages carried inside a Sen bus.
 *
 * Interests, publication discovery, state exchange and TypeSpec exchange are
 * handled here. Runtime updates, events and method calls live separately.
 */

import { SenBinaryReader, SenBinaryWriter } from './codec.js';
import { crc32 } from './crc32.js';
import { KERNEL_CONTROL_MESSAGE_KEY } from './protocol/generated.js';
import { BUS_MESSAGE_CATEGORY } from './bus-protocol.js';
import {
    kernelControlTypeFromKey,
    readSequence,
    readStringList,
    readTypeSpecResponse,
    readU32List,
    requiredUInt32,
    writeSequence,
    writeStringList,
    writeTypeSpecResponse,
    writeU32List
} from './bus-type-spec.js';

function writeObjectAdded(writer, item = {}) {
    writer.writeString(item.className ?? '');
    writer.writeUInt32(requiredUInt32(item.typeHash, 'object typeHash'));
    writer.writeString(item.name ?? '');
    writer.writeUInt32(requiredUInt32(item.id, 'object id'));
    writer.writeBuffer(item.state ?? Buffer.alloc(0));
    writer.writeInt64(item.time ?? 0n);
}

function writeInterestDiscovery(writer, item = {}) {
    writer.writeUInt32(item.interestId ?? 0);
    writeSequence(writer, item.objects ?? [], writeObjectAdded);
}

function writeObjectsPublished(writer, value = {}) {
    writer.writeUInt32(value.ownerId ?? 0);
    writeSequence(writer, value.discoveries ?? [], writeInterestDiscovery);
}

function writeObjectsRemoved(writer, value = {}) {
    writeSequence(writer, value.removals ?? [], (itemWriter, item) => {
        itemWriter.writeUInt32(item.interestId ?? 0);
        writeU32List(itemWriter, item.ids ?? []);
    });
}

function writeObjectsStateResponse(writer, value = {}) {
    writer.writeUInt32(value.ownerId ?? 0);
    writeSequence(writer, value.responses ?? [], (itemWriter, response) => {
        itemWriter.writeUInt32(response.interestId ?? 0);
        writeSequence(itemWriter, response.objectStates ?? [], (stateWriter, state) => {
            stateWriter.writeUInt32(state.id ?? 0);
            stateWriter.writeInt64(state.timestamp ?? 0n);
            stateWriter.writeBuffer(state.state ?? Buffer.alloc(0));
        });
    });
}

function writeTypesInfoResponse(writer, value = {}) {
    writer.writeUInt32(value.ownerId ?? 0);
    writeSequence(writer, value.types ?? [], writeTypeSpecResponse);
}

function writeTypesInfoRejection(writer, value = {}) {
    writer.writeUInt32(value.ownerId ?? 0);
    writeStringList(writer, value.rejections ?? []);
}

function readTypesInfoResponse(reader) {
    return {
        ownerId: reader.readUInt32(),
        types: readSequence(reader, readTypeSpecResponse)
    };
}

function readTypesInfoRejection(reader) {
    return {
        ownerId: reader.readUInt32(),
        rejections: readStringList(reader)
    };
}

function readObjectAdded(reader) {
    return {
        className: reader.readString(),
        typeHash: reader.readUInt32(),
        name: reader.readString(),
        id: reader.readUInt32(),
        state: reader.readBuffer(),
        time: reader.readInt64()
    };
}

function readInterestDiscovery(reader) {
    const interestId = reader.readUInt32();
    const objectCount = reader.readCount('published object sequence');
    const objects = [];
    for (let i = 0; i < objectCount; i += 1) {
        objects.push(readObjectAdded(reader));
    }
    return { interestId, objects };
}

function readObjectsPublished(reader) {
    const ownerId = reader.readUInt32();
    const discoveryCount = reader.readCount('interest discovery sequence');
    const discoveries = [];
    for (let i = 0; i < discoveryCount; i += 1) {
        discoveries.push(readInterestDiscovery(reader));
    }
    return { ownerId, discoveries };
}

function readObjectsRemoved(reader) {
    const removalCount = reader.readCount('object removal sequence');
    const removals = [];
    for (let i = 0; i < removalCount; i += 1) {
        removals.push({
            interestId: reader.readUInt32(),
            ids: readU32List(reader)
        });
    }
    return { removals };
}

function readObjectIdsByInterestList(reader) {
    const count = reader.readCount('object state request sequence');
    const requests = [];
    for (let i = 0; i < count; i += 1) {
        requests.push({
            interestId: reader.readUInt32(),
            objectIds: readU32List(reader)
        });
    }
    return requests;
}

function writeObjectIdsByInterestList(writer, requests = []) {
    writer.writeUInt32(requests.length);
    for (const request of requests) {
        writer.writeUInt32(request.interestId);
        writeU32List(writer, request.objectIds);
    }
}

function readObjectState(reader) {
    return {
        id: reader.readUInt32(),
        timestamp: reader.readInt64(),
        state: reader.readBuffer()
    };
}

function readObjectsStateResponse(reader) {
    const ownerId = reader.readUInt32();
    const groupCount = reader.readCount('object state response group sequence');
    const responses = [];
    for (let i = 0; i < groupCount; i += 1) {
        const interestId = reader.readUInt32();
        const objectStateCount = reader.readCount('object state sequence');
        const objectStates = [];
        for (let j = 0; j < objectStateCount; j += 1) {
            objectStates.push(readObjectState(reader));
        }
        responses.push({ interestId, objectStates });
    }
    return { ownerId, responses };
}


/**
 * @param {{ type: string, value?: object }} message
 */
export function encodeKernelControlMessage(message) {
    const type = message.type;
    const value = message.value ?? {};

    if (!(type in KERNEL_CONTROL_MESSAGE_KEY)) {
        throw new TypeError(`unknown SEN kernel ControlMessage: ${type}`);
    }

    const writer = new SenBinaryWriter();
    writer.writeUInt32(KERNEL_CONTROL_MESSAGE_KEY[type]);

    switch (type) {
        case 'RemoteParticipantReady':
            writer.writeUInt32(value.id);
            break;
        case 'InterestStarted':
            writer.writeString(value.query);
            writer.writeUInt32(value.id ?? crc32(value.query));
            break;
        case 'InterestStopped':
            writer.writeUInt32(value.id);
            break;
        case 'ObjectsStateRequest':
            writer.writeUInt32(value.ownerId);
            writeObjectIdsByInterestList(writer, value.requests);
            break;
        case 'TypesInfoRequest':
            writer.writeUInt32(value.ownerId);
            writeU32List(writer, value.requests);
            break;
        case 'ObjectsPublished':
            writeObjectsPublished(writer, value);
            break;
        case 'ObjectsRemoved':
            writeObjectsRemoved(writer, value);
            break;
        case 'ObjectsStateResponse':
            writeObjectsStateResponse(writer, value);
            break;
        case 'TypesInfoResponse':
            writeTypesInfoResponse(writer, value);
            break;
        case 'TypesInfoRejection':
            writeTypesInfoRejection(writer, value);
            break;
        default:
            throw new TypeError(`encoding SEN kernel ControlMessage ${type} is not implemented`);
    }

    return writer.toBuffer();
}

/**
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeKernelControlMessage(buffer, limits = {}) {
    const reader = new SenBinaryReader(buffer, limits);
    const key = reader.readUInt32();
    const type = kernelControlTypeFromKey(key);

    if (!type) {
        throw new RangeError(`unknown SEN kernel ControlMessage key: ${key}`);
    }

    let value = {};
    switch (type) {
        case 'RemoteParticipantReady':
            value = { id: reader.readUInt32() };
            break;
        case 'InterestStarted':
            value = { query: reader.readString(), id: reader.readUInt32() };
            break;
        case 'InterestStopped':
            value = { id: reader.readUInt32() };
            break;
        case 'ObjectsPublished':
            value = readObjectsPublished(reader);
            break;
        case 'ObjectsRemoved':
            value = readObjectsRemoved(reader);
            break;
        case 'ObjectsStateRequest':
            value = { ownerId: reader.readUInt32(), requests: readObjectIdsByInterestList(reader) };
            break;
        case 'ObjectsStateResponse':
            value = readObjectsStateResponse(reader);
            break;
        case 'TypesInfoRequest':
            value = { ownerId: reader.readUInt32(), requests: readU32List(reader) };
            break;
        case 'TypesInfoResponse':
            value = readTypesInfoResponse(reader);
            break;
        case 'TypesInfoRejection':
            value = readTypesInfoRejection(reader);
            break;
        default:
            value = { raw: reader.buffer.subarray(reader.offset) };
            reader.offset = reader.buffer.length;
            break;
    }

    return {
        type,
        value,
        bytesRead: reader.offset
    };
}

export function encodeBusControlMessage(message) {
    const writer = new SenBinaryWriter();
    writer.writeUInt8(BUS_MESSAGE_CATEGORY.controlMessage);
    writer.chunks.push(encodeKernelControlMessage(message));
    return writer.toBuffer();
}
