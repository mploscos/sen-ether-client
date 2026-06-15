import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Sen } from '../index.js';

const command = process.env.SEN_RECONNECT_COMMAND;
const tcpHub = process.env.SEN_RECONNECT_TCP_HUB;
const interestQuery = process.env.SEN_RECONNECT_INTEREST;
const objectSelector = process.env.SEN_RECONNECT_OBJECT;
const extraInterests = (process.env.SEN_RECONNECT_EXTRA_INTERESTS ?? '')
  .split(';')
  .map(item => item.trim())
  .filter(Boolean);
const cwd = process.env.SEN_RECONNECT_CWD;
const timeoutMs = Number(process.env.SEN_RECONNECT_TIMEOUT_MS ?? 15000);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startProcess() {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore'
  });
  child.unref();
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    return;
  }

  await Promise.race([
    once(child, 'exit'),
    wait(3000)
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // Process already exited.
    }
  }
}

test('reconnect restarts existing interests after process restart', {
  skip: command && tcpHub && interestQuery && objectSelector
    ? false
    : 'set SEN_RECONNECT_COMMAND, SEN_RECONNECT_TCP_HUB, SEN_RECONNECT_INTEREST and SEN_RECONNECT_OBJECT'
}, async () => {
  let processA;
  let processB;
  const sen = new Sen({
    timeout: Number(process.env.SEN_RECONNECT_OPERATION_TIMEOUT_MS ?? 5000),
    reconnect: true,
    reconnectDelayMs: Number(process.env.SEN_RECONNECT_DELAY_MS ?? 250),
    maxReconnectAttempts: Number(process.env.SEN_RECONNECT_ATTEMPTS ?? 80)
  });
  sen.on('warning', () => {});

  try {
    processA = startProcess();
    await wait(Number(process.env.SEN_RECONNECT_STARTUP_MS ?? 1500));

    await sen.connect({
      tcpHub,
      session: process.env.SEN_RECONNECT_SESSION
    });
    const interestOptions = {
      changeMode: process.env.SEN_RECONNECT_CHANGE_MODE ?? 'individual'
    };
    if (process.env.SEN_RECONNECT_PROPERTIES) {
      interestOptions.properties = process.env.SEN_RECONNECT_PROPERTIES.split(',').map(item => item.trim()).filter(Boolean);
    }
    if (interestOptions.changeMode === 'batch') {
      interestOptions.batchIntervalMs = Number(process.env.SEN_RECONNECT_BATCH_INTERVAL_MS ?? 16);
    }

    const interest = await sen.interest(interestQuery, interestOptions);
    const additional = [];
    for (const query of extraInterests) {
      additional.push(await sen.interest(query, interestOptions));
    }
    const first = await interest.waitFor(objectSelector, { timeout: timeoutMs });
    assert.equal(first.matches(objectSelector), true);
    for (const item of additional) {
      assert.ok(item.objects().length >= 0);
    }

    const stale = once(interest, 'stale');
    const reconnected = once(sen, 'reconnect');
    await stopProcess(processA);
    await stale;

    processB = startProcess();
    await reconnected;

    const second = await interest.waitFor(objectSelector, { timeout: timeoutMs });
    assert.equal(second.matches(objectSelector), true);
    for (const item of additional) {
      assert.equal(item.changeMode, interestOptions.changeMode);
    }
  } finally {
    await sen.close();
    await stopProcess(processA);
    await stopProcess(processB);
  }
});
