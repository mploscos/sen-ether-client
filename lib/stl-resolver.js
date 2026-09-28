/**
 * @fileoverview STL import resolution and adaptation to Sen TypeSpecs.
 *
 * Sources are supplied by callers, which keeps this module synchronous and
 * independent of the filesystem. Parsed declarations are resolved once into a
 * reusable immutable registry.
 */

import { SenUnits } from './types/units.js';
import { parseStl } from './stl-parser.js';

const PRIMITIVES = new Set([
    'bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64',
    'string', 'Duration', 'TimeStamp', 'void'
]);

const NUMERIC_TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);
const INTEGRAL_TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64']);

export class StlResolutionError extends Error {
    constructor(message, node) {
        super(`${message}${node?.location ? ` at ${node.location.line}:${node.location.column}` : ''}`);
        this.name = 'StlResolutionError';
        this.location = node?.location;
    }
}

function declarationName(declaration) {
    return declaration.name;
}

function qualifiedName(packageName, name) {
    return `${packageName}.${name}`;
}

function attribute(declaration, name) {
    return declaration.attributes?.find(item => item.name === name);
}

function resolveTransport(attributes, defaultMode, node) {
    let mode = defaultMode;
    let hasTransport = false;
    for (const item of attributes) {
        if (item.name !== 'confirmed' && item.name !== 'bestEffort') continue;
        if (item.value !== true || hasTransport) throw new StlResolutionError(`invalid or repeated transport attribute '${item.name}'`, node);
        hasTransport = true;
        mode = item.name === 'bestEffort' ? 'unicast' : 'confirmed';
    }
    return mode;
}

function builtInType(name) {
    return PRIMITIVES.has(name) ? { kind: 'PrimitiveType', name, qualifiedName: name } : null;
}

function numericSpec(name) {
    if (INTEGRAL_TYPES.has(name)) {
        const integral = { i8: 'int8Type', u8: 'uint8Type', i16: 'int16Type', u16: 'uint16Type', i32: 'int32Type', u32: 'uint32Type', i64: 'int64Type', u64: 'uint64Type' };
        return { type: 'IntegralType', value: integral[name] };
    }
    if (name === 'f32') return { type: 'RealType', value: 'float32Type' };
    if (name === 'f64') return { type: 'RealType', value: 'float64Type' };
    return null;
}

// Mirror UnitRegistry::UnitRegistry. Conversion factors are not serialized in
// SEN TypeSpecs, so the TypeSpec adapter only needs this transport-visible data.
const DEFAULT_UNITS = new Map(SenUnits().map(({ name, abbreviation, category }) => [
    abbreviation,
    { name, abbreviation, category }
]));

function makeConstructor(type, typeByName) {
    const args = [];
    const seen = new Set();
    const collect = item => {
        if (item.parent) collect(typeByName.get(item.parent));
        for (const property of item.properties ?? []) {
            if (property.category === 'staticRW') args.push({ name: property.name, description: property.description, type: property.type });
        }
    };
    const safeCollect = item => {
        if (!item || seen.has(item.qualifiedName)) return;
        seen.add(item.qualifiedName);
        collect(item);
    };
    safeCollect(type);
    return { name: `constructor${type.name}`, description: 'constructor', args, returnType: 'void' };
}

/** A resolved, immutable STL type registry. */
export class StlTypeRegistry {
    constructor(typeByName, files) {
        this.typeByName = new Map(typeByName);
        this.files = new Map(files);
        Object.freeze(this);
    }

    get(name) { return this.typeByName.get(name); }
    has(name) { return this.typeByName.has(name); }
    values() { return this.typeByName.values(); }

