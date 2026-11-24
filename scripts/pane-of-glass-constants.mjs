// Resolve a local const on the TypeScript tree Vite already parsed.
import { createRequire } from 'node:module';
import { parseSync, transformSync, Visitor } from 'rolldown/utils';

const require = createRequire(import.meta.url);

// The scope manager expects one name per namespace. Each segment shares the original
// declaration's source span so the bundler decides whether the whole chain emits a value.
function scopesFor(program) {
  const { analyze } = require('@typescript-eslint/scope-manager');
  const restore = [];
  new Visitor({
    TSModuleDeclaration(node) {
      const { id, body } = node;
      if (id.type !== 'TSQualifiedName') return;
      restore.push(() => Object.assign(node, { id, body }));
      while (node.id.type === 'TSQualifiedName') {
        const { left, right } = node.id;
        node.body = { ...node, id: right };
        node.id = left;
      }
    },
  }).visit(program);
  try {
    return analyze(program, { sourceType: 'module', lib: [], jsxPragma: null }).scopes;
  } finally {
    for (const reset of restore) reset();
  }
}

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
  // An erased declaration leaves the enclosing binding visible.
  if (!values.length && variable.defs.length) return undefined;
  if (values.length !== 1) return null;
  const { name, node, parent } = values[0];
  if (node.type !== 'VariableDeclarator' || node.id !== name || parent.kind !== 'const') return null;
  return node.init ?? null;
}

export function localConstLookup(program, file, source) {
  const references = new Map();
  for (const scope of scopesFor(program)) {
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
