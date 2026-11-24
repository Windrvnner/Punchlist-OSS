// Vite's development transform evaluates glob options. Only hand it expressions built entirely from data.
import { Visitor } from 'vite';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';

function dataProperty(part) {
  if (part.type === 'SpreadElement') return dataValue(part.argument);
  return part.kind === 'init' && !part.method && (!part.computed || dataValue(part.key)) && dataValue(part.value);
}

function literalObject(node) {
  const value = unwrapped(node);
  return value?.type === 'ObjectExpression' && value.properties.every(dataProperty);
}

function propertyKey(node) {
  const key = node.key ?? node.property;
  return node.computed ? literalText(unwrapped(key)) : key.name ?? literalText(key);
}

// Search from the last property back because later properties and spreads replace earlier ones.
function ownValue(receiver, key) {
  const object = unwrapped(receiver);
  if (object?.type === 'MemberExpression') {
    return ownValue(ownValue(object.object, propertyKey(object)), key);
  }
  if (object?.type !== 'ObjectExpression' || key === null) return;
  for (const part of object.properties.toReversed()) {
    if (part.type === 'SpreadElement') {
      const value = ownValue(part.argument, key);
      if (value) return value;
    } else if (propertyKey(part) === key && (key !== '__proto__' || part.computed)) {
      return part.value;
    }
  }
}

function dataValue(node) {
  const value = unwrapped(node);
  if (literalText(value) !== null || ['boolean', 'number'].includes(typeof value?.value)) return true;
  if (value.type === 'TemplateLiteral') return value.expressions.every(dataValue);
  if (value.type === 'UnaryExpression') return value.operator !== 'delete' && dataValue(value.argument);
  if (value.type === 'BinaryExpression' || value.type === 'LogicalExpression') {
    return dataValue(value.left) && dataValue(value.right);
  }
  if (value.type === 'ConditionalExpression') {
    return [value.test, value.consequent, value.alternate].every(dataValue);
  }
  if (value.type !== 'MemberExpression') return literalObject(value);
  return dataValue(value.object) && Boolean(ownValue(value.object, propertyKey(value)));
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
