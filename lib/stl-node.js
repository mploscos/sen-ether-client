import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseStl, resolveStl } from './stl.js';

async function isFile(fileName) {
  try {
    return (await stat(fileName)).isFile();
  } catch {
    return false;
  }
}

async function findImport(fileName, fromFile, includePaths) {
  const candidates = path.isAbsolute(fileName)
    ? [fileName]
    : [path.resolve(path.dirname(fromFile), fileName), ...includePaths.map(item => path.resolve(item, fileName))];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

async function findStlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) return await findStlFiles(fileName);
    return entry.isFile() && entry.name.endsWith('.stl') ? [fileName] : [];
  }));
  return files.flat();
}

/**
 * Loads and resolves an STL file or directory once using Node's filesystem.
 * Parsing and resolution remain in ./stl.js, which has no filesystem access.
 *
 * @param {string} sourcePath Entry STL file or a directory containing STL files.
 * @param {{includePaths?: string[]}} [options]
 * @returns {Promise<import('./stl.js').StlTypeRegistry>}
 */
export async function loadStl(sourcePath, options = {}) {
  const root = path.resolve(String(sourcePath ?? ''));
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo) throw new Error(`STL path does not exist: ${sourcePath}`);

  const includePaths = (options.includePaths ?? []).map(item => path.resolve(item));
  const entries = rootInfo.isDirectory() ? await findStlFiles(root) : [root];
  if (!entries.length) throw new Error(`no .stl files found in ${sourcePath}`);

  const sources = new Map();
  const preload = async fileName => {
    const absolute = path.resolve(fileName);
    if (sources.has(absolute)) return;
    const source = await readFile(absolute, 'utf8');
    sources.set(absolute, source);
    const ast = parseStl(source, { fileName: absolute });
    for (const statement of ast.statements) {
      if (statement.kind !== 'ImportDeclaration') continue;
      const imported = await findImport(statement.file, absolute, includePaths);
      if (!imported) throw new Error(`could not find STL import '${statement.file}' from ${absolute}`);
      await preload(imported);
    }
  };

  for (const entry of entries) await preload(entry);

  return resolveStl(entries.map(item => path.resolve(item)), {
    sources,
    load(fileName, fromFile) {
      const candidates = path.isAbsolute(fileName)
        ? [fileName]
        : [path.resolve(path.dirname(fromFile), fileName), ...includePaths.map(item => path.resolve(item, fileName))];
      for (const candidate of candidates) {
        const absolute = path.resolve(candidate);
        if (sources.has(absolute)) return { fileName: absolute, source: sources.get(absolute) };
      }
      return undefined;
    }
  });
}
