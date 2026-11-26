// @vitest-environment node
// The model sees checklist items by their permanent ids, never by per-prompt labels, and a reply that names an item
// by an id it was not shown is asked again (#1162).
import { describe, expect, it } from 'vitest';
import { itemId } from '../../src/domain/checklist';
import { checkLines, deal, doc, listed, Mem, OK, setup, val, type Call } from './reviewKit';

const PERMIT = 'The environmental permit for operation is in place';
/** an item whose own words start like a per-prompt label: they pass through as written */
const ROAD = 'I2 road access is granted by the county';
const items = [PERMIT, ROAD].map((text) => ({ id: itemId('d1', text), text }));
const [permitId, roadId] = items.map((it) => it.id);
const room = [doc(1, 'Permit.pdf'), doc(2, 'Road access.pdf')];
const checklist = () => ({ broad: items, product: [], sector: [] });
const pickAll = (c: Call) => ({ read: listed(c).map((r) => r.id) });
/** an item id with its last character changed: a malformed id the prose check alone would miss */
const nearly = (id: string) => id.slice(0, -1) + (id.endsWith('0') ? '1' : '0');
/** a check reply that settles every item, each named by the given id */
const settle = (c: Call, ids: string[]) => ({ items: ids.map((id) => ({ id, ...OK(c) })) });

async function firstPass(script: (c: Call, n: number) => unknown) {
  const shared = new Mem();
  const s = setup(script, { d1: room }, { shared, installId: 'pc', checklist, pick: pickAll });
  await deal(s.repo);
  const pass = val(await s.ai.firstPass('d1'));
  const results = new Map(checkLines(shared).filter((l) => l.item).map((l) => [l.item, l.result]));
  return { s, pass, results };
}

describe('a check names checklist items by their ids (#1162)', () => {
  it('lists each item by its id, with its own words as written', async () => {
    const { s } = await firstPass((c) => settle(c, [permitId, roadId]));
    expect(s.calls[0].prompt).toContain(`\n${permitId}: ${PERMIT}\n${roadId}: ${ROAD}\n`);
    expect(s.calls[0].prompt).not.toMatch(/^I1: /m);
  });

  it('maps a reply naming an item id to that item', async () => {
    const { s, results } = await firstPass((c) => settle(c, [permitId, roadId]));
    expect(s.calls.length).toBe(1);
    expect([results.get(permitId), results.get(roadId)]).toEqual(['ok', 'ok']);
  });

  it('asks again, quietly, when a reply names an item id it was not shown', async () => {
    const unknown = itemId('d1', 'An item of another list');
    const { s, results } = await firstPass((c, n) => settle(c, n === 1 ? [unknown, roadId] : [permitId, roadId]));
    expect(s.calls.length).toBe(2);
    expect(s.calls[1].prompt).toBe(s.calls[0].prompt);
    expect([results.get(permitId), results.get(roadId)]).toEqual(['ok', 'ok']);
  });

  it('asks again when an item id has one character changed, and takes the correct retry', async () => {
    const ids = (n: number) => (n === 1 ? [nearly(permitId), roadId] : [permitId, roadId]);
    const { s, results } = await firstPass((c, n) => settle(c, ids(n)));
    expect(s.calls.length).toBe(2);
    expect(s.calls[1].prompt).toBe(s.calls[0].prompt);
    expect([results.get(permitId), results.get(roadId)]).toEqual(['ok', 'ok']);
  });

  it('a second look names each item it sends back by its id', async () => {
    const { s } = await firstPass((c, n) => settle(c, n === 1 ? [roadId] : [permitId]));
    expect(s.calls[1].prompt).toContain(`Put each right:\n${permitId}: It was missing from your reply.`);
  });
});
