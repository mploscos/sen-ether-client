import assert from 'node:assert/strict';
import test from 'node:test';
import { Sen } from '../index.js';

const hub = process.env.SEN_TCP_HUB;
const multicast = process.env.SEN_DISCOVERY === 'multicast';

test('hmi_sen_sim diagnostics covers interest, set, methods and events', {
  skip: hub || multicast
    ? false
    : 'set SEN_TCP_HUB=127.0.0.1 or SEN_DISCOVERY=multicast with hmi_sen_sim diagnostics running'
}, async () => {
  const sen = new Sen({ timeout: 5000, reconnect: false });
  const connectOptions = {
    session: process.env.SEN_SESSION ?? 'hmi'
  };
  if (hub) {
    connectOptions.tcpHub = hub;
  }
  if (process.env.NODE_SEN_INTERFACE) {
    connectOptions.interfaceAddress = process.env.NODE_SEN_INTERFACE;
  }
  await sen.connect(connectOptions);

  try {
    const objects = await sen.interest('SELECT * FROM hmi.diagnostics');
    const probe = await objects.waitFor('EtherProbe', { timeout: 5000 });

    const fastEvent = new Promise(resolve => probe.once('fastEvent', resolve));
    const probeEvent = new Promise(resolve => probe.once('probeEvent', resolve));
    const variantEvent = new Promise(resolve => probe.once('variantEvent', resolve));

    await probe.set('label', 'integration-js');
    assert.equal(await probe.get('label'), 'integration-js');
    assert.equal(await probe.call('ping', ['hello']), 'pong:hello');
    assert.equal(await probe.call('add', [20, 22]), 42);
    assert.deepEqual(await probe.call('echo', [{ id: 7, label: 'js', gain: 1.5 }]), {
      ok: true,
      message: 'js',
      value: 10.5
    });
    assert.deepEqual([...await probe.call('roundTripBuffer', [Buffer.from([1, 2, 3, 4])])], [1, 2, 3, 4]);
    assert.deepEqual(await probe.call('roundTripVariant', [{ type: 'u32', value: 314 }]), {
      key: 1,
      type: 'u32',
      value: 314
    });

    await probe.call('triggerEvents', ['from-test', 123]);
    assert.deepEqual((await fastEvent).args, [123]);
    assert.deepEqual((await probeEvent).args.slice(0, 2), ['from-test', 123]);
    assert.deepEqual((await variantEvent).args[0], {
      key: 1,
      type: 'u32',
      value: 123
    });
  } finally {
    await sen.close();
  }
});
