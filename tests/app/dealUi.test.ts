// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { checkedOffer } from '../../src/app/answerOffer';
import { ask } from '../../src/app/conversations';
import { allHits, loadAllForSearch } from '../../src/app/search';
import { dealUiOnRouteChange, initialState, myDeals, pickNames } from '../../src/app/state';
import { Item, itemId } from '../../src/domain/checklist';
import { firstMember } from '../../src/domain/model';
import { derivedId } from '../../src/domain/derivedId';
import { PORTFOLIO_ASSETS } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal } from './recoveryKit';

it('retains same-deal filters and clears them across a deal boundary with explicit navigation applied last', () => {
  const dealId = 'd_first';
  const here = { name: 'checklist', dealId } as const;
  const home = { name: 'home' } as const;
  expect(dealUiOnRouteChange(here, { name: 'question', dealId, questionId: 'q_here' })).toEqual({});
  expect(dealUiOnRouteChange(home, { name: 'chat' })).toEqual({});
  const defaults = { qaFilter: { status: 'open', workstream: '', text: '' }, checklistFilter: 'all',
    findingFilter: { status: 'open', workstream: '', reviewed: '' }, selectedQuestion: null, selectedChecklist: null };
  expect(initialState().ui).toMatchObject(defaults);
  for (const route of [home, { name: 'chat', dealId: 'd_next' }] as const) {
    expect(dealUiOnRouteChange(here, route)).toEqual(defaults);
  }
  expect(dealUiOnRouteChange(home, here, { selectedChecklist: 'item', checklistFilter: 'gap' }))
    .toMatchObject({ selectedChecklist: 'item', checklistFilter: 'gap', selectedQuestion: null });
});

it('sorts pick names naturally and matches the trimmed query without changing the names or accents', () => {
  const names = ['Phase 10', ' Résumé ', 'Phase 2', 'Résumé'].map((name, n) => ({ name, n }));
  expect(pickNames(names, '  PHASE ').map((x) => x.n)).toEqual([2, 0]);
  expect(pickNames(names, 'resume')).toEqual([]);
  expect(pickNames(names, 'résumé').map((x) => x.name)).toEqual([' Résumé ', 'Résumé']);
  expect(names[0].name).toBe('Phase 10');
});

it('settles off only on a mounted checklist after listeners see the triggering state', async () => {
  const app = recoveryApp();
  const { store } = app;
  try {
    const dealId = await recoveryDeal(app);
    const route = { name: 'checklist', dealId } as const;
    const turns: string[] = [];
    store.subscribe((state) => turns.push(state.ui.checklistFilter));
    store.ui({ route: { ...route, dealId: 'missing' }, checklistFilter: 'off' });
    await Promise.resolve();
    expect(store.get().ui.checklistFilter).toBe('off');
    store.ui({ route });
    store.ui({ route: { name: 'qa', dealId } });
    await Promise.resolve();
    expect(store.get().ui.checklistFilter).toBe('off');
    store.ui({ route });
    store.ui({ checklistFilter: 'gap', selectedChecklist: 'explicit' });
    await Promise.resolve();
    expect(store.get().ui).toMatchObject({ checklistFilter: 'gap', selectedChecklist: 'explicit' });
    const text = 'Confirm lender consent to the transfer of the project company.';
    const id = itemId(dealId, text);
    const deal = store.get().deals[dealId];
    store.get().items[id] = Item.parse({ id, dealId, text, off: true, rev: 1,
      createdAt: deal.createdAt, updatedAt: deal.updatedAt });
    store.ui({ checklistFilter: 'off' });
    await Promise.resolve();
    expect(store.get().ui.checklistFilter).toBe('off');
    store.get().items = {};
    for (const checked of [undefined, 'failed'] as const) {
      if (checked) store.get().checklists[dealId] = checked;
      else delete store.get().checklists[dealId];
      turns.length = 0;
      store.ui({ checklistFilter: 'off' });
      expect(turns).toEqual(['off']);
      await Promise.resolve();
      expect(turns).toEqual(['off', 'all']);
    }
  } finally {
    store.closing();
    await app.repo.close();
  }
});

it('uses the same twenty owned deals for search, loading and answers across a forty-deal portfolio', async () => {
  const app = recoveryApp();
  const { store } = app;
  try {
    const base = await recoveryDeal(app);
    const state = store.get();
    const deal = state.deals[base];
    state.deals = {};
    state.members = {};
    const portfolios = ['Acquisition', 'Refinancing', 'Expansion', 'Construction'];
    const expected: string[] = [];
    for (const [index, name] of PORTFOLIO_ASSETS.slice(0, 10).flatMap((asset) =>
      portfolios.map((phase) => `Portfolio ${asset} ${phase}`)).entries()) {
      const id = derivedId('d', [name]);
      state.deals[id] = { ...deal, id, name };
      const member = firstMember(id, index % 2 ? 'Another reviewer' : state.user!.name, deal.createdAt);
      state.members[member.id] = member;
      if (index % 2 === 0) expected.push(id);
    }
    expect(Object.keys(state.deals)).toHaveLength(40);
    expect(myDeals(state).map((entry) => entry.id)).toEqual(expected);
    expect(new Set(allHits(state, 'Portfolio').filter((hit) => hit.kind === 'deal').map((hit) => hit.key)))
      .toEqual(new Set(expected));
    const load = vi.spyOn(store, 'loadDeal').mockResolvedValue(undefined);
    vi.spyOn(store, 'refreshChecklist').mockResolvedValue(undefined);
    await loadAllForSearch(store);
    expect(load.mock.calls.map(([id]) => id)).toEqual(expected);
    const answer = vi.spyOn(store.services.ai, 'answer')
      .mockResolvedValue({ ok: true, value: { text: 'No gaps.', sources: [] } });
    await ask(store, { kind: 'all' }, 'Which agreements lack lender consent?');
    expect(answer.mock.calls[0][0].dealIds).toEqual(expected);
    for (const entry of Object.values(state.deals)) {
      const offer = checkedOffer(state, { kind: 'all' }, { action: 'open page', page: 'qa', deal: entry.name });
      expect(offer?.kind === 'page' && offer.dealId).toBe(expected.includes(entry.id) ? entry.id : false);
    }
  } finally {
    store.closing();
    await app.repo.close();
  }
});
