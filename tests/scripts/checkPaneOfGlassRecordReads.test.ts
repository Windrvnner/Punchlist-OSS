// @vitest-environment node
import { expect, it } from 'vitest';
import { fixture, loadCompiledFixture } from './paneOfGlassFixture';

it('keeps a captured path across fixed computed keys and harmless destructuring defaults', () => {
  const repo = fixture();
  const file = 'src/ui/checklistCaptions.ts';
  const reads = {
    fromAssertion: "const heading = paths['title' as const]",
    fromTemplate: 'const heading = paths[`title`]',
    fromDefault: "const { title: heading = 'Open findings' } = paths",
    fromUnused: "const { title: heading = (paths.entry = './checklist.mjs') } = paths",
  };
  const functions = Object.entries(reads).map(([name, read]) => [
    `export function ${name}() {`,
    "  const paths = { entry: 'node:path', title: 'Checklist' }",
    `  ${read}`,
    '  const { entry } = paths',
    '  return import(entry)',
    '}',
  ].join('\n'));
  const source = [...functions,
    "const editing = { entry: 'node:path', title: undefined as string | undefined }",
    "const { title = (editing.entry = './checklist.mjs') } = editing",
    'const { entry: changed } = editing',
    'export const afterDefault = () => import(changed)',
  ].join('\n');
  const loader = [
    "import * as captions from './build/checklistCaptions.js'",
    'const { fromAssertion, fromTemplate, fromDefault, fromUnused, afterDefault } = captions',
    "const builtIn = await import('node:path')",
    'const readers = [fromAssertion, fromTemplate, fromDefault, fromUnused, afterDefault]',
    'const modules = await Promise.all(readers.map(read => read()))',
    "console.log(modules.map(page => page === builtIn ? 'node:path' : page.caption).join(','))",
  ].join('\n');
  repo.write(file, source);
  expect(loadCompiledFixture(repo, file, loader)).toBe('node:path,node:path,node:path,node:path,Checklist');
  const result = repo.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file} import (lines 5, 11, 17, 23): 4 exceeds`);
  repo.write(file, source.replaceAll('node:path', './checklist.mjs'));
  expect(loadCompiledFixture(repo, file, loader)).toBe('Checklist,Checklist,Checklist,Checklist,Checklist');
  expect(repo.run().status).toBe(0);
});
