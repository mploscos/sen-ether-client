import { HASH_SEED, hashCombine } from './hash32.js';
import { FindSenUnit } from './types/units.js';

const NON_PRESENT_TYPE_HASH = 18121997;
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
const HASH_COMBINE_MAGIC = 0x9e3779b9;

const TRANSPORT_MODE = Object.freeze({ unicast: 0, multicast: 1, confirmed: 2 });
const PROPERTY_CATEGORY = Object.freeze({ staticRO: 0, staticRW: 1, dynamicRW: 2, dynamicRO: 3 });
const METHOD_CONSTNESS = Object.freeze({ constant: 0, nonConstant: 1 });
const UNIT_CATEGORY = Object.freeze({
  length: 0,
  mass: 1,
  time: 2,
  angle: 3,
  temperature: 4,
  density: 5,
  pressure: 6,
  area: 7,
  force: 8,
  frequency: 9,
  velocity: 10,
  angularVelocity: 11,
  acceleration: 12,
  angularAcceleration: 13,
  torque: 14
});

const NATIVE_NAMES = Object.freeze({
  uint8Type: 'u8',
  int16Type: 'i16',
  uint16Type: 'u16',
  int32Type: 'i32',
  uint32Type: 'u32',
  int64Type: 'i64',
  uint64Type: 'u64',
  float32Type: 'f32',
  float64Type: 'f64',
  booleanType: 'bool',
  stringType: 'string',
  durationType: 'Duration',
  timestampType: 'TimeStamp'
});

