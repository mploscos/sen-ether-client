import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decodeKernelControlMessage, encodeKernelControlMessage } from '../lib/bus.js';
import { EtherClient } from '../lib/client.js';
import { crc32 } from '../lib/crc32.js';
import { Sen } from '../index.js';
import { parseStl, resolveStl, StlResolutionError, StlSyntaxError, tokenizeStl } from '../lib/stl.js';

const COMPLEX_STL = `
package stl_resolver_test;

sequence<u8> ValidSequence;
sequence<u16, 20> ValidBoundedSequence;
array<i16, 50> ValidArray;

enum ValidEnumerationType : u32 { value1, value2, value3 }

struct ValidStructType { field1: u8, field2: ValidEnumerationType }
optional<ValidStructType> ValidOptional;
variant ValidVariantType { ValidSequence, ValidBoundedSequence, ValidArray, ValidEnumerationType, ValidStructType, ValidOptional }
quantity<f64, deg> ValidQuantity [min: -180.0, max: 180.0];
alias ValidTypeAlias ValidVariantType;

class ValidParentClass {
  var staticValue: string [static, confirmed];
  var writableValue: string [writable, confirmed];
  fn methodFromParent() [confirmed];
  event eventFromParent() [bestEffort];
}

abstract class ValidClass : extends ValidParentClass {
  var dynamicValue: ValidQuantity;
  fn methodWithArguments(lhs: i32, rhs: i32) -> i32 [const, bestEffort];
  event eventWithArguments(when: u32, where: string);
}
`;

test('tokenizer follows SEN comments, literals and qualified identifiers', () => {
  const tokens = tokenizeStl(`// description\npackage a.b;\nquantity<f64, deg> Angle [min: -180.0];`);
  assert.deepEqual(tokens.filter(token => token.type === 'identifier').map(token => token.lexeme), ['a', 'b', 'f64', 'deg', 'Angle', 'min']);
  assert.equal(tokens.find(token => token.type === 'comment').value, 'description');
  assert.equal(tokens.find(token => token.type === 'real').value, -180);
});

test('parser creates an isolated AST for the official complex resolver fixture grammar', () => {
  const ast = parseStl(COMPLEX_STL, { fileName: 'complex.stl' });
  assert.equal(ast.kind, 'Program');
  assert.equal(ast.statements.length, 12);
  assert.equal(ast.statements.find(item => item.kind === 'ClassDeclaration' && item.isAbstract).extendsType, 'ValidParentClass');
  assert.equal(ast.statements.find(item => item.kind === 'QuantityDeclaration').attributes[0].name, 'min');
});

test('parser accepts the unmodified official complex STL fixture, including inline comments', () => {
  const source = fs.readFileSync(new URL('./fixtures/official-complex.stl', import.meta.url), 'utf8');
  const ast = parseStl(source, { fileName: 'official-complex.stl' });
  const struct = ast.statements.find(item => item.kind === 'StructDeclaration');
  assert.equal(struct.fields[0].description, 'description of field1');
  assert.equal(ast.statements.find(item => item.kind === 'EnumDeclaration').values[0].description, 'description of value1');
});

test('resolver preserves all value types and class members as SEN TypeSpecs', () => {
  const registry = resolveStl('complex.stl', { sources: { 'complex.stl': COMPLEX_STL } });
  assert.equal([...registry.values()].length, 11);
  assert.equal(registry.get('stl_resolver_test.ValidStructType').kind, 'StructType');
  assert.equal(registry.get('stl_resolver_test.ValidClass').parent, 'stl_resolver_test.ValidParentClass');

  const officialFixture = resolveStl('official.stl', { sources: {
    'official.stl': fs.readFileSync(new URL('./fixtures/official-complex.stl', import.meta.url), 'utf8')
  } });
  assert.equal(officialFixture.get('stl_resolver_test.ValidSequence').description, 'inline comment for valid sequence');

  const types = registry.toTypeSpecs();
  assert.equal(types.get('stl_resolver_test.ValidSequence').data.type, 'SequenceTypeSpec');
  assert.deepEqual(types.get('stl_resolver_test.ValidArray').data.value, { elementType: 'i16', maxSize: 50, fixedSize: true });
  assert.equal(types.get('stl_resolver_test.ValidQuantity').data.value.unit.category, 'angle');
  assert.equal(types.get('stl_resolver_test.ValidClass').data.value.methods[0].transportMode, 'unicast');
  assert.equal(types.get('stl_resolver_test.ValidClass').data.value.properties[0].transportMode, 'multicast');
  assert.equal(types.get('stl_resolver_test.ValidClass').data.value.events[0].transportMode, 'multicast');
  assert.equal(types.get('stl_resolver_test.ValidClass').data.value.constructor.args[0].name, 'staticValue');
});

test('resolver resolves imports and qualified names exactly once', () => {
  const registry = resolveStl('second.stl', { sources: {
    'first.stl': 'package test.first; struct First { value: u32 }',
    'second.stl': 'import "first.stl"\npackage test.second; struct Second { first: test.first.First }'
  } });
  assert.equal(registry.get('test.second.Second').fields[0].type, 'test.first.First');
  assert.equal([...registry.files.keys()].length, 2);
});

