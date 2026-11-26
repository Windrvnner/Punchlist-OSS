// @vitest-environment node
// Filling gaps through the chat agent (docs/core-documents-design.md, part 4): the agent only ever adds to what a check
// found, and every call it makes counts against an allowance of its own, so it never takes the check's own searches.
import { it, expect } from 'vitest';
import { setup, doc, val, deal, itemsIn, OK, isPickAsk, LISTED_ID, type Call } from './reviewKit';
import type { DocRecord } from '../../src/backend/documents';

const esc = (d: DocRecord) => d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a document's id as the call listed it (#1162)
const tag = (c: Call, d: DocRecord) =>
  new RegExp(`^(${LISTED_ID})(?: \\*)?: (?:.*/)?${esc(d)}`, 'm').exec(c.prompt)?.[1] ?? 'doc_?';
const idsOf = (c: Call, ...docs: DocRecord[]) => docs.map((d) => tag(c, d));
const has = (c: Call, d: DocRecord) => tag(c, d) !== 'doc_?';
const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
const FA = doc(1, 'Credit Agreement.pdf'); const TS = doc(2, 'Term sheet.pdf');
const PLAN = doc(16, 'DEC-77.pdf',
  { rel: '09 Misc/DEC-77.pdf', pages: 3, summary: 'Decommissioning plan for the site.' });

it('an item the documents the agent cites leave open, cited for another item of its run, is written exactly as the check left it', async () => {
  const X1 = { id: 'x1', text: 'Decommissioning is provided for' }; const X2 = { id: 'x2', text: 'Insurance is in place' }; const X3 = { id: 'x3', text: 'Water rights are secured' };
  // x1 needs the plan; x2's reply could never be used, so it is not settled; x3 is a gap; against the plan, x2 and x3 would say they need something else
  const s = setup(
    (c) => ({
      items: itemsIn(c).map((it) => ({
        id: it.tag,
        ...(it.text.startsWith('Decom')
          ? has(c, PLAN)
            ? OK(c)
            : { result: 'more', need: 'a decommissioning plan' }
          : has(c, PLAN)
            ? { result: 'more', need: 'something else' }
            : it.text.startsWith('Insurance')
              ? { result: 'banana' }
              : { result: 'more', need: 'the water rights' }),
      })),
    }),
    { d1: [FA, TS, PLAN] },
    {
      checklist: () => ({ broad: [X1, X2, X3], product: [], sector: [] }),
      pick: (c) => ({ read: idsOf(c, FA) }),
      pickFor: () => ({ read: {} }),
      fill: (c) =>
        isTurn(c)
          ? { text: 'DEC-77 is the plan. [1] Nothing on the others.', sources: [{ doc: tag(c, PLAN), page: 1 }] }
          : { text: 'It is the plan. [1]', sources: [{ doc: tag(c, PLAN), page: 1, quote: 'The plan' }] },
    },
  );
  await deal(s.repo); val(await s.ai.firstPass('d1'));
  expect(s.calls.some((c) => itemsIn(c).length === 3 && has(c, PLAN))).toBe(true);                       // the plan was read against all three
  const rows = val(await s.ai.checklist('d1')); const row = (id: string) => rows.find((x) => x.id === id)!;
  expect(row('x1')).toMatchObject({ result: 'satisfied' });
  // still tried again by the next check
  expect(row('x2')).toMatchObject({ result: 'unsettled', why: 'The AI’s reply on it could not be used.' });
  expect(row('x3')).toMatchObject({ result: 'gap', need: 'the water rights' });                            // its need as the check found it
});

