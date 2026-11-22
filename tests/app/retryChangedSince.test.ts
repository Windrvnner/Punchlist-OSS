// The "Couldn’t save" notice's Retry plans the action again from the records as they are now. A change from another PC that
// arrived since is not written over: the Retry is refused, as the interrupted-actions bar's is, and the action stays
// in the journal for the person. Stand-in folders and the other-PC stand-in, on a deal of 2,000 questions.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, ELSEWHERE, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetQuestionStatus } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, EditDeal, CreateQuestion, SetQuestionStatus, ImportQuestions];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 11, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
function start(kv: Disk = disk()) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv, repo };
}
/** a deal of 2,000 questions (deals run to that) */
async function deal(store: Store) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id);
  const csv = ['No.,Question,Response', ...Array.from({ length: 2000 }, (_, k) => `${k + 1},"Question ${k + 1}: please confirm item ${k + 1}.",`)].join('\n');
  const tbl = readCsv(new TextEncoder().encode(csv)); if (!tbl.ok) throw new Error('csv');
  expect((await store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows: prepareImport(tbl.value.rows, suggestMapping(tbl.value.columns)).rows }, { quiet: true })).ok).toBe(true);
  return id;
}
const away = (kv: Disk) => refuse(kv.shared, () => true, () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const notice = (store: Store) => store.get().ui.toasts.find((x) => x.text === 'Couldn’t save ·')!;
const restart = async (kv: Disk, dealId: string) => { const again = start(kv); await again.store.boot(); await again.store.loadDeal(dealId); return again.store; };

describe('the “Couldn’t save” notice’s Retry', () => {
  it('is refused when another PC changed the record since, and writes nothing over it', async () => {
    const { store, kv, repo } = start(); const dealId = await deal(store);
    const back = away(kv);
    expect((await store.dispatch(EditDeal, { dealId, name: 'Project Mine' })).ok).toBe(false);
    const said = notice(store); expect(said.action?.label).toBe('Retry');
    back();
    const d = store.get().deals[dealId]; repo.peer.change('deal', dealId, { ...d, name: 'Theirs newer' }, ELSEWHERE); await repo.sync(); await tick();
    expect(store.get().deals[dealId].name).toBe('Theirs newer');
    said.action!.run!(); await tick();
    expect(store.get().deals[dealId].name).toBe('Theirs newer');
    expect(store.get().ui.toasts.some((x) => x.text.startsWith('This was changed since, so retrying would write over newer work'))).toBe(true);
    // the person's action is not thrown away: the next start offers it, and its own Retry is refused there too, until it is discarded
    const next = await restart(kv, dealId); expect(next.get().deals[dealId].name).toBe('Theirs newer');
    const offered = next.interruptedOps().filter((o) => o.command === 'EditDeal'); expect(offered.map((o) => [o.state, (o.input as { name: string }).name])).toEqual([['interrupted', 'Project Mine']]);
    expect((await next.retryOp(offered[0].id))?.ok).toBe(false); expect(next.get().deals[dealId].name).toBe('Theirs newer');
  });

  it('still makes the action when nothing changed since, once however often it is pressed', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(EditDeal, { dealId, name: 'Project Mine' });
    const said = notice(store); back(); said.action!.run!(); said.action!.run!(); await tick();
    expect(store.get().deals[dealId].name).toBe('Project Mine');
    expect((await restart(kv, dealId)).interruptedOps().filter((o) => o.state === 'interrupted')).toEqual([]);
  });

  it('is refused for a question changed elsewhere among 2,000, and other questions are untouched', async () => {
    const { store, kv, repo } = start(); const dealId = await deal(store);
    const q7 = dealQuestions(store.get(), dealId).find((x) => x.n === 7)!;
    const back = away(kv);
    await store.dispatch(SetQuestionStatus, { dealId, questionId: q7.id, status: 'closed' });
    const said = notice(store); back();
    repo.peer.change('question', q7.id, { ...store.get().questions[q7.id], text: 'Theirs: reworded' }, ELSEWHERE); await repo.sync(); await tick();
    said.action!.run!(); await tick();
    const now = store.get().questions[q7.id]; expect([now.text, now.status]).toEqual(['Theirs: reworded', q7.status]);
    expect(dealQuestions(store.get(), dealId)).toHaveLength(2000);
  });
});
