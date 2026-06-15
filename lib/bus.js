import { SenBinaryReader, SenBinaryWriter } from './codec.js';
import { crc32 } from './crc32.js';
import { eventHash, methodHash, propertyHash } from './hash32.js';
import {
  BASIC_TYPE,
  BUILT_IN_TYPE,
  CUSTOM_TYPE_DATA,
  INTEGRAL_TYPE,
  KERNEL_CONTROL_MESSAGE_KEY,
  METHOD_CONSTNESS,
  NUMERIC_TYPE,
  PROPERTY_CATEGORY,
  PROPERTY_RELATION,
  REAL_TYPE,
  TRANSPORT_MODE,
  TYPE_SPEC_RESPONSE,
  UNIT_CATEGORY
} from './protocol/generated.js';

export { KERNEL_CONTROL_MESSAGE_KEY };

export const BUS_MESSAGE_CATEGORY = Object.freeze({
  controlMessage: 0,
  runtimeObjectUpdate: 1,
  runtimeMethodCallBestEffort: 2,
  runtimeMethodCallConfirmed: 3,
  runtimeMethodResponse: 4,
  runtimeEvents: 5
});

const REMOTE_CALL_RESULT = [
  'success',
  'objectNotFound',
  'runtimeError',
  'logicError',
  'unknownException'
];

function enumName(values, code, label) {
  const name = values[code];
  if (name === undefined) {
    throw new RangeError(`unknown SEN ${label} value: ${code}`);
  }
  return name;
}

function kernelControlTypeFromKey(key) {
  for (const [type, value] of Object.entries(KERNEL_CONTROL_MESSAGE_KEY)) {
    if (value === key) {
      return type;
    }
  }
  return undefined;
}

function readSequence(reader, readItem) {
  const count = reader.readUInt32();
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(readItem(reader));
  }
  return values;
}

function readU32List(reader) {
  return readSequence(reader, itemReader => itemReader.readUInt32());
}

function writeU32List(writer, values = []) {
  writer.writeUInt32(values.length);
  for (const value of values) {
    writer.writeUInt32(value);
  }
}

function readStringList(reader) {
  return readSequence(reader, itemReader => itemReader.readString());
}

function readOptional(reader, readValue) {
  return reader.readBool() ? readValue(reader) : null;
}

