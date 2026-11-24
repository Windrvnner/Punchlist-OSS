// Match syntax, so examples in comments, strings, regexes and JSX text never count as UI dependencies.
import { posix } from 'node:path';
import { parseSync, Visitor } from 'vite';
import { collectGlob } from './pane-of-glass-globs.mjs';
import { forbiddenGlobs } from './pane-of-glass-vite.mjs';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

const storageNames = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const layerPath = /^(?:backend|adapters|desktop|shell)(?:\/|$)/;
const externalModule = /^(?:node:|(?:electron|fs|path)(?:\/|$))/;

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
function stringValues(expression) {
  if (!expression) return [];
  const node = unwrapped(expression);
  const text = literalValue(node);
  if (typeof text === 'string') return [text];
  if (node.type === 'TemplateLiteral') return templateValues(node);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return concatenate(stringValues(node.left), stringValues(node.right));
  }
  if (node.type === 'ConditionalExpression') return [...stringValues(node.consequent), ...stringValues(node.alternate)];
  if (node.type === 'LogicalExpression') return [...stringValues(node.left), ...stringValues(node.right)];
  return ['*'];
}

function forbiddenSource(file) {
  return file.startsWith('src/') && layerPath.test(file.slice('src/'.length));
}

function forbiddenModule(file, name) {
  if (externalModule.test(name)) return true;
  if (!name.startsWith('.')) return layerPath.test(name.replace(/^\/?src\//, ''));
  return forbiddenSource(posix.join(posix.dirname(file), name));
}

function propertyNames(key, computed) {
  if (!computed && (key.type === 'Identifier' || key.type === 'JSXIdentifier')) return [key.name];
  return stringValues(key);
}

function sourceLines(offsets, source) {
  const lines = {};
  for (const kind of Object.keys(offsets).sort()) {
    lines[kind] = [...offsets[kind]].sort((a, b) => a - b)
      .map((offset) => source.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/).length);
  }
  return lines;
}

export async function matchesIn(file, source, files) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  const offsets = {};
  const globs = [];
  const keysOnly = new Map();
  function record(kind, node) {
    (offsets[kind] ??= new Set()).add(node.start);
  }
  function checkModule(node) {
    if (stringValues(node).some((name) => forbiddenModule(file, name))) record('import', node);
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
      collectGlob(node, source, globs, keysOnly);
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') checkModule(node.arguments[0]);
    },
    MemberExpression: checkMember,
    JSXOpeningElement: checkTag,
    ObjectPattern: checkPattern,
    Identifier(node) {
      if (storageNames.has(node.name)) record('storage', node);
    },
  }).visit(parsed.program);

  for (const index of await forbiddenGlobs(file, globs, keysOnly, files, forbiddenSource)) {
    record('import', globs[index].node);
  }

  return sourceLines(offsets, source);
}