it('every call the agent makes counts against its own allowance, so a busy agent stops and the check\'s own searches are untouched', async () => {
  const items = Array.from({ length: 60 }, (_x, i) => ({ id: `g${i + 1}`, text: `Gap item ${i + 1} on decommissioning` }));
  // an agent that reads the whole folder on every turn it has
  const turn = (c: Call) => { const n = +(/This is turn (\d+) of/.exec(c.prompt)?.[1] ?? 99); return n < 25 ? { tool: 'folder', folder: 'vdr', lookFor: `decommissioning ${n}` } : { text: 'Nothing settles them.', sources: [] }; };
  const gapAll = (c: Call) => (isTurn(c) ? turn(c) : { items: itemsIn(c).map((it) => ({ id: it.tag, result: 'more', need: 'a decommissioning plan' })) });
  const opts = { checklist: () => ({ broad: items, product: [], sector: [] }), checkSearchCalls: 100, pick: () => ({ read: [] }), pickFor: () => ({ read: {} }), query: (c: Call) => ({ queries: Object.fromEntries([...c.prompt.matchAll(/^(I\d+):/gm)].map((m) => [m[1], ['decommissioning plan']])) }) };
  const quiet = setup(gapAll, { d1: [FA, TS] }, opts); await deal(quiet.repo); val(await quiet.ai.firstPass('d1'));
  const busy = setup(gapAll, { d1: [FA, TS] }, { ...opts, fill: (c: Call) => (isPickAsk(c) ? { read: [] } : isTurn(c) ? turn(c) : { text: '', sources: [] }) }); await deal(busy.repo);
  const r = val(await busy.ai.firstPass('d1'));
  // every call of the agent: its later turns carry only what is new, so the stand-in counts them among the check's calls
  expect(busy.fillCalls.length + busy.calls.filter((c) => isTurn(c)).length).toBeLessThanOrEqual(100 + 3);   // its allowance, and the few calls already under way when it ran out
  expect(busy.queryCalls.length).toBe(quiet.queryCalls.length);                                           // the check searched as much as it would have without it
  expect(r.gaps.length).toBe(60); expect(val(await busy.ai.checklist('d1')).filter((x) => x.result === 'gap' && x.searched?.length).length).toBe(60);
}, 120_000);

it('a problem whose finding could not be saved is never handed to the agent, so it is never written over as satisfied', async () => {
  const X1 = { id: 'x1', text: 'Decommissioning is provided for' };
  const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(has(c, PLAN) ? OK(c) : { result: 'finding', title: 'No decommissioning plan', workstream: 'Technical', body: ['None is provided. [1]'], next: '', sources: [{ doc: tag(c, FA), page: 2 }] }) })) }), { d1: [FA, TS, PLAN] }, {
    checklist: () => ({ broad: [X1], product: [], sector: [] }), pick: (c) => ({ read: idsOf(c, FA) }),
    fill: (c) => (isTurn(c)
      ? { text: 'DEC-77. [1]', sources: [{ doc: tag(c, PLAN), page: 1 }] }
      : { text: 'Plan. [1]', sources: [{ doc: tag(c, PLAN), page: 1, quote: 'Plan' }] }) });
  await deal(s.repo);
  const write = s.repo.transaction.bind(s.repo); s.repo.transaction = (async (t: Parameters<typeof write>[0]) => (t.writes?.some((w) => w.kind === 'finding') ? { ok: false, error: { kind: 'failed', message: 'no' } } : write(t))) as typeof write;
  val(await s.ai.firstPass('d1'));
  expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'x1')).toMatchObject({ result: 'unsettled', why: 'The finding it raised could not be saved.' });
  expect(s.fillCalls).toEqual([]);
});

it('each document search the gap filler makes has a search\'s own calls, as a chat\'s does', async () => {
  const X1 = { id: 'x1', text: 'Water rights are secured' };
  const isSearchRead = (c: Call) => !isTurn(c) && c.prompt.includes('what they say, with [n] markers');
  let n = 0;
  // 20 searches, each in other words, then an answer
  const turn = () => {
    n++;
    const search = { tool: 'search', what: 'documents', query: `term sheet ${'x'.repeat(n)}` };
    return n <= 20 ? search : { text: 'Nothing.', sources: [] };
  };
  const reply = (c: Call) => (isTurn(c) ? turn() : isSearchRead(c) ? { text: 'nothing here', sources: [] }
    : { items: itemsIn(c).map((it) => ({ id: it.tag, result: 'more', need: 'the water rights' })) });
  const s = setup(reply, { d1: [FA, TS] }, { checklist: () => ({ broad: [X1], product: [], sector: [] }),
    pick: () => ({ read: [] }), pickFor: () => ({ read: {} }), fill: reply, searchCalls: 15 });
  await deal(s.repo);
  val(await s.ai.firstPass('d1'));
  const turns = s.all.filter(isTurn);
  expect(turns.filter((c) => c.prompt.includes('as many calls as one search may'))).toEqual([]);
  expect(s.all.filter(isSearchRead).length).toBeGreaterThan(15);
}, 120_000);
