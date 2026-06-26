import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { EtherClient } from '../lib/client.js';
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
    assert.equal(event.discoveries[0].interestId, 77);
    assert.equal(event.discoveries[0].objects[0].name, 'node1');
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
