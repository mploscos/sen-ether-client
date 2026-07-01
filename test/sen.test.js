import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { Sen, SenInterest, SenRemoteObject } from '../index.js';
import { SenBus } from '../lib/sen.js';
import { createProcessInfo, validateRemoteHello } from '../lib/client.js';
import { SenBinaryWriter } from '../lib/codec.js';
import { eventHash, methodHash, propertyHash } from '../lib/hash32.js';
import { encodeArguments, encodeValue } from '../lib/values.js';

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

async function canListenTcp() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      return false;
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise(resolve => server.close(resolve));
    }
  }
}

async function waitForObjects(interest, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const objects = interest.objects();
    if (objects.length >= count && objects.every(object => Object.keys(object.snapshot).length)) {
      return objects;
    }
    await wait(25);
  }
  throw new Error(`timeout waiting for ${count} SEN objects; got ${interest.objects().length}`);
}

async function waitForObjectNames(interest, names, timeoutMs = 3000) {
  const expected = [...names].sort();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const objects = interest.objects();
    const actual = objects.map(object => object.name).sort();
    if (
      actual.length === expected.length
      && actual.every((name, index) => name === expected[index])
      && objects.every(object => Object.keys(object.snapshot).length)
    ) {
      return objects;
    }
    await wait(25);
  }
  throw new Error(`timeout waiting for SEN objects [${expected.join(', ')}]; got [${interest.objects().map(object => object.name).sort().join(', ')}]`);
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
  bus.objectsById = new Map([[object.id, object]]);
  interest.objectsById.set(object.id, object);

  return { bus, interest, object };
}

test('Sen is the public high-level client export', () => {
  assert.equal(typeof Sen.connect, 'function');
});

test('remote objects preserve all pending states received before type info', () => {
  const bus = new EventEmitter();
  bus.typeRegistry = new Map();
  bus.interests = new Map();
  bus.sen = new EventEmitter();

  const interest = new SenInterest(bus, 7, 'SELECT test.Track FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  const object = new SenRemoteObject(bus, {
    id: 42,
    name: 'track-42',
    className: 'test.Track',
    typeHash: 123,
    ownerId: 9,
    interestId: interest.id
  });
  bus.objectsById = new Map([[object.id, object]]);
  interest.objectsById.set(object.id, object);

  object.applyState(propertyUpdateBuffer([
    { name: 'entityType', type: 'u32', value: 5 },
    { name: 'latitude', type: 'f64', value: 40.1 }
  ]), 'state', 100n, { interestId: interest.id });
  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 40.2 }
  ]), 'update', 200n, { interestId: interest.id });

  object.spec = {
    data: {
      type: 'ClassTypeSpec',
      value: {
        properties: [
          { id: propertyHash('entityType'), name: 'entityType', type: 'u32', category: 'staticRO' },
          { id: propertyHash('latitude'), name: 'latitude', type: 'f64', category: 'dynamicRO' }
        ]
      }
    }
  };

  const pendingStates = object.pendingStates.splice(0);
  for (const state of pendingStates) {
    object.applyState(state.buffer, state.source, state.timestampNs, { interestId: state.interestId });
  }

  assert.equal(object.snapshot.entityType, 5);
  assert.equal(object.snapshot.latitude, 40.2);
});

test('remote object waitForType shares one listener for concurrent callers', async () => {
  const bus = new EventEmitter();
  bus.typeRegistry = new Map();
  bus.interests = new Map();
  bus.sen = new EventEmitter();

  const interest = new SenInterest(bus, 7, 'SELECT test.Track FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  const object = new SenRemoteObject(bus, {
    id: 42,
    name: 'track-42',
    className: 'test.Track',
    typeHash: 123,
    ownerId: 9,
    interestId: interest.id
  });

  const waiters = Array.from({ length: 20 }, () => object.waitForType({ timeout: 1000 }));
  assert.equal(object.listenerCount('type'), 1);

  const spec = {
    data: {
      type: 'ClassTypeSpec',
      value: { properties: [] }
    }
  };
  object.spec = spec;
  object.emit('type', spec);

  assert.deepEqual(await Promise.all(waiters), Array(20).fill(spec));
  assert.equal(object.listenerCount('type'), 0);
});

