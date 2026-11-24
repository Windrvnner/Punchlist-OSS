// Resolve references on Vite's TypeScript syntax tree. A type can share a name with an unrelated runtime value.
import { createRequire } from 'node:module';

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

export function localBindings(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const bindings = new Map();
  for (const scope of scopes) {
    for (const ref of scope.references) bindings.set(ref.identifier, ref.resolved);
  }
  return (identifier) => {
    const definition = fixedDeclaration(bindings.get(identifier));
    if (!definition || definition.node.id !== definition.name) return null;
    return definition.node.init;
  };
}
