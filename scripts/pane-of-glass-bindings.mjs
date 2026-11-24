// Follow a destructuring pattern only through values present in its literal initializer.
import { literalValue, missing, unwrapped } from './pane-of-glass-syntax.mjs';

export function propertyKey(node, computed, resolve = unwrapped) {
  if (!computed && node.type === 'Identifier') return node.name;
  const key = literalValue(resolve(node));
  return typeof key === 'string' || typeof key === 'number' ? String(key) : null;
}

function setsPrototype(entry) {
  return entry.type === 'Property' && entry.kind === 'init' && !entry.computed && !entry.method && !entry.shorthand
    && propertyKey(entry.key, false) === '__proto__';
}

function propertyValue(entry, key, resolve, seen) {
  if (entry.type === 'SpreadElement') return ownEntry(resolve(entry.argument), key, resolve, seen);
  if (setsPrototype(entry)) return missing;
  const name = propertyKey(entry.key, entry.computed, resolve);
  if (name === null) return null;
  if (name !== key) return missing;
  return entry.kind === 'init' ? entry.value : null;
}

function ownEntry(object, key, resolve, seen) {
  if (object?.type === 'ArrayExpression') return arrayProperty(object, key, resolve, false);
  if (object?.type !== 'ObjectExpression' || key === null || seen.has(object)) return null;
  if (object.omittedKeys?.includes(key)) return missing;
  const visited = new Set(seen).add(object);
  // A later spread or computed key can override an earlier literal property.
  for (const entry of object.properties.toReversed()) {
    const value = propertyValue(entry, key, resolve, visited);
    if (value !== missing) return value;
  }
  return missing;
}

function objectEntry(object, key, resolve, seen = new Set()) {
  const value = ownEntry(object, key, resolve, seen);
  if (value !== missing) return value;
  const prototype = object.properties.find(setsPrototype);
  if (prototype) {
    if (literalValue(prototype.value) === null) return missing;
    return objectEntry(resolve(prototype.value), key, resolve, new Set(seen).add(object));
  }
  return Object.hasOwn(Object.prototype, key) ? null : missing;
}

// Stop at the requested index: a runtime spread after it cannot shift an earlier entry.
function arrayElements(array, resolve, limit, seen = new Set()) {
  if (array?.type !== 'ArrayExpression' || seen.has(array)) return null;
  const parts = [];
  for (const part of array.elements) {
    if (parts.length >= limit) break;
    if (part?.type === 'SpreadElement') {
      const tail = arrayElements(resolve(part.argument), resolve, limit - parts.length, new Set(seen).add(array));
      if (!tail) return null;
      for (const item of tail) parts.push(item);
    } else {
      parts.push(part);
    }
  }
  return parts;
}

function arrayProperty(array, key, resolve, includeLength) {
  if (key === null) return null;
  if (key === 'length' && includeLength) {
    const parts = arrayElements(array, resolve, Infinity);
    return parts ? { type: 'Literal', value: parts.length } : null;
  }
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return missing;
  const parts = arrayElements(array, resolve, index + 1);
  return parts ? (parts[index] ?? missing) : null;
}

export function entryValue(container, key, resolve = unwrapped) {
  if (container?.type !== 'ArrayExpression') return objectEntry(container, key, resolve);
  const value = arrayProperty(container, key, resolve, true);
  return value === missing && key in Array.prototype ? null : value;
}

function contains(pattern, name) {
  return pattern && pattern.start <= name.start && name.end <= pattern.end;
}

// Destructuring reads properties in order. Earlier getters, iterators or defaults can change a later target.
function readsProperty(part, source, resolve) {
  if (part.type === 'RestElement') {
    if (source?.type === 'ArrayExpression') return true;
    return source?.type === 'ObjectExpression' && source.properties.every((entry) => entry.kind !== 'get');
  }
  const key = propertyKey(part.key, part.computed, resolve);
  if (key === null) return false;
  const entry = entryValue(source, key, resolve);
  return entry !== null && readsPattern(part.value, entry, resolve);
}