test('bus reconnect preparation removes visible objects once', () => {
  const sen = new EventEmitter();
  const bus = new SenBus(sen, 'hmi.loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  const object = new SenRemoteObject(bus, {
    id: 42,
    name: 'track-42',
    className: 'test.Track',
    typeHash: 123,
    ownerId: 9,
    interestId: interest.id
  });
  bus.objectsById.set(object.key, object);
  interest.objectsById.set(object.key, object);

  let interestRemoves = 0;
  let busRemoves = 0;
  let interestStale = 0;
  let objectStale = 0;
  interest.on('remove', removed => {
    interestRemoves += 1;
    assert.equal(removed, object);
  });
  bus.on('remove', removed => {
    busRemoves += 1;
    assert.equal(removed, object);
  });
  interest.on('stale', detail => {
    interestStale += 1;
    assert.equal(detail.reason, 'reconnect');
  });
  object.on('stale', detail => {
    objectStale += 1;
    assert.equal(detail.reason, 'reconnect');
  });

  bus.prepareReconnect();

  assert.equal(interest.objects().length, 0);
  assert.equal(bus.objects().length, 0);
  assert.equal(interestRemoves, 1);
  assert.equal(busRemoves, 1);
  assert.equal(interestStale, 1);
  assert.equal(objectStale, 1);

  bus.prepareReconnect();

  assert.equal(interestRemoves, 1);
  assert.equal(busRemoves, 1);
  assert.equal(interestStale, 1);
  assert.equal(objectStale, 1);
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

test('Sen includes joined buses when remote announcements are stale', async () => {
  const sen = new Sen();
  sen.target = { session: { name: 'hmi' } };
  sen.client = { processInfo: { sessionName: 'hmi' } };
  sen.buses.set('diagnostics', new SenBus(sen, 'diagnostics', 17));

  assert.deepEqual(sen.listBuses(), ['diagnostics']);
  assert.deepEqual(sen.listBuses({ qualified: true }), ['hmi.diagnostics']);
  assert.deepEqual(await sen.discoverBuses({ busDiscoverySettleMs: 0 }), [
    { session: 'hmi', bus: 'diagnostics', qualified: 'hmi.diagnostics' }
  ]);
});

test('Sen discovers buses across all discovered targets without interests', async () => {
  const originalConnect = Sen.prototype.connect;
  const originalClose = Sen.prototype.close;
  Sen.prototype.connect = async function connect(options = {}) {
    if (!options.target?.buses) {
      return await originalConnect.call(this, options);
    }
    this.target = options.target;
    this.client = { processInfo: { sessionName: options.session } };
    this.remoteBuses = new Set(options.target.buses);
    return this;
  };
  Sen.prototype.close = async function close() {
    this.client = undefined;
  };

  try {
    const sen = new Sen();
    sen.targets = [
      { session: { name: 'hmi' }, process: { appName: 'producer-a' }, buses: ['diagnostics'] },
      { session: { name: 'hmi' }, process: { appName: 'producer-b' }, buses: ['hud'] },
      { session: { name: 'world1' }, process: { appName: 'producer-c' }, buses: ['environment'] }
    ];

    assert.deepEqual(await sen.discoverBuses({ busDiscoverySettleMs: 0 }), [
      { session: 'hmi', bus: 'diagnostics', qualified: 'hmi.diagnostics' },
      { session: 'hmi', bus: 'hud', qualified: 'hmi.hud' },
      { session: 'world1', bus: 'environment', qualified: 'world1.environment' }
    ]);
  } finally {
    Sen.prototype.connect = originalConnect;
    Sen.prototype.close = originalClose;
  }
});

test('Sen discoverBuses waits for the initial bus announcement burst', async () => {
  const originalConnect = Sen.prototype.connect;
  const originalClose = Sen.prototype.close;
  Sen.prototype.connect = async function connect(options = {}) {
    if (!options.target?.buses) {
      return await originalConnect.call(this, options);
    }
    this.target = options.target;
    this.client = { processInfo: { sessionName: options.session } };
    this.remoteBuses = new Set(options.target.buses);
    setTimeout(() => {
      this.remoteBuses.add('hud');
      this.emit('busAvailable', { busName: 'hud' });
    }, 20).unref?.();
    return this;
  };
  Sen.prototype.close = async function close() {
    this.client = undefined;
  };

  try {
    const sen = new Sen();
    sen.targets = [
      { session: { name: 'hmi' }, process: { appName: 'producer' }, buses: ['diagnostics'] }
    ];

    assert.deepEqual(await sen.discoverBuses({ busDiscoverySettleMs: 80 }), [
      { session: 'hmi', bus: 'diagnostics', qualified: 'hmi.diagnostics' },
      { session: 'hmi', bus: 'hud', qualified: 'hmi.hud' }
    ]);
  } finally {
    Sen.prototype.connect = originalConnect;
    Sen.prototype.close = originalClose;
  }
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

test('same remote object can belong to multiple interests on one bus', async () => {
  const sen = new Sen({ timeout: 10 });
  const client = new EventEmitter();
  let nextInterestId = 10;
  const stateRequests = [];
  client.processInfo = { sessionName: 'hmi' };
  client.joinBus = name => {
    queueMicrotask(() => client.emit('busParticipantReady', { busName: name }));
    return { busId: 123 };
  };
  client.startInterest = (bus, query) => ({ id: nextInterestId++, busName: bus, query });
  client.requestTypes = () => {};
  client.requestObjectStates = (bus, requests) => {
    stateRequests.push({ bus, requests });
  };
  sen.target = { session: { name: 'hmi' } };
  sen.client = client;
  sen.remoteBuses.add('loadtest');

  const typed = await sen.interest('SELECT test.Track FROM hmi.loadtest');
  const star = await sen.interest('SELECT * FROM hmi.loadtest');
  const bus = typed.bus;
  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: typed.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = typed.get('track-42');
  object.spec = makeTypedObject().object.spec;
  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: star.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 2n }]
    }]
  });

  assert.equal(bus.objects().length, 1);
  assert.equal(star.get('track-42'), object);
  assert.deepEqual([...object.interestIds].sort((a, b) => a - b), [typed.id, star.id].sort((a, b) => a - b));
  assert.equal(stateRequests.at(-1).requests.some(request => request.interestId === star.id && request.objectIds.includes(42)), true);

  const typedChanges = [];
  const starChanges = [];
  typed.on('change', change => typedChanges.push(change));
  star.on('change', change => starChanges.push(change));
  object.applyState(propertyUpdateBuffer([
    { name: 'latitude', type: 'f64', value: 41.2 }
  ]), 'update', 3n);

  assert.deepEqual(typedChanges.map(change => change.name), ['latitude']);
  assert.deepEqual(starChanges.map(change => change.name), ['latitude']);
});

