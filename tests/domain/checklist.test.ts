import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { norm, key, itemId, sha256Hex, itemsFor, orderItems, dealLayers, Item, firmOf, listId } from '../../src/domain/checklist';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const list = (lists: any[]) => firmOf(lists.map((l) => ({ ...l, id: listId(l.layer, l.name), rev: 1, createdAt: '2026-11-14T10:00:00.000Z', updatedAt: '2026-11-14T10:00:00.000Z', file: '', fileDate: '' })));
const layer = (l: string, name: string, items: string[]) => ({
  layer: l,
  name,
  items: items.map((text) => ({ text })),
  by: 'adoe',
  at: '2026-11-14T10:00:00.000Z',
});

describe('wording', () => {
  it('norm straightens quotes and dashes, drops invisible characters and collapses spaces', () => {
    expect(norm('  The sponsor’s “equity” is   in place – fully​  ')).toBe('The sponsor\'s "equity" is in place - fully');
    expect(norm('ofﬁce')).toBe('office');
    expect(norm('co­operation')).toBe('cooperation');
  });
  it('key folds case fully and drops a final period', () => {
    expect(key('Straße')).toBe(key('STRASSE'));
    expect(key('Insurance is in place.')).toBe(key('insurance is in place'));
    expect(key('a.b')).toBe('a.b');
  });
  it('wording that normalizes to nothing has no key', () => {
    expect(key(' ​  ')).toBe('');
  });
});

describe('ids', () => {
  it('sha256Hex matches Node, including non-Latin text and inputs around a block boundary', () => {
    for (const s of ['', 'abc', `${D}\0insurance`, 'é中文🙂', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)])
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
  it('an item id is the deal plus the key of its wording', () => {
    expect(itemId(D, 'Insurance is in place.')).toBe(itemId(D, '  insurance IS in place'));
    expect(itemId(D, 'Insurance is in place')).not.toBe(itemId('d_01HYYYYYYYYYYYYYYYYYYYYYYY', 'Insurance is in place'));
    expect(itemId(D, 'x')).toMatch(/^i_[0-9a-f]{24}$/);
    expect(itemId(D, 'x')).toBe('i_' + createHash('sha256').update(`${D}\0x`).digest('hex').slice(0, 24));
  });
});

describe('what a deal should hold', () => {
  const firm = list([
    layer('broad', '', ['Insurance is in place', 'The model is audited']),
    layer('product', 'Construction-to-term loan', ['Completion tests are defined', 'insurance is in place.']),
    layer('technology', 'Solar', ['Module warranties are at least 10 years']),
  ]);
  it('takes the general list and the lists named by the deal, each wording once, naming every layer that holds it', () => {
    const got = itemsFor(firm, { product: 'construction-to-term  loan', sector: 'Data centers', technology: '' });
    expect(got.map((x) => x.text)).toEqual(['Insurance is in place', 'The model is audited', 'Completion tests are defined']);
    expect(got[0].from).toEqual([{ layer: 'broad', value: '', rev: 1 }, { layer: 'product', value: 'Construction-to-term loan', rev: 1 }]);   // each with the rev of the list that adds it
  });
  it('a deal with no layers set gets the general list only, and no list at all gives nothing', () => {
    expect(itemsFor(firm, {}).length).toBe(2);
    expect(itemsFor(null, { product: 'x' })).toEqual([]);
    expect(dealLayers({ product: ' ', sector: 'Solar' }).map((l) => l.layer)).toEqual(['broad', 'sector']);
  });
  it('orders items by the firm list, then the rest by when they were added', () => {
    const it = (text: string, at: string, layerName = 'broad') => Item.parse({ id: itemId(D, text), dealId: D, rev: 1, createdAt: at, updatedAt: at, text, from: [{ layer: layerName, value: '' }] });
    const items = [it('A person\'s own', '2026-11-01T00:00:00.000Z', 'deal'), it('Gone from the list', '2026-11-02T00:00:00.000Z'), it('Completion tests are defined', '2026-11-03T00:00:00.000Z', 'product'), it('Insurance is in place', '2026-11-04T00:00:00.000Z')];
    expect(orderItems(items, firm).map((x) => x.text)).toEqual(['Insurance is in place', 'Completion tests are defined', 'Gone from the list', 'A person\'s own']);
  });
});
