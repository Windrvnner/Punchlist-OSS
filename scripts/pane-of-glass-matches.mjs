// Match syntax, so examples in comments, strings, regexes and JSX text never count as UI dependencies.
import { posix } from 'node:path';
import { parseSync, Visitor } from 'vite';
import { localConstants } from './pane-of-glass-constants.mjs';

const storageNames = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const layerPath = /^(?:backend|adapters|desktop|shell)(?:\/|$)/;
const externalModule = /^(?:node:|(?:electron|fs|path)(?:\/|$))/;

function literalText(node) {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

function concatenate(left, right) {
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix));
}

function templateValues(node, resolve) {
  let values = [node.quasis[0].value.cooked];
  for (const [index, expression] of node.expressions.entries()) {
    const tail = node.quasis[index + 1].value.cooked;
    values = concatenate(values, stringValues(expression, resolve)).map((value) => value + tail);
  }
  return values;
}

// Only inspect syntax. A placeholder preserves the known parts of a string around a runtime value.
function stringValues(expression, resolve = () => ['*']) {
  if (!expression) return [];
  const node = unwrapped(expression);
  const text = literalText(node);
  if (text !== null) return [text];
  if (node.type === 'Identifier') return resolve(node);
  if (node.type === 'TemplateLiteral') return templateValues(node, resolve);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return concatenate(stringValues(node.left, resolve), stringValues(node.right, resolve));
  }
  if (node.type === 'ConditionalExpression') {
    return [...stringValues(node.consequent, resolve), ...stringValues(node.alternate, resolve)];
  }
  if (node.type === 'LogicalExpression') {
    return [...stringValues(node.left, resolve), ...stringValues(node.right, resolve)];
  }
  return ['*'];
}

function importTargets(file, source) {
  let constants;
  function targets(node, seen = new Set()) {
    return stringValues(node, (identifier) => {
      constants ??= localConstants(file, source);
      const initializer = constants.get(identifier.start);
      if (!initializer || seen.has(initializer)) return ['*'];
      return targets(initializer, new Set(seen).add(initializer));
    });
  }
  return targets;
}

function forbiddenModule(file, name) {
  if (externalModule.test(name)) return true;
  if (!name.startsWith('.')) return layerPath.test(name.replace(/^\/?src\//, ''));
  const target = posix.join(posix.dirname(file), name);
  return target.startsWith('src/') && layerPath.test(target.slice('src/'.length));
}

function propertyNames(key, computed) {
  if (!computed && (key.type === 'Identifier' || key.type === 'JSXIdentifier')) return [key.name];
  return stringValues(key);
}

// Assertions, parentheses and optional chains leave the underlying path or member unchanged.
function unwrapped(node) {
  while (['TSNonNullExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression',
    'ChainExpression', 'ParenthesizedExpression'].includes(node.type)) {
    node = node.expression;
  }
  return node;
}

export function matchesIn(file, source) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  const offsets = {};
  function record(kind, node) {
    (offsets[kind] ??= new Set()).add(node.start);
  }
  const targets = importTargets(file, source);
  function checkModule(node) {
    if (targets(node).some((name) => forbiddenModule(file, name))) record('import', node);
  }
  function checkProperty(key, computed) {
    const names = propertyNames(key, computed);
    if (names.includes('services')) record('services', key);
    if (names.some((name) => storageNames.has(name))) record('storage', key);
  }
  function checkMember(node) {
    checkProperty(node.property, node.computed);
    const target = unwrapped(node.object);
    if (target.type !== 'MemberExpression' && target.type !== 'JSXMemberExpression') return;
    if (propertyNames(target.property, target.computed).includes('repo')) record('repo', target.property);
  }
  // A dotted JSX tag reads its component once, when opened. Its closing tag repeats the name.
  function checkTag(node) {
    let tag = node.name;
    while (tag.type === 'JSXMemberExpression') {
      checkMember(tag);
      tag = tag.object;
    }
    if (tag !== node.name && storageNames.has(tag.name)) record('storage', tag);
  }
  function checkPattern(node) {
    for (const entry of node.properties) {
      if (entry.type === 'Property') checkProperty(entry.key, entry.computed);
    }
  }
  const moduleSource = (node) => checkModule(node.source);
  new Visitor({
    ImportDeclaration: moduleSource,
    ExportNamedDeclaration: moduleSource,
    ExportAllDeclaration: moduleSource,
    ImportExpression: moduleSource,
    TSImportType: moduleSource,
    TSExternalModuleReference: (node) => checkModule(node.expression),
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') checkModule(node.arguments[0]);
    },
    MemberExpression: checkMember,
    JSXOpeningElement: checkTag,
    ObjectPattern: checkPattern,
    Identifier(node) {
      if (storageNames.has(node.name)) record('storage', node);
    },
  }).visit(parsed.program);

  const lines = {};
  for (const kind of Object.keys(offsets).sort()) {
    lines[kind] = [...offsets[kind]].sort((a, b) => a - b)
      .map((offset) => source.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/).length);
  }
  return lines;
}
