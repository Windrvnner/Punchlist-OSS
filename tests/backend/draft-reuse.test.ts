// @vitest-environment node
// Reusing answers across parties: "Draft response" first searches the deal's Q&A log for questions that read like
// this one and, where an earlier response suits, the draft uses it and names it ("As answered to Lender B (Q12)"),
// alongside the documents. Tested at the scale of a real log: 2,500 questions from many parties.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, type Call } from './reviewKit';
import type { Repository } from '../../src/ports';

const FA = doc(1, 'Credit Agreement.pdf', { summary: 'Senior credit agreement.', keywords: ['lock-up', 'distribution'] });
const parties = ['Lender A', 'Lender B', 'Lender C', 'Bidder A', 'Bidder B', 'Bidder C', 'Rating agency', 'Lenders’ counsel'];
const topics = ['the interconnection timetable', 'the EPC contractor’s liquidated damages cap', 'the O&M fee escalation', 'the land lease term', 'the insurance deductibles', 'the hedging counterparties', 'the tax equity flip date', 'the PPA curtailment compensation', 'the module supplier warranty', 'the decommissioning bond', 'the DSRA sizing', 'the sponsor support undertaking', 'the change in law protection', 'the merchant tail assumptions', 'the interconnection upgrade costs', 'the property tax abatement', 'the availability guarantee', 'the major maintenance reserve', 'the transformer lead times', 'the environmental permit conditions'];
const asks = ['Please confirm', 'Provide details of', 'Explain', 'What is the status of', 'Provide the documents evidencing', 'Describe any changes to', 'Has the sponsor agreed', 'Clarify the basis for'];
/** a log of 2,500 questions, as a deal with several lenders and bidders builds up: most answered, the same topics asked about over and over in other words */
function log(n = 2500) {
  return Array.from({ length: n }, (_, k) => { const t = topics[k % topics.length], a = asks[Math.floor(k / topics.length) % asks.length];
    return { n: k + 100, text: `${a} ${t} (${k}).`, response: k % 3 ? `Per the data room, ${t} is as set out in the relevant agreement, item ${k}.` : '', askedBy: parties[k % parties.length] }; });
}
async function questions(repo: Repository, rows: { n: number; text: string; response: string; askedBy: string }[]) {
  const writes = rows.map((r) => ({ kind: 'question' as const, id: `q_${r.n}`, data: { id: `q_${r.n}`, dealId: 'd1', status: r.response ? 'answered' : 'open', ...r }, expectedRev: null }));
  val(await repo.transaction({ writes, index: { dealId: 'd1', add: writes.map((w) => ({ kind: 'question' as const, id: w.id })) } }));
}
const Q12 = { n: 12, text: 'Confirm the lock-up ratio that applies from financial close and which document prevails.', response: 'The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.', askedBy: 'Lender B' };
const NEW = 'Please confirm which lock-up ratio applies from financial close, and which document prevails if they differ.';
const isDraft = (c: Call) => c.prompt.includes('Draft a response to this question');
/** the earlier responses a draft was shown: R tag and party. Question numbers are never shown to the model (#286). */
const shown = (c: Call) => [...c.prompt.matchAll(/^R(\d+)(?:, submitted by ([^:]+))?:/gm)].map((m) => ({ r: +m[1], by: m[2] ?? '' }));

