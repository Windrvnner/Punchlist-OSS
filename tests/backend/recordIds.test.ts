import { describe, expect, it } from 'vitest';
import { namesOnlyShown, recordIdsIn, unknownIds } from '../../src/backend/recordIds';

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