    /** Converts all resolved custom types to sen-ether-client CustomTypeSpecs. */
    toTypeSpecs(options = {}) {
        const units = new Map(DEFAULT_UNITS);
        for (const item of options.units ?? []) units.set(item.abbreviation, item);
        const result = new Map();
        for (const type of this.typeByName.values()) {
            const base = { name: type.name, qualifiedName: type.qualifiedName, description: type.description ?? '' };
            let data;
            switch (type.kind) {
                case 'StructType':
                    data = { type: 'StructTypeSpec', value: { fields: type.fields.map(field => ({ name: field.name, description: field.description, type: field.type })), parent: type.parent ?? '' } };
                    break;
                case 'EnumType':
                    data = { type: 'EnumTypeSpec', value: { storageType: numericSpec(type.storageType)?.value, enums: type.values.map((item, key) => ({ name: item.name, key: item.key ?? key, description: item.description })) } };
                    break;
                case 'VariantType':
                    data = { type: 'VariantTypeSpec', value: { fields: type.fields.map((item, key) => ({ key, description: item.description, type: item.type })) } };
                    break;
                case 'SequenceType':
                    data = { type: 'SequenceTypeSpec', value: { elementType: type.elementType, maxSize: type.maxSize, fixedSize: type.fixedSize } };
                    break;
                case 'AliasType':
                    data = { type: 'AliasTypeSpec', value: { aliasedType: type.target } };
                    break;
                case 'OptionalType':
                    data = { type: 'OptionalTypeSpec', value: { type: type.target } };
                    break;
                case 'QuantityType': {
                    const unit = units.get(type.unit);
                    if (!unit) throw new StlResolutionError(`unknown SEN unit '${type.unit}' while adapting ${type.qualifiedName}`);
                    data = { type: 'QuantityTypeSpec', value: { elementType: numericSpec(type.elementType), unit, minValue: type.minValue, maxValue: type.maxValue } };
                    break;
                }
                case 'ClassType':
                    data = { type: 'ClassTypeSpec', value: {
                        properties: type.properties.map(({ name, description, type: propertyType, category, transportMode, tags, checkedSet }) => ({ name, description, type: propertyType, category, transportMode, tags, checkedSet })),
                        methods: type.methods.map(({ name, description, args, transportMode, constness, deferred, returnType, localOnly }) => ({ name, description, args, transportMode, constness, deferred, returnType, propertyRelation: 'nonPropertyRelated', localOnly })),
                        events: type.events.map(({ name, description, args, transportMode }) => ({ name, description, args, transportMode })),
                        constructor: makeConstructor(type, this.typeByName),
                        parents: type.parents,
                        isInterface: false
                    } };
                    break;
                default:
                    throw new StlResolutionError(`cannot adapt ${type.kind} '${type.qualifiedName}' to TypeSpec`);
            }
            result.set(type.qualifiedName, { ...base, data });
        }
        return result;
    }
}

class Resolver {
    constructor(options) {
        this.sources = options.sources instanceof Map ? options.sources : new Map(Object.entries(options.sources ?? {}));
        this.load = options.load;
        this.resolveExternal = options.resolveExternal;
        this.typeByName = new Map(options.initialTypes ?? []);
        this.files = new Map(options.externalFiles ?? []);
        this.resolving = new Set();
    }

    resolve(entries) {
        for (const entry of Array.isArray(entries) ? entries : [entries]) this.resolveFile(entry);
        return new StlTypeRegistry(this.typeByName, this.files);
    }

    sourceFor(fileName, fromFile) {
        if (this.sources.has(fileName)) return { fileName, source: this.sources.get(fileName) };
        if (this.load) {
            const loaded = this.load(fileName, fromFile);
            if (typeof loaded === 'string') return { fileName, source: loaded };
            if (loaded && typeof loaded.source === 'string' && loaded.fileName) return loaded;
        }
        throw new StlResolutionError(`could not find STL file '${fileName}'`);
    }

    resolveFile(requestedFileName, fromFile) {
        const external = this.resolveExternal?.(requestedFileName, fromFile);
        if (external) return external;
        const loaded = this.sourceFor(requestedFileName, fromFile);
        const fileName = loaded.fileName;
        if (this.files.has(fileName)) return this.files.get(fileName);
        if (this.resolving.has(fileName)) return this.files.get(fileName);
        this.resolving.add(fileName);
        const file = { fileName, packageName: '', imports: [], types: new Map() };
        this.files.set(fileName, file);
        const program = parseStl(loaded.source, { fileName });
        for (const statement of program.statements) {
            if (statement.kind === 'ImportDeclaration') file.imports.push(this.resolveFile(statement.file, fileName));
            else if (statement.kind === 'PackageDeclaration') {
                if (file.packageName) throw new StlResolutionError(`package is already defined as '${file.packageName}'`, statement);
                file.packageName = statement.name;
            } else this.resolveDeclaration(statement, file);
        }
        this.resolving.delete(fileName);
        return file;
    }