const NATIVE_HASHES = new Map(
  ['u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'bool', 'string', 'void']
    .map(name => [name.toLowerCase(), hashCombine(HASH_SEED, name)])
);
// Duration and TimeStamp are built-in QuantityTypes, not name-only native types.
NATIVE_HASHES.set('duration', 884267260);
NATIVE_HASHES.set('timestamp', 3835921985);

function fnv1a(bytes) {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function hashString(value) {
  return fnv1a(Buffer.from(String(value ?? '')));
}

function hashUnsigned(value, byteLength) {
  let remaining = BigInt.asUintN(byteLength * 8, BigInt(value));
  const bytes = Buffer.allocUnsafe(byteLength);
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return fnv1a(bytes);
}

function hashFloat64(value) {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(Number(value), 0);
  return fnv1a(bytes);
}

function combineHashed(seed, hashed) {
  return (seed ^ (
    (hashed + HASH_COMBINE_MAGIC + ((seed << 6) >>> 0) + (seed >>> 2)) >>> 0
  )) >>> 0;
}

const combineString = (seed, value) => combineHashed(seed, hashString(value));
const combineU8 = (seed, value) => combineHashed(seed, hashUnsigned(value, 1));
const combineU32 = (seed, value) => combineHashed(seed, hashUnsigned(value, 4));
const combineU64 = (seed, value) => combineHashed(seed, hashUnsigned(value, 8));
const combineBool = (seed, value) => combineU8(seed, value ? 1 : 0);
const combineFloat64 = (seed, value) => combineHashed(seed, hashFloat64(value));

function enumValue(mapping, value, label) {
  const result = mapping[value];
  if (result === undefined) throw new TypeError(`unknown SEN ${label}: ${value}`);
  return result;
}

function normalizedNativeName(value) {
  let name = String(value ?? '').trim().replace(/^::/, '').replaceAll('::', '.');
  if (name.startsWith('sen.')) name = name.slice(4);
  return NATIVE_NAMES[name] ?? name;
}

function definitionsMap(definitions, ownSpec) {
  const resolved = typeof definitions?.toTypeSpecs === 'function' ? definitions.toTypeSpecs() : definitions;
  const values = resolved instanceof Map
    ? [...resolved.values()]
    : Array.isArray(resolved)
      ? resolved
      : Object.values(resolved ?? {});
  if (ownSpec) values.push(ownSpec);
  const result = new Map();
  for (const spec of values.filter(Boolean)) {
    for (const name of [spec.name, spec.qualifiedName]) {
      if (name) result.set(String(name), spec);
    }
  }
  return result;
}

function findSpec(registry, name) {
  if (registry.has(name)) return registry.get(name);
  const normalized = String(name).replace(/^::/, '').replaceAll('::', '.');
  if (registry.has(normalized)) return registry.get(normalized);
  const short = normalized.split('.').pop();
  const matches = [...new Set([...registry.values()].filter(spec => spec?.name === short))];
  return matches.length === 1 ? matches[0] : undefined;
}

function numericTypeHash(value) {
  if (typeof value === 'string') return nativeTypeHash(value);
  const kind = value?.type;
  const name = NATIVE_NAMES[value?.value] ?? value?.value;
  if (kind !== 'IntegralType' && kind !== 'RealType') {
    throw new TypeError(`unknown SEN numeric type: ${JSON.stringify(value)}`);
  }
  return nativeTypeHash(name);
}

function nativeTypeHash(name) {
  const normalized = normalizedNativeName(name).toLowerCase();
  const hash = NATIVE_HASHES.get(normalized);
  if (hash === undefined) throw new TypeError(`unknown SEN native type '${name}'`);
  return hash;
}

function unitHash(info) {
  const unit = FindSenUnit(info?.name) ?? FindSenUnit(info?.abbreviation);
  if (!unit) throw new TypeError(`unknown SEN unit '${info?.name ?? info?.abbreviation ?? ''}'`);
  let result = HASH_SEED;
  result = combineU32(result, enumValue(UNIT_CATEGORY, unit.category, 'unit category'));
  result = combineString(result, unit.name);
  result = combineString(result, unit.namePlural);
  result = combineString(result, unit.abbreviation);
  result = combineFloat64(result, unit.f);
  result = combineFloat64(result, unit.x);
  result = combineFloat64(result, unit.y);
  return result;
}

function argHash(arg, context) {
  let result = HASH_SEED;
  result = combineString(result, arg?.name ?? '');
  result = combineU32(result, typeReferenceHash(arg?.type, context));
  return result;
}

function callableHash(callable, context) {
  let result = HASH_SEED;
  result = combineString(result, callable?.name ?? '');
  result = combineU8(result, enumValue(TRANSPORT_MODE, callable?.transportMode ?? 'confirmed', 'transport mode'));
  for (const arg of callable?.args ?? []) result = combineHashed(result, argHash(arg, context));
  return result;
}

function methodSpecHash(method, context) {
  let result = HASH_SEED;
  result = combineHashed(result, callableHash(method, context));
  result = combineU32(result, enumValue(METHOD_CONSTNESS, method?.constness ?? 'nonConstant', 'method constness'));
  result = combineU32(result, typeReferenceHash(method?.returnType || 'void', context));
  return result;
}

function eventSpecHash(event, context) {
  return combineHashed(HASH_SEED, callableHash(event, context));
}

function propertySpecHash(property, context) {
  let result = HASH_SEED;
  result = combineString(result, property?.name ?? '');
  result = combineU32(result, enumValue(PROPERTY_CATEGORY, property?.category ?? 'dynamicRO', 'property category'));
  result = combineU8(result, enumValue(TRANSPORT_MODE, property?.transportMode ?? 'multicast', 'transport mode'));
  result = combineU32(result, typeReferenceHash(property?.type, context));
  for (const tag of property?.tags ?? []) result = combineString(result, tag);
  return result;
}

function typeReferenceHash(name, context) {
  const nativeName = normalizedNativeName(name);
  const native = NATIVE_HASHES.get(nativeName.toLowerCase());
  if (native !== undefined) return native;
  const spec = findSpec(context.registry, name);
  if (!spec) throw new TypeError(`cannot compute SEN type hash: unresolved type '${name}'`);
  return customTypeHash(spec, context);
}

function customTypeHash(spec, context) {
  const identity = spec?.qualifiedName ?? spec?.name;
  if (!identity) throw new TypeError('cannot compute SEN type hash for an unnamed TypeSpec');
  if (context.cache.has(identity)) return context.cache.get(identity);
  if (context.active.has(identity)) throw new TypeError(`cannot compute recursive SEN type hash for '${identity}'`);
  context.active.add(identity);

  const name = spec.name ?? String(identity).split('.').pop();
  const qualifiedName = spec.qualifiedName ?? name;
  const data = spec.data ?? {};
  const value = data.value ?? {};
  let result = HASH_SEED;

  switch (data.type) {
    case 'EnumTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, numericTypeHash(value.storageType ?? 'uint32Type'));
      for (const item of value.enums ?? []) {
        let itemHash = HASH_SEED;
        itemHash = combineString(itemHash, item.name ?? '');
        itemHash = combineU32(itemHash, item.key ?? 0);
        result = combineHashed(result, itemHash);
      }
      break;
    case 'QuantityTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, numericTypeHash(value.elementType));
      result = combineU32(result, unitHash(value.unit));
      result = combineFloat64(result,
        value.minValue === undefined || value.minValue === null ? NON_PRESENT_TYPE_HASH : value.minValue);
      result = combineFloat64(result,
        value.maxValue === undefined || value.maxValue === null ? NON_PRESENT_TYPE_HASH : value.maxValue);
      break;
    case 'SequenceTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, typeReferenceHash(value.elementType, context));
      result = combineU64(result,
        value.maxSize === undefined || value.maxSize === null ? NON_PRESENT_TYPE_HASH : value.maxSize);
      result = combineBool(result, value.fixedSize);
      break;
    case 'StructTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, value.parent ? typeReferenceHash(value.parent, context) : NON_PRESENT_TYPE_HASH);
      for (const field of value.fields ?? []) {
        let fieldHash = HASH_SEED;
        fieldHash = combineString(fieldHash, field.name ?? '');
        fieldHash = combineU32(fieldHash, typeReferenceHash(field.type, context));
        result = combineHashed(result, fieldHash);
      }
      break;
    case 'VariantTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      for (const field of value.fields ?? []) {
        let fieldHash = HASH_SEED;
        fieldHash = combineU32(fieldHash, field.key ?? 0);
        fieldHash = combineU32(fieldHash, typeReferenceHash(field.type, context));
        result = combineHashed(result, fieldHash);
      }
      break;
    case 'AliasTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, typeReferenceHash(value.aliasedType, context));
      break;
    case 'OptionalTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      result = combineU32(result, typeReferenceHash(value.type, context));
      break;
    case 'ClassTypeSpec':
      result = combineString(result, name);
      result = combineString(result, qualifiedName);
      for (const property of value.properties ?? []) result = combineHashed(result, propertySpecHash(property, context));
      for (const method of value.methods ?? []) result = combineHashed(result, methodSpecHash(method, context));
      for (const event of value.events ?? []) result = combineHashed(result, eventSpecHash(event, context));
      result = combineU32(result, value.constructor
        ? methodSpecHash(value.constructor, context)
        : NON_PRESENT_TYPE_HASH);
      for (const parent of value.parents ?? []) result = combineU32(result, typeReferenceHash(parent, context));
      break;
    default:
      throw new TypeError(`cannot compute SEN type hash for unsupported TypeSpec '${data.type ?? ''}'`);
  }

  context.active.delete(identity);
  context.cache.set(identity, result >>> 0);
  return result >>> 0;
}

/** Compute SEN's structural Type::getHash() value for a CustomTypeSpec. */
export function senTypeHash(spec, definitions = undefined) {
  const context = {
    registry: definitionsMap(definitions, spec),
    cache: new Map(),
    active: new Set()
  };
  return customTypeHash(spec, context);
}

/** Compute structural hashes for a complete registry of CustomTypeSpecs. */
export function senTypeHashes(definitions) {
  const registry = definitionsMap(definitions);
  const context = { registry, cache: new Map(), active: new Set() };
  const result = new Map();
  for (const spec of new Set(registry.values())) {
    result.set(spec.qualifiedName ?? spec.name, customTypeHash(spec, context));
  }
  return result;
}
