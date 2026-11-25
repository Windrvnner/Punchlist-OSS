// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { coverOf, isBlackline, cleanDrafts, type BlacklineDoc } from '../../src/backend/blacklines';

const doc = (docId: string, rel: string, extra: Partial<BlacklineDoc> = {}): BlacklineDoc => ({ docId, name: rel.split('/').pop()!, folder: '/x/VDR', rel, ...extra });

describe('blacklines', () => {
  it('knows one by its name, as a PDF only, whatever the tool calls it', () => {
    expect(['SPA (blackline).pdf', 'SPA - Redline v3 v v2.pdf', 'SPA_blacklined.pdf', 'Lease red-line.pdf'].map((name) => isBlackline({ name }))).toEqual([true, true, true, true]);
    expect(['SPA.pdf', 'SPA (blackline).docx', 'Parcel A lease.pdf', 'Marketing plan.pdf', 'Peer comparison.pdf'].map((name) => isBlackline({ name }))).toEqual([false, false, false, false, false]);
    expect(isBlackline({ name: 'SPA v3 v v2.pdf', cover: 'Comparison of SPA v2.docx and SPA v3.docx' })).toBe(true);   // a plain name, but a comparison cover
  });
  it('takes a weaker word (comparison, compared, marked) as a blackline only with its clean draft beside it by name; otherwise it is an ordinary document', () => {
    const m = cleanDrafts([
      doc('fac', 'Legal/Credit agreement comparison.pdf'), doc('fa', 'Legal/Credit agreement.pdf'), doc('epc', 'Legal/EPC marked-up.pdf'), doc('e', 'Legal/EPC.docx'),
      doc('val', 'Finance/Valuation comparison.pdf'), doc('peer', 'Finance/Peer comparison.pdf'), doc('site', 'Tech/Site plan marked.pdf'), doc('rates', 'Finance/Compared rates.pdf'),
      doc('valrl', 'Finance/Valuation comparison (redline).pdf'),                                         // a blackline of a report whose name has "comparison"
    ]);
    expect(Object.fromEntries(m)).toEqual({ fac: 'fa', epc: 'e', valrl: 'val' });
  });
  it('takes "A vs B" of two drafts of one name as a blackline, with A, the newer, as its clean draft', () => {
    const m = cleanDrafts([
      doc('vs', 'Legal/Credit Agreement v4 vs Credit Agreement v3.pdf'), doc('v4', 'Legal/Credit Agreement v4.docx'),
      doc('both', 'Legal/EPC execution vs EPC draft.pdf'), doc('ex', 'Legal/EPC execution.docx'), doc('dr', 'Legal/EPC draft.docx'),   // both there: A
      doc('old', 'Deal/SPA v4 vs SPA v3.pdf'), doc('s3', 'Deal/SPA v3.docx'),                               // only the older there: unclear, not read against it
      // two names, not two drafts: an ordinary document
      doc('case', 'Legal/Doe vs Roe judgment.pdf'), doc('sm', 'Legal/Doe.pdf'),
      doc('lt', 'Leases/Landlord vs Tenant dispute summary.pdf'), doc('ll', 'Leases/Landlord.pdf'),
      doc('us', 'Tax/Tax_Model_v2_vs_Tax_Model_v1.pdf'), doc('tm', 'Tax/Tax Model v2.xlsx'),                    // underscores for spaces
      doc('none', 'Leases/Lease v2 vs Lease v1.pdf'),                                                       // no draft of either name: an ordinary document
    ]);
    expect(Object.fromEntries(m)).toEqual({ vs: 'v4', both: 'ex', old: null, us: 'tm' });
  });
  it('takes "X Redline to Y" as a blackline of X', () => {
    const m = cleanDrafts([
      doc('a', 'Deal/Project Bellows SPA Redline to Project Bellows SPA v1.pdf'), doc('pa', 'Deal/Project Bellows SPA.docx'),
      doc('b', 'Legal/SPA v3 Redline to SPA v2.pdf'), doc('s3', 'Legal/SPA v3.docx'), doc('s2', 'Legal/SPA v2.docx'),
      doc('c', 'Leases/Agreement to Lease redline.pdf'), doc('al', 'Leases/Agreement to Lease.docx'),
      doc('ex', 'Legal/Exhibit A to SPA redline.pdf'), doc('xa', 'Legal/Exhibit A.pdf'),            // "to" in a title splits nothing: no clean draft, so it stands alone
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: 'pa', b: 's3', c: 'al', ex: false });
  });
  it('reads a comparison tool’s cover page, and nothing else as one', () => {
    expect(coverOf('Comparison Details\nOriginal filename: SPA v2.docx\nModified filename: SPA v3.docx\nChanges: Add 12 Delete 7')).toMatch(/^Comparison Details/);
    expect(coverOf('Document comparison by Workshare Compare. Comparison of C:\\Deals\\SPA v2.doc and C:\\Deals\\SPA v3.doc. Insertions 4 Deletions 2')).not.toBeNull();
    expect(coverOf('Stock Purchase Agreement. The parties compare the accounts.')).toBeNull();
    expect(coverOf('STOCK PURCHASE AGREEMENT between the Seller and the Buyer')).toBeNull();
  });
  it('pairs each with its clean draft: the newer file on its cover, else its own name without the blackline word, else the newest of that family', () => {
    const m = cleanDrafts([
      doc('cov', 'Legal/SPA v3 v v2.pdf', { cover: 'Comparison of SPA v2.docx and SPA v3.docx. Insertions 4 Deletions 2' }), doc('v2', 'Legal/SPA v2.docx'), doc('v3', 'Legal/Old/SPA v3.docx'),
      doc('nm', 'Finance/Credit agreement (blackline).pdf'), doc('fa', 'Finance/Credit agreement.pdf'), doc('fa2', 'Other/Credit agreement.pdf'),
      doc('ts', 'Legal/Term sheet (signed) blackline.pdf'), doc('t', 'Legal/Term sheet (signed).pdf'), doc('fam', 'EPC/EPC contract - redline.pdf'), doc('e1', 'EPC/Drafts/2026-03-01/EPC contract.docx', { seen: '2026-03-02' }), doc('e2', 'EPC/Drafts/2026-04-15/EPC contract.docx', { seen: '2026-04-16' }),
    ]);
    expect(Object.fromEntries(m)).toEqual({ cov: 'v3', nm: 'fa', ts: 't', fam: 'e2' });
  });
  it('has none when it is unclear: two files of the cover’s name in other folders, or two families', () => {
    const m = cleanDrafts([
      doc('b1', 'Legal/SPA v3 v v2.pdf', { cover: 'Comparison of SPA v2.docx and SPA v3.docx. Insertions 4 Deletions 2' }), doc('a', 'Legal/A/SPA v3.docx'), doc('b', 'Legal/B/SPA v3.docx'),
      doc('b3', 'Legal/Lease (redline).pdf'), doc('l1', 'One/Drafts/2026-01-01/Lease.pdf'), doc('l2', 'One/Drafts/2026-02-01/Lease.pdf'), doc('l3', 'Two/Drafts/2026-01-01/Lease.pdf'), doc('l4', 'Two/Drafts/2026-02-01/Lease.pdf'),
    ]);
    expect(Object.fromEntries(m)).toEqual({ b1: null, b3: null });
  });
  it('stands alone (false) when neither its cover nor its name finds its clean draft', () => {
    const m = cleanDrafts([
      doc('a1', 'Legal/Side letter blackline.pdf'), doc('x', 'Legal/Lease.pdf'),
      doc('a2', 'Legal/SPA v3 v v2.pdf', { cover: 'Comparison of SPA v2.docx and SPA v3.docx. Insertions 4 Deletions 2' }),
      doc('b2', 'Legal/Side letter blackline.pdf'), doc('sl', 'Other/Side letter.pdf'),                   // its name, in another folder only
      doc('w', 'Finance/Valuation comparison.pdf'),                                                     // a weak word alone is no blackline, so it never stands alone
    ]);
    expect(Object.fromEntries(m)).toEqual({ a1: false, a2: false, b2: false });
  });
  it('stands alone beside a file sharing a word of its name, and is unclear when only the original the cover names is there', () => {
    const m = cleanDrafts([
      doc('r1', 'Legal/Credit Agreement - Redline v3 to v2.pdf'), doc('ca', 'Legal/Credit Agreement v3.docx'),
      doc('r2', 'Deal/Blackline - SPA v3 against SPA v2.pdf'), doc('r3', 'Deal/SPA_redline_2026-03-01.pdf'), doc('r4', 'Deal/SPA blackline.pdf'), doc('sx', 'Deal/SPA (execution version).docx'),
      doc('r5', 'Old/EPC v3 v v2.pdf', { cover: 'Comparison of EPC v2.docx and EPC v3.docx. Insertions 4 Deletions 2' }), doc('e2', 'Old/EPC v2.docx'),   // only the original is here
    ]);
    expect(Object.fromEntries(m)).toEqual({ r1: false, r2: false, r3: false, r4: false, r5: null });
  });
});
