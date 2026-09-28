/**
 * @fileoverview Filesystem-free tokenizer and recursive-descent parser for STL.
 *
 * The parser returns source-located declarations and performs syntax validation
 * only. Import loading, name resolution and TypeSpec adaptation are separate.
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


const TYPE_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
const MEMBER_NAME_RE = /^[a-z][A-Za-z0-9_]*$/;

export class StlSyntaxError extends Error {
    constructor(message, token) {
        super(`${message}${token ? ` at ${token.line}:${token.column}` : ''}`);
        this.name = 'StlSyntaxError';
        this.location = token ? { line: token.line, column: token.column, offset: token.offset } : undefined;
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

