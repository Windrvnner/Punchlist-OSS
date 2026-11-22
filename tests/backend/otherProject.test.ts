// @vitest-environment node
// Documents of another project (docs/other-project-documents-design.md): precedents and blacklines against them
import { describe, it, expect } from 'vitest';
import { cleanDrafts, againstOf, otherProject, coverFiles, type BlacklineDoc } from '../../src/backend/blacklines';
import { families, roomPath } from '../../src/backend/families';

const doc = (docId: string, rel: string, extra: Partial<BlacklineDoc> = {}): BlacklineDoc => ({ docId, name: rel.split('/').pop()!, folder: '/n/Relecloud VDR', rel, ...extra });
const kinds = (docs: BlacklineDoc[]) => { const pairs = cleanDrafts(docs); return { pairs: Object.fromEntries(pairs), against: Object.fromEntries(againstOf(docs, pairs)) }; };

const LITERA =
  'Comparison Details\nTitle pdfDocs compareDocs Comparison Results\nDate & Time ' +
  '11/12/2026 4:10:22 PM\nComparison Time 1.84 seconds\ncompareDocs version ' +
  'v0.0.0\nSources\nOriginal Document [#1234567] [v6] EPC Contract v6.docx\nModified ' +
  'Document [#1234567] [v7] EPC Contract v7.docx\nComparison Statistics\nInsertions 41\nDeletions 17';
const WORKSHARE = 'Document comparison by Workshare Compare on Thursday, November 12, 2026 4:10:22 PM\nInput:\nDocument 1 ID file://C:\\Precedents\\Coho Solar\\Coho PPA (executed).docx\nDescription Coho PPA (executed)\nDocument 2 ID file://C:\\Users\\jd\\Relecloud\\Relecloud PPA v4.docx\nDescription Relecloud PPA v4\nRendering set Standard\nLegend:\nInsertion Deletion';
const WORD = 'Comparison of Credit Agreement (draft 5).docx and Credit Agreement (draft 6).docx\nOriginal document: Credit Agreement (draft 5).docx\nRevised document: Credit Agreement (draft 6).docx\nInsertions 12 Deletions 4';

