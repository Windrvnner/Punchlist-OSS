// Resolve an import argument in its lexical scope. Most UI files have only literal imports and skip this pass.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function localConstants(file, source) {
  const { parse } = require('@babel/parser');
  const { default: traverse } = require('@babel/traverse');
  const plugins = file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'];
  const ast = parse(source, { sourceType: 'module', sourceFilename: file, plugins });
  const values = new Map();
  traverse(ast, {
    ReferencedIdentifier(path) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) return;
      const { id, init } = binding.path.node;
      if (id.type === 'Identifier' && init) values.set(path.node.start, init);
    },
  });
  return values;
}
