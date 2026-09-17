import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LiveDiscovery } from '../lib/live-discovery.js';
import { Sen } from '../index.js';
import { createServer } from 'node:net';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const beam = (name, appName = 'producer') => ({
  key: name, session: { name }, process: { appName }, lastSeen: Date.now(), beamPeriodMs: 50
});

test('root TCP connect is operational without beams and rejects unavailable hub', async () => {
  const sockets = new Set();
  const hub = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const tcpHub = `127.0.0.1:${hub.address().port}`;
  const sen = new Sen({ tcpHub, timeout: 500 });
  let connections = 0;
  sen.on('connect', () => { connections += 1; });
  try {
    await sen.connect();
    assert.equal(connections, 1);
    assert.deepEqual(sen.listSessions(), []);
  } finally {
    await sen.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => hub.close(resolve));
  }
  const unavailable = new Sen({ tcpHub, timeout: 500 });
  unavailable.on('connect', () => { connections += 1; });
  try {
    await assert.rejects(unavailable.connect(), /ECONNREFUSED|timeout/);
    assert.equal(connections, 1);
    assert.equal(unavailable.liveDiscovery.restartTimer, undefined);
  } finally {
    await unavailable.close();
  }
});

test('live discovery releases matching sessions immediately and cancels/cleans other waiters', async () => {
  const scanner = new EventEmitter();
  scanner.start = async () => {};
  scanner.stop = async () => {};
  const discovery = new LiveDiscovery({ app: 'producer' }, () => {}, () => {}, () => scanner);
  await discovery.start();
  const missing = assert.rejects(discovery.waitFor('missing', 20), /timeout discovering/);
  const first = discovery.waitFor('hmi', 1000);
  const second = discovery.waitFor('hmi', 1000);
  scanner.emit('beam', beam('hmi', 'other'));
  assert.equal(discovery.targets.size, 0);
  scanner.emit('beam', beam('hmi'));
  assert.equal(await first, await second);
  await missing;
  scanner.emit('beam', beam('missing'));
  assert.equal((await discovery.waitFor('missing', 20)).session.name, 'missing');
  const stale = beam('stale');
  stale.lastSeen -= 10000;
  scanner.emit('beam', stale);
  await assert.rejects(discovery.waitFor('stale', 20), /timeout discovering/);
  const closing = assert.rejects(discovery.waitFor('later', 1000), /closed/);
  await discovery.close();
  await closing;
  assert.equal(discovery.waiters.size, 0);
});

test('live discovery resumes after a TCP scanner closes', async () => {
  const scanners = [];
  const discovery = new LiveDiscovery({ reconnectDelayMs: 1 }, () => {}, () => {}, () => {
    const scanner = new EventEmitter();
    scanner.start = async () => {};
    scanner.stop = async () => {};
    scanners.push(scanner);
    return scanner;
  });
  await discovery.start();
  const waiting = discovery.waitFor('late', 1000);
  scanners[0].emit('close');
  await delay(10);
  scanners[1].emit('beam', beam('late'));
  assert.equal((await waiting).session.name, 'late');
  await discovery.close();
});

test('closing during scanner startup leaves no reconnect timer or open scanner', async () => {
  const scanner = new EventEmitter();
  let finishStart;
  let stops = 0;
  scanner.start = () => new Promise(resolve => { finishStart = resolve; });
  scanner.stop = async () => { stops += 1; };
  const discovery = new LiveDiscovery({ timeout: 1000 }, () => {}, () => {}, () => scanner);
  const starting = discovery.start();
  const rejected = assert.rejects(starting, /closed/);
  await discovery.close();
  finishStart();
  await rejected;
  assert.ok(stops >= 1);
  assert.equal(discovery.restartTimer, undefined);
  await assert.rejects(discovery.waitFor('hmi', 1000), /closed/);
});

test('progressive SEN interests start independently before all producers exist', async () => {
  const common = {
    port: 53000 + process.pid % 1000, interfaceAddress: '127.0.0.1',
    listenHost: '127.0.0.1', advertisedHost: '127.0.0.1',
    beamPeriodMs: 30, busMulticast: false, timeout: 2000,
    presenceTimeoutMs: 0, reconnect: false
  };
  const consumer = await Sen.connect(common);
  let a, b;
  try {
    assert.deepEqual(consumer.listSessions(), []);
    // Queue the absent session first: it must not delay the next one.
    let lateReady = false;
    const late = consumer.interest('SELECT * FROM late.data').then(value => { lateReady = true; return value; });
    const early = consumer.interest('SELECT * FROM early.data');
    const sameBus = consumer.interest('SELECT demo.Track FROM early.data');
    a = await Sen.connect({ ...common, session: 'early', localSession: true, announceDiscovery: true });
    await a.publish('data', { name: 'first', className: 'demo.Track', properties: { value: 1 } });
    const [first, duplicate] = await Promise.all([early, sameBus]);
    await first.waitFor('first', { timeout: 1000 });
    assert.equal(first.bus, duplicate.bus);
    assert.equal(lateReady, false);
    // The producer may appear after the transport operation timeout. Discovery
    // remains pending without an application retry.
    await delay(common.timeout + 50);
    assert.equal(lateReady, false);
    b = await Sen.connect({ ...common, session: 'late', localSession: true, announceDiscovery: true });
    await b.publish('data', { name: 'second', className: 'demo.Track', properties: { value: 2 } });
    await (await late).waitFor('second', { timeout: 1000 });
    const closing = assert.rejects(consumer.interest('SELECT * FROM absent.data'), /closed/);
    await consumer.close();
    await closing;
  } finally {
    await consumer.close();
    await a?.close();
    await b?.close();
  }
});

test('initial scanner failure rejects startup instead of reporting operational', async () => {
  const scanner = new EventEmitter();
  scanner.start = async () => { throw new Error('bind failed'); };
  let stopped = false;
  scanner.stop = async () => { stopped = true; };
  const discovery = new LiveDiscovery({}, () => {}, () => {}, () => scanner);
  await assert.rejects(discovery.start(), /bind failed/);
  assert.equal(stopped, true);
  assert.equal(discovery.restartTimer, undefined);
  await discovery.close();
});

test('startup timeout rejects and persistent session waits survive operation timeout', async () => {
  const scanner = new EventEmitter();
  scanner.start = () => new Promise(() => {});
  scanner.stop = async () => {};
  const discovery = new LiveDiscovery({ timeout: 10 }, () => {}, () => {}, () => scanner);
  await assert.rejects(discovery.start(), /connection timeout/);
  scanner.start = async () => {};
  await discovery.start();
  const waiting = discovery.waitFor('late', 0);
  await delay(30);
  scanner.emit('beam', beam('late'));
  assert.equal((await waiting).session.name, 'late');
  await discovery.close();
});
