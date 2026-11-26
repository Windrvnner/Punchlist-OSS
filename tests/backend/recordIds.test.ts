import { describe, expect, it } from 'vitest';
import {
  citedDocs, citesUnsent, docHandle, docsUnusable, namesOnlyShown, recordIdsIn, sentAs, unknownIds,
} from '../../src/backend/recordIds';

const ULID = '01HZX3K9Q4V7M2B5N8C1D6E0FG';
const HEX = 'a1b2c3d4e5f60718293a4b5c';
const doc = `doc_${HEX}`;
const finding = `f_${ULID}`;
const item = `i_${HEX}`;
const question = `q_${ULID}`;

describe('recordIdsIn', () => {
  it('finds a finding, document, checklist item and question id in prose, each once', () => {
    const text = `See ${finding}, ${doc}, ${item} and ${question}; again ${doc}.`;
    expect(recordIdsIn(text)).toEqual([finding, doc, item, question]);
  });

  it('finds nothing in "R1.2 billion" or "D2 road"', () => {
    expect(recordIdsIn('R1.2 billion for the D2 road')).toEqual([]);
  });

  it('does not match a document id in the wrong case', () => {
    expect(recordIdsIn(`DOC_${HEX.toUpperCase()}`)).toEqual([]);
  });
});

describe('namesOnlyShown', () => {
  it('accepts prose naming only shown ids and rejects one that changed a character', () => {
    expect(namesOnlyShown(`In ${doc}.`, [doc])).toBe(true);
    expect(namesOnlyShown(`In doc_${HEX.slice(0, 23)}b.`, [doc])).toBe(false);
  });

  it('rejects a shown id of another kind and accepts prose with no ids', () => {
    expect(namesOnlyShown(`In ${finding}.`, [doc])).toBe(false);
    expect(namesOnlyShown('No ids here', [])).toBe(true);
  });
});

describe('unknownIds', () => {
  it('returns the values that were not shown, by exact equality', () => {
    expect(unknownIds(['f_X', finding], [finding])).toEqual(['f_X']);
    expect(unknownIds([`DOC_${HEX}`, doc], [doc])).toEqual([`DOC_${HEX}`]);
    expect(unknownIds([` ${doc}`, 5, undefined], [doc])).toEqual([` ${doc}`, 5, undefined]);
  });
});

describe('documents by their permanent id (#1162)', () => {
  const rec = (docId: string, name: string) => ({ docId, hash: 'h', name, folder: 'vdr', rel: name, size: 1 });
  const where = (r: { rel: string }) => `vdr/${r.rel}`;
  const fa = { dealId: 'd_1', rec: rec(doc, 'Credit Agreement.pdf') };
  const copy = { dealId: 'd_2', rec: rec(doc, 'Credit Agreement.pdf') };

  it('names a document by its docId, or by deal and docId in a prompt that spans deals', () => {
    expect(docHandle(fa, false)).toBe(doc);
    expect(docHandle(fa, true)).toBe(`d_1/${doc}`);
  });

  it('finds the documents a reply cites, at any depth, under "doc" or "document"', () => {
    const reply = { sources: [{ doc: 'a' }], items: [{ where: [{ document: 'b' }], sources: [{ doc: 3 }] }] };
    expect(citedDocs(reply)).toEqual(['a', 'b', 3]);
    expect(citedDocs(null)).toEqual([]);
  });

  it('takes a citation by its id, exactly, or by its whole name or path', () => {
    expect(sentAs(doc, [fa], where)).toBe(fa);
    expect(sentAs(`d_2/${doc}`, [fa, copy], where)).toBe(copy);
    expect(sentAs(doc.toUpperCase(), [fa], where)).toBeUndefined();
    expect(sentAs('vdr/Credit Agreement.pdf', [fa], where)).toBe(fa);
    expect(sentAs('D1', [fa], where)).toBeUndefined();
  });

  it('a reply cites only documents it was given, by the id it was shown or a name or path', () => {
    expect(citesUnsent({ sources: [{ doc }] }, [fa], false, where)).toBe(false);
    expect(citesUnsent({ sources: [{ doc: 'Credit Agreement.pdf' }] }, [fa], false, where)).toBe(false);
    expect(citesUnsent({ sources: [{ doc: `doc_${HEX.slice(0, 23)}` }] }, [fa], false, where)).toBe(true);
    expect(citesUnsent({ sources: [{ doc }] }, [fa, copy], true, where)).toBe(true);
    expect(citesUnsent({ sources: [{ doc: `d_2/${doc}` }] }, [fa, copy], true, where)).toBe(false);
  });
});

describe('docsUnusable (#1162)', () => {
  const fa = { dealId: 'd_1', rec: { docId: doc, hash: 'h', name: 'FA.pdf', folder: 'vdr', rel: 'FA.pdf', size: 1 } };
  const check = docsUnusable([fa], false, ['text'], (r) => r.rel, [question]);
  it('takes a reply that cites and names only what it was shown', () => {
    expect(check(JSON.stringify({ text: `Per ${question} and ${doc}.`, sources: [{ doc, page: 1 }] }))).toBe(false);
  });
  it('refuses one naming an id it was not shown in its words, or citing a document it was not given', () => {
    expect(check(JSON.stringify({ text: `Per ${finding}.`, sources: [] }))).toBe(true);
    expect(check(JSON.stringify({ text: 'So. [1]', sources: [{ doc: 'D1', page: 1 }] }))).toBe(true);
  });
});
