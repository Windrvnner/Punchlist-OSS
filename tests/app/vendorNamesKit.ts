// Finds the vendor and service names written in src, for tests/app/vendorNames.test.ts and
// tests/app/vendorModelNames.test.ts (which also covers the model lists of the claude, openai and north connectors).
// It reads the string literals, template parts and JSX text of src/**/*.ts(x) as written. It does not read comments,
// files that are not TypeScript (html, css, json), names reached through variables or identifiers, or a name split
// across a concatenation.
import { readdirSync } from 'node:fs';
import { parseSync, Visitor } from 'vite';

// Model vendors and providers, their model families, and the default service name. Built at run time, so this file
// holds none of them as text.
const NAMES = ['Cla' + 'ude', 'Anthropic', 'ChatGPT', 'GPT', 'OpenAI', 'Copilot', 'Gemini', 'Cohere', 'Mistral',
  'Llama', 'North', 'Haiku', 'Sonnet', 'Opus', 'Azure', 'Bedrock', 'Vertex', 'Intel' + 'ligence'];
// in any case, so a name written in capitals or lower case is caught too
export const VENDOR = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'i');
const EACH_VENDOR = new RegExp(VENDOR.source, 'gi');

/** A match for the allowance: `line` is the trimmed source line (or the model name), `number` is for display. */
export interface VendorMatch { file: string; kind: string; line: string; number?: number }

/**
 * Each occurrence of a vendor name in a string literal, template part or JSX text, one match per occurrence at its own
 * line. The text is read as written; a name built from an escape sequence is recorded at the start of its literal.
 */
export function vendorMatchesIn(file: string, source: string): VendorMatch[] {
  const found: VendorMatch[] = [];
  const rows = source.split('\n');
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  const record = (offset: number) => {
    const number = lineAt(offset);
    found.push({ file, kind: 'vendor', line: rows[number - 1].trim(), number });
  };
  const check = (start: number, end: number, text: string) => {
    const written = [...source.slice(start, end).matchAll(EACH_VENDOR)];
    if (written.length === 0 && VENDOR.test(text)) record(start);
    for (const match of written) record(start + (match.index ?? 0));
  };
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file} does not parse: ${parsed.errors[0].message}`);
  new Visitor({
    Literal(node) {
      if (typeof node.value === 'string') check(node.start, node.end, node.value);
    },
    TemplateLiteral(node) {
      for (const part of node.quasis) check(part.start, part.end, part.value.cooked ?? '');
    },
    JSXText: (node) => check(node.start, node.end, node.value),
  }).visit(parsed.program);
  return found;
}

/** Every TypeScript source under src, with `/` separators. */
export function srcSources(): string[] {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .map((file) => `src/${file.replaceAll('\\', '/')}`);
  return files.filter((file) => /\.tsx?$/.test(file)).sort();
}
