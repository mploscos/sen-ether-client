import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Sen } from '../lib/sen.js';
import { SenBus } from '../lib/sen-bus.js';
import { SenInterest } from '../lib/sen-interest.js';
import { SenRemoteObject } from '../lib/sen-remote-object.js';

function makeHarness(options = {}) {
  const calls = [];
  const client = {
    closed: false,
    leaveCount: 0,
    stopCount: 0,
    sendRuntimeMethodCall(busName, call) {
      calls.push({ busName, ...call });
    },
    stopInterest() {
      this.stopCount += 1;
    },
    leaveBus() {
      this.leaveCount += 1;
    }
  };
  const sen = new EventEmitter();
  sen.options = options;
  sen.client = client;

  const bus = new SenBus(sen, 'world', 17);
  const interest = new SenInterest(bus, 23, 'SELECT * FROM world');
  bus.interests.set(interest.id, interest);

  const object = new SenRemoteObject(bus, {
    id: 42,
    name: 'room',
    className: 'test.Room',
    typeHash: 123,
    ownerId: 9,
    interestId: interest.id
  });
  object.spec = {
    data: {
      type: 'ClassTypeSpec',
      value: {
        properties: [{
          id: 201,
          name: 'selected',
          type: 'bool',
          category: 'dynamicRW',
          transportMode: 'confirmed'
        }],
        methods: [{
          id: 101,
          name: 'join',
          args: [],
          returnType: 'void',
          transportMode: 'confirmed'
        }]
      }
    }
  };
  object.snapshot.selected = false;
  bus.objectsById.set(object.key, object);
  interest.objectsById.set(object.key, object);

  return { bus, calls, client, interest, object };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCallToStart() {
  await new Promise(resolve => setImmediate(resolve));
}

function respond(bus, ticketId, result = 'success', error = '') {
  bus.handleRuntimeMethodResponse({
    response: { ticketId, result, error }
  });
}

test('a method timeout affects only its pending call and later traffic remains operational', async () => {
  const { bus, calls, client, interest, object } = makeHarness();

  const unaffectedCall = object.call('join', [], { timeout: 0 });
  await waitForCallToStart();
  const rejection = assert.rejects(
    object.call('join', [], { timeout: 5 }),
    error => {
      assert.match(error.message, /timeout waiting for SEN method join response/);
      assert.equal(error.code, 'SEN_METHOD_TIMEOUT');
      assert.equal(error.method, 'join');
      assert.equal(error.timeout, 5);
      return true;
    }
  );
  await Promise.all([rejection, wait(15)]);

  assert.equal(bus.pendingCalls.size, 1);
  assert.equal(client.closed, false);
  assert.equal(client.leaveCount, 0);
  assert.equal(client.stopCount, 0);
  assert.equal(bus.interests.get(interest.id), interest);
  assert.equal(interest.objects().includes(object), true);
  assert.equal(bus.objects().includes(object), true);

  respond(bus, calls[1].ticketId);
  assert.equal(bus.pendingCalls.size, 1);
  respond(bus, calls[0].ticketId);
  await unaffectedCall;

  const laterCall = object.call('join', [], { timeout: 100 });
  await waitForCallToStart();
  assert.equal(bus.pendingCalls.size, 1);

  respond(bus, calls[2].ticketId);
  await laterCall;
  assert.equal(bus.pendingCalls.size, 0);
  assert.equal(client.closed, false);
});

test('a method response before the timeout resolves and removes its timer', async () => {
  const { bus, calls, object } = makeHarness();
  const call = object.call('join', [], { timeout: 100 });
  await waitForCallToStart();

  assert.equal(bus.pendingCalls.size, 1);
  assert.notEqual([...bus.pendingCalls.values()][0].timeout, undefined);
  respond(bus, calls[0].ticketId);

  assert.equal(await call, undefined);
  assert.equal(bus.pendingCalls.size, 0);
});

test('a SEN method error rejects normally and removes its timer', async () => {
  const { bus, calls, object } = makeHarness();
  const call = object.call('join', [], { timeout: 100 });
  await waitForCallToStart();
  respond(bus, calls[0].ticketId, 'rejected', 'join denied');

  await assert.rejects(call, error => {
    assert.equal(error.message, 'join denied');
    assert.equal(error.code, 'SEN_rejected');
    assert.notEqual(error.code, 'SEN_METHOD_TIMEOUT');
    return true;
  });
  assert.equal(bus.pendingCalls.size, 0);
});

test('method timeout precedence is per-call, methodTimeout, then 5000 ms', async () => {
  for (const scenario of [
    { global: 80, call: 120, expected: 120 },
    { global: 80, call: undefined, expected: 80 },
    { global: undefined, call: undefined, expected: 5000 }
  ]) {
    const { bus, calls, object } = makeHarness({ methodTimeout: scenario.global });
    const options = scenario.call === undefined ? {} : { timeout: scenario.call };
    const call = object.call('join', [], options);
    await waitForCallToStart();

    assert.equal([...bus.pendingCalls.values()][0].timeoutMs, scenario.expected);
    respond(bus, calls[0].ticketId);
    await call;
  }
});

test('timeout 0 creates no timer and permits a later response', async () => {
  const { bus, calls, object } = makeHarness({ methodTimeout: 1 });
  const call = object.call('join', [], { timeout: 0 });
  await waitForCallToStart();

  const pending = [...bus.pendingCalls.values()][0];
  assert.equal(pending.timeoutMs, 0);
  assert.equal(pending.timeout, undefined);
  await wait(15);
  assert.equal(bus.pendingCalls.size, 1);

  respond(bus, calls[0].ticketId);
  await call;
  assert.equal(bus.pendingCalls.size, 0);
});

test('a synchronous send failure keeps its connection error and removes the pending call', async () => {
  const { bus, client, object } = makeHarness();
  const connectionError = new Error('socket is not writable');
  connectionError.code = 'SEN_TCP_NOT_WRITABLE';
  client.sendRuntimeMethodCall = () => {
    throw connectionError;
  };

  await assert.rejects(
    object.call('join', [], { timeout: 100 }),
    error => error === connectionError && error.code === 'SEN_TCP_NOT_WRITABLE'
  );
  assert.equal(bus.pendingCalls.size, 0);
});

test('connection loss, reconnect preparation and bus close clear pending calls', async () => {
  for (const cleanup of ['connection', 'reconnect', 'bus']) {
    const { bus, object } = makeHarness();
    const call = object.call('join', [], { timeout: 10_000 });
    const rejection = assert.rejects(call, error => {
      assert.equal(error.code, {
        connection: 'SEN_CONNECTION_CLOSED',
        reconnect: 'SEN_CONNECTION_CLOSED',
        bus: 'SEN_BUS_CLOSED'
      }[cleanup]);
      return true;
    });
    await waitForCallToStart();

    if (cleanup === 'connection') {
      bus.handleParticipantLeft({ participantId: 9, reason: 'connectionClose' });
    } else if (cleanup === 'reconnect') {
      bus.prepareReconnect();
    } else {
      bus.close();
    }

    await rejection;
    assert.equal(bus.pendingCalls.size, 0);
  }
});

test('Sen.close clears method timers through bus close', async () => {
  const sen = new Sen();
  const { bus, object } = makeHarness();
  bus.sen = sen;
  sen.client = bus.sen.client = {
    sendRuntimeMethodCall() {},
    stopInterest() {},
    leaveBus() {},
    async close() {}
  };
  sen.buses.set(bus.name, bus);
  const call = object.call('join', [], { timeout: 10_000 });
  const rejection = assert.rejects(call, error => error.code === 'SEN_BUS_CLOSED');
  await waitForCallToStart();

  await sen.close();
  await rejection;
  assert.equal(bus.pendingCalls.size, 0);
});

test('set uses method timeout semantics and updates snapshot only after success', async () => {
  const { bus, calls, object } = makeHarness({ methodTimeout: 5 });
  const timedOut = assert.rejects(object.set('selected', true), error => {
    assert.equal(error.code, 'SEN_METHOD_TIMEOUT');
    assert.equal(error.method, 'setNextSelected');
    assert.equal(error.timeout, 5);
    return true;
  });
  await Promise.all([timedOut, wait(15)]);
  assert.equal(object.snapshot.selected, false);
  assert.equal(bus.pendingCalls.size, 0);

  const set = object.set('selected', true, { timeout: 100 });
  await waitForCallToStart();
  respond(bus, calls[1].ticketId);
  await set;
  assert.equal(object.snapshot.selected, true);
});

test('methodTimeout passed to connect is retained for static and instance APIs', async () => {
  const constructed = new Sen({ methodTimeout: 70 });
  assert.equal(constructed.options.methodTimeout, 70);

  const instance = new Sen();
  await instance.connect({ announceDiscovery: true, methodTimeout: 71 });
  assert.equal(instance.options.methodTimeout, 71);

  const connected = await Sen.connect({ announceDiscovery: true, methodTimeout: 72 });
  assert.equal(connected.options.methodTimeout, 72);

  await instance.close();
  await connected.close();
});
