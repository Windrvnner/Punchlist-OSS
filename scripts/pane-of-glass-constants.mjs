// Read bindings from the same TypeScript tree used for the rest of the guard. Literal imports skip scope analysis.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fixedInitializer(variable) {
  if (variable.defs.length !== 1) return null;
  const { node } = variable.defs[0];
  if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return null;
  if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
  return node.init;
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
