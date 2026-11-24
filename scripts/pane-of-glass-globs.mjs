// Only literal patterns and filename options enter the probe. Application code never runs in Vite.
import { posix } from 'node:path';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

function globCall(node) {
  const callee = unwrapped(node.callee);
  if (callee.type !== 'MemberExpression') return false;
  const name = callee.computed ? literalValue(callee.property) : callee.property.name;
  const object = unwrapped(callee.object);
  return name === 'glob' && object.type === 'MetaProperty' && object.meta.name === 'import';
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
    if (key === 'query' && literalQuery(expression)) {
      settings.query = Object.fromEntries(plainEntries(expression).map(([name, part]) => [name, literalValue(part)]));
      continue;
    }
    const value = literalValue(expression);
    if (!Object.hasOwn(optionTypes, key) || typeof value !== optionTypes[key]) return;
    settings[key] = value;
  }
  return settings;
}

export function literalGlob(node, source) {
  if (!globCall(node) || node.arguments.length > 2) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const array = argument?.type === 'ArrayExpression';
  const values = (array ? argument.elements : [argument]).map(unwrapped);
  if (!values.length || !values.every((part) => typeof literalValue(part) === 'string')) return;
  const patterns = values.map((part) => ({ value: literalValue(part), syntax: source.slice(part.start, part.end) }));
  // A compound option can change the selected layer. Leave the entire call for #848.
  const settings = literalOptions(options);
  if (!settings) return;
  const first = node.arguments[0];
  const last = node.arguments.at(-1);
  const prefix = source.slice(node.start, first.start);
  const suffix = source.slice(last.end, node.end);
  return { node, array, patterns, settings, prefix, suffix };
}

export function packageName(pattern) {
  const value = pattern.replace(/^!/, '');
  return /^(?:@[\w.-]+\/)?[\w-][\w.-]*(?=\/|$)/.exec(value)?.[0];
}

// Preserve the original paths inside the volume. Bound a path that would walk above the snapshot.
function snapshotPath(value, from, project) {
  const depth = (directory) => directory.split('/').filter(Boolean).length;
  if (value.startsWith('**')) return '/' + '../'.repeat(depth(project)) + value;
  const absolute = value.startsWith('/');
  if (!absolute && !value.startsWith('./') && !value.startsWith('../')) return packageName(value) ? value : undefined;
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

export function probeEntry(glob, project, file) {
  const directory = posix.join(project, posix.dirname(file));
  const { base = '.', ...options } = glob.settings;
  const from = base.startsWith('/') ? posix.join(project, base) : posix.resolve(directory, base);
  const safe = glob.patterns.map((pattern) => patternSyntax(pattern, from, project)).filter(Boolean);
  if (!safe.length) return;
  if (glob.settings.base !== undefined) options.base = snapshotPath(base, directory, project);
  const argument = glob.array ? `[${safe.join(',')}]` : safe[0];
  // The snapshot has the source filenames and no application exports. A namespace import selects the same files.
  delete options.import;
  const args = glob.node.arguments.length > 1 ? argument + ', ' + JSON.stringify(options) : argument;
  return 'export const files = ' + glob.render(glob.prefix + args + glob.suffix);
}
