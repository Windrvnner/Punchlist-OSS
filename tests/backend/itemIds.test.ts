// @vitest-environment node
// The model sees checklist items by their permanent ids, never by per-prompt labels, and a reply that names an item
// by an id it was not shown is asked again (#1162).
import { describe, expect, it } from 'vitest';
import { itemId } from '../../src/domain/checklist';
import { tokensOf } from '../../src/backend/limits';
import { checkLines, deal, doc, itemsIn, listed, Mem, OK, setup, val, type Call } from './reviewKit';

const PERMIT = 'The environmental permit for operation is in place';
/** an item whose own words start like a per-prompt label: they pass through as written */
const ROAD = 'I2 road access is granted by the county';
const items = [PERMIT, ROAD].map((text) => ({ id: itemId('d1', text), text }));
const [permitId, roadId] = items.map((it) => it.id);
const room = [doc(1, 'Permit.pdf'), doc(2, 'Road access.pdf'), doc(3, 'Licence.pdf')];
const checklist = () => ({ broad: items, product: [], sector: [] });
const pickAll = (c: Call) => ({ read: listed(c).map((r) => r.id) });
/** an item id with its last character changed: a malformed id the prose check alone would miss */
const nearly = (id: string) => id.slice(0, -1) + (id.endsWith('0') ? '1' : '0');
/** a check reply that settles every item, each named by the given id */
const settle = (c: Call, ids: string[]) => ({ items: ids.map((id) => ({ id, ...OK(c) })) });

async function firstPass(script: (c: Call, n: number) => unknown, more: Parameters<typeof setup>[2] = {}) {
  const shared = new Mem();
  const s = setup(script, { d1: room }, { shared, installId: 'pc', checklist, pick: pickAll, ...more });
  await deal(s.repo);
  const pass = val(await s.ai.firstPass('d1'));
  const results = new Map(checkLines(shared).filter((l) => l.item).map((l) => [l.item, l.result]));
  const trails = new Map(checkLines(shared).filter((l) => l.item).map((l) => [l.item, l.trail]));
  return { s, pass, results, trails };
}
/** a search reply giving each item one search, its second word, under the given ids */
const searches = (ids: string[]) =>
  ({ queries: Object.fromEntries(ids.map((id, k) => [id, [items[k].text.split(' ')[1]]])) });

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

describe('a search names checklist items by their ids (#1162)', () => {
  it('lists each item by its id and takes the searches given under it', async () => {
    const { s, trails } = await firstPass((c) => settle(c, [permitId, roadId]), {
      query: () => searches([permitId, roadId]),
    });
    expect(s.queryCalls[0].prompt).toContain(`\n${permitId}: ${PERMIT}\n${roadId}: ${ROAD}\n`);
    expect(s.queryCalls[0].prompt).not.toMatch(/^I1: /m);
    expect(trails.get(permitId)?.[0]?.q).toBe('environmental');
  });

  it('asks again, quietly, when a reply names an item id with one character changed', async () => {
    const { s, trails } = await firstPass((c) => settle(c, [permitId, roadId]), {
      query: (_c, n) => searches(n === 1 ? [nearly(permitId), roadId] : [permitId, roadId]),
    });
    expect(s.queryCalls[1].prompt).toBe(s.queryCalls[0].prompt);
    expect(trails.get(permitId)?.[0]?.q).toBe('environmental');
  });
});

describe('a pick for several items names them by their ids (#1162)', () => {
  /** a check that asks for the licence for every item it has not been sent the licence for, and settles the rest */
  const needLicence = (c: Call) => (c.prompt.includes('Licence.pdf')
    ? settle(c, itemsIn(c).map((it) => it.tag))
    : { items: itemsIn(c).map((it) => ({ id: it.tag, result: 'more', need: 'the licence' })) });
  const pickPermit = (c: Call) => ({ read: listed(c).filter((r) => r.path.includes('Permit')).map((r) => r.id) });
  /** the licence's id in a pick's listing */
  const licence = (c: Call) => listed(c).filter((r) => r.path.includes('Licence')).map((r) => r.id);

  it('lists each item by its id and reads the files picked under it', async () => {
    const { s, results } = await firstPass(needLicence, {
      pick: pickPermit,
      pickFor: (c) => ({ read: { [permitId]: licence(c), [roadId]: [] } }),
    });
    const asked = `\n${permitId}: ${PERMIT} Still needed: the licence\n${roadId}: ${ROAD} Still needed: the licence\n`;
    expect(s.pickForCalls[0].prompt).toContain(asked);
    expect(s.pickForCalls[0].prompt).not.toMatch(/^I1: /m);
    expect(itemsIn(s.calls[1]).map((it) => it.tag)).toEqual([permitId]);
    expect(results.get(permitId)).toBe('ok');
  });

  it('asks again, quietly, when a reply names an item id with one character changed', async () => {
    const { s, results } = await firstPass(needLicence, {
      pick: pickPermit,
      pickFor: (c, n) => ({ read: { [n === 1 ? nearly(permitId) : permitId]: licence(c), [roadId]: [] } }),
    });
    expect(s.pickForCalls.length).toBe(2);
    expect(s.pickForCalls[1].prompt).toBe(s.pickForCalls[0].prompt);
    expect(results.get(permitId)).toBe('ok');
  });
});

