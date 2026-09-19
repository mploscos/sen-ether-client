import {
  GetSenTypeCode,
  GetSenTypeNameFromSpec,
  GetSenTypeValue,
  NormalizeSenTypeName,
  SenTypeCode,
  SenTypeResolver
} from './resolver.js';

const INTEGER_TYPES = /^(?:[ui](?:8|16|32|64)|u?int(?:8|16|32|64)?|long|short|byte|word|dword|qword)$/i;
const REAL_TYPES = /^(?:f(?:32|64)|float|double|number)$/i;

const PRIMITIVE_ALIASES = Object.freeze({
  booleantype: 'bool', float32type: 'f32', float64type: 'f64',
  uint8type: 'u8', int16type: 'i16', uint16type: 'u16', int32type: 'i32',
  uint32type: 'u32', int64type: 'i64', uint64type: 'u64', stringtype: 'string',
  durationtype: 'duration', timestamptype: 'timestamp'
});

/** Return the protocol-visible unit together with a stable display label. */
export function NormalizeSenUnit(unit) {
  const source = unit && typeof unit === 'object' ? unit : { abbreviation: unit };
  const abbreviation = String(source?.abbreviation ?? source?.name ?? '').trim();
  return {
    name: String(source?.name ?? '').trim(),
    abbreviation,
    category: String(source?.category ?? '').trim(),
    label: FormatSenUnit(abbreviation)
  };
}

/** Format SEN unit abbreviations without changing their canonical identity. */
export function FormatSenUnit(value) {
  const source = String(value ?? '').trim();
  if (!source) return '';
  const exact = {
    deg: '°', degC: '°C', degF: '°F', Nm: 'N·m',
    kph: 'km/h', arcmin: '′', arcsec: '″'
  };
  if (exact[source]) return exact[source];
  const formatted = source
    .replaceAll('_per_', '/')
    .replace(/_sq\b/g, '²')
    .replace(/_cube\b/g, '³')
    .replace(/([A-Za-z])2\b/g, '$1²')
    .replace(/([A-Za-z])3\b/g, '$1³')
    .replace(/^deg(?=\/|$)/, '°')
    .replace(/^degC(?=\/|$)/, '°C')
    .replace(/^degF(?=\/|$)/, '°F');
  const prefix = '(?:da|f|p|n|u|m|c|d|h|k|M|G|T|P)?';
  return formatted
    .replace(new RegExp(`^(${prefix})(pa|nw|hz|k)(?=\\/|²|³|$)`), (_, unitPrefix, base) => {
      const symbols = { pa: 'Pa', nw: 'N', hz: 'Hz', k: 'K' };
      return `${unitPrefix === 'u' ? 'µ' : unitPrefix}${symbols[base]}`;
    })
    .replace(/^u(?=(?:m|s|rad|g)(?:\/|²|³|$))/, 'µ');
}

/** Classify primitive/numeric specs after aliases have been resolved. */
export function DescribeSenPrimitive(spec) {
  const value = GetSenTypeValue(spec);
  const inlinePrimitive = /^(?:IntegralType|RealType)$/i.test(String(spec?.type ?? ''))
    ? spec?.value
    : '';
  const raw = inlinePrimitive
    || GetSenTypeNameFromSpec(spec)
    || (typeof value?.value === 'string' ? value.value : '')
    || (typeof value === 'string' ? value : '');
  const name = String(raw).trim();
  const sourceName = NormalizeSenTypeName(name);
  const normalized = PRIMITIVE_ALIASES[sourceName] ?? sourceName;
  const integer = INTEGER_TYPES.test(normalized);
  const real = REAL_TYPES.test(normalized);
  return {
    name,
    normalized,
    integer,
    numeric: integer || real,
    boolean: /^(?:bool|boolean|booleantype)$/i.test(normalized),
    string: /^(?:string|stringtype)$/i.test(normalized),
    largeInteger: /^(?:[iu]64|int64type|uint64type|duration|timestamp)$/i.test(normalized),
    timestamp: /^(?:timestamp|timestamptype|time stamp)$/i.test(normalized)
  };
}

