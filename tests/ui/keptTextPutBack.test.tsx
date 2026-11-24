// @vitest-environment jsdom
// Text kept as "Not saved" while its field is off screen is not written over a change another PC made and a third PC put
// back meanwhile. Real Store, stand-in folders, other PCs with their clocks ahead and behind, 2,000 questions.
import { restartKeptText } from './keptTextSession';
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal } from '../../src/app/commands/deals';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { CreateQuestion, EditQuestionField, SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { conflictVersionCount } from '../../src/app/dealCounts';
import { dealQuestions } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { sheet } from '../app/importKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const COMMANDS = [CreateDeal, EditDeal, CreateQuestion, EditQuestionField, SetResponse, ImportQuestions, ResolveConflict];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 14, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HRRRRRRRRRRRRRRRR${String(seq++).padStart(7, '0')}` };
// two other PCs, one clock three hours ahead of this PC's and one two hours behind
const PC2 = { by: 'sroe', from: 'PC B', at: '2026-11-17T17:00:00.000Z' };
const PC3 = { by: 'jroe', from: 'PC C', at: '2026-11-17T12:00:00.000Z' };
const SIZE = 2000;
const tick = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function start(kv: Disk = disk()) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, kv };
}
const rows = (n: number) => { const csv = ['No.,Question,Response', ...Array.from({ length: n }, (_, k) => `${k + 1},"Question ${k + 1}.",`)].join('\n'); const tbl = readCsv(new TextEncoder().encode(csv)); if (!tbl.ok) throw new Error('csv'); return prepareImport(tbl.value.rows, suggestMapping(tbl.value.columns)).rows; };
async function deal(store: Store, questions = rows(SIZE)) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id);
  expect((await store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows: questions }, { quiet: true })).ok)
    .toBe(true);
  expect(dealQuestions(store.get(), id)).toHaveLength(questions.length);
  return id;
}
/** the shared folder refuses every write, as when it is out of reach; returns what puts it back */
const away = (kv: Disk) => refuse(kv.shared, () => true, () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
/** another PC changes a record from the latest version it can see, and this PC reads the change */
async function other(m: ReturnType<typeof start>, who: typeof PC2, kind: 'deal' | 'question', id: string, patch: Record<string, unknown>) {
  const s = m.store.get(); const cur = kind === 'deal' ? s.deals[id] : s.questions[id];
  m.repo.peer.change(kind, id, { ...cur, ...patch }, who); await m.repo.sync(); await tick();
}

// the field and the store's context come from one load of the modules, as in the app (a restart loads them again)
type Ui = typeof import('../../src/ui/editField') & typeof import('../../src/ui/hooks')
  & typeof import('../../src/app/fieldDrafts');
/** a field as the app shows one: under the store, drawn from its state; `shown(false)` takes it off screen */
function screen(ui: Ui, store: Store, which: { kind: 'counterparty'; dealId: string } | { kind: 'response'; dealId: string; questionId: string }) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const Field = () => {
    const s = ui.useAppState();
    if (which.kind === 'counterparty') {
      const { dealId } = which;
      const deal = s.deals[dealId];
      const locked = conflictVersionCount(s, dealId) === undefined ? null : 'Choose a version first';
      return <ui.ReadOnlyContext.Provider value={locked}>
        <ui.EditField keep={`${dealId}:counterparty`} read={ui.readDeal(dealId, 'counterparty')}
          label="Counterparty" value={deal.counterparty} rev={deal.rev} debounceMs={20}
          commit={(counterparty, over) => store.dispatch(EditDeal, { dealId, counterparty }, { quiet: true, over })} />
      </ui.ReadOnlyContext.Provider>;
    }
    const q = s.questions[which.questionId];
    return <ui.EditField keep={`${q.id}:response`} read={ui.readQuestion(q.id, 'response')} label="Response" multiline value={q.response} rev={q.rev} debounceMs={20} commit={(v, over) => store.dispatch(SetResponse, { dealId: q.dealId, questionId: q.id, response: v }, { quiet: true, over })} />;
  };
  const shown = (on: boolean) => act(() => { render(<ui.StoreContext.Provider value={store}>{on ? <Field /> : <span />}</ui.StoreContext.Provider>, host); });
  const el = () => host.querySelector('input, textarea') as HTMLInputElement;
  const type = async (v: string) => { await act(() => { el().dispatchEvent(new FocusEvent('focus')); el().value = v; el().dispatchEvent(new Event('input', { bubbles: true })); el().dispatchEvent(new FocusEvent('blur')); }); await tick(60); };
  const press = async (label: string) => { await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label))!.click(); }); await tick(60); };
  return { host, shown, el, type, press, text: () => host.textContent ?? '' };
}
const load = async (): Promise<Ui> => ({
  ...(await import('../../src/ui/editField')),
  ...(await import('../../src/ui/hooks')),
  ...(await import('../../src/app/fieldDrafts')),
});
async function fresh() {
  localStorage.clear();
  await restartKeptText();
  return load();
}

