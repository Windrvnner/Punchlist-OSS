// @vitest-environment jsdom
// A notice shows the glyph it was raised with, whatever its words say, and a kept notice keeps that glyph (#1114).
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { StoreContext } from '../../src/ui/hooks';
import './keptTextSession';
import { Notices } from '../../src/ui/app';

let t = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0, t++)).toISOString() };
let seq = 0;
const ids = { next: (p: string) => `${p}_01HYYYYYYYYYYYYYYYD${String(seq++).padStart(7, '0')}` };

async function start(local = new MemoryLocal()) {
  const repo = memRepo(clock.now, disk());
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({
    repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), sheets: csvCodec,
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    session: mockSession(opts), local, clock, ids,
  }, []);
  await store.boot();
  const host = document.createElement('div');
  document.body.append(host);
  await act(() => { render(<StoreContext.Provider value={store}><Notices /></StoreContext.Provider>, host); });
  return { store, host, local };
}
const glyphs = (host: HTMLElement) => [...host.querySelectorAll('.toast .tg')].map((g) => g.innerHTML);

describe('a notice shows the glyph it was raised with', () => {
  it('a done notice shows the check although its words say "not cured"', async () => {
    const { store, host } = await start();
    await act(() => { store.toast('Saved', 'done'); });
    await act(() => { store.toast('Notice of default not cured · Saved', 'done'); });
    await act(() => { store.toast('Q4 updated', 'warn'); });
    const [check, notCured, warning] = glyphs(host);
    expect(notCured).toBe(check);
    expect(warning).not.toBe(check);
  });

  it('the same words raised as done and as warn show the glyph of each argument', async () => {
    const { store, host } = await start();
    await act(() => { store.toast('Saved', 'done'); });
    const doneGlyph = glyphs(host)[0];
    await act(() => { store.toast('Same words', 'done'); });
    await act(() => { store.toast('Same words', 'warn'); });
    const [, sameDone, sameWarn] = glyphs(host);
    expect(store.get().ui.toasts.map((x) => x.glyph)).toEqual(['done', 'done', 'warn']);
    expect(sameDone).toBe(doneGlyph);
    expect(sameWarn).not.toBe(doneGlyph);
  });

  it('a kept notice re-raised after a restart keeps its glyph', async () => {
    const first = await start();
    await act(() => { first.store.toast('Changes kept', 'done', undefined, 'kept'); });
    await act(() => { first.store.toast('Not kept', 'warn', undefined, 'kept'); });
    const before = glyphs(first.host);
    const second = await start(first.local);
    expect(second.store.get().ui.toasts.map((x) => x.glyph)).toEqual(['done', 'warn']);
    expect(glyphs(second.host)).toEqual(before);
  });
});
