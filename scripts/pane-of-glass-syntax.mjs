// These wrappers preserve the underlying runtime expression, including the receiver of a method call.
export function unwrapped(node) {
  while (['TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression',
    'TSInstantiationExpression', 'ChainExpression', 'ParenthesizedExpression'].includes(node?.type)) {
    node = node.expression;
  }
  return node;
}
