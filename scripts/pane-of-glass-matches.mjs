// Match syntax, so examples in comments, strings, regexes and JSX text never count as UI dependencies.
import { posix } from 'node:path';
import { parseSync, Visitor } from 'vite';
import { globSources } from './pane-of-glass-globs.mjs';
import { globImports } from './pane-of-glass-vite.mjs';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';
import { localConstLookup } from './pane-of-glass-constants.mjs';

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

// Only a direct identifier argument follows const aliases. Keep the diagnostic at the import site.
function dynamicImportSource(program, file, source) {
  let lookup;
  return (argument) => {
    let node = unwrapped(argument);
    if (node.type !== 'Identifier') return argument;
    lookup ??= localConstLookup(program, file, source);
    const seen = new Set();
    while (node?.type === 'Identifier' && !seen.has(node)) {
      seen.add(node);
      node = unwrapped(lookup(node));
    }
    return literalText(node) === null ? argument : node;
  };
}

export async function matchesIn(file, source, checkGlobs) {
  const parsed = parseSync(file, source, { range: true });
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  const offsets = {};
  function record(kind, node) {
    (offsets[kind] ??= new Set()).add(node.start);
  }
  const importSource = dynamicImportSource(parsed.program, file, source);
  function checkModule(node, source = node) {
    if (stringValues(source).some((name) => forbiddenModule(file, name))) record('import', node);
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
    ImportExpression: (node) => checkModule(node.source, importSource(node.source)),
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

  const globs = checkGlobs ? globSources(parsed.program, source) : [];
  for (const { node, code } of globs) {
    const ids = await globImports(file, code);
    if (ids.some((id) => id.startsWith('src/') && forbiddenModule(file, id))) record('import', node);
  }
  return matchingLines(offsets, source);
}

function matchingLines(offsets, source) {
  const lines = {};
  for (const kind of Object.keys(offsets).sort()) {
    lines[kind] = [...offsets[kind]].sort((a, b) => a - b)
      .map((offset) => source.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/).length);
  }
  return lines;
}