test('published object without initial state is emitted when its type is known', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  const spec = {
    qualifiedName: 'test.Track',
    data: {
      type: 'ClassTypeSpec',
      value: {
        properties: [
          { id: propertyHash('latitude'), name: 'latitude', type: 'f64', category: 'dynamicRO' }
        ]
      }
    }
  };
  const typeHash = 123;
  bus.handleTypesInfoResponse({
    types: [{
      type: 'ClassSpecResponse',
      classHash: typeHash,
      spec,
      dependentTypes: []
    }]
  });

  const emitted = [];
  interest.on('object', object => emitted.push(object));

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'track-42', className: spec.qualifiedName, typeHash, time: 1n }]
    }]
  });

  assert.deepEqual(emitted.map(object => object.name), ['track-42']);
  assert.equal(interest.get('track-42')?.isReadyForInterest(interest.id), true);
});

test('published objects from different owners can reuse object ids', () => {
  const sen = new EventEmitter();
  const typeRequests = [];
  const stateRequests = [];
  sen.client = {
    requestTypes: (bus, hashes) => typeRequests.push({ bus, hashes: [...hashes] }),
    requestObjectStates: (bus, requests) => stateRequests.push({ bus, requests })
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  const otherInterest = new SenInterest(bus, 8, 'SELECT test.Track FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);
  bus.interests.set(otherInterest.id, otherInterest);

  const removed = [];
  interest.on('remove', object => removed.push(object));

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });
  const first = interest.get('track-42');
  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: otherInterest.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });
  assert.equal(otherInterest.get('track-42'), first);

  bus.handleObjectsPublished({
    ownerId: 88,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'track-42-b', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 2n }]
    }]
  });
  const second = interest.get('track-42-b');

  assert.notEqual(second, first);
  assert.equal(first.ownerId, 77);
  assert.equal(second.ownerId, 88);
  assert.equal(bus.objects().length, 2);
  assert.deepEqual(interest.objects(), [first, second]);
  assert.deepEqual(otherInterest.objects(), [first]);
  assert.deepEqual(removed, []);

  first.spec = makeTypedObject().object.spec;
  second.spec = makeTypedObject().object.spec;
  bus.handleObjectsStateResponse({
    ownerId: 88,
    responses: [{
      interestId: interest.id,
      objectStates: [{
        id: 42,
        timestamp: 3n,
        state: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 88 }])
      }]
    }]
  });
  assert.equal(first.snapshot.latitude, undefined);
  assert.equal(second.snapshot.latitude, 88);

  bus.handleRuntimeObjectUpdate({
    to: 77,
    update: {
      objectId: 42,
      time: 4n,
      properties: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 77 }])
    }
  });
  assert.equal(first.snapshot.latitude, 77);
  assert.equal(second.snapshot.latitude, 88);
});

