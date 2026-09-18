import { SenTypeCatalog } from './catalog.js';

export { SenTypeCatalog } from './catalog.js';

export const SenTypeCode = Object.freeze({
  enum: 0,
  quantity: 1,
  sequence: 2,
  struct: 3,
  variant: 4,
  alias: 5,
  optional: 6,
  class: 7
});

export const SenTypeKindByCode = Object.freeze(
  Object.fromEntries(Object.entries(SenTypeCode).map(([kind, code]) => [code, kind]))
);
export const SenTypeCodeByKind = SenTypeCode;

const codeBySpecName = Object.freeze({
  EnumTypeSpec: SenTypeCode.enum,
  EnumType: SenTypeCode.enum,
  QuantityTypeSpec: SenTypeCode.quantity,
  QuantityType: SenTypeCode.quantity,
  SequenceTypeSpec: SenTypeCode.sequence,
  SequenceType: SenTypeCode.sequence,
  StructTypeSpec: SenTypeCode.struct,
  StructType: SenTypeCode.struct,
  VariantTypeSpec: SenTypeCode.variant,
  VariantType: SenTypeCode.variant,
  AliasTypeSpec: SenTypeCode.alias,
  AliasType: SenTypeCode.alias,
  OptionalTypeSpec: SenTypeCode.optional,
  OptionalType: SenTypeCode.optional,
  ClassTypeSpec: SenTypeCode.class,
  ClassType: SenTypeCode.class
});

export function GetSenTypeCode(definition) {
  const kind = definition?.data?.type ?? definition?.kind;
  if (Number.isInteger(kind)) return kind;
  return typeof kind === 'string' ? (codeBySpecName[kind] ?? null) : null;
}

export function GetSenTypeKind(definition) {
  const code = GetSenTypeCode(definition);
  return code === null ? null : (SenTypeKindByCode[code] ?? null);
}

export function GetSenTypeValue(definition) {
  return definition?.data?.value ?? definition ?? {};
}

export function NormalizeSenTypeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/^::/, '')
    .replaceAll('::', '.')
    .toLowerCase();
}

export function GetSenTypeNameFromSpec(spec) {
  if (!spec || typeof spec !== 'object') return String(spec ?? '').trim();
  const direct = [
    spec.type,
    spec.retType,
    spec.ret_type,
    spec.returnType,
    spec.valueType,
    spec.elementType,
    spec.itemType
  ].find(value => typeof value === 'string' && value.trim());
  return String(direct ?? '').trim();
}

export class SenTypeResolver {
  /** @param {Map<string, any> | Record<string, any> | (() => Map<string, any> | Record<string, any>)} definitions */
  constructor(definitions) {
    this.typeDefinitions = typeof definitions === 'function' ? definitions : () => definitions;
  }

  resolveTypeDefinition(typeName, options = {}) {
    const target = NormalizeSenTypeName(typeName);
    if (!target) return null;
    const definitions = this.typeDefinitions();
    if (definitions instanceof SenTypeCatalog) {
      if (options.unique ?? false) {
        return definitions.findUnique(typeName, NormalizeSenTypeName)?.value ?? null;
      }
      return definitions.resolve(typeName, NormalizeSenTypeName);
    }

    const entries = definitions instanceof Map
      ? [...definitions.entries()]
      : Object.entries(definitions && typeof definitions === 'object' ? definitions : {});
    const keyMatch = entries.find(([key]) => NormalizeSenTypeName(key) === target);
    if (keyMatch) return keyMatch[1];
    const exact = entries.filter(([, value]) => [value?.name, value?.qualifiedName]
      .some(candidate => NormalizeSenTypeName(candidate) === target));
    const exactValues = [...new Set(exact.map(([, value]) => value))];
    if (exactValues.length === 1) return exactValues[0];
    if (exactValues.length > 1) return null;
    if (target.includes('.')) return null;
    const short = entries.filter(([key]) => NormalizeSenTypeName(key).split('.').pop() === target);
    return short.length === 1 ? short[0][1] : null;
  }

  /**
   * Resolve a member spec or type reference and follow every alias.
   * Unknown primitive and external references remain explicit `{ type }` specs.
   */
  resolveValueDefinition(spec) {
    let current = typeof spec === 'string' ? { type: spec } : spec;
    const seen = new Set();
    for (let depth = 0; current && depth < 64; depth += 1) {
      const code = GetSenTypeCode(current);
      const typeName = code === SenTypeCode.alias
        ? String(GetSenTypeValue(current).aliasedType ?? '').trim()
        : code === null
          ? GetSenTypeNameFromSpec(current)
          : '';
      if (!typeName) return current;
      const normalized = NormalizeSenTypeName(typeName);
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      const resolved = this.resolveTypeDefinition(typeName, { unique: true });
      if (!resolved) return code === SenTypeCode.alias ? { type: typeName } : current;
      current = resolved;
    }
    return null;
  }

