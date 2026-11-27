// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { EditDeal } from '../../src/app/commands/deals';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { KEPT_TEXT_KEY, type Transaction } from '../../src/ports';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { ELSEWHERE } from '../adapters/memRepo';
import {
  failRecoveryWrite, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal, type RecoveryApp,
} from './recoveryKit';

const original = 'Project Recovery fixture';
const raw = '  Café  Cafe\u0301 Solar  ';
const stored = 'Project Café  Cafe\u0301 Solar';
let app: RecoveryApp;

const writesDeal = (tx: Transaction) => tx.writes.some((write) => write.kind === 'deal');
const settlesRename = (tx: Transaction) => tx.writes.length === 1 && operationWrite(tx, 'EditDeal', 'succeeded');

afterEach(async () => {
  app.store.closing();
  await app.repo.close();
});

async function fixture(kept?: string) {
  app = recoveryApp(undefined, [EditDeal]);
  const id = await recoveryDeal(app);
  const local = new MemoryLocal();
  if (kept !== undefined) {
    local.write(KEPT_TEXT_KEY, { 'deal-name': [[id, { text: kept, base: original }]] });
  }
  async function start() {
    vi.resetModules();
    const { initializeKeptText, saveKeptDrafts } = await import('../../src/app/keptText');
    initializeKeptText(local);
    const { DealRename } = await import('../../src/app/dealRename');
    const header = () => new DealRename(app.store, id, { render() {}, close() {}, focus() {} });
    return { header, saveKeptDrafts };
  }
  const { header, saveKeptDrafts } = await start();
  const field = header();
  field.open();
  return { field, header, saveKeptDrafts, start, local, id, deal: () => app.store.get().deals[id] };
}

it('keeps typing through a pause and sends only the edge-trimmed command on Enter', async () => {
  const { field, deal } = await fixture();
  const dispatch = vi.spyOn(app.store, 'dispatch');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    field.typed(raw);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(field.kept?.text).toBe(raw);
  } finally {
    vi.useRealTimers();
  }
  await Promise.all([field.submit('enter'), field.submit('blur')]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toEqual({ dealId: deal().id, name: 'Café  Cafe\u0301 Solar' });
  expect(dispatch.mock.calls[0]?.[2]).toEqual({ quiet: true, over: original });
});

it.each(['enter', 'blur'] as const)('saves a restored untouched rename on %s', async (event) => {
  const { field, header, deal } = await fixture(raw);
  expect(header().kept).toEqual({ text: raw, base: original });
  expect(field.kept?.text).toBe(raw);
  await field.submit(event);
  expect(deal().name).toBe(stored);
  expect(field.kept).toBeUndefined();
  expect(field.editing).toBe(false);
});

it('drops fresh typing on Escape and closes a same-name save without a command', async () => {
  const { field, deal } = await fixture();
  const dispatch = vi.spyOn(app.store, 'dispatch');
  field.typed(raw);
  field.escape();
  expect(field.kept).toBeUndefined();
  field.open();
  field.typed('  Project Recovery fixture  ');
  await field.submit('enter');
  expect(field.kept).toBeUndefined();
  expect(field.editing).toBe(false);
  expect(deal().name).toBe(original);
  expect(dispatch).not.toHaveBeenCalled();
});

it('warns on blank Enter and discards the blank only on blur', async () => {
  const { field, deal } = await fixture(raw);
  field.typed('  ');
  await field.submit('enter');
  expect(app.store.get().ui.toasts.at(-1)?.text).toBe('A deal needs a name');
  expect(field.editing).toBe(true);
  expect(field.kept?.text).toBe('  ');
  await field.submit('blur');
  expect(field.editing).toBe(false);
  expect(field.kept).toBeUndefined();
  expect(deal().name).toBe(original);
});

it('keeps the exact refused spelling on Escape after more typing', async () => {
  const { field } = await fixture();
  const long = '  ' + 'Solar  Wind '.repeat(13);
  field.typed(long);
  await field.submit('blur');
  expect(field.editing).toBe(true);
  expect(field.kept?.text).toBe(long);
  expect(app.store.get().ui.toasts.at(-1)?.text).toContain('Keep the name under');
  field.typed('Temporary edit');
  field.escape();
  expect(field.kept?.text).toBe(long);
});

it('sign-out closes the box and a later sign-in waits for an explicit save', async () => {
  const { field, deal } = await fixture();
  const lock = vi.spyOn(app.store, 'readOnly').mockReturnValue('Sign in to Intelligence to make changes');
  field.typed(raw);
  await field.submit('enter');
  expect(field.editing).toBe(false);
  expect(field.kept?.text).toBe(raw);
  expect(app.store.get().ui.toasts.at(-1)?.text).toBe('Sign in to Intelligence to make changes');
  lock.mockRestore();
  expect(deal().name).toBe(original);
  field.open();
  await field.submit('blur');
  expect(deal().name).toBe(stored);
});

it('asks before overwriting a peer rename and uses the current name only on Keep Mine', async () => {
  const { field, deal, id } = await fixture();
  field.typed(raw);
  app.repo.peer.change('deal', id, { ...deal(), name: 'Project West' }, ELSEWHERE);
  await app.repo.sync();
  await field.submit('enter');
  expect(field.changedElsewhere).toBe(true);
  expect(deal().name).toBe('Project West');
  field.escape();
  expect(field.kept?.text).toBe(raw);
  field.open();
  await field.submit('blur');
  await field.submit('mine');
  expect(deal().name).toBe(stored);
  expect(field.kept).toBeUndefined();
});