test('object state responses are ignored when owner id does not match', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = interest.get('track-42');
  object.spec = makeTypedObject().object.spec;
  bus.handleObjectsStateResponse({
    ownerId: 88,
    responses: [{
      interestId: interest.id,
      objectStates: [{
        id: 42,
        timestamp: 2n,
        state: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 99 }])
      }]
    }]
  });

  assert.equal(object.snapshot.latitude, undefined);

  bus.handleObjectsStateResponse({
    ownerId: 77,
    responses: [{
      interestId: interest.id,
      objectStates: [{
        id: 42,
        timestamp: 3n,
        state: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 41.2 }])
      }]
    }]
  });

  assert.equal(object.snapshot.latitude, 41.2);
});

test('runtime object updates fall back to object id when owner id is the local recipient', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = interest.get('track-42');
  object.spec = makeTypedObject().object.spec;

  bus.handleRuntimeObjectUpdate({
    ownerId: 12345,
    update: {
      objectId: object.id,
      time: 2n,
      properties: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 42.3 }])
    }
  });

  assert.equal(object.snapshot.latitude, 42.3);
});

test('runtime events are routed using the remote owner id', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'student-42', className: 'school.Student', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = interest.get('student-42');
  object.spec = {
    qualifiedName: 'school.Student',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [],
        methods: [],
        events: [{
          id: eventHash('saidSomething'),
          name: 'saidSomething',
          args: [{ name: 'words', type: 'string' }]
        }]
      }
    }
  };

  const objectEvents = [];
  const interestEvents = [];
  const busEvents = [];
  const senEvents = [];
  object.on('saidSomething', event => objectEvents.push(event));
  interest.on('event', event => interestEvents.push(event));
  bus.on('event', event => busEvents.push(event));
  sen.on('event', event => senEvents.push(event));

  bus.handleRuntimeEvents({
    ownerId: 77,
    to: 12345,
    events: [{
      producerId: 42,
      eventId: eventHash('saidSomething'),
      creationTime: 2n,
      argumentsBuffer: encodeArguments(['hello'], [{ name: 'words', type: 'string' }])
    }]
  });

  assert.equal(objectEvents.length, 1);
  assert.deepEqual(objectEvents[0].args, ['hello']);
  assert.equal(interestEvents[0], objectEvents[0]);
  assert.equal(busEvents[0], objectEvents[0]);
  assert.equal(senEvents[0], objectEvents[0]);
});

