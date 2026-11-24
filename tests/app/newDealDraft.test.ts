// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { PORTFOLIO_ASSETS } from '../fixtures/portfolioQuestions';

const dataRoom = 'D:/Transactions/Renewable Portfolio/';
const folders = PORTFOLIO_ASSETS.map((label, index) => ({
  path: dataRoom + label,
  label,
  files: 195 + index,
  size: '1.2 GB',
}));
const form = {
  name: 'Renewable portfolio buyout',
  counterparty: 'Northwind Infrastructure',
  kinds: { sector: 'Energy' },
  folders,
};
const empty = { name: '', folders: [] };

async function restart(local: MemoryLocal) {
  vi.resetModules();
  const kept = await import('../../src/app/keptText');
  kept.initializeKeptText(local);
  return { ...await import('../../src/app/newDealDraft'), save: kept.saveKeptDrafts };
}

describe('a New deal draft outside the window', () => {
  it('retains a late read and the remaining selection across a restart', async () => {
    const local = new MemoryLocal();
    const { NewDealDraftSession, keptNewDeal, save } = await restart(local);
    const session = new NewDealDraftSession(true, () => {});
    session.open(empty);
    const insurance = {
      path: dataRoom + 'Insurance and Claims',
      label: 'Insurance and Claims',
      files: 118,
      size: '0.4 GB',
    };
    const permits = dataRoom + 'Environmental Permits';
    let finishRead!: (folder: typeof insurance) => void;
    const deferred = new Promise<typeof insurance>((resolve) => { finishRead = resolve; });
    const read = vi.fn(async (path: string) => {
      session.started(path);
      expect(session.finished(path, await deferred)).toBe(false);
    });
    const reading = session.readEach([insurance.path, permits], read);
    session.keep(form, 'D:/Transactions/Lender Consent');
    session.close();
    finishRead(insurance);
    await reading;
    expect(read.mock.calls).toEqual([[insurance.path]]);
    expect(keptNewDeal()).toEqual({
      ...form,
      folders: [...folders, insurance],
      path: 'D:/Transactions/Lender Consent',
      reading: [permits],
    });
    save();

    const resumed = await restart(local);
    const reopened = new resumed.NewDealDraftSession(true, () => {});
    expect(reopened.open(empty)).toEqual({
      fields: { ...form, folders: [...folders, insurance] },
      path: 'D:/Transactions/Lender Consent',
      reading: [permits],
    });
    reopened.close();
  });

  it('lets a reopened form reread a pending folder without the old result claiming it', async () => {
    const { NewDealDraftSession, keptNewDeal, save } = await restart(new MemoryLocal());
    const first = new NewDealDraftSession(true, () => {});
    const reopened = new NewDealDraftSession(true, () => {});
    const path = dataRoom + 'Financing Agreements';
    first.open(empty);
    first.started(path);
    first.keep(form, path.toUpperCase());
    first.close();

    expect(reopened.open(empty)).toEqual({ fields: form, path: '', reading: [path] });
    const outdated = { path, label: 'Financing Agreements', files: 20, size: '0.1 GB' };
    expect(first.finished(path, outdated)).toBe(false);
    expect(keptNewDeal()).toEqual({ ...form, path: path.toUpperCase(), reading: [path] });
    reopened.close();
    save();
  });
});
