/**
 * @fileoverview Binary reader/writer functions for Sen TypeSpec structures.
 *
 * These functions translate only the schema portion of the kernel protocol;
 * they do not own sockets, routing state or decoded runtime object values.
 */

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

/** Resolve a numeric enum key or reject an unknown wire value. */
export function enumName(values, code, label) {
    const name = values[code];
    if (name === undefined) {
        throw new RangeError(`unknown SEN ${label} value: ${code}`);
    }
    return name;
}

/** Normalize a required protocol identifier to an unsigned 32-bit value. */
export function requiredUInt32(value, label) {
    if (value === undefined || value === null) {
        throw new TypeError(`missing required SEN ${label}`);
    }
    return value >>> 0;
}

/** Resolve the generated kernel control name for a numeric message key. */
export function kernelControlTypeFromKey(key) {
    for (const [type, value] of Object.entries(KERNEL_CONTROL_MESSAGE_KEY)) {
        if (value === key) {
            return type;
        }
    }
    return undefined;
}

/** Read a bounded Sen sequence with the supplied item decoder. */
export function readSequence(reader, readItem) {
    const count = reader.readCount('sequence');
    const values = [];
    for (let i = 0; i < count; i += 1) {
        values.push(readItem(reader));
    }
    return values;
}

/** Read a bounded sequence of unsigned 32-bit integers. */
export function readU32List(reader) {
    return readSequence(reader, itemReader => itemReader.readUInt32());
}

/** Write a sequence of unsigned 32-bit integers. */
export function writeU32List(writer, values = []) {
    writer.writeUInt32(values.length);
    for (const value of values) {
        writer.writeUInt32(value);
    }
}

function enumKey(values, value, label) {
    const index = values.indexOf(value);
    if (index < 0) {
        throw new RangeError(`unknown SEN ${label} value: ${value}`);
    }
    return index;
}

/** Write a length-prefixed sequence with the supplied item encoder. */
export function writeSequence(writer, values = [], writeItem) {
    writer.writeUInt32(values.length);
    for (const value of values) {
        writeItem(writer, value);
    }
}

/** Write a length-prefixed sequence of UTF-8 strings. */
export function writeStringList(writer, values = []) {
    writeSequence(writer, values, (itemWriter, value) => itemWriter.writeString(value));
}

function writeOptional(writer, value, writeValue) {
    const present = value !== null && value !== undefined;
    writer.writeBool(present);
    if (present) {
        writeValue(writer, value);
    }
}

/** Read a bounded length-prefixed sequence of UTF-8 strings. */
export function readStringList(reader) {
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

/** Decode one class or non-class TypeSpec response. */
export function readTypeSpecResponse(reader) {
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

function writeEnumeratorSpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeUInt32(item.key ?? 0);
    writer.writeString(item.description ?? '');
}

function writeEnumTypeSpec(writer, value = {}) {
    writeSequence(writer, value.enums ?? [], writeEnumeratorSpec);
    writer.writeUInt8(enumKey(INTEGRAL_TYPE, value.storageType ?? 'uint32Type', 'IntegralType'));
}

function writeNumericType(writer, value = {}) {
    const type = value.type ?? 'RealType';
    writer.writeUInt32(enumKey(NUMERIC_TYPE, type, 'NumericType'));
    if (type === 'IntegralType') {
        writer.writeUInt8(enumKey(INTEGRAL_TYPE, value.value ?? 'int32Type', 'IntegralType'));
        return;
    }
    if (type === 'RealType') {
        writer.writeUInt8(enumKey(REAL_TYPE, value.value ?? 'float64Type', 'RealType'));
        return;
    }
    throw new TypeError(`unhandled SEN NumericType alternative: ${type}`);
}

function writeUnitInfo(writer, value = {}) {
    writer.writeString(value.name ?? '');
    writer.writeString(value.abbreviation ?? '');
    writer.writeUInt8(enumKey(UNIT_CATEGORY, value.category ?? 'length', 'UnitCat'));
}

function writeQuantityTypeSpec(writer, value = {}) {
    writeNumericType(writer, value.elementType ?? { type: 'RealType', value: 'float64Type' });
    writeUnitInfo(writer, value.unit ?? {});
    writeOptional(writer, value.minValue, (itemWriter, item) => itemWriter.writeFloat64(Number(item)));
    writeOptional(writer, value.maxValue, (itemWriter, item) => itemWriter.writeFloat64(Number(item)));
}

function writeSequenceTypeSpec(writer, value = {}) {
    writer.writeString(value.elementType ?? '');
    writeOptional(writer, value.maxSize, (itemWriter, item) => itemWriter.writeUInt64(item));
    writer.writeBool(Boolean(value.fixedSize));
}

function writeStructTypeFieldSpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeString(item.description ?? '');
    writer.writeString(item.type ?? '');
}

function writeStructTypeSpec(writer, value = {}) {
    writeSequence(writer, value.fields ?? [], writeStructTypeFieldSpec);
    writer.writeString(value.parent ?? '');
}

