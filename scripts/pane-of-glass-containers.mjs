// Track uses that can change a named literal before a primitive path is copied out of it.
import { Visitor } from 'vite';
import { resizedArray } from './pane-of-glass-arrays.mjs';
import { entryValue, propertyKey, readsPattern } from './pane-of-glass-bindings.mjs';
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
  const assignments = new Map();
  function declarations(block) {
    let last;
    for (const statement of block.body) {
      const expression = statement.expression;
      if (expression?.type === 'AssignmentExpression' && expression.operator === '=') {
        assignments.set(unwrapped(expression.left), { block, expression });
      }
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
  return { patterns, members, spreads, receivers, exported, writeTargets, blocks, previous, assignments };
}

function primitive(container, key, resolve) {
  const entry = resolve(entryValue(container, key, resolve));
  return entry === missing || literalValue(entry) !== undefined;
}

function separateEntry(value, key, keys, resolve) {
  const entry = entryValue(value, key, resolve);
  return keys.length && !keys.includes(null) && !keys.includes(key) && entry && entry !== missing;
}

function writeKeepsSelection(value, key, keys, member, target, resolve, recordResize) {
  if (target !== member) return false;
  if (value.type === 'ArrayExpression') {
    if (key === 'length') return recordResize(member);
    if (keys.includes('length')) return false;
  }
  return separateEntry(value, key, keys, resolve);
}

function readsSelection(identifier, value, keys, uses, resolve, recordResize) {
  const member = uses.members.get(identifier);
  if (member && uses.receivers.has(member)) return false;
  const pattern = uses.patterns.get(identifier);
  if (pattern) {
    if (!readsPattern(pattern, value, resolve)) return false;
    // Rest and nested bindings can only copy a selected primitive. References to other entries cannot replace it.
    if (keys.length && keys.every((key) => key !== null && primitive(value, key, resolve))) return true;
  }
  const reads = selectedKeys(pattern, member, resolve);
  if (!reads.length || reads.includes(null)) return false;
  const target = member && uses.writeTargets.find((part) => part.start <= member.start && member.end <= part.end);
  return reads.every((key) => {
    if (target) return writeKeepsSelection(value, key, keys, member, target, resolve, recordResize);
    return primitive(value, key, resolve) || separateEntry(value, key, keys, resolve);
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
    return { block, end: declaration.end, immediate: direct && uses.previous.get(declaration) === created };
  }
  return null;
}

function afterCapture(ref, captured, scope) {
  if (!captured) return false;
  if (ref.from.variableScope === scope.variableScope) return ref.identifier.start > captured.end;
  // No deferred code can run between consecutive creation and a direct primitive capture.
  return captured.immediate;
}

function fixedLengthWrite(member, location, declaration, uses, resolve, writes) {
  const step = uses.assignments.get(member);
  if (!step || step.block !== declaration?.block || step.expression.end >= location.start) return false;
  const length = literalValue(resolve(step.expression.right));
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) return false;
  writes.set(step.expression.start, length);
  return true;
}

function flatLiteral(value) {
  if (value.original) return flatLiteral(value.original);
  if (value.slots) return [...value.slots.entries.values()].every((part) => literalValue(part) !== undefined);
  const parts = value.type === 'ArrayExpression' ? value.elements : value.properties.map((part) => part.value);
  return parts.every((part) => literalValue(part) !== undefined);
}

export function containerReads(program, scopeOf, aliases) {
  const uses = usesIn(program);
  function stable(variable, use, value, capture, resolve, writes, seen = new Set()) {
    if (seen.has(variable)) return false;
    if (variable.defs.some((def) => uses.exported.has(def.node))) return false;
    const { use: location, key } = capture;
    const keys = key === undefined
      ? selectedKeys(uses.patterns.get(location), uses.members.get(location), resolve)
      : [key];
    const flat = flatLiteral(value);
    const scope = scopeOf(location);
    const snapshots = keys.length && keys.every((key) => key !== null && primitive(value, key, resolve));
    const declaration = scope === variable.scope && captureDeclaration(variable, location, uses);
    const captured = snapshots && declaration;
    const recordResize = (member) => fixedLengthWrite(member, location, declaration, uses, resolve, writes);
    return variable.references.every((ref) => {
      if (!ref.isRead() || !ref.isValueReference || ref.identifier === use) return true;
      if (afterCapture(ref, captured, scope)) return true;
      if (flat && uses.spreads.has(ref.identifier)) return true;
      const alias = aliases.get(ref.identifier);
      if (alias) return stable(alias, null, value, capture, resolve, writes, new Set(seen).add(variable));
      return readsSelection(ref.identifier, value, keys, uses, resolve, recordResize);
    });
  }
  return (variable, use, value, capture, resolve) => {
    const writes = new Map();
    if (!stable(variable, use, value, capture, resolve, writes)) return null;
    return resizedArray(value, writes);
  };
}
