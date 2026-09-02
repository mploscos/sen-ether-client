/**
 * STL tokenizer, parser and resolver.
 *
 * This module deliberately has no transport or filesystem dependency. Callers
 * provide source text (or a synchronous source loader) and receive a reusable
 * registry that can later be adapted to SEN TypeSpecs.
 */

const KEYWORDS = new Map([
  ['abstract', 'abstract'], ['alias', 'alias'], ['array', 'array'], ['class', 'class'],
  ['enum', 'enum'], ['event', 'event'], ['extends', 'extends'], ['fn', 'fn'],
  ['implements', 'implements'], ['import', 'import'], ['interface', 'interface'],
  ['optional', 'optional'], ['package', 'package'], ['quantity', 'quantity'],
  ['sequence', 'sequence'], ['struct', 'struct'], ['var', 'var'], ['variant', 'variant'],
  ['true', 'boolean'], ['false', 'boolean']
]);

const PUNCTUATION = new Map([
  ['(', 'leftParen'], [')', 'rightParen'], ['{', 'leftBrace'], ['}', 'rightBrace'],
  ['[', 'leftBracket'], [']', 'rightBracket'], [',', 'comma'], ['.', 'dot'],
  [':', 'colon'], [';', 'semicolon'], ['-', 'minus'], ['<', 'less'], ['>', 'greater'], ['=', 'equal']
]);

const PRIMITIVES = new Set([
  'bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64',
  'string', 'Duration', 'TimeStamp', 'void'
]);

const NUMERIC_TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);
const INTEGRAL_TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64']);

const TYPE_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
const MEMBER_NAME_RE = /^[a-z][A-Za-z0-9_]*$/;

export class StlSyntaxError extends Error {
  constructor(message, token) {
    super(`${message}${token ? ` at ${token.line}:${token.column}` : ''}`);
    this.name = 'StlSyntaxError';
    this.location = token ? { line: token.line, column: token.column, offset: token.offset } : undefined;
  }
}

export class StlResolutionError extends Error {
  constructor(message, node) {
    super(`${message}${node?.location ? ` at ${node.location.line}:${node.location.column}` : ''}`);
    this.name = 'StlResolutionError';
    this.location = node?.location;
  }
}

function location(line, column, offset) {
  return { line, column, offset };
}

function token(type, lexeme, line, column, offset, value = undefined) {
  return { type, lexeme, value, line, column, offset };
}

