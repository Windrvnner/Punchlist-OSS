// @vitest-environment node
// A Word draft's tracked changes go whole with it. A request refused as too long lists half of each draft's changes,
// the rest counted, and again, until none is listed, before any document is left out (#1381). Tested at deal scale:
// a 150-page facility agreement draft with 1,000 changed passages beside the deal's other documents.
import { describe, it, expect } from 'vitest';
import { tooLong } from '../../src/backend/limits';
import {
  setup, doc, deal, finding, itemsIn, OK, val, ask, sentNames, clauseChanges, wasLines, isVerifyAsk, affectedAs,
  type Call,
} from './reviewKit';

const PASSAGES = 1_000;
/** the most change lines the stand-in service takes in one request: more is refused as too long */
const TAKES = 300;
const DRAFT = doc(60, 'Facility agreement (markup).docx', {
  tracked: PASSAGES, pages: 150, words: ['facility', 'agreement', 'margin', 'ratio'],
});
const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin', 'ratio'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'margin', 'facility', 'ratio'] });
const isCheck = (p: string) => p.includes('Check each of these checklist items');
const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
/** a stand-in that settles every checklist item it is asked about */
const settles = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
/** a deal's checklist of these items, and the draft's tracked changes */
const checking = (items: { id: string; text: string }[]) => ({
  changes: clauseChanges(PASSAGES), installId: 'pc', checklist: () => ({ broad: items, product: [], sector: [] }),
});

/** a service that refuses, as too long, any request that lists more than `TAKES` change lines */
function refusing(s: ReturnType<typeof setup>) {
  const orig = s.svc.complete.bind(s.svc); const refused = { n: 0 };
  s.svc.complete = async (input) => {
    if (wasLines(input.prompt).length > TAKES) { refused.n++; throw tooLong('too long', 400); }
    return orig(input);
  };
  return refused;
}
/** the changes listed after halving 1,000 until no more than `TAKES` are: 1,000, 500, 250 */
const LISTED = 250;
const COUNTED = `  - and ${PASSAGES - LISTED} more changed passages, not listed here.`;

