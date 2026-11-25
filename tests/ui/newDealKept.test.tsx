// @vitest-environment jsdom
// The New deal form kept across a restart (#55), with folders still being read (#113).
import { restartKeptText } from './keptTextSession';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'dil/1/kept-drafts';
const load = async () => {
  await restartKeptText();
  return import('../../src/app/newDealDraft');
};
const folder = (n: number) => ({ path: `D:\\Deals\\Room ${n}`, label: `Room ${n}`, files: 100 + n, size: '0.3 GB' });
const DRAFT = {
  name: 'Buyer diligence', counterparty: 'Acme', kinds: { product: 'Acquisition' },
  folders: [folder(1), folder(2), folder(3)], path: 'D:\\Deals\\Typed', reading: ['D:\\Deals\\Chosen'],
};
beforeEach(() => { localStorage.clear(); });

describe('the kept New deal form', () => {
  it('comes back after a restart as it was left', async () => {
    let k = await load();
    k.keepNewDeal(DRAFT);
    window.dispatchEvent(new Event('pagehide'));
    k = await load();
    expect(k.keptNewDeal()).toEqual(DRAFT);
  });

  it('reads the prior raw key and flushes the same shape when the window is hidden', async () => {
    localStorage.setItem(KEY, JSON.stringify({ 'new-deal': [['new', DRAFT]] }));
    const k = await load();
    expect(k.keptNewDeal()).toEqual(DRAFT);

    const updated = { ...DRAFT, name: 'Lender diligence' };
    k.keepNewDeal(updated);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ 'new-deal': [['new', updated]] });
    } finally {
      hidden.mockRestore();
    }
  });

  it('is forgotten once the deal is made', async () => {
    let k = await load();
    k.keepNewDeal(DRAFT);
    k.keepNewDeal(null);
    window.dispatchEvent(new Event('pagehide'));
    k = await load();
    expect(k.keptNewDeal()).toBe(null);
  });

  it('drops a stored form of another shape, and the form opens empty', async () => {
    const bad = [
      { ...DRAFT, folders: [{ ...folder(1), files: '3' }] }, { ...DRAFT, name: 7 }, { ...DRAFT, reading: 'x' },
      { ...DRAFT, kinds: { product: 1 } }, { ...DRAFT, path: undefined }, null, 'text',
    ];
    for (const v of bad) {
      localStorage.setItem(KEY, JSON.stringify({ 'new-deal': [['new', v]] }));
      const k = await load();
      expect(k.keptNewDeal()).toBe(null);
    }
  });

  it('says whether a form holds anything typed or chosen', async () => {
    const k = await load();
    const empty = { name: ' ', folders: [], path: '' };
    expect(k.hasNewDealDraft(empty)).toBe(false);
    expect(k.hasNewDealDraft({ ...empty, kinds: { sector: ' ' } })).toBe(false);
    expect(k.hasNewDealDraft({ ...empty, kinds: { sector: 'Energy' } })).toBe(true);
    expect(k.hasNewDealDraft({ ...empty, counterparty: 'Acme' })).toBe(true);
    expect(k.hasNewDealDraft({ ...empty, reading: ['D:\\Deals\\Chosen'] })).toBe(true);
    expect(k.hasNewDealDraft({ ...empty, path: 'D:\\x' })).toBe(true);
    expect(k.hasNewDealDraft({ ...empty, folders: [folder(1)] })).toBe(true);
  });
});
