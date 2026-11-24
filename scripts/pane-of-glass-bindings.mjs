// Follow a destructuring pattern only through values present in its literal initializer.
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

const missing = Symbol('missing literal entry');

function propertyKey(property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  const key = literalValue(property.key);
  return typeof key === 'string' || typeof key === 'number' ? String(key) : null;
}

function objectEntry(object, key) {
  if (object?.type !== 'ObjectExpression' || key === null) return null;
  // A later spread or computed key can override an earlier literal property.
  for (const entry of object.properties.toReversed()) {
    if (entry.type === 'SpreadElement') {
      const value = objectEntry(unwrapped(entry.argument), key);
      if (value !== missing) return value;
    } else {
      const name = propertyKey(entry);
      if (name === null) return null;
      if (name === key) return entry.kind === 'init' ? entry.value : null;
    }
  }
  return key in Object.prototype ? null : missing;
}

function arrayEntry(array, index) {
  if (array?.type !== 'ArrayExpression') return null;
  if (array.elements.slice(0, index + 1).some((part) => part?.type === 'SpreadElement')) return null;
  return array.elements[index] ?? missing;
}

function contains(pattern, name) {
  return pattern && pattern.start <= name.start && name.end <= pattern.end;
}

export function boundValue(pattern, source, name) {
  const value = unwrapped(source);
  if (pattern === name) return value === missing ? null : value;
  if (pattern.type === 'AssignmentPattern') {
    return boundValue(pattern.left, value === missing ? pattern.right : value, name);
  }
  if (pattern.type === 'ObjectPattern') {
    const entry = pattern.properties.find((part) => part.type === 'Property' && contains(part.value, name));
    if (entry) return boundValue(entry.value, objectEntry(value, propertyKey(entry)), name);
  }
  if (pattern.type === 'ArrayPattern') {
    const index = pattern.elements.findIndex((part) => contains(part, name));
    if (index >= 0) return boundValue(pattern.elements[index], arrayEntry(value, index), name);
  }
  return null;
}
