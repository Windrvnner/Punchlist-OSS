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

function composerRecoveryFixture(dealId: string, fid: string, qid: string) {
  const portfolio = portfolioQuestions().map((text, index) => [`q_portfolio-${index}:text`, {
    text, base: '', rev: 1,
  }]);
  const next = 'cfacility';
  const home = 'cportfolio';
  const slot = `deal:${dealId}`;
  const conv = `${slot}:${next}`;
  const doc = 'Portfolio lender consent.pdf';
  const findingDoc = 'Credit agreement.pdf';
  const findingConv = `f:${dealId}:${fid}`;
  const attached = { id: 'lender-consent', name: doc, dealId, conv, doc, docId: 'executed-lender-consent' };
  const findingAttachment = {
    id: 'credit-agreement', name: findingDoc, dealId, findingId: fid, conv: findingConv,
    doc: findingDoc, docId: 'executed-credit-agreement',
  };
  const [dealText, findingText, questionText, homeText] = [
    'Does this consent cover the transfer of the operating companies?',
    'Which lender approvals would change the debt service coverage finding?',
    'Does the sponsor expect the lender to turn comments by Friday?',
    'Which deals still need lender approval before financial close?',
  ];
  const snapshot = {
    'edit-field': portfolio,
    'composer-files': [[attached.id, attached], [findingAttachment.id, findingAttachment]],
    'next-conversation': [[slot, next], ['all', home]],
    composer: [[conv, dealText], [findingConv, findingText],
      [`q:${dealId}:${qid}`, questionText], [`all:${home}`, homeText]],
  };
  return {
    snapshot, portfolio, next, home, attached, findingAttachment, dealText, findingText, questionText, homeText,
  };
}

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

  it('moves saved attachments and composer drafts if recovery happens before a composer opens (#117)', async () => {
    const { okd, syncAll, twoPcs } = await import('./pcs');
    const { EditQuestionField } = await import('../../src/app/commands/questions');
    const { DeleteDeal } = await import('../../src/app/commands/deals');
    const { A, B, dealId, qid, fid } = await twoPcs();
    const {
      snapshot, portfolio, next, home, attached, findingAttachment, dealText, findingText, questionText, homeText,
    } = composerRecoveryFixture(dealId, fid, qid);
    local.write(KEPT_TEXT_KEY, snapshot);
    const { saveKeptDrafts } = await restartKeptText();
    const { startKeepingDrafts } = await import('../../src/app/startKeepingDrafts');
    const stop = startKeepingDrafts(B.store);
    try {
      B.store.ui({ route: { name: 'finding', dealId, findingId: fid } });
      okd(await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: dealText }));
      okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware' }));
      await syncAll(A, B);
      await expect.poll(() => B.store.get().ui.attachments[0]?.dealId).not.toBe(dealId);
      const [moved, movedFindingAttachment] = B.store.get().ui.attachments;
      const copy = moved.dealId;
      const copiedSlot = `deal:${copy}`;
      const copiedConv = `${copiedSlot}:${next}`;
      expect(moved).toEqual({ ...attached, dealId: copy, conv: copiedConv, state: 'done' });
      await B.store.loadDeal(copy, { gaps: false });
      const copiedFinding = Object.values(B.store.get().findings).find((finding) => finding.dealId === copy);
      const copiedQuestion = Object.values(B.store.get().questions).find((question) => question.dealId === copy);
      if (!copiedFinding || !copiedQuestion) throw new Error('The copy did not preserve the finding and question');
      expect(movedFindingAttachment).toEqual({
        ...findingAttachment, dealId: copy, findingId: copiedFinding.id, conv: `f:${copy}:${copiedFinding.id}`,
        state: 'done',
      });
      expect(movedFindingAttachment.findingId).not.toBe(fid);

      saveKeptDrafts(); // The keys have to move without any reads of the composer.
      const kept = {
        'edit-field': portfolio,
        'next-conversation': expect.arrayContaining([[copiedSlot, next], ['all', home]]),
        composer: expect.arrayContaining([[copiedConv, dealText], [`f:${copy}:${copiedFinding.id}`, findingText],
          [`q:${copy}:${copiedQuestion.id}`, questionText], [`all:${home}`, homeText]]),
      };
      expect(local.read(KEPT_TEXT_KEY)).toMatchObject(kept);
      expect(JSON.stringify(local.read(KEPT_TEXT_KEY))).not.toContain(dealId);

      const after = await startWith();
      expect(after.get().ui.attachments).toEqual([moved, movedFindingAttachment]);
      const { composerScope, composerText, convKey } = await import('../../src/app/conversations');
      const first = composerScope({ kind: 'deal', dealId: copy }, true);
      expect(convKey(first.scope)).toBe(copiedConv);
      expect(composerText(copiedConv)).toBe(dealText);
      expect(convKey(composerScope({ kind: 'all' }, true).scope)).toBe(`all:${home}`);
      expect(composerText(`all:${home}`)).toBe(homeText);
      expect(composerText(`f:${copy}:${copiedFinding.id}`)).toBe(findingText);
      expect(composerText(`q:${copy}:${copiedQuestion.id}`)).toBe(questionText);
      expect(local.read(KEPT_TEXT_KEY)).toMatchObject(kept);
    } finally {
      stop();
      A.store.closing();
      B.store.closing();
      await A.repo.close();
      await B.repo.close();
    }
  });
});
