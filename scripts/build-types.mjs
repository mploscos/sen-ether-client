#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'types', 'generated');
const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

fs.rmSync(outputDir, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.types.json'], {
  cwd: rootDir,
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
