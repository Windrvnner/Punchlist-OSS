// Match syntax, so examples in comments, strings, regexes and JSX text never count as UI dependencies.
import { posix } from 'node:path';
import { parseSync, Visitor } from 'vite';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';

// Persistence and network access belong in src/app and src/backend: browser storage, cookies, the Cache API, and
// the browser's own ways to reach a server (a model service among them).
const storageNames = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie']);
const networkNames = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']);
// Read only as a property (document.cookie, navigator.sendBeacon), so a local variable of that name is fine.
const propertyOnlyNames = new Set(['cookie', 'sendBeacon']);
const layerPath = /^(?:backend|adapters|desktop|shell)(?:\/|$)/;
const requireNames = new Set(['require', 'createRequire']);
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

// Decision: a UI module names what it loads with a plain string, so the check never has to work out a path (#848).
function computedPath(argument) {
  return !argument || literalText(unwrapped(argument)) === null;
}

// Decision: the UI reads import.meta only as import.meta.env, so a Vite glob cannot load another layer (#848).
function envRead(node) {
  const object = unwrapped(node.object);
  return object.type === 'MetaProperty' && object.meta.name === 'import' && !node.computed
    && node.property.name === 'env';
}

// What a UI module loads: other modules, by a plain string only, and import.meta only as import.meta.env.
function moduleChecks(file, record) {
  function checkModule(node, source = node) {
    if (stringValues(source).some((name) => forbiddenModule(file, name))) record('import', node);
  }
  function checkLoaded(node, argument) {
    if (computedPath(argument)) record('import', node);
    else checkModule(node, argument);
  }
  // The visitor reaches a node before its parts, so import.meta.env and require('…') are known by then.
  const envMeta = new Set();
  const calledRequire = new Set();
  const namesOnly = new Set();
  const moduleSource = (node) => checkModule(node.source);
  return {
    ImportDeclaration: moduleSource,
    ExportNamedDeclaration: moduleSource,
    ExportAllDeclaration: moduleSource,
    ImportExpression: (node) => checkLoaded(node.source, node.source),
    TSImportType: moduleSource,
    TSExternalModuleReference: (node) => checkModule(node.expression),
    CallExpression(node) {
      const callee = unwrapped(node.callee);
      if (callee.type !== 'Identifier' || callee.name !== 'require') return;
      calledRequire.add(callee);
      checkLoaded(node, node.arguments[0]);
    },
    // A key of an object literal, or a type, named require only names something; it loads nothing. A destructured
    // key still counts: `const { require: load } = module` takes the loader.
    ObjectExpression(node) {
      for (const entry of node.properties) {
        if (entry.type === 'Property' && !entry.computed && !entry.shorthand) namesOnly.add(entry.key);
      }
    },
    TSTypeAliasDeclaration(node) {
      namesOnly.add(node.id);
    },
    // Any other use of require (an alias, require.call, module.require, createRequire) loads an unchecked path.
    usesRequire(node) {
      if (requireNames.has(node.name) && !calledRequire.has(node) && !namesOnly.has(node)) record('import', node);
    },
    MetaProperty(node) {
      if (node.meta.name === 'import' && !envMeta.has(node)) record('import', node);
    },
    readsEnv(node) {
      if (envRead(node)) envMeta.add(unwrapped(node.object));
    },
  };
}

export function matchesIn(file, source) {
  const parsed = parseSync(file, source, { range: true });
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  const offsets = {};
  function record(kind, node) {
    (offsets[kind] ??= new Set()).add(node.start);
  }
  function checkProperty(key, computed) {
    const names = propertyNames(key, computed);
    if (names.includes('services')) record('services', key);
    if (names.some((name) => storageNames.has(name))) record('storage', key);
    if (names.some((name) => networkNames.has(name))) record('network', key);
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
  const { readsEnv, usesRequire, ...modules } = moduleChecks(file, record);
  new Visitor({
    ...modules,
    MemberExpression(node) {
      readsEnv(node);
      checkMember(node);
    },
    JSXOpeningElement: checkTag,
    ObjectPattern: checkPattern,
    Identifier(node) {
      usesRequire(node);
      if (propertyOnlyNames.has(node.name)) return;
      if (storageNames.has(node.name)) record('storage', node);
      if (networkNames.has(node.name)) record('network', node);
    },
  }).visit(parsed.program);
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
