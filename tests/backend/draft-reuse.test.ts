// @vitest-environment node
// Reusing answers across parties: "Draft response" first searches the deal's Q&A log for questions that read like
// this one and, where an earlier response suits, the draft uses it and names it ("As answered to Lender B (Q12)"),
// alongside the documents. Tested at the scale of a real log: 2,500 questions from many parties.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, type Call } from './reviewKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
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
/** the earlier responses a draft was shown: R tag, question number and party */
const shown = (c: Call) => [...c.prompt.matchAll(/^R(\d+): Q(\d+)(?:, submitted by ([^:]+))?:/gm)].map((m) => ({ r: +m[1], q: +m[2], by: m[3] ?? '' }));

describe('a draft reuses an answer already given to another party', () => {
  it('among 2,500 questions, the one asked before in other words is found and the draft uses it, named as asked', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: 'The lock-up ratio is 1.20x from financial close, and the credit agreement prevails. [1] As answered to Lender B (Q12).', sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    const t0 = performance.now(); const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })); const ms = performance.now() - t0;
    const c = s.calls.find(isDraft)!;
    expect(shown(c)[0]).toEqual({ r: 1, q: 12, by: 'Lender B' }); expect(shown(c).length).toBeLessThanOrEqual(5);   // the log's 2,500 others share words like "confirm" and "provide", which weigh little
    expect(c.prompt).toContain('Response to Q12: “The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.”');
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
    const differs = setup((c) => (isDraft(c) ? { status: 'found', text: 'As answered to Lender B (Q12). The lock-up ratio is 1.35x. [1]', sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
    await deal(differs.repo); await questions(differs.repo, [Q12]);
    const d = val(await differs.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(d.text).toBe('As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe lock-up ratio is 1.35x. [1]'); expect(d.text).not.toMatch(/\(Q12\)\. The lock-up ratio is 1\.35x/);
    for (const said of ['Lender B was told in Q12 that the ratio is 1.35x. [1] The credit agreement sets 1.35x. [1]', 'the credit agreement sets 1.35x. [1] This is as previously answered in Q12.']) {
      const w = setup((c) => (isDraft(c) ? { status: 'found', text: said, sources: [{ doc: 'D1', page: 14 }], reused: ['R1'] } : {}), { d1: [FA] });
      await deal(w.repo); await questions(w.repo, [Q12]);
      expect(val(await w.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).text).toBe('As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.\n\nThe credit agreement sets 1.35x. [1]');   // a credit in other words is dropped too
    }
    const plain = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is 1.20x. [1]', sources: [{ doc: 'D1', page: 14 }] } : {}), { d1: [FA] });
    await deal(plain.repo); await questions(plain.repo, [Q12]); expect(val(await plain.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).text).toBe('The ratio is 1.20x. [1]');
  });

  it('with no document behind it, an earlier response is enough for a draft; with neither, there is no draft', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'found', text: 'As answered to Lender B (Q12): the ratio is 1.20x.', sources: [], reused: ['R1'] } : {}), { d1: [] });
    await deal(s.repo); await questions(s.repo, [Q12]);
    expect(val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }))).toEqual({ status: 'found', text: 'As answered to Lender B (Q12): The lock-up ratio is 1.20x from financial close; the credit agreement prevails over the term sheet.', sources: [] });   // the response itself, not the model's wording
    expect(s.calls.find(isDraft)!.prompt).toContain('No document in the data room was found to bear on this.');
    const none = setup((c) => (isDraft(c) ? { status: 'found', text: 'The ratio is probably 1.20x.', sources: [] } : {}), { d1: [FA] });
    await deal(none.repo); await questions(none.repo, [Q12]); expect(val(await none.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW })).status).toBe('none');
  });

  it('keeps a dated quarter even when a similar earlier question has that number (#286)', async () => {
    const quarter = 'Commercial operation is expected in Q3 2027. [1]';
    const longStop = 'The long-stop date is 31 March 2028. [2]';
    const sources = [{ doc: 'D1', page: 14 }, { doc: 'D1', page: 16 }];
    let reply = { status: 'found', text: `${quarter} ${longStop}`, sources };
    const s = setup((call) => isDraft(call) ? reply : {}, { d1: [FA] });
    const earlier = {
      n: 3,
      text: 'When is commercial operation expected for the project?',
      response: 'The schedule puts commercial operation in the second half of 2027.',
      askedBy: 'Lender A',
    };
    const portfolio = portfolioQuestions().map((text, index) => ({
      n: index + 100,
      text,
      response: '',
      askedBy: 'Lender B',
    }));
    await deal(s.repo);
    await questions(s.repo, [earlier, ...portfolio]);

    const draft = { dealId: 'd1', questionId: 'q_new', questionText: earlier.text };
    const full = val(await s.ai.draft(draft));
    expect(shown(s.calls.find(isDraft)!).map((entry) => entry.q)).toContain(3);
    expect(full.status).toBe('found');
    expect(full.text).toBe(`${quarter} ${longStop}`);
    expect(full.sources.map((source) => source.loc)).toEqual(['p. 14', 'p. 16']);

    const dates = [
      'Q3', 'Q3 2027', 'Q3-2027', 'Q3/2027', 'Q3 (2027)', 'Q3, 2027', '2027 Q3',
      'Q3 in 2027', 'FY 2027 (Q3)', 'Q3 of calendar year 2027',
    ];
    for (const date of dates) {
      const text = `Commercial operation is expected by ${date}. [1]`;
      reply = { ...reply, text, sources: [sources[0]] };
      const only = val(await s.ai.draft(draft));
      expect(only.status, date).toBe('found');
      expect(only.text, date).toBe(text);
      expect(only.sources.map((source) => source.loc), date).toEqual(['p. 14']);
    }

    const text = 'The sponsor responded to Q3 budget changes with a higher contingency. [1]';
    reply = { ...reply, text };
    expect(val(await s.ai.draft(draft)).text).toBe(text);
  });

  it('renumbers surviving sources after removing a genuine earlier-question credit (#286)', async () => {
    const calendar = 'The ratio applies from financial close in Q3 2027.';
    const text = `${calendar} [2] As answered in Q3. [1] The agreement prevails. [2]`;
    const sources = [{ doc: 'D1', page: 9 }, { doc: 'D1', page: 14 }];
    const s = setup((call) => isDraft(call) ? { status: 'found', text, sources, reused: ['R1'] } : {}, { d1: [FA] });
    await deal(s.repo);
    await questions(s.repo, [{ ...Q12, n: 3 }]);

    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft.status).toBe('found');
    expect(draft.text).toBe([
      `As answered to Lender B (Q3): ${Q12.response}`,
      `${calendar} [1] The agreement prevails. [1]`,
    ].join('\n\n'));
    expect(draft.sources.map((source) => source.loc)).toEqual(['p. 14']);
  });

  it('keeps a source without a sentence marker when an unrelated credit is removed (#286)', async () => {
    const retained = 'The credit agreement sets the ratio at 1.20x.';
    const text = `As answered in Q12. [1] ${retained}`;
    const sources = [{ doc: 'D1', page: 9 }, { doc: 'D1', page: 14 }];
    const s = setup((call) => isDraft(call) ? { status: 'found', text, sources } : {}, { d1: [FA] });
    await deal(s.repo);
    await questions(s.repo, [Q12]);

    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft.status).toBe('found');
    expect(draft.text).toBe(retained);
    expect(draft.sources.map((source) => source.loc)).toEqual(['p. 14']);
  });

  it.each([
    ['a clause beginning with a year', 'As answered in Q3, 2027 capital spending is capped at $20 million.'],
    ['a closing quote', 'As answered in Q3, “the target is still provisional.”'],
    ['a dash before a year', 'As answered in Q3 — 2027 capital spending is capped at $20 million.'],
    ['a dash without spaces', 'As answered in Q3—2027 capital spending is capped at $20 million.'],
    ['a year before the question number', 'The minutes confirm that in 2027 Q3 was answered by the sponsor.'],
    ['a quote and a continuation', 'The sponsor responded to Q3 with “Not yet!” before the term sheet was amended.'],
    ['a direct answer', 'The sponsor answered Q3 with the execution date from the prior draft.'],
  ])('removes a credit with %s and keeps the next cited sentence (#286)', async (_case, credit) => {
    const retained = 'Commercial operation is expected in Q3 2027.';
    const text = `${credit} [1] ${retained} [2]`;
    const sources = [{ doc: 'D1', page: 9 }, { doc: 'D1', page: 14 }];
    const s = setup((call) => isDraft(call) ? { status: 'found', text, sources, reused: ['R1'] } : {}, { d1: [FA] });
    await deal(s.repo);
    await questions(s.repo, [{ ...Q12, n: 3 }]);

    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft.status).toBe('found');
    expect(draft.text).toBe(`As answered to Lender B (Q3): ${Q12.response}\n\n${retained} [1]`);
    expect(draft.sources.map((source) => source.loc)).toEqual(['p. 14']);
  });

  it('keeps paragraphs when no earlier question is shown (#286)', async () => {
    const text = 'The engineer wrote “The permit was issued.”\n\nThe long-stop date is 31 March 2028. [1]';
    const sources = [{ doc: 'D1', page: 14 }];
    const s = setup((call) => isDraft(call) ? { status: 'found', text, sources } : {}, { d1: [FA] });
    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft.text).toBe(text);
    expect(draft.sources.map((source) => source.loc)).toEqual(['p. 14']);
  });

  it('keeps the paragraph break crossed by a removed credit (#286)', async () => {
    const first = 'Commercial operation is expected in Q3 2027.';
    const last = 'The long-stop date is 31 March 2028.';
    const text = `${first} [1]\n\nAs answered in Q3. [2]\n${last} [3]`;
    const sources = [{ doc: 'D1', page: 9 }, { doc: 'D1', page: 14 }, { doc: 'D1', page: 16 }];
    const s = setup((call) => isDraft(call) ? { status: 'found', text, sources } : {}, { d1: [FA] });
    await deal(s.repo);
    await questions(s.repo, [{ ...Q12, n: 3 }]);

    const draft = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: NEW }));
    expect(draft.text).toBe(`${first} [1]\n\n${last} [2]`);
    expect(draft.sources.map((source) => source.loc)).toEqual(['p. 9', 'p. 16']);
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
    expect(shown(c)).toEqual([{ r: 1, q: 12, by: 'Lender B' }]);
    expect(c.prompt).toContain('Response to Q12: “The lock-up ratio is 1.20x from financial close. The credit agreement prevails.”');
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
    expect(s.calls.find(isDraft)!.prompt).toContain('Response to Q12 (drafted by AI from the data room, not received from anyone): “The lock-up ratio');
  });

  it('"lockup" finds "lock-up" among 2,500 questions', async () => {
    const s = setup((c) => (isDraft(c) ? { status: 'none' } : {}), { d1: [FA] });
    await deal(s.repo); await questions(s.repo, [Q12, ...log()]);
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: 'Which lockup ratio applies from financial close?' }));
    expect(shown(s.calls.find(isDraft)!)[0]).toEqual({ r: 1, q: 12, by: 'Lender B' });
  });
});
