export function literalText(node) {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

// Assertions, parentheses and optional chains leave the underlying path or member unchanged.
export function unwrapped(node, stopBefore) {
  const wrappers = ['TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression',
    'ChainExpression', 'ParenthesizedExpression'];
  while (wrappers.includes(node?.type) && node.type !== stopBefore) {
    node = node.expression;
  }
  return node;
}
