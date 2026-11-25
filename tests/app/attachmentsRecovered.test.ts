// @vitest-environment node
// Files attached in a deal's ask boxes and not yet sent, when another PC deletes the deal and this PC keeps it as a
// copy (#117): they follow their conversations to the copy, as typed text does, and go with the next message there.
import { describe, it, expect, vi } from 'vitest';
import { okd, syncAll, twoPcs, type PC } from './pcs';
import { DeleteDeal } from '../../src/app/commands/deals';
import { EditQuestionField } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { attachFiles, filesSendable, followCopies, MAX_ATTACHED } from '../../src/app/attachments';
import { ask, convKey, type Scope } from '../../src/app/conversations';
import { Store } from '../../src/app/store';
import { MemoryLocal } from '../../src/adapters/local';
import type { AiService, DocumentService } from '../../src/ports';
import { fail, ok } from '../../src/domain/result';

const ROWS = Array.from({ length: 2000 }, (_, i) => ({
  n: i + 1, text: `Please provide the lender consent for facility ${i + 1}.`, askedBy: 'Lender A', received: '',
  workstream: 'Legal', priority: '' as const, response: '', respondedBy: '', responded: '', status: '' as const,
}));

/** B's documents and answers, watched: what was carried to which deal, and what each answer was sent */
function watch(B: PC) {
  const carried: [string, string][] = [];
  const sent: { dealId?: string; attachments?: { docId: string }[] }[] = [];
  const docs = B.store.services.docs as DocumentService;
  docs.carryAttached = async (from, to) => { carried.push([from, to]); return ok({ written: 1, unresolved: 0 }); };
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

function standInDocumentFolders(B: PC, dealId: string, delayUpload: boolean) {
  const doc = 'Executed facility agreement.pdf';
  const docId = 'executed-facility-agreement';
  let finishUpload = () => {};
  const upload = new Promise<void>((resolve) => { finishUpload = resolve; });
  const source = new Set<string>();
  const destination = new Set<string>();
  const carries: string[] = [];
  const docs = B.store.services.docs;
  let available = false;
  docs.attach = async () => {
    if (delayUpload) await upload;
    source.add(docId);
    return ok({ doc, docId });
  };
  docs.carryAttached = async (_from, to) => {
    carries.push(to);
    if (!available && (!delayUpload || source.size)) {
      return fail({ kind: 'unreachable', message: 'Folder unavailable' });
    }
    for (const id of source) destination.add(id);
    return ok({ written: source.size, unresolved: 0 });
  };
  docs.unsendable = async (deal, ids) => ok(ids.filter((id) => !(deal === dealId ? source : destination).has(id)));
  return { doc, docId, finishUpload, source, destination, carries, reconnect: () => { available = true; } };
}

describe('attachment carry after a restart (#744)', () => {
  it.each([
    { caseName: 'the first carry missed the unfinished upload', delayUpload: true, olderCopy: false },
    { caseName: 'the first carry and the startup carry were refused', delayUpload: false, olderCopy: false },
    { caseName: 'the copy predates the persisted carry', delayUpload: false, olderCopy: true },
  ])('carries a published attachment after restart when $caseName', async ({ delayUpload, olderCopy }) => {
    const { A, B, dealId, qid } = await twoPcs();
    const docs = standInDocumentFolders(B, dealId, delayUpload);
    const stop = followCopies(B.store);
    try {
      const conv = convKey({ kind: 'deal', dealId });
      await attachFiles(B.store, { dealId, conv }, [new File(['facility agreement'], docs.doc)]);
      if (!delayUpload) await expect.poll(() => B.store.get().ui.attachments[0]?.state).toBe('done');
      await deleteUnseen(A, B, dealId, qid);
      await expect.poll(() => docs.carries.length).toBeGreaterThan(0);
      docs.finishUpload();
      await expect.poll(() => B.store.get().ui.attachments[0]?.state).toBe('done');
      const [kept] = B.store.get().ui.attachments;
      expect(kept.dealId).not.toBe(dealId);
      expect(docs.source.has(docs.docId)).toBe(true);
      expect(docs.destination.has(docs.docId)).toBe(false);

      stop();
      const local = olderCopy ? new MemoryLocal() : B.store.services.local;
      const reopened = new Store({ ...B.store.services, local }, []);
      reopened.ui({ attachments: [kept] });
      vi.useFakeTimers();
      if (delayUpload || olderCopy) docs.reconnect();
      const stopReopened = followCopies(reopened);
      try {
        await reopened.boot();
        const sendable = () => filesSendable(reopened, kept.dealId, [docs]);
        if (!delayUpload && !olderCopy) {
          await expect(sendable()).resolves.toBe(false);
          expect(reopened.get().ui.attachments[0]).toEqual(kept);
          docs.reconnect();
          await vi.advanceTimersByTimeAsync(30_000);
          expect(docs.destination.has(docs.docId)).toBe(true);
        }
        await expect(sendable()).resolves.toBe(true);
        expect(docs.destination.has(docs.docId)).toBe(true);
        expect(reopened.get().ui.attachments[0]).toEqual(kept);
      } finally {
        stopReopened();
        reopened.closing();
        vi.useRealTimers();
      }
    } finally {
      stop();
      A.store.closing();
      B.store.closing();
      await A.repo.close();
      await B.repo.close();
    }
  });
});

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

describe('a recovered copy whose source cannot be looked up (#744)', () => {
  it('is waiting, not missing, while the deleted deals cannot be listed, then sends once they can', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    const docs = standInDocumentFolders(B, dealId, false);
    const stop = followCopies(B.store);
    try {
      await attachFiles(B.store, { dealId, conv: convKey({ kind: 'deal', dealId }) }, [new File(['x'], docs.doc)]);
      await expect.poll(() => B.store.get().ui.attachments[0]?.state).toBe('done');
      await deleteUnseen(A, B, dealId, qid);
      await expect.poll(() => B.store.get().ui.attachments[0]?.dealId).not.toBe(dealId);
      const [kept] = B.store.get().ui.attachments;
      stop();
      // a restart that no longer remembers which deal the copy came from: the source is looked up
      const reopened = new Store({ ...B.store.services, local: new MemoryLocal() }, []);
      reopened.ui({ attachments: [kept] });
      const list = reopened.services.repo.list.bind(reopened.services.repo);
      let reachable = false;
      reopened.services.repo.list = ((kind: string, ...rest: unknown[]) =>
        !reachable && kind === 'tombstone' ? Promise.resolve(fail({ kind: 'unreachable', message: 'offline' }))
          : (list as (...args: unknown[]) => unknown)(kind, ...rest)) as typeof reopened.services.repo.list;
      const stopReopened = followCopies(reopened);
      try {
        await reopened.boot();
        await expect(filesSendable(reopened, kept.dealId, [docs])).resolves.toBe(false);
        expect(reopened.get().ui.attachments[0].missing).toBeUndefined();
        reachable = true;
        docs.reconnect();
        await expect(filesSendable(reopened, kept.dealId, [docs])).resolves.toBe(true);
        expect(reopened.get().ui.attachments[0].missing).toBeUndefined();
      } finally {
        stopReopened();
        reopened.closing();
      }
    } finally {
      A.store.closing();
      B.store.closing();
      await A.repo.close();
      await B.repo.close();
    }
  });
});

