// docs/architecture.md, Layers: only the shell wires adapters in, so the app and the backend never import them (#648).
// The imports are found by the UI check's own scan (scripts/pane-of-glass-matches.mjs).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsIn } from '../../scripts/pane-of-glass-matches.mjs';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function intoAdapters(file: string) {
  const folder = path.posix.dirname(file);
  return (name: string) => name.startsWith('.') && path.posix.join(folder, name).startsWith('src/adapters/');
}

function adapterImports(file: string, source: string) {
  return importsIn(file, source, intoAdapters(file)).map((line) => `${file}:${line}`);
}

describe('layering', () => {
  it('finds an import of adapters in every form a module can load one', () => {
    const source = [
      "import { a } from '../adapters/a';",
      "import '../adapters/b';",
      "export * from '../adapters/c';",
      "type D = import('../adapters/d').D;",
      "const e = await import('../adapters/e');",
      "const g = require('../adapters/g');",
      "import h = require('../adapters/h');",
      "import { f } from '../domain/f';",
    ].join('\n');
    const expected = [1, 2, 3, 4, 5, 6, 7].map((line) => `src/backend/x.ts:${line}`);
    expect(adapterImports('src/backend/x.ts', source)).toEqual(expected);
  });

  it.each(['app', 'backend'])('%s never imports adapters', (layer) => {
    const files = sourceFiles(`src/${layer}`);
    expect(files.flatMap((file) => adapterImports(file, readFileSync(file, 'utf8')))).toEqual([]);
  });
});
