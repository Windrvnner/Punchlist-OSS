// @vitest-environment node
// Reusing answers across parties: "Draft response" first searches the deal's Q&A log for questions that read like
// this one and, where an earlier response suits, the draft uses it and names it ("As answered to Lender B (Q12)"),
// alongside the documents. Tested at the scale of a real log: 2,500 questions from many parties.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, qid, type Call } from './reviewKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import type { Repository } from '../../src/ports';
import type { Provenance } from '../../src/domain/model';

const FA = doc(1, 'Credit Agreement.pdf', { summary: 'Senior credit agreement.', keywords: ['lock-up', 'distribution'] });
const parties = ['Lender A', 'Lender B', 'Lender C', 'Bidder A', 'Bidder B', 'Bidder C', 'Rating agency', 'Lenders’ counsel'];
const topics = ['the interconnection timetable', 'the EPC contractor’s liquidated damages cap', 'the O&M fee escalation', 'the land lease term', 'the insurance deductibles', 'the hedging counterparties', 'the tax equity flip date', 'the PPA curtailment compensation', 'the module supplier warranty', 'the decommissioning bond', 'the DSRA sizing', 'the sponsor support undertaking', 'the change in law protection', 'the merchant tail assumptions', 'the interconnection upgrade costs', 'the property tax abatement', 'the availability guarantee', 'the major maintenance reserve', 'the transformer lead times', 'the environmental permit conditions'];
const asks = ['Please confirm', 'Provide details of', 'Explain', 'What is the status of', 'Provide the documents evidencing', 'Describe any changes to', 'Has the sponsor agreed', 'Clarify the basis for'];
/** a log of 2,500 questions, as a deal with several lenders and bidders builds up: most answered, the same topics asked about over and over in other words */
function log(n = 2500) {
  return Array.from({ length: n }, (_, k) => { const t = topics[k % topics.length], a = asks[Math.floor(k / topics.length) % asks.length];
    return { n: k + 100, text: `${a} ${t} (${k}).`, response: k % 3 ? `Per the data room, ${t} is as set out in the relevant agreement, item ${k}.` : '', askedBy: parties[k % parties.length] }; });
}
type QuestionRow = {
  n: number;
  text: string;
  response: string;
  askedBy: string;
  respondedBy?: string;
  provenance?: Provenance;
};
async function questions(repo: Repository, rows: QuestionRow[]) {
  const writes = rows.map((r) => {
    const data = { id: qid(r.n), dealId: 'd1', status: r.response ? 'answered' : 'open', ...r };
    return { kind: 'question' as const, id: qid(r.n), data, expectedRev: null };
  });
  val(await repo.transaction({ writes, index: { dealId: 'd1', add: writes.map((w) => ({ kind: 'question' as const, id: w.id })) } }));
}
const Q12 = { n: 12, text: 'Confirm the lock-up ratio that applies from financial close and which document prevails.', response: 'The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.', askedBy: 'Lender B' };
const NEW = 'Please confirm which lock-up ratio applies from financial close, and which document prevails if they differ.';
const isDraft = (c: Call) => c.prompt.includes('Draft a response to this question');
/** a backend whose model gives `reply` to every draft, over the deal's `library` */
const drafting = (reply: object, library: typeof FA[]) => setup((c) => (isDraft(c) ? reply : {}), { d1: library });
/** Q12's id, the only name the model is shown it by */
const ID12 = qid(12);
/** Q12's response as a draft quotes it, credited to who asked it */
const AS_ANSWERED_12 = 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; '
  + 'the credit agreement prevails over the term sheet.';
/**
 * the earlier responses a draft was shown: question id and party. Question numbers are never shown to the model
 * (#286, #1105).
 */
const shown = (c: Call) => [...c.prompt.matchAll(/^(q_\w+)(?:, submitted by ([^:]+))?:/gm)]
  .map((m) => ({ id: m[1], by: m[2] ?? '' }));

const previousDraft: Provenance = {
  origin: 'ai',
  sources: [14, 16].map((page) => ({ doc: FA.name, docId: FA.docId, loc: `p. ${page}` })),
  actor: 'pc',
  at: '2026-11-15T09:00:00.000Z',
};
const legalReferences = 'See clause 21.3 [2] of the facility agreement and Schedule [14].';

