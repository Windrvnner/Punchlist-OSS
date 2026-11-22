// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { wordIndex, countWords, TITLE_WORDS } from '../../src/backend/wordIndex';
import { tokens, fold } from '../../src/backend/words';

const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'words-')); roots.push(d); return d; };
const q = (t: string) => new Set(tokens(t).map(fold));
const named = (docId: string, name: string) => ({ docId, named: q(name) });

describe("each PC's word index", () => {
  it('counts every word, leaving out filler words and bare numbers, with plurals folded, and takes the title from the first page', () => {
    const w = countWords('The Permits were granted. Permit 12 of 2026 covers air emissions.', 'Environmental Permit Schedule');
    expect(Object.fromEntries(w.counts)).toEqual({ permit: 2, granted: 1, cover: 1, air: 1, emission: 1 });
    expect(w.length).toBe(6); expect(w.title).toEqual(['environmental', 'permit', 'schedule']);
    expect(countWords(Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ')).title.length).toBe(TITLE_WORDS);
  });
  it('ranks a match in the name above the title, and the title above the body, by the agreed weights', () => {
    const ix = wordIndex(nodeFolder(dir()));
    ix.add('d', 'body', countWords('Introduction. '.repeat(40) + 'The lock-up applies. The lock-up test is the DSCR lock-up.', 'Introduction'));
    ix.add('d', 'title', countWords('Lock-up provisions. Other matters follow.', 'Lock-up provisions'));
    ix.add('d', 'name', countWords('Other matters entirely.', 'Other matters'));
    ix.add('d', 'none', countWords('Nothing relevant here at all.', 'Nothing'));
    const s = ix.score('d', q('lock-up'), [named('body', 'Agreement.pdf'), named('title', 'Schedule.pdf'), named('name', 'Lock-up letter.pdf'), named('none', 'Notes.pdf')]);
    expect(s.get('name')).toBeGreaterThan(s.get('title')!); expect(s.get('title')).toBeGreaterThan(s.get('body')!); expect(s.get('body')).toBeGreaterThan(0); expect(s.get('none')).toBe(0);
    // scored on the given words alone: the title and body the index holds are left out
    const only = ix.score('d', q('lock-up'), [named('body', 'Agreement.pdf'), named('name', 'Lock-up letter.pdf')], true);
    expect(only.get('body')).toBe(0); expect(only.get('name')).toBeCloseTo(s.get('name')!);
  });
  it('weighs a rare word above a common one, and scores a document it has not read on its name alone', () => {
    const ix = wordIndex(nodeFolder(dir()));
    for (let i = 0; i < 5; i++) ix.add('d', `p${i}`, countWords(`The project agreement number ${i}.`));
    ix.add('d', 'rare', countWords('The project insurance certificate.'));
    const s = ix.score('d', q('project insurance'), [named('p0', 'a.pdf'), named('rare', 'b.pdf'), named('unread', 'Insurance certificate.pdf')]);
    expect(s.get('rare')).toBeGreaterThan(s.get('p0')!); expect(s.get('unread')).toBeGreaterThan(0);
    expect(ix.has('d', 'rare')).toBe(true); expect(ix.has('d', 'unread')).toBe(false); expect(ix.has('other', 'rare')).toBe(false);
  });
  it('is kept on this PC, read back after a restart, and a document read again replaces its old words', () => {
    const d = dir(); const a = wordIndex(nodeFolder(d));
    a.add('deal', 'x', countWords('Turbine supply agreement.')); a.add('deal', 'x', countWords('Operation and maintenance agreement.'));
    expect(fs.readdirSync(d)).toEqual(['words-deal.jsonl']);
    const b = wordIndex(nodeFolder(d)); expect(b.has('deal', 'x')).toBe(true);
    expect(b.score('deal', q('turbine'), [named('x', 'x.pdf')]).get('x')).toBe(0);
    expect(b.score('deal', q('maintenance'), [named('x', 'x.pdf')]).get('x')).toBeGreaterThan(0);
    fs.appendFileSync(path.join(d, 'words-deal.jsonl'), '{"d":"y","n":3,"t":"'); expect(wordIndex(nodeFolder(d)).has('deal', 'y')).toBe(false);   // a line cut short is read again later
  });
});
