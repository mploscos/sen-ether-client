import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Sen, SenInterest, SenRemoteObject } from '../index.js';
import { createProcessInfo, validateRemoteHello } from '../lib/client.js';
import { SenBinaryWriter } from '../lib/codec.js';
import { propertyHash } from '../lib/hash32.js';
import { encodeValue } from '../lib/values.js';

function helloForSession(sessionName, version = { kernel: 9, ether: 2 }) {
  return {
    info: createProcessInfo({
      sessionName,
      appName: 'remote-sen',
      hostName: 'remote-host',
      processId: 1234
    }),
    udpPort: 42000,
    version
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function propertyUpdateBuffer(updates) {
  const writer = new SenBinaryWriter();
  for (const update of updates) {
    writer.writeUInt32(propertyHash(update.name));
    const value = encodeValue(update.value, update.type);
    writer.writeUInt32(value.length);
    writer.chunks.push(value);
  }
  return writer.toBuffer();
}

function makeTypedObject(options = {}) {
  const bus = new EventEmitter();
  bus.typeRegistry = new Map();
  bus.interests = new Map();
  bus.sen = new EventEmitter();

  const interest = new SenInterest(bus, 7, 'SELECT test.Track FROM hmi.loadtest', options);
  bus.interests.set(interest.id, interest);

  const object = new SenRemoteObject(bus, {
    id: 42,
    name: 'track-42',
    className: 'test.Track',
    typeHash: 123,
    ownerId: 9,
    interestId: interest.id
  });
  object.spec = {
    data: {
      type: 'ClassTypeSpec',
      value: {
        properties: [
          { id: propertyHash('latitude'), name: 'latitude', type: 'f64', category: 'dynamicRO' },
          { id: propertyHash('longitude'), name: 'longitude', type: 'f64', category: 'dynamicRO' },
          { id: propertyHash('altitude'), name: 'altitude', type: 'f64', category: 'dynamicRO' }
        ]
      }
    }
  };

  return { bus, interest, object };
}

test('Sen is the public high-level client export', () => {
  assert.equal(typeof Sen.connect, 'function');
});

test('single-session clients reject interests for another session', async () => {
  const sen = new Sen({ timeout: 1 });
  sen.target = { session: { name: 'hmi' } };
  sen.client = { processInfo: { sessionName: 'hmi' } };

  await assert.rejects(
    () => sen.interest('SELECT * FROM world1.environment'),
    /query targets SEN session "world1" but this client is connected to session "hmi"/
  );
});

test('explicit interest bus may contain dots inside the connected session', async () => {
  const sen = new Sen({ timeout: 10 });
  const client = new EventEmitter();
  client.processInfo = { sessionName: 'scenario' };
  client.joinBus = name => {
    assert.equal(name, 'world1.environment');
    queueMicrotask(() => client.emit('busParticipantReady', { busName: name }));
    return { busId: 123 };
  };
  client.startInterest = (bus, query) => {
    assert.equal(bus, 'world1.environment');
    assert.equal(query, 'SELECT * FROM world1.environment');
    return { id: 7 };
  };
  sen.target = { session: { name: 'scenario' } };
  sen.client = client;

  const interest = await sen.interest('SELECT * FROM world1.environment', {
    bus: 'world1.environment',
    forceBus: true
  });

  assert.equal(interest.id, 7);
  assert.equal(interest.bus.name, 'world1.environment');
});


test('Sen lists discovered sessions', () => {
  const sen = new Sen();
  sen.targetsBySession.set('world1', {});
  sen.targetsBySession.set('hmi', {});

  assert.deepEqual(sen.listSessions(), ['hmi', 'world1']);
});

test('Sen lists buses in single-session mode', () => {
  const sen = new Sen();
  sen.target = { session: { name: 'hmi' } };
  sen.client = { processInfo: { sessionName: 'hmi' } };
  sen.remoteBuses.add('diagnostics');
  sen.remoteBuses.add('hud');

  assert.deepEqual(sen.listBuses(), ['diagnostics', 'hud']);
  assert.deepEqual(sen.listBuses({ qualified: true }), ['hmi.diagnostics', 'hmi.hud']);
});

test('Sen bus is an alias for subscribe', async () => {
  const sen = new Sen();
  sen.subscribe = async (name, options) => ({ name, options });

  assert.deepEqual(await sen.bus('diagnostics', { forceBus: true }), {
    name: 'diagnostics',
    options: { forceBus: true }
  });
});

test('SenRemoteObject matches by id, name, class and predicate', () => {
  const object = new SenRemoteObject({}, {
    id: 42,
    name: 'blue-air-1',
    className: 'rpr.objects.Aircraft',
    typeHash: 123,
    ownerId: 7,
    interestId: 9
  });

  assert.equal(object.matches(42), true);
  assert.equal(object.matches('42'), true);
  assert.equal(object.matches('blue-air-1'), true);
  assert.equal(object.matches('rpr.objects.Aircraft'), true);
  assert.equal(object.matches(item => item.name.startsWith('blue-air')), true);
  assert.equal(object.matches(item => item.className === 'rpr.objects.GroundVehicle'), false);
});

test('remote SEN protocol versions are validated during handshake', () => {
  const processInfo = createProcessInfo({ sessionName: 'hmi', processId: 1 });
  const options = {
    kernelProtocolVersion: 9,
    etherProtocolVersion: 2
  };

  assert.doesNotThrow(() => {
    validateRemoteHello(helloForSession('hmi'), options, processInfo);
  });

  assert.throws(
    () => validateRemoteHello(helloForSession('hmi', { kernel: 10, ether: 2 }), options, processInfo),
    /remote SEN kernel protocol 10 is incompatible with 9/
  );

  assert.throws(
    () => validateRemoteHello(helloForSession('hmi', { kernel: 9, ether: 3 }), options, processInfo),
    /remote SEN ether protocol 3 is incompatible with 2/
  );
});

test('interest property filters skip unrelated property decoding and events', () => {
  const { interest, object } = makeTypedObject({ properties: ['latitude'] });
  const changes = [];
  interest.on('change', change => changes.push(change));

  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.2 },
    { name: 'longitude', type: 'f64', value: -3.7 }
  ]), 'update');

  assert.deepEqual(changes.map(change => change.name), ['latitude']);
  assert.equal(object.snapshot.latitude, 41.2);
  assert.equal(object.snapshot.longitude, undefined);
});

