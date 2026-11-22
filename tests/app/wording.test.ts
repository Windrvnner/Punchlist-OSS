// @vitest-environment node
// Words that reach the screen follow "One name per thing" in docs/decisions.md. A scan of the source's string literals,
// with comments left out, catches a name that should not be written anywhere a person can read it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []; });
/** every quoted string in the source, with where it is, comments taken out first */
const literals = () => files('src').flatMap((f) => {
  const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => `${f}: ${m[0]}`);
});

/**
 * UK spellings kept on purpose in the data that matches document names, since other parties' files use them:
 * 'licence' in the control file's word lists and in the keyword prompt
 */
const matchedUkSpelling = (s: string) =>
  s === "src/control.ts: 'licence'" || /^src\/backend\/ai\.ts: .*consent, license, licence,/s.test(s);

describe('names on screen', () => {
  it('call the records folder the "Punchlist folder", never the "shared folder"', () => {
    expect(literals().filter((s) => /shared folder/i.test(s))).toEqual([]);
  });

  it('are written in en-US', () => {
    const ukSpelling = /\b(labelled|cancelled|colour|organis|behaviour|favour|centre|licence|grey)/i;
    expect(literals().filter((s) => ukSpelling.test(s) && !matchedUkSpelling(s))).toEqual([]);
  });
});
