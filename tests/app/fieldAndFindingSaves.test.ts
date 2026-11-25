// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { CHANGED_ELSEWHERE } from '../../src/app/changedElsewhere';
import { CreateDeal } from '../../src/app/commands/deals';
import { EditFinding } from '../../src/app/commands/findings';
import type { FieldCommit, FieldInput } from '../../src/app/fieldSave';
import { cancelSave, pendingSave, sendSave, showSaveForm } from '../../src/app/saveOut';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { make } from './importKit';

const original = 'Provide the executed agreement with all amendments.';
const firstEdit = 'Provide the executed credit agreement with all amendments.';
const laterEdit = 'Provide the executed credit agreement and any lender waivers.';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

async function startDrafts() {
  const kept = await import('../../src/app/keptText');
  kept.initializeKeptText(new MemoryLocal());
}

async function field(restored?: string) {
  await startDrafts();
  const { FieldSave } = await import('../../src/app/fieldSave');
  const { restoreFieldDraft, unsavedFields } = await import('../../src/app/fieldDrafts');
  const key = 'q_credit:question';
  let text = restored ?? original;
  let locked = false;
  const input: FieldInput = {
    text: () => text,
    partial: () => false,
    partialNow: () => false,
    focused: () => restored === undefined,
    locked: () => locked,
    stopTimer: () => false,
    markPartial: () => {},
    replaceText: (value) => { text = value; },
    adoptBase: () => {},
    landedEntryText: () => {},
    show: () => {},
  };
  if (restored !== undefined) unsavedFields.set(key, { text: restored, base: original, rev: 1 });
  const save = new FieldSave({ value: original, rev: 1 }, key, restoreFieldDraft(key, original), input);
  const pending: {
    value: string;
    over: string;
    resolve(result: Awaited<ReturnType<FieldCommit>>): void;
  }[] = [];
  const commit: FieldCommit = (value, over) => new Promise((resolve) => pending.push({ value, over, resolve }));
  const type = (value: string) => {
    input.replaceText(value);
    save.typed(text);
  };
  const lock = (next: boolean) => {
    locked = next;
    if (locked) save.keepCurrent();
    save.lockChanged(locked, commit);
  };
  return {
    save, type, lock, pending, commit, key, restoreFieldDraft, unsavedFields,
    text: () => text, replaceText: input.replaceText,
  };
}

it('unlocks without sending restored text and still sends new typing after a lock', async () => {
  const { save, lock, type, pending, key, restoreFieldDraft } = await field(firstEdit);
  lock(false);
  lock(true);
  lock(false);
  expect(pending).toHaveLength(0);
  expect(save.view).toMatchObject({ status: 'failed', byItself: false });
  expect(restoreFieldDraft(key, original)?.text).toBe(firstEdit);

  lock(true);
  type(laterEdit);
  expect(pending).toHaveLength(0);
  lock(false);
  expect(pending[0]).toMatchObject({ value: laterEdit, over: original });
  save.receive({ value: laterEdit, rev: 2 });
  pending[0].resolve({ ok: true });
  await vi.runAllTimersAsync();
  expect(restoreFieldDraft(key, laterEdit)).toBeUndefined();
});

it('sends fresh text on unlock even if an older save fails while the field is locked', async () => {
  const { save, lock, type, pending, commit, key, restoreFieldDraft } = await field(firstEdit);
  const retry = save.save(firstEdit, commit);
  lock(true);
  type(laterEdit);
  pending[0].resolve({ ok: false, error: { kind: 'failed', message: 'The record could not be written.' } });
  await retry;
  expect(restoreFieldDraft(key, original)?.text).toBe(laterEdit);
  expect(pending).toHaveLength(1);

  lock(false);
  expect(pending[1]).toMatchObject({ value: laterEdit, over: original });
  save.receive({ value: laterEdit, rev: 2 });
  pending[1].resolve({ ok: true });
  await vi.runAllTimersAsync();
  expect(restoreFieldDraft(key, laterEdit)).toBeUndefined();
});

it('waits for Retry after Escape puts back the restored draft and a lock clears', async () => {
  const { save, lock, type, replaceText, pending, commit, key, restoreFieldDraft } = await field(firstEdit);
  lock(false);
  type(laterEdit);
  replaceText(firstEdit);
  save.escape(firstEdit, { saved: original, status: 'failed', reason: '', byItself: false }, commit);

  lock(true);
  lock(false);
  expect(pending).toHaveLength(0);
  expect(restoreFieldDraft(key, original)?.text).toBe(firstEdit);
});