describe('documents of another project', () => {
  it('reads the files a comparison cover names, original first, with their paths', () => {
    expect(coverFiles(LITERA).map((f) => f.name)).toEqual(['EPC Contract v6.docx', 'EPC Contract v7.docx']);
    expect(coverFiles(WORKSHARE).map((f) => f.path)).toEqual(['C:\\Precedents\\Coho Solar\\Coho PPA (executed).docx', 'C:\\Users\\jd\\Relecloud\\Relecloud PPA v4.docx']);
    expect(coverFiles(WORD).slice(0, 2).map((f) => f.name)).toEqual(['Credit Agreement (draft 5).docx', 'Credit Agreement (draft 6).docx']);
    expect(coverFiles('Comparison of C:\\Deals\\SPA v2.doc and C:\\Deals\\SPA v3.doc. Insertions 4 Deletions 2').map((f) => f.name)).toEqual(['SPA v2.doc', 'SPA v3.doc']);
  });

  it('is another project\'s only when every place it is in runs through a precedents folder', () => {
    expect(otherProject(doc('p', '12. Precedents/Coho Solar/Coho PPA (executed).pdf'))).toBe(true);
    expect(otherProject({ folder: 'X:\\Precedents', rel: 'Coho PPA.pdf' })).toBe(true);                                          // a deal folder that is a precedents folder
    expect(otherProject(doc('c', '04 Finance/Conditions Precedent/CP Checklist.xlsx'))).toBe(false);
    expect(otherProject(doc('g', '03 Legal/Gas Transportation Precedent Agreement.pdf'))).toBe(false);
    expect(otherProject(doc('x', 'Precedents/Relecloud PPA (executed).pdf', { copies: [{ folder: '/n/Relecloud VDR', rel: '03 Legal/Relecloud PPA (executed).pdf' }] }))).toBe(false);   // also filed as this deal's
  });

  it('never makes a precedent a draft of this deal, so it is no blackline\'s clean draft', () => {
    const docs = [doc('a', 'Drafts/2026-03-01/PPA.docx', { seen: '2026-11-18' }), doc('b', 'Drafts/2026-04-15/PPA.docx', { seen: '2026-11-18' }), doc('p', 'Drafts/Precedents/PPA.docx', { seen: '2026-11-18T09:00:00Z' }), doc('bl', '03 Legal/PPA blackline.pdf')];
    expect(families(docs.map((d) => ({ docId: d.docId, path: roomPath(d), seen: d.seen })))[0].drafts.map((d) => d.docId)).toEqual(['b', 'a']);
    expect(kinds(docs).pairs).toEqual({ bl: 'b' });
  });

  it('tells this deal\'s own blacklines by what they were compared against', () => {
    const { pairs, against } = kinds([
      doc('r', '03 Legal/SPA v3 Redline to SPA v2.pdf'), doc('s3', '03 Legal/SPA v3.docx'), doc('s2', '03 Legal/SPA v2.docx'),
      doc('vs', '03 Legal/Project Datum SPA v4 vs Project Datum SPA v3.pdf'), doc('a4', '03 Legal/Project Datum SPA v4.docx'),
      doc('epc', '05 Construction/EPC Contract blackline.pdf', { cover: LITERA }), doc('e7', '05 Construction/EPC Contract v7.docx'), doc('e6', '05 Construction/EPC Contract v6.docx'),
      doc('ca', '04 Finance/Credit Agreement comparison.pdf', { cover: WORD }), doc('c6', '04 Finance/Credit Agreement (draft 6).docx'),
      doc('fb', 'Drafts/2026-04-15/Credit Agreement redline.pdf', { cover: 'Comparison of Credit Agreement.docx and Credit Agreement.docx. Insertions 3 Deletions 1' }), doc('f1', 'Drafts/2026-03-01/Credit Agreement.docx'), doc('f2', 'Drafts/2026-04-15/Credit Agreement.docx'),
    ]);
    expect(pairs).toMatchObject({ r: 's3', vs: 'a4', epc: 'e7', ca: 'c6', fb: 'f2' });
    expect(against).toEqual({ r: 'own', vs: 'own', epc: 'own', ca: 'own', fb: 'own' });
  });

  it('tells a blackline against another project\'s document, and one made on another project', () => {
    expect(kinds([doc('w', '03 Legal/Relecloud PPA blackline.pdf', { cover: WORKSHARE }), doc('p4', '03 Legal/Relecloud PPA v4.docx')]).against).toEqual({ w: 'other' });
    const { pairs, against } = kinds([
      doc('t', '03 Legal/LTSA Redline to Coho LTSA.pdf'), doc('l', '03 Legal/LTSA.docx'), doc('bl', '12. Precedents/Coho LTSA.pdf'),
      doc('in', '12. Precedents/PPA blackline.pdf'), doc('pp', 'Drafts/2026-04-15/PPA.docx'), doc('pq', 'Drafts/2026-03-01/PPA.docx'),
    ]);
    expect(pairs).toMatchObject({ t: 'l', in: false });
    expect(against).toEqual({ t: 'other', in: 'other' });
  });

  it('does not know when it cannot be told, and never calls that own', () => {
    const { against } = kinds([
      doc('n', '03 Legal/PPA redline.pdf'), doc('p', '03 Legal/PPA.docx'),
      doc('x', '03 Legal/SPA blackline.pdf', { cover: 'Comparison of Coho SPA executed.docx and SPA v3.docx. Insertions 9 Deletions 3' }), doc('s', '03 Legal/SPA v3.docx'),
      doc('alone', '06 Permits/Interconnection blackline.pdf'),
    ]);
    expect(against).toEqual({ n: 'unknown', x: 'unknown', alone: 'unknown' });
  });

  it('leaves ordinary documents alone', () => {
    const { pairs } = kinds([
      doc('b', '04 Finance/Budget vs Actual Q3.pdf'), doc('bu', '04 Finance/Budget.xlsx'),
      doc('lt', 'Leases/Landlord vs Tenant dispute summary.pdf'), doc('ll', 'Leases/Landlord.pdf'),
      doc('g', '03 Legal/Gas Transportation Precedent Agreement.pdf'), doc('cp', '04 Finance/Conditions Precedent Checklist.xlsx'),
    ]);
    expect(pairs).toEqual({});
  });

  it('works out a 2,000-document room with 150 blacklines quickly', () => {
    const docs: BlacklineDoc[] = []; const kinds2 = ['PPA', 'EPC Contract', 'Credit Agreement', 'LTSA', 'O&M Agreement', 'Interconnection Agreement', 'Ground Lease', 'Security Agreement'];
    for (let i = 0; i < 1850; i++) docs.push(doc(`d${i}`, `0${(i % 9) + 1} Folder ${i % 40}/${kinds2[i % kinds2.length]} ${['Schedule', 'Exhibit', 'Notice', 'Certificate'][i % 4]} ${i} v${(i % 5) + 1}.docx`));
    for (let i = 0; i < 150; i++) docs.push(doc(`b${i}`, `0${(i % 9) + 1} Folder ${i % 40}/${kinds2[i % kinds2.length]} Notice ${i} v3 Redline to ${kinds2[i % kinds2.length]} Notice ${i} v2.pdf`));
    const t = Date.now(); const pairs = cleanDrafts(docs); againstOf(docs, pairs);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