describe('a carry that finds nothing synced yet (#744)', () => {
  it('stays queued and holds sends only for a grace period, then reports missing and still completes', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    const docs = standInDocumentFolders(B, dealId, false);
    const stop = followCopies(B.store);
    const queued = () => (B.store.services.local.read('attachment-carries') as unknown[] | undefined) ?? [];
    vi.useFakeTimers({ shouldAdvanceTime: true });          // the first refused carry already holds the retry timer
    try {
      await attachFiles(B.store, { dealId, conv: convKey({ kind: 'deal', dealId }) }, [new File(['x'], docs.doc)]);
      await expect.poll(() => B.store.get().ui.attachments[0]?.state).toBe('done');
      await deleteUnseen(A, B, dealId, qid);
      await expect.poll(() => B.store.get().ui.attachments[0]?.dealId).not.toBe(dealId);
      const copyId = B.store.get().ui.attachments[0].dealId;
      let tries = 0;
      const port = B.store.services.docs;
      port.carryAttached = async () => { tries++; return ok({ written: 0, unresolved: 1 }); };
      await vi.advanceTimersByTimeAsync(30_000);
      tries = 0;
      await expect(filesSendable(B.store, copyId, [docs])).resolves.toBe(false);
      expect(B.store.get().ui.attachments[0].missing).toBeUndefined();
      expect(queued()).toHaveLength(1);                           // unresolved keeps the carry, in memory and saved
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(tries).toBeGreaterThan(20);                          // it keeps retrying past the grace period
      expect(queued()).toHaveLength(1);
      await expect(filesSendable(B.store, copyId, [docs])).resolves.toBe(false);
      expect(B.store.get().ui.attachments[0].missing).toBe(true);
      // the lines arrive after all: the carry completes and the file is sent from the copy
      port.carryAttached = async () => { docs.destination.add(docs.docId); return ok({ written: 1, unresolved: 0 }); };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(queued()).toHaveLength(0);
      await expect(filesSendable(B.store, copyId, [docs])).resolves.toBe(true);
    } finally {
      stop();
      vi.useRealTimers();
      A.store.closing();
      B.store.closing();
      await A.repo.close();
      await B.repo.close();
    }
  });
});
