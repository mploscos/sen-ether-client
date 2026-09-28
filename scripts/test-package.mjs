#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(rootDir, '.package-test-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('test:package must be run through npm');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${path.basename(command)} exited with ${result.status}`);
  }
  return result.stdout;
}

try {
  run(process.execPath, [path.join(rootDir, 'scripts', 'build-types.mjs')]);
  const packOutput = run(process.execPath, [
    npmCli,
    'pack',
    '--json',
    '--pack-destination',
    tempDir
  ], { capture: true });
  const [manifest] = JSON.parse(packOutput);
  const files = manifest.files.map(entry => entry.path);
  const forbidden = files.filter(file => /^(test|artifacts|node_modules)\//.test(file));
  if (forbidden.length) {
    throw new Error(`package contains internal files: ${forbidden.join(', ')}`);
  }
  for (const required of [
    'index.js',
    'types/generated/index.d.ts',
    'types/interest-query.d.ts',
    'types/types.d.ts',
    'LICENSE',
    'LICENSES/Apache-2.0.txt',
    'THIRD_PARTY_NOTICES.md',
    'README.md',
    'API.md',
    'docs/ARCHITECTURE.md',
    'docs/COMPATIBILITY.md',
    'docs/INTEGRATION.md',
    'docs/UPGRADING.md',
    'CHANGELOG.md',
    'resources/protocol/protocol.json'
  ]) {
    if (!files.includes(required)) throw new Error(`package is missing ${required}`);
  }

  const consumerDir = path.join(tempDir, 'consumer');
  fs.mkdirSync(consumerDir);
  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module'
  }, null, 2));
  const tarball = path.join(tempDir, manifest.filename);
  run(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumerDir
  });
  fs.copyFileSync(path.join(rootDir, 'test', 'package-consumer.mjs'), path.join(consumerDir, 'consumer.mjs'));
  fs.copyFileSync(path.join(rootDir, 'test', 'package-consumer.mts'), path.join(consumerDir, 'consumer.mts'));
  fs.writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      noEmit: true,
      strict: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: ['node']
    },
    files: ['consumer.mts']
  }, null, 2));
  run(process.execPath, ['consumer.mjs'], { cwd: consumerDir });
  const tsc = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', path.join(consumerDir, 'tsconfig.json')]);
  console.log(`package consumer passed (${files.length} files, ${manifest.size} bytes)`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
