// @vitest-environment node
// The first pass and Check again on the search agent: what to read for an item is searched for, the search trail is
// kept and shown on a gap, a search that cannot be made never makes a gap by itself, and Check again starts from each
// satisfied item's own documents.
import { describe, it, expect } from 'vitest';
import {
  setup,
  doc,
  val,
  deal,
  listed,
  sentNames,
  itemsIn,
  checkLines,
  Mem,
  type Call,
  OK,
  LISTED_ID,
} from './reviewKit';
import type { DocRecord } from '../../src/backend/documents';

const pad = (n: number) => String(n).padStart(4, '0');
/** a realistic data room: 2,000 land documents nobody asks about, and the few that matter */
const land = Array.from({ length: 2000 }, (_, i) => doc(1000 + i, `Easement ${pad(i)}.pdf`, { rel: `05 Land/Easement ${pad(i)}.pdf`, words: ['easement', 'landowner', 'grantor', 'cable', 'route'] }));
const permit = doc(1, 'EPA Consent 2024-117.pdf', { rel: '07 Permits/EPA Consent 2024-117.pdf', words: ['consent', 'discharge', 'conditions'] });
const insurance = doc(2, 'Litware certificate.pdf', {
  rel: '09 Insurance/Litware certificate.pdf',
  words: ['insured', 'policy', 'construction', 'all', 'risks'],
});
const room: DocRecord[] = [...land, permit, insurance];
const items = [
  { id: 'p1', text: 'The environmental permits for operation are in place' },
  { id: 'i1', text: 'Construction all risks insurance is in force' },
  { id: 'h1', text: 'A hedging strategy has been approved by the board' },
];
const checklist = () => ({ broad: items, product: [], sector: [] });
/** a fast model that searches as a person would: the permit by its usual name, the insurance by the policy, and nothing that the hedging item could find */
const queries = (c: Call) => { const out: Record<string, string[]> = {}; for (const m of c.prompt.matchAll(/^(I\d+): (.*)$/gm)) out[m[1]] = /permit/i.test(m[2]) ? ['EPA consent', 'discharge conditions'] : /insurance/i.test(m[2]) ? ['construction all risks policy'] : ['hedge swap ISDA']; return { queries: out }; };
/** a standard model that settles what it is given the right document for, and asks for more otherwise */
const answer = (c: Call) => ({
  items: itemsIn(c).map((it) => {
    const name = /permit/i.test(it.text) ? 'EPA' : /insurance/i.test(it.text) ? 'Litware' : null;
    const d = name ? new RegExp(`^(${LISTED_ID}): [^\\n]*${name}`, 'm').exec(c.prompt) : null;
    return d
      ? {
          id: it.tag,
          ...OK(c),
          ...(OK(c).where ? { where: [{ doc: d[1], page: 1, quote: 'As the item requires.' }] } : {}),
        }
      : { id: it.tag, result: 'more', need: it.text };
  }),
});
/** a fast model that picks whatever its searches found, the first of them first */
const pickFound = (c: Call) => ({ read: listed(c).slice(0, 2).map((r) => r.id) });
const pickForFound = (c: Call) => {
  const out: Record<string, string[]> = {};
  for (const m of c.prompt.matchAll(/^(I\d+): .*\(its searches found ([\w, ]+)\)$/gm))
    out[m[1]] = m[2].split(', ').slice(0, 2);
  return { read: out };
};

