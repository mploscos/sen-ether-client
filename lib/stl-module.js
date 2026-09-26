const PRIMITIVES = new Map([
  ['bool', 'boolean'], ['boolean', 'boolean'], ['string', 'string'],
  ['f32', 'number'], ['f64', 'number'], ['float', 'number'], ['double', 'number'],
  ['i8', 'number'], ['u8', 'number'], ['i16', 'number'], ['u16', 'number'],
  ['i32', 'number'], ['u32', 'number'],
  ['i64', 'bigint | number'], ['u64', 'bigint | number'],
  ['Duration', 'bigint | number'], ['TimeStamp', 'bigint | number'],
  ['Buffer', 'Uint8Array | ArrayBuffer'], ['void', 'void']
]);

function pascalCase(value) {
  return String(value).split(/[^A-Za-z0-9_$]+/).filter(Boolean)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join('');
}

function identifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : JSON.stringify(value);
}

function aliasesFor(types) {
  const counts = new Map();
  for (const type of types) counts.set(type.name, (counts.get(type.name) ?? 0) + 1);
  return new Map(types.map(type => [
    type.qualifiedName,
    counts.get(type.name) === 1 ? type.name : pascalCase(type.qualifiedName)
  ]));
}

function typeName(name, aliases) {
  return PRIMITIVES.get(name) ?? aliases.get(name) ?? pascalCase(name);
}

function objectType(properties) {
  if (!properties.length) return '{}';
  return `{\n${properties.map(property => ` *   ${property}`).join(',\n')}\n * }`;
}

function typedef(lines, type, name, description = '') {
  lines.push('/**');
  if (description) lines.push(` * ${String(description).replaceAll('*/', '* /')}`);
  lines.push(` * @typedef {${type}} ${name}`, ' */', '');
}

function intersection(types) {
  const values = types.filter(Boolean);
  return values.length ? values.map(value => `(${value})`).join(' & ') : '{}';
}

function tuple(args, aliases) {
  return `[${(args ?? []).map(arg => `${identifier(arg.name)}: ${typeName(arg.type, aliases)}`).join(', ')}]`;
}

function classMembers(type, typesByName, member) {
  const values = new Map();
  const visit = current => {
    for (const parent of current.parents ?? []) {
      const parentType = typesByName.get(parent);
      if (parentType) visit(parentType);
    }
    for (const item of current[member] ?? []) values.set(item.name, item);
  };
  visit(type);
  return [...values.values()];
}

function emitEnum(lines, type, alias) {
  const values = type.values.map((item, index) => ({
    key: item.key ?? index,
    name: item.name
  }));
  lines.push('/**');
  if (type.description) lines.push(` * ${String(type.description).replaceAll('*/', '* /')}`);
  lines.push(' * @type {Readonly<Record<number, string> & {');
  for (const value of values) lines.push(` *   ${identifier(value.name)}: ${value.key},`);
  lines.push(' * }>}', ' */', `export const ${alias} = Object.freeze({`);
  for (const value of values) lines.push(`  ${JSON.stringify(String(value.key))}: ${JSON.stringify(value.name)},`);
  for (const value of values) lines.push(`  ${identifier(value.name)}: ${value.key},`);
  lines.push('});', '');
  typedef(lines, `Extract<(typeof ${alias})[keyof typeof ${alias}], number>`, alias);
}

function emitValueType(lines, type, alias, aliases) {
  const ref = name => typeName(name, aliases);
  switch (type.kind) {
    case 'StructType': {
      const own = objectType(type.fields.map(field => `${identifier(field.name)}: ${ref(field.type)}`));
      typedef(lines, intersection([type.parent ? `${ref(type.parent)}` : '', own]), alias, type.description);
      break;
    }
    case 'EnumType': emitEnum(lines, type, alias); break;
    case 'SequenceType': typedef(lines, `Array<${ref(type.elementType)}>`, alias, type.description); break;
    case 'AliasType': typedef(lines, ref(type.target), alias, type.description); break;
    case 'OptionalType': typedef(lines, `${ref(type.target)} | null`, alias, type.description); break;
    case 'QuantityType': typedef(lines, ref(type.elementType), alias, type.description); break;
    case 'VariantType':
      typedef(lines, type.fields.map((field, key) => `{key: ${key}, value: ${ref(field.type)}}`).join(' | ') || 'never', alias, type.description);
      break;
    default: throw new TypeError(`cannot generate JavaScript types for '${type.qualifiedName}' (${type.kind})`);
  }
}

