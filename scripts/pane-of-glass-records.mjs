// Recognize the string copied by a simple property binding on a local data record.
import { Visitor } from 'vite';
import { literalText, unwrapped } from './pane-of-glass-syntax.mjs';

function keyName(raw, computed) {
  const key = unwrapped(raw);
  if (!computed && (key.type === 'Identifier' || key.type === 'JSXIdentifier')) return key.name;
  if (typeof key.value === 'number') return String(key.value);
  return literalText(key);
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

function literalData(expression) {
  const node = unwrapped(expression);
  return node?.type === 'Literal' || literalText(node) !== null;
}

function simplePattern(pattern, properties) {
  if (pattern?.type !== 'ObjectPattern') return false;
  return pattern.properties.every((part) => {
    if (part.type !== 'Property') return false;
    const value = properties.get(keyName(part.key, part.computed));
    if (!value) return false;
    let target = unwrapped(part.value);
    if (target.type === 'AssignmentPattern') {
      if (!literalData(value) && !literalData(target.right)) return false;
      target = unwrapped(target.left);
    }
    // Assignments may copy into a display field. markTarget checks the destination independently.
    return target.type === 'Identifier' || target.type === 'MemberExpression';
  });
}

// Computed keys in an assignment target are reads. Only its assigned leaves are writes.
function markTarget(target, effects) {
  const node = unwrapped(target);
  if (!node) return;
  if (node.type === 'ObjectPattern') {
    for (const part of node.properties) markTarget(part.value ?? part.argument, effects);
  } else if (node.type === 'ArrayPattern') {
    for (const part of node.elements) markTarget(part, effects);
  } else if (node.type === 'AssignmentPattern' || node.type === 'RestElement') {
    markTarget(node.left ?? node.argument, effects);
  } else {
    effects.add(node);
  }
}

function recordUses(program) {
  const members = new Map();
  const patterns = new Map();
  const effects = new Set();
  const write = (target) => markTarget(target, effects);
  const exported = new Set();
  const typeNames = new Set();
  const blocks = new Map();
  function declarations(block) {
    for (const statement of block.body) {
      const declaration = statement.declaration ?? statement;
      for (const item of declaration.declarations ?? []) blocks.set(item, block);
    }
  }
  const member = (node) => members.set(unwrapped(node.object), node);
  new Visitor({
    Program: declarations,
    BlockStatement: declarations,
    TSModuleBlock: declarations,
    TSTypeQuery(node) {
      let name = node.exprName;
      while (name.type === 'TSQualifiedName') name = name.left;
      typeNames.add(name);
    },
    MemberExpression: member,
    JSXMemberExpression: member,
    VariableDeclarator: (node) => patterns.set(unwrapped(node.init), node.id),
    // A destructuring assignment returns its input. A standalone statement discards that reference.
    ExpressionStatement(node) {
      const assignment = unwrapped(node.expression);
      if (assignment.type === 'AssignmentExpression' && assignment.operator === '=') {
        patterns.set(unwrapped(assignment.right), assignment.left);
      }
    },
    AssignmentExpression: (node) => write(node.left),
    UpdateExpression: (node) => write(node.argument),
    ForInStatement: (node) => write(node.left),
    ForOfStatement: (node) => write(node.left),
    UnaryExpression(node) {
      if (node.operator === 'delete') write(node.argument);
    },
    CallExpression: (node) => effects.add(unwrapped(node.callee)),
    TaggedTemplateExpression: (node) => effects.add(unwrapped(node.tag)),
    ExportNamedDeclaration(node) {
      for (const item of node.declaration?.declarations ?? []) exported.add(item);
      for (const specifier of node.specifiers) exported.add(specifier.local);
    },
  }).visit(program);
  return { members, patterns, effects, exported, blocks, typeNames };
}

// A plain property read or destructuring copies data without exposing the record itself.
function readsData(id, properties, uses) {
  if (simplePattern(uses.patterns.get(id), properties)) return true;
  const member = uses.members.get(id);
  if (!member || !properties.has(keyName(member.property, member.computed))) return false;
  return !uses.effects.has(member);
}

// A literal own value is defined, so JavaScript skips that property's fallback expression.
function inactiveDefaults(refs, properties, uses) {
  const defaults = [];
  for (const ref of refs) {
    const pattern = uses.patterns.get(ref.identifier);
    if (!simplePattern(pattern, properties)) continue;
    for (const part of pattern.properties) {
      const value = properties.get(keyName(part.key, part.computed));
      if (part.value.type === 'AssignmentPattern' && literalData(value)) defaults.push(part.value.right);
    }
  }
  return defaults;
}

function stableAtCapture(origin, capture, scope, refs, properties, uses) {
  if (uses.exported.has(origin.node)) return false;
  const block = uses.blocks.get(origin.node);
  const ordered = block && block === uses.blocks.get(capture) && origin.node.end <= capture.start;
  const inactive = inactiveDefaults(refs, properties, uses);
  return refs.every((ref) => {
    if (inactive.some((expr) => expr.start <= ref.identifier.start && ref.identifier.end <= expr.end)) return true;
    if (ref.identifier === origin.name || uses.typeNames.has(ref.identifier)) return true;
    if (uses.exported.has(ref.identifier)) return false;
    // A later statement in the same execution cannot change a string already copied.
    if (ordered && ref.from.variableScope === scope.variableScope && ref.identifier.start >= capture.end) return true;
    return readsData(ref.identifier, properties, uses);
  });
}

function capturedValue(properties, pattern, name) {
  if (!properties || !simplePattern(pattern, properties)) return null;
  const part = pattern.properties.find((entry) => entry.value === name);
  return part ? properties.get(keyName(part.key, part.computed)) : null;
}

export function recordCaptures(program, references, definitionFor) {
  const uses = recordUses(program);
  const byName = Map.groupBy(references.values(), (ref) => ref.identifier.name);
  return ({ node, name }) => {
    const source = unwrapped(node.init);
    const origin = source?.type === 'Identifier' ? definitionFor(source) : null;
    if (origin && origin.node.id !== origin.name) return null;
    const properties = propertiesOf(origin ? unwrapped(origin.node.init) : source);
    const value = capturedValue(properties, node.id, name);
    if (!value || !origin) return value;
    const refs = byName.get(origin.name.name).filter((ref) => definitionFor(ref.identifier) === origin);
    return stableAtCapture(origin, node, references.get(source).from, refs, properties, uses) ? value : null;
  };
}