describe('checks on the search agent', () => {
  it('the documents an item’s searches find head the pick, the item is settled on them, and a gap keeps the trail of what was searched for', async () => {
    const shared = new Mem();
    const s = setup(answer, { d1: room }, { shared, installId: 'pc', checklist, query: queries, pick: pickFound, pickFor: pickForFound });
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    // the permit and the certificate were found by their searches among 2,002 documents, and head the list the fast model picked from
    const head = listed(s.pickCalls[0] as Call).slice(0, 2).map((x) => x.path);
    expect(head.sort()).toEqual([
      'vdr/07 Permits/EPA Consent 2024-117.pdf',
      'vdr/09 Insurance/Litware certificate.pdf',
    ]);
    expect(sentNames(s.calls[0])).toEqual(['EPA Consent 2024-117.pdf', 'Litware certificate.pdf']);
    // the hedging item found nothing, was searched once more in other words, and only then became a gap: no pick was asked for it
    // (asked with the other items first, then on its second look for what it said it needed: each time once more in other words)
    expect(s.queryCalls.length).toBe(4); expect(s.queryCalls[1].prompt).toContain('searched already, finding nothing: "hedge swap ISDA"');
    expect(s.pickForCalls).toEqual([]);
    expect(r.gaps).toEqual([{ title: 'A hedging strategy has been approved by the board' }]);
    const rows = val(await s.ai.checklist('d1')); const gap = rows.find((x) => x.id === 'h1')!;
    expect(gap.searched).toEqual(Array(4).fill({ q: 'hedge swap ISDA', n: 0 }));
    expect(rows.find((x) => x.id === 'p1')).toMatchObject({ result: 'satisfied' }); expect(rows.find((x) => x.id === 'p1')!.searched).toBeUndefined();   // the trail is shown on gaps only
    expect(checkLines(shared).find((l) => l.item === 'p1')?.trail?.[0]).toEqual({ q: 'EPA consent', n: 1 });
  });

  it('a search that cannot be made is never a gap by itself: documents are picked as they were before searches', async () => {
    const s = setup(
      answer,
      { d1: room },
      {
        checklist,
        query: () => 'I am not sure what to search for.',
        pick: (c) => ({
          read: listed(c as Call)
            .filter((r) => /EPA|Litware/.test(r.path))
            .map((r) => r.id),
        }),
        pickFor: () => ({ read: { I1: [] } }),
      },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(s.queryCalls.length).toBe(2);                                         // step one and the second look each asked, and neither could be read
    expect(s.pickForCalls.length).toBe(1);                                       // so the second look was picked for as before, by the fast model
    expect(r.gaps).toEqual([{ title: 'A hedging strategy has been approved by the board' }]);
    expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched).toBeUndefined();   // no search was made, so there is no trail to show
  });

  it('a reply that gives an item no searches is not taken to mean nothing was found: it is picked for as before, never made a gap by itself', async () => {
    // the reply can be read, but names no search for anything (or for an item when asked once more): the items are picked for, as on main
    for (const query of [() => ({ queries: {} }), () => ({ queries: { I1: [], I2: [], I3: [] } }), () => ({ queries: { I1: ['N/A'], I2: ['-', 'the of a'], I3: ['…'] } }), () => ({ queries: { I1: ['None'], I2: ['not applicable', 'TBD'], I3: ['unknown', 'no search needed'] } }), () => ({ queries: { I1: ['No searches'], I2: ['No searches needed', 'Nones'], I3: ['Unknowns', 'n.a.'] } }), (c: Call, n: number) => (n === 1 ? queries(c) : { queries: {} })]) {
      const s = setup(
        answer,
        { d1: room },
        {
          checklist,
          query,
          pick: (c) => ({
            read: listed(c as Call)
              .filter((r) => /EPA|Litware/.test(r.path))
              .map((r) => r.id),
          }),
          pickFor: () => ({ read: { I1: [] } }),
        },
      );
      await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
      expect(s.pickForCalls.length).toBe(1); expect(s.pickForCalls[0].prompt).toContain('A hedging strategy');
      expect(r.gaps).toEqual([{ title: 'A hedging strategy has been approved by the board' }]);   // a gap only because the pick found nothing, as before searches
      expect(val(await s.ai.checklist('d1')).filter((x) => x.result === 'satisfied').length).toBe(2);
    }
  });

  it('any wording a model uses for "no search" is not a search: the item is picked for, never made a gap by it (probe)', async () => {
    const placeholders = ['No searches', 'No searches needed', 'None found', 'Not required', 'No query', 'No relevant search', 'No further searches', 'No other searches',
      'Nothing further', 'None.', 'N/A', 'n.a.', 'Not applicable', 'TBD', 'Unknown', 'No search terms', 'No keywords available', 'Not needed', 'Nothing to search', 'No additional searches required'];
    for (const p of placeholders) {
      const s = setup(
        answer,
        { d1: room },
        {
          checklist,
          query: (c) => {
            const out: Record<string, string[]> = {};
            for (const m of (c as Call).prompt.matchAll(/^(I\d+): /gm)) out[m[1]] = [p];
            return { queries: out };
          },
          pick: (c) => ({
            read: listed(c as Call)
              .filter((r) => /EPA|Litware/.test(r.path))
              .map((r) => r.id),
          }),
          pickFor: () => ({ read: { I1: [] } }),
        },
      );
      await deal(s.repo); val(await s.ai.firstPass('d1'));
      expect([p, s.pickForCalls.length]).toEqual([p, 1]);                          // the hedging item's second look was picked for, as before searches
      expect([p, val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched]).toEqual([p, undefined]);
    }
    // short real searches still count: they find nothing for the hedging item, so it is searched once more, then a gap with no pick
    for (const q of ['PPA', 'EPC contract', 'O&M agreement', 'term sheet', 'Schedule 1', 'other agreements', 'ISDA', 'LC']) {
      const s = setup(answer, { d1: room }, { checklist, query: (c) => { const out: Record<string, string[]> = {}; for (const m of (c as Call).prompt.matchAll(/^(I\d+): (.*)$/gm)) out[m[1]] = /hedging/i.test(m[2]) ? [q] : ['EPA consent', 'construction all risks policy']; return { queries: out }; }, pick: pickFound, pickFor: pickForFound });
      await deal(s.repo); val(await s.ai.firstPass('d1'));
      expect([q, s.pickForCalls.length]).toEqual([q, 0]);
      expect([q, val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched?.[0]?.q]).toEqual([q, q]);
    }
  }, 30_000);                                                                        // 28 first passes over 2,002 documents, each handing its gap to the chat agent's search: past the default 5 seconds on a busy machine

  it('a reworded gap is searched for afresh, and never shows the searches made for its old wording', async () => {
    let list = items; const shared = new Mem();
    const s = setup(answer, { d1: room }, { shared, installId: 'pc', checklist: () => ({ broad: list, product: [], sector: [] }), query: queries, pick: pickFound, pickFor: pickForFound });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched?.[0].q).toBe('hedge swap ISDA');
    list = items.map((it) => (it.id === 'h1' ? { id: 'h1', text: 'Interest rate swaps are in place for the term loan' } : it));
    const before = s.queryCalls.length; val(await s.ai.firstPass('d1'));
    const asked = s.queryCalls.slice(before).map((c) => c.prompt).join('\n');
    expect(asked).toContain('Interest rate swaps are in place for the term loan');
    const row = val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!;
    expect(row.text).toBe('Interest rate swaps are in place for the term loan');
    // its trail is its own searches, asked with its new wording, not the old wording's carried over
    const now = checkLines(shared).filter((l) => l.item === 'h1' && l.text === row.text).at(-1)!.trail ?? [];
    expect(now.length).toBe(4); expect(s.queryCalls.slice(before).filter((c) => c.prompt.includes('Interest rate swaps')).length).toBe(4);
  });

  it('the search keeps to its budget per deal: with none left it asks no more, and the check still ends', async () => {
    const s = setup(
      answer,
      { d1: room },
      {
        checklist,
        checkSearchCalls: 1,
        query: queries,
        pick: pickFound,
        pickFor: (c) => ({ read: { I1: [listed(c as Call)[0].id] } }),
      },
    );
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(s.queryCalls.length).toBe(1); expect(s.pickForCalls.length).toBe(1);
    expect(r.gaps.length + r.unsettled.length).toBeLessThanOrEqual(1);
    const none = setup(answer, { d1: room }, { checklist, checkSearchCalls: 0, query: queries });
    await deal(none.repo); val(await none.ai.firstPass('d1')); expect(none.queryCalls).toEqual([]);
  });

  it('a search that fails is asked again quietly, and each try counts against the deal\'s budget, since each is paid for', async () => {
    // the fast model sends two empty replies, then searches: the first search is retried twice and answers
    const flaky = (c: Call, n: number) => (n <= 2 ? '' : queries(c));
    const s = setup(answer, { d1: room }, { checklist, query: flaky, pick: pickFound, pickFor: pickForFound });
    await deal(s.repo); const r = val(await s.ai.firstPass('d1'));
    expect(s.queryCalls.length).toBe(6);                                         // step one tried three times, then the three searches the first test makes after it
    expect(r.gaps).toEqual([{ title: 'A hedging strategy has been approved by the board' }]);
    expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched?.length).toBe(4);
    // with three calls for the deal, the three tries of step one spend them all: everything after is picked for as before
    const tight = setup(
      answer,
      { d1: room },
      {
        checklist,
        checkSearchCalls: 3,
        query: flaky,
        pick: pickFound,
        pickFor: (c) => ({ read: { I1: [listed(c as Call)[0].id] } }),
      },
    );
    await deal(tight.repo); val(await tight.ai.firstPass('d1'));
    expect(tight.queryCalls.length).toBe(3); expect(tight.pickForCalls.length).toBe(1);
  });

  it('an item whose second search in other words cannot be made is picked for as before, not taken as a gap', async () => {
    // three calls: step one, the hedging item once more in other words, and its second look; the second look's retry is past the budget
    const s = setup(
      answer,
      { d1: room },
      {
        checklist,
        checkSearchCalls: 3,
        query: queries,
        pick: pickFound,
        pickFor: (c) => ({ read: { I1: [listed(c as Call)[0].id] } }),
      },
    );
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(s.queryCalls.length).toBe(3); expect(s.queryCalls[2].prompt).not.toContain('searched already');
    expect(s.pickForCalls.length).toBe(1); expect(s.pickForCalls[0].prompt).toContain('A hedging strategy');
    expect(s.pickForCalls[0].prompt).not.toContain('its searches found');      // no search answered for it, so the pick is told nothing of searches
  });

  it('Check again starts from each satisfied item’s own documents: no search and no pick for them, and the quick look is given exactly those', async () => {
    const shared = new Mem();
    const s = setup((c) => (c.model === 'fast' ? { items: itemsIn(c).map((it) => ({ id: it.tag, result: 'ok' })) } : answer(c)), { d1: room }, { shared, installId: 'pc', checklist, query: queries, pick: pickFound, pickFor: pickForFound });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    const q0 = s.queryCalls.length, p0 = s.pickCalls.length, c0 = s.calls.length;
    val(await s.ai.checkAll({ dealId: 'd1' }));
    const glances = s.calls.slice(c0).filter((c) => c.model === 'fast');
    const satisfied = glances.find((c) => itemsIn(c).some((it) => /permit/i.test(it.text)))!;
    // the two documents the satisfied items were settled on
    expect(sentNames(satisfied)).toEqual(['EPA Consent 2024-117.pdf', 'Litware certificate.pdf']);
    expect(itemsIn(satisfied).map((it) => it.text).sort()).toEqual(['Construction all risks insurance is in force', 'The environmental permits for operation are in place']);
    // nothing was searched for again: the gap was searched for on these same documents, and keeps its trail
    expect(s.queryCalls.length).toBe(q0);
    expect(s.pickCalls.slice(p0).every((c) => !c.prompt.includes('environmental permits') && !c.prompt.includes('all risks insurance'))).toBe(true);
    expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'h1')!.searched?.[0]).toEqual({ q: 'hedge swap ISDA', n: 0 });
    // once a document arrives, the gap is searched for again, and only the gap
    s.recs.d1 = [...room, doc(9, 'Board minutes.pdf', { rel: '02 Corporate/Board minutes.pdf', words: ['board', 'minutes', 'resolution'] })];
    const q1 = s.queryCalls.length; val(await s.ai.checkAll({ dealId: 'd1' }));
    const asked = s.queryCalls.slice(q1).flatMap((c) => [...c.prompt.matchAll(/^I\d+: (.*)$/gm)].map((m) => m[1]));
    expect(asked.length).toBeGreaterThan(0); expect(asked.every((t) => t.startsWith('A hedging strategy'))).toBe(true);
  });
});
