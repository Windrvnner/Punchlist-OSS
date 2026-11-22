// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, quota, toAQuestion } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, DeleteQuestion } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
import { StoreContext } from '../../src/ui/hooks';
import { Composer } from '../../src/ui/conversation';

const COMMANDS = [CreateDeal, CreateQuestion, DeleteQuestion];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HYYYYYYYYYYYYYYYC${String(seq++).padStart(7, '0')}` };
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A deal's ask box over a real store on in-memory storage. */
async function mount(name: string) {
  const kv = disk(); const repo = memRepo(clock.now, kv); const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name, folders: [] });
  const dealId = Object.values(store.get().deals).find((d) => d.name === `Project ${name}`)!.id; await store.loadDeal(dealId);
  const host = document.createElement('div'); document.body.appendChild(host);
  await act(() => { render(<StoreContext.Provider value={store}><Composer scope={{ kind: 'deal', dealId }} launch="deal" /></StoreContext.Provider>, host); });
  const box = () => host.querySelector('textarea') as HTMLTextAreaElement;
  const enter = async (v: string) => {
    await act(() => { box().value = v; box().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
  };
  const questions = () => Object.values(store.get().questions).filter((q) => q.dealId === dealId);
  const toasts = () => store.get().ui.toasts.map((x) => x.text);
  return { store, kv, repo, dealId, host, box, enter, questions, toasts };
}

describe('"add a question: …" in a deal’s ask box', () => {
  it('makes the question and empties the box', async () => {
    const m = await mount('Yonder');
    await m.enter('add a question: Please confirm the O&M term.');
    expect(m.questions().map((q) => q.text)).toEqual(['Please confirm the O&M term.']);
    expect(m.box().value).toBe('');
  });

  it('with storage full, keeps the text in the box and says why', async () => {
    const m = await mount('Bellows');
    refuse(m.kv.local, toAQuestion, quota);
    await m.enter('add a question: Please provide the insurance schedule.');
    expect(m.questions()).toHaveLength(0);
    expect(m.box().value).toBe('add a question: Please provide the insurance schedule.');
    expect(m.toasts().some((x) => /storage is full/.test(x))).toBe(true);
  });

  it('when saving fails, says why without a Retry: the text back in the box is how to send it again, so it is never logged twice', async () => {
    const m = await mount('Datum');
    refuse(m.kv.local, toAQuestion, () => new Error('This PC’s own copy of the changes cannot be written to'));
    await m.enter('add a question: Please send the waiver.');
    expect(m.box().value).toBe('add a question: Please send the waiver.');
    const last = m.store.get().ui.toasts.at(-1);
    expect(last?.text).toMatch(/Couldn’t save/); expect(last?.action).toBeUndefined();
  });
});