/** Tokenizes the STL lexical grammar used by SEN's StlScanner. */
export function tokenizeStl(source, fileName = '<memory>') {
  const text = String(source ?? '');
  const tokens = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const atEnd = () => offset >= text.length;
  const peek = (ahead = 0) => text[offset + ahead] ?? '\0';
  const advance = () => {
    const value = text[offset++] ?? '\0';
    if (value === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return value;
  };
  const add = (type, start, startLine, startColumn, value) =>
    tokens.push(token(type, text.slice(start, offset), startLine, startColumn, start, value));
  const isDigit = value => value >= '0' && value <= '9';
  const isAlpha = value => /[A-Za-z_]/.test(value);
  const isAlphaNumeric = value => isAlpha(value) || isDigit(value);

  while (!atEnd()) {
    const start = offset;
    const startLine = line;
    const startColumn = column;
    const current = advance();

    if (/\s/.test(current)) continue;
    if (PUNCTUATION.has(current)) {
      if (current === '-' && isDigit(peek())) {
        while (isDigit(peek())) advance();
        if (peek() === '.' && isDigit(peek(1))) {
          advance();
          while (isDigit(peek())) advance();
          add('real', start, startLine, startColumn, Number(text.slice(start, offset)));
        } else {
          add('integral', start, startLine, startColumn, Number(text.slice(start, offset)));
        }
      } else {
        add(PUNCTUATION.get(current), start, startLine, startColumn);
      }
      continue;
    }
    if (current === '/') {
      if (peek() !== '/') {
        throw new StlSyntaxError(`unexpected character '/' in ${fileName}`, token('invalid', '/', startLine, startColumn, start));
      }
      advance();
      // SEN treats //-- and // -- as rulers, not descriptions.
      const ruler = (peek() === '-' && peek(1) === '-') || (peek() === ' ' && peek(1) === '-' && peek(2) === '-');
      while (!atEnd() && peek() !== '\n' && peek() !== '\r') advance();
      if (!ruler) {
        const value = text.slice(start + 2, offset).trimStart();
        tokens.push(token('comment', value, startLine, startColumn, start, value));
      }
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      while (!atEnd() && peek() !== quote) advance();
      if (atEnd()) {
        throw new StlSyntaxError(`unterminated string in ${fileName}`, token('string', '', startLine, startColumn, start));
      }
      advance();
      const value = text.slice(start + 1, offset - 1);
      tokens.push(token('string', value, startLine, startColumn, start, value));
      continue;
    }
    if (isDigit(current)) {
      while (isDigit(peek())) advance();
      if (peek() === '.' && isDigit(peek(1))) {
        advance();
        while (isDigit(peek())) advance();
        add('real', start, startLine, startColumn, Number(text.slice(start, offset)));
      } else {
        add('integral', start, startLine, startColumn, Number(text.slice(start, offset)));
      }
      continue;
    }
    if (isAlpha(current)) {
      while (isAlphaNumeric(peek())) advance();
      const lexeme = text.slice(start, offset);
      const type = KEYWORDS.get(lexeme) ?? 'identifier';
      const value = type === 'boolean' ? lexeme === 'true' : lexeme;
      tokens.push(token(type, lexeme, startLine, startColumn, start, value));
      continue;
    }
    throw new StlSyntaxError(`unexpected character '${current}' in ${fileName}`, token('invalid', current, startLine, startColumn, start));
  }
  tokens.push(token('eof', '', line, column, offset));
  return tokens;
}

function descriptionFrom(comments) {
  return comments.map(item => item.value).filter(Boolean).join(' ');
}

class Parser {
  constructor(tokens, fileName) {
    this.tokens = tokens;
    this.fileName = fileName;
    this.current = 0;
  }

  parse() {
    const statements = [];
    while (!this.check('eof')) {
      const comments = this.takeComments();
      if (this.check('eof')) break;
      statements.push(this.attachTrailingDescription(this.declaration(descriptionFrom(comments))));
    }
    return Object.freeze({ kind: 'Program', fileName: this.fileName, statements: Object.freeze(statements) });
  }

  declaration(description) {
    if (this.match('import')) return this.importDeclaration(description);
    if (this.match('package')) return this.packageDeclaration(description);
    if (this.match('struct')) return this.structDeclaration(description);
    if (this.match('enum')) return this.enumDeclaration(description);
    if (this.match('variant')) return this.variantDeclaration(description);
    if (this.match('sequence')) return this.sequenceDeclaration(description, false);
    if (this.match('array')) return this.sequenceDeclaration(description, true);
    if (this.match('quantity')) return this.quantityDeclaration(description);
    if (this.match('alias')) return this.aliasDeclaration(description);
    if (this.match('optional')) return this.optionalDeclaration(description);
    if (this.match('class')) return this.classDeclaration(description, false);
    if (this.match('abstract')) {
      this.consume('class', "expected 'class' after 'abstract'");
      return this.classDeclaration(description, true);
    }
    if (this.match('interface')) return this.interfaceDeclaration(description);
    throw this.error(this.peek(), 'expected STL declaration');
  }

  importDeclaration(description) {
    const file = this.consume('string', 'expected import file name');
    return this.node('ImportDeclaration', file, { description, file: file.value });
  }

  packageDeclaration(description) {
    const first = this.consume('identifier', 'expected package identifier');
    const path = [first.lexeme];
    while (this.match('dot')) path.push(this.consume('identifier', 'expected package identifier').lexeme);
    this.consume('semicolon', "expected ';' after package declaration");
    return this.node('PackageDeclaration', first, { description, path, name: path.join('.') });
  }

  structDeclaration(description) {
    const name = this.typeIdentifier('expected struct name');
    let parent = null;
    if (this.match('colon')) parent = this.typeName('expected parent struct name');
    const fields = [];
    if (!this.match('semicolon')) {
      this.consume('leftBrace', "expected '{' before struct body");
      while (!this.check('rightBrace') && !this.check('eof')) {
        const comments = this.takeComments();
        if (this.check('rightBrace')) break;
        const fieldName = this.memberIdentifier('expected struct field name');
        this.consume('colon', "expected ':' after struct field name");
        const type = this.typeName('expected struct field type');
        let fieldDescription = descriptionFrom(comments);
        fieldDescription = this.appendInlineDescription(fieldDescription, this.previous().line);
        if (this.match('comma')) fieldDescription = this.appendInlineDescription(fieldDescription, this.previous().line);
        else if (!this.check('rightBrace')) throw this.error(this.peek(), 'expected comma after struct field');
        fields.push(this.node('StructField', fieldName, { name: fieldName.lexeme, type, description: fieldDescription }));
      }
      this.consume('rightBrace', "expected '}' after struct body");
    }
    return this.node('StructDeclaration', name, { name: name.lexeme, description, parent, fields });
  }

  enumDeclaration(description) {
    const name = this.typeIdentifier('expected enum name');
    this.consume('colon', "expected ':' after enum name");
    const storageType = this.typeName('expected enum storage type');
    this.consume('leftBrace', "expected '{' before enum body");
    const values = [];
    while (!this.check('rightBrace') && !this.check('eof')) {
      const comments = this.takeComments();
      if (this.check('rightBrace')) break;
      const item = this.memberIdentifier('expected enum value');
      let itemDescription = this.appendInlineDescription(descriptionFrom(comments), item.line);
      if (this.match('comma')) itemDescription = this.appendInlineDescription(itemDescription, this.previous().line);
      else if (!this.check('rightBrace')) throw this.error(this.peek(), 'expected comma after enum value');
      values.push(this.node('EnumValue', item, { name: item.lexeme, description: itemDescription }));
    }
    this.consume('rightBrace', "expected '}' after enum body");
    return this.node('EnumDeclaration', name, { name: name.lexeme, description, storageType, values });
  }

  variantDeclaration(description) {
    const name = this.typeIdentifier('expected variant name');
    this.consume('leftBrace', "expected '{' before variant body");
    const fields = [];
    while (!this.check('rightBrace') && !this.check('eof')) {
      const comments = this.takeComments();
      if (this.check('rightBrace')) break;
      const type = this.typeName('expected variant element type');
      const item = this.previous();
      const fieldDescription = this.appendInlineDescription(descriptionFrom(comments), item.line);
      let descriptionWithComma = fieldDescription;
      if (this.match('comma')) descriptionWithComma = this.appendInlineDescription(descriptionWithComma, this.previous().line);
      else if (!this.check('rightBrace')) throw this.error(this.peek(), 'expected comma after variant element');
      fields.push(this.node('VariantField', item, { type, description: descriptionWithComma }));
    }
    this.consume('rightBrace', "expected '}' after variant body");
    return this.node('VariantDeclaration', name, { name: name.lexeme, description, fields });
  }

  sequenceDeclaration(description, fixedSize) {
    const start = this.consume('less', "expected '<' to start sequence definition");
    const elementType = this.typeName('expected sequence element type');
    let maxSize = null;
    if (this.match('comma')) maxSize = this.consume('integral', 'expected sequence size').value;
    this.consume('greater', "expected '>' after sequence definition");
    const name = this.typeIdentifier('expected sequence type name');
    const attributes = this.attributes(name.lexeme);
    this.consume('semicolon', "expected ';' after sequence declaration");
    if (fixedSize && maxSize === null) throw this.error(start, 'array requires a fixed size');
    return this.node(fixedSize ? 'ArrayDeclaration' : 'SequenceDeclaration', name, {
      name: name.lexeme, description, elementType, maxSize, fixedSize, attributes
    });
  }

  quantityDeclaration(description) {
    const start = this.consume('less', "expected '<' to start quantity definition");
    const elementType = this.typeName('expected quantity numeric type');
    this.consume('comma', "expected ',' after quantity type");
    const unit = this.consume('identifier', 'expected quantity unit');
    this.consume('greater', "expected '>' after quantity definition");
    const name = this.typeIdentifier('expected quantity type name');
    const attributes = this.attributes(name.lexeme);
    this.consume('semicolon', "expected ';' after quantity declaration");
    return this.node('QuantityDeclaration', start, {
      name: name.lexeme, description, elementType, unit: unit.lexeme, attributes
    });
  }

  aliasDeclaration(description) {
    const name = this.typeIdentifier('expected alias name');
    const target = this.typeName('expected aliased type');
    this.consume('semicolon', "expected ';' after alias declaration");
    return this.node('AliasDeclaration', name, { name: name.lexeme, description, target });
  }

  optionalDeclaration(description) {
    const start = this.consume('less', "expected '<' to start optional definition");
    const target = this.typeName('expected optional element type');
    this.consume('greater', "expected '>' after optional definition");
    const name = this.typeIdentifier('expected optional type name');
    this.consume('semicolon', "expected ';' after optional declaration");
    return this.node('OptionalDeclaration', start, { name: name.lexeme, description, target });
  }

  classDeclaration(description, isAbstract) {
    const name = this.typeIdentifier('expected class name');
    const parents = this.parents(name.lexeme);
    const members = this.classMembers(name.lexeme);
    return this.node('ClassDeclaration', name, { name: name.lexeme, description, isAbstract, ...parents, ...members });
  }

  interfaceDeclaration(description) {
    const name = this.typeIdentifier('expected interface name');
    const members = this.classMembers(name.lexeme);
    return this.node('InterfaceDeclaration', name, { name: name.lexeme, description, ...members });
  }

  parents(className) {
    let extendsType = null;
    const implementsTypes = [];
    if (!this.match('colon')) return { extendsType, implementsTypes };
    while (!this.check('leftBrace') && !this.check('eof')) {
      if (this.match('extends')) {
        if (extendsType) throw this.error(this.previous(), `class ${className} cannot extend more than one class`);
        extendsType = this.typeName('expected parent class name');
      } else if (this.match('implements')) {
        implementsTypes.push(this.typeName('expected parent interface name'));
      } else {
        throw this.error(this.peek(), `expected extends or implements for class ${className}`);
      }
      this.match('comma');
    }
    return { extendsType, implementsTypes };
  }

  classMembers(className) {
    this.consume('leftBrace', `expected '{' before ${className} body`);
    const properties = [];
    const methods = [];
    const events = [];
    while (!this.check('rightBrace') && !this.check('eof')) {
      const comments = this.takeComments();
      if (this.check('rightBrace')) break;
      const description = descriptionFrom(comments);
      if (this.match('var')) properties.push(this.attachTrailingDescription(this.propertyDeclaration(description)));
      else if (this.match('fn')) methods.push(this.attachTrailingDescription(this.methodDeclaration(description)));
      else if (this.match('event')) events.push(this.attachTrailingDescription(this.eventDeclaration(description)));
      else throw this.error(this.peek(), 'expected class member');
    }
    this.consume('rightBrace', `expected '}' after ${className} body`);
    return { properties, methods, events };
  }

  propertyDeclaration(description) {
    const name = this.memberIdentifier('expected property name');
    this.consume('colon', "expected ':' after property name");
    const type = this.typeName('expected property type');
    let defaultValue = null;
    if (this.match('equal')) defaultValue = this.literal();
    const attributes = this.attributes(name.lexeme);
    this.consume('semicolon', "expected ';' after property declaration");
    return this.node('PropertyDeclaration', name, { name: name.lexeme, description, type, defaultValue, attributes });
  }

  methodDeclaration(description) {
    const name = this.memberIdentifier('expected method name');
    const args = this.arguments(name.lexeme);
    let returnType = 'void';
    if (this.match('minus')) {
      this.consume('greater', "expected '>' in method return arrow");
      returnType = this.typeName('expected method return type');
    }
    const attributes = this.attributes(name.lexeme);
    this.consume('semicolon', "expected ';' after method declaration");
    return this.node('MethodDeclaration', name, { name: name.lexeme, description, args, returnType, attributes });
  }

  eventDeclaration(description) {
    const name = this.memberIdentifier('expected event name');
    const args = this.arguments(name.lexeme);
    const attributes = this.attributes(name.lexeme);
    this.consume('semicolon', "expected ';' after event declaration");
    return this.node('EventDeclaration', name, { name: name.lexeme, description, args, attributes });
  }

  arguments(owner) {
    this.consume('leftParen', `expected '(' before arguments for ${owner}`);
    const args = [];
    while (!this.check('rightParen') && !this.check('eof')) {
      const comments = this.takeComments();
      const name = this.memberIdentifier('expected argument name');
      this.consume('colon', "expected ':' after argument name");
      const type = this.typeName('expected argument type');
      args.push(this.node('ArgumentDeclaration', name, { name: name.lexeme, type, description: descriptionFrom(comments) }));
      if (!this.match('comma')) break;
    }
    this.consume('rightParen', `expected ')' after arguments for ${owner}`);
    return args;
  }

  attributes(subject) {
    if (!this.match('leftBracket')) return [];
    const attributes = [];
    while (!this.check('rightBracket') && !this.check('eof')) {
      const name = this.consume('identifier', `expected attribute name for ${subject}`);
      let value = true;
      if (this.match('colon')) {
        if (this.check('identifier')) value = this.advance().lexeme;
        else value = this.literal();
      }
      attributes.push({ name: name.lexeme, value, location: this.nodeLocation(name) });
      if (!this.match('comma')) break;
    }
    this.consume('rightBracket', `expected ']' after attributes for ${subject}`);
    return attributes;
  }

  literal() {
    if (this.match('integral', 'real', 'string', 'boolean')) return this.previous().value;
    throw this.error(this.peek(), 'expected literal');
  }

  typeName(message) {
    const first = this.consume('identifier', message);
    const path = [first.lexeme];
    while (this.match('dot')) path.push(this.consume('identifier', message).lexeme);
    return path.join('.');
  }

  typeIdentifier(message) {
    const item = this.consume('identifier', message);
    if (!TYPE_NAME_RE.test(item.lexeme)) throw this.error(item, `invalid type name '${item.lexeme}'`);
    return item;
  }

  memberIdentifier(message) {
    const item = this.consume('identifier', message);
    if (!MEMBER_NAME_RE.test(item.lexeme)) throw this.error(item, `invalid member name '${item.lexeme}'`);
    return item;
  }

  optionalSeparator(end, message) {
    if (this.match('comma')) return;
    if (!this.check(end)) throw this.error(this.peek(), message);
  }

  takeComments() {
    const comments = [];
    while (this.check('comment')) comments.push(this.advance());
    return comments;
  }

  appendInlineDescription(description, line) {
    const comments = [];
    while (this.check('comment') && this.peek().line === line) comments.push(this.advance());
    const inline = descriptionFrom(comments);
    return description && inline ? `${description} ${inline}` : description || inline;
  }

  attachTrailingDescription(declaration) {
    if (this.previous().type !== 'semicolon') return declaration;
    const description = this.appendInlineDescription(declaration.description, this.previous().line);
    return description === declaration.description ? declaration : Object.freeze({ ...declaration, description });
  }

  node(kind, item, properties) {
    return Object.freeze({ kind, ...properties, location: this.nodeLocation(item) });
  }

  nodeLocation(item) {
    return location(item.line, item.column, item.offset);
  }

  match(...types) {
    if (!types.some(type => this.check(type))) return false;
    this.advance();
    return true;
  }

  consume(type, message) {
    if (this.check(type)) return this.advance();
    throw this.error(this.peek(), message);
  }

  check(type) { return this.peek().type === type; }
  advance() { if (!this.check('eof')) this.current += 1; return this.previous(); }
  peek() { return this.tokens[this.current]; }
  previous() { return this.tokens[this.current - 1]; }
  error(item, message) { return new StlSyntaxError(`${message} in ${this.fileName}`, item); }
}

/** Parses STL source text into a transport-independent AST. */
export function parseStl(source, options = {}) {
  const fileName = options.fileName ?? '<memory>';
  return new Parser(tokenizeStl(source, fileName), fileName).parse();
}

function declarationName(declaration) {
  return declaration.name;
}

function qualifiedName(packageName, name) {
  return `${packageName}.${name}`;
}

function attribute(declaration, name) {
  return declaration.attributes?.find(item => item.name === name);
}

function resolveTransport(attributes, defaultMode, node) {
  let mode = defaultMode;
  let hasTransport = false;
  for (const item of attributes) {
    if (item.name !== 'confirmed' && item.name !== 'bestEffort') continue;
    if (item.value !== true || hasTransport) throw new StlResolutionError(`invalid or repeated transport attribute '${item.name}'`, node);
    hasTransport = true;
    mode = item.name === 'bestEffort' ? 'unicast' : 'confirmed';
  }
  return mode;
}

function builtInType(name) {
  return PRIMITIVES.has(name) ? { kind: 'PrimitiveType', name, qualifiedName: name } : null;
}

function numericSpec(name) {
  if (INTEGRAL_TYPES.has(name)) {
    const integral = { i8: 'int8Type', u8: 'uint8Type', i16: 'int16Type', u16: 'uint16Type', i32: 'int32Type', u32: 'uint32Type', i64: 'int64Type', u64: 'uint64Type' };
    return { type: 'IntegralType', value: integral[name] };
  }
  if (name === 'f32') return { type: 'RealType', value: 'float32Type' };
  if (name === 'f64') return { type: 'RealType', value: 'float64Type' };
  return null;
}

const unit = (name, abbreviation, category) => [abbreviation, { name, abbreviation, category }];

// Mirror UnitRegistry::UnitRegistry. Conversion factors are not serialized in
// SEN TypeSpecs, so the TypeSpec adapter only needs this transport-visible data.
const DEFAULT_UNITS = new Map([
  unit('meter', 'm', 'length'), unit('second', 's', 'time'), unit('radian', 'rad', 'angle'),
  unit('kelvin', 'k', 'temperature'), unit('gram', 'g', 'mass'),
  unit('radians_per_second', 'rad_per_s', 'angularVelocity'),
  unit('grams_per_centimeters_cube', 'g_per_cm3', 'density'), unit('pascals', 'pa', 'pressure'),
  unit('square_meter', 'm_sq', 'area'), unit('newton', 'nw', 'force'),
  unit('hertz', 'hz', 'frequency'), unit('meters_per_second', 'm_per_s', 'velocity'),
  unit('decimeters_per_second', 'dm_per_s', 'velocity'),
  unit('meters_per_second_squared', 'm_per_s_sq', 'acceleration'),
  unit('radians_per_second_squared', 'rad_per_s_sq', 'angularAcceleration'),
  unit('min', 'min', 'time'), unit('hour', 'hour', 'time'), unit('day', 'day', 'time'),
  unit('week', 'week', 'time'), unit('month', 'month', 'time'), unit('year', 'year', 'time'),
  unit('newton_meter', 'Nm', 'torque'), unit('foot', 'ft', 'length'), unit('mile', 'mi', 'length'),
  unit('nauticalMile', 'nmi', 'length'), unit('degree', 'deg', 'angle'),
  unit('arcminute', 'arcmin', 'angle'), unit('arcsecond', 'arcsec', 'angle'),
  unit('centigrade', 'degC', 'temperature'), unit('fahrenheit', 'degF', 'temperature'),
  unit('km_per_hour', 'kph', 'velocity'), unit('miles_per_hour', 'mph', 'velocity'),
  unit('knot', 'kn', 'velocity'), unit('feet_per_second', 'ft_per_s', 'velocity'),
  unit('feet_per_minute', 'ft_per_min', 'velocity'),
  unit('degrees_per_second', 'deg_per_s', 'angularVelocity'),
  unit('revolutions_per_min', 'rpm', 'angularVelocity'), unit('pound', 'lb', 'mass'),
  unit('kilograms_per_meters_cube', 'kg_per_m3', 'density')
]);

function makeConstructor(type, typeByName) {
  const args = [];
  const seen = new Set();
  const collect = item => {
    if (item.parent) collect(typeByName.get(item.parent));
    for (const property of item.properties ?? []) {
      if (property.category === 'staticRW') args.push({ name: property.name, description: property.description, type: property.type });
    }
  };
  const safeCollect = item => {
    if (!item || seen.has(item.qualifiedName)) return;
    seen.add(item.qualifiedName);
    collect(item);
  };
  safeCollect(type);
  return { name: `constructor${type.name}`, description: 'constructor', args, returnType: 'void' };
}

/** A resolved, immutable STL type registry. */
export class StlTypeRegistry {
  constructor(typeByName, files) {
    this.typeByName = new Map(typeByName);
    this.files = new Map(files);
    Object.freeze(this);
  }

  get(name) { return this.typeByName.get(name); }
  has(name) { return this.typeByName.has(name); }
  values() { return this.typeByName.values(); }

  /** Converts all resolved custom types to sen-ether-client CustomTypeSpecs. */
  toTypeSpecs(options = {}) {
    const units = new Map(DEFAULT_UNITS);
    for (const item of options.units ?? []) units.set(item.abbreviation, item);
    const result = new Map();
    for (const type of this.typeByName.values()) {
      const base = { name: type.name, qualifiedName: type.qualifiedName, description: type.description ?? '' };
      let data;
      switch (type.kind) {
        case 'StructType':
          data = { type: 'StructTypeSpec', value: { fields: type.fields.map(field => ({ name: field.name, description: field.description, type: field.type })), parent: type.parent ?? '' } };
          break;
        case 'EnumType':
          data = { type: 'EnumTypeSpec', value: { storageType: numericSpec(type.storageType)?.value, enums: type.values.map((item, key) => ({ name: item.name, key, description: item.description })) } };
          break;
        case 'VariantType':
          data = { type: 'VariantTypeSpec', value: { fields: type.fields.map((item, key) => ({ key, description: item.description, type: item.type })) } };
          break;
        case 'SequenceType':
          data = { type: 'SequenceTypeSpec', value: { elementType: type.elementType, maxSize: type.maxSize, fixedSize: type.fixedSize } };
          break;
        case 'AliasType':
          data = { type: 'AliasTypeSpec', value: { aliasedType: type.target } };
          break;
        case 'OptionalType':
          data = { type: 'OptionalTypeSpec', value: { type: type.target } };
          break;
        case 'QuantityType': {
          const unit = units.get(type.unit);
          if (!unit) throw new StlResolutionError(`unknown SEN unit '${type.unit}' while adapting ${type.qualifiedName}`);
          data = { type: 'QuantityTypeSpec', value: { elementType: numericSpec(type.elementType), unit, minValue: type.minValue, maxValue: type.maxValue } };
          break;
        }
        case 'ClassType':
          data = { type: 'ClassTypeSpec', value: {
            properties: type.properties.map(({ name, description, type: propertyType, category, transportMode, tags, checkedSet }) => ({ name, description, type: propertyType, category, transportMode, tags, checkedSet })),
            methods: type.methods.map(({ name, description, args, transportMode, constness, deferred, returnType, localOnly }) => ({ name, description, args, transportMode, constness, deferred, returnType, propertyRelation: 'nonPropertyRelated', localOnly })),
            events: type.events.map(({ name, description, args, transportMode }) => ({ name, description, args, transportMode })),
            constructor: makeConstructor(type, this.typeByName),
            parents: type.parents,
            isInterface: false
          } };
          break;
        default:
          throw new StlResolutionError(`cannot adapt ${type.kind} '${type.qualifiedName}' to TypeSpec`);
      }
      result.set(type.qualifiedName, { ...base, data });
    }
    return result;
  }
}

class Resolver {
  constructor(options) {
    this.sources = options.sources instanceof Map ? options.sources : new Map(Object.entries(options.sources ?? {}));
    this.load = options.load;
    this.typeByName = new Map();
    this.files = new Map();
    this.resolving = new Set();
  }

  resolve(entries) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) this.resolveFile(entry);
    return new StlTypeRegistry(this.typeByName, this.files);
  }

  sourceFor(fileName, fromFile) {
    if (this.sources.has(fileName)) return { fileName, source: this.sources.get(fileName) };
    if (this.load) {
      const loaded = this.load(fileName, fromFile);
      if (typeof loaded === 'string') return { fileName, source: loaded };
      if (loaded && typeof loaded.source === 'string' && loaded.fileName) return loaded;
    }
    throw new StlResolutionError(`could not find STL file '${fileName}'`);
  }

  resolveFile(requestedFileName, fromFile) {
    const loaded = this.sourceFor(requestedFileName, fromFile);
    const fileName = loaded.fileName;
    if (this.files.has(fileName)) return this.files.get(fileName);
    if (this.resolving.has(fileName)) return this.files.get(fileName);
    this.resolving.add(fileName);
    const file = { fileName, packageName: '', imports: [], types: new Map() };
    this.files.set(fileName, file);
    const program = parseStl(loaded.source, { fileName });
    for (const statement of program.statements) {
      if (statement.kind === 'ImportDeclaration') file.imports.push(this.resolveFile(statement.file, fileName));
      else if (statement.kind === 'PackageDeclaration') {
        if (file.packageName) throw new StlResolutionError(`package is already defined as '${file.packageName}'`, statement);
        file.packageName = statement.name;
      } else this.resolveDeclaration(statement, file);
    }
    this.resolving.delete(fileName);
    return file;
  }

  resolveDeclaration(statement, file) {
    if (!file.packageName) throw new StlResolutionError('please specify the package before defining a type', statement);
    if (statement.kind === 'InterfaceDeclaration') {
      // This follows the current official resolver, rather than pretending that
      // parser support means the type is usable by SEN.
      throw new StlResolutionError('STL interfaces are not supported', statement);
    }
    const name = declarationName(statement);
    const qualified = qualifiedName(file.packageName, name);
    if (file.types.has(name) || this.typeByName.has(qualified)) throw new StlResolutionError(`there is already a type named '${qualified}'`, statement);
    const add = value => {
      const resolved = Object.freeze({ ...value, name, qualifiedName: qualified, description: statement.description ?? '', fileName: file.fileName });
      file.types.set(name, resolved);
      this.typeByName.set(qualified, resolved);
    };
    const valueType = (type, node) => this.resolveType(type, file, node, 'value');
    const classType = (type, node) => this.resolveType(type, file, node, 'class');

    switch (statement.kind) {
      case 'StructDeclaration':
        if (statement.parent) {
          const parent = this.findResolvedType(valueType(statement.parent, statement));
          if (parent?.kind !== 'StructType') throw new StlResolutionError(`parent of struct '${name}' is not a struct`, statement);
        }
        add({ kind: 'StructType', parent: statement.parent ? valueType(statement.parent, statement) : null,
          fields: statement.fields.map(field => ({ name: field.name, description: field.description, type: valueType(field.type, field) })) });
        break;
      case 'EnumDeclaration': {
        const storageType = valueType(statement.storageType, statement);
        if (!INTEGRAL_TYPES.has(storageType)) throw new StlResolutionError(`enum storage type '${storageType}' is not integral`, statement);
        add({ kind: 'EnumType', storageType, values: statement.values });
        break;
      }
      case 'VariantDeclaration': {
        const fields = statement.fields.map(field => ({ description: field.description, type: valueType(field.type, field) }));
        if (new Set(fields.map(field => field.type)).size !== fields.length) throw new StlResolutionError(`variant '${name}' contains the same type more than once`, statement);
        add({ kind: 'VariantType', fields });
        break;
      }
      case 'SequenceDeclaration':
      case 'ArrayDeclaration':
        add({ kind: 'SequenceType', elementType: valueType(statement.elementType, statement), maxSize: statement.maxSize, fixedSize: statement.fixedSize });
        break;
      case 'QuantityDeclaration': {
        const elementType = valueType(statement.elementType, statement);
        if (!NUMERIC_TYPES.has(elementType)) throw new StlResolutionError(`quantity element type '${elementType}' is not numeric`, statement);
        if (!DEFAULT_UNITS.has(statement.unit)) throw new StlResolutionError(`unknown SEN unit '${statement.unit}'`, statement);
        for (const attr of statement.attributes) {
          if (!['min', 'max'].includes(attr.name) || typeof attr.value !== 'number') {
            throw new StlResolutionError(`invalid quantity attribute '${attr.name}'`, statement);
          }
        }
        const min = attribute(statement, 'min')?.value;
        const max = attribute(statement, 'max')?.value;
        add({ kind: 'QuantityType', elementType, unit: statement.unit, minValue: min ?? null, maxValue: max ?? null });
        break;
      }
      case 'AliasDeclaration': add({ kind: 'AliasType', target: valueType(statement.target, statement) }); break;
      case 'OptionalDeclaration': add({ kind: 'OptionalType', target: valueType(statement.target, statement) }); break;
      case 'ClassDeclaration': {
        const parent = statement.extendsType ? classType(statement.extendsType, statement) : null;
        const interfaces = statement.implementsTypes.map(item => classType(item, statement));
        if (interfaces.length) throw new StlResolutionError(`STL interfaces are not supported`, statement);
        add({ kind: 'ClassType', isAbstract: statement.isAbstract, parent, parents: [parent, ...interfaces].filter(Boolean),
          properties: statement.properties.map(item => this.resolveProperty(item, file)),
          methods: statement.methods.map(item => this.resolveMethod(item, file)),
          events: statement.events.map(item => this.resolveEvent(item, file)) });
        break;
      }
      default: throw new StlResolutionError(`unsupported STL declaration '${statement.kind}'`, statement);
    }
  }

  resolveType(name, file, node, expectedKind) {
    if (name === 'void') return 'void';
    const primitive = builtInType(name);
    if (primitive) {
      if (expectedKind === 'class') throw new StlResolutionError(`'${name}' is not a class type`, node);
      return name;
    }
    let result;
    if (name.includes('.')) result = this.typeByName.get(name);
    else {
      result = file.types.get(name);
      if (!result) {
        for (const imported of file.imports) {
          if (imported.packageName === file.packageName) result = imported.types.get(name);
          if (result) break;
          const common = file.packageName.split('.').filter((part, index) => imported.packageName.split('.')[index] === part).join('.');
          if (common) result = this.typeByName.get(`${common}.${name}`);
          if (result) break;
        }
      }
    }
    if (!result) throw new StlResolutionError(`type '${name}' not found`, node);
    if (expectedKind === 'class' && result.kind !== 'ClassType') throw new StlResolutionError(`'${name}' is not a class type`, node);
    if (expectedKind === 'value' && result.kind === 'ClassType') throw new StlResolutionError(`'${name}' is not a value type`, node);
    return result.qualifiedName;
  }

  findResolvedType(name) {
    return this.typeByName.get(name);
  }

  resolveProperty(item, file) {
    const transportMode = resolveTransport(item.attributes, 'multicast', item);
    const categories = ['static', 'static_no_config', 'writable'].filter(name => attribute(item, name));
    if (categories.length > 1) throw new StlResolutionError(`invalid property category attributes for '${item.name}'`, item);
    const category = categories[0] === 'static' ? 'staticRW' : categories[0] === 'static_no_config' ? 'staticRO' : categories[0] === 'writable' ? 'dynamicRW' : 'dynamicRO';
    for (const attr of item.attributes) {
      if (['confirmed', 'bestEffort', 'static', 'static_no_config', 'writable', 'checked', 'tag'].includes(attr.name)) continue;
      throw new StlResolutionError(`invalid property attribute '${attr.name}'`, item);
    }
    const type = this.resolveType(item.type, file, item, 'value');
    return Object.freeze({ name: item.name, description: item.description, type, category, transportMode,
      tags: item.attributes.filter(attr => attr.name === 'tag').map(attr => String(attr.value)), checkedSet: Boolean(attribute(item, 'checked')) });
  }

  resolveMethod(item, file) {
    for (const attr of item.attributes) {
      if (!['confirmed', 'bestEffort', 'const', 'deferred', 'local'].includes(attr.name) || attr.value !== true) throw new StlResolutionError(`invalid method attribute '${attr.name}'`, item);
    }
    return Object.freeze({ name: item.name, description: item.description, args: item.args.map(arg => ({ name: arg.name, description: arg.description, type: this.resolveType(arg.type, file, arg, 'value') })),
      returnType: this.resolveType(item.returnType, file, item, 'value'), transportMode: resolveTransport(item.attributes, 'confirmed', item),
      constness: attribute(item, 'const') ? 'constant' : 'nonConstant', deferred: Boolean(attribute(item, 'deferred')), localOnly: Boolean(attribute(item, 'local')) });
  }

  resolveEvent(item, file) {
    for (const attr of item.attributes) {
      if (!['confirmed', 'bestEffort'].includes(attr.name) || attr.value !== true) throw new StlResolutionError(`invalid event attribute '${attr.name}'`, item);
    }
    return Object.freeze({ name: item.name, description: item.description, args: item.args.map(arg => ({ name: arg.name, description: arg.description, type: this.resolveType(arg.type, file, arg, 'value') })),
      transportMode: resolveTransport(item.attributes, 'multicast', item) });
  }
}

/**
 * Resolves an STL source graph once. `sources` is a record or Map keyed by the
 * exact entry/import string; `load(name)` is an optional synchronous fallback.
 */
export function resolveStl(entry, options = {}) {
  if (!entry || (Array.isArray(entry) && !entry.length)) throw new TypeError('an STL entry file name is required');
  return new Resolver(options).resolve(entry);
}
