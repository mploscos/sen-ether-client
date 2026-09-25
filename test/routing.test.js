import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { encodeBusControlMessage, encodeConfirmedBusFrame } from '../lib/bus.js';
import { EtherClient } from '../lib/client.js';
import { encodeProcessTcpFrame, PROCESS_MESSAGE_CATEGORY } from '../lib/codec.js';
import { crc32 } from '../lib/crc32.js';

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

async function waitFor(emitter, event, timeoutMs = 3000) {
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

function wait(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timeout waiting for condition');
    await wait(10);
  }
}

function options(sessionName, appName) {
  return {
    sessionName,
    appName,
    busMulticast: false,
    multicastDiscovery: false,
    announceDiscovery: false
  };
}

async function startClient(sessionName, appName, busName, participantId) {
  const client = new EtherClient(options(sessionName, appName));
  await client.start({ listenHost: '127.0.0.1', listenPort: 0 });
  await client.joinBus(busName, { participantId });
  return client;
}

test('routing targets the announcing participant and starts one interest per connection', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const session = `routing-${process.pid}-${Date.now()}`;
  const bus = 'environment';
  const consumer = await startClient(session, 'consumer', bus, 100);
  const producer = await startClient(session, 'producer', bus, 200);
  const unrelated = await startClient(session, 'unrelated', bus, 300);
  const query = `SELECT * FROM ${session}.${bus}`;
  const interestId = crc32(query);
  let producerInterests = 0;
  let unrelatedInterests = 0;
  let producerStateRequests = 0;
  let unrelatedStateRequests = 0;
  let producerTypeRequests = 0;
  let unrelatedTypeRequests = 0;
  let leakedStateResponses = 0;

  producer.on('busControlMessage', event => {
    if (event.control.type === 'InterestStarted') producerInterests += 1;
    if (event.control.type === 'ObjectsStateRequest') producerStateRequests += 1;
    if (event.control.type === 'TypesInfoRequest') producerTypeRequests += 1;
  });
  unrelated.on('busControlMessage', event => {
    if (event.control.type === 'InterestStarted') unrelatedInterests += 1;
    if (event.control.type === 'ObjectsStateRequest') unrelatedStateRequests += 1;
    if (event.control.type === 'TypesInfoRequest') unrelatedTypeRequests += 1;
  });
  unrelated.on('objectsStateResponse', () => { leakedStateResponses += 1; });

  try {
    consumer.startInterest(bus, query, { id: interestId });
    consumer.startInterest(bus, query, { id: interestId });
    producer.publishObjects(bus, {
      id: 1,
      name: 'aircraft',
      className: 'rpr.Aircraft',
      properties: { altitude: 1000 }
    });
    const publication = waitFor(consumer, 'objectsPublished');
    await producer.connect(consumer.listenEndpoint);
    const [published] = await publication;
    const object = published.discoveries[0].objects[0];
    await unrelated.connect(consumer.listenEndpoint);
    await wait(100);

    const typeResponse = waitFor(consumer, 'typesInfoResponse');
    consumer.requestTypes(bus, [object.typeHash], { ownerId: 200 });
    await typeResponse;
    const stateResponse = waitFor(consumer, 'objectsStateResponse');
    consumer.requestObjectStates(bus, [{ interestId, objectIds: [object.id] }], { ownerId: 200 });
    await stateResponse;
    await wait(100);

    assert.equal(producerInterests, 1);
    assert.equal(unrelatedInterests, 1);
    assert.equal(producerTypeRequests, 1);
    assert.equal(unrelatedTypeRequests, 0);
    assert.equal(producerStateRequests, 1);
    assert.equal(unrelatedStateRequests, 0);
    assert.equal(leakedStateResponses, 0);

    await producer.close();
    assert.throws(
      () => consumer.requestTypes(bus, [object.typeHash], { ownerId: 200 }),
      error => error.code === 'SEN_ROUTE_NOT_FOUND'
    );
  } finally {
    await Promise.allSettled([unrelated.close(), producer.close(), consumer.close()]);
  }
});

test('the same type hash can be requested concurrently from different owners', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const session = `same-type-${process.pid}-${Date.now()}`;
  const bus = 'environment';
  const consumer = await startClient(session, 'consumer', bus, 100);
  const producerA = await startClient(session, 'producer-a', bus, 200);
  const producerB = await startClient(session, 'producer-b', bus, 300);
  const publications = [];
  const responses = [];
  consumer.on('objectsPublished', event => publications.push(event));
  consumer.on('typesInfoResponse', event => responses.push(event));

  try {
    consumer.startInterest(bus, `SELECT * FROM ${session}.${bus}`);
    producerA.publishObjects(bus, { id: 1, name: 'one', className: 'shared.Track', properties: { value: 1 } });
    producerB.publishObjects(bus, { id: 2, name: 'two', className: 'shared.Track', properties: { value: 2 } });
    await producerA.connect(consumer.listenEndpoint);
    await producerB.connect(consumer.listenEndpoint);
    await waitUntil(() => publications.length === 2);
    const typeHash = publications[0].discoveries[0].objects[0].typeHash;

    consumer.requestTypes(bus, [typeHash], { ownerId: 200 });
    consumer.requestTypes(bus, [typeHash], { ownerId: 300 });
    await waitUntil(() => responses.length === 2);

    assert.deepEqual(new Set(responses.map(event => event.providerId)), new Set([200, 300]));
  } finally {
    await Promise.allSettled([producerB.close(), producerA.close(), consumer.close()]);
  }
});

