#!/usr/bin/env node
import { spawn } from 'node:child_process';

const timeoutMs = Number(process.env.SEN_TEST_EXIT_TIMEOUT_MS ?? 120_000);
const args = [
  '--test',
  '--test-concurrency=1',
  '--test-reporter',
  'spec',
  './test/protocol.test.js',
  './test/codec.test.js',
  './test/discovery.test.js',
  './test/live-discovery.test.js',
  './test/client.test.js',
  './test/routing.test.js',
  './test/sen.test.js',
  './test/method-timeout.test.js',
  './test/stl.test.js',
  './test/types.test.js',
  './test/resource-limits.test.js'
];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
const timer = setTimeout(() => {
  console.error(`test process did not exit within ${timeoutMs} ms; sockets or timers may still be open`);
  child.kill('SIGTERM');
}, timeoutMs);
timer.unref();
child.once('error', error => {
  clearTimeout(timer);
  throw error;
});
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  process.exitCode = signal ? 1 : code ?? 1;
});
