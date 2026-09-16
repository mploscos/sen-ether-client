import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { compileInterestQuery } from '../lib/interest-query.js';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { decodeBusMessage } from '../lib/bus.js';
import { EtherClient, decodeMulticastBusDatagram } from '../lib/client.js';
import { SenBinaryWriter } from '../lib/codec.js';
import { crc32 } from '../lib/crc32.js';

async function waitFor(emitter, event, timeoutMs = 3000) {
  return await Promise.race([
    once(emitter, event),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs))
  ]);
}

async function createDiscoveryHub() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', chunk => {
      for (const other of sockets) {
        if (other !== socket && !other.destroyed) {
          other.write(chunk);
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    hub: `127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise(resolve => server.close(resolve));
    }
  };
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

async function runProbe(args, timeoutMs = 5000) {
  const child = spawn(process.execPath, ['./bin/node-sen-probe.js', ...args], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`probe did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

test('EtherClient uses SEN query hash as the default native interest id', () => {
  const client = new EtherClient({ sessionName: 'js', appName: 'consumer', busMulticast: false });
  const busName = 'tree';
  const busId = crc32(busName);
  const query = 'SELECT * FROM js.tree';
  client.buses.set(busId, {
    busName,
    busId,
    participantId: 123,
    interests: new Map(),
    remoteInterests: new Map()
  });

  const first = client.startInterest(busName, query);
  assert.equal(first.id, crc32(query));

  const simultaneous = client.startInterest(busName, query);
  assert.notEqual(simultaneous.id, first.id);
  client.stopInterest(busName, simultaneous.id);
  client.stopInterest(busName, first.id);

  const recreated = client.startInterest(busName, query);
  assert.equal(recreated.id, crc32(query));
});

test('EtherClient closes a discovered connection when presence expires', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const publisher = new EtherClient({
    sessionName: 'js-presence',
    appName: 'publisher',
    busMulticast: false,
    multicastDiscovery: false
  });
  const consumer = new EtherClient({
    sessionName: 'js-presence',
    appName: 'consumer',
    busMulticast: false,
    multicastDiscovery: false,
    presenceTimeoutMs: 100,
    presenceCheckIntervalMs: 50
  });

  try {
    publisher.on('warning', () => {});
    consumer.on('warning', () => {});
    await publisher.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await publisher.joinBus('tree');
    await consumer.start({ listenHost: '127.0.0.1', listenPort: 0 });

    const joined = waitFor(consumer, 'busJoined');
    await consumer.connect({ info: publisher.processInfo, endpoints: [publisher.listenEndpoint] });
    await joined;

    const connection = [...consumer.connections.values()]
      .find(item => item.remoteProcessInfo?.appName === 'publisher');
    assert.ok(connection);
    connection.discoveryLastSeen = Date.now() - 1000;

    const [left] = await waitFor(consumer, 'busLeft', 3000);
    assert.equal(left.busName, 'tree');
    assert.equal(left.reason, 'connectionClose');
  } finally {
    await publisher.close();
    await consumer.close();
  }
});

test('decodeMulticastBusDatagram reads native SEN bus multicast payloads', () => {
  const runtimeEvents = new SenBinaryWriter();
  runtimeEvents.writeUInt8(5);
  runtimeEvents.writeUInt32(1);
  runtimeEvents.writeUInt32(2);
  runtimeEvents.writeInt64(3n);
  runtimeEvents.writeUInt32(0);

  const payload = runtimeEvents.toBuffer();
  const datagram = Buffer.alloc(8 + payload.length);
  datagram.writeUInt32LE(1234, 0);
  datagram.writeUInt32LE(payload.length, 4);
  payload.copy(datagram, 8);

  const decoded = decodeMulticastBusDatagram(datagram);
  assert.equal(decoded.processId, 1234);
  assert.equal(decoded.payloadSize, payload.length);
  assert.deepEqual(decoded.message, payload);
  assert.equal(decodeBusMessage(decoded.message).categoryName, 'runtimeEvents');
});

test('EtherClient routes published objects between two JS participants', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const publisher = new EtherClient({ sessionName: 'js', appName: 'publisher', busMulticast: false });
  const consumer = new EtherClient({ sessionName: 'js', appName: 'consumer', busMulticast: false });
  try {
    await publisher.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await consumer.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await publisher.joinBus('tree');
    await consumer.joinBus('tree');

    await publisher.connect(consumer.listenEndpoint);
    await waitFor(publisher, 'ready');

    const received = waitFor(consumer, 'objectsPublished');
    consumer.startInterest('tree', 'SELECT * FROM js.tree', { id: 77 });
    await new Promise(resolve => setTimeout(resolve, 20));
    publisher.publishObjects('tree', {
      name: 'node1',
      className: 'demo.Counter',
      properties: { count: 1 }
    });

    const [event] = await received;
    const publisherBus = publisher.buses.get(crc32('tree'));
    assert.equal(event.ownerId, publisherBus.participantId);
    assert.equal(event.discoveries[0].interestId, 77);
    assert.equal(event.discoveries[0].objects[0].name, 'node1');
  } finally {
    await publisher.close();
    await consumer.close();
  }
});

