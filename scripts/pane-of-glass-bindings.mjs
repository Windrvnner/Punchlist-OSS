// Follow a destructuring pattern only through values present in its literal initializer.
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

export const missing = Symbol('missing literal entry');

export function propertyKey(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  const key = literalValue(node);
  return typeof key === 'string' || typeof key === 'number' ? String(key) : null;
}

function propertyValue(entry, key) {
  if (entry.type === 'SpreadElement') return objectEntry(unwrapped(entry.argument), key);
  const name = propertyKey(entry.key, entry.computed);
  if (name === null) return null;
  if (name !== key) return missing;
  return entry.kind === 'init' ? entry.value : null;
}

function objectEntry(object, key) {
  if (object?.type !== 'ObjectExpression' || key === null) return null;
  // A later spread or computed key can override an earlier literal property.
  for (const entry of object.properties.toReversed()) {
    const value = propertyValue(entry, key);
    if (value !== missing) return value;
  }
  return key in Object.prototype ? null : missing;
}

function arrayEntry(array, index) {
  if (array?.type !== 'ArrayExpression') return null;
  if (array.elements.slice(0, index + 1).some((part) => part?.type === 'SpreadElement')) return null;
  return array.elements[index] ?? missing;
}

export function memberValue(container, member) {
  const key = propertyKey(member.property, member.computed);
  if (container?.type === 'ArrayExpression') {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? arrayEntry(container, index) : null;
  }
  return objectEntry(container, key);
}

function contains(pattern, name) {
  return pattern && pattern.start <= name.start && name.end <= pattern.end;
}

export function boundValue(pattern, source, name, resolve) {
  const raw = unwrapped(source);
  if (pattern === name) return raw === missing ? null : raw;
  const value = resolve(raw);
  if (pattern.type === 'AssignmentPattern') {
    const absent = value === missing || (value?.type === 'UnaryExpression' && value.operator === 'void');
    return boundValue(pattern.left, absent ? pattern.right : value, name, resolve);
  }
  if (pattern.type === 'ObjectPattern') {
    const entry = pattern.properties.find((part) => part.type === 'Property' && contains(part.value, name));
    if (entry) {
      const key = propertyKey(entry.key, entry.computed);
      return boundValue(entry.value, objectEntry(value, key), name, resolve);
    }
  }
  if (pattern.type === 'ArrayPattern') {
    const index = pattern.elements.findIndex((part) => contains(part, name));
    if (index >= 0) return boundValue(pattern.elements[index], arrayEntry(value, index), name, resolve);
  }
  return null;
}
