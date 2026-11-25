// @vitest-environment node
import { expect, it } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { responseMergeView } from '../../src/app/drafting';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import { KEPT_TEXT_KEY } from '../../src/ports';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp } from './recoveryKit';

const questionId = (index: number) => `q_${String(index).padStart(26, '0')}`;

it('moves saved merge text and field choices when startup recovers a deal before Resolve opens', async () => {
  const storage = new MemoryLocal();
  const drafts = portfolioQuestions().slice(0, 312).map((text, index) =>
    [questionId(index), { text, ai: text }] as const);
  const entry = {
    text: 'The transmission permit was renewed in November. Counsel will confirm the renewal term.',
    ai: 'The transmission permit was renewed in November.',
  };
  const original = questionId(91);
  const copy = questionId(400);
  const fields = { priority: 'log', status: 'app' };
  drafts[91] = [original, entry];
  storage.write(KEPT_TEXT_KEY, { 'qa-merge': drafts, 'qa-merge-sides': [[original, fields]] });
  initializeKeptText(storage);
  const { startKeepingDrafts } = await import('../../src/app/startKeepingDrafts');
  const { store, repo } = recoveryApp();
  const stop = startKeepingDrafts(store);
  try {
    await store.tookCopy('d_original', 'd_recovered', { [original]: copy });
    saveKeptDrafts();   // Recovery must have moved the entries before anyone reads a merge.
    expect(storage.read(KEPT_TEXT_KEY)).toMatchObject({
      'qa-merge': [...drafts.filter(([id]) => id !== original), [copy, entry]],
      'qa-merge-sides': [[copy, fields]],
    });
    expect(responseMergeView(copy)).toMatchObject({ draft: entry, fields, hasDraft: true });
  } finally {
    stop();
    store.closing();
    await repo.close();
  }
});