it('submits the untouched name from the box if a peer renamed the deal while it was open', async () => {
  const { field, deal, id } = await fixture();
  app.repo.peer.change('deal', id, { ...deal(), name: 'Project Western Wind' }, ELSEWHERE);
  await app.repo.sync();
  await vi.waitFor(() => expect(deal().name).toBe('Project Western Wind'));
  await field.submit('enter');
  expect(field.editing).toBe(true);
  expect(field.changedElsewhere).toBe(true);
  expect(field.kept?.text).toBe(original);
  field.takeTheirs();
  expect(deal().name).toBe('Project Western Wind');
  expect(field.kept).toBeUndefined();
});

it('holds a two-version deal rename for a choice among 104 unrelated question conflicts', async () => {
  const { field, deal, id } = await fixture();
  const rows = portfolioQuestions().slice(0, 104).map((text, index) => ({
    n: index + 1, text, askedBy: 'Counsel', received: '2026-11-01', workstream: 'Financing', priority: 'High',
    response: '', respondedBy: '', responded: '', status: '',
  } as const));
  expect((await app.store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows })).ok).toBe(true);
  for (const question of Object.values(app.store.get().questions)) {
    const peer = { ...question, response: 'See the updated credit agreement.' };
    app.repo.peer.edit('question', question.id, peer, ELSEWHERE);
  }
  app.repo.peer.edit('deal', id, { ...deal(), counterparty: 'Western Infrastructure' }, ELSEWHERE);
  await app.repo.sync();
  await vi.waitFor(() => expect(Object.keys(app.store.get().conflicts)).toHaveLength(105));
  field.typed(raw);
  await field.submit('enter');
  expect(field.changedElsewhere).toBe(true);
  expect(field.kept?.text).toBe(raw);
  await field.submit('mine');
  expect(field.changedElsewhere).toBe(true);
  field.takeTheirs();
  expect(field.editing).toBe(false);
  expect(field.kept).toBeUndefined();
  expect(deal().name).toBe(original);
  expect(Object.keys(app.store.get().conflicts)).toHaveLength(105);
});

it('keeps newer typing when the original deal disappears before a saved rename settles', async () => {
  const { field, id, deal } = await fixture();
  const gate = holdRecoveryWrite(app, settlesRename);
  field.typed(raw);
  const saving = field.submit('enter');
  await gate.entered;
  field.typed('Newer name while waiting');
  field.dispose();
  app.repo.peer.deleteDeal(id, ELSEWHERE);
  await app.repo.sync();
  await vi.waitFor(() => expect(deal()).toBeUndefined());
  gate.release();
  await saving;
  expect(field.kept?.text).toBe('Newer name while waiting');
});

it('keeps a name typed while its save is in flight, in the same box and after the page reopens', async () => {
  const { field, header, deal } = await fixture();
  const gate = holdRecoveryWrite(app, writesDeal);
  field.typed(raw);
  const saving = field.submit('enter');
  await gate.entered;
  field.typed('North  Ridge');
  gate.release();
  await saving;
  expect(deal().name).toBe(stored);
  expect(field.editing).toBe(true);
  expect(field.text).toBe('North  Ridge');
  field.dispose();
  const reopened = header();
  expect(reopened.kept?.text).toBe('North  Ridge');
  reopened.open();
  expect(reopened.text).toBe('North  Ridge');
});

it('asks for a choice when a rename meets any conflict, not only a changed name', async () => {
  const { field } = await fixture();
  const conflict = { kind: 'conflict', message: 'This record has two versions. Choose one.' } as const;
  vi.spyOn(app.store, 'dispatch').mockResolvedValue({ ok: false, error: conflict } as never);
  field.typed(raw);
  await field.submit('enter');
  expect(field.changedElsewhere).toBe(true);
  expect(field.kept?.text).toBe(raw);
});

it('still says why a rename failed after Escape closed the box during its save', async () => {
  const { field } = await fixture();
  failRecoveryWrite(app, writesDeal, 'The shared folder is unavailable');
  const gate = holdRecoveryWrite(app, writesDeal);
  field.typed(raw);
  const saving = field.submit('enter');
  await gate.entered;
  field.escape();
  gate.release();
  await saving;
  expect(field.editing).toBe(false);
  expect(field.kept?.text).toBe(raw);
  expect(app.store.get().ui.toasts.at(-1)?.text).toBe('The shared folder is unavailable');
});

it.each(['same box', 'restarted app'] as const)('saves typing kept through a save over it in the %s', async (when) => {
  const { field, deal, id, saveKeptDrafts, start } = await fixture();
  const gate = holdRecoveryWrite(app, writesDeal);
  field.typed(raw);
  const saving = field.submit('enter');
  await gate.entered;
  field.typed('North  Ridge');
  gate.release();
  await saving;
  let target = field;
  if (when === 'restarted app') {
    saveKeptDrafts();
    app.store.closing();
    await app.repo.close();
    app = recoveryApp(app.saved, [EditDeal]);
    await app.store.boot();
    await app.store.loadDeal(id, { gaps: false });
    target = (await start()).header();
    target.open();
  }
  await target.submit('enter');
  expect(target.changedElsewhere).toBe(false);
  expect(deal().name).toBe('Project North  Ridge');
  expect(target.kept).toBeUndefined();
});

it('saves newer typing when the box is left while an earlier save is out', async () => {
  const { field, deal } = await fixture();
  const gate = holdRecoveryWrite(app, writesDeal);
  field.typed(raw);
  const saving = field.submit('enter');
  await gate.entered;
  field.typed('North  Ridge');
  const left = field.submit('blur');
  gate.release();
  await Promise.all([saving, left]);
  await vi.waitFor(() => expect(deal().name).toBe('Project North  Ridge'));
  expect(field.editing).toBe(false);
  expect(field.kept).toBeUndefined();
});
