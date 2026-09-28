import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import { Sen } from '../index.js';
import { eventHash, methodHash, propertyHash } from '../lib/hash32.js';

const hub = process.env.SEN_TCP_HUB;
const enabled = process.env.SEN_INTEGRATION_PUBLISH === '1';

test('real Sen routes JavaScript publications, methods, writes, events and duplicate ObjectIds', {
  skip: hub && enabled
    ? false
    : 'set SEN_TCP_HUB and SEN_INTEGRATION_PUBLISH=1 with a writable Sen session running'
}, async () => {
  const session = process.env.SEN_SESSION ?? 'hmi';
  const busName = process.env.SEN_INTEGRATION_PUBLISH_BUS ?? 'js_integration';
  const secondaryBus = process.env.SEN_INTEGRATION_SECONDARY_BUS ?? 'js_integration_secondary';
  const connectOptions = {
    tcpHub: hub,
    session,
    timeout: Number(process.env.SEN_INTEGRATION_TIMEOUT_MS ?? 10_000),
    reconnect: false,
    busMulticast: false
  };
  const classSpec = {
    name: 'IntegrationCounter',
    qualifiedName: 'integration.IntegrationCounter',
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        parents: [],
        properties: [{
          id: propertyHash('value'), name: 'value', description: '',
          category: 'dynamicRW', type: 'i32', transportMode: 'confirmed',
          tags: [], checkedSet: false
        }],
        methods: [{
          id: methodHash('increment'), name: 'increment', description: '',
          args: [{ name: 'delta', type: 'i32' }], returnType: 'i32',
          transportMode: 'confirmed', localOnly: false
        }],
        events: [{
          id: eventHash('sampled'), name: 'sampled', description: '',
          args: [{ name: 'value', type: 'i32' }], transportMode: 'confirmed'
        }],
        constructor: { name: '', description: '', args: [], returnType: '' },
        isInterface: false
      }
    }
  };

  const producerA = await Sen.connect({ ...connectOptions, appName: 'integration-producer-a' });
  const producerB = await Sen.connect({ ...connectOptions, appName: 'integration-producer-b' });
  const consumer = await Sen.connect({ ...connectOptions, appName: 'integration-consumer' });
  try {
    const first = await producerA.publish(busName, {
      id: 1,
      name: 'counter-a',
      className: classSpec.qualifiedName,
      spec: classSpec,
      properties: { value: 1 },
      methods: {
        increment(delta) {
          const value = this.state.value + delta;
          this.update({ value });
          return value;
        }
      }
    });
    await producerB.publish(busName, {
      id: 1,
      name: 'counter-b',
      className: classSpec.qualifiedName,
      spec: classSpec,
      properties: { value: 10 }
    });
    await producerA.publish(secondaryBus, {
      id: 1,
      name: 'secondary-counter',
      className: classSpec.qualifiedName,
      spec: classSpec,
      properties: { value: 100 }
    });

    const [primary, secondary] = await Promise.all([
      consumer.interest(`SELECT * FROM ${session}.${busName}`),
      consumer.interest(`SELECT * FROM ${session}.${secondaryBus}`)
    ]);
    const [counterA, counterB, secondaryCounter] = await Promise.all([
      primary.waitFor('counter-a'),
      primary.waitFor('counter-b'),
      secondary.waitFor('secondary-counter')
    ]);
    assert.equal(counterA.id, counterB.id);
    assert.notEqual(counterA.ownerId, counterB.ownerId);
    assert.equal(Number(secondaryCounter.snapshot.value), 100);

    await counterA.set('value', 2);
    assert.equal(await counterA.call('increment', [3]), 5);
    const sampled = once(counterA, 'sampled');
    await first.emit('sampled', [5]);
    assert.deepEqual((await sampled)[0].args, [5]);
  } finally {
    await consumer.close();
    await producerB.close();
    await producerA.close();
  }
});