    resolveDeclaration(statement, file) {
        if (!file.packageName) throw new StlResolutionError('please specify the package before defining a type', statement);
        if (statement.kind === 'InterfaceDeclaration') {
            // This follows the current official resolver, rather than pretending that
            // parser support means the type is usable by SEN.
            throw new StlResolutionError('STL interfaces are not supported', statement);
        }
        const name = declarationName(statement);
        const qualified = qualifiedName(file.packageName, name);
        if (file.types.has(name) || this.typeByName.has(qualified)) throw new StlResolutionError(`there is already a type named '${qualified}'`, statement);
        const add = value => {
            const resolved = Object.freeze({ ...value, name, qualifiedName: qualified, description: statement.description ?? '', fileName: file.fileName });
            file.types.set(name, resolved);
            this.typeByName.set(qualified, resolved);
        };
        const valueType = (type, node) => this.resolveType(type, file, node, 'value');
        const classType = (type, node) => this.resolveType(type, file, node, 'class');

        switch (statement.kind) {
            case 'StructDeclaration':
                if (statement.parent) {
                    const parent = this.findResolvedType(valueType(statement.parent, statement));
                    if (parent?.kind !== 'StructType') throw new StlResolutionError(`parent of struct '${name}' is not a struct`, statement);
                }
                add({ kind: 'StructType', parent: statement.parent ? valueType(statement.parent, statement) : null,
                    fields: statement.fields.map(field => ({ name: field.name, description: field.description, type: valueType(field.type, field) })) });
                break;
            case 'EnumDeclaration': {
                const storageType = valueType(statement.storageType, statement);
                if (!INTEGRAL_TYPES.has(storageType)) throw new StlResolutionError(`enum storage type '${storageType}' is not integral`, statement);
                add({ kind: 'EnumType', storageType, values: statement.values });
                break;
            }
            case 'VariantDeclaration': {
                const fields = statement.fields.map(field => ({ description: field.description, type: valueType(field.type, field) }));
                if (new Set(fields.map(field => field.type)).size !== fields.length) throw new StlResolutionError(`variant '${name}' contains the same type more than once`, statement);
                add({ kind: 'VariantType', fields });
                break;
            }
            case 'SequenceDeclaration':
            case 'ArrayDeclaration':
                add({ kind: 'SequenceType', elementType: valueType(statement.elementType, statement), maxSize: statement.maxSize, fixedSize: statement.fixedSize });
                break;
            case 'QuantityDeclaration': {
                const elementType = valueType(statement.elementType, statement);
                if (!NUMERIC_TYPES.has(elementType)) throw new StlResolutionError(`quantity element type '${elementType}' is not numeric`, statement);
                if (!DEFAULT_UNITS.has(statement.unit)) throw new StlResolutionError(`unknown SEN unit '${statement.unit}'`, statement);
                for (const attr of statement.attributes) {
                    if (!['min', 'max'].includes(attr.name) || typeof attr.value !== 'number') {
                        throw new StlResolutionError(`invalid quantity attribute '${attr.name}'`, statement);
                    }
                }
                const min = attribute(statement, 'min')?.value;
                const max = attribute(statement, 'max')?.value;
                add({ kind: 'QuantityType', elementType, unit: statement.unit, minValue: min ?? null, maxValue: max ?? null });
                break;
            }
            case 'AliasDeclaration': add({ kind: 'AliasType', target: valueType(statement.target, statement) }); break;
            case 'OptionalDeclaration': add({ kind: 'OptionalType', target: valueType(statement.target, statement) }); break;
            case 'ClassDeclaration': {
                const parent = statement.extendsType ? classType(statement.extendsType, statement) : null;
                const interfaces = statement.implementsTypes.map(item => classType(item, statement));
                if (interfaces.length) throw new StlResolutionError(`STL interfaces are not supported`, statement);
                add({ kind: 'ClassType', isAbstract: statement.isAbstract, parent, parents: [parent, ...interfaces].filter(Boolean),
                    properties: statement.properties.map(item => this.resolveProperty(item, file)),
                    methods: statement.methods.map(item => this.resolveMethod(item, file)),
                    events: statement.events.map(item => this.resolveEvent(item, file)) });
                break;
            }
            default: throw new StlResolutionError(`unsupported STL declaration '${statement.kind}'`, statement);
        }
    }

