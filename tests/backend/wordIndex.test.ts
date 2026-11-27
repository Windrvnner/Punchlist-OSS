// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { wordIndex, countWords, bm25, TITLE_WORDS, WEIGHT } from '../../src/backend/wordIndex';
import { tokens, fold } from '../../src/backend/words';

const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'words-')); roots.push(d); return d; };
const q = (t: string) => new Set(tokens(t).map(fold));
const named = (docId: string, name: string) => ({ docId, named: q(name) });

describe("each PC's word index", () => {
  it('counts every word, numbers included, not filler words, folds plurals, and takes the title from page one', () => {
    const text = 'The Permits were granted. Permit 12 of 2026 covers air emissions.';
    const w = countWords(text, 'Environmental Permit Schedule');
    expect(Object.fromEntries(w.counts))
      .toEqual({ permit: 2, granted: 1, '12': 1, '2026': 1, cover: 1, air: 1, emission: 1 });
    expect(w.length).toBe(8);
    expect(w.title).toEqual(['environmental', 'permit', 'schedule']);
    expect(countWords(Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ')).title.length).toBe(TITLE_WORDS);
  });
  it('counts a word or number of any length, leaving out only the filler words', () => {
    const w = countWords('Schedule B lists item 5 and item 12.');
    expect(Object.fromEntries(w.counts)).toEqual({ schedule: 1, b: 1, list: 1, item: 2, '5': 1, '12': 1 });
  });
  it('scores documents with the same evidence the same, whatever order the words were asked in', () => {
    const ix = wordIndex(nodeFolder(dir()));
    const docs = Array.from({ length: 12 }, (_, i) => `Agreement ${i}`);
    for (const [i, name] of docs.entries()) ix.add('d', `doc${i}`, countWords(`${name} is signed.`, name));
    const files = docs.map((name, i) => named(`doc${i}`, name));
    // each document's own number sits at a different place among the other words asked about
    const words = docs.flatMap((_, i) => [
      String(i), ...(i % 4 === 1 ? ['agreement'] : []), ...(i % 5 === 2 ? ['signed'] : []),
    ]);
    const ask = q(words.join(' '));
    const scores = [...ix.score('d', ask, files).values()];
    expect(new Set(scores).size).toBe(1);
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
    expect(fs.readdirSync(d)).toEqual(['words5-deal.jsonl']);
    const b = wordIndex(nodeFolder(d)); expect(b.has('deal', 'x')).toBe(true);
    expect(b.score('deal', q('turbine'), [named('x', 'x.pdf')]).get('x')).toBe(0);
    expect(b.score('deal', q('maintenance'), [named('x', 'x.pdf')]).get('x')).toBeGreaterThan(0);
    fs.appendFileSync(path.join(d, 'words5-deal.jsonl'), '{"d":"y","n":3,"t":"');
    expect(wordIndex(nodeFolder(d)).has('deal', 'y')).toBe(false);   // a line cut short is read again later
  });
  it('does not read an index built under older rules, so each document is read again', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'words-deal.jsonl'), '{"d":"x","n":1,"t":"","w":"turbine:1"}\n');
    // words2: built before a document's most-used words kept numbers and single letters (#1147)
    fs.writeFileSync(path.join(d, 'words2-deal.jsonl'), '{"d":"y","n":1,"t":"","w":"turbine:1"}\n');
    const ix = wordIndex(nodeFolder(d));
    expect([ix.has('deal', 'x'), ix.has('deal', 'y')]).toEqual([false, false]);
  });
  it('does not read a words4 index, whose words kept combining marks', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'words4-deal.jsonl'), '{"d":"x","n":1,"t":"","w":"turbine:1"}\n');
    expect(wordIndex(nodeFolder(d)).has('deal', 'x')).toBe(false);
  });
  it('scores anything given as name, title and body words by the same BM25 the index uses', () => {
    const corpus = { size: 10, avgLength: 20, docsWith: (w: string) => (w === 'lockup' ? 1 : 9) };
    const idf = (n: number) => Math.log(1 + (10 - n + 0.5) / (n + 0.5));
    const none = (_w: string) => 0;
    const got = bm25(new Set(['lockup']), [
      { id: 'named', named: new Set(['lockup']), title: new Set(), tf: none, length: 20 },
      { id: 'titled', named: new Set(), title: new Set(['lockup']), tf: none, length: 20 },
      { id: 'body', named: new Set(), title: new Set(), tf: (w) => (w === 'lockup' ? 1 : 0), length: 20 },
      { id: 'none', named: new Set(), title: new Set(), tf: none, length: 20 },
    ], corpus);
    expect(got.get('named')).toBeCloseTo(WEIGHT.name * idf(1), 10);
    expect(got.get('titled')).toBeCloseTo(WEIGHT.title * idf(1), 10);
    // one use in a document of average length: a term weight of 1
    expect(got.get('body')).toBeCloseTo(idf(1), 10);
    expect(got.get('none')).toBe(0);
    expect(bm25(new Set(['other']), [{ id: 'b', named: new Set(['other']), title: new Set(), tf: none, length: 20 }],
      corpus).get('b')).toBeCloseTo(WEIGHT.name * idf(9), 10);
  });
});
