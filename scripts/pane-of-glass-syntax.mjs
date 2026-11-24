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

// Fold only literal operands. Computed keys use the same string concatenation and interpolation as import paths.
function literalSum(node, operand) {
  const left = operand(node.left);
  const right = operand(node.right);
  if (left === undefined || right === undefined) return node;
  if (typeof left === 'string' || typeof right === 'string') return { type: 'Literal', value: String(left) + right };
  if (typeof left === 'number' && typeof right === 'number') return { type: 'Literal', value: left + right };
  return node;
}

export function foldedValue(node, resolve) {
  function operand(part) {
    const value = literalValue(resolve(part));
    return value !== null && typeof value === 'object' ? undefined : value;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const value = operand(node.argument);
    if (value !== undefined) return { type: 'Literal', value: !value };
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') return literalSum(node, operand);
  if (node.type === 'TemplateLiteral') {
    let text = node.quasis[0].value.cooked;
    for (const [index, part] of node.expressions.entries()) {
      const value = operand(part);
      if (value === undefined) return node;
      text += String(value) + node.quasis[index + 1].value.cooked;
    }
    return { type: 'Literal', value: text };
  }
  return node;
}

export const missing = Symbol('missing literal entry');
