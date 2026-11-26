// docs/architecture.md, Layers: only the shell wires adapters in, so the app and the backend never import them (#648).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const importFrom = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function adapterImports(layer: string) {
  return sourceFiles(path.join('src', layer)).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const targets = [...source.matchAll(importFrom)].map((match) => match[1] ?? match[2]);
    const fromAdapters = targets.filter((target) => {
      const resolved = path.posix.join(path.posix.dirname(file.split(path.sep).join('/')), target);
      return target.startsWith('.') && resolved.startsWith('src/adapters/');
    });
    return fromAdapters.map((target) => `${file}: ${target}`);
  });
}

describe('layering', () => {
  it.each(['app', 'backend'])('%s never imports adapters', (layer) => {
    expect(adapterImports(layer)).toEqual([]);
  });
});
