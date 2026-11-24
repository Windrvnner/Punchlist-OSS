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

function dataChildren(node) {
  switch (node.type) {
    case 'ObjectExpression': return node.properties;
    case 'ArrayExpression': return node.elements;
    case 'SpreadElement':
    case 'UnaryExpression': return [node.argument];
    case 'LogicalExpression':
    case 'BinaryExpression': return [node.left, node.right];
    case 'ConditionalExpression': return [node.test, node.consequent, node.alternate];
    case 'TemplateLiteral': return [...node.quasis, ...node.expressions];
    case 'Property':
      if (node.kind !== 'init' || node.method || node.shorthand) return;
      return node.computed ? [node.key, node.value] : [node.value];
  }
}

// Collect strings only from expressions Vite can evaluate without invoking application code.
export function fixedData(expression, strings) {
  const node = unwrapped(expression);
  if (!node) return false;
  if (node.type === 'Literal' || node.type === 'TemplateElement') {
    const value = node.type === 'Literal' ? node.value : node.value.cooked;
    if (typeof value === 'string') strings.push(value);
    return value === null || ['number', 'string', 'boolean'].includes(typeof value);
  }
  return dataChildren(node)?.every((child) => fixedData(child, strings)) ?? false;
}