describe("a draft's tracked changes in a request refused as too long", () => {
  it('an answer\'s read lists half the changes, then half again, and sends every document it chose', async () => {
    const s = setup(() => ({ text: 'The ratio is 1.20x.', sources: [] }), { d1: [DRAFT, FA, TS] },
      { changes: clauseChanges(PASSAGES), library: [] });
    await deal(s.repo); const refused = refusing(s);
    val(await s.ai.answer(ask('What ratio does the facility agreement markup set?')));
    const reads = s.calls.filter((c) => c.prompt.startsWith('Documents:'));
    const last = reads.at(-1)!;
    expect(refused.n).toBe(2);
    expect(sentNames(last)).toContain(DRAFT.name);
    expect(last.files.length).toBe(3);
    expect(wasLines(last.prompt).length).toBe(LISTED);
    expect(last.prompt).toContain(COUNTED);
  });

  it('a check keeps the draft among its documents and settles every item', async () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ id: `c${k + 1}`, text: `Facility point ${k + 1}` }));
    const s = setup(settles, { d1: [DRAFT, FA, TS] }, checking(items));
    await deal(s.repo); const refused = refusing(s);
    const r = val(await s.ai.firstPass('d1'));
    const checks = s.calls.filter((c) => isCheck(c.prompt));
    expect(refused.n).toBeGreaterThan(0);
    expect(r.unsettled).toEqual([]);
    expect(checks.every((c) => sentNames(c).includes(DRAFT.name) && c.files.length === 3)).toBe(true);
    expect(checks.every((c) => wasLines(c.prompt).length === LISTED && c.prompt.includes(COUNTED))).toBe(true);
  });

  it('a re-check of a finding against the new draft lists fewer changes rather than give up', async () => {
    const recs = { d1: [FA, TS] };
    const items = [{ id: 'c1', text: 'Facility agreement ratio is in order' }];
    const s = setup(settles, recs, {
      ...checking(items), affects: (c: Call) => affectedAs(c, 'F1'),
      verify: () => ({ stands: false, why: 'The markup moves the ratio.' }),
    });
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'Ratio differs between the credit agreement and the term sheet',
      { sources: [{ doc: FA.name, docId: FA.docId, loc: 'p. 3' }] });
    val(await s.ai.firstPass('d1'));
    recs.d1.push(DRAFT); const refused = refusing(s);
    const next = val(await s.ai.firstPass('d1'));
    const verifies = s.verifyCalls.filter((c) => isVerifyAsk(c) && sentNames(c).includes(DRAFT.name));
    expect(refused.n).toBeGreaterThan(0);
    expect(verifies.length).toBeGreaterThan(0);
    expect(verifies.every((c) => wasLines(c.prompt).length === LISTED)).toBe(true);
    expect(next.marked).toEqual(['f_1']);
  });

  it('the main session, given the draft, lists fewer changes in its turn rather than fail', async () => {
    const s = setup(() => ({ text: 'The ratio is 1.20x.', sources: [] }), { d1: [DRAFT, FA, TS] },
      { changes: clauseChanges(PASSAGES), library: [] });
    await deal(s.repo); const refused = refusing(s);
    const attachments = [{ doc: DRAFT.name, docId: DRAFT.docId }];
    val(await s.ai.answer(ask('What ratio does the facility agreement markup set?', { attachments })));
    const turns = s.calls.filter((c) => isTurn(c) && sentNames(c).includes(DRAFT.name));
    expect(refused.n).toBeGreaterThan(0);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((c) => wasLines(c.prompt).length === LISTED && c.prompt.includes(COUNTED))).toBe(true);
  });

  it('a whole-folder read sends the draft in its batch with fewer changes rather than leave it unread', async () => {
    const draft = { ...DRAFT, rel: `Drafts/${DRAFT.name}` }; const other = { ...FA, rel: `Drafts/${FA.name}` };
    let turn = 0;
    const answer = (c: Call) => {
      if (c.prompt.includes('In what order should they be read?')) return { order: [] };
      if (!isTurn(c)) return { text: '', sources: [] };
      turn++;
      return turn === 1 ? { tool: 'folder', folder: 'Drafts', lookFor: 'the ratio' } : { text: 'ok', sources: [] };
    };
    const s = setup(answer, { d1: [draft, other, TS] }, { changes: clauseChanges(PASSAGES), library: [] });
    await deal(s.repo); const refused = refusing(s);
    val(await s.ai.answer(ask('What ratio do the drafts set?')));
    const batches = s.calls.filter((c) => c.prompt.includes('which is being read a batch at a time'));
    expect(refused.n).toBeGreaterThan(0);
    expect(batches.some((c) => sentNames(c).includes(DRAFT.name))).toBe(true);
    expect(batches.every((c) => wasLines(c.prompt).length === LISTED)).toBe(true);
    expect(s.calls.some((c) => c.prompt.includes('too long to send together'))).toBe(false);
  });

  it('a request refused for its documents, not its changes, lists every change again once it sends fewer', async () => {
    const s = setup(() => ({ text: 'The ratio is 1.20x.', sources: [] }), { d1: [DRAFT, FA, TS] },
      { changes: clauseChanges(PASSAGES), library: [] });
    await deal(s.repo);
    const orig = s.svc.complete.bind(s.svc);
    s.svc.complete = async (input) => {
      if ((input.files?.length ?? 0) > 2) throw tooLong('too long', 400);
      return orig(input);
    };
    val(await s.ai.answer(ask('What ratio does the facility agreement markup set?')));
    const last = s.calls.filter((c) => c.prompt.startsWith('Documents:')).at(-1)!;
    expect(sentNames(last)).toContain(DRAFT.name);
    expect(wasLines(last.prompt).length).toBe(PASSAGES);
  });
});
