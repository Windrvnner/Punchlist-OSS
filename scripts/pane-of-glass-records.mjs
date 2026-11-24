// Recognize the string copied by a simple property binding on a local data record.

function keyName(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && ['string', 'number'].includes(typeof key.value)) return String(key.value);
  return null;
}

function propertiesOf(literal) {
  if (literal?.type !== 'ObjectExpression') return null;
  const properties = new Map();
  for (const entry of literal.properties) {
    if (entry.type !== 'Property' || entry.kind !== 'init' || entry.method) return null;
    const key = keyName(entry.key, entry.computed);
    if (key === null || key === '__proto__') return null;
    properties.set(key, entry.value);
  }
  return properties;
}

function simplePattern(pattern, properties) {
  return pattern?.type === 'ObjectPattern' && pattern.properties.every((part) =>
    part.type === 'Property' && part.value.type === 'Identifier' && properties.has(keyName(part.key, part.computed)));
}

export function capturedValue(pattern, literal, name) {
  const properties = propertiesOf(literal);
  if (!properties || !simplePattern(pattern, properties)) return null;
  const part = pattern.properties.find((entry) => entry.value === name);
  return part ? properties.get(keyName(part.key, part.computed)) : null;
}