test('duplicate runtime events are emitted once', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'student-42', className: 'school.Student', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = interest.get('student-42');
  object.spec = {
    qualifiedName: 'school.Student',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [],
        methods: [],
        events: [{
          id: eventHash('saidSomething'),
          name: 'saidSomething',
          args: [{ name: 'words', type: 'string' }]
        }]
      }
    }
  };

  const objectEvents = [];
  object.on('saidSomething', event => objectEvents.push(event));

  const runtimeEvent = {
    ownerId: 77,
    events: [{
      producerId: 42,
      eventId: eventHash('saidSomething'),
      creationTime: 2n,
      argumentsBuffer: encodeArguments(['hello'], [{ name: 'words', type: 'string' }])
    }]
  };
  bus.handleRuntimeEvents(runtimeEvent);
  bus.handleRuntimeEvents(runtimeEvent);

  assert.equal(objectEvents.length, 1);
  assert.deepEqual(objectEvents[0].args, ['hello']);
});

test('runtime events fall back to producer id when owner id is the local recipient', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: interest.id,
      objects: [{ id: 42, name: 'student-42', className: 'school.Student', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });

  const object = interest.get('student-42');
  object.spec = {
    qualifiedName: 'school.Student',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [],
        methods: [],
        events: [{
          id: eventHash('saidSomething'),
          name: 'saidSomething',
          args: [{ name: 'words', type: 'string' }]
        }]
      }
    }
  };

  const objectEvents = [];
  object.on('saidSomething', event => objectEvents.push(event));

  bus.handleRuntimeEvents({
    ownerId: 12345,
    to: 12345,
    events: [{
      producerId: 42,
      eventId: eventHash('saidSomething'),
      creationTime: 2n,
      argumentsBuffer: encodeArguments(['hello'], [{ name: 'words', type: 'string' }])
    }]
  });

  assert.equal(objectEvents.length, 1);
  assert.deepEqual(objectEvents[0].args, ['hello']);
});

