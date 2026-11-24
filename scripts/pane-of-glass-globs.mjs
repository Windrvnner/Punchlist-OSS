// Vite evaluates glob options in development. Pass it only literal data and operations on that data.
import { fixedData, literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

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

function filePattern(value) {
  return typeof value === 'string' && /^!?(?:\/|\.\.?\/|\*\*)/.test(value);
}

function literalGlob(node, source) {
  if (!globCall(node)) return;
  const [argument, options] = node.arguments.map(unwrapped);
  const array = argument?.type === 'ArrayExpression';
  const elements = array ? argument.elements.map(unwrapped) : [argument];
  const values = elements.map(literalValue);
  if (!values.length || !values.every(filePattern)) return;
  const syntax = (part) => source.slice(part.start, part.end);
  const patterns = elements.map((part, index) => ({ value: values[index], syntax: syntax(part) }));
  const strings = [];
  const properties = (options?.properties ?? []).filter((part) => fixedData(part, strings)).map(syntax);
  // Add one pattern's parent segments to the largest possible ascent in its literal options.
  const isParent = (part) => part === '..';
  const ascent = Math.max(...values.map((value) => value.replace(/^!/, '').split(/[\\/]/).filter(isParent).length));
  const text = strings.join('');
  const dotPairs = Math.floor((text.match(/\./g)?.length ?? 0) / 2);
  const separators = text.match(/[\\/]/g)?.length ?? 0;
  return { patterns, array, properties, parentSteps: ascent + Math.min(dotPairs, separators + 1) };
}

export function collectGlob(node, source, globs, keysOnly) {
  const glob = literalGlob(node, source);
  if (glob) globs.push({ ...glob, node });
  const keys = globKeysArgument(node);
  if (keys) keysOnly.add(keys.start);
}

function patternSyntax({ value, syntax }, volume) {
  const negative = value.startsWith('!');
  const pattern = negative ? value.slice(1) : value;
  // Vite starts a bare ** at the filesystem root. Keep that traversal on the snapshot's virtual volume.
  if (pattern.startsWith('**')) return JSON.stringify((negative ? '!' : '') + volume + pattern);
  return syntax;
}

export function probeEntry(globs, volume, keysOnly) {
  return globs.map(({ node, patterns, array, properties }, index) => {
    const args = patterns.map((pattern) => patternSyntax(pattern, volume));
    const argument = array ? `[${args.join(',')}]` : args[0];
    // Keep each original property in place. Native builds and development interpret option spreads differently.
    const tagged = [...properties, "as: ''", "import: 'default'", `query: '?raw&glob=${index}'`].join(',');
    const call = `import.meta.glob(${argument}, {${tagged}})`;
    return `export const files${index} = ${keysOnly.has(node.start) ? `Object.keys(${call})` : call}`;
  }).join('\n');
}
