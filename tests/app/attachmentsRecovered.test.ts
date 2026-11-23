// @vitest-environment node
// Files attached in a deal's ask boxes and not yet sent, when another PC deletes the deal and this PC keeps it as a
// copy (#117): they follow their conversations to the copy, as typed text does, and go with the next message there.
import { describe, it, expect } from 'vitest';
import { okd, syncAll, twoPcs, type PC } from './pcs';
import { DeleteDeal } from '../../src/app/commands/deals';
import { EditQuestionField } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { attachFiles, followCopies, MAX_ATTACHED } from '../../src/app/attachments';
import { ask, convKey, type Scope } from '../../src/app/conversations';
import type { AiService, DocumentService } from '../../src/ports';
import { ok } from '../../src/domain/result';

const ROWS = Array.from({ length: 2000 }, (_, i) => ({
  n: i + 1, text: `Please provide the lender consent for facility ${i + 1}.`, askedBy: 'Lender A', received: '',
  workstream: 'Legal', priority: '' as const, response: '', respondedBy: '', responded: '', status: '' as const,
}));

/** B's documents and answers, watched: what was carried to which deal, and what each answer was sent */
function watch(B: PC) {
  const carried: [string, string][] = [];
  const sent: { dealId?: string; attachments?: { docId: string }[] }[] = [];
  const docs = B.store.services.docs as DocumentService;
  docs.carryAttached = async (from, to) => { carried.push([from, to]); return ok(undefined); };
  const ai = B.store.services.ai as AiService;
  const answer = ai.answer.bind(ai);
  ai.answer = async (input) => {
    sent.push({ dealId: input.dealId, attachments: input.attachments });
    return answer(input);
  };
  return { carried, sent };
}

const pdfs = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => new File([`${prefix} ${i}`], `${prefix} ${i + 1}.pdf`));
/** B changes the deal while A, not having seen it, deletes it: B keeps the deal as a copy */
async function deleteUnseen(A: PC, B: PC, dealId: string, qid: string) {
  const edit = { dealId, questionId: qid, field: 'text', value: 'Asked offline on B' };
  okd(await B.store.dispatch(EditQuestionField, edit));
  okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware' }));
  await syncAll(A, B);
}
const settleFiles = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('files attached and not yet sent on a deal another PC deletes (#117)', () => {
  it('follow their conversations to the copy, at deal scale, and go with the next message there', async () => {
    const { A, B, dealId, qid, fid } = await twoPcs();
    okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: ROWS }));
    await syncAll(A, B);
    await B.store.loadDeal(dealId, { gaps: false });
    const stop = followCopies(B.store);
    const { carried, sent } = watch(B);
    const onDeal: Scope = { kind: 'deal', dealId };
    const onFinding: Scope = { kind: 'finding', dealId, findingId: fid };
    await attachFiles(B.store, { dealId, conv: convKey(onDeal) }, pdfs('Lender consent', MAX_ATTACHED));
    await attachFiles(B.store, { dealId, findingId: fid, conv: convKey(onFinding) }, pdfs('Side letter', 3));
    await settleFiles();
    expect(B.store.get().ui.attachments.filter((a) => a.state === 'done')).toHaveLength(MAX_ATTACHED + 3);
    await deleteUnseen(A, B, dealId, qid);
    const copy = () => Object.values(B.store.get().deals).find((deal) => deal.name.endsWith('(recovered)'));
    await expect.poll(copy).toBeDefined();
    const copyId = copy()!.id;
    await expect.poll(() => carried).toEqual([[dealId, copyId]]);
    await B.store.loadDeal(copyId, { gaps: false });
    const copiedFinding = Object.values(B.store.get().findings).find((f) => f.dealId === copyId)!;
    const onCopy: Scope = { kind: 'deal', dealId: copyId };
    const onCopiedFinding: Scope = { kind: 'finding', dealId: copyId, findingId: copiedFinding.id };
    const attachments = B.store.get().ui.attachments;
    expect(attachments.filter((a) => a.conv === convKey(onCopy))).toHaveLength(MAX_ATTACHED);
    const sideLetters = attachments.filter((a) => a.conv === convKey(onCopiedFinding));
    expect(sideLetters.map((a) => [a.name, a.findingId, a.state])).toEqual(
      [1, 2, 3].map((n) => [`Side letter ${n}.pdf`, copiedFinding.id, 'done']));
    expect(attachments.every((a) => a.dealId === copyId)).toBe(true);
    // the next message on the copy takes its files with it, and the finding's stay with the finding
    await ask(B.store, onCopy, 'Do the lender consents cover the change of control?');
    expect(sent.at(-1)?.dealId).toBe(copyId);
    expect(sent.at(-1)?.attachments).toHaveLength(MAX_ATTACHED);
    expect(B.store.get().ui.attachments.map((a) => a.name)).toEqual([1, 2, 3].map((n) => `Side letter ${n}.pdf`));
    stop();
  });

  it('leave attachments on other deals and on Home where they are', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    const stop = followCopies(B.store);
    watch(B);
    await attachFiles(B.store, { dealId: 'me_0123456789abcdef', conv: 'all:c1' }, pdfs('Board minutes', 2));
    await attachFiles(B.store, { dealId, conv: convKey({ kind: 'deal', dealId }) }, pdfs('Term sheet', 1));
    await settleFiles();
    await deleteUnseen(A, B, dealId, qid);
    const termSheet = () => B.store.get().ui.attachments.find((a) => a.name === 'Term sheet 1.pdf');
    await expect.poll(() => termSheet()?.dealId).not.toBe(dealId);
    const home = B.store.get().ui.attachments.filter((a) => a.conv === 'all:c1');
    expect(home.map((a) => a.dealId)).toEqual(['me_0123456789abcdef', 'me_0123456789abcdef']);
    stop();
  });
});
