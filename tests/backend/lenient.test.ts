// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readJson, list, strings, int, pageOf, word, tagNumber } from '../../src/backend/lenient';

const want = { text: 'It is 1.25x. [1]', sources: [{ doc: 'D1', page: 14 }] };
const read = (reply: string) => readJson(reply, ['text', 'sources']);

describe('reading a reply that is nearly JSON', () => {
  it('reads the object as written, and with whatever is wrapped around it', () => {
    const plain = JSON.stringify(want);
    for (const reply of [plain, `  ${plain}\n`, `﻿${plain}`, `Here is the answer:\n${plain}\nLet me know if you need more.`, '```json\n' + plain + '\n```', 'Sure.\n```\n' + plain + '\n```\nDone.', '```json\n' + plain])
      expect(read(reply)).toEqual(want);
  });

  it('repairs the usual slips: trailing commas, single and curly quotes, bare keys, a line break in a string, True and None, a missing comma', () => {
    expect(read('{"text": "It is 1.25x. [1]", "sources": [{"doc": "D1", "page": 14,},],}')).toEqual(want);
    expect(read("{'text': 'It is 1.25x. [1]', 'sources': [{'doc': 'D1', 'page': 14}]}")).toEqual(want);
    expect(read('{“text”: “It is 1.25x. [1]”, “sources”: [{“doc”: “D1”, “page”: 14}]}')).toEqual(want);
    expect(read('{text: "It is 1.25x. [1]", sources: [{doc: "D1", page: 14}]}')).toEqual(want);
    expect(read('{"text": "It is 1.25x. [1]" "sources": [{"doc": "D1" "page": 14}]}')).toEqual(want);
    expect(read('{"text": "First line.\nSecond line.", "sources": []}')).toEqual({ text: 'First line.\nSecond line.', sources: [] });
    expect(read('{"text": "x", "sources": [], "found": True, "note": None}')).toEqual({ text: 'x', sources: [], found: true, note: null });
    expect(read('{"text": "He said "no" twice.", "sources": []}')).toEqual({ text: 'He said "no" twice.', sources: [] });
  });

  it('a reply cut off before it closed keeps what was complete', () => {
    const cut = readJson('{"items": [{"id": "I1", "result": "ok"}, {"id": "I2", "result": "finding", "title": "Lock-up dif', ['items'])!;
    expect(cut.items).toEqual([{ id: 'I1', result: 'ok' }]);                                                           // the item that was cut is not guessed at: the caller sees it is missing and asks again
    expect(read('```json\n{"text": "It is 1.25x. [1]", "sources": [{"doc": "D1", "page": 14}')).toEqual(want);
  });

  it('of several objects in a reply, the one with a field that was asked for is the answer', () => {
    expect(read('I considered {"option": "a"} and rejected it.\n{"text": "It is 1.25x. [1]", "sources": [{"doc": "D1", "page": 14}]}')).toEqual(want);
    expect(read('The set {x} is empty. {"text": "It is 1.25x. [1]", "sources": [{"doc": "D1", "page": 14}]} That is all.')).toEqual(want);
    expect(read('{"thinking": "the clause says {this}"}\n\n{"text": "It is 1.25x. [1]", "sources": [{"doc": "D1", "page": 14}]}')).toEqual(want);
  });

  it('a reply that is nothing but a list is the list that was asked for; a list in passing is not', () => {
    expect(readJson('[3, 1, 12]', ['read'])).toEqual({ read: [3, 1, 12] }); expect(readJson('```json\n[3, 1]\n```', ['core'])).toEqual({ core: [3, 1] });
    expect(readJson('[{"id": "I1", "result": "ok"}]', ['items'])).toEqual({ items: [{ id: 'I1', result: 'ok' }] });
    expect(readJson('I would read the term sheet [1] first.', ['read'])).toBeNull();
  });

  it('with nothing usable in it, a reply is not read', () => {
    for (const reply of ['', '   ', 'I am sorry, I cannot help with that.', 'no', '{', '}{', '{"other": 1}', 'The set {x} is empty.', '42', '"just a string"']) expect(read(reply)).toBeNull();
  });
});

describe('reading a field that is nearly the shape asked for', () => {
  it('a list, strings, whole numbers and a chosen word', () => {
    expect([list([1, 2]), list('a'), list(null), list(undefined), list({ a: 1 })]).toEqual([[1, 2], ['a'], [], [], [{ a: 1 }]]);
    expect([strings([' a ', '', 7, 'b']), strings(' one '), strings(undefined)]).toEqual([[' a ', 'b'], [' one '], []]);
    expect([int(3), int('3'), int(' 12 '), int('3*'), int(1.5), int('x'), int('1.5'), int(null), int('3 and 4')]).toEqual([3, 3, 12, 3, null, null, null, null, null]);
    expect([word(' OK '), word('Finding'), word(1), word(undefined)]).toEqual(['ok', 'finding', '', '']);
  });

  it('a page is a page however it is written; a clause number is not a page', () => {
    expect([pageOf(14), pageOf('14'), pageOf('p. 14'), pageOf('p14'), pageOf('Page 14'), pageOf('pp. 14-16'), pageOf('14–16')]).toEqual([14, 14, 14, 14, 14, 14, 14]);
    expect([pageOf('clause 14.2'), pageOf('14.2'), pageOf('section 3'), pageOf('s. 14'), pageOf(14.5), pageOf(''), pageOf(null), pageOf('Schedule 2, p. 14')]).toEqual([null, null, null, null, null, null, null, null]);
  });

  it('a tag is read with its letter, in brackets, in either case, or as a bare number; a name that starts with a number is not a tag', () => {
    expect(['D3', 'd3', '[D3]', ' D3: Credit Agreement.pdf', 'Document 3', 'doc #3', '3', '[3]', 3].map((x) => tagNumber(x, 'D'))).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(['I7', 'i7', 'Item 7', '7.', 'I7:'].map((x) => tagNumber(x, 'I'))).toEqual([7, 7, 7, 7, 7]);
    expect(['3 Model.xlsx', '2024 accounts.pdf', 'Credit Agreement.pdf', 'D', '', 0, -1, 1.5, null].map((x) => tagNumber(x, 'D'))).toEqual([null, null, null, null, null, null, null, null, null]);
  });
});