test('runtime event owner fallback is ignored when producer id is ambiguous', () => {
  const sen = new EventEmitter();
  sen.client = {
    requestTypes: () => {},
    requestObjectStates: () => {}
  };
  const bus = new SenBus(sen, 'loadtest', 123);
  const interest = new SenInterest(bus, 7, 'SELECT * FROM hmi.loadtest');
  bus.interests.set(interest.id, interest);

  for (const [ownerId, name] of [[77, 'student-42-a'], [88, 'student-42-b']]) {
    bus.handleObjectsPublished({
      ownerId,
      discoveries: [{
        interestId: interest.id,
        objects: [{ id: 42, name, className: 'school.Student', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
      }]
    });
  }

  let emitted = 0;
  for (const object of interest.objects()) {
    object.on('event', () => {
      emitted += 1;
    });
  }

  bus.handleRuntimeEvents({
    ownerId: 12345,
    events: [{
      producerId: 42,
      eventId: eventHash('saidSomething'),
      creationTime: 2n,
      argumentsBuffer: encodeArguments(['hello'], [{ name: 'words', type: 'string' }])
    }]
  });

  assert.equal(emitted, 0);
});

test('recreated interest requests object state again for existing object ids', async () => {
  const sen = new Sen({ timeout: 10 });
  const client = new EventEmitter();
  const stateRequests = [];
  const stopped = [];
  client.processInfo = { sessionName: 'hmi' };
  client.joinBus = name => {
    queueMicrotask(() => client.emit('busParticipantReady', { busName: name }));
    return { busId: 123 };
  };
  let nextInterestId = 7;
  client.startInterest = (bus, query) => ({ id: nextInterestId++, busName: bus, query });
  client.stopInterest = (bus, id) => stopped.push({ bus, id });
  client.requestTypes = () => {};
  client.requestObjectStates = (bus, requests) => {
    stateRequests.push({ bus, requests });
  };
  sen.target = { session: { name: 'hmi' } };
  sen.client = client;
  sen.remoteBuses.add('loadtest');

  const first = await sen.interest('SELECT * FROM hmi.loadtest');
  const bus = first.bus;
  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: first.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 1n }]
    }]
  });
  first.get('track-42').spec = makeTypedObject().object.spec;
  bus.handleTypesInfoResponse({ types: [] });

  assert.equal(stateRequests.length, 1);
  assert.equal(stateRequests[0].requests[0].interestId, 7);
  first.close();
  assert.deepEqual(stopped, [{ bus: 123, id: 7 }]);
  assert.equal(bus.objects().length, 0);
  assert.equal(bus.requestedTypeHashes.has(123), false);

  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: first.id,
      objects: [{ id: 42, name: 'stale-track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 2n }]
    }]
  });
  assert.equal(bus.objects().length, 0);

  const second = await sen.interest('SELECT * FROM hmi.loadtest');
  assert.equal(second.id, 8);
  bus.handleObjectsPublished({
    ownerId: 77,
    discoveries: [{
      interestId: second.id,
      objects: [{ id: 42, name: 'track-42', className: 'test.Track', typeHash: 123, state: Buffer.alloc(0), time: 2n }]
    }]
  });
  second.get('track-42').spec = makeTypedObject().object.spec;

  bus.handleObjectsStateResponse({
    ownerId: 77,
    responses: [{
      interestId: first.id,
      objectStates: [{
        id: 42,
        timestamp: 2n,
        state: propertyUpdateBuffer([{ name: 'latitude', type: 'f64', value: 99 }])
      }]
    }]
  });
  assert.equal(second.get('track-42').snapshot.latitude, undefined);

  bus.handleTypesInfoResponse({ types: [] });

  assert.equal(stateRequests.length, 2);
  assert.equal(stateRequests[1].requests[0].interestId, 8);
  assert.deepEqual(stateRequests[1].requests[0].objectIds, [42]);
});

