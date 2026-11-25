// @vitest-environment node
// Screens name no vendor, and the service name and the AI label come from the control file (names.service,
// names.aiContent), never written in (docs/review-prompt.md, Privacy). Reads every string and JSX text in src/ui and
// src/app; comments are not read.
import { readdirSync, readFileSync } from 'node:fs';
import { parseSync, Visitor } from 'vite';
import { describe, expect, it } from 'vitest';

// Model vendors and providers, their model families, and the default service name. Built at run time, so this file
// holds none of them as text.
const NAMES = ['Cla' + 'ude', 'Anthropic', 'ChatGPT', 'OpenAI', 'Copilot', 'Gemini', 'Cohere', 'North', 'Haiku',
  'Sonnet', 'Opus', 'Azure', 'Bedrock', 'Vertex', 'Intel' + 'ligence'];
const VENDOR = new RegExp(`\\b(${NAMES.join('|')})\\b`);

/** Each string literal, template part and JSX text in a source file that names a vendor, with its line. */
function vendorNamesIn(file: string, source: string): string[] {
  const found: string[] = [];
  const check = (start: number, text: string) => {
    const line = source.slice(0, start).split('\n').length;
    if (VENDOR.test(text)) found.push(`${file}:${line} ${text.trim().slice(0, 60)}`);
  };
  new Visitor({
    Literal(node) {
      if (typeof node.value === 'string') check(node.start, node.value);
    },
    TemplateLiteral(node) {
      for (const part of node.quasis) check(part.start, part.value.cooked ?? '');
    },
    JSXText: (node) => check(node.start, node.value),
  }).visit(parseSync(file, source).program);
  return found;
}

function screenSources(): string[] {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .map((file) => `src/${file.replaceAll('\\', '/')}`);
  return files.filter((file) => /^src\/(ui|app)\/.*\.tsx?$/.test(file)).sort();
}

describe('vendor names on screen', () => {
  it('finds a vendor or the default service name in a string or JSX text, and not in a comment', () => {
    const service = 'Intel' + 'ligence';
    const vendor = 'Cla' + 'ude';
    const source = [
      `// ${vendor} is named in a comment only`,
      `export const empty = <p>${vendor} found nothing</p>;`,
      `export const title = 'Sign in to ${service}';`,
      `export const wait = \`Waiting for ${service}…\`;`,
      "export const plain = 'Northwest office';",
    ].join('\n');
    expect(vendorNamesIn('src/ui/x.tsx', source).map((line) => line.split(' ')[0])).toEqual([
      'src/ui/x.tsx:2', 'src/ui/x.tsx:3', 'src/ui/x.tsx:4',
    ]);
  });

  it('is in no screen or app source', () => {
    const found = screenSources().flatMap((file) => vendorNamesIn(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });
});
