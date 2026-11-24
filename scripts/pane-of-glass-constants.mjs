// Resolve references on Vite's TypeScript syntax tree. A type can share a name with an unrelated runtime value.
import { createRequire } from 'node:module';
import { containerReads } from './pane-of-glass-containers.mjs';
import { foldedValue, literalValue, missing, unwrapped } from './pane-of-glass-syntax.mjs';
import { boundValue, entryValue, propertyKey } from './pane-of-glass-bindings.mjs';

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

function containerAliases(scopes) {
  const aliases = new Map();
  for (const scope of scopes) {
    for (const variable of scope.variables) {
      const declaration = fixedDeclaration(variable);
      if (!declaration || declaration.node.id !== declaration.name) continue;
      const source = unwrapped(declaration.node.init);
      if (source?.type === 'Identifier') aliases.set(source, variable);
    }
  }
  return aliases;
}

export function localBindings(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const bindings = new Map();
  for (const scope of scopes) {
    for (const ref of scope.references) bindings.set(ref.identifier, ref);
  }
  const stableContainer = containerReads(program, (ref) => bindings.get(ref)?.from, containerAliases(scopes));
  function resolveVariable(reference, seen, capture) {
    const variable = bindings.get(reference)?.resolved;
    if (reference.name === 'undefined' && !variable?.defs.length) return missing;
    const definition = fixedDeclaration(variable);
    if (!definition || seen.has(variable)) return null;
    const visited = new Set(seen).add(variable);
    const next = (ref, key) => resolve(ref, visited, { use: unwrapped(ref), key });
    const { node, name } = definition;
    const initial = boundValue(node.id, node.init, name, next, capture.key);
    // A direct alias keeps the key selected by its eventual destructuring or member read.
    const alias = node.id === name && initial?.type === 'Identifier';
    const value = alias ? resolve(initial, visited, capture) : next(initial);
    if (value?.type === 'ObjectExpression' || value?.type === 'ArrayExpression') {
      if (!stableContainer(variable, reference, value, capture, next)) return null;
    }
    return value;
  }

  function resolve(expression, seen = new Set(), capture = { use: unwrapped(expression) }) {
    const reference = unwrapped(expression);
    if (reference?.type === 'ConditionalExpression' || reference?.type === 'LogicalExpression') {
      const branch = selectedBranch(reference, (part) => resolve(part, seen));
      return branch === reference ? reference : resolve(branch, seen);
    }
    if (reference?.type === 'MemberExpression') {
      if (seen.has(reference)) return null;
      const visited = new Set(seen).add(reference);
      const next = (part) => resolve(part, visited);
      const key = propertyKey(reference.property, reference.computed, next);
      const object = resolve(reference.object, visited, { use: unwrapped(reference.object), key });
      return next(entryValue(object, key, next));
    }
    if (reference?.type === 'Identifier') return resolveVariable(reference, seen, capture);
    return reference ? foldedValue(reference, (part) => resolve(part, seen)) : reference;
  }
  return resolve;
}
