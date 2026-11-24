// A named literal may be changed through a write, method call, or alias that escapes the file.
import { Visitor } from 'vite';
import { memberValue, missing, propertyKey } from './pane-of-glass-bindings.mjs';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

function selectedKeys(pattern, member) {
  if (member) return [propertyKey(member.property, member.computed)];
  if (pattern?.type === 'ArrayPattern') {
    if (pattern.elements.some((part) => part?.type === 'RestElement')) return [];
    return pattern.elements.flatMap((part, index) => part ? [String(index)] : []);
  }
  if (pattern?.type !== 'ObjectPattern') return [];
  return pattern.properties.map((part) => part.type === 'Property' ? propertyKey(part.key, part.computed) : null);
}

export function containerReads(program) {
  const patterns = new Map();
  const receivers = new Set();
  const members = new Map();
  const exported = new Set();
  const writeTargets = [];
  new Visitor({
    VariableDeclarator({ id, init }) {
      if (id.type.endsWith('Pattern')) patterns.set(unwrapped(init), id);
    },
    ExportNamedDeclaration({ declaration }) {
      for (const item of declaration?.declarations ?? []) exported.add(item);
    },
    MemberExpression(node) {
      members.set(unwrapped(node.object), node);
    },
    CallExpression: (node) => receivers.add(unwrapped(node.callee)),
    TaggedTemplateExpression: (node) => receivers.add(unwrapped(node.tag)),
    AssignmentExpression: (node) => writeTargets.push(node.left),
    UpdateExpression: (node) => writeTargets.push(node.argument),
    ForInStatement: (node) => writeTargets.push(node.left),
    ForOfStatement: (node) => writeTargets.push(node.left),
    UnaryExpression(node) {
      if (node.operator === 'delete') writeTargets.push(node.argument);
    },
  }).visit(program);

  function readsMember(identifier, container, keys) {
    const member = members.get(identifier);
    if (!member || receivers.has(member)) return false;
    if (writeTargets.some((target) => target.start <= member.start && member.end <= target.end)) return false;
    const entry = memberValue(container, member);
    if (literalValue(entry) !== undefined) return true;
    // Reading a separate data property cannot replace the property being destructured.
    if (!entry || entry === missing || !keys.length || keys.includes(null)) return false;
    return !keys.includes(propertyKey(member.property, member.computed));
  }

  return (variable, use, value) => {
    if (variable.defs.some((def) => exported.has(def.node))) return false;
    const parts = value.type === 'ArrayExpression' ? value.elements : value.properties.map((part) => part.value);
    const flat = parts.every((part) => literalValue(part) !== undefined);
    const keys = selectedKeys(patterns.get(use), members.get(use));
    return variable.references.every((ref) => {
      if (!ref.isRead() || !ref.isValueReference || ref.identifier === use) return true;
      return (flat && patterns.has(ref.identifier)) || readsMember(ref.identifier, value, keys);
    });
  };
}
