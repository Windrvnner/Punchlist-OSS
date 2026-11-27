// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { EditDeal } from '../../src/app/commands/deals';
import { KEPT_TEXT_KEY } from '../../src/ports';
import { recoveryApp, recoveryDeal, type RecoveryApp } from './recoveryKit';

const original = 'Project Recovery fixture';
const raw = '  Café  Cafe\u0301 Solar  ';
const stored = 'Project Café  Cafe\u0301 Solar';
let app: RecoveryApp;

afterEach(async () => {
  app.store.closing();
  await app.repo.close();
});

async function fixture(legacy?: string, current?: string) {
  app = recoveryApp(undefined, [EditDeal]);
  const id = await recoveryDeal(app);
  const local = new MemoryLocal();
  if (legacy !== undefined) local.write(KEPT_TEXT_KEY, {
    'deal-name': [[id, { text: legacy, base: original }]],
    'edit-field': current === undefined ? [] : [[`deal-name:${id}`, { text: current, base: original, rev: 1 }]],
  });
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

it('hands off a legacy draft and restores its exact text on Escape and restart', async () => {
  const { field, saveKeptDrafts, start, local, id } = await fixture(raw);
  expect(field.text).toBe(raw);
  field.typed('Replacement');
  field.escape();
  expect(field.editing).toBe(false);
  saveKeptDrafts();
  expect(local.read(KEPT_TEXT_KEY)).toEqual({
    'edit-field': [[`deal-name:${id}`, { text: raw, base: original, rev: 1 }]],
  });
  const restarted = (await start()).header();
  restarted.open();
  expect(restarted.text).toBe(raw);
  expect(restarted.kept?.base).toBe(original);
});

it('preserves both drafts when a different rename already occupies the migration destination', async () => {
  const { field, id, local, saveKeptDrafts } = await fixture(raw, 'Project Granite');
  expect(field.text).toBe('Project Granite');
  saveKeptDrafts();
  expect(local.read(KEPT_TEXT_KEY)).toEqual({
    'deal-name': [[id, { text: raw, base: original }]],
    'edit-field': [[`deal-name:${id}`, { text: 'Project Granite', base: original, rev: 1 }]],
  });
});

it('retires a duplicate legacy copy after its matching draft saves', async () => {
  const { field, saveKeptDrafts, start } = await fixture(raw, raw);
  await field.submit('enter');
  saveKeptDrafts();
  expect((await start()).header().kept).toBeUndefined();
});

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
  const { field, deal } = await fixture(raw);
  expect(field.kept?.text).toBe(raw);
  await field.submit(event);
  expect(deal().name).toBe(stored);
  expect(field.kept).toBeUndefined();
  expect(field.editing).toBe(false);
});