test('EtherClient keeps owner and remote publisher objects unique across a star bus topology', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const options = { sessionName: 'js-star', busMulticast: false, multicastDiscovery: false };
  const owner = new EtherClient({ ...options, appName: 'owner' });
  const publisher = new EtherClient({ ...options, appName: 'publisher' });
  const consumer = new EtherClient({ ...options, appName: 'consumer' });
  try {
    await owner.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await publisher.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await consumer.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await owner.joinBus('interest', { participantId: 100 });
    await publisher.joinBus('interest', { participantId: 200 });
    await consumer.joinBus('interest', { participantId: 300 });
    owner.publishObjects('interest', {
      id: 10, name: 'simulator-interest-source', className: 'demo.Empty', properties: {}
    });
    publisher.publishObjects('interest', {
      id: 1, name: 'before-interest', className: 'demo.Empty', properties: {}
    });

    const publisherReady = waitFor(publisher, 'ready');
    const consumerReady = waitFor(consumer, 'ready');
    await publisher.connect(owner.listenEndpoint);
    await consumer.connect(owner.listenEndpoint);
    await Promise.all([publisherReady, consumerReady]);

    const remoteInterest = waitFor(publisher, 'remoteInterestStarted');
    const received = [];
    consumer.on('objectsPublished', event => {
      for (const discovery of event.discoveries) {
        for (const object of discovery.objects) {
          received.push({ ownerId: event.ownerId, interestId: discovery.interestId, ...object });
        }
      }
    });
    consumer.startInterest('interest', 'SELECT * FROM js-star.interest', { id: 77 });
    const [started] = await remoteInterest;
    assert.equal(started.participantId, 300);

    const initialDeadline = Date.now() + 3000;
    while (Date.now() < initialDeadline && new Set(received.map(object => object.name)).size < 2) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(received.map(object => object.name).sort(), [
      'before-interest',
      'simulator-interest-source'
    ]);
    assert.deepEqual(received.map(object => object.ownerId).sort(), [100, 200]);

    publisher.publishObjects('interest', {
      id: 2, name: 'after-interest', className: 'demo.Model', properties: { value: 2 }
    });
    const finalDeadline = Date.now() + 3000;
    while (Date.now() < finalDeadline && received.length < 3) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(received.map(object => `${object.ownerId}:${object.id}:${object.interestId}`).sort(), [
      '100:10:77',
      '200:1:77',
      '200:2:77'
    ]);
  } finally {
    await consumer.close();
    await publisher.close();
    await owner.close();
  }
});

