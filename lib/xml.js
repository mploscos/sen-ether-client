/**
 * Small, dependency-free XML reader for SEN/HLA interface documents.
 *
 * It intentionally exposes only the tree operations needed by the FOM loader.
 * XML namespaces are matched by local name so IEEE OMT documents work with or
 * without a default namespace.
 */

export class XmlSyntaxError extends Error {
  constructor(message, fileName = '<xml>', offset = 0) {
    super(`${message} in ${fileName} at offset ${offset}`);
    this.name = 'XmlSyntaxError';
    this.fileName = fileName;
    this.offset = offset;
  }
}

function localName(name) {
  const separator = name.indexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

function decodeEntities(value) {
  return value.replace(/&(?:#x([\da-f]+)|#(\d+)|([a-z]+));/gi, (match, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' })[named] ?? match;
  });
}

export class XmlElement {
  constructor(name, attributes = {}, parent = null) {
    this.name = localName(name);
    this.attributes = Object.freeze(attributes);
    this.parent = parent;
    this.children = [];
    this.textParts = [];
  }

  child(name) { return this.children.find(item => item.name === name); }
  childrenNamed(name) { return this.children.filter(item => item.name === name); }
  childText(name) { return this.child(name)?.text() ?? ''; }
  attribute(name) { return this.attributes[name]; }
  text() { return this.textParts.join('').trim(); }

  descendants(name) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (!name || child.name === name) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

function parseTag(text, fileName, offset) {
  let cursor = 0;
  const skipSpace = () => { while (/\s/.test(text[cursor] ?? '')) cursor += 1; };
  const readName = () => {
    const start = cursor;
    while (/[^\s=/>]/.test(text[cursor] ?? '')) cursor += 1;
    return text.slice(start, cursor);
  };
  skipSpace();
  const name = readName();
  if (!name) throw new XmlSyntaxError('expected element name', fileName, offset);
  const attributes = {};
  while (cursor < text.length) {
    skipSpace();
    if (cursor >= text.length) break;
    const attributeName = localName(readName());
    skipSpace();
    if (text[cursor] !== '=') throw new XmlSyntaxError(`expected '=' after attribute '${attributeName}'`, fileName, offset + cursor);
    cursor += 1;
    skipSpace();
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") throw new XmlSyntaxError(`expected quoted value for attribute '${attributeName}'`, fileName, offset + cursor);
    const start = ++cursor;
    while (cursor < text.length && text[cursor] !== quote) cursor += 1;
    if (cursor >= text.length) throw new XmlSyntaxError(`unterminated attribute '${attributeName}'`, fileName, offset + start);
    attributes[attributeName] = decodeEntities(text.slice(start, cursor));
    cursor += 1;
  }
  return { name, attributes };
}

/** Parses XML into a lightweight immutable-name element tree. */
export function parseXml(source, options = {}) {
  const text = String(source ?? '');
  const fileName = options.fileName ?? '<xml>';
  const document = new XmlElement('#document');
  const stack = [document];
  let offset = 0;

  const appendText = value => {
    if (value) stack.at(-1).textParts.push(decodeEntities(value));
  };

  while (offset < text.length) {
    const opening = text.indexOf('<', offset);
    if (opening < 0) {
      appendText(text.slice(offset));
      break;
    }
    appendText(text.slice(offset, opening));

    if (text.startsWith('<!--', opening)) {
      const end = text.indexOf('-->', opening + 4);
      if (end < 0) throw new XmlSyntaxError('unterminated comment', fileName, opening);
      offset = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', opening)) {
      const end = text.indexOf(']]>', opening + 9);
      if (end < 0) throw new XmlSyntaxError('unterminated CDATA section', fileName, opening);
      stack.at(-1).textParts.push(text.slice(opening + 9, end));
      offset = end + 3;
      continue;
    }
    if (text.startsWith('<?', opening)) {
      const end = text.indexOf('?>', opening + 2);
      if (end < 0) throw new XmlSyntaxError('unterminated processing instruction', fileName, opening);
      offset = end + 2;
      continue;
    }
    if (text.startsWith('<!', opening)) {
      let cursor = opening + 2;
      let bracketDepth = 0;
      let quote = '';
      while (cursor < text.length) {
        const char = text[cursor];
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '[') bracketDepth += 1;
        else if (char === ']') bracketDepth -= 1;
        else if (char === '>' && bracketDepth === 0) break;
        cursor += 1;
      }
      if (cursor >= text.length) throw new XmlSyntaxError('unterminated declaration', fileName, opening);
      offset = cursor + 1;
      continue;
    }

    let cursor = opening + 1;
    let quote = '';
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      cursor += 1;
    }
    if (cursor >= text.length) throw new XmlSyntaxError('unterminated element', fileName, opening);

    const raw = text.slice(opening + 1, cursor).trim();
    if (raw.startsWith('/')) {
      const closingName = localName(raw.slice(1).trim());
      const current = stack.pop();
      if (current === document || current.name !== closingName) {
        throw new XmlSyntaxError(`unexpected closing element '${closingName}'`, fileName, opening);
      }
    } else {
      const selfClosing = raw.endsWith('/');
      const parsed = parseTag(selfClosing ? raw.slice(0, -1) : raw, fileName, opening + 1);
      const element = new XmlElement(parsed.name, parsed.attributes, stack.at(-1));
      stack.at(-1).children.push(element);
      if (!selfClosing) stack.push(element);
    }
    offset = cursor + 1;
  }

  if (stack.length !== 1) throw new XmlSyntaxError(`unclosed element '${stack.at(-1).name}'`, fileName, text.length);
  if (document.children.length !== 1) throw new XmlSyntaxError('expected one document element', fileName, 0);
  return document.children[0];
}
