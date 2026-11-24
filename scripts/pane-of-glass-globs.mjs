// Vite's development transform evaluates glob options. Only hand it expressions built entirely from data.
import { Visitor } from 'vite';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';

function dataProperty(part) {
  if (part.type === 'SpreadElement') return literalObject(part.argument);
  return part.kind === 'init' && !part.method && !part.computed && dataValue(part.value);
}

function literalObject(node) {
  const value = unwrapped(node);
  return value?.type === 'ObjectExpression' && value.properties.every(dataProperty);
}

function dataValue(node) {
  const value = unwrapped(node);
  if (literalText(value) !== null || ['boolean', 'number'].includes(typeof value?.value)) return true;
  if (value.type === 'BinaryExpression') {
    return value.operator === '+' && dataValue(value.left) && dataValue(value.right);
  }
  if (value.type !== 'MemberExpression') return literalObject(value);
  const object = unwrapped(value.object);
  const key = value.computed ? literalText(value.property) : value.property.name;
  if (key === null || !literalObject(object)) return false;
  return object.properties.some((part) => part.key && (part.key.name ?? literalText(part.key)) === key);
}

function globMeta(node) {
  let callee = unwrapped(node.callee);
  if (callee.type === 'TSInstantiationExpression') callee = unwrapped(callee.expression);
  if (callee.type !== 'MemberExpression') return;
  const key = callee.computed ? literalText(callee.property) : callee.property.name;
  const meta = unwrapped(callee.object);
  if (key === 'glob' && meta.type === 'MetaProperty' && meta.meta.name === 'import') return meta;
}

function staticGlob(node) {
  const meta = globMeta(node);
  if (!meta || node.arguments.length > 2) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const patterns = argument?.type === 'ArrayExpression' ? argument.elements : [argument];
  if (patterns.every((part) => literalText(unwrapped(part)) !== null) && (!options || literalObject(options))) {
    return { node, meta };
  }
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
      const object = unwrapped(node.object);
      const key = node.computed ? literalText(node.property) : node.property.name;
      if (object.type === 'MetaProperty' && ['env', 'hot'].includes(key)) keep.add(object);
    },
    MetaProperty(node) {
      if (node.meta.name === 'import' && !keep.has(node)) edits.push([node, '__paneMeta']);
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