test('EtherClient keeps existing interests active when joining a second bus', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const publisher = new EtherClient({ sessionName: 'js', appName: 'publisher', busMulticast: false });
  const consumer = new EtherClient({ sessionName: 'js', appName: 'consumer', busMulticast: false });
  const busNames = ['facpl.hmi', 'hmi.hud'];

  try {
    await publisher.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await consumer.start({ listenHost: '127.0.0.1', listenPort: 0 });
    for (const busName of busNames) {
      await publisher.joinBus(busName);
      await consumer.joinBus(busName);
    }
    await publisher.connect(consumer.listenEndpoint);
    await waitFor(publisher, 'ready');

    const received = new Map();
    const bothPublished = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for two bus publications')), 3000);
      consumer.on('objectsPublished', event => {
        received.set(event.bus.busName, event);
        if (received.size === busNames.length) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    consumer.startInterest('facpl.hmi', 'SELECT * FROM js.facpl.hmi', { id: 101 });
    consumer.startInterest('hmi.hud', 'SELECT * FROM js.hmi.hud', { id: 102 });
    await new Promise(resolve => setTimeout(resolve, 20));

    publisher.publishObjects('facpl.hmi', {
      name: 'Bandit_1',
      className: 'demo.Track',
      properties: { latitude: 39.16 }
    });
    publisher.publishObjects('hmi.hud', {
      name: 'AircraftInfo',
      className: 'demo.AircraftInfo',
      properties: { altitude: 9200 }
    });

    await bothPublished;
    assert.equal(consumer.buses.size, 2);
    assert.equal(received.get('facpl.hmi').discoveries[0].interestId, 101);
    assert.equal(received.get('hmi.hud').discoveries[0].interestId, 102);
  } finally {
    await publisher.close();
    await consumer.close();
  }
});

test('EtherClient discovers JS peers through a TCP discovery hub', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const discovery = await createDiscoveryHub();
  const publisher = new EtherClient({
    sessionName: 'js',
    appName: 'publisher',
    busMulticast: false,
    tcpHub: discovery.hub,
    beamPeriodMs: 100
  });
  const consumer = new EtherClient({
    sessionName: 'js',
    appName: 'consumer',
    busMulticast: false,
    tcpHub: discovery.hub,
    beamPeriodMs: 100
  });
  try {
    await publisher.start({ listenHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
    await consumer.start({ listenHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
    await publisher.joinBus('tree');
    await consumer.joinBus('tree');
    await waitFor(publisher, 'ready', 5000);

    const received = waitFor(consumer, 'objectsPublished', 5000);
    consumer.startInterest('tree', 'SELECT * FROM js.tree', { id: 88 });
    await new Promise(resolve => setTimeout(resolve, 150));
    publisher.publishObjects('tree', {
      name: 'node2',
      className: 'demo.Counter',
      properties: { count: 2 }
    });

    const [event] = await received;
    assert.equal(event.discoveries[0].interestId, 88);
    assert.equal(event.discoveries[0].objects[0].name, 'node2');
  } finally {
    await publisher.close();
    await consumer.close();
    await discovery.close();
  }
});

test('sen-ether-probe lists announced buses without selecting a default bus', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const discovery = await createDiscoveryHub();
  const publisher = new EtherClient({
    sessionName: 'probe-list',
    appName: 'publisher',
    busMulticast: false,
    tcpHub: discovery.hub,
    beamPeriodMs: 50
  });
  try {
    await publisher.start({ listenHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
    await publisher.joinBus('devices');

    const result = await runProbe([
      '--tcp-hub', discovery.hub,
      '--session', 'probe-list',
      '--timeout', '1000'
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[ether\] remote bus joined name=devices/);
    assert.match(result.stdout, /\[probe\] announced buses: devices/);
    assert.doesNotMatch(result.stdout + result.stderr, /scenario\.control/);
  } finally {
    await publisher.close();
    await discovery.close();
  }
});

test('EtherClient discovers JS peers through multicast discovery', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const port = 46000 + (process.pid % 1000);
  const publisher = new EtherClient({
    sessionName: 'js-mcast',
    appName: 'publisher',
    busMulticast: false,
    group: '239.255.0.44',
    port,
    interfaceAddress: '127.0.0.1',
    beamPeriodMs: 100
  });
  const consumer = new EtherClient({
    sessionName: 'js-mcast',
    appName: 'consumer',
    busMulticast: false,
    group: '239.255.0.44',
    port,
    interfaceAddress: '127.0.0.1',
    beamPeriodMs: 100
  });
  try {
    await publisher.start({ listenHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
    await consumer.start({ listenHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
    await publisher.joinBus('tree');
    await consumer.joinBus('tree');
    await waitFor(publisher, 'ready', 5000);

    const received = waitFor(consumer, 'objectsPublished', 5000);
    consumer.startInterest('tree', 'SELECT * FROM js-mcast.tree', { id: 99 });
    await new Promise(resolve => setTimeout(resolve, 150));
    publisher.publishObjects('tree', {
      name: 'node3',
      className: 'demo.Counter',
      properties: { count: 3 }
    });

    const [event] = await received;
    assert.equal(event.discoveries[0].interestId, 99);
    assert.equal(event.discoveries[0].objects[0].name, 'node3');
  } finally {
    await publisher.close();
    await consumer.close();
  }
});

test('published query predicates preserve classes, literals and expression precedence', () => {
  const base = { qualifiedName: 'demo.Base', data: { value: { parents: [] } } };
  const spec = { qualifiedName: 'demo.Track', data: { value: { parents: ['demo.Base'] } } };
  const types = new Map([[base.qualifiedName, base], [spec.qualifiedName, spec]]);
  const object = { spec, name: 'A  B', id: 42, state: { id: 'A  B', altitude: 12.5, position: { x: -2 } } };
  for (const query of [
    'SELECT demo.Track FROM js-test.tree WHERE name == "A  B"',
    "SELECT demo.Base FROM js.tree WHERE name = 'A  B' AND altitude > 12",
    'SELECT * FROM js.tree WHERE (altitude + 2.5) / 3 = 5 AND position.x IN (-2, 3)',
    'SELECT * FROM js.tree WHERE NOT altitude < 10',
    'SELECT * FROM js.tree WHERE id = "A  B"'
  ]) assert.equal(compileInterestQuery(query)(object, types), true, query);
  for (const query of [
    'SELECT demo.Other FROM js.tree',
    'SELECT * FROM js.tree WHERE id = 42',
    'SELECT demo.Track FROM js.tree WHERE id = "other"',
    'SELECT * FROM js.tree WHERE missing != 1',
    'SELECT * FROM js.tree WHERE altitude < 5 OR position.x > 0'
  ]) assert.equal(compileInterestQuery(query)(object, types), false, query);
  for (const where of ['id =', 'id === "x"', 'process.exit()', 'id LIKE "x"', 'id = "x"; garbage']) {
    assert.throws(() => compileInterestQuery(`SELECT * FROM js.tree WHERE ${where}`), SyntaxError);
  }
});

test('JavaScript publisher filters each interest and updates membership when WHERE changes', async t => {
  if (!await canListenTcp()) { t.skip('TCP listen is not permitted'); return; }
  const publisher = new EtherClient({ sessionName: 'js', appName: 'publisher', busMulticast: false, multicastDiscovery: false });
  const consumer = new EtherClient({ sessionName: 'js', appName: 'consumer', busMulticast: false, multicastDiscovery: false });
  const memberships = new Map();
  const seen = [];
  consumer.on('objectsPublished', event => {
    for (const discovery of event.discoveries) {
      const ids = memberships.get(discovery.interestId) ?? new Set();
      for (const object of discovery.objects) { ids.add(object.name); seen.push([discovery.interestId, object.name]); }
      memberships.set(discovery.interestId, ids);
    }
  });
  const removed = [];
  consumer.on('objectsRemoved', event => removed.push(...event.removals));
  async function until(predicate) {
    const end = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Timed out waiting for interest membership');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    await publisher.start({listenHost:'127.0.0.1', listenPort:0});
    await consumer.start({listenHost:'127.0.0.1', listenPort:0});
    await publisher.joinBus('tree'); await consumer.joinBus('tree');
    await publisher.connect(consumer.listenEndpoint); await waitFor(publisher, 'ready');
    publisher.publishObjects('tree', [
      {name:'AircraftInfo', className:'demo.AircraftInfo', properties:{id:'AircraftInfo', altitude:20}},
      {name:'InstrumentData', className:'demo.InstrumentData', properties:{id:'InstrumentData', altitude:10}}
    ]);
    const queries = [
      'SELECT * FROM js.tree',
      'SELECT demo.InstrumentData FROM js.tree',
      'SELECT demo.InstrumentData FROM js.tree WHERE name == "InstrumentData" AND altitude > 15',
      'SELECT * FROM js.tree WHERE name = "AircraftInfo"',
      'SELECT * FROM js.tree WHERE id = "AircraftInfo"'
    ];
    for (let i = 0; i < queries.length; i++) consumer.startInterest('tree', queries[i], {id:101+i});
    await until(() => memberships.has(105));
    assert.deepEqual([...memberships.get(101)].sort(), ['AircraftInfo','InstrumentData']);
    assert.deepEqual([...memberships.get(102)], ['InstrumentData']);
    assert.equal(memberships.has(103), false);
    assert.deepEqual([...memberships.get(104)], ['AircraftInfo']);
    assert.deepEqual([...memberships.get(105)], ['AircraftInfo']);
    publisher.updatePublishedObject('tree', 'InstrumentData', {altitude:20});
    await until(() => memberships.has(103));
    assert.deepEqual([...memberships.get(103)], ['InstrumentData']);
    publisher.updatePublishedObject('tree', 'InstrumentData', {altitude:5});
    await until(() => removed.some(item => item.interestId === 103));
    assert.equal(removed.length, 1);
    publisher.updatePublishedObject('tree', 'InstrumentData', {altitude:30});
    await until(() => seen.filter(([id]) => id === 103).length === 2);
    assert.equal(seen.some(([id, name]) => id === 102 && name !== 'InstrumentData'), false);
    publisher.publishObjects('tree', {name:'Late', className:'demo.InstrumentData', properties:{id:'Late', altitude:30}});
    await until(() => memberships.get(102)?.has('Late'));
    assert.equal(memberships.get(103).has('Late'), false);
    const beforeRemoval = removed.length;
    publisher.removePublishedObjects('tree', ['Late']);
    await until(() => removed.length >= beforeRemoval + 2);
    assert.deepEqual(removed.slice(beforeRemoval).map(item => item.interestId).sort(), [101, 102]);
    consumer.stopInterest('tree', 103);
  } finally { await publisher.close(); await consumer.close(); }
});
