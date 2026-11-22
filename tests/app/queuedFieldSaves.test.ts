// A field's save queued behind another save of the same record is refused, not written, when another PC's change to that
// field synced in meanwhile. Real Store, stand-in folders, the other-PC stand-in, a deal of 2,000 questions.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { CHANGED_ELSEWHERE } from '../../src/app/changedElsewhere';
import { memRepo, disk, type MemRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import type { Transaction } from '../../src/ports';

const COMMANDS = [CreateDeal, EditDeal, CreateQuestion, EditQuestionField, SetResponse, ImportQuestions];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 9, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HQQQQQQQQQQQQQQQQ${String(seq++).padStart(7, '0')}` };
const THEM = { by: 'sroe', from: 'PC B', at: '2026-11-17T09:30:00.000Z' };
const SIZE = 2000;

/**
 * A PC whose journal note after a change can be held: the change is written and applied, and the save of the same record
 * queued behind it waits, as when the journal is slow. `hold()` holds the next one; it returns what lets it go.
 */
function start() {
  const repo: MemRepo = memRepo(clock.now, { ...disk(), label: 'PC A' });
  let gate: Promise<void> | null = null; let release = () => {};
  let writeGate: Promise<void> | null = null; let releaseWrite = () => {};
  const real = repo.transaction.bind(repo);
  repo.transaction = async (tx: Transaction) => {
    const settled = tx.writes.length === 1 && tx.writes[0].kind === 'op' && (tx.writes[0].data as { state?: string }).state === 'succeeded';
    if (settled && gate) { const g = gate; gate = null; await g; }
    if (!settled && writeGate && tx.writes.some((w) => w.kind === 'deal')) { const g = writeGate; writeGate = null; await g; }
    return real(tx);
  };
  const hold = () => { gate = new Promise<void>((r) => { release = r; }); return () => release(); };
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  /** hold the next write of a deal itself, before it is applied */
  const holdWrite = () => { writeGate = new Promise<void>((r) => { releaseWrite = r; }); return () => releaseWrite(); };
  return { store, repo, hold, holdWrite };
}
const rows = (n: number) => { const csv = ['No.,Question,Response', ...Array.from({ length: n }, (_, k) => `${k + 1},"Question ${k + 1}.",`)].join('\n'); const tbl = readCsv(new TextEncoder().encode(csv)); if (!tbl.ok) throw new Error('csv'); return prepareImport(tbl.value.rows, suggestMapping(tbl.value.columns)).rows; };
async function deal(m: ReturnType<typeof start>) {
  await m.store.boot(); await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const id = Object.keys(m.store.get().deals)[0]; await m.store.loadDeal(id);
  expect((await m.store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows: rows(SIZE) }, { quiet: true })).ok).toBe(true);
  expect(dealQuestions(m.store.get(), id).length).toBe(SIZE);
  return id;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** another PC changes a record after it saw this PC's latest version of it, and this PC reads the change */
async function theirs(m: ReturnType<typeof start>, kind: 'deal' | 'question', id: string, patch: Record<string, unknown>) {
  const s = m.store.get(); const cur = kind === 'deal' ? s.deals[id] : s.questions[id];
  m.repo.peer.change(kind, id, { ...cur, ...patch }, THEM); await m.repo.sync(); await tick();
}
/** two more PCs, one clock 3 hours ahead and one 2 hours behind */
const PC2 = { by: 'jroe', from: 'PC C', at: '2026-11-17T12:00:00.000Z' };
const PC3 = { by: 'mdoe', from: 'PC D', at: '2026-11-17T07:00:00.000Z' };
/** other PCs change a record one after another, each after the one before, and this PC reads all of it in one sync */
async function oneSync(m: ReturnType<typeof start>, kind: 'deal' | 'question', id: string, changes: [typeof PC2, Record<string, unknown>][]) {
  const s = m.store.get(); let cur = kind === 'deal' ? s.deals[id] : s.questions[id];
  for (const [who, patch] of changes) { cur = { ...cur, ...patch } as typeof cur; m.repo.peer.change(kind, id, cur, who); }
  await m.repo.sync(); await tick();
}

describe('a field save queued behind another save of the record', () => {
  it('the issue\'s steps: "Theirs" synced in before the second save\'s turn is kept, and the second save is refused as changed elsewhere', async () => {
    const m = start(); const dealId = await deal(m);
    const go = m.hold();
    const first = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso' }, { quiet: true, over: '' });           // 1. typed "Contoso", blurred
    await tick();
    const second = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso B' }, { quiet: true, over: '' });        // 2. typed on and blurred: waits behind the first
    await tick(); expect(m.store.get().deals[dealId].counterparty).toBe('Contoso');
    await theirs(m, 'deal', dealId, { counterparty: 'Theirs' });                                                     // 3. another PC's change syncs in
    expect(m.store.get().deals[dealId].counterparty).toBe('Theirs');
    go();
    expect((await first).ok).toBe(true);
    const r = await second;
    expect(r.ok ? null : r.error).toEqual({ kind: 'conflict', message: CHANGED_ELSEWHERE });                         // 4. refused, not written
    expect(m.store.get().deals[dealId].counterparty).toBe('Theirs');
  });

  it('with nothing from elsewhere, the queued save goes through on top of the field\'s own first save, trimmed or not', async () => {
    const m = start(); const dealId = await deal(m);
    let go = m.hold();
    const a = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso ' }, { quiet: true, over: '' });               // stored trimmed, as "Contoso"
    await tick();
    const b = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso B ' }, { quiet: true, over: '' });
    await tick(); go();
    expect([(await a).ok, (await b).ok]).toEqual([true, true]);
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso B');
    // and a third, still typed over the value the field last took ("Contoso", trimmed), lands on the field's own "Contoso B"
    go = m.hold(); const c = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso BC' }, { quiet: true, over: 'Contoso' }); go();
    expect((await c).ok).toBe(true); expect(m.store.get().deals[dealId].counterparty).toBe('Contoso BC');
  });

  it('a question\'s text and response in a 2,000-question deal: a change to that field elsewhere is kept; one to another field is not in question', async () => {
    const m = start(); const dealId = await deal(m);
    const q = dealQuestions(m.store.get(), dealId).find((x) => String(x.n) === '1500')!;
    let go = m.hold();
    const first = m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Mine 1' }, { quiet: true, over: q.text });
    await tick();
    const second = m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Mine 2' }, { quiet: true, over: q.text });
    await tick(); await theirs(m, 'question', q.id, { text: 'Their wording' }); go();
    expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
    expect(m.store.get().questions[q.id].text).toBe('Their wording');
    // another PC changes who asked; this PC's queued response save is not about that field, so it goes through
    go = m.hold();
    const r1 = m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Draft' }, { quiet: true, over: '' });
    await tick();
    const r2 = m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Draft, longer' }, { quiet: true, over: '' });
    await tick(); await theirs(m, 'question', q.id, { askedBy: 'sroe' }); go();
    expect([(await r1).ok, (await r2).ok]).toEqual([true, true]);
    expect({ response: m.store.get().questions[q.id].response, askedBy: m.store.get().questions[q.id].askedBy, text: m.store.get().questions[q.id].text }).toEqual({ response: 'Draft, longer', askedBy: 'sroe', text: 'Their wording' });
  });

  it('Take theirs and Keep mine queued behind a slow save are refused when a newer change synced in, and neither writes over it', async () => {
    const m = start(); const dealId = await deal(m);
    const q = dealQuestions(m.store.get(), dealId).find((x) => String(x.n) === '7')!;
    await theirs(m, 'question', q.id, { response: 'theirs v1' });                                                   // the field shows "Changed elsewhere" over theirs v1
    for (const [answer, value] of [['Take theirs', 'theirs v1'], ['Keep mine', 'mine']] as const) {
      const go = m.hold();
      const slow = m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'askedBy', value: `Asked ${answer}` }, { quiet: true, over: m.store.get().questions[q.id].askedBy });   // a slow save on the same question
      await tick();
      const before = m.store.get().questions[q.id].response;
      const chosen = m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: value }, { quiet: true, over: before });   // the person answers over what was shown
      await tick(); await theirs(m, 'question', q.id, { response: `theirs v2 (${answer})` }); go();
      expect((await slow).ok).toBe(true);
      const r = await chosen; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
      expect(m.store.get().questions[q.id].response).toBe(`theirs v2 (${answer})`);
    }
  });

  it('a save with no `over` (a pick, an Undo, an import) is planned as before', async () => {
    const m = start(); const dealId = await deal(m);
    const go = m.hold();
    const a = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso' }, { quiet: true }); await tick();
    const b = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso B' }, { quiet: true }); await tick();
    await theirs(m, 'deal', dealId, { counterparty: 'Theirs' }); go();
    expect([(await a).ok, (await b).ok]).toEqual([true, true]);
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso B');
  });
  it('what this window wrote is not trusted once another PC changed the record since, even if that PC puts the same value back', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso' }, { quiet: true, over: '' })).ok).toBe(true);
    await theirs(m, 'deal', dealId, { counterparty: 'Coho' });
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();   // the field next door
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'Coho Corp' }, { quiet: true, over: 'Coho' }); await tick();
    await theirs(m, 'deal', dealId, { counterparty: 'Contoso' }); go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso');
  });
  it('another PC taking the first save back to what the second was typed over is a change from elsewhere too', async () => {
    const m = start(); const dealId = await deal(m);
    const write = m.holdWrite(); const go = m.hold();
    const a = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso' }, { quiet: true, over: '' }); await tick();
    const b = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso B' }, { quiet: true, over: '' }); await tick();   // sent before the first landed
    write(); for (let i = 0; i < 5; i++) await tick();
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso');
    await theirs(m, 'deal', dealId, { counterparty: '' }); go();                                                      // the other PC takes it back
    expect((await a).ok).toBe(true);
    const r = await b; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('');
  });
  it('after a save the Store trimmed, another PC putting back the value from before it is a change from elsewhere', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso ' }, { quiet: true, over: '' })).ok).toBe(true);
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso');
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso C' }, { quiet: true, over: '' }); await tick();   // the field could not tell "Contoso " landed as "Contoso"
    await theirs(m, 'deal', dealId, { counterparty: '' }); go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('');
  });
  it('a change from elsewhere that another change puts back while the save waits is still a change from elsewhere', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true })).ok).toBe(true);   // no `over`: not this field's own write
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();   // holds the deal's queue
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'mine' }, { quiet: true, over: 'orig' }); await tick();
    await theirs(m, 'deal', dealId, { counterparty: 'pc2' });
    await theirs(m, 'deal', dealId, { counterparty: 'orig' });                                                     // put back by another PC
    go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');
  });
});

describe('a field\'s queued save when several changes from elsewhere arrive in one sync', () => {
  it('the issue\'s steps: a change and its put-back read in one sync are a change from elsewhere, and the put-back is kept', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();   // holds the deal's queue
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'mine' }, { quiet: true, over: 'orig' }); await tick();
    const rev = m.store.get().deals[dealId].rev;
    await oneSync(m, 'deal', dealId, [[PC2, { counterparty: 'pc2' }], [PC3, { counterparty: 'orig' }]]);
    expect(m.store.get().deals[dealId].rev).toBe(rev + 2); expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');
  });
  it('a question\'s response in a 2,000-question deal, changed and put back by two PCs in one sync while its save waits', async () => {
    const m = start(); const dealId = await deal(m);
    const q = dealQuestions(m.store.get(), dealId)[1234];
    expect((await m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Ours' }, { quiet: true })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Question 1235, reworded.' }, { quiet: true, over: q.text }); await tick();
    const mine = m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Mine' }, { quiet: true, over: 'Ours' }); await tick();
    await oneSync(m, 'question', q.id, [[PC2, { response: 'Theirs' }], [PC3, { response: 'Ours' }]]);
    go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().questions[q.id].response).toBe('Ours');
    expect(dealQuestions(m.store.get(), dealId).length).toBe(SIZE);
  });
  it('this window\'s own save is no base once two changes arrive in one sync and end on its value', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso' }, { quiet: true, over: '' })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'Contoso Corp' }, { quiet: true, over: 'Contoso' }); await tick();
    await oneSync(m, 'deal', dealId, [[PC2, { counterparty: 'Coho' }], [PC3, { counterparty: 'Contoso' }]]);
    go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('Contoso');
  });
  it('one change to another field, read in one sync, still lets the queued save through', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'mine' }, { quiet: true, over: 'orig' }); await tick();
    await oneSync(m, 'deal', dealId, [[PC2, { sector: 'Energy' }]]);
    go();
    expect((await next).ok).toBe(true);
    expect((await mine).ok).toBe(true);
    expect(m.store.get().deals[dealId].counterparty).toBe('mine');
  });
  it('a clash read in one sync and settled back by another PC in the next, the field showing the same value throughout', async () => {
    const m = start(); const dealId = await deal(m);
    expect((await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditDeal, { dealId, product: 'Term loan' }, { quiet: true, over: '' }); await tick();
    const mine = m.store.dispatch(EditDeal, { dealId, counterparty: 'mine' }, { quiet: true, over: 'orig' }); await tick();
    const cur = m.store.get().deals[dealId];
    m.repo.peer.edit('deal', dealId, { ...cur, counterparty: 'pc2' }, PC2); await m.repo.sync(); await tick();   // made without this PC's latest: a clash
    expect(m.store.get().conflicts[dealId]).toBeTruthy(); expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    m.repo.peer.change('deal', dealId, { ...m.store.get().deals[dealId], counterparty: 'orig' }, PC3); await m.repo.sync(); await tick();
    expect(m.store.get().conflicts[dealId]).toBeFalsy(); expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    go();
    expect((await next).ok).toBe(true);
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');
  });
  it('a save sent while its question is in a clash, which another PC then settles back to the value shown, before its turn', async () => {
    const m = start(); const dealId = await deal(m);
    const q = dealQuestions(m.store.get(), dealId)[1999];
    expect((await m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Ours' }, { quiet: true })).ok).toBe(true);
    const go = m.hold();
    const next = m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Question 2000, reworded.' }, { quiet: true, over: q.text }); await tick();
    m.repo.peer.edit('question', q.id, { ...m.store.get().questions[q.id], text: q.text, response: 'Theirs' }, PC2); await m.repo.sync(); await tick();
    expect(m.store.get().conflicts[q.id]).toBeTruthy(); expect(m.store.get().questions[q.id].response).toBe('Ours');
    const mine = m.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Mine' }, { quiet: true, over: 'Ours' }); await tick();   // sent as the field leaves for the clash
    m.repo.peer.change('question', q.id, { ...m.store.get().questions[q.id], response: 'Ours' }, PC3); await m.repo.sync(); await tick();
    expect(m.store.get().conflicts[q.id]).toBeFalsy(); expect(m.store.get().questions[q.id].response).toBe('Ours');
    go(); await next;
    const r = await mine; expect(r.ok ? null : r.error.message).toBe(CHANGED_ELSEWHERE);
    expect(m.store.get().questions[q.id].response).toBe('Ours');
  });
});
