// A notice's Undo (#957): what becomes of the notice when the Undo cannot run, for each failure kind and sign-in state,
// timed with stand-in failures and fake timers.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, toAQuestion } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { fail, ok, rejected, type Failure } from '../../src/domain/result';
import { keepUntilSignedIn, undoFromNotice } from '../../src/app/undoNotice';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, DeleteQuestion } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';

const COMMANDS = [CreateDeal, CreateQuestion, DeleteQuestion];
for (const command of COMMANDS) registry.set(command.name, command);

const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10)).toISOString() };
let seq = 0;
const ids = { next: (prefix: string) => `${prefix}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const SIGNED_OUT = 'Sign in to Intelligence to make changes';
const TEXT = 'Question deleted ·';

function makeStore(kv = disk()) {
  const opts = { latency: [0, 0] as [number, number] };
  return new Store({
    repo: memRepo(clock.now, kv), ai: mockAi(opts), docs: mockDocuments(opts),
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, COMMANDS);
}

/** A store whose Undo gives back `outcome` and whose sign-in reads `signedOut`, with one Undo notice showing. */
function noticeShowing(outcome: Failure | null, signedOut = false) {
  const store = makeStore();
  vi.spyOn(store, 'readOnly').mockReturnValue(signedOut ? SIGNED_OUT : null);
  const undo = vi.spyOn(store, 'undo').mockResolvedValue(outcome ? fail(outcome) : ok({ opId: 'op_undo' }));
  const action = { label: 'Undo', opId: 'op_1' };
  const id = store.toast(TEXT, 'done', action);
  return { store, undo, notice: { id, text: TEXT, glyph: 'done' as const, action } };
}
const shown = (store: Store) => store.get().ui.toasts
  .map((t) => ({ text: t.text, sticky: t.sticky, action: t.action }));

describe('a notice\'s Undo', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('signed out: says so, and the notice comes back with its Undo to stay past the usual time', async () => {
    vi.useFakeTimers();
    const { store, undo, notice } = noticeShowing(null, true);
    await undoFromNotice(store, notice);
    expect(undo).not.toHaveBeenCalled();
    expect(shown(store)).toEqual([
      { text: SIGNED_OUT, sticky: false, action: undefined },
      { text: TEXT, sticky: true, action: notice.action },
    ]);
    vi.advanceTimersByTime(Store.TOAST_MS + 1);
    expect(shown(store)).toEqual([{ text: TEXT, sticky: true, action: notice.action }]);
  });

  for (const kind of ['storageFull', 'unreachable'] as const) {
    it(`a refusal that can clear (${kind}) puts the notice back with its Undo for the usual time`, async () => {
      vi.useFakeTimers();
      const { store, undo, notice } = noticeShowing({ kind, message: 'Refused' });
      await undoFromNotice(store, notice);
      expect(undo).toHaveBeenCalledWith('op_1');
      expect(shown(store)).toEqual([{ text: TEXT, sticky: false, action: notice.action }]);
      vi.advanceTimersByTime(Store.TOAST_MS - 1);
      expect(shown(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(shown(store)).toEqual([]);
    });
  }

  it('a refusal for good leaves the notice gone', async () => {
    const { store, notice } = noticeShowing(rejected('Already changed'));
    await undoFromNotice(store, notice);
    expect(shown(store)).toEqual([]);
  });

  it('a done Undo leaves the notice gone', async () => {
    const { store, notice } = noticeShowing(null);
    await undoFromNotice(store, notice);
    expect(shown(store)).toEqual([]);
  });

  it('signed in, keeping until sign-in does nothing', () => {
    const { store } = noticeShowing(null);
    expect(keepUntilSignedIn(store, 'Couldn’t save ·', 'warn', { label: 'Retry', run: () => {} })).toBe(false);
    expect(shown(store)).toHaveLength(1);
  });

  it('a failed save\'s Retry pressed while signed out keeps its notice the same way', async () => {
    const kv = disk();
    const store = makeStore(kv);
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'Is the lease assignable?' });
    const questionId = Object.keys(store.get().questions)[0];
    refuse(kv.shared, toAQuestion, () => new Error('The network path was not found'));
    await store.dispatch(DeleteQuestion, { dealId, questionId });
    const failed = store.get().ui.toasts.find((t) => t.text === 'Couldn’t save ·');
    vi.spyOn(store, 'readOnly').mockReturnValue(SIGNED_OUT);
    store.dismissToast(failed!.id);
    vi.useFakeTimers();
    failed!.action!.run!();
    expect(shown(store).filter((t) => t.text !== 'Couldn’t save ·').map((t) => t.text)).toContain(SIGNED_OUT);
    vi.advanceTimersByTime(Store.TOAST_MS + 1);
    const kept = shown(store).filter((t) => t.text === 'Couldn’t save ·');
    const retry = { label: 'Retry', run: failed!.action!.run };
    expect(kept).toEqual([{ text: 'Couldn’t save ·', sticky: true, action: retry }]);
  });
});
