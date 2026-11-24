// Track uses that can change a named literal before a primitive path is copied out of it.
import { Visitor } from 'vite';
import { entryValue, missing, propertyKey } from './pane-of-glass-bindings.mjs';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

function selectedKeys(pattern, member, resolve) {
  if (member) return [propertyKey(member.property, member.computed, resolve)];
  if (pattern?.type === 'ArrayPattern') {
    if (pattern.elements.some((part) => part?.type === 'RestElement')) return [];
    return pattern.elements.flatMap((part, index) => part ? [String(index)] : []);
  }
  if (pattern?.type !== 'ObjectPattern') return [];
  return pattern.properties.map((part) => {
    return part.type === 'Property' ? propertyKey(part.key, part.computed, resolve) : null;
  });
}

function usesIn(program) {
  const patterns = new Map();
  const receivers = new Set();
  const members = new Map();
  const spreads = new Set();
  const exported = new Set();
  const writeTargets = [];
  const blocks = new Map();
  function declarations(block) {
    for (const statement of block.body) {
      const variable = statement.declaration ?? statement;
      if (variable.type !== 'VariableDeclaration') continue;
      for (const item of variable.declarations) blocks.set(item, block);
    }
  }
  new Visitor({
    Program: declarations,
    BlockStatement: declarations,
    VariableDeclarator({ id, init }) {
      if (id.type.endsWith('Pattern')) patterns.set(unwrapped(init), id);
    },
    ExportNamedDeclaration({ declaration }) {
      for (const item of declaration?.declarations ?? []) exported.add(item);
    },
    MemberExpression: (node) => members.set(unwrapped(node.object), node),
    SpreadElement: (node) => spreads.add(unwrapped(node.argument)),
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
  return { patterns, members, spreads, receivers, exported, writeTargets, blocks };
}

function primitive(container, key, resolve) {
  return literalValue(resolve(entryValue(container, key, resolve))) !== undefined;
}

function readsSelection(identifier, value, keys, uses, resolve) {
  const member = uses.members.get(identifier);
  if (member && uses.receivers.has(member)) return false;
  const reads = selectedKeys(uses.patterns.get(identifier), member, resolve);
  if (!reads.length || reads.includes(null)) return false;
  const target = member && uses.writeTargets.find((part) => part.start <= member.start && member.end <= part.end);
  return reads.every((key) => {
    // A direct write to another data property leaves the tracked entry alone.
    if (target && (target !== member || keys.includes(key))) return false;
    if (!target && primitive(value, key, resolve)) return true;
    const entry = entryValue(value, key, resolve);
    return keys.length && !keys.includes(null) && !keys.includes(key) && entry && entry !== missing;
  });
}

function captureDeclaration(variable, capture, blocks) {
  const block = blocks.get(variable.defs.find((def) => blocks.has(def.node))?.node);
  if (!block) return null;
  for (const [declaration, owner] of blocks) {
    const init = declaration.init;
    if (owner === block && init && init.start <= capture.start && capture.end <= init.end) return declaration;
  }
  return null;
}

export function containerReads(program, scopeOf) {
  const uses = usesIn(program);
  return (variable, use, value, capture, resolve) => {
    if (variable.defs.some((def) => uses.exported.has(def.node))) return false;
    const keys = selectedKeys(uses.patterns.get(capture), uses.members.get(capture), resolve);
    const parts = value.type === 'ArrayExpression' ? value.elements : value.properties.map((part) => part.value);
    const flat = parts.every((part) => literalValue(part) !== undefined);
    const scope = scopeOf(capture);
    const snapshots = keys.length && keys.every((key) => key !== null && primitive(value, key, resolve));
    const captured = scope === variable.scope && snapshots && captureDeclaration(variable, capture, uses.blocks);
    return variable.references.every((ref) => {
      if (!ref.isRead() || !ref.isValueReference || ref.identifier === use) return true;
      // A later statement cannot change a primitive already copied in this invocation.
      if (captured && ref.from.variableScope === scope.variableScope && ref.identifier.start > captured.end) return true;
      if (flat && uses.spreads.has(ref.identifier)) return true;
      return readsSelection(ref.identifier, value, keys, uses, resolve);
    });
  };
}
