import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { decodeBusMessage, decodeKernelControlMessage, decodePropertyUpdateBuffer } from '../lib/bus.js';
import { EtherClient } from '../lib/client.js';
import { decodeEtherControlMessage, SenBinaryReader } from '../lib/codec.js';
import { SenRemoteObject } from '../lib/sen.js';

const tcpAvailable = async () => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return false;
    throw error;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
};

async function waitForEvent(emitter, event, timeoutMs = 3000) {
  let timeout;
  try {
    return await Promise.race([
      once(emitter, event),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timeout waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('binary readers reject truncated and oversized strings and buffers', () => {
  const truncated = Buffer.alloc(6);
  truncated.writeUInt32LE(8, 0);
  assert.throws(() => new SenBinaryReader(truncated).readString(), /buffer underflow/);

  const oversizedString = Buffer.alloc(4);
  oversizedString.writeUInt32LE(33, 0);
  assert.throws(
    () => new SenBinaryReader(oversizedString, { maxStringBytes: 32 }).readString(),
    error => error.code === 'SEN_RESOURCE_LIMIT' && error.resource === 'string byte length'
  );

  const oversizedBuffer = Buffer.alloc(4);
  oversizedBuffer.writeUInt32LE(65, 0);
  assert.throws(
    () => new SenBinaryReader(oversizedBuffer, { maxBufferBytes: 64 }).readBuffer(),
    error => error.code === 'SEN_RESOURCE_LIMIT' && error.resource === 'buffer byte length'
  );
});

test('protocol decoders reject invalid sequence counters before iterating', () => {
  const objectsPublished = Buffer.alloc(12);
  objectsPublished.writeUInt32LE(3, 0); // ObjectsPublished variant.
  objectsPublished.writeUInt32LE(10, 4);
  objectsPublished.writeUInt32LE(1000, 8);

  assert.throws(
    () => decodeKernelControlMessage(objectsPublished, { maxSequenceLength: 10 }),
    error => error.code === 'SEN_RESOURCE_LIMIT'
  );
});

test('local interest and pre-type state queues enforce configured bounds', async () => {
  const client = new EtherClient({
    sessionName: 'limits',
    busMulticast: false,
    multicastDiscovery: false,
    resourceLimits: { maxInterestsPerBus: 1 }
  });
  try {
    // The capacity check itself needs no socket; mark the client as started so
    // joinBus can create its normal internal bus state deterministically.
    client.server = {};
    await client.joinBus('bounded');
    client.startInterest('bounded', 'SELECT * FROM limits.bounded', { id: 1 });
    assert.throws(
      () => client.startInterest('bounded', 'SELECT * FROM limits.bounded', { id: 2 }),
      error => error.code === 'SEN_RESOURCE_LIMIT'
    );
  } finally {
    client.server = undefined;
    await client.close();
  }

  const sen = new EventEmitter();
  sen.options = { resourceLimits: { maxPendingStatesPerObject: 2 } };
  const bus = new EventEmitter();
  bus.sen = sen;
  bus.interests = new Map();
  const object = new SenRemoteObject(bus, {
    id: 1,
    name: 'bounded-state',
    className: 'demo.Bounded',
    typeHash: 1,
    ownerId: 2,
    interestId: 3
  });
  const warnings = [];
  sen.on('warning', error => warnings.push(error));
  object.applyState(Buffer.from([1]), 'state', 1n);
  object.applyState(Buffer.from([2]), 'state', 2n);
  object.applyState(Buffer.from([3]), 'state', 3n);
  assert.equal(object.pendingStates.length, 2);
  assert.deepEqual(object.pendingStates.map(state => [...state.buffer]), [[2], [3]]);
  assert.equal(warnings[0]?.code, 'SEN_RESOURCE_LIMIT');
});

test('deterministic malformed buffers never escape as non-Error failures', () => {
  let seed = 0x5eed1234;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const decoders = [
    decodeEtherControlMessage,
    decodeKernelControlMessage,
    decodeBusMessage,
    decodePropertyUpdateBuffer
  ];

  for (let index = 0; index < 256; index += 1) {
    const buffer = Buffer.alloc(next() % 96);
    for (let offset = 0; offset < buffer.length; offset += 1) buffer[offset] = next() & 0xff;
    for (const decode of decoders) {
      try {
        decode(buffer, {
          maxFrameSize: 1024,
          maxReceiveBufferSize: 1029,
          maxStringBytes: 256,
          maxBufferBytes: 1024,
          maxSequenceLength: 64
        });
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }
  }
});

test('an oversized TCP frame closes only the responsible connection', async t => {
  if (!await tcpAvailable()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const limits = { maxFrameSize: 1024, maxReceiveBufferSize: 1029 };
  const server = new EtherClient({
    sessionName: 'limits',
    appName: 'server',
    busMulticast: false,
    multicastDiscovery: false,
    resourceLimits: limits
  });
  const peer = new EtherClient({
    sessionName: 'limits',
    appName: 'peer',
    busMulticast: false,
    multicastDiscovery: false,
    listen: false,
    resourceLimits: limits
  });
  const warnings = [];
  server.on('warning', error => warnings.push(error));
  server.on('error', () => {});
  peer.on('error', () => {});
  let attacker;
  try {
    await server.start({ listenHost: '127.0.0.1', listenPort: 0 });
    attacker = net.createConnection(server.listenEndpoint);
    attacker.on('error', () => {});
    await waitForEvent(attacker, 'connect');
    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0);
    header.writeUInt32LE(1025, 1);
    attacker.write(header);
    await waitUntil(() => warnings.some(error => error.resource === 'TCP frame payload byte length'));

    assert.equal(warnings.some(error => (
      error.code === 'SEN_RESOURCE_LIMIT'
      && error.resource === 'TCP frame payload byte length'
    )), true);

    const ready = waitForEvent(peer, 'ready');
    await peer.connect(server.listenEndpoint);
    await ready;
    assert.equal(peer.ready, true);
  } finally {
    attacker?.destroy();
    await peer.close();
    await server.close();
  }
});

test('a truncated TCP frame is reported when its connection closes', async t => {
  if (!await tcpAvailable()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const server = new EtherClient({
    sessionName: 'truncated',
    busMulticast: false,
    multicastDiscovery: false
  });
  const warnings = [];
  server.on('warning', error => warnings.push(error));
  server.on('error', () => {});
  let socket;
  try {
    await server.start({ listenHost: '127.0.0.1', listenPort: 0 });
    socket = net.createConnection(server.listenEndpoint);
    socket.on('error', () => {});
    await waitForEvent(socket, 'connect');
    socket.write(Buffer.from([1, 2, 3]));
    socket.destroy();
    await waitUntil(() => warnings.some(error => error.code === 'SEN_TRUNCATED_FRAME'));
    assert.equal(warnings.some(error => error.code === 'SEN_TRUNCATED_FRAME'), true);
  } finally {
    socket?.destroy();
    await server.close();
  }
});
