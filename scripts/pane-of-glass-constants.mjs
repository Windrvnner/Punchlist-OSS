// Read bindings from the same TypeScript tree used for the rest of the guard. Literal imports skip scope analysis.
import { createRequire } from 'node:module';
import { boundValue } from './pane-of-glass-bindings.mjs';

const require = createRequire(import.meta.url);

function definesValue(definition) {
  if (!definition.isVariableDefinition) return false;
  return definition.node.importKind !== 'type' && definition.parent?.importKind !== 'type';
}

function fixedInitializer(variable) {
  const definitions = variable.defs.filter(definesValue);
  if (definitions.length !== 1) return null;
  const { node, name } = definitions[0];
  if (node.type !== 'VariableDeclarator') return null;
  if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
  return boundValue(node.id, node.init, name);
}

export function localConstants(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const values = new Map();
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  for (const scope of scopes) {
    for (const variable of scope.variables) {
      const initializer = fixedInitializer(variable);
      if (!initializer) continue;
      for (const ref of variable.references) values.set(ref.identifier, initializer);
    }
  }
  return values;
}
