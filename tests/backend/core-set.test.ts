// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { coreSet, shortNamesIn, type CoreDoc, type CoreItem } from '../../src/backend/core';
import { indexWords } from '../../src/backend/words';

const filler = new Set(['the', 'and', 'of', 'to', 'for', 'a', 'an', 'in', 'on', 'is', 'are', 'by', 'with', 'any', 'all', 'pdf', 'docx']);
const ask = new Set(['executed', 'copy', 'provided', 'confirm', 'provide', 'party', 'term', 'lenders']);
const library = [['PPA', 'power purchase agreement', 'offtake agreement'], ['EPC', 'EPC contract', 'engineering procurement and construction contract'], ['ground lease', 'land lease', 'lease agreement']];
const doc = (path: string, more: Partial<CoreDoc> = {}): CoreDoc => ({ docId: `d:${path}`, path, ...more });
const item = (id: string, text: string, more: Partial<CoreItem> = {}): CoreItem => ({ id, text, ...more });
const run = (docs: CoreDoc[], items: CoreItem[], standIn?: Map<string, string | null>) => coreSet({ docs, items, library, filler, ask, standIn });
const names = (ids: string[]) => ids.map((id) => id.split('/').pop());

describe('core documents with no model and no cap', () => {
  it('takes each item\'s best matches by name over folder, the agreement before its amendments, and a synonym as its group', () => {
    const docs = [doc('Room/03 Contracts/EPC/EPC Contract.pdf'), doc('Room/03 Contracts/EPC/Amendment No 1 to EPC Contract.pdf'), doc('Room/03 Contracts/EPC/Change Orders/Change Order 14.pdf'),
      doc('Room/03 Contracts/Offtake/Offtake Agreement - Execution Version.pdf'), doc('Room/05 Real Estate/Solar Lease Agreement - Parcel 7.pdf'), doc('Room/09 Correspondence/Letter re lease payment.pdf')];
    const s = run(docs, [item('i1', 'An executed copy of the EPC contract'), item('i2', 'The power purchase agreement is in full force'), item('i3', 'Land lease for the site is in place')]);
    expect(names(s.ids)).toContain('Offtake Agreement - Execution Version.pdf');                                    // "power purchase agreement" and "offtake agreement" are one group
    expect(names(s.ids)).toContain('Solar Lease Agreement - Parcel 7.pdf');                                           // "land lease" and "lease agreement": one group, its own words still count
    const epc = names(s.ids).filter((n) => /EPC|Change/.test(n!)); expect(epc[0]).toBe('EPC Contract.pdf');          // fewer relation words win the tie
    expect(s.idle).toBe(0);
  });
  it('has no cap: every item\'s top 3 is core, however many items there are', () => {
    // 400 permits, each its own item: one place each, so 400 core documents
    const docs = Array.from({ length: 400 }, (_, i) => doc(`Room/Permits/Permit ${['air', 'water', 'zoning', 'building', 'grading'][i % 5]} permit no ref${i}.pdf`));
    const items = docs.map((d, i) => item(`i${i}`, `The ${['air', 'water', 'zoning', 'building', 'grading'][i % 5]} permit ref${i} is valid`));
    const s = run(docs, items);
    expect(s.ids.length).toBeGreaterThanOrEqual(400); expect(s.best).toBe(100);
  });
  it('takes only the newest draft, and a blackline through its clean draft; one whose clean draft is unclear is not core', () => {
    const docs = [doc('Room/Model/Base Case Model v14.xlsx'), doc('Room/Model/Base Case Model v13.xlsx'), doc('Room/PPA/PPA redline.pdf'), doc('Room/PPA/PPA.pdf'), doc('Room/PPA/PPA blackline unclear.pdf')];
    const standIn = new Map<string, string | null>([['d:Room/Model/Base Case Model v13.xlsx', 'd:Room/Model/Base Case Model v14.xlsx'], ['d:Room/PPA/PPA redline.pdf', 'd:Room/PPA/PPA.pdf'], ['d:Room/PPA/PPA blackline unclear.pdf', null]]);
    const s = run(docs, [item('i1', 'The base case model shows a DSCR above 1.30x'), item('i2', 'The PPA tariff is fixed')], standIn);
    expect(names(s.ids).sort()).toEqual(['Base Case Model v14.xlsx', 'PPA.pdf']);
    // a blackline of an earlier draft goes through that draft to the newest
    const chain = new Map<string, string | null>([['d:Room/Drafts/2025-01/SPA (blackline).pdf', 'd:Room/Drafts/2025-01/SPA.docx'], ['d:Room/Drafts/2025-01/SPA.docx', 'd:Room/Drafts/2025-03/SPA.docx']]);
    const c = run([doc('Room/Drafts/2025-01/SPA (blackline).pdf'), doc('Room/Drafts/2025-01/SPA.docx'), doc('Room/Drafts/2025-03/SPA.docx')], [item('i1', 'The SPA is signed')], chain);
    expect(c.ids).toEqual(['d:Room/Drafts/2025-03/SPA.docx']);
  });
  it('never takes a precedent, and a data-room index is a hub: core once, but not among the best', () => {
    const docs = [doc('Room/12. Precedents/Project Coho PPA.pdf'), doc('Room/Offtake/PPA.pdf'), doc('Room/Conditions Precedent/CP Checklist.pdf'), doc('Room/VDR Index.xlsx', { words: ['ppa', 'lease', 'permit'] })];
    const s = run(docs, [item('i1', 'The PPA is signed'), item('i2', 'Conditions precedent checklist is complete'), item('i3', 'Index of the data room')]);
    expect(names(s.ids)).not.toContain('Project Coho PPA.pdf'); expect(names(s.ids)).toContain('CP Checklist.pdf');
    expect(names(s.hubs)).toEqual(['VDR Index.xlsx']); expect(s.ids.slice(0, s.best).map((id) => id.split('/').pop())).not.toContain('VDR Index.xlsx');
  });
  it('an item that names nothing in any file name or folder adds nothing; with no checklist, or none that names anything, each library group is an item', () => {
    const docs = [doc('Room/Offtake/Power Purchase Agreement.pdf'), doc('Room/EPC/EPC Contract.pdf'), doc('Room/Misc/Notes.pdf')];
    expect(names(run(docs, []).ids).sort()).toEqual(['EPC Contract.pdf', 'Power Purchase Agreement.pdf']);
    // a checklist none of whose items names anything in the data room is no better than none: the library stands in
    expect(run(docs, [item('i1', 'Gas supply arrangements are adequate')]).ids).toEqual(run(docs, []).ids);
    const some = run(docs, [item('i1', 'Gas supply arrangements are adequate'), item('i2', 'The EPC contract is signed')]); expect(names(some.ids)).toEqual(['EPC Contract.pdf']); expect(some.idle).toBe(1);
  });
  it('gives the same set whatever order the documents and items come in', () => {
    // ids that do not sort as the paths do, so neither order stands in for the other
    const docs = ['A/PPA.pdf', 'A/EPC Contract.pdf', 'B/Lease Agreement.pdf', 'B/O&M Agreement.pdf', 'C/Insurance Certificate.pdf', 'C/Insurance Policy.pdf'].map((p, i) => ({ docId: `z${(i * 7) % 6}`, path: `Room/${p}` }));
    const items = [item('i1', 'PPA tariff'), item('i2', 'EPC price'), item('i3', 'Lease term'), item('i4', 'O&M fees'), item('i5', 'Insurance cover'), item('i6', 'Insurance policy and lease agreement')];
    const a = run(docs, items).ids; expect(a.length).toBeGreaterThan(4);
    expect(run([...docs].reverse(), [...items].reverse()).ids).toEqual(a); expect(run([docs[3], docs[0], docs[5], docs[1], docs[4], docs[2]], [items[2], items[5], items[0], items[4], items[1], items[3]]).ids).toEqual(a);
  });
  it('reads a bare abbreviation as a file name', () => {
    const docs = [doc('Room/03 Offtake/PPA.pdf'), doc('Room/03 Offtake/Purchase order 12.pdf'), doc('Room/03 Offtake/Power meter readings.pdf'), doc('Room/03 Offtake/Agreement on metering.pdf'), ...['Tax return', 'Property tax bill', 'Tax opinion'].map((n) => doc(`Room/10 Tax/${n}.pdf`))];
    const s = run(docs, [item('i1', 'The power purchase agreement is in full force'), item('i2', 'The PPA term is at least 10 years', { heads: 'Section 10 Offtake' }), item('i3', 'Interconnection is in place'), item('i4', 'Insurance is in force'), item('i5', 'Site access is secured')]);   // (a word half the items use counts for nothing, so more than two)
    expect(names(s.ids.slice(0, 1))).toEqual(['PPA.pdf']);
  });
  it('keeps numbers and single letters as words, as the word index does (#1147)', () => {
    const kept = ['wind', 'farm', '2', 'schedule', 'a', 'tax', '10'];
    expect(indexWords('Wind Farm 2 Schedule A Tax 10', new Set())).toEqual(kept);
    const docs = [doc('Room/Reports/Wind Farm 1 Report.pdf'), doc('Room/Reports/Wind Farm 2 Report.pdf')];
    const s = run(docs, [item('i1', 'The Wind Farm 2 report')]);
    expect(names(s.ids)[0]).toBe('Wind Farm 2 Report.pdf');
  });
  it('a file is a hub by name only when it is named as a list', () => {
    const docs = [doc('Room/VDR Index v3.xlsx'), doc('Room/Index of documents.pdf'), doc('Room/PPA/PPA Price Index Adjustment.pdf'), doc('Room/PPA/PPA.pdf')];
    const s = run(docs, [item('i1', 'The PPA price index adjustment is agreed'), item('i2', 'Data room index and documents index')]);
    expect(names(s.hubs).sort()).toEqual(['Index of documents.pdf', 'VDR Index v3.xlsx']); expect(names(s.ids)).toContain('PPA Price Index Adjustment.pdf');
  });
});

describe('short names the paths spell out', () => {
  it('reads an abbreviation beside the phrase it stands for, one initial per word, joining words skipped', () => {
    expect(shortNamesIn(['Room/Offtake/Power Purchase Agreement (PPA).pdf', 'Room/EPC - Engineering, Procurement and Construction Contract.pdf', 'Room/O&M/Operation and Maintenance Agreement (O&M).pdf']))
      .toEqual({ PPA: 'power purchase agreement', EPC: 'engineering procurement and construction', 'O&M': 'operation and maintenance' });
  });
  it('does not guess: no phrase whose initials fit, letters inside words, or a path in capitals only', () => {
    expect(shortNamesIn(['Room/FINAL/Shareholders Agreement.pdf', 'Room/SHA notes.pdf', 'ROOM/PILOT PROGRAM/PAYMENT IN LIEU OF TAXES.PDF'])).toEqual({});
    // both forms in one folder or file name: a deal folder's name is not what a file's abbreviation stands for
    expect(shortNamesIn(['Project Proseware Acquisition/03 Offtake/PPA.pdf', 'Execution Package Copy/EPC.pdf'])).toEqual({});
  });
});
