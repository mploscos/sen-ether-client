/** IEEE 1516.2-2010 HLA FOM to SEN type registry conversion. */

import { StlResolutionError, StlTypeRegistry } from './stl.js';
import { parseXml } from './xml.js';

const PRIMITIVES = new Set(['bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'string', 'Duration', 'TimeStamp']);
const NATIVE_FOM_TYPES = new Map([
  ['HLAASCIIchar', 'u8'], ['HLAbyte', 'u8'], ['HLAunicodeChar', 'u16'],
  ['HLAcount', 'i32'], ['HLAseconds', 'i32'], ['HLAmsec', 'i32'], ['HLAindex', 'i32'],
  ['HLAinteger64Time', 'i64'], ['HLAfloat64Time', 'f64'], ['HLAboolean', 'bool'],
  ['HLAASCIIstring', 'string'], ['HLAunicodeString', 'string']
]);
const REPRESENTATIONS = new Map([
  ['HLAinteger16LE', 'i16'], ['HLAinteger16BE', 'i16'],
  ['HLAinteger32LE', 'i32'], ['HLAinteger32BE', 'i32'],
  ['HLAinteger64LE', 'i64'], ['HLAinteger64BE', 'i64'],
  ['HLAfloat32LE', 'f32'], ['HLAfloat32BE', 'f32'],
  ['HLAfloat64LE', 'f64'], ['HLAfloat64BE', 'f64'],
  ['HLAoctet', 'u8'], ['HLAoctetPairBE', 'u16'], ['HLAoctetPairLE', 'u16']
]);
const UNITS = new Map([
  ['meter per second squared (m/(s^2))', 'm_per_s_sq'], ['degree (deg)', 'deg'],
  ['radian (rad)', 'rad'], ['radian per second (rad/s)', 'rad_per_s'], ['meter (m)', 'm'],
  ['hertz (Hz)', 'hz'], ['interrogations/second', 'hz'], ['kilogram (kg)', 'kg'],
  ['revolutions per minute (RPM)', 'rpm'], ['RPM', 'rpm'], ['degree Celsius (C)', 'degC'],
  ['microsecond', 'us'], ['millisecond (ms)', 'ms'], ['second (s)', 's'],
  ['meter per second (m/s)', 'm_per_s'], ['micron', 'um'], ['decimeter per second (dm/s)', 'dm_per_s']
]);
const OPTIONAL_PREFIXES = ['Optional.', 'Optional (', 'Optional:', 'Optional,'];
const RESERVED_PROPERTIES = new Set(['name', 'id', 'localName', 'lastCommitTime', 'propertyUntyped']);

export class FomResolutionError extends StlResolutionError {
  constructor(message, document) {
    super(`${message}${document?.fileName ? ` in ${document.fileName}` : ''}`);
    this.name = 'FomResolutionError';
  }
}

function words(value) { return String(value ?? '').split(/[_-]+/).filter(Boolean); }

export function fomTypeName(value) {
  let result = String(value ?? '').replace(/[_-]/g, '');
  if (result) result = result[0].toUpperCase() + result.slice(1);
  if (/^\d/.test(result)) result = `n${result}`;
  return result;
}

function memberTypeName(value) {
  let result = words(value).map(word => {
    const normalized = /^[A-Z\d]+$/.test(word) ? word.toLowerCase() : word;
    return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
  }).join('');
  if (/^\d/.test(result)) result = `n${result}`;
  return result;
}

export function fomMemberName(value) {
  const result = memberTypeName(value);
  if (!result) return result;
  const member = result[0].toLowerCase() + result.slice(1);
  return ['true', 'false', 'class', 'enum', 'struct', 'static'].includes(member) ? `${member}Val` : member;
}

function propertyName(value) {
  const result = fomMemberName(value);
  return RESERVED_PROPERTIES.has(result) ? `${result}NonSen` : result;
}

function description(node) { return node?.childText('semantics').replace(/\n/g, ' ').replace(/"/g, "'") ?? ''; }
function isOptional(text) { return OPTIONAL_PREFIXES.some(prefix => text.startsWith(prefix)); }
function nodeName(node) { return node.childText('name'); }
function qualified(doc, name) { return `${doc.packageName}.${fomTypeName(name)}`; }

function collectSemanticNodes(root, elementName) {
  return root.descendants(elementName).filter(node => node.child('semantics'));
}

/** Parses one HLA FOM module without resolving cross-document types. */
export function parseFom(source, options = {}) {
  const fileName = options.fileName ?? '<fom.xml>';
  const packageName = options.packageName ?? 'fom';
  const root = parseXml(source, { fileName });
  if (root.name !== 'objectModel') throw new FomResolutionError(`expected an objectModel root, found '${root.name}'`, { fileName });
  const identification = root.child('modelIdentification');
  const references = identification?.childrenNamed('reference') ?? [];
  return {
    fileName,
    packageName,
    root,
    identification: identification?.childText('name') ?? '',
    dependencies: references.filter(item => item.childText('type').includes('Dependency'))
      .map(item => item.childText('identification')).filter(item => item && item !== 'MIM'),
    deps: [],
    definitions: new Map(),
    classes: collectSemanticNodes(root.child('objects') ?? root, 'objectClass'),
    interactions: collectSemanticNodes(root.child('interactions') ?? root, 'interactionClass'),
    resolved: new Map(),
    types: new Map()
  };
}

function indexDefinitions(doc) {
  const dataTypes = doc.root.child('dataTypes');
  const groups = [
    ['simpleDataTypes', 'simpleData', 'simple'], ['arrayDataTypes', 'arrayData', 'array'],
    ['fixedRecordDataTypes', 'fixedRecordData', 'record'],
    ['variantRecordDataTypes', 'variantRecordData', 'variant'],
    ['enumeratedDataTypes', 'enumeratedData', 'enum']
  ];
  for (const [group, element, kind] of groups) {
    for (const node of dataTypes?.child(group)?.childrenNamed(element) ?? []) {
      if (!doc.definitions.has(nodeName(node))) doc.definitions.set(nodeName(node), { kind, node });
    }
  }
  for (const node of doc.classes) if (!doc.definitions.has(nodeName(node))) doc.definitions.set(nodeName(node), { kind: 'class', node });
}

class FomResolver {
  constructor(documents, mappings = []) {
    this.documents = documents;
    this.mappingRoots = mappings.map(item => item.root ?? parseXml(item.source, { fileName: item.fileName }));
    this.typeByName = new Map();
    this.files = new Map();
    this.representations = new Map(REPRESENTATIONS);
    this.resolving = new Set();
  }

  resolve() {
    this.resolveDependencies();
    this.readRepresentations();
    this.addHlaTypes();
    for (const doc of this.documents) indexDefinitions(doc);
    for (const doc of this.dependencyOrder()) {
      for (const name of doc.definitions.keys()) this.resolveType(name, doc);
      for (const interaction of doc.interactions) this.interactionStruct(interaction, doc);
    }
    this.applyMappings();
    for (const doc of this.documents) this.files.set(doc.fileName, { fileName: doc.fileName, packageName: doc.packageName, imports: [], types: doc.types });
    for (const doc of this.documents) this.files.get(doc.fileName).imports = doc.deps.map(dep => this.files.get(dep.fileName));
    return new StlTypeRegistry(this.typeByName, this.files);
  }

  resolveDependencies() {
    for (const doc of this.documents) {
      for (const dependency of doc.dependencies) {
        const needle = dependency.toLowerCase();
        const found = this.documents.find(candidate => candidate.identification.toLowerCase().includes(needle) || candidate.fileName.toLowerCase().split('/').at(-1).replace(/\.xml$/, '').includes(needle));
        if (!found) throw new FomResolutionError(`could not find dependent document '${dependency}'`, doc);
        doc.deps.push(found);
      }
    }
  }

  dependencyOrder() {
    const result = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = doc => {
      if (visited.has(doc)) return;
      if (visiting.has(doc)) throw new FomResolutionError('circular FOM document dependency', doc);
      visiting.add(doc);
      for (const dep of doc.deps) visit(dep);
      visiting.delete(doc);
      visited.add(doc);
      result.push(doc);
    };
    for (const doc of this.documents) visit(doc);
    return result;
  }

  readRepresentations() {
    for (const doc of this.documents) {
      const group = doc.root.child('dataTypes')?.child('basicDataRepresentations');
      for (const node of group?.childrenNamed('basicData') ?? []) {
        const encoding = node.childText('encoding');
        const match = [
          ['8-bit unsigned integer', 'u8'], ['16-bit unsigned integer', 'u16'], ['32-bit unsigned integer', 'u32'], ['64-bit unsigned integer', 'u64'],
          ['16-bit signed integer', 'i16'], ['32-bit signed integer', 'i32'], ['64-bit signed integer', 'i64']
        ].find(([prefix]) => encoding.startsWith(prefix));
        if (!match) throw new FomResolutionError(`unknown encoding '${encoding}' for basic data representation '${nodeName(node)}'`, doc);
        this.representations.set(nodeName(node), match[1]);
      }
    }
  }

  addHlaTypes() {
    this.add(null, { kind: 'ClassType', name: 'ObjectRoot', qualifiedName: 'hla.ObjectRoot', description: 'HLA Base Class that contains the RTI object ID', parent: null, parents: [], isAbstract: false,
      properties: [{ name: 'rtiId', description: 'HLA RTI object ID', type: 'string', category: 'dynamicRW', transportMode: 'confirmed', tags: [], checkedSet: false }], methods: [], events: [] });
    for (const primitive of PRIMITIVES) {
      // SEN has no signed 8-bit native type in its transport TypeSpec model.
      if (primitive === 'i8') continue;
      const name = `Maybe${fomTypeName(primitive)}`;
      this.add(null, { kind: 'OptionalType', name, qualifiedName: `hla.${name}`, description: '', target: primitive });
    }
  }

  add(doc, value) {
    const existing = this.typeByName.get(value.qualifiedName);
    if (existing) {
      if (doc) {
        doc.types.set(value.name, existing);
        doc.resolved.set(value.name, existing.qualifiedName);
      }
      return existing.qualifiedName;
    }
    const frozen = Object.freeze(value);
    this.typeByName.set(value.qualifiedName, frozen);
    if (doc) {
      doc.types.set(value.name, frozen);
      doc.resolved.set(value.name, value.qualifiedName);
    }
    return value.qualifiedName;
  }

  findDefinition(name, doc, seen = new Set()) {
    if (seen.has(doc)) return null;
    seen.add(doc);
    if (doc.definitions.has(name)) return { doc, ...doc.definitions.get(name) };
    for (const dep of doc.deps) {
      const found = this.findDefinition(name, dep, seen);
      if (found) return found;
    }
    return null;
  }

  resolveType(name, context) {
    if (!name) throw new FomResolutionError('encountered an empty FOM type name', context);
    if (PRIMITIVES.has(name)) return name;
    if (NATIVE_FOM_TYPES.has(name)) return NATIVE_FOM_TYPES.get(name);
    if (name === 'RPRboolean') return 'bool';
    if (context.resolved.has(name)) return context.resolved.get(name);
    const definition = this.findDefinition(name, context);
    if (!definition) throw new FomResolutionError(`could not find type '${name}'`, context);
    if (definition.doc.resolved.has(name)) return definition.doc.resolved.get(name);
    const key = `${definition.doc.fileName}\0${name}`;
    if (this.resolving.has(key)) throw new FomResolutionError(`circular reference while resolving type '${name}'`, definition.doc);
    this.resolving.add(key);
    let result;
    try { result = this.convertDefinition(name, definition); }
    finally { this.resolving.delete(key); }
    context.resolved.set(name, result);
    return result;
  }

  convertDefinition(name, definition) {
    const { doc, node, kind } = definition;
    const typeName = fomTypeName(name);
    const base = { name: typeName, qualifiedName: `${doc.packageName}.${typeName}`, description: description(node), fileName: doc.fileName };
    if (kind === 'simple') {
      const representation = this.representation(node.childText('representation'), doc);
      const unit = UNITS.get(node.childText('units'));
      return this.add(doc, unit
        ? { ...base, kind: 'QuantityType', elementType: representation, unit, minValue: null, maxValue: null }
        : { ...base, kind: 'AliasType', target: representation });
    }
    if (kind === 'array') {
      const elementName = node.childText('dataType');
      const cardinality = node.childText('cardinality');
      if (cardinality === 'Dynamic' && (elementName === 'HLAASCIIchar' || elementName === 'HLAunicodeChar')) {
        doc.resolved.set(name, 'string');
        return 'string';
      }
      let maxSize = null;
      if (/^\d+$/.test(cardinality)) maxSize = Number(cardinality);
      else {
        const range = cardinality.match(/^\[(\d+)\.{2,}(\d+)\]$/);
        if (range && Number(range[2]) < 1024 * 1024) maxSize = Number(range[2]);
      }
      return this.add(doc, { ...base, kind: 'SequenceType', elementType: this.resolveType(elementName, doc), maxSize, fixedSize: false });
    }
    if (kind === 'record') {
      const includes = node.childrenNamed('include').map(item => item.text()).filter(Boolean);
      if (includes.length > 1) throw new FomResolutionError(`record '${name}' includes more than one record`, doc);
      const parent = includes.length ? this.resolveType(includes[0], doc) : null;
      if (parent && this.typeByName.get(parent)?.kind !== 'StructType') throw new FomResolutionError(`record '${name}' includes '${includes[0]}', which is not a record`, doc);
      const fields = node.childrenNamed('field').map(field => ({ name: fomMemberName(field.childText('name')), description: description(field), type: this.resolveType(field.childText('dataType'), doc) }));
      return this.add(doc, { ...base, kind: 'StructType', parent, fields });
    }
    if (kind === 'variant') {
      const fields = node.childrenNamed('alternative').map(item => ({ name: fomMemberName(item.childText('name')), description: description(item), type: this.resolveType(item.childText('dataType'), doc) }));
      return this.add(doc, { ...base, kind: 'VariantType', fields });
    }
    if (kind === 'enum') {
      const storageType = this.representation(node.childText('representation'), doc);
      if (!/^[iu](?:8|16|32|64)$/.test(storageType)) throw new FomResolutionError(`storage type '${node.childText('representation')}' for enumeration '${name}' is not integral`, doc);
      const counts = new Map();
      const values = node.childrenNamed('enumerator').map(item => {
        const initial = fomMemberName(item.childText('name'));
        const count = counts.get(initial) ?? 0;
        counts.set(initial, count + 1);
        return { name: count ? `${initial}${count}` : initial, key: Number.parseInt(item.childText('value'), 10), description: description(item) };
      });
      return this.add(doc, { ...base, kind: 'EnumType', storageType, values });
    }
    if (kind === 'class') return this.classType(node, doc);
    throw new FomResolutionError(`unsupported FOM definition '${kind}'`, doc);
  }

  representation(name, doc) {
    const result = this.representations.get(name) ?? NATIVE_FOM_TYPES.get(name);
    if (!result) throw new FomResolutionError(`data representation '${name}' is not yet supported`, doc);
    return result;
  }

  optionalType(fomName, doc) {
    const target = this.resolveType(fomName, doc);
    let owner = doc;
    let name;
    if (PRIMITIVES.has(target)) {
      name = `Maybe${fomTypeName(target)}`;
      return `hla.${name}`;
    }
    const targetType = this.typeByName.get(target);
    if (targetType?.kind === 'AliasType' && PRIMITIVES.has(targetType.target)) {
      name = `Maybe${fomTypeName(targetType.target)}`;
      return `hla.${name}`;
    }
    name = `Maybe${fomTypeName(fomName)}`;
    const existing = this.typeByName.get(`${target.split('.').slice(0, -1).join('.')}.${name}`);
    if (existing) return existing.qualifiedName;
    owner = this.documents.find(item => item.packageName === target.split('.')[0] && [...item.types.values()].some(type => type.qualifiedName === target)) ?? doc;
    return this.add(owner, { kind: 'OptionalType', name, qualifiedName: `${owner.packageName}.${name}`, description: '', target, fileName: owner.fileName });
  }

  classType(node, doc) {
    const name = nodeName(node);
    if (doc.resolved.has(name)) return doc.resolved.get(name);
    let parent = 'hla.ObjectRoot';
    if (node.parent?.name === 'objectClass') {
      const parentName = nodeName(node.parent);
      parent = parentName === 'HLAobjectRoot' ? 'hla.ObjectRoot' : this.resolveType(parentName, doc);
    }
    const typeName = fomTypeName(name);
    const properties = node.childrenNamed('attribute').map(item => {
      const semantics = item.childText('semantics');
      const updateType = item.childText('updateType');
      const sharing = item.childText('sharing');
      let category = 'dynamicRO';
      if (updateType === 'Static') {
        if (sharing === 'PublishSubscribe' || sharing === 'Publish') category = 'staticRW';
        else if (sharing === 'Subscribe' || sharing === 'Neither') category = 'staticRO';
        else throw new FomResolutionError(`unknown sharing mode '${sharing}'`, doc);
      } else if (sharing === 'Writeable') category = 'dynamicRW';
      return { name: propertyName(item.childText('name')), description: description(item),
        type: isOptional(semantics) ? this.optionalType(item.childText('dataType'), doc) : this.resolveType(item.childText('dataType'), doc),
        category, transportMode: this.transport(item.childText('transportation'), 'property', doc), tags: [], checkedSet: false };
    });
    return this.add(doc, { kind: 'ClassType', name: typeName, qualifiedName: `${doc.packageName}.${typeName}`, description: description(node), fileName: doc.fileName,
      isAbstract: false, parent, parents: [parent], properties, methods: [], events: [], fomPath: this.classPath(node) });
  }

  transport(value, kind, doc) {
    if (value === 'HLAreliable') return 'confirmed';
    if (value === 'HLAbestEffort') return kind === 'method' ? 'unicast' : 'multicast';
    throw new FomResolutionError(`unknown transport mode '${value}'`, doc);
  }

  classPath(node) {
    const names = [nodeName(node)];
    for (let parent = node.parent; parent?.name === 'objectClass'; parent = parent.parent) {
      const name = nodeName(parent);
      if (name && name !== 'HLAobjectRoot') names.unshift(name);
    }
    return names.map(fomTypeName).join('.');
  }

  interactionPath(node) {
    const names = [nodeName(node)];
    for (let parent = node.parent; parent?.name === 'interactionClass'; parent = parent.parent) {
      const name = nodeName(parent);
      if (name && name !== 'HLAinteractionRoot') names.unshift(name);
    }
    return names.join('.');
  }

  interactionArgs(node, doc, ignored = []) {
    const chain = [];
    for (let current = node; current?.name === 'interactionClass'; current = current.parent) {
      if (nodeName(current) === 'HLAinteractionRoot') break;
      chain.unshift(current);
    }
    return chain.flatMap(current => current.childrenNamed('parameter')).filter(item => !ignored.includes(item.childText('name'))).map(item => {
      const semantics = item.childText('semantics');
      return { name: fomMemberName(item.childText('name')), description: description(item),
        type: isOptional(semantics) ? this.optionalType(item.childText('dataType'), doc) : this.resolveType(item.childText('dataType'), doc) };
    });
  }

  interactionStruct(node, doc, ignored = []) {
    let name = fomTypeName(nodeName(node));
    const duplicates = this.documents.flatMap(item => item.interactions.map(interaction => ({ doc: item, interaction })))
      .filter(item => fomTypeName(nodeName(item.interaction)) === name && item.doc.packageName === doc.packageName);
    if (duplicates.length > 1) name += words(doc.fileName.split('/').at(-1).replace(/\.xml$/, '')).at(-1) ?? '';
    const qualifiedName = `${doc.packageName}.${name}`;
    if (this.typeByName.has(qualifiedName)) return qualifiedName;
    return this.add(doc, { kind: 'StructType', name, qualifiedName, description: description(node), fileName: doc.fileName, parent: null,
      fields: this.interactionArgs(node, doc, ignored) });
  }

  findClass(path) { return [...this.typeByName.values()].find(type => type.kind === 'ClassType' && type.fomPath === path); }
  findInteraction(path) {
    for (const doc of this.documents) {
      const node = doc.interactions.find(item => this.interactionPath(item) === path || nodeName(item) === path);
      if (node) return { doc, node };
    }
    return null;
  }

  applyMappings() {
    for (const root of this.mappingRoots) {
      if (root.name !== 'senMapping') continue;
      for (const classMapping of root.childrenNamed('class')) {
        const type = this.findClass(classMapping.attribute('name'));
        if (!type) throw new FomResolutionError(`could not find mapped class '${classMapping.attribute('name')}'`);
        const mutable = { ...type, properties: type.properties.map(item => ({ ...item })), methods: [...type.methods], events: [...type.events] };
        for (const property of classMapping.childrenNamed('property')) {
          const found = mutable.properties.find(item => item.name === property.attribute('name'));
          if (found && /^true$/i.test(property.attribute('writable') ?? '')) found.category = 'dynamicRW';
          if (found && property.attribute('checked') !== undefined) found.checkedSet = /^true$/i.test(property.attribute('checked'));
        }
        for (const event of classMapping.childrenNamed('event')) mutable.events.push(this.mappedCallable(event, 'event'));
        for (const method of classMapping.childrenNamed('method')) mutable.methods.push(this.mappedCallable(method, 'method'));
        const frozen = Object.freeze(mutable);
        this.typeByName.set(type.qualifiedName, frozen);
        for (const doc of this.documents) if (doc.types.get(type.name)?.qualifiedName === type.qualifiedName) doc.types.set(type.name, frozen);
      }
    }
  }

  mappedCallable(mapping, kind) {
    const found = this.findInteraction(mapping.attribute('hlaInteraction'));
    if (!found) throw new FomResolutionError(`could not find interaction '${mapping.attribute('hlaInteraction')}'`);
    const ignored = mapping.childrenNamed('ignore').map(item => item.attribute('parameter'));
    const packed = /^true$/i.test(mapping.attribute('pack') ?? '');
    const args = packed ? [{ name: 'args', description: '', type: this.interactionStruct(found.node, found.doc, ignored) }] : this.interactionArgs(found.node, found.doc, ignored);
    const base = { name: fomMemberName(nodeName(found.node)), description: description(found.node), args,
      transportMode: this.transport(found.node.childText('transportation'), kind, found.doc) };
    if (kind === 'event') return base;
    const returnNode = mapping.child('return');
    let returnType = 'void';
    if (returnNode?.attribute('hlaInteraction')) {
      const returned = this.findInteraction(returnNode.attribute('hlaInteraction'));
      if (!returned) throw new FomResolutionError(`could not find return interaction '${returnNode.attribute('hlaInteraction')}'`);
      returnType = this.interactionStruct(returned.node, returned.doc, returnNode.childrenNamed('ignore').map(item => item.attribute('parameter')));
    } else if (returnNode?.attribute('dataType')) returnType = this.resolveType(returnNode.attribute('dataType'), found.doc);
    return { ...base, returnType, constness: 'nonConstant', deferred: /^true$/i.test(returnNode?.attribute('deferred') ?? ''), localOnly: /^true$/i.test(mapping.attribute('local') ?? '') };
  }
}

/** Resolves already parsed FOM documents into the same registry used by STL. */
export function resolveFom(documents, options = {}) {
  if (!Array.isArray(documents) || !documents.length) throw new TypeError('at least one FOM document is required');
  return new FomResolver(documents, options.mappings).resolve();
}