function emitClass(lines, type, alias, aliases, typesByName) {
  const ref = name => typeName(name, aliases);
  const propertiesName = `${alias}Properties`;
  const contextName = `${alias}MethodContext`;
  const methodsName = `${alias}Methods`;
  const eventsName = `${alias}Events`;
  const objectName = `${alias}Object`;
  const proxyName = `${alias}Proxy`;
  const allProperties = classMembers(type, typesByName, 'properties');
  const allMethods = classMembers(type, typesByName, 'methods');
  const allEvents = classMembers(type, typesByName, 'events');

  const ownProperties = objectType(type.properties.map(property => `${identifier(property.name)}: ${ref(property.type)}`));
  typedef(lines, intersection([...(type.parents ?? []).map(parent => `${ref(parent)}Properties`), ownProperties]), propertiesName);
  typedef(lines, objectType([
    `readonly state: ${propertiesName}`,
    `update: (patch: Partial<${propertiesName}>) => unknown`,
    `set: (patch: Partial<${propertiesName}>) => unknown`
  ]), contextName);

  const methodCallbacks = [];
  for (const method of type.methods) {
    const callbackName = `${alias}${pascalCase(method.name)}Method`;
    lines.push('/**', ` * @callback ${callbackName}`, ` * @this {${contextName}}`);
    for (const arg of method.args ?? []) lines.push(` * @param {${ref(arg.type)}} ${arg.name}`);
    lines.push(` * @returns {${ref(method.returnType)} | Promise<${ref(method.returnType)}>}`, ' */', '');
    methodCallbacks.push(`${identifier(method.name)}?: ${callbackName}`);
  }
  typedef(lines, intersection([
    ...(type.parents ?? []).map(parent => `${ref(parent)}Methods`),
    objectType(methodCallbacks)
  ]), methodsName);

  const ownEvents = objectType(type.events.map(event => `${identifier(event.name)}: ${tuple(event.args, aliases)}`));
  typedef(lines, intersection([...(type.parents ?? []).map(parent => `${ref(parent)}Events`), ownEvents]), eventsName);

  const eventCalls = allEvents.map(event => `(name: ${JSON.stringify(event.name)}, args: ${tuple(event.args, aliases)}) => Promise<unknown>`);
  typedef(lines, objectType([
    'readonly name: string',
    `readonly className: ${JSON.stringify(type.qualifiedName)}`,
    `readonly snapshot: ${propertiesName}`,
    `readonly properties: ${propertiesName}`,
    `readonly methods: ${methodsName}`,
    `update: (patch: Partial<${propertiesName}>) => Promise<unknown>`,
    `emit: ${intersection(eventCalls.length ? eventCalls : ['(name: never, args: never) => Promise<never>'])}`,
    'remove: () => Promise<void>'
  ]), objectName);

  const writableSets = allProperties.filter(property => property.category?.endsWith('RW'))
    .map(property => `(name: ${JSON.stringify(property.name)}, value: ${ref(property.type)}) => Promise<void>`);
  const methodCalls = allMethods.map(method => `(name: ${JSON.stringify(method.name)}, args: ${tuple(method.args, aliases)}) => Promise<Awaited<${ref(method.returnType)}>>`);
  const listeners = [
    ...allEvents.map(event => `(name: ${JSON.stringify(event.name)}, listener: (event: {args: ${tuple(event.args, aliases)}}) => void) => ${proxyName}`),
    ...allProperties.map(property => `(name: ${JSON.stringify(`change:${property.name}`)}, listener: (change: {value: ${ref(property.type)}, previous: ${ref(property.type)} | undefined}) => void) => ${proxyName}`)
  ];
  typedef(lines, objectType([
    'readonly name: string',
    `readonly className: ${JSON.stringify(type.qualifiedName)}`,
    `readonly snapshot: ${propertiesName}`,
    `get: <Name extends keyof ${propertiesName}>(name: Name) => Promise<${propertiesName}[Name]>`,
    `set: ${intersection(writableSets.length ? writableSets : ['(name: never, value: never) => Promise<never>'])}`,
    `call: ${intersection(methodCalls.length ? methodCalls : ['(name: never, args: never) => Promise<never>'])}`,
    `on: ${intersection(listeners.length ? listeners : ['(name: never, listener: never) => never'])}`
  ]), proxyName);

  typedef(lines, objectType([
    'name: string',
    `className: ${JSON.stringify(type.qualifiedName)}`,
    `properties: ${propertiesName}`,
    `methods?: ${methodsName}`
  ]), alias, type.description);

  lines.push('/**', ` * Publish a ${type.qualifiedName} object.`, ' * @param {*} sen', ' * @param {string} bus', ` * @param {${alias}} descriptor`, ' * @param {object} [options]', ` * @returns {Promise<${objectName}>}`, ' */');
  lines.push(`export async function publish${alias}(sen, bus, descriptor, options) {`, `  return /** @type {${objectName}} */ (await sen.publish(bus, descriptor, options));`, '}', '');
  lines.push('/**', ` * Wait for a remote ${type.qualifiedName} object.`, ' * @param {*} interest', ` * @param {string | number | ((object: ${proxyName}) => boolean)} selector`, ' * @param {object} [options]', ` * @returns {Promise<${proxyName}>}`, ' */');
  lines.push(`export async function waitFor${alias}(interest, selector, options) {`, `  return /** @type {${proxyName}} */ (await interest.waitFor(selector, options));`, '}', '');
}

/** Generate an ESM helper module with self-contained JSDoc types for resolved STL. */
export function generateStlModule(registry) {
  if (!registry || typeof registry.values !== 'function') throw new TypeError('generateStlModule requires an StlTypeRegistry');
  const types = [...registry.values()];
  const aliases = aliasesFor(types);
  const typesByName = new Map(types.map(type => [type.qualifiedName, type]));
  const lines = ['// Generated by sen-stl-types. Do not edit.', '// @ts-check', ''];
  for (const type of types) {
    const alias = aliases.get(type.qualifiedName);
    if (type.kind === 'ClassType') emitClass(lines, type, alias, aliases, typesByName);
    else emitValueType(lines, type, alias, aliases);
  }
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