  /** Resolve alias chains and reject cycles. */
  unwrapTypeDefinition(definition) {
    let current = definition;
    const seen = new Set();
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (GetSenTypeCode(current) !== SenTypeCode.alias) return current;
      const typeName = String(GetSenTypeValue(current).aliasedType ?? '').trim();
      const normalized = NormalizeSenTypeName(typeName);
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      current = this.resolveTypeDefinition(typeName, { unique: true }) ?? { type: typeName };
      if (GetSenTypeCode(current) === null) return current;
    }
    return null;
  }

  optionalValueDefinition(definition) {
    if (GetSenTypeCode(definition) !== SenTypeCode.optional) return null;
    const typeName = String(GetSenTypeValue(definition).type ?? '').trim();
    return typeName ? { typeName, definition: { type: typeName } } : null;
  }

  isArrayDefinition(definition) {
    return GetSenTypeCode(definition) === SenTypeCode.sequence;
  }

  arrayItemDefinition(definition) {
    if (!this.isArrayDefinition(definition)) return null;
    const typeName = String(GetSenTypeValue(definition).elementType ?? '').trim();
    return typeName
      ? (this.resolveTypeDefinition(typeName, { unique: true }) ?? { type: typeName })
      : null;
  }

  isQuantityDefinition(definition) {
    return GetSenTypeCode(definition) === SenTypeCode.quantity;
  }

  variantDefinition(definition) {
    if (GetSenTypeCode(definition) !== SenTypeCode.variant) return null;
    const fields = Array.isArray(GetSenTypeValue(definition).fields)
      ? GetSenTypeValue(definition).fields
      : [];
    const options = fields.map(field => {
      const value = GetSenTypeNameFromSpec(field);
      return value ? { label: value.split('.').pop() || value, value } : null;
    }).filter(Boolean);
    return options.length ? { options } : null;
  }

  typeFields(definition) {
    const code = GetSenTypeCode(definition);
    if (code !== SenTypeCode.struct && code !== SenTypeCode.class) return [];
    const value = GetSenTypeValue(definition);
    const fields = code === SenTypeCode.class ? value.properties : value.fields;
    return Array.isArray(fields) ? fields : [];
  }

  enumOptions(definition) {
    if (GetSenTypeCode(definition) !== SenTypeCode.enum) return null;
    const value = GetSenTypeValue(definition);
    const entries = Array.isArray(value.enums) ? value.enums : value.values;
    if (!Array.isArray(entries)) return null;
    return Object.fromEntries(entries.map((entry, index) => {
      if (entry && typeof entry === 'object') {
        return [String(entry.name ?? ''), entry.key ?? entry.value ?? index];
      }
      return [String(entry), index];
    }).filter(([name]) => name));
  }

  classLineage(typeName) {
    const visit = (name, seen) => {
      const definition = this.resolveTypeDefinition(name, { unique: true });
      const identity = NormalizeSenTypeName(definition?.qualifiedName ?? definition?.name ?? name);
      if (!definition || !identity || seen.has(identity)) return [];
      seen.add(identity);
      const value = GetSenTypeValue(definition);
      const parents = value.parents ?? (value.parent ? [value.parent] : []);
      return [
        ...parents.flatMap(parent => visit(parent, seen)),
        definition
      ];
    };
    return visit(typeName, new Set());
  }

  classMembers(typeName, member) {
    return this.classLineage(typeName).flatMap(definition => {
      const items = GetSenTypeValue(definition)?.[member];
      return Array.isArray(items) ? items : [];
    });
  }

  typeDefinitionKey(args) {
    return args.map(arg => GetSenTypeNameFromSpec(arg)).filter(Boolean).map(typeName => {
      const definition = this.resolveTypeDefinition(typeName, { unique: true });
      if (!definition) return `${typeName}:`;
      try {
        return `${typeName}:${JSON.stringify(definition)}`;
      } catch {
        return `${typeName}:${String(definition?.name ?? definition?.qualifiedName ?? 'object')}`;
      }
    }).join('|');
  }
}