describe('a draft reuses an answer already given to another party', () => {
  it('among 2,500 questions, the one asked before in other words is found and the draft uses it, named as asked', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: 'The lock-up ratio is 1.20x from financial close, and the credit agreement prevails. [1] As answered to Lender B (R1).', sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    const t0 = performance.now(); const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })); const ms = performance.now() - t0;
    const c = s.calls.find(isDraft)!;
    expect(shown(c)[0]).toEqual({ r: 1, by: 'Lender B' }); expect(shown(c).length).toBeLessThanOrEqual(5);   // the log's 2,500 others share words like "confirm" and "provide", which weigh little
    expect(c.prompt).toContain('Response to R1: “The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.”');
    expect(c.prompt).toContain('name it in "reused": it is put in the draft word for word, credited to whoever asked it');
    expect(r).toMatchObject({ status: 'found', text: 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe lock-up ratio is 1.20x from financial close, and the credit agreement prevails. [1]' }); expect(r.sources.map((x) => x.doc)).toEqual(['Credit Agreement.pdf']);   // the model's own credit is taken out: the quoted response carries it
    expect(ms).toBeLessThan(1500);
  });

  it('an earlier response the model uses is quoted word for word and named, ahead of what the documents add; one never shown is ignored', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is 1.20x. [1]', sources: [{ doc: 'D1', page: 14 }], reused: ['R1', 'R9'] } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log(300)]);
    const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(r.text).toBe('As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe ratio is 1.20x. [1]');                       // R9 was never shown: it is ignored
    // the credit is never put on the model's wording: a figure that differs from the response stays beside it, in sight
    const differs = setup((c) => (isDraft(c) ? { status: 'found', text: 'As answered to Lender B (R1). The lock-up ratio is 1.35x. [1]', sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
    await deal(differs.repo); await questions(differs.repo, [Q12]);
    const d = val(await differs.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(d.text).toBe('As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe lock-up ratio is 1.35x. [1]'); expect(d.text).not.toMatch(/\(R1\)\. The lock-up ratio is 1\.35x/);
    for (const said of ['Lender B was told in R1 that the ratio is 1.35x. [1] The credit agreement sets 1.35x. [1]', 'the credit agreement sets 1.35x. [1] This is as previously answered in R1.']) {
      const w = setup((c) => (isDraft(c) ? { status: 'found', text: said, sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
      await deal(w.repo); await questions(w.repo, [Q12]);
      expect(val(await w.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).text).toBe('As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe credit agreement sets 1.35x. [1]');   // a credit in other words is dropped too
    }
    const plain = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is 1.20x. [1]', sources: [{ doc: 'D1', page: 14 }] } : {}), { d1: [FA] });
    await deal(plain.repo); await questions(plain.repo, [Q12]); expect(val(await plain.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).text).toBe('The ratio is 1.20x. [1]');
  });

  it('with no document behind it, an earlier response is enough for a draft; with neither, there is no draft', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: 'As answered to Lender B (R1): the ratio is 1.20x.', sources: [], reused: ['R1'] } : {}), { d1: [] });
    await deal(s.repo); await questions(s.repo, [Q12]);
    expect(val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }))).toEqual({ status: 'found', text: 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.', sources: [] });   // the response itself, not the model's wording
    expect(s.calls.find(isDraft)!.prompt).toContain('No document in the data room was found to bear on this.');
    const none = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is probably 1.20x.', sources: [] } : {}), { d1: [FA] });
    await deal(none.repo); await questions(none.repo, [Q12]); expect(val(await none.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).status).toBe('none');
  });

  it('a question that only shares common words, or has no response yet, or is the question itself, is not shown', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [{ ...Q12, n: 13, response: '' }, { n: 14, text: 'Please confirm which document applies.', response: 'The term sheet.', askedBy: 'Bidder A' }, ...log(500)]);
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_self', data: { id: 'q_self', dealId: 'd1', n: 15, text: NEW, response: 'Our own earlier words.', askedBy: 'Lender C' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q_self' }] } }));
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_self', questionText: NEW }));
    expect(shown(s.calls.find(isDraft)!)).toEqual([]); expect(s.calls.find(isDraft)!.prompt).not.toContain('Responses already given');
  });

  it('a response typed but not yet marked Answered is not shown, and a shown response loses its own [n] markers', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [{ ...Q12, response: 'The lock-up ratio is 1.20x from financial close. [1] The credit agreement prevails. [2]' }]);
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_20', data: { id: 'q_20', dealId: 'd1', n: 20, text: Q12.text, response: 'Half-typed: 1.2', askedBy: 'Lender C', status: 'open' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q_20' }] } }));
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    const c = s.calls.find(isDraft)!;
    expect(shown(c)).toEqual([{ r: 1, by: 'Lender B' }]);
    expect(c.prompt).toContain('Response to R1: “The lock-up ratio is 1.20x from financial close. The credit agreement prevails.”');
  });

  it('a draft with no document behind it is the response it names, word for word: nothing made up, added or turned round is put in another party’s answer', async () => {
    for (const said of ['', 'The sponsor has agreed to a 2.5x lock-up and a $40m equity cure.', 'The lock-up ratio is not 1.20x; the term sheet prevails over the credit agreement.', 'The lock-up ratio is 1.20x from financial close, and the sponsor has waived the lock-up test.']) {
      const s = setup((c) => (isDraft(c) ? { status: 'found', text: said, sources: [], reused: ['R1'] } : {}), { d1: [] });
      await deal(s.repo); await questions(s.repo, [Q12]);
      expect(val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }))).toEqual({ status: 'found', text: 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.', sources: [] });
      const c = s.calls.find(isDraft)!; expect(c.system).toContain('Answer only from the earlier responses you are given'); expect(c.system).not.toContain('Answer only from the documents');
    }
  });

  it('an earlier response a person took from an AI draft is shown to the model as drafted by AI', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo);
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_12', data: { id: 'q_12', dealId: 'd1', status: 'answered', ...Q12, provenance: { origin: 'ai', sources: [], actor: 'me', at: '2026-11-15T09:00:00.000Z' } }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q_12' }] } }));
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(s.calls.find(isDraft)!.prompt).toContain('Response to R1 (drafted by AI from the data room, not received from anyone): “The lock-up ratio');
  });

  it('"lockup" finds "lock-up" among 2,500 questions', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: 'Which lockup ratio applies from financial close?' }));
    expect(shown(s.calls.find(isDraft)!)[0]).toEqual({ r: 1, by: 'Lender B' });
  });

  // #286: question numbers are never shown to the model, so a calendar quarter is never taken for a credit
  describe('a calendar quarter in a draft', () => {
    const Q3 = { ...Q12, n: 3 };
    const sources = [{ doc: 'D1', page: 14 }, { doc: 'D1', page: 16 }];
    const draftWith = async (text: string, reused: string[] = []) => {
      const s = setup((c) => (isDraft(c) ? { status: 'found', text, sources, reused } : {}), { d1: [FA] });
      await deal(s.repo); await questions(s.repo, [Q3, ...log(2377)]);
      const reply = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
      return { reply, prompt: s.calls.find(isDraft)!.prompt };
    };

    it('stays, whatever the date format, and the prompt carries no question number', async () => {
      for (const quarter of ['Q3 2027', 'Q3-2027', 'Q3/2027', 'Q3 (2027)', 'Q3 in fiscal year 2027', 'FY 2027 (Q3)', 'Q3, 2027', 'Q3']) {
        const { reply, prompt } = await draftWith(`Commercial operation is expected in ${quarter}. [1]`);
        expect(reply).toMatchObject({ status: 'found', text: `Commercial operation is expected in ${quarter}. [1]` });
        expect(reply.sources).toHaveLength(2);   // a source listed without a marker stays
        expect(prompt).not.toMatch(/\bQ3\b/);
      }
    });

    it('stays beside a real credit, which goes with its source while the next citation is renumbered', async () => {
      const text = 'As answered in R1, 2027 capex is capped at $20 million. [1] Commercial operation is expected in Q3 2027. [2]';
      const { reply } = await draftWith(text, ['R1']);
      expect(reply.text).toBe('As answered to Lender B (Q3): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nCommercial operation is expected in Q3 2027. [1]');
      expect(reply.sources).toEqual([expect.objectContaining({ loc: 'p. 16' })]);
    });
  });
});
