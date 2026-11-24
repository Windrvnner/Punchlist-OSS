// Validate glob options as data before Vite sees the original syntax. Never invoke functions from the source.
import { unwrapped } from './pane-of-glass-syntax.mjs';

const binary = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
  '%': (a, b) => a % b, '**': (a, b) => a ** b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, in: (a, b) => a in b,
  // biome-ignore lint/suspicious/noDoubleEquals: Glob expressions follow JavaScript's equality operators.
  '==': (a, b) => a == b,
  // biome-ignore lint/suspicious/noDoubleEquals: Glob expressions follow JavaScript's equality operators.
  '!=': (a, b) => a != b,
};
const unary = {
  '+': (value) => +value, '-': (value) => -value, '!': (value) => !value, '~': (value) => ~value,
  typeof: (value) => typeof value, void: () => undefined,
};

const logical = {
  '&&': (left, right) => left() && right(), '||': (left, right) => left() || right(),
  '??': (left, right) => left() ?? right(),
};

function keyReader(node, key) {
  if (node.computed) return dataReader(key);
  return () => key.type === 'Identifier' ? key.name : key.value;
}

function recordReader(properties) {
  let prototype;
  const fields = properties.map((part) => {
    if (part.type === 'SpreadElement') {
      const read = dataReader(part.argument);
      return () => Object.entries({ ...read() });
    }
    if (part.kind !== 'init' || part.method) throw new Error('Non-data property');
    const key = keyReader(part, part.key);
    const read = dataReader(part.value);
    if (!part.computed && key() === '__proto__') {
      prototype = read;
      return () => [];
    }
    return () => [[key(), read()]];
  });
  return () => {
    const record = Object.fromEntries(fields.flatMap((field) => field()));
    if (!prototype) return record;
    const base = prototype();
    // The prototype is itself checked data. Member lookups still require an own property.
    if (base === null || typeof base === 'object') return Object.setPrototypeOf(record, base);
    // JavaScript ignores a primitive supplied as an object literal's prototype.
    return record;
  };
}

function arrayReader(elements) {
  const readers = elements.map((part) => part && dataReader(part.type === 'SpreadElement' ? part.argument : part));
  return () => {
    const items = [];
    for (const [index, read] of readers.entries()) {
      if (!read) items.length++;
      else if (elements[index].type === 'SpreadElement') items.push(...read());
      else items.push(read());
    }
    return items;
  };
}

const shortCircuit = Symbol('optional chain');
const primitiveGlobals = { undefined, NaN, Infinity };

function memberReader(node) {
  const receiver = dataReader(node.object);
  const property = keyReader(node, node.property);
  return () => {
    const owner = receiver();
    if (owner === shortCircuit || (node.optional && (owner === null || owner === undefined))) return shortCircuit;
    const key = property();
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value;
    if (!(key in Object(owner))) return undefined;
    throw new Error('Expected an own data property');
  };
}

// Check the syntax of every branch. Read only the chosen values, as JavaScript does for &&, ||, ?? and ?:.
function dataReader(expression) {
  const node = unwrapped(expression, 'ChainExpression');
  switch (node.type) {
    case 'Identifier':
      if (!Object.hasOwn(primitiveGlobals, node.name)) break;
      return () => primitiveGlobals[node.name];
    case 'Literal':
      if (node.regex) break;
      return () => node.value;
    case 'ObjectExpression':
      return recordReader(node.properties);
    case 'ArrayExpression':
      return arrayReader(node.elements);
    case 'MemberExpression':
      return memberReader(node);
    case 'ChainExpression': {
      const read = dataReader(node.expression);
      return () => {
        const value = read();
        return value === shortCircuit ? undefined : value;
      };
    }
    case 'TemplateLiteral': {
      const raw = node.quasis.map((part) => part.value.cooked);
      const values = node.expressions.map(dataReader);
      return () => String.raw({ raw }, ...values.map((read) => read()));
    }
    case 'UnaryExpression': {
      const read = dataReader(node.argument);
      if (!Object.hasOwn(unary, node.operator)) break;
      return () => unary[node.operator](read());
    }
    case 'LogicalExpression':
    case 'BinaryExpression': {
      const left = dataReader(node.left);
      const right = dataReader(node.right);
      if (node.type === 'LogicalExpression') return () => logical[node.operator](left, right);
      if (!Object.hasOwn(binary, node.operator)) break;
      return () => binary[node.operator](left(), right());
    }
    case 'ConditionalExpression': {
      const [test, yes, no] = [node.test, node.consequent, node.alternate].map(dataReader);
      return () => test() ? yes() : no();
    }
  }
  throw new Error('Expected literal data');
}

export function dataOptions(node) {
  if (node.type !== 'ObjectExpression') return false;
  try {
    dataReader(node)();
    return true;
  } catch {
    return false;
  }
}
