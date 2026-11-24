// @vitest-environment node
// Files attached and not yet sent come back after a restart, as the text beside them does (#60).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import type { Attachment } from '../../src/app/state';
import { KEPT_TEXT_KEY } from '../../src/ports';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

let local: MemoryLocal;
let flush: (() => void) | undefined;

async function restartKeptText() {
  flush?.();
  vi.resetModules();
  const kept = await import('../../src/app/keptText');
  kept.initializeKeptText(local);
  flush = kept.saveKeptDrafts;
  return kept;
}

/** a stand-in for the store: just its attachments, and who listens to them */
function fakeStore(attachments: Attachment[] = []) {
  let state = { ui: { attachments } };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    ui: (patch: (ui: { attachments: Attachment[] }) => Partial<{ attachments: Attachment[] }>) => {
      state = { ui: { ...state.ui, ...patch(state.ui) } };
      for (const listener of listeners) listener();
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
/** a fresh start of the app, with what the last one kept: the store it keeps attachments for */
async function startWith(attachments: Attachment[] = []) {
  await restartKeptText();
  const { keepAttachments } = await import('../../src/app/attachments');
  const store = fakeStore(attachments);
  keepAttachments(store as never);
  return store;
}
const HOME = 'all:c_01HZZZZZZZZZZZZZZZZ0000001';
const DEAL = 'deal:d_01HZZZZZZZZZZZZZZZZ0000002:c_01HZZZZZZZZZZZZZZZZ0000003';
const NAMES = ['Renewal schedule.pdf', 'Credit Agreement.pdf', 'Model v12.xlsx', 'Energy Yield Report.pdf'];
const done = (n: number, conv: string): Attachment => {
  const name = `${n + 1} ${NAMES[n % NAMES.length]}`;
  return { id: `a${n}`, name, dealId: 'd_1', conv, state: 'done', doc: name, docId: `doc${n}` };
};

beforeEach(() => {
  local = new MemoryLocal();
  flush = undefined;
});
afterEach(() => flush?.());

describe('attachments kept across a restart', () => {
  it('come back on Home and on a deal, as many as were ready, and only those', async () => {
    const before = await startWith();
    const ready = [...Array.from({ length: 10 }, (_, n) => done(n, HOME)), done(10, DEAL)];
    const uploading: Attachment = { id: 'p', name: 'Board minutes.pdf', dealId: 'd_1', conv: HOME, state: 'pending' };
    before.ui(() => ({ attachments: [...ready, uploading] }));
    const after = await startWith();
    expect(after.get().ui.attachments).toEqual(ready);
  });

  it('are let go once sent or taken off, so they do not come back after the next restart', async () => {
    const before = await startWith();
    before.ui(() => ({ attachments: [done(1, HOME), done(2, DEAL)] }));
    before.ui((ui) => ({ attachments: ui.attachments.filter((a) => a.id !== 'a1') }));   // sent, or its × pressed
    const after = await startWith();
    expect(after.get().ui.attachments.map((a) => a.id)).toEqual(['a2']);
  });

  it('are not doubled when the chip is still showing as the app starts again', async () => {
    const before = await startWith();
    before.ui(() => ({ attachments: [done(1, HOME)] }));
    const after = await startWith([done(1, HOME)]);
    expect(after.get().ui.attachments).toEqual([done(1, HOME)]);
  });

  it('moved to a deal’s recovered copy, come back on the copy after a restart (#117)', async () => {
    const before = await startWith();
    before.ui(() => ({ attachments: [done(1, DEAL), done(2, HOME)] }));
    const moved = { ...done(1, 'deal:d_copy:c_01HZZZZZZZZZZZZZZZZ0000003'), dealId: 'd_copy' };
    before.ui((ui) => ({ attachments: ui.attachments.map((a) => (a.id === 'a1' ? moved : a)) }));
    const after = await startWith();
    expect(after.get().ui.attachments).toEqual([moved, done(2, HOME)]);
  });

  it('keeps the latest name of a completed document with the same reference', async () => {
    const before = await startWith();
    const original = done(1, DEAL);
    before.ui(() => ({ attachments: [original] }));
    const renamed = { ...original, name: 'Executed Credit Agreement.pdf', doc: 'Executed Credit Agreement.pdf' };
    before.ui(() => ({ attachments: [renamed] }));
    const after = await startWith();
    expect(after.get().ui.attachments).toEqual([renamed]);
    const { state: _state, ...stored } = renamed;
    expect(local.read(KEPT_TEXT_KEY)).toEqual({ 'composer-files': [[renamed.id, stored]] });
  });

  it('restores a real recovered deal attachment and its typed text without rendering (#117)', async () => {
    const { keptDrafts, isText, saveKeptDrafts } = await restartKeptText();
    const { startKeepingDrafts } = await import('../../src/app/startKeepingDrafts');
    const { okd, row, syncAll, twoPcs } = await import('./pcs');
    const { ImportQuestions } = await import('../../src/app/commands/importQuestions');
    const { EditQuestionField } = await import('../../src/app/commands/questions');
    const { DeleteDeal } = await import('../../src/app/commands/deals');
    const { A, B, dealId, qid, fid } = await twoPcs();
    const rows = portfolioQuestions().map((question, index) => row(index + 1, question));
    okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }));
    await syncAll(A, B);
    await B.store.loadDeal(dealId, { gaps: false });
    expect(Object.values(B.store.get().questions)).toHaveLength(rows.length + 1);

    const stop = startKeepingDrafts(B.store);
    const conv = `finding:${dealId}:${fid}:c_facility`;
    const sentLater = {
      id: 'lender-consent', name: 'Portfolio lender consent.pdf', state: 'done' as const, dealId,
      findingId: fid, conv, doc: 'Portfolio lender consent.pdf', docId: 'executed-lender-consent',
    };
    B.store.ui({ attachments: [sentLater] });
    const draft = 'Does this consent cover the transfer of the operating companies?';
    keptDrafts('composer', isText).set(conv, draft);
    okd(await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: draft }));
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware' }));
    await syncAll(A, B);
    await expect.poll(() => B.store.get().ui.attachments[0]?.dealId).not.toBe(dealId);
    const [moved] = B.store.get().ui.attachments;
    expect(moved.findingId).not.toBe(fid);
    expect(moved.conv).toBe(`finding:${moved.dealId}:${moved.findingId}:c_facility`);
    const renamed = { ...sentLater, dealId: moved.dealId, findingId: moved.findingId, conv: moved.conv };
    expect(moved).toEqual(renamed);
    saveKeptDrafts();
    stop();

    const after = await startWith();
    expect(after.get().ui.attachments).toEqual([renamed]);
    expect(local.read(KEPT_TEXT_KEY)).toMatchObject({ composer: [[moved.conv, draft]] });
  });
});
