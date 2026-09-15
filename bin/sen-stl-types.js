#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadStl } from '../lib/stl-node.js';
import { generateStlModule } from '../lib/stl-module.js';

function usage() {
  console.log(`Usage: sen-stl-types <stl-file-or-directory> [options]

Options:
  -o, --output <file>        Output module. Default: stl.mjs
  -I, --include <directory>  Add an STL import search path (repeatable)
  -h, --help                 Show this help`);
}

function parseArgs(argv) {
  const options = { includePaths: [], output: 'stl.mjs' };
  const nextValue = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${option} requires a path value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-o' || arg === '--output') {
      options.output = nextValue(index, arg);
      index += 1;
    } else if (arg === '-I' || arg === '--include') {
      options.includePaths.push(nextValue(index, arg));
      index += 1;
    } else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else if (!options.source) options.source = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.help && !options.source) throw new Error('an STL file or directory is required');
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    const registry = await loadStl(options.source, { includePaths: options.includePaths });
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, generateStlModule(registry), 'utf8');
    console.log(`Generated ${[...registry.values()].length} STL types in ${output}`);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