    resolveType(name, file, node, expectedKind) {
        if (name === 'void') return 'void';
        const primitive = builtInType(name);
        if (primitive) {
            if (expectedKind === 'class') throw new StlResolutionError(`'${name}' is not a class type`, node);
            return name;
        }
        let result;
        if (name.includes('.')) result = this.typeByName.get(name);
        else {
            result = file.types.get(name);
            if (!result) {
                for (const imported of file.imports) {
                    if (imported.packageName === file.packageName) result = imported.types.get(name);
                    if (result) break;
                    const common = file.packageName.split('.').filter((part, index) => imported.packageName.split('.')[index] === part).join('.');
                    if (common) result = this.typeByName.get(`${common}.${name}`);
                    if (result) break;
                }
            }
        }
        if (!result) throw new StlResolutionError(`type '${name}' not found`, node);
        if (expectedKind === 'class' && result.kind !== 'ClassType') throw new StlResolutionError(`'${name}' is not a class type`, node);
        if (expectedKind === 'value' && result.kind === 'ClassType') throw new StlResolutionError(`'${name}' is not a value type`, node);
        return result.qualifiedName;
    }

    findResolvedType(name) {
        return this.typeByName.get(name);
    }

    resolveProperty(item, file) {
        const transportMode = resolveTransport(item.attributes, 'multicast', item);
        const categories = ['static', 'static_no_config', 'writable'].filter(name => attribute(item, name));
        if (categories.length > 1) throw new StlResolutionError(`invalid property category attributes for '${item.name}'`, item);
        const category = categories[0] === 'static' ? 'staticRW' : categories[0] === 'static_no_config' ? 'staticRO' : categories[0] === 'writable' ? 'dynamicRW' : 'dynamicRO';
        for (const attr of item.attributes) {
            if (['confirmed', 'bestEffort', 'static', 'static_no_config', 'writable', 'checked', 'tag'].includes(attr.name)) continue;
            throw new StlResolutionError(`invalid property attribute '${attr.name}'`, item);
        }
        const type = this.resolveType(item.type, file, item, 'value');
        return Object.freeze({ name: item.name, description: item.description, type, category, transportMode,
            tags: item.attributes.filter(attr => attr.name === 'tag').map(attr => String(attr.value)), checkedSet: Boolean(attribute(item, 'checked')) });
    }

    resolveMethod(item, file) {
        for (const attr of item.attributes) {
            if (!['confirmed', 'bestEffort', 'const', 'deferred', 'local'].includes(attr.name) || attr.value !== true) throw new StlResolutionError(`invalid method attribute '${attr.name}'`, item);
        }
        return Object.freeze({ name: item.name, description: item.description, args: item.args.map(arg => ({ name: arg.name, description: arg.description, type: this.resolveType(arg.type, file, arg, 'value') })),
            returnType: this.resolveType(item.returnType, file, item, 'value'), transportMode: resolveTransport(item.attributes, 'confirmed', item),
            constness: attribute(item, 'const') ? 'constant' : 'nonConstant', deferred: Boolean(attribute(item, 'deferred')), localOnly: Boolean(attribute(item, 'local')) });
    }

    resolveEvent(item, file) {
        for (const attr of item.attributes) {
            if (!['confirmed', 'bestEffort'].includes(attr.name) || attr.value !== true) throw new StlResolutionError(`invalid event attribute '${attr.name}'`, item);
        }
        return Object.freeze({ name: item.name, description: item.description, args: item.args.map(arg => ({ name: arg.name, description: arg.description, type: this.resolveType(arg.type, file, arg, 'value') })),
            transportMode: resolveTransport(item.attributes, 'multicast', item) });
    }
}

/**
 * Resolves an STL source graph once. `sources` is a record or Map keyed by the
 * exact entry/import string; `load(name)` is an optional synchronous fallback.
 */
export function resolveStl(entry, options = {}) {
    if (!entry || (Array.isArray(entry) && !entry.length)) throw new TypeError('an STL entry file name is required');
    return new Resolver(options).resolve(entry);
}