test('Sen keeps multi-producer objects stable after interest recreation', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const session = `js-multi-${process.pid}-${Date.now()}`;
  const discoveryPort = 47000 + (process.pid % 1000);
  const options = {
    session,
    reconnect: false,
    timeout: 3000,
    busMulticast: false,
    listenHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
    interfaceAddress: '127.0.0.1',
    port: discoveryPort,
    beamPeriodMs: 100
  };
  const query = `SELECT * FROM ${session}.tracks`;
  const producerA = await Sen.connect({ ...options, appName: 'producer-a' });
  const producerB = await Sen.connect({ ...options, appName: 'producer-b' });
  const consumer = await Sen.connect({ ...options, appName: 'consumer' });

  const publish = async (producer, objects) => {
    await producer.publishObjects('tracks', objects.map(object => ({
      ...object,
      className: 'demo.Track'
    })));
  };
  const byName = objects => new Map(objects.map(object => [object.name, object]));
  const assertPositions = (objects, expected, duplicateObjectIdOneOwners) => {
    const map = byName(objects);
    assert.equal(objects.length, Object.keys(expected).length);
    for (const [name, x] of Object.entries(expected)) {
      assert.equal(Number(map.get(name)?.snapshot.x), x, `unexpected x for ${name}`);
    }
    if (duplicateObjectIdOneOwners !== undefined) {
      assert.equal(objects.filter(object => object.id === 1).length, duplicateObjectIdOneOwners);
      assert.equal(new Set(objects.filter(object => object.id === 1).map(object => object.ownerId)).size, duplicateObjectIdOneOwners);
    }
  };
  let producerC;

  try {
    await publish(producerA, [
      { id: 1, name: 'a-1', properties: { x: 10, y: 1 } },
      { id: 2, name: 'a-2', properties: { x: 20, y: 2 } },
      { id: 3, name: 'a-3', properties: { x: 30, y: 3 } }
    ]);
    await publish(producerB, [
      { id: 1, name: 'b-1', properties: { x: 100, y: 10 } }
    ]);

    await consumer.client.connect(producerA.client.listenEndpoint);
    await consumer.client.connect(producerB.client.listenEndpoint);
    await consumer.waitForRemoteBus('tracks', 3000);

    const first = await consumer.interest(query, { forceBus: true });
    assertPositions(await waitForObjects(first, 4), {
      'a-1': 10,
      'a-2': 20,
      'a-3': 30,
      'b-1': 100
    }, 2);
    first.close();

    const second = await consumer.interest(query, { forceBus: true });
    assert.equal(second.id, first.id);
    assertPositions(await waitForObjects(second, 4), {
      'a-1': 10,
      'a-2': 20,
      'a-3': 30,
      'b-1': 100
    }, 2);

    await producerA.close();
    assertPositions(await waitForObjectNames(second, ['b-1']), {
      'b-1': 100
    }, 1);

    producerC = await Sen.connect({ ...options, appName: 'producer-c' });
    await publish(producerC, [
      { id: 1, name: 'c-1', properties: { x: 1000, y: 100 } },
      { id: 4, name: 'c-4', properties: { x: 4000, y: 400 } }
    ]);
    await consumer.client.connect(producerC.client.listenEndpoint);
    assertPositions(await waitForObjectNames(second, ['b-1', 'c-1', 'c-4']), {
      'b-1': 100,
      'c-1': 1000,
      'c-4': 4000
    }, 2);

    await producerC.client.close();
    assertPositions(await waitForObjectNames(second, ['b-1']), {
      'b-1': 100
    }, 1);

    await publish(producerB, [
      { id: 1, name: 'b-1', properties: { x: 101, y: 10 } }
    ]);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const objects = second.objects();
      try {
        assertPositions(objects, {
          'b-1': 101
        }, 1);
        return;
      } catch {
        await wait(25);
      }
    }
    assertPositions(second.objects(), {
      'b-1': 101
    }, 1);
  } finally {
    await consumer.close().catch(() => {});
    await producerC?.close().catch(() => {});
    await producerA.close().catch(() => {});
    await producerB.close().catch(() => {});
  }
});

