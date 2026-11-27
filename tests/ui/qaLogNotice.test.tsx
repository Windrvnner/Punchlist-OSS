import { expect, it, vi } from 'vitest';
import './keptTextSession';
import * as qaLog from '../../src/app/qaLog';
import { showQaLogUpdate } from '../../src/ui/qaLogNotice';
import { recoveryApp, recoveryDeal } from '../app/recoveryKit';

it('uses the duration reported by the app in the retry-limit notice', async () => {
  const app = recoveryApp();
  const outcome: qaLog.QaLogUpdateOutcome = {
    kind: 'retryLimit',
    minutes: 17,
    retry: async () => ({ kind: 'canceled' }),
  };
  const update = vi.spyOn(qaLog, 'updateQaLog').mockImplementation(async (_store, _dealId, options) => {
    options?.announce?.(outcome);
    return outcome;
  });

  try {
    const dealId = await recoveryDeal(app);
    await showQaLogUpdate(app.store, dealId);
    expect(app.store.get().ui.toasts.at(-1)?.text)
      .toBe('Q&A log not updated · in use elsewhere for 17 minutes');
  } finally {
    update.mockRestore();
    app.store.closing();
    await app.repo.close();
  }
});
