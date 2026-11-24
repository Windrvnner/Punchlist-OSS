// Only literal patterns and filename options enter the probe. Application code never runs in Vite.
import { posix } from 'node:path';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

function globCall(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'glob') return false;
  const object = callee.object;
  return object.type === 'MetaProperty' && object.meta.name === 'import' && object.property.name === 'meta';
}

function globKeysArgument(node) {
  const callee = node.callee;
  if (callee.type === 'MemberExpression' && !callee.computed && !callee.optional && !node.optional &&
      callee.object.name === 'Object' && callee.property.name === 'keys') return unwrapped(node.arguments[0]);
}

const optionTypes = {
  base: 'string', eager: 'boolean', exhaustive: 'boolean', caseSensitive: 'boolean',
  as: 'string', import: 'string', query: 'string',
};

function plainEntries(node) {
  if (node?.type !== 'ObjectExpression') return;
  const simple = (p) => p.type === 'Property' && p.kind === 'init' && !p.computed && !p.shorthand;
  if (!node.properties.every(simple)) return;
  return node.properties.map((p) => [p.key.name ?? literalValue(p.key), unwrapped(p.value)]);
}

function literalQuery(node) {
  return plainEntries(node)?.every(([, value]) => ['boolean', 'number', 'string'].includes(typeof literalValue(value)));
}

function literalOptions(node) {
  if (!node) return {};
  const entries = plainEntries(node);
  if (!entries) return;
  const settings = {};
  for (const [key, expression] of entries) {
    if (key === 'query' && literalQuery(expression)) continue;
    const value = literalValue(expression);
    if (!Object.hasOwn(optionTypes, key) || typeof value !== optionTypes[key]) return;
    if (['base', 'eager', 'exhaustive', 'caseSensitive'].includes(key)) settings[key] = value;
  }
  return settings;
}

function literalGlob(node, source) {
  if (!globCall(node)) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const array = argument?.type === 'ArrayExpression';
  const values = (array ? argument.elements : [argument]).map(unwrapped);
  if (!values.length || !values.every((part) => typeof literalValue(part) === 'string')) return;
  const patterns = values.map((part) => ({ value: literalValue(part), syntax: source.slice(part.start, part.end) }));
  // A compound option can change the selected layer. Leave the entire call for #848.
  const settings = literalOptions(options);
  if (settings) return { array, patterns, settings };
}

export function collectGlob(node, source, globs, keysOnly) {
  const glob = literalGlob(node, source);
  if (glob) globs.push({ ...glob, node });
  const keys = globKeysArgument(node);
  if (keys) keysOnly.add(keys.start);
}

// Preserve the original paths inside the volume. Bound a path that would walk above the snapshot.
function snapshotPath(value, from, project) {
  const depth = (directory) => directory.split('/').filter(Boolean).length;
  if (value.startsWith('**')) return '/' + '../'.repeat(depth(project)) + value;
  const absolute = value.startsWith('/');
  if (!absolute && !value.startsWith('./') && !value.startsWith('../')) return;
  const directory = absolute ? project : from;
  const parents = value.split(/[\\/]/).filter((part) => part === '..').length;
  if (parents <= depth(directory)) return value;
  return '/' + posix.relative(project, posix.join(directory, value));
}

function patternSyntax({ value, syntax }, from, project) {
  const negative = value.startsWith('!');
  const pattern = negative ? value.slice(1) : value;
  const local = snapshotPath(pattern, from, project);
  if (local === pattern) return syntax;
  if (local !== undefined) return JSON.stringify((negative ? '!' : '') + local);
}

export function probeEntry(globs, project, file, keysOnly) {
  const directory = posix.join(project, posix.dirname(file));
  return globs.map(({ node, array, patterns, settings }, index) => {
    const { base = '.', ...options } = settings;
    const from = base.startsWith('/') ? posix.join(project, base) : posix.resolve(directory, base);
    const safe = patterns.map((pattern) => patternSyntax(pattern, from, project));
    if (safe.includes(undefined)) return '';
    if (settings.base !== undefined) options.base = snapshotPath(base, directory, project);
    const tagged = { ...options, import: 'default', query: `?raw&glob=${index}` };
    const argument = array ? `[${safe.join(',')}]` : safe[0];
    const call = `import.meta.glob(${argument}, ${JSON.stringify(tagged)})`;
    return `export const files${index} = ${keysOnly.has(node.start) ? `Object.keys(${call})` : call}`;
  }).join('\n');
}
