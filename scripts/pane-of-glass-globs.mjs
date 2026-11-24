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

function literalGlob(node) {
  if (!globCall(node)) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const values = argument?.type === 'ArrayExpression' ? argument.elements : [argument];
  const patterns = values.map(literalValue);
  if (!patterns.length || !patterns.every((value) => typeof value === 'string')) return;
  const settings = {};
  for (const option of options?.properties ?? []) {
    const key = option.key?.name ?? literalValue(option.key);
    if (['base', 'caseSensitive', 'eager', 'exhaustive'].includes(key)) settings[key] = literalValue(option.value);
  }
  return { patterns, settings };
}

export function collectGlob(node, globs, keysOnly) {
  const glob = literalGlob(node);
  if (glob) globs.push({ ...glob, node });
  const keys = globKeysArgument(node);
  if (keys) keysOnly.add(keys.start);
}

// Resolve on a virtual volume before writing a pattern. Even a glob that starts above the checkout
// can only walk the isolated filename snapshot. Vite handles the pattern syntax and file selection.
function snapshotPattern(pattern, directory, project, base) {
  const negative = pattern.startsWith('!');
  const value = negative ? pattern.slice(1) : pattern;
  let target;
  if (value.startsWith('/')) target = posix.join(project, value);
  else if (value.startsWith('**')) target = posix.join('/', value);
  else if (value.startsWith('./') || value.startsWith('../')) target = posix.resolve(base, value);
  else return;
  const relative = posix.relative(directory, target);
  return (negative ? '!' : '') + (relative.startsWith('../') ? relative : './' + relative);
}

export function probeEntry(globs, project, file, keysOnly) {
  const directory = posix.join(project, posix.dirname(file));
  return globs.map(({ node, patterns, settings }, index) => {
    const { base = '.', ...options } = settings;
    const from = base.startsWith('/') ? posix.join(project, base) : posix.resolve(directory, base);
    const relative = patterns.map((pattern) => snapshotPattern(pattern, directory, project, from));
    if (relative.includes(undefined)) return '';
    const tagged = { ...options, import: 'default', query: `?raw&glob=${index}` };
    const call = `import.meta.glob(${JSON.stringify(relative)}, ${JSON.stringify(tagged)})`;
    return `export const files${index} = ${keysOnly.has(node.start) ? `Object.keys(${call})` : call}`;
  }).join('\n');
}
