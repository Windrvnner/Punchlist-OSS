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