describe('earlier responses keep literal brackets when quoted (#287)', () => {
  it.each([
    { label: 'a typed response', row: { response: legalReferences }, expected: legalReferences, large: true },
    {
      label: 'a response received from the counterparty',
      row: { response: legalReferences, respondedBy: 'Counterparty' },
      expected: legalReferences,
    },
    {
      label: 'a conversation response with source metadata',
      row: { response: legalReferences, provenance: { ...previousDraft, origin: 'chat' as const } },
      expected: legalReferences,
    },
    {
      label: 'an accepted draft with no sources',
      row: { response: legalReferences, provenance: { ...previousDraft, sources: [] } },
      expected: legalReferences,
    },
    {
      label: 'an accepted draft with markers and an out-of-range bracket',
      row: { response: 'The lock-up ratio is 1.20x. [1] See Schedule [14]. [2]', provenance: previousDraft },
      expected: 'The lock-up ratio is 1.20x. See Schedule [14].',
    },
  ])('prepares $label for the model and quotes it word for word', async ({ row, expected, large }) => {
    const s = setup(() => ({ status: 'found', text: '', sources: [], reused: [qid(5)] }), { d1: [] });
    const portfolio = large ? portfolioQuestions().map((text, index) => ({
      n: index + 100,
      text,
      response: '',
      askedBy: 'Lender A',
    })) : [];
    await deal(s.repo);
    await questions(s.repo, [{ ...Q12, ...row, n: 5 }, ...portfolio]);
    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft).toEqual({
      status: 'found',
      text: `As answered to Lender B (Q5): ${expected}`,
      sources: [],
    });
    const call = s.calls.find(isDraft)!;
    const responseLine = call.prompt.split('\n').find((line) => line.startsWith(`Response to ${qid(5)}`));
    expect(responseLine).toContain(`“${expected}”`);
  });
});

