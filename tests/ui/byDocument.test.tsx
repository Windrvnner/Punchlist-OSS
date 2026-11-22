import { describe, it, expect } from 'vitest';
import { byDocument } from '../../src/ui/ref';

// a pop and a finding's list of sources count and list documents, each with its places
describe('byDocument', () => {
  const S = (doc: string, loc: string, docId = 'doc_' + doc) => ({ doc, loc, docId });
  it('groups places under their document, in the order each document is first cited', () => {
    const g = byDocument([S('TA report.pdf', 'p. 41'), S('O&M.pdf', 'cl. 7.2'), S('TA report.pdf', 'p. 44'), S('Model.xlsx', 'Ops!F12'), S('O&M.pdf', 'cl. 7.4')]);
    expect(g.map((x) => `${x.doc.doc} · ${x.places}`)).toEqual(['TA report.pdf · p. 41, p. 44', 'O&M.pdf · cl. 7.2, cl. 7.4', 'Model.xlsx · Ops!F12']);
    expect(g.map((x) => x.items.length)).toEqual([2, 2, 1]);
  });
  it('tells documents apart by id, not by name, and names a place cited twice once', () => {
    const g = byDocument([S('Report.pdf', 'p. 1', 'doc_a'), S('Report.pdf', 'p. 2', 'doc_b'), S('Report.pdf', 'p. 1', 'doc_a')]);
    expect(g.map((x) => [x.doc.docId, x.places])).toEqual([['doc_a', 'p. 1'], ['doc_b', 'p. 2']]);
  });
  it('leaves out empty places and is empty for no sources', () => {
    expect(byDocument([S('Memo.docx', ''), S('Memo.docx', 'p. 3')])[0].places).toBe('p. 3');
    expect(byDocument([S('Memo.docx', '')])[0].places).toBe('');
    expect(byDocument([])).toEqual([]);
  });
});
