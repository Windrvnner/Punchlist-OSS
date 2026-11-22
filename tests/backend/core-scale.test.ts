// @vitest-environment node
// The core set at deal scale (docs/core-documents-design.md, acceptance criteria): a generated 1,779-file data room and
// the 2,400-item checklist, with the control file's library and word lists, as the app works it out.
import { describe, it, expect } from 'vitest';
import { coreSet, type CoreDoc } from '../../src/backend/core';
import { families } from '../../src/backend/families';
import { control } from '../../src/control';
import { paths } from './fixtures/relecloudRoom';
import { dealList } from './dealList';

const filler = new Set([...control.lists.searchFiller, ...control.lists.indexFiller].map((w) => w.toLowerCase()));
const ask = new Set(control.lists.askWords.map((w) => w.toLowerCase()));
const library = control.lists.synonyms as string[][];
const docs: CoreDoc[] = paths.map((p) => ({ docId: `d:${p}`, path: p }));
// as the app does: an earlier draft stands in for its newest, a blackline for the clean draft beside it
const standIn = new Map<string, string | null>();
for (const f of families(docs)) for (const d of f.drafts.slice(1)) standIn.set(d.docId, f.drafts[0].docId);
for (const d of docs) if (/ \(blackline\)\.pdf$/.test(d.path)) standIn.set(d.docId, `d:${d.path.replace(/ \(blackline\)\.pdf$/, '.docx')}`);
const items = dealList().items.map((text, i) => ({ id: `i${i}`, text }));
const name = (id: string) => id.split('/').pop()!;

describe('the core set at deal scale', () => {
  it('on 1,779 files and 2,400 items: the main agreements are core, no earlier draft or precedent is, and it takes well under 10 seconds', () => {
    expect(paths.length).toBe(1779); expect(items.length).toBe(2400);
    const t0 = performance.now(); const s = coreSet({ docs, items, standIn, library, filler, ask }); const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10_000);
    const names = s.ids.map(name);
    for (const main of ['Power Purchase Agreement.pdf', 'EPC Contract.pdf', 'Operation and Maintenance Agreement.pdf', 'Large Generator Interconnection Agreement.pdf', 'Long-Term Service Agreement.pdf', 'Credit Agreement.docx'])
      expect(names).toContain(main);
    expect(s.ids).toContain('d:Relecloud VDR/05 Financing/Drafts/2025-05-02/Credit Agreement.docx');          // the newest draft, not an earlier one
    expect(s.ids.filter((id) => standIn.has(id))).toEqual([]);
    expect(s.ids.filter((id) => /\/Precedents\//.test(id))).toEqual([]);
    // no cap, but a set to read up front, not the data room: a few hundred documents at most
    expect(s.best).toBe(100); expect(s.ids.length).toBeGreaterThan(100); expect(s.ids.length).toBeLessThan(400);
    console.log(`core set: ${s.ids.length} of ${paths.length} documents (${s.hubs.length} hubs), ${s.idle} items adding none, in ${Math.round(ms)} ms`);
  });
  it('with 30 most-used words for each document, as a described data room has, still well under 10 seconds', () => {
    const vocab = ['agreement', 'party', 'lender', 'borrower', 'project', 'company', 'notice', 'payment', 'term', 'price', 'energy', 'capacity', 'site', 'permit', 'insurance', 'contractor', 'owner', 'section', 'schedule', 'date', 'default', 'termination', 'warranty', 'tax', 'lease', 'county', 'interconnection', 'module', 'turbine', 'equity', 'security', 'account', 'fee', 'report', 'engineer', 'completion', 'commercial', 'operation', 'delay', 'damages'];
    const worded = docs.map((d, i) => ({ ...d, words: Array.from({ length: 30 }, (_, k) => vocab[(i * 7 + k * 3) % vocab.length] + (k % 3 ? '' : String.fromCharCode(97 + ((i + k) % 26)))) }));
    const t0 = performance.now(); const s = coreSet({ docs: worded, items, standIn, library, filler, ask }); const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10_000); expect(s.ids.map(name)).toContain('Power Purchase Agreement.pdf');
    console.log(`core set with most-used words: ${s.ids.length} documents in ${Math.round(ms)} ms`);
  });
});