describe('phrasing names each point by its record id (#1162)', () => {
  const FINDING = 'f_01JD5Z6Q7W8X9Y0ZABCDEFGHJK';
  const points = [
    { kind: 'gap' as const, id: permitId, what: PERMIT, need: 'the permit' },
    { kind: 'finding' as const, id: FINDING, what: 'Lock-up ratio differs', need: '' },
  ];
  const isPhrase = (c: Call) => c.prompt.includes('Write one question for the counterparty');
  /** a phrase reply with a question for each point, under the given ids, the finding's first */
  const questions = (ids: string[]) => ({ items: [{ id: ids[1], text: 'Q2' }, { id: ids[0], text: 'Q1' }] });
  async function phrase(script: (n: number) => unknown) {
    const s = setup((c, n) => (isPhrase(c) ? script(n) : {}), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd1', items: points }));
    return { calls: s.calls.filter(isPhrase), out };
  }

  it('tags a gap by its item id and a finding by its finding id, and keeps each question under its id', async () => {
    const { calls, out } = await phrase(() => questions([permitId, FINDING]));
    expect(calls[0].prompt).toContain(
      `\n${permitId}: [gap] ${PERMIT} — needed: the permit\n${FINDING}: [finding] Lock-up ratio differs\n`);
    expect(out).toEqual(['Q1', 'Q2']);
  });

  it('asks again, quietly, when a reply names a point by an id with one character changed', async () => {
    const { calls, out } = await phrase((n) => questions(n === 1 ? [permitId, nearly(FINDING)] : [permitId, FINDING]));
    expect(calls.length).toBe(2);
    expect(calls[1].prompt).toBe(calls[0].prompt);
    expect(out).toEqual(['Q1', 'Q2']);
  });
});

describe('parts are sized with each item\'s id counted (#1162)', () => {
  /** the tokens the lines of a prompt that start with an item id take, ids included */
  const idLines = (prompt: string) =>
    (prompt.match(/^i_[0-9a-f]{24}: .*$/gm) ?? []).reduce((n, l) => n + tokensOf(l), 0);
  /** 60% of the input limit: what a part's items are sized to fill (control: limits.partShare) */
  const LIMIT = 500;
  const share = LIMIT * 0.6;
  const short = Array.from({ length: 40 }, (_, k) => `Item ${k + 1} is in place`)
    .map((text) => ({ id: itemId('d1', text), text }));

  it('a check part\'s item lines, ids and all, fit its share of the input limit', async () => {
    const shared = new Mem();
    const s = setup((c) => settle(c, itemsIn(c).map((it) => it.tag)), { d1: room },
      { shared, installId: 'pc', checklist: () => ({ broad: short, product: [], sector: [] }), pick: pickAll });
    s.svc.inputLimit = () => LIMIT;
    await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    expect(s.calls.length).toBeGreaterThan(0);
    for (const c of s.calls) expect(idLines(c.prompt)).toBeLessThanOrEqual(share);
  });

  it('a phrase part\'s point lines, ids and all, fit its share of the input limit', async () => {
    const isPhrase = (c: Call) => c.prompt.includes('Write one question for the counterparty');
    const s = setup((c) => (isPhrase(c) ? { items: [] } : {}), {}, { shared: new Mem(), installId: 'pc' });
    s.svc.inputLimit = () => LIMIT;
    const gaps = short.map((it) => ({ kind: 'gap' as const, id: it.id, what: it.text, need: '' }));
    await s.ai.phrase!({ dealId: 'd1', items: gaps });
    const asked = s.calls.filter(isPhrase);
    expect(asked.length).toBeGreaterThan(0);
    for (const c of asked) expect(idLines(c.prompt)).toBeLessThanOrEqual(share);
  });
});
