import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFom, resolveFom } from './fom.js';
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

async function findXmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
    .map(entry => path.join(directory, entry.name)).sort();
}

async function fomLayout(source) {
  const info = await stat(source);
  if (info.isFile()) {
    if (path.extname(source).toLowerCase() !== '.xml') throw new Error(`FOM source is not an XML file: ${source}`);
    const root = path.dirname(path.dirname(source));
    const entries = await readdir(root, { withFileTypes: true });
    return {
      moduleDirectories: entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)).sort(),
      mappingFiles: entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xml')).map(entry => path.join(root, entry.name)).sort()
    };
  }
  const directXml = await findXmlFiles(source);
  const entries = await readdir(source, { withFileTypes: true });
  const childDirectories = entries.filter(entry => entry.isDirectory()).map(entry => path.join(source, entry.name)).sort();
  if (directXml.length && !childDirectories.length) return { moduleDirectories: [source], mappingFiles: [] };
  return {
    moduleDirectories: childDirectories,
    mappingFiles: directXml
  };
}

async function loadFomLayouts(layouts, options = {}) {
  const moduleDirectories = [...new Set(layouts.flatMap(item => item.moduleDirectories))];
  const mappingFiles = [...new Set([
    ...layouts.flatMap(item => item.mappingFiles),
    ...(options.mappingPaths ?? []).map(item => path.resolve(item))
  ])];
  const documents = [];
  for (const directory of moduleDirectories) {
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) continue;
    const packageName = path.basename(directory).toLowerCase();
    for (const fileName of await findXmlFiles(directory)) {
      documents.push(parseFom(await readFile(fileName, 'utf8'), { fileName: path.resolve(fileName), packageName }));
    }
  }
  if (!documents.length) throw new Error('no HLA FOM XML files found');
  const mappings = await Promise.all(mappingFiles.map(async fileName => ({ fileName, source: await readFile(fileName, 'utf8') })));
  return resolveFom(documents, { mappings });
}

/**
 * Loads an IEEE 1516.2 FOM module directory, a SEN FOM layout, or one XML file
 * within such a layout into a reusable SEN type registry.
 *
 * @param {string|URL} sourcePath
 * @param {{mappingPaths?: string[]}} [options]
 */
export async function loadFom(sourcePath, options = {}) {
  const inputPath = sourcePath instanceof URL ? fileURLToPath(sourcePath) : String(sourcePath ?? '');
  const root = path.resolve(inputPath);
  if (!await stat(root).catch(() => null)) throw new Error(`FOM path does not exist: ${sourcePath}`);
  return await loadFomLayouts([await fomLayout(root)], options);
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
  const inputPath = sourcePath instanceof URL ? fileURLToPath(sourcePath) : String(sourcePath ?? '');
  const root = path.resolve(inputPath);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo) throw new Error(`STL path does not exist: ${sourcePath}`);

  const includePaths = (options.includePaths ?? []).map(item => path.resolve(item));
  const entries = rootInfo.isDirectory() ? await findStlFiles(root) : [root];
  if (!entries.length) throw new Error(`no .stl files found in ${sourcePath}`);

  const sources = new Map();
  const fomImports = new Set();
  const preload = async fileName => {
    const absolute = path.resolve(fileName);
    if (path.extname(absolute).toLowerCase() === '.xml') {
      fomImports.add(absolute);
      return;
    }
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

  let fomRegistry;
  if (fomImports.size) {
    const layouts = [];
    const roots = new Set();
    for (const fileName of fomImports) {
      const root = path.dirname(path.dirname(fileName));
      if (!roots.has(root)) {
        roots.add(root);
        layouts.push(await fomLayout(fileName));
      }
    }
    fomRegistry = await loadFomLayouts(layouts, options);
  }

  return resolveStl(entries.map(item => path.resolve(item)), {
    sources,
    initialTypes: fomRegistry?.typeByName,
    externalFiles: fomRegistry?.files,
    resolveExternal(fileName, fromFile) {
      if (!fomRegistry) return undefined;
      const candidates = path.isAbsolute(fileName)
        ? [fileName]
        : [path.resolve(path.dirname(fromFile), fileName), ...includePaths.map(item => path.resolve(item, fileName))];
      for (const candidate of candidates) {
        const external = fomRegistry.files.get(path.resolve(candidate));
        if (external) return external;
      }
      return undefined;
    },
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