/** Resolve a QuantityTypeSpec into transport-neutral metadata. */
export function DescribeSenQuantity(spec, definitions) {
  const resolver = definitions instanceof SenTypeResolver ? definitions : new SenTypeResolver(definitions);
  const definition = ResolveSenPresentValueDefinition(spec, resolver);
  if (GetSenTypeCode(definition) !== SenTypeCode.quantity) return null;
  const value = GetSenTypeValue(definition);
  const elementType = value.elementType ?? null;
  const primitive = DescribeSenPrimitive(elementType);
  return {
    definition,
    elementType,
    unit: NormalizeSenUnit(value.unit),
    minValue: value.minValue ?? null,
    maxValue: value.maxValue ?? null,
    integer: primitive.integer
  };
}

/** Resolve aliases and transparent OptionalTypeSpec wrappers for a present value. */
export function ResolveSenPresentValueDefinition(spec, definitions) {
  const resolver = definitions instanceof SenTypeResolver ? definitions : new SenTypeResolver(definitions);
  let definition = resolver.resolveValueDefinition(spec);
  const seen = new Set();
  for (let depth = 0; definition && depth < 64; depth += 1) {
    if (GetSenTypeCode(definition) !== SenTypeCode.optional) return definition;
    const optional = resolver.optionalValueDefinition(definition);
    const identity = NormalizeSenTypeName(optional?.typeName);
    if (!optional || !identity || seen.has(identity)) return null;
    seen.add(identity);
    definition = resolver.resolveValueDefinition(optional.definition);
  }
  return null;
}

/** Resolve a nested value spec. Paths use string/number segments, not UI notation. */
export function ResolveSenValueSpec(spec, path, definitions) {
  const resolver = definitions instanceof SenTypeResolver ? definitions : new SenTypeResolver(definitions);
  let current = spec;
  for (const segment of path ?? []) {
    const resolved = ResolveSenPresentValueDefinition(current, resolver);
    if (!resolved) return null;
    if (typeof segment === 'number') {
      current = resolver.arrayItemDefinition(resolved);
      if (!current) return null;
      continue;
    }
    const field = resolver.typeFields(resolved).find(item => String(item?.name ?? '') === String(segment));
    if (!field) return null;
    current = field;
  }
  return current;
}

/**
 * Walk a SEN value according to its TypeSpec. The visitor receives canonical
 * path segments so every UI can choose its own path syntax.
 */
export function WalkSenValue(value, spec, definitions, visitor, path = [], depth = 0) {
  if (depth > 64) return;
  const resolver = definitions instanceof SenTypeResolver ? definitions : new SenTypeResolver(definitions);
  const definition = ResolveSenPresentValueDefinition(spec, resolver);
  visitor({ path, value, spec, definition, code: GetSenTypeCode(definition) });
  if (value == null || !definition) return;
  const code = GetSenTypeCode(definition);
  if (code === SenTypeCode.sequence && Array.isArray(value)) {
    const item = resolver.arrayItemDefinition(definition);
    if (item) value.forEach((entry, index) => WalkSenValue(entry, item, resolver, visitor, [...path, index], depth + 1));
    return;
  }
  if (code === SenTypeCode.variant && value && typeof value === 'object') {
    const fields = GetSenTypeValue(definition).fields ?? [];
    const selected = fields.find(field => NormalizeSenTypeName(field?.type) === NormalizeSenTypeName(value.type));
    if (selected && Object.hasOwn(value, 'value')) {
      WalkSenValue(value.value, selected, resolver, visitor, [...path, 'value'], depth + 1);
    }
    return;
  }
  if ((code === SenTypeCode.struct || code === SenTypeCode.class) && value && typeof value === 'object') {
    for (const field of resolver.typeFields(definition)) {
      const name = String(field?.name ?? '').trim();
      if (name && Object.hasOwn(value, name)) {
        WalkSenValue(value[name], field, resolver, visitor, [...path, name], depth + 1);
      }
    }
  }
}
