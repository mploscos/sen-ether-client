import { SenBinaryReader, SenBinaryWriter } from './codec.js';
import { decodePropertyUpdateBuffer } from './bus.js';

function numberOrBigInt(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function normalizeTypeName(typeName) {
  switch (typeName) {
    case 'bool':
    case 'booleanType':
      return 'boolean';
    case 'float':
    case 'float32Type':
      return 'f32';
    case 'double':
    case 'float64Type':
      return 'f64';
    case 'uint8Type':
      return 'u8';
    case 'int16Type':
      return 'i16';
    case 'uint16Type':
      return 'u16';
    case 'int32Type':
      return 'i32';
    case 'uint32Type':
      return 'u32';
    case 'int64Type':
      return 'i64';
    case 'uint64Type':
      return 'u64';
    case 'stringType':
      return 'string';
    case 'durationType':
      return 'Duration';
    case 'timestampType':
      return 'TimeStamp';
    default:
      return typeName;
  }
}

function findTypeSpec(typeRegistry, typeName) {
  if (!typeRegistry) {
    return undefined;
  }
  if (typeof typeRegistry.get === 'function') {
    return typeRegistry.get(typeName);
  }
  return typeRegistry[typeName];
}

function classSpecData(spec) {
  return spec?.data?.type === 'ClassTypeSpec' ? spec.data.value : undefined;
}

function collectClassProperties(spec, typeRegistry, seen = new Set()) {
  const data = classSpecData(spec);
  if (!data || seen.has(spec.qualifiedName)) {
    return [];
  }
  seen.add(spec.qualifiedName);

  return [
    ...(data.parents ?? []).flatMap(parent => collectClassProperties(findTypeSpec(typeRegistry, parent), typeRegistry, seen)),
    ...data.properties
  ];
}

function decodeEnum(reader, spec) {
  const storage = spec.data.value.storageType;
  return decodeValueFromReader(reader, storage);
}

function decodeStruct(reader, spec, typeRegistry) {
  const result = {};
  for (const field of spec.data.value.fields) {
    result[field.name] = decodeValueFromReader(reader, field.type, typeRegistry);
  }
  return result;
}

function decodeSequence(reader, spec, typeRegistry) {
  if (spec.data.value.elementType === 'u8' || spec.data.value.elementType === 'uint8Type') {
    return reader.readBuffer();
  }

  const count = reader.readUInt32();
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(decodeValueFromReader(reader, spec.data.value.elementType, typeRegistry));
  }
  return values;
}

function decodeVariant(reader, spec, typeRegistry) {
  const key = reader.readUInt32();
  const field = spec.data.value.fields.find(candidate => candidate.key === key);
  if (!field) {
    throw new TypeError(`unknown SEN variant key ${key} for ${spec.qualifiedName}`);
  }
  return {
    key,
    type: field.type,
    value: decodeValueFromReader(reader, field.type, typeRegistry)
  };
}

function decodeCustom(reader, spec, typeRegistry) {
  switch (spec.data.type) {
    case 'EnumTypeSpec':
      return decodeEnum(reader, spec);
    case 'StructTypeSpec':
      return decodeStruct(reader, spec, typeRegistry);
    case 'AliasTypeSpec':
      return decodeValueFromReader(reader, spec.data.value.aliasedType, typeRegistry);
    case 'OptionalTypeSpec':
      return reader.readBool() ? decodeValueFromReader(reader, spec.data.value.type, typeRegistry) : null;
    case 'QuantityTypeSpec':
      return decodeValueFromReader(reader, spec.data.value.elementType.value, typeRegistry);
    case 'SequenceTypeSpec':
      return decodeSequence(reader, spec, typeRegistry);
    case 'VariantTypeSpec':
      return decodeVariant(reader, spec, typeRegistry);
    default:
      throw new TypeError(`decoding SEN type kind ${spec.data.type} is not implemented`);
  }
}

function writeInteger(writer, value, write) {
  if (!Number.isInteger(Number(value))) {
    throw new TypeError(`SEN integer value expected, got ${value}`);
  }
  write.call(writer, value);
}

