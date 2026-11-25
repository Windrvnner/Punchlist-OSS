import { describe, it, expect } from 'vitest';
import {
  byDocument, canAddToSources, fewDocuments, inSources, menuSections, newerThan, popDocuments, shownDrafts, sourceChips,
} from '../../src/app/citations';
import type { DocRef } from '../../src/app/conversations';
import type { Source } from '../../src/domain/model';

// #950: how citations are grouped, ordered and counted, run with no screen, on citations as a deal produces them

/** A data room's documents: two share a name in different folders, so they differ only by id. */
const ROOM = [
  ['Credit agreement (draft 3).pdf', 'doc_ca3'], ['Credit agreement (draft 3).pdf', 'doc_ca3_archive'],
  ['Technical advisor report.pdf', 'doc_ta'], ['Information memorandum.pdf', 'doc_im'],
  ['Financial model v14.xlsx', 'doc_fm'], ['Capacity agreement.pdf', 'doc_cap'], ['Term sheet (signed).pdf', 'doc_ts'],
  ['O&M agreement.pdf', 'doc_om'], ['Insurance advisor report.pdf', 'doc_ins'], ['Land lease.pdf', 'doc_land'],
  ['Interconnection agreement.pdf', 'doc_ix'], ['Environmental permit.pdf', 'doc_env'],
] as const;
const PLACES = ['p. 6', 'p. 22', 'p. 41', 'p. 44', 'p. 88', 'p. 142', 'cl. 7.2', 'cl. 14.1(b)', 'Revenue!D14', ''];

/** A deterministic stream of citations, as the answers to a deal's 2,000 questions cite them. */
function dealCitations(count: number): Source[] {
  let seed = 950;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor(seed / 65536) % n;
  };
  return Array.from({ length: count }, () => {
    const [doc, docId] = ROOM[next(ROOM.length)];
    return { doc, docId, loc: PLACES[next(PLACES.length)] };
  });
}
const S = (doc: string, loc: string, docId = 'doc_' + doc) => ({ doc, loc, docId });
const R = (doc: string, loc: string, from = 'From the finding', ask?: string, docId = 'id_' + doc): DocRef =>
  ({ doc, docId, loc, from, ask });

describe('a document’s citations', () => {
  const finding = [S('TA report.pdf', 'p. 41'), S('O&M.pdf', 'cl. 7.2'), S('TA report.pdf', 'p. 44'),
    S('TA report.pdf', 'p. 41'), S('Model.xlsx', ''), S('Model.xlsx', 'Ops!F12'), S('Model.xlsx', '')];
  it('lists each place once, keeping the first citation of it and an unplaced one', () => {
    const groups = byDocument(finding);
    expect(groups.map((g) => g.pages.map((x) => x.loc))).toEqual([['p. 41', 'p. 44'], ['cl. 7.2'], ['', 'Ops!F12']]);
    expect(groups[0].pages[0]).toBe(finding[0]);
    expect(groups.map((g) => g.places)).toEqual(['p. 41, p. 44', 'cl. 7.2', 'Ops!F12']);
  });
  it('gives one chip per document and place, in order, a same-named document apart', () => {
    const chips = sourceChips([...finding, S('TA report.pdf', 'p. 41', 'doc_other')]);
    expect(chips.map((x) => `${x.docId} ${x.loc}`)).toEqual(['doc_TA report.pdf p. 41', 'doc_O&M.pdf cl. 7.2',
      'doc_TA report.pdf p. 44', 'doc_Model.xlsx ', 'doc_Model.xlsx Ops!F12', 'doc_other p. 41']);
  });
  it('shows up to four documents in a pop, and past that three and the rest as more', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((x) => S(`${x}.pdf`, 'p. 1'));
    expect(fewDocuments(five.slice(0, 4))).toBe(true);
    expect(fewDocuments([...five.slice(0, 4), S('A.pdf', 'p. 9')])).toBe(true);
    expect(fewDocuments(five)).toBe(false);
    const pop = popDocuments(five, true);
    expect([pop.capped, pop.shown.map((g) => g.doc.doc), pop.more]).toEqual([true, ['A.pdf', 'B.pdf', 'C.pdf'], 2]);
    expect(popDocuments(five, false).shown).toHaveLength(5);
  });
});

