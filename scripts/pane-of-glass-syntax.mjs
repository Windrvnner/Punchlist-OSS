// Assertions, parentheses and optional chains leave the underlying path or member unchanged.
export function unwrapped(node) {
  while (['TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression',
    'ChainExpression', 'ParenthesizedExpression'].includes(node?.type)) {
    node = node.expression;
  }
  return node;
}

export function literalValue(expression) {
  const node = unwrapped(expression);
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
}

export const missing = Symbol('missing literal entry');
const unknown = Symbol('runtime operand');

// These operators receive only primitive literals, so no coercion can call application code.
const binary = new Map([
  ['+', (left, right) => left + right],
  ['-', (left, right) => left - right],
  ['*', (left, right) => left * right],
  ['/', (left, right) => left / right],
  ['%', (left, right) => left % right],
  ['===', (left, right) => left === right],
  ['!==', (left, right) => left !== right],
  // biome-ignore lint/suspicious/noDoubleEquals: The source expression uses JavaScript's coercing equality.
  ['==', (left, right) => left == right],
  // biome-ignore lint/suspicious/noDoubleEquals: The source expression uses JavaScript's coercing inequality.
  ['!=', (left, right) => left != right],
  ['<', (left, right) => left < right],
  ['<=', (left, right) => left <= right],
  ['>', (left, right) => left > right],
  ['>=', (left, right) => left >= right],
]);

function literalBinary(node, operand) {
  const operation = binary.get(node.operator);
  if (!operation) return node;
  const left = operand(node.left);
  const right = operand(node.right);
  if (left === unknown || right === unknown) return node;
  try {
    return { type: 'Literal', value: operation(left, right) };
  } catch {
    // Invalid literal arithmetic, such as mixing bigint and number, cannot supply a module path.
    return node;
  }
}

export function foldedValue(node, resolve) {
  function operand(part) {
    const fixed = resolve(part);
    if (fixed === missing || (fixed?.type === 'UnaryExpression' && fixed.operator === 'void')) return undefined;
    const value = literalValue(fixed);
    if (value === undefined || (value !== null && typeof value === 'object')) return unknown;
    return value;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const value = operand(node.argument);
    if (value !== unknown) return { type: 'Literal', value: !value };
  }
  if (node.type === 'BinaryExpression') return literalBinary(node, operand);
  if (node.type === 'TemplateLiteral') {
    let text = node.quasis[0].value.cooked;
    for (const [index, part] of node.expressions.entries()) {
      const value = operand(part);
      if (value === unknown) return node;
      text += String(value) + node.quasis[index + 1].value.cooked;
    }
    return { type: 'Literal', value: text };
  }
  return node;
}
