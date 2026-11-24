// Read bindings from the same TypeScript tree used for the rest of the guard. Literal imports skip scope analysis.
import { createRequire } from 'node:module';
import { Visitor } from 'vite';
import { boundValue, missing } from './pane-of-glass-bindings.mjs';
import { literalValue, unwrapped } from './pane-of-glass-syntax.mjs';

const require = createRequire(import.meta.url);

function definesValue(definition) {
  if (!definition.isVariableDefinition) return false;
  return definition.node.importKind !== 'type' && definition.parent?.importKind !== 'type';
}

function fixedInitializer(variable, resolve) {
  const definitions = variable.defs.filter(definesValue);
  if (definitions.length !== 1) return null;
  const { node, name } = definitions[0];
  if (node.type !== 'VariableDeclarator') return null;
  if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
  return boundValue(node.id, node.init, name, resolve);
}

// Another use of the container may mutate it. Multiple destructurings of a flat literal share only primitive values.
function containerReads(program) {
  const patterns = new Set();
  const exported = new Set();
  new Visitor({
    VariableDeclarator({ id, init }) {
      if (id.type.endsWith('Pattern')) patterns.add(unwrapped(init));
    },
    ExportNamedDeclaration({ declaration }) {
      for (const item of declaration?.declarations ?? []) exported.add(item);
    },
  }).visit(program);
  return (variable, use, value) => {
    if (variable.defs.some((def) => exported.has(def.node))) return false;
    const others = variable.references.filter((ref) => ref.isRead() && ref.isValueReference && ref.identifier !== use);
    if (!others.length) return true;
    const parts = value.type === 'ArrayExpression' ? value.elements : value.properties.map((part) => part.value);
    const flat = parts.every((part) => literalValue(part) !== undefined);
    return flat && others.every((ref) => patterns.has(ref.identifier));
  };
}

function bindingResolver(program, scopes) {
  const bindings = new Map();
  for (const scope of scopes) {
    for (const ref of scope.references) bindings.set(ref.identifier, ref.resolved);
  }
  const stableContainer = containerReads(program);
  function resolve(identifier, seen = new Set()) {
    const variable = bindings.get(identifier);
    if (identifier.name === 'undefined' && !variable?.defs.length) return missing;
    if (!variable || seen.has(variable)) return null;
    const next = (name) => resolve(name, new Set(seen).add(variable));
    const initial = fixedInitializer(variable, next);
    const value = initial?.type === 'Identifier' ? next(initial) : initial;
    if (value?.type === 'ObjectExpression' || value?.type === 'ArrayExpression') {
      if (!stableContainer(variable, identifier, value)) return null;
    }
    return value;
  }
  return resolve;
}

export function localConstants(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const values = new Map();
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const resolve = bindingResolver(program, scopes);
  for (const scope of scopes) {
    for (const variable of scope.variables) {
      const initializer = fixedInitializer(variable, resolve);
      if (!initializer) continue;
      for (const ref of variable.references) values.set(ref.identifier, initializer);
    }
  }
  return values;
}
