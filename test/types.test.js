import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DescribeSenQuantity,
  FormatSenUnit,
  GetSenTypeKind,
  NormalizeSenUnit,
  ResolveSenPresentValueDefinition,
  ResolveSenValueSpec,
  SenTypeCatalog,
  SenTypeResolver,
  WalkSenValue
} from '../lib/types/index.js';

const spec = (type, value, extra = {}) => ({ ...extra, data: { type, value } });

test('normalizes numeric, TypeSpec and resolved STL kinds', () => {
  assert.equal(GetSenTypeKind(spec(3, {})), 'struct');
  assert.equal(GetSenTypeKind(spec('StructTypeSpec', {})), 'struct');
  assert.equal(GetSenTypeKind({ kind: 'StructType', fields: [] }), 'struct');
});

test('resolves qualified names and rejects ambiguous short names', () => {
  const first = spec('StructTypeSpec', {}, { name: 'Point', qualifiedName: 'a.Point' });
  const second = spec('StructTypeSpec', {}, { name: 'Point', qualifiedName: 'b.Point' });
  const catalog = new SenTypeCatalog([['a.Point', first], ['b.Point', second]]);
  const resolver = new SenTypeResolver(catalog);

  assert.equal(resolver.resolveTypeDefinition('a.Point'), first);
  assert.equal(resolver.resolveTypeDefinition('Point', { unique: true }), null);
});

test('accepts a unique short name and duplicate keys for the same definition', () => {
  const point = spec('StructTypeSpec', {}, { name: 'Point', qualifiedName: 'demo.Point' });
  const resolver = new SenTypeResolver({
    Point: point,
    'demo.Point': point
  });
  assert.equal(resolver.resolveTypeDefinition('Point', { unique: true }), point);

  const catalog = new SenTypeCatalog([['demo.Point', point]]);
  assert.equal(catalog.findUnique('Point', value => String(value ?? '').toLowerCase())?.value, point);
});

test('catalog revision tracks effective mutations but not constructor entries', () => {
  const value = { name: 'demo.Speed' };
  const catalog = new SenTypeCatalog([['demo.Speed', value]]);
  assert.equal(catalog.revision, 0);
  catalog.set('demo.Speed', value);
  assert.equal(catalog.revision, 1);
  assert.equal(catalog.delete('absent'), false);
  assert.equal(catalog.revision, 1);
  assert.equal(catalog.delete('demo.Speed'), true);
  assert.equal(catalog.revision, 2);
  catalog.clear();
  assert.equal(catalog.revision, 3);
});

test('unwraps alias chains and rejects cycles', () => {
  const target = spec('StructTypeSpec', { fields: [] }, { qualifiedName: 'demo.Target' });
  const catalog = new SenTypeCatalog([
    ['demo.A', spec('AliasTypeSpec', { aliasedType: 'demo.B' })],
    ['demo.B', spec('AliasTypeSpec', { aliasedType: 'demo.Target' })],
    ['demo.Target', target]
  ]);
  const resolver = new SenTypeResolver(catalog);
  assert.equal(resolver.unwrapTypeDefinition(catalog.get('demo.A')), target);
  assert.equal(resolver.resolveValueDefinition({ type: 'demo.A' }), target);

  catalog.set('demo.Target', spec('AliasTypeSpec', { aliasedType: 'demo.A' }));
  assert.equal(resolver.unwrapTypeDefinition(catalog.get('demo.A')), null);
});

test('returns inherited classes and members in parent-first order', () => {
  const inherited = { name: 'enabled', type: 'bool' };
  const own = { name: 'label', type: 'string' };
  const base = spec('ClassTypeSpec', { parents: [], properties: [inherited] }, {
    name: 'Base', qualifiedName: 'demo.Base'
  });
  const child = spec('ClassTypeSpec', { parents: ['demo.Base'], properties: [own] }, {
    name: 'Child', qualifiedName: 'demo.Child'
  });
  const resolver = new SenTypeResolver(new SenTypeCatalog([
    ['demo.Base', base],
    ['demo.Child', child]
  ]));
  assert.deepEqual(resolver.classLineage('demo.Child'), [base, child]);
  assert.deepEqual(resolver.classMembers('demo.Child', 'properties'), [inherited, own]);
});

