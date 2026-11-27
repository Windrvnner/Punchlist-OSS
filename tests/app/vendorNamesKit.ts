// Finds the vendor and service names written in src, for tests/app/vendorNames.test.ts and
// tests/app/vendorModelNames.test.ts. Comments are not read.
import { readdirSync } from 'node:fs';
import { parseSync, Visitor } from 'vite';

// Model vendors and providers, their model families, and the default service name. Built at run time, so this file
// holds none of them as text.
const NAMES = ['Cla' + 'ude', 'Anthropic', 'ChatGPT', 'GPT', 'OpenAI', 'Copilot', 'Gemini', 'Cohere', 'Mistral',
  'Llama', 'North', 'Haiku', 'Sonnet', 'Opus', 'Azure', 'Bedrock', 'Vertex', 'Intel' + 'ligence'];
// in any case, so a name written in capitals or lower case is caught too
export const VENDOR = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'i');

/** A match for the allowance: `line` is the trimmed source line (or the model name), `number` is for display. */
export interface VendorMatch { file: string; kind: string; line: string; number?: number }

/** Each string literal, template part and JSX text in a source file that names a vendor. */
export function vendorMatchesIn(file: string, source: string): VendorMatch[] {
  const found: VendorMatch[] = [];
  const rows = source.split('\n');
  const check = (start: number, text: string) => {
    const number = source.slice(0, start).split('\n').length;
    if (VENDOR.test(text)) found.push({ file, kind: 'vendor', line: rows[number - 1].trim(), number });
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

/** Every TypeScript source under src, with `/` separators. */
export function srcSources(): string[] {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .map((file) => `src/${file.replaceAll('\\', '/')}`);
  return files.filter((file) => /\.tsx?$/.test(file)).sort();
}