describe('kept text and a change put back while its field was off screen', () => {
  it('keeps a restored edit waiting for Retry after choosing a version with the same field value (#232)', async () => {
    const ui = await fresh();
    const { store, repo, kv } = start();
    const questions = portfolioQuestions();
    expect(questions).toHaveLength(2376);
    const dealId = await deal(store, sheet('Question', questions.map((question) => [question])));
    const original = 'Project company';
    const draft = 'Borrower and guarantors';
    const peer = 'Holding company';
    expect((await store.dispatch(EditDeal, { dealId, counterparty: original }, { quiet: true, over: '' })).ok).toBe(true);
    const record = () => store.get().deals[dealId];
    const field = screen(ui, store, { kind: 'counterparty', dealId });
    await field.shown(true);
    const restoreWrites = away(kv);
    await field.type(draft);
    await field.shown(false);
    restoreWrites();
    await field.shown(true);
    expect(field.text()).toBe('Not saved · Retry');
    const base = record();
    repo.peer.change('deal', dealId, { ...base, sector: 'Energy' }, PC3);
    await repo.sync();
    await tick();
    expect(record()).toMatchObject({ counterparty: original, sector: 'Energy' });
    expect(repo.peer.edit('deal', dealId, { ...base, counterparty: peer }, PC2)).toBe('conflict');
    await repo.sync();
    await tick();
    expect(field.el().readOnly).toBe(true);
    expect(record().counterparty).toBe(original);
    const { versions } = store.get().conflicts[dealId];
    expect(versions).toHaveLength(2);
    const chosen = versions.find(({ from }) => from === PC3.from)!;
    expect((await store.dispatch(ResolveConflict, { dealId, recordId: dealId, keep: chosen.id })).ok).toBe(true);
    await tick(60);

    expect(store.get().conflicts[dealId]).toBeUndefined();
    expect(record()).toMatchObject({ counterparty: original, sector: 'Energy' });
    expect(field.el().value).toBe(draft);
    expect(field.text()).toBe('Not saved · Retry');
    await field.press('Not saved');
    expect(record()).toMatchObject({ counterparty: draft, sector: 'Energy' });
    await field.shown(false);
  });

  it('the issue\'s steps: a second PC changes the counterparty, a third puts it back; the field says "Changed elsewhere" and Retry is not offered', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
    const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
    const back = away(m.kv); await f.type('mine');                                                     // 1. the save fails
    expect(f.text()).toMatch(/Not saved/);
    await f.shown(false); back();                                                                      // 2. off screen
    await other(m, PC2, 'deal', dealId, { counterparty: 'pc2 wording' });                               // 3. one PC changes it, another puts it back
    await other(m, PC3, 'deal', dealId, { counterparty: 'orig' });
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    await f.shown(true);                                                                               // 4. back
    expect(f.el().value).toBe('mine'); expect(f.text()).toMatch(/Changed elsewhere/); expect(f.text()).not.toMatch(/Retry/);
    await act(async () => { f.el().dispatchEvent(new FocusEvent('blur')); }); await tick(60);
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');                                     // 5. nothing written without the person
    await f.press('Keep Mine');
    expect(m.store.get().deals[dealId].counterparty).toBe('mine'); expect(f.text()).not.toMatch(/Changed elsewhere|Not saved/);
    await f.shown(false);
  });

  it('Escape keeps the text and leaves the choice open, in the one-line field', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
    const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
    const back = away(m.kv); await f.type('mine'); await f.shown(false); back();
    await other(m, PC2, 'deal', dealId, { counterparty: 'pc2 wording' }); await other(m, PC3, 'deal', dealId, { counterparty: 'orig' });
    await f.shown(true);
    await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); f.el().dispatchEvent(new FocusEvent('blur')); }); await tick(60);
    expect(f.el().value).toBe('mine'); expect(f.text()).toMatch(/Changed elsewhere · Keep Mine Take Theirs/);
    expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    await f.shown(false);
  });

  it('Take theirs drops the kept text and writes nothing', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
    const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
    const back = away(m.kv); await f.type('mine'); await f.shown(false); back();
    await other(m, PC2, 'deal', dealId, { counterparty: 'pc2 wording' }); await other(m, PC3, 'deal', dealId, { counterparty: 'orig' });
    await f.shown(true); await f.press('Take Theirs');
    expect(f.el().value).toBe('orig'); expect(m.store.get().deals[dealId].counterparty).toBe('orig');
    await f.shown(false); await f.shown(true);
    expect(f.el().value).toBe('orig'); expect(f.text()).not.toMatch(/Changed elsewhere|Not saved/);
    await f.shown(false);
  });

  it('another PC changing only another part of the record while the field is off screen still leaves "Not saved · Retry", and Retry saves', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
    const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
    const back = away(m.kv); await f.type('mine'); await f.shown(false); back();
    await other(m, PC2, 'deal', dealId, { sector: 'Energy' }); await other(m, PC3, 'deal', dealId, { target: 'Proseware Holdings' });
    await f.shown(true);
    expect(f.el().value).toBe('mine'); expect(f.text()).toMatch(/Not saved · Retry/); expect(f.text()).not.toMatch(/Changed elsewhere/);
    await f.press('Not saved');
    expect(m.store.get().deals[dealId]).toMatchObject({ counterparty: 'mine', sector: 'Energy', target: 'Proseware Holdings' });
    await f.shown(false);
  });

  it('a question\'s response among 2,000: put back by two PCs while the person was on another question', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    const q = dealQuestions(m.store.get(), dealId).find((x) => String(x.n) === '1500')!;
    const f = screen(ui, m.store, { kind: 'response', dealId, questionId: q.id }); await f.shown(true);
    const back = away(m.kv); await f.type('Our response'); expect(f.text()).toMatch(/Not saved/);
    await f.shown(false); back();
    await other(m, PC2, 'question', q.id, { response: 'Their response' });
    await other(m, PC3, 'question', q.id, { askedBy: 'jroe' });                                    // another field too
    await other(m, PC3, 'question', q.id, { response: '' });                                            // and the response put back
    await f.shown(true);
    expect(f.el().value).toBe('Our response'); expect(f.text()).toMatch(/Changed elsewhere/); expect(f.text()).not.toMatch(/Retry/);
    expect(m.store.get().questions[q.id].response).toBe('');
    await f.shown(false);
  });

  it('a change and its put-back that arrive in one sync (this PC was cut off meanwhile) are asked about, off screen and on screen', async () => {
    for (const off of [true, false]) {
      const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
      await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
      const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
      const back = away(m.kv); await f.type('mine'); if (off) await f.shown(false); back();
      const cur = () => m.store.get().deals[dealId];
      m.repo.peer.change('deal', dealId, { ...cur(), counterparty: 'pc2 wording' }, PC2);              // both written before this PC looks again
      m.repo.peer.change('deal', dealId, { ...cur(), counterparty: 'orig' }, PC3);
      await m.repo.sync(); await tick();
      expect(cur().counterparty).toBe('orig');
      if (off) await f.shown(true);
      expect(f.el().value).toBe('mine'); expect(f.text()).toMatch(/Changed elsewhere/); expect(f.text()).not.toMatch(/Retry/);
      await act(async () => { f.el().dispatchEvent(new FocusEvent('blur')); }); await tick(60);
      expect(cur().counterparty).toBe('orig');
      await f.shown(false);
    }
  });

  it('text being typed when "Changed elsewhere" shows is kept against a crash, and so is what is typed after', async () => {
    for (const route of ['other fields in one sync', 'the field itself'] as const) {
      const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
      const { saveKeptDrafts } = await import('../../src/app/keptText');
      const stored = () => { saveKeptDrafts(); return JSON.stringify(JSON.parse(localStorage.getItem('dil/1/kept-drafts') ?? '{}')['edit-field'] ?? []); };
      const q = dealQuestions(m.store.get(), dealId).find((x) => String(x.n) === '1500')!;
      const f = screen(ui, m.store, { kind: 'response', dealId, questionId: q.id }); await f.shown(true);
      await act(() => { f.el().dispatchEvent(new FocusEvent('focus')); f.el().value = 'Typed, not sent yet'; f.el().dispatchEvent(new Event('input', { bubbles: true })); });   // inside the debounce
      const cur = () => m.store.get().questions[q.id];
      if (route === 'the field itself') await other(m, PC2, 'question', q.id, { response: 'Their response' });
      else { m.repo.peer.change('question', q.id, { ...cur(), askedBy: 'sroe' }, PC2); m.repo.peer.change('question', q.id, { ...cur(), askedBy: 'sroe', priority: 'High' }, PC3); await m.repo.sync(); await tick(); }
      expect(f.text()).toMatch(/Changed elsewhere/);
      expect(stored()).toContain('Typed, not sent yet');                                              // a crash now would not lose it
      await act(() => { f.el().value = 'Typed, not sent yet, and more'; f.el().dispatchEvent(new Event('input', { bubbles: true })); }); await tick(60);
      expect(stored()).toContain('Typed, not sent yet, and more'); expect(stored()).toContain('"rev":-1');   // still asked about after a restart
      expect(cur().response).toBe(route === 'the field itself' ? 'Their response' : '');
      await f.shown(false);
    }
  });

  it('with nothing typed, two changes elsewhere in one sync are just followed', async () => {
    const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
    const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
    const cur = () => m.store.get().deals[dealId];
    m.repo.peer.change('deal', dealId, { ...cur(), counterparty: 'pc2 wording' }, PC2); m.repo.peer.change('deal', dealId, { ...cur(), counterparty: 'pc2 wording', sector: 'Energy' }, PC3);
    await m.repo.sync(); await tick();
    expect(f.el().value).toBe('pc2 wording'); expect(f.text()).not.toMatch(/Changed elsewhere|Not saved/);
    await f.type('mine'); expect(cur().counterparty).toBe('mine');
    await f.shown(false);
  });

  it('after a restart: put back while the app was closed is asked about; nothing changed since still says "Not saved · Retry"', async () => {
    for (const putBack of [true, false]) {
      const ui = await fresh(); const m = start(); const dealId = await deal(m.store);
      await m.store.dispatch(EditDeal, { dealId, counterparty: 'orig' }, { quiet: true, over: '' });
      const f = screen(ui, m.store, { kind: 'counterparty', dealId }); await f.shown(true);
      const back = away(m.kv); await f.type('mine'); await f.shown(false); back();
      await new Promise((r) => setTimeout(r, 500));                                                    // kept in local storage
      // the app closes; meanwhile two other PCs change it and put it back
      const again = start(m.kv);
      if (putBack) { await again.store.boot(); await other(again, PC2, 'deal', dealId, { counterparty: 'pc2 wording' }); await other(again, PC3, 'deal', dealId, { counterparty: 'orig' }); }
      const restarted = start(m.kv); await restarted.store.boot(); await restarted.store.loadDeal(dealId);
      expect(restarted.store.get().deals[dealId].counterparty).toBe('orig');
      await restartKeptText();
      const ui2 = await load();
      const g = screen(ui2, restarted.store, { kind: 'counterparty', dealId }); await g.shown(true);
      expect(g.el().value).toBe('mine');
      if (putBack) { expect(g.text()).toMatch(/Changed elsewhere/); expect(g.text()).not.toMatch(/Retry/); }
      else { expect(g.text()).toMatch(/Not saved · Retry/); await g.press('Not saved'); expect(restarted.store.get().deals[dealId].counterparty).toBe('mine'); }
      await g.shown(false); void ui;
    }
  });
});