test('remote object changes expose SEN timestamps as nanosecond BigInts', () => {
  const { interest, object } = makeTypedObject();
  const changes = [];
  interest.on('change', change => changes.push(change));

  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.2 }
  ]), 'update', 12345n);

  assert.equal(object.timestamp, 12345n);
  assert.equal(object.timestampNs, 12345n);
  assert.equal(object.lastUpdateTimestamp, 12345n);
  assert.equal(object.lastUpdateTimestampNs, 12345n);
  assert.equal(object.getPropertyTimestamp('latitude'), 12345n);
  assert.equal(object.propertyTimestamps.get('latitude'), 12345n);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].timestamp, 12345n);
  assert.equal(changes[0].timestampNs, 12345n);
});

test('pending remote object state keeps its SEN timestamp until the type is known', () => {
  const { interest, object } = makeTypedObject();
  const spec = object.spec;
  const changes = [];
  interest.on('change', change => changes.push(change));
  object.spec = undefined;

  object.applyState(propertyUpdateBuffer([
    { name: 'altitude', type: 'f64', value: 3200 }
  ]), 'state', 98765n);

  assert.equal(object.timestampNs, 98765n);
  assert.equal(object.lastStateTimestampNs, 98765n);
  assert.equal(changes.length, 0);

  object.spec = spec;
  object.applyState(
    object.pendingState.buffer,
    object.pendingState.source,
    object.pendingState.timestampNs
  );

  assert.equal(object.snapshot.altitude, 3200);
  assert.equal(object.getPropertyTimestamp('altitude'), 98765n);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].timestampNs, 98765n);
});

test('remote objects decode inherited class properties', () => {
  const { bus, interest, object } = makeTypedObject();
  bus.typeRegistry.set('test.BaseTrack', {
    qualifiedName: 'test.BaseTrack',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [
          { id: propertyHash('inheritedLatitude'), name: 'inheritedLatitude', type: 'f64', category: 'dynamicRO' }
        ],
        methods: [],
        events: []
      }
    }
  });
  object.spec.data.value.parents = ['test.BaseTrack'];
  const changes = [];
  interest.on('change', change => changes.push(change));

  object.applyState(propertyUpdateBuffer([
    { name: 'inheritedLatitude', type: 'f64', value: 40.4 }
  ]), 'state');

  assert.equal(object.snapshot.inheritedLatitude, 40.4);
  assert.deepEqual(changes.map(change => change.name), ['inheritedLatitude']);
});


test('batched interests emit changes without individual change events', async () => {
  const { interest, object } = makeTypedObject({
    changeMode: 'batch',
    batchIntervalMs: 1,
    coalesce: true
  });
  const individual = [];
  const batches = [];
  interest.on('change', change => individual.push(change));
  interest.on('changes', batch => batches.push(batch));

  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.2 },
    { name: 'latitude', type: 'f64', value: 41.3 },
    { name: 'altitude', type: 'f64', value: 1000 }
  ]), 'update');
  await wait(5);

  assert.equal(individual.length, 0);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].changes.map(change => [change.name, change.value]), [
    ['latitude', 41.3],
    ['altitude', 1000]
  ]);
});

test('batched interests flush on close and keep options after local reset', async () => {
  const { interest, object } = makeTypedObject({
    properties: ['latitude'],
    changeMode: 'batch',
    batchIntervalMs: 1000,
    maxQueuedChanges: 10
  });
  const batches = [];
  interest.on('changes', batch => batches.push(batch));

  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.2 },
    { name: 'longitude', type: 'f64', value: -3.7 }
  ]), 'update');
  interest.closeLocal();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].changes.map(change => change.name), ['latitude']);

  interest.resetLocal();
  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.4 },
    { name: 'longitude', type: 'f64', value: -3.8 }
  ]), 'update');
  interest.closeLocal();

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1].changes.map(change => change.name), ['latitude']);
});