function readUInt64Json(reader) {
  const value = reader.readUInt64();
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function readIntegralType(reader) {
  return enumName(INTEGRAL_TYPE, reader.readUInt8(), 'IntegralType');
}

function readRealType(reader) {
  return enumName(REAL_TYPE, reader.readUInt8(), 'RealType');
}

function readNumericType(reader) {
  const key = reader.readUInt32();
  const type = enumName(NUMERIC_TYPE, key, 'NumericType');
  switch (type) {
    case 'IntegralType':
      return { type: 'IntegralType', value: readIntegralType(reader) };
    case 'RealType':
      return { type: 'RealType', value: readRealType(reader) };
    default:
      throw new TypeError(`unhandled SEN NumericType alternative: ${type}`);
  }
}

function readBasicType(reader) {
  return enumName(BASIC_TYPE, reader.readUInt8(), 'BasicType');
}

function readBuiltInType(reader) {
  const key = reader.readUInt32();
  const type = enumName(BUILT_IN_TYPE, key, 'BuiltInType');
  switch (type) {
    case 'NumericType':
      return { type: 'NumericType', value: readNumericType(reader) };
    case 'BasicType':
      return { type: 'BasicType', value: readBasicType(reader) };
    default:
      throw new TypeError(`unhandled SEN BuiltInType alternative: ${type}`);
  }
}

function readUnitInfo(reader) {
  return {
    name: reader.readString(),
    abbreviation: reader.readString(),
    category: enumName(UNIT_CATEGORY, reader.readUInt8(), 'UnitCat')
  };
}

function readEnumeratorSpec(reader) {
  return {
    name: reader.readString(),
    key: reader.readUInt32(),
    description: reader.readString()
  };
}

function readEnumTypeSpec(reader) {
  return {
    enums: readSequence(reader, readEnumeratorSpec),
    storageType: readIntegralType(reader)
  };
}

function readQuantityTypeSpec(reader) {
  return {
    elementType: readNumericType(reader),
    unit: readUnitInfo(reader),
    minValue: readOptional(reader, itemReader => itemReader.readFloat64()),
    maxValue: readOptional(reader, itemReader => itemReader.readFloat64())
  };
}

function readSequenceTypeSpec(reader) {
  return {
    elementType: reader.readString(),
    maxSize: readOptional(reader, readUInt64Json),
    fixedSize: reader.readBool()
  };
}

function readStructTypeFieldSpec(reader) {
  return {
    name: reader.readString(),
    description: reader.readString(),
    type: reader.readString()
  };
}

function readStructTypeSpec(reader) {
  return {
    fields: readSequence(reader, readStructTypeFieldSpec),
    parent: reader.readString()
  };
}

function readVariantTypeFieldSpec(reader) {
  return {
    key: reader.readUInt32(),
    description: reader.readString(),
    type: reader.readString()
  };
}

function readVariantTypeSpec(reader) {
  return {
    fields: readSequence(reader, readVariantTypeFieldSpec)
  };
}

function readAliasTypeSpec(reader) {
  return {
    aliasedType: reader.readString()
  };
}

function readOptionalTypeSpec(reader) {
  return {
    type: reader.readString()
  };
}

function readArgSpec(reader) {
  return {
    name: reader.readString(),
    description: reader.readString(),
    type: reader.readString()
  };
}

function readEventSpec(reader) {
  const name = reader.readString();
  return {
    id: eventHash(name),
    name,
    description: reader.readString(),
    args: readSequence(reader, readArgSpec),
    transportMode: enumName(TRANSPORT_MODE, reader.readUInt8(), 'TransportModeSpec')
  };
}

function readMethodSpec(reader) {
  const name = reader.readString();
  return {
    id: methodHash(name),
    name,
    description: reader.readString(),
    args: readSequence(reader, readArgSpec),
    transportMode: enumName(TRANSPORT_MODE, reader.readUInt8(), 'TransportModeSpec'),
    constness: enumName(METHOD_CONSTNESS, reader.readUInt8(), 'MethodConstnessSpec'),
    deferred: reader.readBool(),
    returnType: reader.readString(),
    propertyRelation: enumName(PROPERTY_RELATION, reader.readUInt8(), 'PropertyRelationSpec'),
    localOnly: reader.readBool()
  };
}

function readPropertySpec(reader) {
  const name = reader.readString();
  return {
    id: propertyHash(name),
    name,
    description: reader.readString(),
    category: enumName(PROPERTY_CATEGORY, reader.readUInt8(), 'PropertyCategorySpec'),
    type: reader.readString(),
    transportMode: enumName(TRANSPORT_MODE, reader.readUInt8(), 'TransportModeSpec'),
    tags: readStringList(reader),
    checkedSet: reader.readBool()
  };
}

function readClassTypeSpec(reader) {
  return {
    properties: readSequence(reader, readPropertySpec),
    methods: readSequence(reader, readMethodSpec),
    events: readSequence(reader, readEventSpec),
    constructor: readMethodSpec(reader),
    parents: readStringList(reader),
    isInterface: reader.readBool()
  };
}

function readCustomTypeData(reader) {
  const key = reader.readUInt32();
  const type = enumName(CUSTOM_TYPE_DATA, key, 'CustomTypeData');
  let value;

  switch (type) {
    case 'EnumTypeSpec':
      value = readEnumTypeSpec(reader);
      break;
    case 'QuantityTypeSpec':
      value = readQuantityTypeSpec(reader);
      break;
    case 'SequenceTypeSpec':
      value = readSequenceTypeSpec(reader);
      break;
    case 'StructTypeSpec':
      value = readStructTypeSpec(reader);
      break;
    case 'VariantTypeSpec':
      value = readVariantTypeSpec(reader);
      break;
    case 'AliasTypeSpec':
      value = readAliasTypeSpec(reader);
      break;
    case 'OptionalTypeSpec':
      value = readOptionalTypeSpec(reader);
      break;
    case 'ClassTypeSpec':
      value = readClassTypeSpec(reader);
      break;
    default:
      throw new TypeError(`unhandled SEN CustomTypeData alternative: ${type}`);
  }

  return { type, value };
}

function readCustomTypeSpec(reader) {
  return {
    name: reader.readString(),
    qualifiedName: reader.readString(),
    description: reader.readString(),
    data: readCustomTypeData(reader)
  };
}

function readTypeSpecResponse(reader) {
  const key = reader.readUInt32();
  const type = enumName(TYPE_SPEC_RESPONSE, key, 'TypeSpecResponse');

  switch (type) {
    case 'ClassSpecResponse':
      return {
        type,
        classHash: reader.readUInt32(),
        spec: readCustomTypeSpec(reader),
        dependentTypes: readU32List(reader)
      };
    case 'NonClassSpecResponse':
      return {
        type,
        spec: readCustomTypeSpec(reader)
      };
    default:
      throw new TypeError(`unhandled SEN TypeSpecResponse alternative: ${type}`);
  }
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
  const objectCount = reader.readUInt32();
  const objects = [];
  for (let i = 0; i < objectCount; i += 1) {
    objects.push(readObjectAdded(reader));
  }
  return { interestId, objects };
}

function readObjectsPublished(reader) {
  const ownerId = reader.readUInt32();
  const discoveryCount = reader.readUInt32();
  const discoveries = [];
  for (let i = 0; i < discoveryCount; i += 1) {
    discoveries.push(readInterestDiscovery(reader));
  }
  return { ownerId, discoveries };
}

function readObjectsRemoved(reader) {
  const removalCount = reader.readUInt32();
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
  const count = reader.readUInt32();
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
  const groupCount = reader.readUInt32();
  const responses = [];
  for (let i = 0; i < groupCount; i += 1) {
    const interestId = reader.readUInt32();
    const objectStateCount = reader.readUInt32();
    const objectStates = [];
    for (let j = 0; j < objectStateCount; j += 1) {
      objectStates.push(readObjectState(reader));
    }
    responses.push({ interestId, objectStates });
  }
  return { ownerId, responses };
}

export function decodePropertyUpdateBuffer(buffer) {
  const reader = new SenBinaryReader(buffer);
  const updates = [];

  while (reader.remaining() > 0) {
    const id = reader.readUInt32();
    const size = reader.readUInt32();
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
  reader.ensure(propertiesSize);
  const properties = reader.buffer.subarray(reader.offset, reader.offset + propertiesSize);
  reader.offset += propertiesSize;
  return {
    objectId,
    time,
    propertiesSize,
    properties,
    propertyUpdates: decodePropertyUpdateBuffer(properties)
  };
}

function readRuntimeMethodResponse(reader) {
  const resultCode = reader.readUInt8();
  const result = enumName(REMOTE_CALL_RESULT, resultCode, 'RemoteCallResult');
  const objectId = reader.readUInt32();
  const ticketId = reader.readUInt32();

  if (result === 'success') {
    const returnSize = reader.readUInt32();
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
    const producerId = reader.readUInt32();
    const eventId = reader.readUInt32();
    const creationTime = reader.readInt64();
    const argumentsSize = reader.readUInt32();
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
export function decodeConfirmedBusFrame(buffer) {
  const reader = new SenBinaryReader(buffer);
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
export function decodeBusMessage(buffer) {
  const reader = new SenBinaryReader(buffer);
  const category = reader.readUInt8();
  const payload = reader.buffer.subarray(reader.offset);

  if (category === BUS_MESSAGE_CATEGORY.controlMessage) {
    return {
      category,
      categoryName: 'controlMessage',
      control: decodeKernelControlMessage(payload)
    };
  }

  if (category === BUS_MESSAGE_CATEGORY.runtimeObjectUpdate) {
    return {
      category,
      categoryName: 'runtimeObjectUpdate',
      update: readRuntimeObjectUpdate(reader)
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
    default:
      throw new TypeError(`encoding SEN kernel ControlMessage ${type} is not implemented`);
  }

  return writer.toBuffer();
}

/**
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeKernelControlMessage(buffer) {
  const reader = new SenBinaryReader(buffer);
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
