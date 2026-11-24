// Keep the expression containing each glob so Vite itself sees the original calls, operators and property lookups.
function children(node) {
  return Object.values(node).flat().filter((child) => typeof child?.type === 'string' && Number.isInteger(child.start));
}

function surroundingExpression(node) {
  if (!node.type.endsWith('Expression') && node.type !== 'TemplateLiteral') return false;
  return !['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression', 'ImportExpression',
    'YieldExpression', 'AwaitExpression'].includes(node.type);
}

function inert(node) {
  if (node.type === 'MetaProperty') return '({})';
  if (node.type === 'PrivateIdentifier') return '__globPrivate';
  if (node.type === 'Super') return '__globSuper';
  if (node.type === 'Identifier' && node.name === 'require') return '__globRequire';
  if (node.type === 'ObjectExpression') return '({})';
  if (node.type === 'ArrayExpression') return '[]';
  if (['CallExpression', 'NewExpression', 'ImportExpression', 'TaggedTemplateExpression', 'ArrowFunctionExpression',
    'FunctionExpression', 'ClassExpression', 'JSXElement', 'JSXFragment'].includes(node.type)) return '(void 0)';
}

function context(root, target, source) {
  const edits = [];
  function visit(node) {
    if (node === target) return;
    if (node.start > target.start || node.end < target.end) {
      const replacement = inert(node);
      if (replacement !== undefined) {
        edits.push({ start: node.start, end: node.end, text: replacement });
        return;
      }
    }
    for (const child of children(node)) visit(child);
  }
  visit(root);
  return (call) => {
    const pieces = [...edits, { start: target.start, end: target.end, text: call }].sort((a, b) => a.start - b.start);
    let text = '';
    let start = root.start;
    for (const piece of pieces) {
      if (piece.start < start) continue;
      text += source.slice(start, piece.start) + piece.text;
      start = piece.end;
    }
    return text + source.slice(start, root.end);
  };
}

export function retainExpressions(program, globs, source) {
  const targets = new Map(globs.map((glob) => [glob.node, glob]));
  function visit(node, expression) {
    const root = surroundingExpression(node) ? (expression ?? node) : null;
    const glob = targets.get(node);
    if (glob) glob.render = context(root ?? node, node, source);
    for (const child of children(node)) visit(child, root);
  }
  if (globs.length) visit(program, null);
}
