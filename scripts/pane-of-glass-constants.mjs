// Resolve a local const on the TypeScript tree Vite already parsed.
import { createRequire } from 'node:module';
import { parseSync, transformSync } from 'rolldown/utils';

const require = createRequire(import.meta.url);

function definesValue(definition, file, source) {
  if (!definition.isVariableDefinition) return false;
  const { node, parent } = definition;
  if (node.importKind === 'type' || parent?.importKind === 'type' || node.declare || parent?.declare) return false;
  if (node.type !== 'TSModuleDeclaration') return true;
  // The bundler emits a variable for a namespace that has runtime members. Type-only namespaces disappear.
  const emitted = transformSync(file, source.slice(node.start, node.end));
  if (emitted.errors.length) return true;
  return parseSync('namespace.js', emitted.code).program.body.some((part) => part.type === 'VariableDeclaration');
}

function constInitializer(variable, file, source) {
  const values = variable.defs.filter((def) => definesValue(def, file, source));
  if (!values.length && variable.defs.length) return undefined; // Erased; keep looking in the enclosing scope.
  if (values.length !== 1) return null;
  const { name, node, parent } = values[0];
  if (node.type !== 'VariableDeclarator' || node.id !== name || parent.kind !== 'const') return null;
  return node.init ?? null;
}

export function localConstLookup(program, file, source) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const { scopes } = analyze(program, { sourceType: 'module', lib: [], jsxPragma: null });
  const references = new Map();
  for (const scope of scopes) {
    for (const ref of scope.references) {
      if (ref.isValueReference) references.set(ref.identifier, ref.resolved);
    }
  }
  const bindings = new Map();
  return (identifier) => {
    const variable = references.get(identifier);
    for (let scope = variable?.scope; scope; scope = scope.upper) {
      const candidate = scope.set.get(identifier.name);
      if (!candidate) continue;
      if (!bindings.has(candidate)) bindings.set(candidate, constInitializer(candidate, file, source));
      const value = bindings.get(candidate);
      if (value !== undefined) return value;
    }
    return null;
  };
}
