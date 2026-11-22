// @vitest-environment jsdom
// Files attached and not yet sent come back after a restart, as the text beside them does (#60).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Attachment } from '../../src/app/state';

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
  window.dispatchEvent(new Event('pagehide'));
  vi.resetModules();
  const { keepAttachments } = await import('../../src/ui/keptAttachments');
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

beforeEach(() => localStorage.clear());

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
});