test('resolver mirrors official rejection of interfaces and class value usage', () => {
  assert.throws(
    () => resolveStl('input.stl', { sources: { 'input.stl': 'package test; interface Unsupported {}' } }),
    StlResolutionError
  );
  assert.throws(
    () => resolveStl('input.stl', { sources: { 'input.stl': 'package test; class Object {} struct Invalid { object: Object }' } }),
    /not a value type/
  );
});

test('resolver rejects an unknown quantity unit like the official UnitRegistry', () => {
  assert.throws(
    () => resolveStl('input.stl', { sources: { 'input.stl': 'package test; quantity<f64, unknown> Broken;' } }),
    /unknown SEN unit/
  );
});

test('resolver rejects non-struct inheritance and unsupported implements clauses', () => {
  assert.throws(
    () => resolveStl('input.stl', { sources: { 'input.stl': 'package test; enum Kind: u8 { value } struct Invalid: Kind {}' } }),
    /not a struct/
  );
  assert.throws(
    () => resolveStl('input.stl', { sources: { 'input.stl': 'package test; class Parent {} class Invalid: implements Parent {}' } }),
    /interfaces are not supported/
  );
});

test('every adapted TypeSpec is accepted by the existing SEN binary codec', () => {
  const types = resolveStl('complex.stl', { sources: { 'complex.stl': COMPLEX_STL } }).toTypeSpecs();
  const response = {
    type: 'TypesInfoResponse',
    value: {
      ownerId: 1,
      types: [...types.values()].map(spec => ({
        type: spec.data.type === 'ClassTypeSpec' ? 'ClassSpecResponse' : 'NonClassSpecResponse',
        classHash: 0,
        spec,
        dependentTypes: []
      }))
    }
  };
  const decoded = decodeKernelControlMessage(encodeKernelControlMessage(response));
  assert.equal(decoded.value.types.length, types.size);
  assert.equal(decoded.value.types.find(item => item.spec.qualifiedName === 'stl_resolver_test.ValidClass').spec.data.type, 'ClassTypeSpec');
});

test('Sen.loadStl resolves a directory once, including relative imports', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sen-ether-client-stl-'));
  try {
    await mkdir(path.join(directory, 'common'));
    await writeFile(path.join(directory, 'common', 'point.stl'), 'package demo.common; struct Point { latitude: f64, longitude: f64 }');
    await writeFile(path.join(directory, 'track.stl'), 'import "common/point.stl"\npackage demo; class Track { var point: demo.common.Point; }');

    const registry = await Sen.loadStl(directory);
    assert.equal(registry.get('demo.Track').properties[0].type, 'demo.common.Point');
    assert.equal(registry.toTypeSpecs().get('demo.Track').data.type, 'ClassTypeSpec');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Sen.publishObjects forwards configured STL TypeSpecs for automatic class lookup', async () => {
  const types = resolveStl('types.stl', { sources: {
    'types.stl': 'package demo; struct Point { latitude: f64 } class Track { var point: Point; }'
  } });
  const sen = new Sen({ types });
  const calls = [];
  sen.client = {
    processInfo: { sessionName: 'demo' },
    publishObjects(...args) {
      calls.push(args);
      return [{ id: 1, name: 'track-1' }];
    }
  };
  sen.target = { session: { name: 'demo' } };
  sen.buses.set('tracks', {});

  const published = await sen.publishObject('tracks', { name: 'track-1', className: 'demo.Track', properties: { point: { latitude: 40 } } });
  assert.equal(published.id, 1);
  const registry = calls[0][2].types;
  assert.ok(registry instanceof Map);
  assert.equal(registry.get('demo.Track').data.type, 'ClassTypeSpec');
  assert.equal(registry.get('demo.Point').data.type, 'StructTypeSpec');
});

test('EtherClient selects the STL ClassTypeSpec when publishing without spec', () => {
  const types = resolveStl('types.stl', { sources: {
    'types.stl': 'package demo; struct Point { latitude: f64 } class Track { var point: Point; }'
  } }).toTypeSpecs();
  const client = new EtherClient({ sessionName: 'demo', busMulticast: false });
  client.buses.set(crc32('tracks'), {
    busName: 'tracks', busId: crc32('tracks'), participantId: 1, readyRemoteParticipants: new Set(),
    interests: new Map(), remoteInterests: new Map(), publishedObjects: new Map(),
    localTypeRegistry: new Map(), localTypeResponsesByHash: new Map()
  });

  const [published] = client.publishObjects('tracks', {
    name: 'track-1', className: 'demo.Track', properties: { point: { latitude: 40 } }
  }, { types });
  assert.equal(published.spec.qualifiedName, 'demo.Track');
  assert.equal(published.spec.data.value.properties[0].type, 'demo.Point');
});

test('syntax errors carry a source location', () => {
  assert.throws(() => parseStl('package test; struct Broken { value: }'), error => {
    assert.ok(error instanceof StlSyntaxError);
    assert.deepEqual(error.location, { line: 1, column: 38, offset: 37 });
    return true;
  });
});
