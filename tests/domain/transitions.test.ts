import { describe, it, expect } from 'vitest';
import { setQuestionStatus, setResponse, setFindingStatus, isDraftStale, editQuestionField, checkFinding } from '../../src/domain/transitions';
import { Question, Finding, wordingHash } from '../../src/domain/model';

const ctx = { at: '2026-11-09T10:00:00.000Z', actor: 'adoe' };
const q = (): Question => Question.parse({ id: 'q_01HZZZZZZZZZZZZZZZZZZZZZZZ', dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ', rev: 1, createdAt: ctx.at, updatedAt: ctx.at, n: 1, text: 'Please confirm the lock-up test.' });
const f = (): Finding => Finding.parse({ id: 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ', dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ', rev: 1, createdAt: ctx.at, updatedAt: ctx.at, title: 'Lock-up differs', workstream: 'Legal', raisedAt: ctx.at, origin: 'ai', sources: [{ doc: 'a.pdf', loc: 'p. 1', docId: 'doc_a' }, { doc: 'b.pdf', loc: 'p. 2', docId: 'doc_b' }] });

describe('question status', () => {
  it('cannot become answered without a response', () => {
    const r = setQuestionStatus(q(), 'answered', ctx);
    expect(r.ok).toBe(false);
  });
  it('moves open → closed and records audit', () => {
    const r = setQuestionStatus(q(), 'closed', ctx);
    expect(r.ok && r.value.record.status).toBe('closed');
    expect(r.ok && r.value.audit[0]).toMatchObject({ kind: 'status', from: 'open', to: 'closed' });
  });
  it('is a no-op for the same status', () => {
    const r = setQuestionStatus(q(), 'open', ctx);
    expect(r.ok && r.value.audit.length).toBe(0);
  });
});

describe('response and linked finding', () => {
  it('marks the linked finding when a response arrives and unmarks when withdrawn', () => {
    const linked = f();
    const q1 = { ...q(), linkedFinding: linked.id };
    const r1 = setResponse(q1, 'Confirmed.', { origin: 'human', sources: [], actor: 'A', at: ctx.at }, linked, ctx);
    expect(r1.ok && r1.value.finding?.record.updated).toBe(true); expect(r1.ok && r1.value.finding?.record.updatedWhy).toBe(`Response received on Q${q1.n}`);   // the mark says why
    expect(r1.ok && r1.value.finding?.record.updatedOn).toEqual({ questions: [q1.id] });                                    // and which question, by id, so that renumbering it does not leave the wrong number
    const r2 = setResponse(r1.ok ? r1.value.question.record : q1, '', undefined, r1.ok ? r1.value.finding!.record : linked, ctx);
    expect(r2.ok && r2.value.finding?.record.updated).toBe(false); expect(r2.ok && r2.value.finding?.record.updatedWhy).toBe('');
    expect(r2.ok && r2.value.question.audit[0].kind).toBe('responseWithdrawn');
  });
  it('withdrawing a response clears only the mark that response put there', () => {
    const at = ctx.at; const prov = { origin: 'human' as const, sources: [], actor: 'A', at };
    const linked = f(); const qa = { ...q(), linkedFinding: linked.id }; const qb = { ...q(), id: 'q_01HZZZZZZZZZZZZZZZZZZZZZZY', n: 2, linkedFinding: linked.id };
    // a check marked it for another reason: a response arriving and being withdrawn leaves the check's mark and its reason alone
    const byCheck = { ...linked, updated: true, updatedWhy: 'Check of everything' };
    const r1 = setResponse(qa, 'Yes.', prov, byCheck, ctx); expect(r1.ok && r1.value.finding).toBeUndefined();       // already marked: its reason stands; the response is in the question's history
    const w1 = setResponse({ ...qa, response: 'Yes.' }, '', undefined, byCheck, ctx); expect(w1.ok && w1.value.finding).toBeUndefined();
    // two responses marked it: withdrawing one leaves it marked by the other
    const a1 = setResponse(qa, 'Yes.', prov, linked, ctx); const f1 = a1.ok ? a1.value.finding!.record : linked;
    const b1 = setResponse(qb, 'Also yes.', prov, f1, ctx); const f2 = b1.ok ? b1.value.finding!.record : f1;
    expect(f2.updated).toBe(true); expect(f2.updatedOn).toEqual({ questions: [qa.id, qb.id] });
    const wa = setResponse({ ...qa, response: 'Yes.' }, '', undefined, f2, ctx); const f3 = wa.ok ? wa.value.finding!.record : f2;
    expect(f3.updated).toBe(true); expect(f3.updatedOn).toEqual({ questions: [qb.id] }); expect(f3.updatedWhy).toBe(f2.updatedWhy);   // the words on screen are made from updatedOn and today's numbers (markText)
    expect(wa.ok && wa.value.finding!.audit[0]).toMatchObject({ kind: 'responseWithdrawn', text: 'Response removed from Q1' });
    // and the last one goes: now it is unmarked
    const wb = setResponse({ ...qb, response: 'Also yes.' }, '', undefined, f3, ctx); const f4 = wb.ok ? wb.value.finding!.record : f3;
    expect([f4.updated, f4.updatedWhy, f4.updatedOn]).toEqual([false, '', undefined]);
    // a mark from before marks named their questions, or one this question did not set: withdrawing leaves it
    const old = { ...linked, updated: true, updatedWhy: 'Response received on Q1' };
    const w2 = setResponse({ ...qa, response: 'Yes.' }, '', undefined, old, ctx); expect(w2.ok && w2.value.finding).toBeUndefined();
    const other = { ...linked, updated: true, updatedWhy: 'Response received on Q2', updatedOn: { questions: [qb.id] } };
    const w3 = setResponse({ ...qa, response: 'Yes.' }, '', undefined, other, ctx); expect(w3.ok && w3.value.finding).toBeUndefined();
  });
  it('a reworded response marks the finding again; other spacing, or a mark this question already set, ' +
    'changes nothing', () => {
    const prov = { origin: 'human' as const, sources: [], actor: 'A', at: ctx.at };
    const linked = f(); const q1 = { ...q(), linkedFinding: linked.id, response: 'The DSCR is 1.30x.' };
    const r = setResponse(q1, 'The DSCR is 1.25x.', prov, linked, ctx);
    expect(r.ok && r.value.finding?.record).toMatchObject({ updated: true, updatedWhy: `Response received on Q${q1.n}`, updatedOn: { questions: [q1.id] } });
    const none = (x: ReturnType<typeof setResponse>) => x.ok && !x.value.finding;
    expect(none(setResponse(q1, 'The DSCR   is\n1.30x. ', prov, linked, ctx))).toBe(true);
    const marked = r.ok ? r.value.finding!.record : linked;
    expect(none(setResponse({ ...q1, response: 'The DSCR is 1.25x.' }, 'The DSCR is 1.25x, per the model.', prov, marked, ctx))).toBe(true);
    const byCheck = { ...linked, updated: true, updatedWhy: 'Check of everything' };                 // a mark set for another reason stands as it is
    expect(none(setResponse(q1, 'The DSCR is 1.25x.', prov, byCheck, ctx))).toBe(true);
  });
});

describe('drafts', () => {
  it('a draft is stale once the wording changes', () => {
    const q1: Question = { ...q(), draft: { status: 'found', text: 'x', sources: [], forWording: wordingHash('Please confirm the lock-up test.') } };
    expect(isDraftStale(q1)).toBe(false);
    const r = editQuestionField(q1, 'text', 'Please confirm the tax indemnity cap.', ctx);
    expect(r.ok && isDraftStale(r.value.record)).toBe(true);
  });
});

describe('finding status', () => {
  it('appends notes and records status together', () => {
    const r = setFindingStatus(f(), 'closed', 'Confirmed with counsel', ctx);
    expect(r.ok && r.value.record.status).toBe('closed');
    expect(r.ok && r.value.audit.map((a) => a.kind)).toEqual(['status', 'note']);
  });
});

describe('a finding the model raises', () => {
  // one citation is enough: what matters most is often said in one place only
  it('stands on one source, and not on none', () => {
    expect(checkFinding({ ...f(), sources: f().sources.slice(0, 1) }).ok).toBe(true);
    expect(checkFinding({ ...f(), sources: [] }).ok).toBe(false);
    expect(checkFinding({ ...f(), origin: 'human', sources: [] }).ok).toBe(true);
  });
});

describe('Source', () => {
  it('keeps docId, version and the verification quote the backend sends, and drops anything unknown', async () => {
    const { Source } = await import('../../src/domain/model');
    const s = Source.parse({ doc: 'Credit agreement.docx', loc: 'p. 142', docId: 'doc_1', version: '3', quote: 'the Lock-Up Ratio is 1.25:1', highlight: [1, 2] } as any);
    expect(s).toEqual({ doc: 'Credit agreement.docx', loc: 'p. 142', docId: 'doc_1', version: '3', quote: 'the Lock-Up Ratio is 1.25:1' });
    expect(Source.safeParse({ doc: 'x.pdf', loc: 'p. 1' }).success).toBe(false);                      // a citation always names its document by id
  });
});