function encodeEnum(writer, value, spec) {
  const storage = spec.data.value.storageType;
  let key = value;
  if (typeof value === 'string') {
    const item = spec.data.value.enums.find(candidate => candidate.name === value);
    if (!item) {
      throw new TypeError(`unknown SEN enum value ${value} for ${spec.qualifiedName}`);
    }
    key = item.key;
  }
  encodeValueToWriter(writer, key, storage);
}

function encodeStruct(writer, value, spec, typeRegistry) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`SEN struct ${spec.qualifiedName} expects an object value`);
  }

  for (const field of spec.data.value.fields) {
    encodeValueToWriter(writer, value[field.name], field.type, typeRegistry);
  }
}

function encodeSequence(writer, value, spec, typeRegistry) {
  if (spec.data.value.elementType === 'u8' || spec.data.value.elementType === 'uint8Type') {
    writer.writeBuffer(value);
    return;
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`SEN sequence ${spec.qualifiedName} expects an array value`);
  }
  writer.writeUInt32(value.length);
  for (const item of value) {
    encodeValueToWriter(writer, item, spec.data.value.elementType, typeRegistry);
  }
}

function encodeVariant(writer, value, spec, typeRegistry) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`SEN variant ${spec.qualifiedName} expects { key|type, value }`);
  }

  const field = value.key !== undefined
    ? spec.data.value.fields.find(candidate => candidate.key === value.key)
    : spec.data.value.fields.find(candidate => candidate.type === value.type);
  if (!field) {
    throw new TypeError(`unknown SEN variant field for ${spec.qualifiedName}: ${value.key ?? value.type}`);
  }

  writer.writeUInt32(field.key);
  encodeValueToWriter(writer, value.value, field.type, typeRegistry);
}

function encodeCustom(writer, value, spec, typeRegistry) {
  switch (spec.data.type) {
    case 'EnumTypeSpec':
      encodeEnum(writer, value, spec);
      break;
    case 'StructTypeSpec':
      encodeStruct(writer, value, spec, typeRegistry);
      break;
    case 'AliasTypeSpec':
      encodeValueToWriter(writer, value, spec.data.value.aliasedType, typeRegistry);
      break;
    case 'OptionalTypeSpec':
      writer.writeBool(value !== null && value !== undefined);
      if (value !== null && value !== undefined) {
        encodeValueToWriter(writer, value, spec.data.value.type, typeRegistry);
      }
      break;
    case 'QuantityTypeSpec':
      encodeValueToWriter(writer, value, spec.data.value.elementType.value, typeRegistry);
      break;
    case 'SequenceTypeSpec':
      encodeSequence(writer, value, spec, typeRegistry);
      break;
    case 'VariantTypeSpec':
      encodeVariant(writer, value, spec, typeRegistry);
      break;
    default:
      throw new TypeError(`encoding SEN type kind ${spec.data.type} is not implemented`);
  }
}

export function decodeValueFromReader(reader, typeName, typeRegistry) {
  const normalized = normalizeTypeName(typeName);

  switch (normalized) {
    case 'u8':
      return reader.readUInt8();
    case 'i16':
      return reader.readInt16();
    case 'u16':
      return reader.readUInt16();
    case 'i32':
      return reader.readInt32();
    case 'u32':
      return reader.readUInt32();
    case 'i64':
    case 'Duration':
    case 'TimeStamp':
      return reader.readInt64();
    case 'u64':
      return numberOrBigInt(reader.readUInt64());
    case 'f32':
      return reader.readFloat32();
    case 'f64':
      return reader.readFloat64();
    case 'boolean':
      return reader.readBool();
    case 'string':
      return reader.readString();
    case 'Buffer':
    case 'buffer':
    case 'binary':
      return reader.readBuffer();
    default: {
      const spec = findTypeSpec(typeRegistry, normalized);
      if (!spec) {
        throw new TypeError(`unknown SEN value type: ${normalized}`);
      }
      return decodeCustom(reader, spec, typeRegistry);
    }
  }
}

