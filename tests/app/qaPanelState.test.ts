// @vitest-environment node
import { expect, it } from 'vitest';
import { keepOpenQuestion, openQuestionFor } from '../../src/app/qaView';
import { showsResponder } from '../../src/app/state';
import { canSetQuestionStatus, setQuestionStatus } from '../../src/domain/transitions';
import { initializeKeptText } from '../../src/app/keptText';
import { CreateQuestion } from '../../src/app/commands/questions';
import { recoveryApp, recoveryDeal } from './recoveryKit';

it('keeps an open panel per deal and restores only an existing question on that deal', async () => {
  const app = recoveryApp();
  const { store } = app;
  try {
    const dealId = await recoveryDeal(app);
    await store.dispatch(CreateQuestion, { dealId });
    const [q] = Object.values(store.get().questions);
    store.setPrefs({ qaOpen: { other: q.id } });
    keepOpenQuestion(store, dealId, q.id);
    const prefs = store.get().prefs;
    keepOpenQuestion(store, dealId, q.id);
    expect(store.get().prefs).toBe(prefs);
    expect(openQuestionFor(store.get(), dealId)).toBe(q.id);
    expect(openQuestionFor(store.get(), 'other')).toBeNull();
    store.setPrefs({ qaOpen: { ...prefs.qaOpen, absent: 'missing' } });
    expect(openQuestionFor(store.get(), 'absent')).toBeNull();
    keepOpenQuestion(store, dealId, null);
    expect(store.get().prefs.qaOpen).toEqual({ other: q.id, absent: 'missing' });

    const typed = 'Unsaved response';
    initializeKeptText(store.services.local);
    const { handFieldText, typedResponse, unsavedFields } = await import('../../src/app/fieldDrafts');
    handFieldText(`${q.id}:response`, typed, { value: q.response, rev: q.rev });
    expect(typedResponse(q)).toBe(true);
    expect(canSetQuestionStatus(q, 'answered')).toBe(false);
    unsavedFields.delete(`${q.id}:response`);
    expect(showsResponder(q)).toBe(false);
    expect(showsResponder({ ...q, respondedBy: 'Taylor' })).toBe(true);
    expect(showsResponder({ ...q, response: ' ' })).toBe(true);
    expect(canSetQuestionStatus({ ...q, response: typed }, 'answered')).toBe(true);
    const answered = { ...q, status: 'answered' as const };
    expect(showsResponder(answered)).toBe(true);
    expect(canSetQuestionStatus(answered, 'answered')).toBe(false);
    expect(canSetQuestionStatus(q, 'open')).toBe(true);
    expect(setQuestionStatus(answered, 'answered', { actor: 'Taylor', at: q.updatedAt }))
      .toEqual({ ok: true, value: { record: answered, audit: [] } });
  } finally {
    store.closing();
    await app.repo.close();
  }
});
