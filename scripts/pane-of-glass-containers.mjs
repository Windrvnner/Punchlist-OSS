// Track uses that can change a named literal before a primitive path is copied out of it.
import { Visitor } from 'vite';
import { entryValue, propertyKey } from './pane-of-glass-bindings.mjs';
import { literalValue, missing, unwrapped } from './pane-of-glass-syntax.mjs';

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
  const previous = new Map();
  function declarations(block) {
    let last;
    for (const statement of block.body) {
      const variable = statement.declaration ?? statement;
      if (variable.type !== 'VariableDeclaration') last = null;
      for (const item of variable.declarations ?? []) {
        previous.set(item, last);
        blocks.set(item, block);
        last = item;
      }
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
  return { patterns, members, spreads, receivers, exported, writeTargets, blocks, previous };
}

function primitive(container, key, resolve) {
  const entry = resolve(entryValue(container, key, resolve));
  return entry === missing || literalValue(entry) !== undefined;
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

function captureDeclaration(variable, capture, uses) {
  const created = variable.defs.find((def) => uses.blocks.has(def.node))?.node;
  const block = uses.blocks.get(created);
  if (!block) return null;
  for (const [declaration, owner] of uses.blocks) {
    const init = declaration.init;
    if (owner !== block || !init || init.start > capture.start || capture.end > init.end) continue;
    const source = unwrapped(init);
    const direct = source === capture || (source.type === 'MemberExpression' && unwrapped(source.object) === capture);
    return { end: declaration.end, immediate: direct && uses.previous.get(declaration) === created };
  }
  return null;
}

function afterCapture(ref, captured, scope) {
  if (!captured) return false;
  if (ref.from.variableScope === scope.variableScope) return ref.identifier.start > captured.end;
  // No deferred code can run between consecutive creation and a direct primitive capture.
  return captured.immediate;
}

export function containerReads(program, scopeOf, aliases) {
  const uses = usesIn(program);
  function stable(variable, use, value, capture, resolve, seen = new Set()) {
    if (seen.has(variable)) return false;
    if (variable.defs.some((def) => uses.exported.has(def.node))) return false;
    const { use: location, key } = capture;
    const keys = key === undefined
      ? selectedKeys(uses.patterns.get(location), uses.members.get(location), resolve)
      : [key];
    const parts = value.type === 'ArrayExpression' ? value.elements : value.properties.map((part) => part.value);
    const flat = parts.every((part) => literalValue(part) !== undefined);
    const scope = scopeOf(location);
    const snapshots = keys.length && keys.every((key) => key !== null && primitive(value, key, resolve));
    const captured = scope === variable.scope && snapshots && captureDeclaration(variable, location, uses);
    return variable.references.every((ref) => {
      if (!ref.isRead() || !ref.isValueReference || ref.identifier === use) return true;
      if (afterCapture(ref, captured, scope)) return true;
      if (flat && uses.spreads.has(ref.identifier)) return true;
      const alias = aliases.get(ref.identifier);
      if (alias) return stable(alias, null, value, capture, resolve, new Set(seen).add(variable));
      return readsSelection(ref.identifier, value, keys, uses, resolve);
    });
  }
  return stable;
}
