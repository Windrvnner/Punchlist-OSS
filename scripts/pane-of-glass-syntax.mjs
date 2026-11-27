export function literalText(node) {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

// Assertions, parentheses and optional chains leave the underlying path or member unchanged.
export function unwrapped(node) {
  const wrappers = ['TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression',
    'ChainExpression', 'ParenthesizedExpression'];
  while (wrappers.includes(node?.type)) {
    node = node.expression;
  }
  return node;
}

function concatenate(left, right) {
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix));
}

function templateValues(node) {
  let values = [node.quasis[0].value.cooked];
  for (const [index, expression] of node.expressions.entries()) {
    const tail = node.quasis[index + 1].value.cooked;
    values = concatenate(values, stringValues(expression)).map((value) => value + tail);
  }
  return values;
}

// Only inspect syntax. A placeholder preserves the known parts of a string around a runtime value.
export function stringValues(expression) {
  if (!expression) return [];
  const node = unwrapped(expression);
  const text = literalText(node);
  if (text !== null) return [text];
  if (node.type === 'TemplateLiteral') return templateValues(node);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return concatenate(stringValues(node.left), stringValues(node.right));
  }
  if (node.type === 'ConditionalExpression') return [...stringValues(node.consequent), ...stringValues(node.alternate)];
  if (node.type === 'LogicalExpression') return [...stringValues(node.left), ...stringValues(node.right)];
  return ['*'];
}

export function propertyNames(key, computed) {
  if (!computed && (key.type === 'Identifier' || key.type === 'JSXIdentifier')) return [key.name];
  return stringValues(key);
}