test('Sen JS published class specs announce dependent types', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const session = `js-dependent-types-${process.pid}-${Date.now()}`;
  const discoveryPort = 48000 + (process.pid % 1000);
  const options = {
    session,
    reconnect: false,
    timeout: 3000,
    busMulticast: false,
    listenHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
    interfaceAddress: '127.0.0.1',
    port: discoveryPort,
    beamPeriodMs: 100
  };

  const metadataSpec = {
    name: 'Metadata',
    qualifiedName: 'demo.Metadata',
    description: '',
    data: {
      type: 'StructTypeSpec',
      value: {
        fields: [
          { name: 'label', description: '', type: 'string' },
          { name: 'revision', description: '', type: 'u32' }
        ]
      }
    }
  };
  const namesSpec = {
    name: 'Names',
    qualifiedName: 'demo.Names',
    description: '',
    data: {
      type: 'SequenceTypeSpec',
      value: { elementType: 'string' }
    }
  };
  const baseSpec = {
    name: 'BaseDevice',
    qualifiedName: 'demo.BaseDevice',
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [
          { name: 'names', description: '', category: 'dynamicRO', type: 'demo.Names', transportMode: 'confirmed', tags: [], checkedSet: false }
        ],
        methods: [],
        events: [],
        constructor: { name: '', description: '', args: [], returnType: '' },
        isInterface: false
      }
    }
  };
  const deviceSpec = {
    name: 'Device',
    qualifiedName: 'demo.Device',
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: ['demo.BaseDevice'],
        properties: [
          { name: 'metadata', description: '', category: 'dynamicRO', type: 'demo.Metadata', transportMode: 'confirmed', tags: [], checkedSet: false }
        ],
        methods: [],
        events: [],
        constructor: { name: '', description: '', args: [], returnType: '' },
        isInterface: false
      }
    }
  };

  const producer = await Sen.connect({ ...options, appName: 'producer' });
  const consumer = await Sen.connect({ ...options, appName: 'consumer' });

  try {
    await producer.publishObjects('devices', {
      id: 1,
      name: 'device-with-dependent-types',
      className: 'demo.Device',
      spec: deviceSpec,
      properties: {
        names: ['primary', 'backup'],
        metadata: { label: 'example', revision: 2 }
      }
    }, {
      types: [metadataSpec, namesSpec, baseSpec]
    });

    await consumer.client.connect(producer.client.listenEndpoint);
    await consumer.waitForRemoteBus('devices', 3000);

    const interest = await consumer.interest(`SELECT * FROM ${session}.devices`, { forceBus: true });
    const [object] = await waitForObjectNames(interest, ['device-with-dependent-types']);

    assert.deepEqual(object.snapshot.names, ['primary', 'backup']);
    assert.deepEqual(object.snapshot.metadata, { label: 'example', revision: 2 });
  } finally {
    await consumer.close().catch(() => {});
    await producer.close().catch(() => {});
  }
});

test('Sen JS published objects can handle remote method calls and publish updates', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const session = `js-local-methods-${process.pid}-${Date.now()}`;
  const discoveryPort = 49000 + (process.pid % 1000);
  const options = {
    session,
    reconnect: false,
    timeout: 3000,
    busMulticast: false,
    listenHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
    interfaceAddress: '127.0.0.1',
    port: discoveryPort,
    beamPeriodMs: 100
  };
  const counterSpec = {
    name: 'Counter',
    qualifiedName: 'demo.Counter',
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [
          { id: propertyHash('count'), name: 'count', description: '', category: 'dynamicRO', type: 'i32', transportMode: 'confirmed', tags: [], checkedSet: false }
        ],
        methods: [
          { id: methodHash('increment'), name: 'increment', description: '', args: [{ name: 'delta', type: 'i32' }], returnType: 'i32', transportMode: 'confirmed', tags: [], localOnly: false }
        ],
        events: [],
        constructor: { name: '', description: '', args: [], returnType: '' },
        isInterface: false
      }
    }
  };
  const producer = await Sen.connect({ ...options, appName: 'producer' });
  const consumer = await Sen.connect({ ...options, appName: 'consumer' });

  try {
    await producer.publishObjects('devices', {
      id: 1,
      name: 'counter',
      className: 'demo.Counter',
      spec: counterSpec,
      properties: { count: 1 },
      methods: {
        increment(delta) {
          const count = this.state.count + delta;
          this.update({ count });
          return count;
        }
      }
    });

    await consumer.client.connect(producer.client.listenEndpoint);
    await consumer.waitForRemoteBus('devices', 3000);

    const interest = await consumer.interest(`SELECT * FROM ${session}.devices`, { forceBus: true });
    const [counter] = await waitForObjectNames(interest, ['counter']);

    assert.equal(counter.snapshot.count, 1);
    assert.equal(await counter.call('increment', [4]), 5);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && counter.snapshot.count !== 5) {
      await wait(25);
    }
    assert.equal(counter.snapshot.count, 5);
  } finally {
    await consumer.close().catch(() => {});
    await producer.close().catch(() => {});
  }
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