function writeVariantTypeFieldSpec(writer, item = {}) {
    writer.writeUInt32(item.key ?? 0);
    writer.writeString(item.description ?? '');
    writer.writeString(item.type ?? '');
}

function writeVariantTypeSpec(writer, value = {}) {
    writeSequence(writer, value.fields ?? [], writeVariantTypeFieldSpec);
}

function writeAliasTypeSpec(writer, value = {}) {
    writer.writeString(value.aliasedType ?? '');
}

function writeOptionalTypeSpec(writer, value = {}) {
    writer.writeString(value.type ?? '');
}

function writeArgSpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeString(item.description ?? '');
    writer.writeString(item.type ?? '');
}

function writeEventSpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeString(item.description ?? '');
    writeSequence(writer, item.args ?? [], writeArgSpec);
    writer.writeUInt8(enumKey(TRANSPORT_MODE, item.transportMode ?? 'confirmed', 'TransportModeSpec'));
}

function writeMethodSpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeString(item.description ?? '');
    writeSequence(writer, item.args ?? [], writeArgSpec);
    writer.writeUInt8(enumKey(TRANSPORT_MODE, item.transportMode ?? 'confirmed', 'TransportModeSpec'));
    writer.writeUInt8(enumKey(METHOD_CONSTNESS, item.constness ?? 'nonConstant', 'MethodConstnessSpec'));
    writer.writeBool(Boolean(item.deferred));
    writer.writeString(item.returnType ?? '');
    writer.writeUInt8(enumKey(PROPERTY_RELATION, item.propertyRelation ?? 'nonPropertyRelated', 'PropertyRelationSpec'));
    writer.writeBool(Boolean(item.localOnly));
}

function writePropertySpec(writer, item = {}) {
    writer.writeString(item.name ?? '');
    writer.writeString(item.description ?? '');
    writer.writeUInt8(enumKey(PROPERTY_CATEGORY, item.category ?? 'dynamicRO', 'PropertyCategorySpec'));
    writer.writeString(item.type ?? '');
    writer.writeUInt8(enumKey(TRANSPORT_MODE, item.transportMode ?? 'confirmed', 'TransportModeSpec'));
    writeStringList(writer, item.tags ?? []);
    writer.writeBool(Boolean(item.checkedSet));
}

function writeClassTypeSpec(writer, value = {}) {
    writeSequence(writer, value.properties ?? [], writePropertySpec);
    writeSequence(writer, value.methods ?? [], writeMethodSpec);
    writeSequence(writer, value.events ?? [], writeEventSpec);
    writeMethodSpec(writer, value.constructor ?? { name: '', returnType: '' });
    writeStringList(writer, value.parents ?? []);
    writer.writeBool(Boolean(value.isInterface));
}

function writeCustomTypeData(writer, data = {}) {
    const type = data.type ?? 'StructTypeSpec';
    const value = data.value ?? {};
    writer.writeUInt32(enumKey(CUSTOM_TYPE_DATA, type, 'CustomTypeData'));

    switch (type) {
        case 'EnumTypeSpec':
            writeEnumTypeSpec(writer, value);
            break;
        case 'QuantityTypeSpec':
            writeQuantityTypeSpec(writer, value);
            break;
        case 'SequenceTypeSpec':
            writeSequenceTypeSpec(writer, value);
            break;
        case 'StructTypeSpec':
            writeStructTypeSpec(writer, value);
            break;
        case 'VariantTypeSpec':
            writeVariantTypeSpec(writer, value);
            break;
        case 'AliasTypeSpec':
            writeAliasTypeSpec(writer, value);
            break;
        case 'OptionalTypeSpec':
            writeOptionalTypeSpec(writer, value);
            break;
        case 'ClassTypeSpec':
            writeClassTypeSpec(writer, value);
            break;
        default:
            throw new TypeError(`unhandled SEN CustomTypeData alternative: ${type}`);
    }
}

function writeCustomTypeSpec(writer, spec = {}) {
    writer.writeString(spec.name ?? '');
    writer.writeString(spec.qualifiedName ?? spec.name ?? '');
    writer.writeString(spec.description ?? '');
    writeCustomTypeData(writer, spec.data);
}

/** Encode one class or non-class TypeSpec response. */
export function writeTypeSpecResponse(writer, item = {}) {
    writer.writeUInt32(enumKey(TYPE_SPEC_RESPONSE, item.type ?? 'NonClassSpecResponse', 'TypeSpecResponse'));
    if ((item.type ?? 'NonClassSpecResponse') === 'ClassSpecResponse') {
        writer.writeUInt32(requiredUInt32(item.classHash, 'classHash'));
        writeCustomTypeSpec(writer, item.spec);
        writeU32List(writer, item.dependentTypes ?? []);
        return;
    }
    writeCustomTypeSpec(writer, item.spec);
}

