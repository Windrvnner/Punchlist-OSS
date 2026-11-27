import { expect, it, vi } from 'vitest';
import './keptTextSession';
import * as qaLog from '../../src/app/qaLog';
import { showQaLogUpdate } from '../../src/ui/qaLogNotice';
import { recoveryApp, recoveryDeal } from '../app/recoveryKit';

it('shows the reported duration with a working Retry action in the retry-limit notice', async () => {
  const app = recoveryApp();
  const retry = vi.fn(async () => ({ kind: 'canceled' as const }));
  const outcome: qaLog.QaLogUpdateOutcome = {
    kind: 'retryLimit',
    minutes: 17,
    retry,
  };
  const update = vi.spyOn(qaLog, 'updateQaLog').mockImplementation(async (_store, _dealId, options) => {
    options?.announce?.(outcome);
    return outcome;
  });

  try {
    const dealId = await recoveryDeal(app);
    await showQaLogUpdate(app.store, dealId);
    const notice = app.store.get().ui.toasts.at(-1);
    expect(notice?.text).toBe('Q&A log not updated · in use elsewhere for 17 minutes');
    expect(notice?.action?.label).toBe('Retry');
    notice?.action?.run?.();
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    update.mockRestore();
    app.store.closing();
    await app.repo.close();
  }
});
