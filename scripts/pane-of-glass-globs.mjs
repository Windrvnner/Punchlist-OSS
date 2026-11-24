// A Vite glob only imports files that exist and survive its exclusions. Match against the forbidden source files.
import { posix } from 'node:path';
import picomatch from 'picomatch';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

function globCall(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'glob') return false;
  const object = callee.object;
  return object.type === 'MetaProperty' && object.meta.name === 'import' && object.property.name === 'meta';
}

function rootPattern(pattern, directory) {
  if (pattern.startsWith('**')) return pattern;
  return posix.resolve(directory, pattern);
}

export function importsForbiddenGlob(file, node, files) {
  if (!globCall(node)) return false;
  const [argument, options] = node.arguments.map(unwrapped);
  const patterns = argument?.type === 'ArrayExpression' ? argument.elements : [argument];
  const settings = {};
  for (const option of options?.properties ?? []) {
    if (option.type === 'Property') settings[option.key.name ?? literalValue(option.key)] = literalValue(option.value);
  }
  const directory = posix.resolve('/', posix.dirname(file), settings.base ?? '.');
  const matchOptions = { dot: !!settings.exhaustive, nocase: settings.caseSensitive === false, noext: true };
  const include = [];
  const exclude = [];
  for (const pattern of patterns.map(literalValue)) {
    if (typeof pattern !== 'string') continue;
    const negative = pattern.startsWith('!');
    const value = negative ? pattern.slice(1) : pattern;
    const matcher = picomatch(rootPattern(value, directory), matchOptions);
    (negative ? exclude : include).push(matcher);
  }
  return files.some((target) => {
    if (!settings.exhaustive && target.includes('/node_modules/')) return false;
    const matches = (matcher) => matcher('/' + target);
    return include.some(matches) && !exclude.some(matches);
  });
}
