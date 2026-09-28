/**
 * @fileoverview Type-aware construction and encoding of local Sen objects.
 *
 * Helpers in this file walk inherited class members, infer simple schemas and
 * encode full or partial state. They are transport-independent.
 */

import { methodHash } from './hash32.js';
import { makeObjectId } from './object-id.js';
import { senTypeHash } from './type-hash.js';
import { encodePropertyUpdateBuffer } from './values.js';

function classSpecData(spec) {
    return spec?.data?.type === 'ClassTypeSpec' ? spec.data.value : undefined;
}

function localTypeSpec(typeRegistry, typeName) {
    return typeRegistry?.get?.(typeName) ?? typeRegistry?.[typeName];
}

/** Collect inherited and directly declared class properties in wire order. */
export function collectClassProperties(spec, typeRegistry, seen = new Set()) {
    const data = classSpecData(spec);
    const key = spec?.qualifiedName ?? spec?.name;
    if (!data || seen.has(key)) {
        return [];
    }
    seen.add(key);
    return [
        ...(data.parents ?? []).flatMap(parent => collectClassProperties(localTypeSpec(typeRegistry, parent), typeRegistry, seen)),
        ...(data.properties ?? [])
    ];
}

/** Collect inherited and directly declared class methods in wire order. */
export function collectClassMethods(spec, typeRegistry, seen = new Set()) {
    const data = classSpecData(spec);
    const key = spec?.qualifiedName ?? spec?.name;
    if (!data || seen.has(key)) {
        return [];
    }
    seen.add(key);
    return [
        ...(data.parents ?? []).flatMap(parent => collectClassMethods(localTypeSpec(typeRegistry, parent), typeRegistry, seen)),
        ...(data.methods ?? [])
    ];
}

/** Collect inherited and directly declared class events in wire order. */
export function collectClassEvents(spec, typeRegistry, seen = new Set()) {
    const data = classSpecData(spec);
    const key = spec?.qualifiedName ?? spec?.name;
    if (!data || seen.has(key)) {
        return [];
    }
    seen.add(key);
    return [
        ...(data.parents ?? []).flatMap(parent => collectClassEvents(localTypeSpec(typeRegistry, parent), typeRegistry, seen)),
        ...(data.events ?? [])
    ];
}

const PRIMITIVE_TYPES = new Set([
    'bool',
    'boolean',
    'float',
    'double',
    'f32',
    'f64',
    'i8',
    'u8',
    'i16',
    'u16',
    'i32',
    'u32',
    'i64',
    'u64',
    'string',
    'Buffer',
    'buffer',
    'binary',
    'Duration',
    'TimeStamp',
    'void'
]);

/** Return structural hashes for every non-primitive referenced TypeSpec. */
export function collectTypeDependencies(spec, typeRegistry, seen = new Set()) {
    const dependencies = new Set();
    const addType = typeName => {
        const name = String(typeName || '').trim();
        if (!name || PRIMITIVE_TYPES.has(name) || seen.has(name)) return;
        const nested = localTypeSpec(typeRegistry, name);
        if (!nested) return;
        seen.add(name);
        dependencies.add(senTypeHash(nested, typeRegistry));
        for (const dependency of collectTypeDependencies(nested, typeRegistry, seen)) {
            dependencies.add(dependency);
        }
    };

    const data = spec?.data;
    const value = data?.value ?? {};
    switch (data?.type) {
        case 'ClassTypeSpec':
            for (const parent of value.parents ?? []) addType(parent);
            for (const item of value.properties ?? []) addType(item.type);
            for (const item of value.methods ?? []) {
                for (const arg of item.args ?? []) addType(arg.type);
                addType(item.returnType);
            }
            for (const item of value.events ?? []) {
                for (const arg of item.args ?? []) addType(arg.type);
            }
            break;
        case 'StructTypeSpec':
            for (const field of value.fields ?? []) addType(field.type);
            break;
        case 'SequenceTypeSpec':
            addType(value.elementType);
            break;
        case 'VariantTypeSpec':
            for (const field of value.fields ?? []) addType(field.type);
            break;
        case 'AliasTypeSpec':
            addType(value.aliasedType);
            break;
        case 'OptionalTypeSpec':
            addType(value.type);
            break;
        case 'QuantityTypeSpec':
            addType(value.elementType?.value);
            break;
        default:
            break;
    }
    return dependencies;
}

function inferValueType(value) {
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') return Number.isInteger(value) ? 'i64' : 'f64';
    if (typeof value === 'bigint') return 'i64';
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) return 'Buffer';
    if (typeof value === 'string' || value === null || value === undefined) return 'string';
    throw new TypeError('cannot infer SEN type for structured value; pass an explicit spec and dependent types');
}

function ensureClassSpec(className, state = {}, spec) {
    if (spec) return spec;
    const properties = Object.entries(state || {}).map(([name, value]) => ({
        name,
        description: '',
        category: 'dynamicRO',
        type: inferValueType(value),
        transportMode: 'confirmed',
        tags: [],
        checkedSet: false
    }));
    return {
        name: String(className || '').split('.').pop() || String(className || ''),
        qualifiedName: className,
        description: '',
        data: {
            type: 'ClassTypeSpec',
            value: {
                properties,
                methods: [],
                events: [],
                constructor: { name: '', description: '', args: [], returnType: '' },
                parents: [],
                isInterface: false
            }
        }
    };
}