it('settles a normalized save without dropping newer typed text', async () => {
  const fieldDraft = await field();
  const { save, type, pending, commit, key, unsavedFields } = fieldDraft;
  type(` ${firstEdit} `);
  const attempt = save.save(fieldDraft.text(), commit);
  type(laterEdit);
  save.keepCurrent();
  save.receive({ value: firstEdit, rev: 2 });
  pending[0].resolve({ ok: true });

  await expect(attempt).resolves.toEqual({ kind: 'saved', written: true });
  await vi.runAllTimersAsync();
  expect(fieldDraft.text()).toBe(laterEdit);
  expect(unsavedFields.get(key)).toEqual({ base: firstEdit, rev: 2, text: laterEdit });
  expect(save.view).toMatchObject({ status: 'idle', external: false });
});

it('recognizes a stale queued field write and keeps the newer text until the person chooses', async () => {
  const fieldDraft = await field();
  const { save, type, pending, commit, key, restoreFieldDraft } = fieldDraft;
  type(firstEdit);
  const stale = save.save(fieldDraft.text(), commit);
  type(laterEdit);
  const peerText = 'Confirm the lending entities in the executed facility agreement.';
  save.receive({ value: peerText, rev: 2 });
  pending[0].resolve({ ok: false, error: { kind: 'conflict', message: CHANGED_ELSEWHERE } });

  await expect(stale).resolves.toEqual({ kind: 'changedElsewhere' });
  expect(save.view.external).toBe(true);
  expect(restoreFieldDraft(key, peerText)).toEqual({ text: laterEdit, base: original, rev: -1 });
  await expect(save.save(laterEdit, commit)).resolves.toBeUndefined();
  expect(pending).toHaveLength(1);

  const chosen = save.save(fieldDraft.text(), commit, true);
  expect(pending[1]).toMatchObject({ value: laterEdit, over: peerText });
  save.receive({ value: laterEdit, rev: 3 });
  pending[1].resolve({ ok: true });
  await expect(chosen).resolves.toEqual({ kind: 'saved', written: true });
  await vi.runAllTimersAsync();
  expect(restoreFieldDraft(key, laterEdit)).toBeUndefined();
});

it('returns a typed refusal and restores the draft with everything typed after the send', async () => {
  const fieldDraft = await field();
  const { save, type, pending, commit, key, restoreFieldDraft } = fieldDraft;
  type(firstEdit);
  const attempt = save.save(fieldDraft.text(), commit);
  type(laterEdit);
  const reason = 'The question is closed.';
  pending[0].resolve({ ok: false, error: { kind: 'rejected', message: reason } });

  await expect(attempt).resolves.toEqual({ kind: 'refused', reason });
  expect(save.view).toMatchObject({ status: 'refused', reason, external: false });
  expect(restoreFieldDraft(key, original)).toEqual({ text: laterEdit, base: original, rev: 1 });
});

it('settles two quick writes without overwriting either newer typing or the rest of the portfolio', async () => {
  const fieldDraft = await field();
  const { save, type, pending, commit, key, unsavedFields } = fieldDraft;
  const portfolio = portfolioQuestions().map((text, index) => [`q_portfolio_${index}:question`, {
    text,
    base: '',
    rev: 1,
  }] as const);
  expect(portfolio).toHaveLength(2376);
  for (const [id, draft] of portfolio) unsavedFields.set(id, draft);
  type(firstEdit);
  const first = save.save(fieldDraft.text(), commit);
  type(laterEdit);
  const second = save.save(fieldDraft.text(), commit);
  await expect(save.save(fieldDraft.text(), commit)).resolves.toBeUndefined();
  expect(pending.map(({ value }) => value)).toEqual([firstEdit, laterEdit]);

  const newest = laterEdit + ' Include the latest extension notice.';
  type(newest);
  save.keepCurrent();
  save.receive({ value: firstEdit, rev: 2 });
  pending[0].resolve({ ok: true });
  await first;
  save.receive({ value: laterEdit, rev: 3 });
  pending[1].resolve({ ok: true });
  await second;
  await vi.runAllTimersAsync();

  expect(fieldDraft.text()).toBe(newest);
  expect(unsavedFields.get(key)?.text).toBe(newest);
  expect(save.base).toBe(laterEdit);
  expect(save.view).toMatchObject({ status: 'idle', external: false });
  expect([...unsavedFields].filter(([id]) => id !== key)).toEqual(portfolio);
});