test('describes quantities without losing canonical unit identity', () => {
  const quantity = spec('QuantityTypeSpec', {
    elementType: { type: 'IntegralType', value: 'int32Type' },
    unit: { name: 'meters_per_second', abbreviation: 'm_per_s', category: 'velocity' },
    minValue: 0,
    maxValue: 300
  });
  const descriptor = DescribeSenQuantity(quantity, new Map());
  assert.deepEqual(descriptor?.unit, {
    name: 'meters_per_second', abbreviation: 'm_per_s', category: 'velocity', label: 'm/s'
  });
  assert.deepEqual(NormalizeSenUnit({ name: 'megapascals', abbreviation: 'Mpa', category: 'pressure' }), {
    name: 'megapascals', abbreviation: 'Mpa', category: 'pressure', label: 'MPa'
  });
  assert.equal(descriptor?.integer, true);
  for (const [input, expected] of [
    ['us', 'µs'], ['um', 'µm'], ['hz', 'Hz'], ['khz', 'kHz'], ['Mhz', 'MHz'],
    ['pa', 'Pa'], ['kpa', 'kPa'], ['Mpa', 'MPa'], ['nw', 'N'], ['knw', 'kN'],
    ['m_per_s', 'm/s'], ['km_per_s', 'km/s'], ['m_per_s_sq', 'm/s²'],
    ['rad_per_s', 'rad/s'], ['deg_per_s', '°/s'], ['g_per_cm3', 'g/cm³'],
    ['kg_per_m3', 'kg/m³'], ['m_sq', 'm²'], ['km_sq', 'km²'], ['Nm', 'N·m'],
    ['degC', '°C'], ['degF', '°F'], ['kph', 'km/h'], ['custom', 'custom']
  ]) assert.equal(FormatSenUnit(input), expected);
});

test('resolves and walks nested sequence specs with path segments', () => {
  const speed = spec('QuantityTypeSpec', {
    elementType: { type: 'RealType', value: 'float64Type' },
    unit: { abbreviation: 'm_per_s' }
  });
  const catalog = new SenTypeCatalog([
    ['demo.Speed', speed],
    ['demo.Speeds', spec('SequenceTypeSpec', { elementType: 'demo.Speed' })],
    ['demo.State', spec('StructTypeSpec', { fields: [{ name: 'speeds', type: 'demo.Speeds' }] })]
  ]);
  const nested = ResolveSenValueSpec({ type: 'demo.State' }, ['speeds', 0], catalog);
  assert.equal(new SenTypeResolver(catalog).resolveValueDefinition(nested), speed);

  const paths = [];
  WalkSenValue({ speeds: [12.5] }, { type: 'demo.State' }, catalog, entry => paths.push(entry.path));
  assert.deepEqual(paths, [[], ['speeds'], ['speeds', 0]]);
});

test('resolves present optional values transparently', () => {
  const speed = spec('QuantityTypeSpec', {
    elementType: { type: 'RealType', value: 'float64Type' },
    unit: { abbreviation: 'm_per_s' }
  });
  const catalog = new SenTypeCatalog([
    ['demo.Speed', speed]
  ]);
  const optional = spec('OptionalTypeSpec', { type: 'demo.Speed' });

  assert.equal(ResolveSenPresentValueDefinition(optional, catalog), speed);
  assert.equal(DescribeSenQuantity(optional, catalog)?.unit.label, 'm/s');
  const paths = [];
  WalkSenValue(3.5, optional, catalog, entry => paths.push(entry.path));
  assert.deepEqual(paths, [[]]);
});

test('resolves inline quantities without enumerating an unrelated catalog', () => {
  const quantity = spec('QuantityTypeSpec', {
    elementType: { type: 'RealType', value: 'float64Type' }, unit: { abbreviation: 'm' }
  });
  const catalog = new Map();
  catalog[Symbol.iterator] = () => { throw Error('inline definition scanned the catalog'); };
  assert.equal(DescribeSenQuantity(quantity, catalog)?.unit.label, 'm');
});
