// Resolve references on Vite's TypeScript syntax tree. A type can share a name with an unrelated runtime value.
import { createRequire } from 'node:module';
import { containerReads } from './pane-of-glass-containers.mjs';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';
import { boundValue, memberValue, missing } from './pane-of-glass-bindings.mjs';

const require = createRequire(import.meta.url);

function definesValue(definition) {
  if (!definition.isVariableDefinition) return false;
  return definition.node.importKind !== 'type' && definition.parent?.importKind !== 'type';
}

function fixedDeclaration(variable) {
  const definitions = variable?.defs.filter(definesValue) ?? [];
  if (definitions.length !== 1) return null;
  if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
  return definitions[0].node.type === 'VariableDeclarator' ? definitions[0] : null;
}

// A fixed test selects only the branch JavaScript would use. A runtime test keeps both possible paths.
function selectedBranch(node, resolve) {
  const test = resolve(node.test ?? node.left);
  const value = literalValue(test);
  const absent = test === missing || (test?.type === 'UnaryExpression' && test.operator === 'void');
  if (value === undefined && !absent) return node;
  if (node.type === 'ConditionalExpression') return value ? node.consequent : node.alternate;
  if (node.operator === '??') return value == null ? node.right : node.left;
  if (node.operator === '||') return value ? node.left : node.right;
  return value ? node.right : node.left;
}

export function localBindings(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const bindings = new Map();
  for (const scope of scopes) {
    for (const ref of scope.references) bindings.set(ref.identifier, ref.resolved);
  }
  const stableContainer = containerReads(program);
  function resolveVariable(reference, seen, capture) {
    const variable = bindings.get(reference);
    if (reference.name === 'undefined' && !variable?.defs.length) return missing;
    const definition = fixedDeclaration(variable);
    if (!definition || seen.has(variable)) return null;
    const visited = new Set(seen).add(variable);
    const next = (ref) => resolve(ref, visited);
    const { node, name } = definition;
    const initial = boundValue(node.id, node.init, name, next);
    // A direct alias keeps the key selected by its eventual destructuring or member read.
    const alias = node.id === name && initial?.type === 'Identifier';
    const value = alias ? resolve(initial, visited, capture) : next(initial);
    if (value?.type === 'ObjectExpression' || value?.type === 'ArrayExpression') {
      if (!stableContainer(variable, reference, value, capture)) return null;
    }
    return value;
  }

  function resolve(expression, seen = new Set(), capture = unwrapped(expression)) {
    const reference = unwrapped(expression);
    if (reference?.type === 'ConditionalExpression' || reference?.type === 'LogicalExpression') {
      const branch = selectedBranch(reference, (part) => resolve(part, seen));
      return branch === reference ? reference : resolve(branch, seen);
    }
    if (reference?.type === 'MemberExpression') {
      if (seen.has(reference)) return null;
      const visited = new Set(seen).add(reference);
      return resolve(memberValue(resolve(reference.object, visited), reference), visited);
    }
    return reference?.type === 'Identifier' ? resolveVariable(reference, seen, capture) : reference;
  }
  return resolve;
}
