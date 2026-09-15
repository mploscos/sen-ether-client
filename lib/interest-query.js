/** Compile queries for objects published by this JavaScript client, without eval. */
export function compileInterestQuery(query) {
  const match = /^\s*SELECT\s+(\*|[\w.]+)\s+FROM\s+([\w.-]+)(?:\s+WHERE\s+([\s\S]+?))?\s*;?\s*$/i.exec(query);
  if (!match) throw new SyntaxError(`Invalid SEN interest query: ${query}`);
  const [, className, , where] = match;
  const predicate = where ? compileExpression(where) : () => true;
  return (object, types) => (className === '*' || isClass(object.spec, className, types)) && Boolean(predicate(object));
}

function isClass(spec, name, types, seen = new Set()) {
  if (!spec || seen.has(spec.qualifiedName)) return false;
  if (spec.qualifiedName === name) return true;
  seen.add(spec.qualifiedName);
  return (spec.data?.value?.parents ?? []).some(parent => isClass(types.get(parent), name, types, seen));
}

const binary = {
  OR: [1, (a, b) => Boolean(a) || Boolean(b)],
  AND: [2, (a, b) => Boolean(a) && Boolean(b)],
  '=': [3, (a, b) => a === b], '==': [3, (a, b) => a === b],
  '!=': [3, (a, b) => a !== b], '<>': [3, (a, b) => a !== b],
  '<': [3, (a, b) => a < b], '>': [3, (a, b) => a > b],
  '<=': [3, (a, b) => a <= b], '>=': [3, (a, b) => a >= b],
  '+': [4, (a, b) => a + b], '-': [4, (a, b) => a - b],
  '*': [5, (a, b) => a * b], '/': [5, (a, b) => a / b], '%': [5, (a, b) => a % b]
};

function compileExpression(source) {
  const tokens = [];
  const pattern = /\s*(?:("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)|(==|!=|<>|<=|>=|[=<>+*/%(),!-]))/gy;
  let offset = 0;
  while (offset < source.trimEnd().length) {
    pattern.lastIndex = offset;
    const token = pattern.exec(source);
    if (!token) throw new SyntaxError(`Unsupported SEN WHERE expression near: ${source.slice(offset)}`);
    offset = pattern.lastIndex;
    if (token[1]) {
      const value = token[1].slice(1, -1).replace(/\\([\\"'nrt])/g, (_, c) => ({n:'\n', r:'\r', t:'\t'}[c] ?? c));
      tokens.push({value});
    } else if (token[2]) tokens.push({value:Number(token[2])});
    else if (token[3] && !/^(AND|OR|NOT|IN|TRUE|FALSE)$/i.test(token[3])) tokens.push({path:token[3].split('.')});
    else tokens.push({op:(token[3] ?? token[4]).toUpperCase()});
  }
  let index = 0;
  const peek = () => tokens[index]?.op;
  const take = op => { if (peek() !== op) throw new SyntaxError(`Expected ${op} in SEN WHERE`); index++; };
  function expression(min = 0) {
    const token = tokens[index++];
    if (!token) throw new SyntaxError('Incomplete SEN WHERE expression');
    let left;
    if ('value' in token) left = () => token.value;
    else if (token.path) {
      const [key] = token.path;
      left = object => token.path.length === 1 && key === 'name'
        ? object[key]
        : token.path.reduce((value, field) => value != null && Object.hasOwn(value, field) ? value[field] : undefined, object.state);
    }
    else if (token.op === '(') { left = expression(); take(')'); }
    else if (token.op === 'TRUE' || token.op === 'FALSE') left = () => token.op === 'TRUE';
    else if (['NOT', '!', '-', '+'].includes(token.op)) {
      const right = expression(token.op === 'NOT' ? 3 : 6);
      left = state => token.op === '-' ? -right(state) : token.op === '+' ? +right(state) : !right(state);
    } else throw new SyntaxError(`Unexpected ${token.op} in SEN WHERE`);
    while (index < tokens.length) {
      const op = peek();
      if (op === 'IN' && min <= 3) {
        index++; take('(');
        const values = [expression()];
        while (peek() === ',') { index++; values.push(expression()); }
        take(')');
        const previous = left;
        left = state => values.some(value => value(state) === previous(state));
        continue;
      }
      const operator = binary[op];
      if (!operator || operator[0] < min) break;
      index++;
      const right = expression(operator[0] + 1);
      const previous = left;
      left = state => {
        const a = previous(state);
        if (op === 'AND' && !a) return false;
        if (op === 'OR' && a) return true;
        const b = right(state);
        return a !== undefined && b !== undefined && operator[1](a, b);
      };
    }
    return left;
  }
  const result = expression();
  if (index !== tokens.length) throw new SyntaxError('Unsupported SEN WHERE expression');
  return result;
}
