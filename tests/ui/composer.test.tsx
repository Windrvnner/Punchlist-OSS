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
import { attachFiles, followCopies, removeAttachment, MAX_ATTACHED } from '../../src/app/attachments';
import { convKey } from '../../src/app/conversations';
import { ok } from '../../src/domain/result';
import type { DocumentService } from '../../src/ports';

const COMMANDS = [CreateDeal, CreateQuestion, DeleteQuestion];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HYYYYYYYYYYYYYYYC${String(seq++).padStart(7, '0')}` };
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A deal's ask box over a real store on in-memory storage. */
async function mount(name: string, docs: Partial<DocumentService> = {}, underConversation = false) {
  const kv = disk(); const repo = memRepo(clock.now, kv); const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({
    repo, ai: mockAi(opts, repo), docs: { ...mockDocuments(opts), ...docs }, sheets: csvCodec,
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name, folders: [] });
  const dealId = Object.values(store.get().deals).find((d) => d.name === `Project ${name}`)!.id; await store.loadDeal(dealId);
  const host = document.createElement('div'); document.body.appendChild(host);
  const composer = <Composer scope={{ kind: 'deal', dealId }} launch={underConversation ? undefined : 'deal'} />;
  await act(() => { render(<StoreContext.Provider value={store}>{composer}</StoreContext.Provider>, host); });
  const box = () => host.querySelector('textarea') as HTMLTextAreaElement;
  const type = (v: string) => act(() => {
    box().value = v;
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = () => act(() => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const enter = async (v: string) => {
    await type(v);
    await press();
    await settle();
  };
  const questions = () => Object.values(store.get().questions).filter((q) => q.dealId === dealId);
  const toasts = () => store.get().ui.toasts.map((x) => x.text);
  return { store, kv, repo, dealId, host, box, type, press, enter, questions, toasts };
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

describe('files that can no longer be sent (#671)', () => {
  /** a deal's ask box with every file it can take attached, and a check whose answer the test gives */
  async function attachedAll(name: string) {
    let gone: string[] = [];
    let hold: Promise<void> | null = null;
    const checked: string[][] = [];
    const unsendable = async (_dealId: string, docIds: string[]) => {
      checked.push(docIds);
      if (hold) await hold;
      return ok(docIds.filter((id) => gone.includes(id)));
    };
    const m = await mount(name, { unsendable }, true);
    const files = Array.from({ length: MAX_ATTACHED }, (_, i) => new File([`consent ${i}`], `Consent ${i + 1}.pdf`));
    const conv = convKey({ kind: 'deal', dealId: m.dealId });
    await act(() => attachFiles(m.store, { dealId: m.dealId, conv }, files));
    await settle(40);
    const chips = () => m.store.get().ui.attachments;
    const asked = () => (m.store.get().threads[conv] ?? []).filter((x) => x.role === 'me');
    const lose = (...n: number[]) => { gone = n.map((i) => chips()[i].docId!); };
    const holdChecks = () => {
      let release = () => {};
      hold = new Promise((r) => { release = r; });
      return () => { hold = null; release(); };
    };
    return { ...m, conv, chips, asked, lose, holdChecks, checked };
  }

  it('sends nothing, keeps the text and every chip, and names what is missing', async () => {
    const m = await attachedAll('Mistral');
    m.lose(2, 5);
    await m.enter('Do the consents cover the change of control?');
    expect(m.asked()).toEqual([]);
    expect(m.box().value).toBe('Do the consents cover the change of control?');
    expect(m.chips()).toHaveLength(MAX_ATTACHED);
    expect(m.toasts().at(-1)).toBe('Couldn’t find 2 files — attach them again');
    // once the file is back, the same message goes with all of them
    m.lose();
    await m.press();
    await settle();
    expect(m.asked().map((x) => x.attached?.length)).toEqual([MAX_ATTACHED]);
    expect(m.box().value).toBe('');
  });

  it('while files are checked, what is typed meanwhile goes too, and a second Enter sends nothing twice', async () => {
    const m = await attachedAll('Sorrel');
    const release = m.holdChecks();
    await m.type('Do the consents');
    await m.press();
    await m.type('Do the consents cover the change of control?');
    await m.press();
    release();
    await settle(40);
    expect(m.checked).toHaveLength(1);
    expect(m.asked().map((x) => x.text)).toEqual(['Do the consents cover the change of control?']);
    expect(m.box().value).toBe('');
  });

  it('when the deal is kept as a copy during the check, nothing goes to the deleted deal (#117)', async () => {
    const m = await attachedAll('Fennel');
    await m.store.dispatch(CreateDeal, { name: 'Fennel (recovered)', folders: [] });
    const copyId = Object.values(m.store.get().deals).find((d) => d.id !== m.dealId)!.id;
    const stop = followCopies(m.store);
    const release = m.holdChecks();
    await m.enter('Do the consents cover the change of control?');
    await act(() => m.store.tookCopy(m.dealId, copyId, { [m.dealId]: copyId }));
    release();
    await settle(40);
    expect(m.asked()).toEqual([]);
    const onCopy = convKey({ kind: 'deal', dealId: copyId });
    expect(m.chips().map((chip) => chip.conv)).toEqual(Array(MAX_ATTACHED).fill(onCopy));
    stop();
  });

  it('nor when the files were taken off during the check and the deal was then kept as a copy (#117)', async () => {
    const m = await attachedAll('Zinnia');
    await m.store.dispatch(CreateDeal, { name: 'Zinnia (recovered)', folders: [] });
    const copyId = Object.values(m.store.get().deals).find((d) => d.id !== m.dealId)!.id;
    const stop = followCopies(m.store);
    const release = m.holdChecks();
    await m.enter('Do the consents cover the change of control?');
    for (const chip of m.chips()) removeAttachment(m.store, chip.id);
    await act(() => m.store.tookCopy(m.dealId, copyId, { [m.dealId]: copyId }));
    release();
    await settle(40);
    expect(m.asked()).toEqual([]);
    expect(m.store.get().threads[convKey({ kind: 'deal', dealId: copyId })] ?? []).toEqual([]);
    stop();
  });
});