/** Normalize map, array or object type registries to a dense array. */
export function normalizeTypeDefinitions(typeDefinitions = []) {
    const values = typeDefinitions instanceof Map
        ? [...typeDefinitions.values()]
        : Array.isArray(typeDefinitions)
            ? typeDefinitions
            : Object.values(typeDefinitions || {});
    return values.filter(Boolean);
}


/** Validate and normalize one JavaScript publication descriptor. */
export function buildLocalObject(input, typeRegistry, options = {}) {
    const className = String(input.className ?? input.classname ?? input.type ?? '').trim();
    if (!className) {
        throw new TypeError('SEN published object requires className');
    }
    const name = String(input.name ?? '').trim();
    if (!name) {
        throw new TypeError('SEN published object requires name');
    }
    const id = input.id ?? makeObjectId(name);
    const state = input.state ?? input.snapshot ?? input.properties ?? {};
    const suppliedSpec = input.spec ?? localTypeSpec(typeRegistry, className);
    if (!suppliedSpec && options.strictTypes) {
        throw new TypeError(`SEN published object className '${className}' was not found in the configured STL types`);
    }
    if (suppliedSpec?.data?.type && suppliedSpec.data.type !== 'ClassTypeSpec') {
        throw new TypeError(`SEN published object className '${className}' does not resolve to a ClassTypeSpec`);
    }
    const spec = ensureClassSpec(className, state, suppliedSpec);
    const registry = new Map(typeRegistry);
    registry.set(spec.qualifiedName, spec);
    const typeHash = input.typeHash ?? senTypeHash(spec, registry);
    const properties = collectClassProperties(spec, registry);
    const stateBuffer = input.stateBuffer
        ? Buffer.from(input.stateBuffer)
        : encodePropertyUpdateBuffer(
            properties
                .filter(property => Object.prototype.hasOwnProperty.call(state, property.name))
                .map(property => ({ name: property.name, type: property.type, value: state[property.name] })),
            registry
        );

    return {
        id: id >>> 0,
        name,
        className,
        typeHash: typeHash >>> 0,
        spec,
        state,
        stateBuffer,
        methods: normalizeLocalMethodHandlers(input.methods ?? input.handlers),
        timestamp: input.timestamp ?? input.time ?? BigInt(Date.now()) * 1_000_000n
    };
}

function normalizeLocalMethodHandlers(methods = {}) {
    if (!methods || typeof methods !== 'object') return {};
    const out = {};
    for (const [name, handler] of Object.entries(methods)) {
        if (typeof handler === 'function') out[name] = handler;
    }
    return out;
}

/** Resolve an inherited method by explicit or computed Sen member hash. */
export function methodById(spec, typeRegistry, methodId) {
    return collectClassMethods(spec, typeRegistry)
        .find(method => ((method.id ?? methodHash(method.name)) >>> 0) === (methodId >>> 0));
}

/** Return the native setter method name for a writable property. */
export function setterName(propertyName) {
    return `setNext${propertyName.slice(0, 1).toUpperCase()}${propertyName.slice(1)}`;
}

/** Resolve a writable property from its generated setter method hash. */
export function writablePropertySetterById(spec, typeRegistry, methodId) {
    return collectClassProperties(spec, typeRegistry).find(property => (
        property.category?.endsWith('RW')
    && (methodHash(setterName(property.name)) >>> 0) === (methodId >>> 0)
    ));
}

/** Build the effective type registry for a local object and its bus. */
export function localObjectTypeRegistry(busState, localObject) {
    const registry = new Map(busState.localTypeRegistry);
    registry.set(localObject.spec.qualifiedName, localObject.spec);
    return registry;
}

/** Encode the complete known property state of a local object. */
export function localObjectStateBuffer(localObject, registry, state = localObject.state) {
    const properties = collectClassProperties(localObject.spec, registry);
    return encodePropertyUpdateBuffer(
        properties
            .filter(property => Object.prototype.hasOwnProperty.call(state, property.name))
            .map(property => ({ name: property.name, type: property.type, value: state[property.name] })),
        registry
    );
}

/** Encode a validated partial property update for a local object. */
export function localObjectPatchBuffer(localObject, registry, patch) {
    const propertiesByName = new Map(collectClassProperties(localObject.spec, registry).map(property => [property.name, property]));
    return encodePropertyUpdateBuffer(
        Object.keys(patch).map(name => {
            const property = propertiesByName.get(name);
            if (!property) {
                throw new Error(`SEN property not found: ${localObject.className}.${name}`);
            }
            return { name, type: property.type, value: patch[name] };
        }),
        registry
    );
}

/**
 * Create a ProcessInfo compatible with sen::kernel::getOwnProcessInfo.
 *
 * @param {object} options
 * @param {string} options.sessionName
 * @param {string} [options.appName]
 * @param {string} [options.hostName]
 * @param {number} [options.hostId]
 * @param {number} [options.processId]
 */
