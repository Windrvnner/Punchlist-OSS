// Vite evaluates glob options in development. Only pass direct literal data to that transform.
import { Visitor } from 'vite';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';

function literalScalar(expression) {
  const node = unwrapped(expression);
  if (literalText(node) !== null) return true;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    return typeof unwrapped(node.argument)?.value === 'number';
  }
  return node.type === 'Literal' && !node.regex && !node.bigint;
}

function literalProperty(part) {
  if (part.type !== 'Property' || part.kind !== 'init' || part.method || part.shorthand) return false;
  if (part.computed && !literalScalar(part.key)) return false;
  const value = unwrapped(part.value);
  return value.type === 'ObjectExpression' ? value.properties.every(literalProperty) : literalScalar(value);
}

function metaMember(node) {
  const object = unwrapped(node.object);
  if (object.type !== 'MetaProperty' || object.meta.name !== 'import') return;
  const key = node.computed ? literalText(unwrapped(node.property)) : node.property.name;
  return { object, key };
}

function globMeta(node) {
  let callee = unwrapped(node.callee);
  if (callee.type === 'TSInstantiationExpression') callee = unwrapped(callee.expression);
  if (callee.type !== 'MemberExpression') return;
  const member = metaMember(callee);
  if (member?.key === 'glob') return member.object;
}

function staticGlob(node) {
  const meta = globMeta(node);
  if (!meta || node.arguments.length > 2) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const patterns = argument?.type === 'ArrayExpression' ? argument.elements : [argument];
  if (options && (options.type !== 'ObjectExpression' || !options.properties.every(literalProperty))) return;
  if (patterns.every((part) => literalText(unwrapped(part)) !== null)) return { node, meta };
}

// Keep each call in its enclosing expression. Other imports get stand-ins so overlapping imports can be
// attributed to the right line, and unrelated glob options and asset URLs never run through Vite.
export function* globSources(program, source) {
  const globs = [];
  const edits = [];
  const keep = new Set();
  const mask = (source) => {
    if (source) edits.push([source, '"data:text/javascript,"']);
  };
  const maskImport = (node) => mask(node.source);
  new Visitor({
    CallExpression(node) {
      const glob = staticGlob(node);
      if (glob) globs.push(glob);
    },
    ImportDeclaration: maskImport,
    ExportAllDeclaration: maskImport,
    ExportNamedDeclaration: maskImport,
    ImportExpression: maskImport,
    TSExternalModuleReference: (node) => mask(node.expression),
    MemberExpression(node) {
      const member = metaMember(node);
      if (member && ['env', 'hot'].includes(member.key)) keep.add(member.object);
    },
    MetaProperty(node) {
      // Hide other glob calls and asset URLs from Vite's transforms without introducing a name the UI can shadow.
      if (node.meta.name === 'import' && !keep.has(node)) edits.push([node, '((() => import.meta)())']);
    },
  }).visit(program);
  edits.sort(([a], [b]) => a.start - b.start);
  for (const { node, meta } of globs) {
    let code = '';
    let end = 0;
    for (const [part, replacement] of edits) {
      if (part.start < end || (part.start <= meta.start && part.end >= meta.end)) continue;
      code += source.slice(end, part.start) + replacement;
      end = part.end;
    }
    yield { node, code: code + source.slice(end) };
  }
}
