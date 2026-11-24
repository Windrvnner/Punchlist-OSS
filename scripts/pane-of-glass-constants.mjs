// Index only runtime references to a simple const declaration on the TypeScript tree Vite already parsed.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function definesValue(definition) {
  if (!definition.isVariableDefinition) return false;
  return definition.node.importKind !== 'type' && definition.parent?.importKind !== 'type';
}

function constInitializer(variable) {
  const values = variable.defs.filter(definesValue);
  if (values.length !== 1) return null;
  const { name, node, parent } = values[0];
  if (node.type !== 'VariableDeclarator' || node.id !== name || parent.kind !== 'const') return null;
  return node.init;
}

export function constInitializers(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const initializers = new Map();
  for (const scope of scopes) {
    for (const variable of scope.variables) {
      const init = constInitializer(variable);
      if (!init) continue;
      for (const ref of variable.references) {
        if (ref.isValueReference) initializers.set(ref.identifier, init);
      }
    }
  }
  return initializers;
}