it('transfers typing during Create and bases the next finding edit on the command’s stored title', async () => {
  vi.useRealTimers();
  await startDrafts();
  const { editDrafts, newFindingDrafts, saveFindingEdit, saveNewFinding } =
    await import('../../src/app/findingDrafts');
  const { store } = make();
  await store.boot();
  await store.dispatch(CreateDeal, { name: 'Southridge Solar Financing', folders: [] });
  const dealId = Object.keys(store.get().deals)[0];
  const title = '  Final draw conditions remain outstanding  ';
  const sent = { title, ws: 'Legal', body: 'The lender consent is unsigned.' };
  const typed = { ...sent, body: sent.body + '\n\nCounsel expects to deliver it on Friday.' };
  newFindingDrafts.set(dealId, sent);
  const created = saveNewFinding(store, dealId, sent, () => false);
  newFindingDrafts.set(dealId, typed);
  const made = await created;
  if (!made) throw new Error('Expected the draft to move to the created finding');
  expect(made.title).toBe('Final draw conditions remain outstanding');
  expect(newFindingDrafts.has(dealId)).toBe(false);
  const edit = editDrafts.get(made.id);
  if (!edit) throw new Error('Expected the typing to be kept on the new finding');
  expect(edit).toMatchObject({ ...typed, base: { title: made.title, workstream: 'Legal', body: [sent.body] } });

  const peerTitle = 'Lender consent remains outstanding';
  const change = await store.dispatch(EditFinding, {
    dealId, findingId: made.id, title: peerTitle, workstream: 'Legal', body: made.body,
  });
  expect(change.ok).toBe(true);
  await expect(saveFindingEdit(store, made, edit, () => false)).resolves.toBeNull();
  expect(store.get().findings[made.id]).toMatchObject({
    title: peerTitle, body: [sent.body, 'Counsel expects to deliver it on Friday.'],
  });
  expect(editDrafts.has(made.id)).toBe(false);
});

it('follows a single in-flight form save across reopening and preserves the Cancel choice', async () => {
  const key = 'finding-edit:facility';
  let resolveWrite!: () => void;
  const write = new Promise<void>((resolve) => { resolveWrite = resolve; });
  const hide = showSaveForm(key);
  const save = vi.fn(async (cancelled: () => boolean, inSight: () => boolean) => {
    await write;
    return { cancelled: cancelled(), inSight: inSight() };
  });
  const pending = sendSave(key, save);
  hide();
  cancelSave(key);
  const hideReopened = showSaveForm(key);
  expect(pendingSave(key)).toBe(pending);
  expect(sendSave(key, save)).toBeUndefined();
  resolveWrite();

  await expect(pending).resolves.toEqual({ cancelled: true, inSight: true });
  expect(save).toHaveBeenCalledTimes(1);
  expect(pendingSave(key)).toBeUndefined();
  await expect(sendSave(key, save)).resolves.toEqual({ cancelled: false, inSight: true });
  hideReopened();
});

const handed = 'Seller counsel confirmed the executed agreement is in folder 4.2.';
const theirs = 'Provide the executed agreement, as amended through closing.';

it('puts handed text after unsaved typing in a field on screen, marked changed elsewhere (#939)', async () => {
  const { save, type, key, unsavedFields, text } = await field();
  type(firstEdit);
  save.takeHanded(handed);
  save.receive({ value: theirs, rev: 2 });
  expect(text()).toBe(`${firstEdit}\n\n${handed}`);
  expect(save.view.external).toBe(true);
  expect(unsavedFields.get(key)).toEqual({ text: `${firstEdit}\n\n${handed}`, base: original, rev: -1 });
});

it('keeps unsaved typing and handed text when the typing’s save is refused as changed elsewhere (#939)', async () => {
  const { save, type, pending, commit, key, unsavedFields, text } = await field();
  type(firstEdit);
  const saving = save.save(firstEdit, commit);
  save.takeHanded(handed);
  save.receive({ value: theirs, rev: 2 });
  pending[0].resolve({ ok: false, error: { kind: 'conflict', message: CHANGED_ELSEWHERE } });
  await saving;
  expect(text()).toBe(`${firstEdit}\n\n${handed}`);
  expect(save.view.external).toBe(true);
  expect(unsavedFields.get(key)?.text).toBe(`${firstEdit}\n\n${handed}`);
});
