/**
 * @fileoverview Shared identity, TypeSpec and value helpers for remote objects.
 *
 * The functions are free of transport state so `SenBus`, `SenInterest` and
 * `SenRemoteObject` can stay small without duplicating ownership rules.
 */

import { isDeepStrictEqual } from 'node:util';

export const STATE_RESYNC_DELAYS_MS = [250, 1000, 3000, 8000];
export const STATE_RESYNC_INTERVAL_MS = 1000;
export const RUNTIME_EVENT_DEDUPE_LIMIT = 2048;
const PRIMITIVE_TYPE_NAMES = new Set([
    'bool', 'boolean', 'float', 'double', 'f32', 'f64',
    'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64',
    'string', 'Buffer', 'buffer', 'binary', 'Duration', 'TimeStamp', 'void',
    // TypeSpec payloads use the protocol enum names rather than STL aliases.
    'booleanType', 'float32Type', 'float64Type',
    'uint8Type', 'int16Type', 'uint16Type', 'int32Type', 'uint32Type',
    'int64Type', 'uint64Type', 'stringType', 'durationType', 'timestampType'
]);

/** Compare decoded Sen values, treating numeric `-0` and `0` as equal. */
export function senValuesEqual(left, right) {
    // SEN numeric setters use value equality, where -0 and 0 are equivalent.
    // The deep comparison covers decoded structs, sequences, variants and buffers.
    return left === right || isDeepStrictEqual(left, right);
}

function classSpecData(spec) {
    return spec?.data?.type === 'ClassTypeSpec' ? spec.data.value : undefined;
}

/** Look up a TypeSpec in map-like or record-like registries. */
export function findTypeSpec(typeRegistry, typeName) {
    return typeRegistry?.get?.(typeName) ?? typeRegistry?.[typeName];
}

function typeSpecEntries(types) {
    const resolved = typeof types?.toTypeSpecs === 'function' ? types.toTypeSpecs() : types;
    if (!resolved) return [];
    if (resolved instanceof Map) return [...resolved.values()];
    return Array.isArray(resolved) ? resolved : Object.values(resolved);
}

/** Merge base and per-operation types with later qualified names winning. */
export function mergedTypeDefinitions(base, override) {
    const values = [...typeSpecEntries(base), ...typeSpecEntries(override)].filter(Boolean);
    if (!values.length) return undefined;
    const result = new Map();
    for (const spec of values) result.set(spec.qualifiedName ?? spec.name, spec);
    return result;
}

/** Collect inherited class members of the requested member collection. */
export function collectClassMembers(spec, typeRegistry, member, seen = new Set()) {
    const data = classSpecData(spec);
    const key = spec?.qualifiedName ?? spec?.name;
    if (!data || seen.has(key)) {
        return [];
    }
    seen.add(key);

    return [
        ...(data.parents ?? []).flatMap(parent => collectClassMembers(findTypeSpec(typeRegistry, parent), typeRegistry, member, seen)),
        ...(data[member] ?? [])
    ];
}

/** Traverse structural references and return every required non-primitive name. */
export function collectReferencedTypeNames(typeNames, typeRegistry) {
    const required = new Set();
    const pending = [...typeNames];

    while (pending.length) {
        const typeName = String(pending.pop() || '').trim();
        if (!typeName || PRIMITIVE_TYPE_NAMES.has(typeName) || required.has(typeName)) {
            continue;
        }
        required.add(typeName);

        const spec = findTypeSpec(typeRegistry, typeName);
        const value = spec?.data?.value ?? {};
        switch (spec?.data?.type) {
            case 'ClassTypeSpec':
                pending.push(...(value.parents ?? []));
                pending.push(...(value.properties ?? []).map(item => item.type));
                for (const method of value.methods ?? []) {
                    pending.push(...(method.args ?? []).map(arg => arg.type), method.returnType);
                }
                for (const event of value.events ?? []) {
                    pending.push(...(event.args ?? []).map(arg => arg.type));
                }
                break;
            case 'StructTypeSpec':
            case 'VariantTypeSpec':
                pending.push(...(value.fields ?? []).map(field => field.type));
                break;
            case 'SequenceTypeSpec':
                pending.push(value.elementType);
                break;
            case 'AliasTypeSpec':
                pending.push(value.aliasedType);
                break;
            case 'OptionalTypeSpec':
                pending.push(value.type);
                break;
            case 'QuantityTypeSpec':
                pending.push(value.elementType?.value);
                break;
            default:
                break;
        }
    }

    return required;
}

/** Find a named protocol member in a flat collection. */
export function findByName(items, name) {
    return items.find(item => item.name === name);
}

/** Return the native setter method name for a writable property. */
export function setterName(propertyName) {
    return `setNext${propertyName.slice(0, 1).toUpperCase()}${propertyName.slice(1)}`;
}


/** Render an object selector for diagnostics without executing predicates. */
export function selectorDescription(selector) {
    return typeof selector === 'function' ? '<predicate>' : String(selector);
}

/** Normalize a comma-separated or array property filter to a set. */
export function normalizePropertyNames(properties) {
    if (!properties) {
        return undefined;
    }
    const values = Array.isArray(properties)
        ? properties
        : String(properties).split(',');
    const names = values.map(value => String(value).trim()).filter(Boolean);
    return names.length ? new Set(names) : undefined;
}

/** Normalize an optional nanosecond timestamp to `bigint`. */
export function normalizeTimestampNs(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return typeof value === 'bigint' ? value : BigInt(value);
}

/** Build the pending-state key scoped by interest, owner and object. */
export function stateRequestKey(interestId, ownerId, objectId) {
    return `${interestId >>> 0}:${remoteObjectKey(ownerId, objectId)}`;
}

/** Build remote object identity from owner and ObjectId. */
export function remoteObjectKey(ownerId, objectId) {
    const owner = ownerId === undefined || ownerId === null ? 'unknown' : String(ownerId >>> 0);
    return `${owner}:${objectId >>> 0}`;
}

/** Resolve the provider identity carried by validated bus event metadata. */
export function eventOwnerId(event) {
    if (event?.providerId !== undefined) {
        return event.providerId;
    }
    if (event?.ownerId !== undefined) {
        return event.ownerId;
    }
    return event?.multicast ? undefined : event?.to;
}

/** Build a stable deduplication key when an event has a creation timestamp. */
export function runtimeEventDedupeKey(ownerId, item) {
    if (item.creationTime === undefined || item.creationTime === null) {
        return undefined;
    }
    const owner = ownerId === undefined || ownerId === null ? 'unknown' : String(ownerId >>> 0);
    const args = Buffer.from(item.argumentsBuffer ?? []).toString('hex');
    return `${owner}:${item.producerId >>> 0}:${item.eventId >>> 0}:${String(item.creationTime)}:${args}`;
}