describe('a draft reuses an answer already given to another party', () => {
  it('among 2,500 questions, the one asked before in other words is found and the draft uses it, named as asked', async () => {
    const own = 'The lock-up ratio is 1.20x from financial close, and the credit agreement prevails. [1]';
    const text = `${own} As answered to Lender B (${ID12}).`;
    const s = drafting({ status: 'found', text, sources: [{ doc: 'D1', page: 14 }], reused: [ID12] }, [FA]);
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    const t0 = performance.now(); const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })); const ms = performance.now() - t0;
    const c = s.calls.find(isDraft)!;
    expect(shown(c)[0]).toEqual({ id: ID12, by: 'Lender B' });
    // the log's 2,500 others share words like "confirm" and "provide", which weigh little
    expect(shown(c).length).toBeLessThanOrEqual(5);
    expect(c.prompt).toContain(`Response to ${ID12}: “${Q12.response}”`);
    expect(c.prompt).toContain('name it in "reused": it is put in the draft word for word, credited to whoever asked it');
    expect(r).toMatchObject({ status: 'found', text: 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe lock-up ratio is 1.20x from financial close, and the credit agreement prevails. [1]' }); expect(r.sources.map((x) => x.doc)).toEqual(['Credit Agreement.pdf']);   // the model's own credit is taken out: the quoted response carries it
    expect(ms).toBeLessThan(1500);
  });

  it('an earlier response the model uses is quoted word for word and named, ahead of what the documents add; '
    + 'one never shown fails the draft', async () => {
    const page14 = [{ doc: 'D1', page: 14 }];
    const neverShown = { status: 'found', text: 'The ratio is 1.20x. [1]', sources: page14, reused: [ID12, qid(9)] };
    const s = drafting(neverShown, [FA]);
    await deal(s.repo); await questions(s.repo, [Q12, ...log(300)]);
    // Q9 was never shown: the reply is asked again, and still naming Q9 when its tries run out, it is no draft (#1105)
    expect((await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).ok).toBe(false);
    const named = drafting({ status: 'found', text: 'The ratio is 1.20x. [1]', sources: page14, reused: [ID12] }, [FA]);
    await deal(named.repo); await questions(named.repo, [Q12]);
    const r = val(await named.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(r.text).toBe(`${AS_ANSWERED_12}\n\nThe ratio is 1.20x. [1]`);
    // the credit is never put on the model's wording: a figure that differs from the response stays beside it, in sight
    const credit = `As answered to Lender B (${ID12}). The lock-up ratio is 1.35x. [1]`;
    const differs = drafting({ status: 'found', text: credit, sources: page14, reused: [ID12] }, [FA]);
    await deal(differs.repo); await questions(differs.repo, [Q12]);
    const d = val(await differs.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(d.text).toBe(`${AS_ANSWERED_12}\n\nThe lock-up ratio is 1.35x. [1]`);
    const credits = [
      `Lender B was told in ${ID12} that the ratio is 1.35x. [1] The credit agreement sets 1.35x. [1]`,
      `the credit agreement sets 1.35x. [1] This is as previously answered in ${ID12}.`,
    ];
    for (const said of credits) {
      const w = drafting({ status: 'found', text: said, sources: page14, reused: [ID12] }, [FA]);
      await deal(w.repo); await questions(w.repo, [Q12]);
      const drafted = val(await w.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
      // a credit in other words is dropped too
      expect(drafted.text).toBe(`${AS_ANSWERED_12}\n\nThe credit agreement sets 1.35x. [1]`);
    }
    const plain = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is 1.20x. [1]', sources: [{ doc: 'D1', page: 14 }] } : {}), { d1: [FA] });
    await deal(plain.repo); await questions(plain.repo, [Q12]); expect(val(await plain.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).text).toBe('The ratio is 1.20x. [1]');
  });

  it('a draft whose text names a question it was not shown is asked again (#1105)', async () => {
    let drafts = 0;
    const said = () => (++drafts > 1 ? 'The ratio is 1.20x. [1]' : `The ratio is 1.20x, as answered in ${qid(9)}. [1]`);
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: said(), sources: [{ doc: 'D1', page: 14 }] } : {}), {
      d1: [FA],
    });
    await deal(s.repo); await questions(s.repo, [Q12]);
    const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(r.text).toBe('The ratio is 1.20x. [1]');
    const asked = s.calls.filter(isDraft);
    expect(asked.length).toBe(2);
    expect(asked[1].prompt).toBe(asked[0].prompt);
  });

  it.each([['documents', [FA]], ['no document', []]])(
    'a draft with %s still naming an unshown question id when its tries run out fails (#1105)',
    async (_label, library) => {
      const text = `The ratio is 1.20x, as answered in ${qid(9)}. [1]`;
      const sources = library.length ? [{ doc: 'D1', page: 14 }] : [];
      for (const thorough of ['thorough', 'standard']) {
        const s = drafting({ status: 'found', text, sources, reused: [ID12] }, library);
        s.svc.offered = { ...s.svc.offered, thorough };
        await deal(s.repo); await questions(s.repo, [Q12]);
        expect((await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).ok).toBe(false);
      }
    },
  );

  it('with no document behind it, an earlier response is enough for a draft; with neither, there is no draft', async () => {
    const credit = `As answered to Lender B (${ID12}): the ratio is 1.20x.`;
    const s = drafting({ status: 'found', text: credit, sources: [], reused: [ID12] }, []);
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
    await deal(s.repo);
    await questions(s.repo, [{
      ...Q12,
      response: 'The lock-up ratio is 1.20x from financial close. [1] The credit agreement prevails. [2]',
      provenance: previousDraft,
    }]);
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_20', data: { id: 'q_20', dealId: 'd1', n: 20, text: Q12.text, response: 'Half-typed: 1.2', askedBy: 'Lender C', status: 'open' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q_20' }] } }));
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    const c = s.calls.find(isDraft)!;
    expect(shown(c)).toEqual([{ id: ID12, by: 'Lender B' }]);
    const responseLine = c.prompt.split('\n').find((line) => line.startsWith(`Response to ${ID12}`));
    expect(responseLine).toBe(
      `Response to ${ID12} (drafted by AI from the data room, not received from anyone): `
      + '“The lock-up ratio is 1.20x from financial close. The credit agreement prevails.”',
    );
  });

  it('a draft with no document behind it is the response it names, word for word: nothing made up, added or turned round is put in another party’s answer', async () => {
    for (const said of ['', 'The sponsor has agreed to a 2.5x lock-up and a $40m equity cure.', 'The lock-up ratio is not 1.20x; the term sheet prevails over the credit agreement.', 'The lock-up ratio is 1.20x from financial close, and the sponsor has waived the lock-up test.']) {
      const s = drafting({ status: 'found', text: said, sources: [], reused: [ID12] }, []);
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
    const drafted = 'q_12 (drafted by AI from the data room, not received from anyone): “The lock-up ratio';
    expect(s.calls.find(isDraft)!.prompt).toContain(`Response to ${drafted}`);
  });

  it('"lockup" finds "lock-up" among 2,500 questions', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: 'Which lockup ratio applies from financial close?' }));
    expect(shown(s.calls.find(isDraft)!)[0]).toEqual({ id: ID12, by: 'Lender B' });
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
      const quarters = ['Q3 2027', 'Q3-2027', 'Q3/2027', 'Q3 (2027)', 'Q3 in fiscal year 2027', 'FY 2027 (Q3)', 'Q3, 2027', 'Q3'];
      for (const quarter of quarters) {
        const { reply, prompt } = await draftWith(`Commercial operation is expected in ${quarter}. [1]`);
        expect(reply).toMatchObject({ status: 'found', text: `Commercial operation is expected in ${quarter}. [1]` });
        expect(reply.sources).toHaveLength(2);   // a source listed without a marker stays
        expect(prompt).not.toMatch(/\bQ3\b/);
      }
    });

    it('stays beside a real credit, which goes with its source while the next citation is renumbered', async () => {
      const credit = `As answered in ${qid(3)}, 2027 capex is capped at $20 million. [1]`;
      const text = `${credit} Commercial operation is expected in Q3 2027. [2]`;
      const { reply } = await draftWith(text, [qid(3)]);
      const quoted = 'As answered to Lender B (Q3): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.';
      expect(reply.text).toBe(`${quoted}\n\nCommercial operation is expected in Q3 2027. [1]`);
      expect(reply.sources).toEqual([expect.objectContaining({ loc: 'p. 16' })]);
    });
  });
});
