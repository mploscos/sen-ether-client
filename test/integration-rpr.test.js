import assert from 'node:assert/strict';
import test from 'node:test';
import { Sen } from '../index.js';

const hub = process.env.RPR_SEN_TCP_HUB;
const query = process.env.RPR_SEN_INTEREST;

test('RPR compatibility smoke: interest discovers and decodes at least one object', {
  skip: hub && query ? false : 'set RPR_SEN_TCP_HUB and RPR_SEN_INTEREST with an RPR SEN kernel running'
}, async () => {
  const sen = new Sen({
    timeout: Number(process.env.RPR_SEN_TIMEOUT_MS ?? 10000),
    reconnect: false
  });
  await sen.connect({
    tcpHub: hub,
    session: process.env.RPR_SEN_SESSION
  });

  try {
    const objects = await sen.interest(query, {
      bus: process.env.RPR_SEN_BUS,
      forceBus: process.env.RPR_SEN_FORCE_BUS === '1',
      timeout: Number(process.env.RPR_SEN_TIMEOUT_MS ?? 10000)
    });
    const object = await objects.waitFor(() => true, {
      timeout: Number(process.env.RPR_SEN_TIMEOUT_MS ?? 10000)
    });
    await object.waitForType({ timeout: Number(process.env.RPR_SEN_TIMEOUT_MS ?? 10000) });
    assert.ok(object.className);
    assert.ok(object.name);
  } finally {
    await sen.close();
  }
});
