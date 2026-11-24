// Match syntax, so examples in comments, strings, regexes and JSX text never count as UI dependencies.
import { posix } from 'node:path';
import { parseSync, Visitor } from 'vite';

const storageNames = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const layerPath = /^(?:backend|adapters|desktop|shell)(?:\/|$)/;
const externalModule = /^(?:node:|(?:electron|fs|path)(?:\/|$))/;

function literalText(node) {
  if (typeof node?.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

function joinedPaths(left, right) {
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix));
}

function templatePaths(node) {
  let paths = [node.quasis[0].value.cooked];
  for (const [index, expression] of node.expressions.entries()) {
    const tail = node.quasis[index + 1].value.cooked;
    paths = joinedPaths(paths, modulePaths(expression)).map((path) => path + tail);
  }
  return paths;
}

// Only inspect syntax. A placeholder preserves the known parts of a path around a runtime value.
function modulePaths(expression) {
  if (!expression) return [];
  const node = unwrapped(expression);
  const text = literalText(node);
  if (text !== null) return [text];
  if (node.type === 'TemplateLiteral') return templatePaths(node);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return joinedPaths(modulePaths(node.left), modulePaths(node.right));
  }
  if (node.type === 'ConditionalExpression') return [...modulePaths(node.consequent), ...modulePaths(node.alternate)];
  if (node.type === 'LogicalExpression') return [...modulePaths(node.left), ...modulePaths(node.right)];
  return ['*'];
}

function forbiddenModule(file, name) {
  if (externalModule.test(name)) return true;
  if (!name.startsWith('.')) return layerPath.test(name.replace(/^\/?src\//, ''));
  const target = posix.join(posix.dirname(file), name);
  return target.startsWith('src/') && layerPath.test(target.slice('src/'.length));
}

function propertyName(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name;
  return literalText(key);
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
  function checkModule(node) {
    if (modulePaths(node).some((name) => forbiddenModule(file, name))) record('import', node);
  }
  function checkMember(node) {
    const name = propertyName(node.property, node.computed);
    if (name === 'services') record('services', node.property);
    if (storageNames.has(name)) record('storage', node.property);
    const target = unwrapped(node.object);
    if (target.type === 'MemberExpression' && propertyName(target.property, target.computed) === 'repo') {
      record('repo', target.property);
    }
  }
  function checkPattern(node) {
    for (const entry of node.properties) {
      if (entry.type !== 'Property') continue;
      const name = propertyName(entry.key, entry.computed);
      if (name === 'services') record('services', entry.key);
      if (storageNames.has(name)) record('storage', entry.key);
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