test('a late state response is ignored after its interest stops', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const session = `late-${process.pid}-${Date.now()}`;
  const bus = 'environment';
  const busId = crc32(bus);
  const consumer = await startClient(session, 'consumer', bus, 100);
  const producer = await startClient(session, 'producer', bus, 200);
  const query = `SELECT * FROM ${session}.${bus}`;
  const interestId = crc32(query);
  let delivered = 0;
  const discarded = [];
  consumer.on('objectsStateResponse', () => { delivered += 1; });
  consumer.on('routingTrace', event => {
    if (event.discarded) discarded.push(event);
  });
  consumer.routingTraceEnabled = true;

  try {
    await producer.connect(consumer.listenEndpoint);
    await wait(50);
    consumer.startInterest(bus, query, { id: interestId });
    consumer.requestObjectStates(bus, [{ interestId, objectIds: [999] }], { ownerId: 200 });
    consumer.stopInterest(bus, interestId);

    const response = encodeBusControlMessage({
      type: 'ObjectsStateResponse',
      value: {
        ownerId: 100,
        responses: [{
          interestId,
          objectStates: [{ id: 999, timestamp: 1n, state: Buffer.alloc(0) }]
        }]
      }
    });
    const frame = encodeConfirmedBusFrame({ to: 200, busId, message: response });
    const connection = [...producer.connections.values()][0];
    connection.socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, frame));
    await wait(100);

    assert.equal(delivered, 0);
    assert.equal(discarded.some(event => event.reason === 'stale-or-unrequested-state'), true);
  } finally {
    await Promise.allSettled([producer.close(), consumer.close()]);
  }
});

test('a response from a replacement connection cannot satisfy an old request', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const session = `generation-${process.pid}-${Date.now()}`;
  const bus = 'environment';
  const busId = crc32(bus);
  const consumer = await startClient(session, 'consumer', bus, 100);
  const originalProducer = await startClient(session, 'producer-old', bus, 200);
  let replacementProducer;
  const interestId = crc32(`SELECT * FROM ${session}.${bus}`);
  let delivered = 0;
  const discarded = [];
  consumer.on('objectsStateResponse', () => { delivered += 1; });
  consumer.on('routingTrace', event => {
    if (event.discarded) discarded.push(event);
  });
  consumer.routingTraceEnabled = true;

  try {
    await originalProducer.connect(consumer.listenEndpoint);
    await wait(50);
    consumer.startInterest(bus, `SELECT * FROM ${session}.${bus}`, { id: interestId });
    consumer.requestObjectStates(bus, [{ interestId, objectIds: [999] }], { ownerId: 200 });
    const left = waitFor(consumer, 'busLeft');
    await originalProducer.close();
    await left;

    replacementProducer = await startClient(session, 'producer-new', bus, 200);
    await replacementProducer.connect(consumer.listenEndpoint);
    await wait(50);
    const response = encodeBusControlMessage({
      type: 'ObjectsStateResponse',
      value: {
        ownerId: 100,
        responses: [{
          interestId,
          objectStates: [{ id: 999, timestamp: 1n, state: Buffer.alloc(0) }]
        }]
      }
    });
    const frame = encodeConfirmedBusFrame({ to: 200, busId, message: response });
    const connection = [...replacementProducer.connections.values()][0];
    connection.socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, frame));
    await wait(100);

    assert.equal(delivered, 0);
    assert.equal(discarded.some(event => event.reason === 'stale-or-unrequested-state'), true);
  } finally {
    await Promise.allSettled([replacementProducer?.close(), originalProducer.close(), consumer.close()]);
  }
});

test('fifteen interests across buses are each sent once without listener warnings', async t => {
  if (!await canListenTcp()) {
    t.skip('TCP listen is not permitted in this test environment');
    return;
  }
  const session = `many-${process.pid}-${Date.now()}`;
  const consumer = new EtherClient(options(session, 'consumer'));
  const producer = new EtherClient(options(session, 'producer'));
  const counts = new Map();
  const warnings = [];
  producer.on('busControlMessage', event => {
    if (event.control.type !== 'InterestStarted') return;
    const key = `${event.busId}:${event.control.value.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const onWarning = warning => warnings.push(warning);
  process.on('warning', onWarning);

  try {
    await consumer.start({ listenHost: '127.0.0.1', listenPort: 0 });
    await producer.start({ listenHost: '127.0.0.1', listenPort: 0 });
    for (let index = 0; index < 15; index += 1) {
      const bus = `bus-${index}`;
      await consumer.joinBus(bus, { participantId: 1000 + index });
      await producer.joinBus(bus, { participantId: 2000 + index });
      consumer.startInterest(bus, `SELECT * FROM ${session}.${bus}`, { id: 3000 + index });
    }
    await producer.connect(consumer.listenEndpoint);
    await wait(200);

    assert.equal(counts.size, 15);
    assert.equal([...counts.values()].every(count => count === 1), true);
    assert.equal(warnings.some(warning => warning.name === 'MaxListenersExceededWarning'), false);
  } finally {
    process.off('warning', onWarning);
    await Promise.allSettled([producer.close(), consumer.close()]);
  }
});