describe('citations at deal scale', () => {
  const all = dealCitations(20_000);
  it('counts every document once, by id, in order of first citation, with each place once', () => {
    const groups = byDocument(all);
    const firstSeen = [...new Set(all.map((x) => x.docId))];
    expect(groups.map((g) => g.doc.docId)).toEqual(firstSeen);
    expect(groups).toHaveLength(ROOM.length);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(all.length);
    for (const g of groups) {
      expect(g.pages.map((x) => x.loc).sort()).toEqual([...PLACES].sort());
      expect(g.places.split(', ')).toHaveLength(PLACES.length - 1);
    }
    expect(fewDocuments(all)).toBe(false);
  });
  it('gives as many chips as distinct document pages, and runs fast enough for a long conversation', () => {
    const started = performance.now();
    const chips = sourceChips(all);
    byDocument(all);
    expect(performance.now() - started).toBeLessThan(500);
    expect(chips).toHaveLength(ROOM.length * PLACES.length);
    expect(new Set(chips.map((x) => `${x.docId}|${x.loc}`)).size).toBe(chips.length);
  });
});

describe('the reading-mode document list', () => {
  it('orders a document’s pages by page number, places without one last, keeping the list’s positions', () => {
    const docs = [R('Agreement.pdf', 'p. 142'), R('Model.xlsx', 'Ops!F12'), R('Agreement.pdf', 'cl. 7.2'),
      R('Agreement.pdf', 'p. 27'), R('Agreement.pdf', 'p. 9')];
    const [row] = menuSections(docs, null)[0].groups;
    expect(row.pages.map((x) => [x.x.loc, x.i])).toEqual([['p. 9', 4], ['p. 27', 3], ['p. 142', 0], ['cl. 7.2', 2]]);
    expect(row.items.map((x) => x.i)).toEqual([0, 2, 3, 4]);
  });
  it('keeps two documents of the same name apart, and groups 2,000 answers by question', () => {
    const docs = dealCitations(2_000).map((x, n) =>
      R(x.doc, x.loc, `From answer ${Math.floor(n / 4) + 1}`, `Question ${Math.floor(n / 4) + 1}?`, x.docId));
    const sections = menuSections(docs, R('Land lease.pdf', 'p. 3', 'From the conversation', 'Follow-up?'));
    expect(sections).toHaveLength(501);
    expect(sections.at(-1)!.groups[0].items[0].i).toBe(-1);
    const rows = sections.slice(0, -1).flatMap((s) => s.groups);
    expect(rows.flatMap((g) => g.items.map((x) => x.i)).sort((a, b) => a - b)).toEqual(docs.map((_, i) => i));
    for (const s of sections) expect(new Set(s.groups.map((g) => g.key)).size).toBe(s.groups.length);
    expect(rows.some((g) => g.ref.docId === 'doc_ca3_archive')).toBe(true);
  });
});

describe('a document’s drafts', () => {
  const draft = (docId: string, folder: string, date: string | null) =>
    ({ doc: 'Credit agreement.pdf', docId, folder, date });
  const drafts = [draft('d3', 'vdr/2026-04-15', '2026-04-15'), draft('d2', 'vdr/2026-03-02', '2026-03-02'),
    draft('d1', 'vdr/Archive', null)];
  it('shows drafts only for a document with more than one, and names the newest for an earlier one', () => {
    expect(shownDrafts(undefined)).toEqual([]);
    expect(shownDrafts(drafts.slice(0, 1))).toEqual([]);
    expect(shownDrafts(drafts)).toBe(drafts);
    expect(newerThan(drafts, 'd1')).toBe(drafts[0]);
    expect(newerThan(drafts, 'd3')).toBeNull();
    expect(newerThan(drafts, 'not a draft')).toBeNull();
  });
});

describe('Add to Sources', () => {
  const finding = { sources: [S('Credit agreement (draft 3).pdf', 'p. 142', 'doc_ca3')] };
  it('is offered for a finished file not among the finding’s sources, told apart by id', () => {
    const archived = { doc: 'Credit agreement (draft 3).pdf', docId: 'doc_ca3_archive' };
    expect(canAddToSources(finding, archived)).toBe(true);
    expect(canAddToSources(finding, { ...archived, state: 'done' })).toBe(true);
    expect(inSources(finding, 'doc_ca3')).toBe(true);
    expect(inSources(finding, 'doc_ca3_archive')).toBe(false);
  });
  it('is not offered off a finding, while attaching, or for a file already among its sources', () => {
    expect(canAddToSources(null, { doc: 'Land lease.pdf', docId: 'doc_land' })).toBe(false);
    expect(canAddToSources(finding, { doc: 'Land lease.pdf', docId: 'doc_land', state: 'pending' })).toBe(false);
    expect(canAddToSources(finding, { doc: 'Land lease.pdf', state: 'done' })).toBe(false);
    expect(canAddToSources(finding, { doc: 'Credit agreement (draft 3).pdf', docId: 'doc_ca3' })).toBe(false);
  });
});
