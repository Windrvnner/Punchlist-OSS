// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { folderDate, families, versionOf } from '../../src/backend/families';

describe('document families', () => {
  it('reads the date in a folder name, month first unless only day first is a date', () => {
    expect(['2026-03-01', '2026_03_01 signing', 'Draft 20260301', '03-01-2026', '03.01.26', '13-01-2026', 'March 1, 2026', '1 March 2026', 'Mar 2026 drafts', '2026-03'].map(folderDate))
      .toEqual(['2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01', '2026-01-13', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01']);
    expect(['Drafts', '01 Legal', 'Version 12', '13-13-2026', '2026-02-30', 'Mayor letters 2026', 'Q3 2026'].map(folderDate)).toEqual([null, null, null, null, null, null, null]);
  });
  it('makes a family of one file name in sibling dated folders, newest first, and leaves the rest out', () => {
    const f = families([
      { docId: 'a', path: 'Legal/Drafts/2026-03-01/SPA.docx' }, { docId: 'b', path: 'Legal/Drafts/2026-04-15/SPA.docx' }, { docId: 'c', path: 'Legal/Drafts/01-04-2026/spa.docx' },
      { docId: 'x', path: 'Legal/Drafts/2026-03-01/Side letter.docx' },                                       // alone: no family
      { docId: 'y', path: 'Finance/2026-03-01/SPA.docx' },                                                     // another parent: not a sibling
      { docId: 'm', path: 'Model/Model.xlsx' }, { docId: 'n', path: 'Old/Model.xlsx' },                        // no dated folder: no family
      { docId: 't1', path: 'Lenders/Bank A/Term sheet.pdf' }, { docId: 't2', path: 'Lenders/2026-03 Bank B/Term sheet.pdf' },   // one dated folder only: likely two documents, no family
    ]);
    expect(f).toEqual([{ name: 'SPA.docx', drafts: [{ docId: 'b', date: '2026-04-15' }, { docId: 'a', date: '2026-03-01' }, { docId: 'c', date: '2026-01-04' }] }]);   // 01-04-2026 is January 4
  });
  it('places a draft whose folder has no date by when the app first saw it, and breaks a tie the same way', () => {
    const f = families([
      { docId: 'old', path: 'Drafts/2026-02-01/EPC.pdf', seen: '2026-02-03T09:00:00.000Z' },
      { docId: 'latest', path: 'Drafts/Latest/EPC.pdf', seen: '2026-11-10T09:00:00.000Z' },
      { docId: 'tieA', path: 'Drafts/2026-06-01 v1/EPC.pdf', seen: '2026-06-02T09:00:00.000Z' }, { docId: 'tieB', path: 'Drafts/2026-06-01 v2/EPC.pdf', seen: '2026-06-03T09:00:00.000Z' },
    ]);
    expect(f[0].drafts.map((d) => d.docId)).toEqual(['latest', 'tieB', 'tieA', 'old']); expect(f[0].drafts[0].date).toBeNull();
  });
  it('makes a family of versions in one folder only from an explicit mark, newest mark first', () => {
    expect(['SPA v3.docx', 'SPA v.3.docx', 'SPA_v3.1.docx', 'SPA version 3.docx', 'SPA draft 3.docx', 'SPA rev 3.docx', 'SPA Rev A.docx'].map((n) => versionOf(n)?.base)).toEqual(['spa', 'spa', 'spa', 'spa', 'spa', 'spa', 'spa']);
    // a download copy, a date, a bare number, a schedule's number or a lower-case letter is no mark
    expect(['Invoice (1).pdf', 'Monthly Report 2026-03.pdf', 'Schedule 2.pdf', 'Exhibit A.pdf', 'SPA rev a.docx', 'Lease Parcel 12.pdf', 'Development.pdf', 'Turbine V150 spec.pdf', 'Annual Budget Draft 2025.xlsx', 'Notice v 2023.pdf'].map(versionOf)).toEqual([null, null, null, null, null, null, null, null, null, null]);   // a model or a year is no version
    const f = families([
      ...[1, 2, 10, 9].map((n) => ({ docId: `m${n}`, path: `Model/Base Case Model v${n}.xlsx` })),
      { docId: 'clean', path: 'Model/Base Case Model.xlsx' },                                                    // no mark: cannot be told an earlier draft, so it stays apart
      { docId: 'ra', path: 'EPC/EPC Contract Rev A.pdf' }, { docId: 'rb', path: 'EPC/EPC Contract Rev B.pdf' },
      { docId: 'other', path: 'Other/Base Case Model v11.xlsx' },                                                // another folder: not a version of these
      { docId: 'i1', path: 'AP/Invoice (1).pdf' }, { docId: 'i2', path: 'AP/Invoice (2).pdf' },
    ]);
    expect(f.map((x) => [x.name, x.drafts.map((d) => d.docId)])).toEqual([['Base Case Model v10.xlsx', ['m10', 'm9', 'm2', 'm1']], ['EPC Contract Rev B.pdf', ['rb', 'ra']]]);
  });
});
