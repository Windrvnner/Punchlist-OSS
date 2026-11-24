// Making the deal memo from the app: one press, the model's ratings and summary, the records as they stand, and the save dialog.
import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding } from '../../src/app/commands/findings';
import { CreateQuestion } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
import { makeMemo, runMemo } from '../../src/app/memo';
import { ok, fail } from '../../src/domain/result';
import type { FileSystem, SpreadsheetCodec, AiService } from '../../src/ports';

const COMMANDS = [CreateDeal, CreateFinding, CreateQuestion];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 15, 15, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
type Saved = { name: string; bytes: Uint8Array; kinds?: { label: string; ext: string }[] };

/**
 * `pick`: the stand-in save dialog with two kinds, answering with the kind given, or null for canceled. `log` records
 * the order of the dialog, the model and the write.
 */
function make(o: {
  pick?: 'docx' | 'pdf' | null;
  document?: SpreadsheetCodec['document'];
  ai?: Partial<AiService>;
  writePicked?: FileSystem['writePicked'];
} = {}) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now); const saved: Saved[] = []; const log: string[] = [];
  let asked: { name: string; kinds: { label: string; ext: string }[] } | null = null;
  const fs: FileSystem = { pickFolders: null, pathFor: null, save: async (name, bytes) => { saved.push({ name, bytes }); return ok('saved' as const); },
    ...(o.pick !== undefined ? {
      pickSave: async (name: string, kinds: { label: string; ext: string }[]) => { log.push('dialog'); asked = { name, kinds }; return ok(o.pick ? { id: 'p1', ext: o.pick } : null); },
      writePicked: async (id: string, bytes: Uint8Array) => {
        log.push(`write ${id}`);
        const result = o.writePicked ? await o.writePicked(id, bytes) : ok('saved' as const);
        if (result.ok) saved.push({ ...asked!, bytes });
        return result;
      },
      openPicked: async (id: string) => { log.push(`open ${id}`); return ok('opened' as const); },
    } : {}) };
  const ai = { ...mockAi(opts, repo), ...o.ai }; const memo = ai.memo!; ai.memo = (dealId) => { log.push('model'); return memo(dealId); };
  const store = new Store({ repo, ai, docs: mockDocuments(opts), fs, sheets: { ...csvCodec, ...(o.document ? { document: o.document } : {}) }, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, saved, log };
}
const twoKinds = async () => ok({ docx: new Uint8Array([1]), pdf: new Uint8Array([2]) });
async function dealWith(store: Store) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Southridge', folders: [] }, { quiet: true });
  const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
  await store.dispatch(CreateFinding, { dealId, title: 'Yield above the advisor’s figure', workstream: 'Technical',
    body: ['The advisor supports 2,010. [1]'], sources: [{ doc: 'Advisor report.pdf', loc: 'p. 41', docId: 'doc_a' }] },
    { quiet: true });
  await store.dispatch(CreateFinding, { dealId, title: 'Lock-up differs', workstream: 'Legal' }, { quiet: true });
  await store.dispatch(CreateFinding, { dealId, title: 'Cover is 12 months', workstream: 'Insurance' }, { quiet: true });
  await store.dispatch(CreateQuestion, { dealId, text: 'Which yield?', workstream: 'Technical' }, { quiet: true });
  return dealId;
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('the deal memo, made from the app', () => {
  it('without LibreOffice saves the laid-out document, with the model’s ratings and the records as they stand',
    async () => {
    const { store, saved } = make(); const dealId = await dealWith(store);
    const r = await makeMemo(store, dealId); expect(r).toEqual(ok('saved'));
    expect(saved.map((x) => x.name)).toEqual(['Project Southridge deal memo.fodt']);
    const doc = text(saved[0].bytes);
    expect(doc).toContain('<text:h text:style-name="Title" text:outline-level="1">Project Southridge</text:h>');
    expect(doc).toContain('Yield above the advisor’s figure'); expect(doc).toContain('3 open findings in 3 risks: 1 High, 1 Medium, 1 Low.');
    expect(doc).not.toContain('Made by'); expect(doc).not.toContain('rerun the model');
  });

  it('with LibreOffice opens the save dialog first, offering Word or PDF, then makes the memo and writes the kind picked', async () => {
    const made: string[] = [];
    const { store, saved, log } = make({ pick: 'pdf', document: async (fodt) => { made.push(fodt); return twoKinds(); } });
    const dealId = await dealWith(store);
    expect(await makeMemo(store, dealId)).toEqual(ok('saved'));
    expect(log).toEqual(['dialog', 'model', 'write p1']); expect(made.length).toBe(1);
    expect(saved).toEqual([{ name: 'Project Southridge deal memo', bytes: new Uint8Array([2]), kinds: [{ label: 'Word document', ext: 'docx' }, { label: 'PDF', ext: 'pdf' }] }]);
  });

  it('the button spins while it is made, then says it was saved; a failure says so with Retry, and Retry makes it', async () => {
    let failNext = true;
    const { store, saved } = make({ ai: { memo: async (dealId: string) => (failNext ? fail({ kind: 'unreachable', message: 'down' }) : mockAi({ latency: [0, 0] }).memo!(dealId)) } });
    const dealId = await dealWith(store);
    const run = runMemo(store, dealId); expect(store.get().ui.memoBusy).toEqual([dealId]);
    void runMemo(store, dealId);                                                     // a second press while it is made does nothing
    await run; expect(store.get().ui.memoBusy).toEqual([]);
    const toast = store.get().ui.toasts.at(-1)!; expect(toast.text).toBe('Couldn’t make the deal memo: Intelligence could not be reached'); expect(toast.action?.label).toBe('Retry');
    failNext = false; (toast.action as { run: () => void }).run(); await new Promise((r) => setTimeout(r, 20));
    expect(saved.length).toBe(1); expect(store.get().ui.toasts.at(-1)!.text).toBe('Deal memo saved');
  });

  it('the notice offers Open, which opens the file written', async () => {
    const { store, log } = make({ pick: 'docx', document: twoKinds }); const dealId = await dealWith(store);
    await runMemo(store, dealId);
    const toast = store.get().ui.toasts.at(-1)!; expect(toast.text).toBe('Deal memo saved'); expect(toast.action?.label).toBe('Open');
    (toast.action as { run: () => void }).run(); await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['dialog', 'model', 'write p1', 'open p1']);
  });

  it.each(['docx', 'pdf'] as const)('retries the same %s memo after the selected file refuses it', async (pick) => {
    const openMessage = 'Couldn’t save the file · Open elsewhere';
    const otherMessage = 'Couldn’t save the file';
    const document = vi.fn(twoKinds);
    const writePicked = vi.fn<NonNullable<FileSystem['writePicked']>>()
      .mockResolvedValueOnce(fail({ kind: 'failed', message: openMessage }))
      .mockResolvedValueOnce(fail({ kind: 'failed', message: otherMessage }))
      .mockResolvedValueOnce(ok('saved' as const));
    const { store, log, saved } = make({ pick, document, writePicked });
    const dealId = await dealWith(store);

    await runMemo(store, dealId);
    const notice = () => store.get().ui.toasts.at(-1);
    expect(notice()?.text).toBe(openMessage);
    expect(notice()?.action?.label).toBe('Retry');
    expect(saved).toEqual([]);

    notice()?.action?.run?.();
    await vi.waitFor(() => expect(notice()?.text).toBe(otherMessage));
    expect(notice()?.action?.label).toBe('Retry');
    notice()?.action?.run?.();
    await vi.waitFor(() => expect(notice()?.text).toBe('Deal memo saved'));
    expect(notice()?.action?.label).toBe('Open');
    notice()?.action?.run?.();

    const bytes = new Uint8Array([pick === 'pdf' ? 2 : 1]);
    expect(writePicked.mock.calls).toEqual([['p1', bytes], ['p1', bytes], ['p1', bytes]]);
    expect(document).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['dialog', 'model', 'write p1', 'write p1', 'write p1', 'open p1']);
  });

  it('makes the memo again after conversion fails before there are bytes to save', async () => {
    const document = vi.fn<NonNullable<SpreadsheetCodec['document']>>()
      .mockResolvedValueOnce(fail({ kind: 'failed', message: 'Couldn’t convert the document' }))
      .mockImplementationOnce(twoKinds);
    const { store, log } = make({ pick: 'docx', document });
    const dealId = await dealWith(store);

    await runMemo(store, dealId);
    const notice = () => store.get().ui.toasts.at(-1);
    expect(notice()?.text).toBe('Couldn’t make the deal memo');
    expect(log).toEqual(['dialog', 'model']);
    expect(notice()?.action?.label).toBe('Retry');
    notice()?.action?.run?.();

    await vi.waitFor(() => expect(notice()?.text).toBe('Deal memo saved'));
    expect(document).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['dialog', 'model', 'dialog', 'model', 'write p1']);
  });

  it('a canceled save dialog says nothing, asks nothing of the model and never spins the button', async () => {
    const { store, saved, log } = make({ pick: null, document: twoKinds });
    const dealId = await dealWith(store); const before = store.get().ui.toasts.length; const spun: string[][] = [];
    const off = store.subscribe(() => spun.push(store.get().ui.memoBusy));
    await runMemo(store, dealId); off();
    expect(log).toEqual(['dialog']); expect(saved).toEqual([]); expect(spun.flat()).toEqual([]); expect(store.get().ui.toasts.length).toBe(before);
  });
});