export function encodeValueToWriter(writer, value, typeName, typeRegistry) {
  const normalized = normalizeTypeName(typeName);

  switch (normalized) {
    case 'u8':
      writeInteger(writer, value, writer.writeUInt8);
      break;
    case 'i16':
      writeInteger(writer, value, writer.writeInt16);
      break;
    case 'u16':
      writeInteger(writer, value, writer.writeUInt16);
      break;
    case 'i32':
      writeInteger(writer, value, writer.writeInt32);
      break;
    case 'u32':
      writeInteger(writer, value, writer.writeUInt32);
      break;
    case 'i64':
    case 'Duration':
    case 'TimeStamp':
      writer.writeInt64(value);
      break;
    case 'u64':
      writer.writeUInt64(value);
      break;
    case 'f32':
      writer.writeFloat32(Number(value));
      break;
    case 'f64':
      writer.writeFloat64(Number(value));
      break;
    case 'boolean':
      writer.writeBool(Boolean(value));
      break;
    case 'string':
      writer.writeString(value);
      break;
    case 'Buffer':
    case 'buffer':
    case 'binary':
      writer.writeBuffer(value);
      break;
    default: {
      const spec = findTypeSpec(typeRegistry, normalized);
      if (!spec) {
        throw new TypeError(`unknown SEN value type: ${normalized}`);
      }
      encodeCustom(writer, value, spec, typeRegistry);
      break;
    }
  }
}

export function encodeValue(value, typeName, typeRegistry) {
  const writer = new SenBinaryWriter();
  encodeValueToWriter(writer, value, typeName, typeRegistry);
  return writer.toBuffer();
}

export function encodeArguments(values, argSpecs = [], typeRegistry) {
  if ((values?.length ?? 0) !== argSpecs.length) {
    throw new TypeError(`SEN method expects ${argSpecs.length} argument(s), got ${values?.length ?? 0}`);
  }

  const writer = new SenBinaryWriter();
  for (let i = 0; i < argSpecs.length; i += 1) {
    encodeValueToWriter(writer, values[i], argSpecs[i].type, typeRegistry);
  }
  return writer.toBuffer();
}

export function decodeArguments(buffer, argSpecs = [], typeRegistry) {
  const reader = new SenBinaryReader(buffer);
  const values = [];
  for (const arg of argSpecs) {
    values.push(decodeValueFromReader(reader, arg.type, typeRegistry));
  }
  if (reader.remaining() !== 0) {
    throw new RangeError(`SEN argument decoder left ${reader.remaining()} unread bytes`);
  }
  return values;
}

export function decodeValue(buffer, typeName, typeRegistry) {
  const reader = new SenBinaryReader(buffer);
  const value = decodeValueFromReader(reader, typeName, typeRegistry);
  if (reader.remaining() !== 0) {
    throw new RangeError(`SEN value decoder left ${reader.remaining()} unread bytes for ${typeName}`);
  }
  return value;
}

export function decodePropertyValues(buffer, classSpec, typeRegistry, options = {}) {
  const strict = options.strict ?? false;
  const propertyNames = options.propertyNames
    ? new Set([...options.propertyNames].map(name => String(name)))
    : undefined;
  const propertyIds = options.propertyIds
    ? new Set([...options.propertyIds].map(id => Number(id)))
    : undefined;
  const properties = collectClassProperties(classSpec, typeRegistry);
  const propertiesById = new Map(properties.map(property => [property.id, property]));

  const values = [];
  for (const update of decodePropertyUpdateBuffer(buffer)) {
    if (propertyIds && !propertyIds.has(update.id)) {
      continue;
    }
    const property = propertiesById.get(update.id);
    if (!property) {
      if (strict) {
        throw new TypeError(`unknown SEN property id: ${update.id}`);
      }
      values.push({
        ...update,
        name: undefined,
        type: undefined,
        value: undefined,
        decoded: false
      });
      continue;
    }

    if (propertyNames && !propertyNames.has(property.name)) {
      continue;
    }

    try {
      values.push({
        ...update,
        name: property.name,
        type: property.type,
        property,
        value: decodeValue(update.value, property.type, typeRegistry),
        decoded: true
      });
    } catch (error) {
      if (strict) {
        throw error;
      }
      values.push({
        ...update,
        name: property.name,
        type: property.type,
        property,
        value: undefined,
        error,
        decoded: false
      });
    }
  }
  return values;
}
