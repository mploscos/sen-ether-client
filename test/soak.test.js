import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';

import { Sen } from '../index.js';
import { propertyHash } from '../lib/hash32.js';

const durationMs = Number(process.env.SEN_SOAK_DURATION_MS ?? 5_000);

async function canListenTcp() {
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
}

function listenerCount(emitter) {
  return emitter.eventNames().reduce((total, name) => total + emitter.listenerCount(name), 0);
}

function pendingCount(sen) {
  let count = 0;
  for (const bus of sen.buses.values()) count += bus.pendingCalls.size;
  for (const bus of sen.client?.buses.values() ?? []) {
    count += bus.pendingStateRequests.size;
    count += bus.pendingTypeRequests.size;
    count += bus.pendingTransitCalls.size;
  }
  return count;
}

test('TCP stability workload bounds listeners, requests and memory', {
  timeout: durationMs + 20_000
}, async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }

  const session = `soak-${process.pid}-${Date.now()}`;
  const common = {
    session,
    multicastDiscovery: false,
    busMulticast: false,
    listenHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
    reconnect: true,
    reconnectDelayMs: 10,
    timeout: 3_000,
    presenceTimeoutMs: 0
  };
  const spec = {
    name: 'Counter',
    qualifiedName: 'soak.Counter',
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [{
          id: propertyHash('value'),
          name: 'value',
          description: '',
          category: 'dynamicRO',
          type: 'i32',
          transportMode: 'confirmed',
          tags: [],
          checkedSet: false
        }],
        methods: [],
        events: [],
        constructor: { name: '', description: '', args: [], returnType: '' },
        isInterface: false
      }
    }
  };

  let producer;
  let consumer;
  const interests = [];
  const handles = new Map();
  const warnings = [];
  let operations = 0;
  let reconnects = 0;
  const heapStart = process.memoryUsage().heapUsed;

  try {
    producer = await Sen.connect({ ...common, localSession: true, appName: 'soak-producer' });
    producer.on('warning', error => warnings.push(error));
    for (const busName of ['alpha', 'bravo', 'charlie']) {
      handles.set(busName, await producer.publish(busName, {
        id: 1,
        name: `${busName}-counter`,
        className: spec.qualifiedName,
        spec,
        properties: { value: 0 }
      }));
    }

    consumer = await Sen.connect({
      ...common,
      localSession: false,
      target: producer.client.listenEndpoint,
      appName: 'soak-consumer'
    });
    consumer.on('warning', error => warnings.push(error));
    for (const busName of handles.keys()) {
      await consumer.waitForRemoteBus(busName, 3_000);
      for (let index = 0; index < 4; index += 1) {
        const interest = await consumer.interest(`SELECT * FROM ${session}.${busName}`, {
          forceBus: true,
          id: propertyHash(`${busName}-${index}`)
        });
        interests.push(interest);
        await interest.waitFor(`${busName}-counter`);
      }
    }

    const baselineListeners = listenerCount(consumer) + interests.reduce((sum, value) => (
      sum + listenerCount(value)
    ), 0);
    const deadline = Date.now() + durationMs;
    let reconnected = false;
    while (Date.now() < deadline) {
      const busName = [...handles.keys()][operations % handles.size];
      await handles.get(busName).update({ value: operations });
      operations += 1;

      if (!reconnected && Date.now() >= deadline - durationMs / 2) {
        const reconnect = once(consumer, 'reconnect');
        const connection = consumer.client.connections.values().next().value;
        assert.ok(connection, 'expected an active producer connection');
        connection.socket.destroy(new Error('intentional soak reconnect'));
        await reconnect;
        reconnects += 1;
        reconnected = true;
      }

      if (operations % 20 === 0) {
        const old = handles.get(busName);
        await old.remove();
        handles.set(busName, await producer.publish(busName, {
          id: 1,
          name: `${busName}-counter`,
          className: spec.qualifiedName,
          spec,
          properties: { value: operations }
        }));
      }
      await new Promise(resolve => setImmediate(resolve));
    }

    const settleDeadline = Date.now() + 3_000;
    while (pendingCount(consumer) !== 0 && Date.now() < settleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const finalListeners = listenerCount(consumer) + interests.reduce((sum, value) => (
      sum + listenerCount(value)
    ), 0);
    const heapDelta = process.memoryUsage().heapUsed - heapStart;
    assert.equal(reconnects, 1);
    assert.equal(pendingCount(consumer), 0);
    assert.ok(finalListeners <= baselineListeners + 2, `${finalListeners} listeners exceeds baseline ${baselineListeners}`);
    assert.ok(heapDelta < 64 * 1024 * 1024, `heap grew by ${heapDelta} bytes`);
    assert.equal(warnings.some(error => error?.code === 'SEN_RESOURCE_LIMIT'), false);
    t.diagnostic(JSON.stringify({
      durationMs,
      operations,
      reconnects,
      listeners: finalListeners,
      pending: pendingCount(consumer),
      heapDeltaBytes: heapDelta
    }));
  } finally {
    await consumer?.close().catch(() => {});
    await producer?.close().catch(() => {});
  }
});
