#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-isolation=none',
  './test/client.test.js'
], {
  env: { ...process.env, SEN_TEST_MULTICAST: '1' },
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
