// A notice's Undo (#957): what becomes of the notice when the Undo cannot run, for each failure kind and sign-in state,
// timed with stand-in failures and fake timers.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { fail, ok, rejected, type Failure } from '../../src/domain/result';
import { keepUntilSignedIn, undoFromNotice } from '../../src/app/undoNotice';

const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10)).toISOString() };
let seq = 0;
const ids = { next: (prefix: string) => `${prefix}_${String(seq++).padStart(7, '0')}` };
const SIGNED_OUT = 'Sign in to Intelligence to make changes';
const TEXT = 'Question deleted ·';

/** A store whose Undo gives back `outcome` and whose sign-in reads `signedOut`, with one Undo notice showing. */
function noticeShowing(outcome: Failure | null, signedOut = false) {
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({
    repo: memRepo(clock.now, disk()), ai: mockAi(opts), docs: mockDocuments(opts),
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, []);
  vi.spyOn(store, 'readOnly').mockReturnValue(signedOut ? SIGNED_OUT : null);
  const undo = vi.spyOn(store, 'undo').mockResolvedValue(outcome ? fail(outcome) : ok({ opId: 'op_undo' }));
  const action = { label: 'Undo', opId: 'op_1' };
  const id = store.toast(TEXT, action);
  return { store, undo, notice: { id, text: TEXT, action } };
}
const shown = (store: Store) => store.get().ui.toasts.map((t) => ({ text: t.text, sticky: t.sticky, action: t.action }));

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
    expect(keepUntilSignedIn(store, 'Couldn’t save ·', { label: 'Retry', run: () => {} })).toBe(false);
    expect(shown(store)).toHaveLength(1);
  });
});