function readsDefault(pattern, raw, resolve) {
  const value = resolve(raw);
  const container = value?.type === 'ObjectExpression' || value?.type === 'ArrayExpression';
  const known = literalValue(value) !== undefined || container;
  if (known) return readsPattern(pattern.left, value, resolve);
  // A default containing a call cannot be assumed harmless if the property may be absent.
  if (literalValue(resolve(pattern.right)) === undefined) return false;
  return readsPattern(pattern.left, value === missing ? pattern.right : value, resolve);
}

export function readsPattern(pattern, raw, resolve) {
  if (pattern.type === 'Identifier') return true;
  if (pattern.type === 'RestElement') return readsPattern(pattern.argument, raw, resolve);
  if (pattern.type === 'AssignmentPattern') return readsDefault(pattern, raw, resolve);
  const value = resolve(raw);
  if (pattern.type === 'ObjectPattern') return pattern.properties.every((part) => readsProperty(part, value, resolve));
  if (pattern.type !== 'ArrayPattern' || value?.type !== 'ArrayExpression') return false;
  return pattern.elements.every((part, index) => {
    if (!part) return true;
    if (part.type === 'RestElement') return part.argument.type === 'Identifier';
    return readsPattern(part, entryValue(value, String(index), resolve), resolve);
  });
}

function objectBinding(pattern, source, name, resolve, selectedKey) {
  const entry = pattern.properties.find((part) => {
    return contains(part.type === 'Property' ? part.value : part.argument, name);
  });
  if (!entry) return null;
  if (entry.type === 'RestElement') {
    const value = resolve(source, selectedKey);
    if (value?.type !== 'ObjectExpression' && value?.type !== 'ArrayExpression') return null;
    const omitted = pattern.properties.slice(0, -1).map((part) => propertyKey(part.key, part.computed, resolve));
    if (omitted.includes(null)) return null;
    // Rest copies own enumerable properties and excludes every key already bound.
    const spread = { type: 'SpreadElement', argument: value };
    return { type: 'ObjectExpression', properties: [spread], omittedKeys: omitted };
  }
  const key = propertyKey(entry.key, entry.computed, resolve);
  const value = resolve(source, key);
  const earlier = pattern.properties.slice(0, pattern.properties.indexOf(entry));
  if (!earlier.every((part) => readsProperty(part, value, resolve))) return null;
  return boundValue(entry.value, entryValue(value, key, resolve), name, resolve);
}

function arrayBinding(pattern, source, name, resolve, selectedKey) {
  const index = pattern.elements.findIndex((part) => contains(part, name));
  if (index < 0) return null;
  const part = pattern.elements[index];
  if (part.type === 'RestElement') {
    const tailIndex = Number(selectedKey);
    const key = String(tailIndex) === selectedKey && tailIndex >= 0 ? String(index + tailIndex) : undefined;
    const elements = arrayElements(resolve(source, key), resolve, Infinity);
    if (!elements) return null;
    const tail = { type: 'ArrayExpression', elements: elements.slice(index) };
    return boundValue(part.argument, tail, name, resolve);
  }
  const key = String(index);
  return boundValue(part, entryValue(resolve(source, key), key, resolve), name, resolve);
}

export function boundValue(pattern, source, name, resolve, selectedKey) {
  const raw = unwrapped(source);
  if (pattern === name) return raw === missing ? null : raw;
  if (pattern.type === 'AssignmentPattern') {
    const value = resolve(raw, selectedKey);
    const absent = value === missing || (value?.type === 'UnaryExpression' && value.operator === 'void');
    return boundValue(pattern.left, absent ? pattern.right : value, name, resolve);
  }
  if (pattern.type === 'ObjectPattern') return objectBinding(pattern, raw, name, resolve, selectedKey);
  if (pattern.type === 'ArrayPattern') return arrayBinding(pattern, raw, name, resolve, selectedKey);
  return null;
}
