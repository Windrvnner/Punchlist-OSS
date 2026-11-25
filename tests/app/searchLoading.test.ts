// @vitest-environment node
import { expect, it } from 'vitest';
import { ownDealsLoading } from '../../src/app/search';
import { initialState } from '../../src/app/state';
import { derivedId } from '../../src/domain/derivedId';
import { firstMember } from '../../src/domain/model';
import { scaleMemoInput } from '../fixtures/memoScale';
import { PORTFOLIO_ASSETS } from '../fixtures/portfolioQuestions';

it('waits for just the deals in My Deals that are unvisited or loading', () => {
  const state = initialState();
  const { deal } = scaleMemoInput;
  const deals = PORTFOLIO_ASSETS.map((asset) => ({
    ...deal, id: derivedId('d', [asset]), name: `Project ${asset}`,
  }));
  state.deals = Object.fromEntries(deals.map((entry) => [entry.id, entry]));
  const [loading, unvisited, loaded, failed, removed, teammate] = deals;
  const user = { name: 'Reviewer', initials: 'R' };
  for (const { id } of [loading, unvisited, loaded, failed, removed]) {
    const member = firstMember(id, user.name, deal.createdAt);
    state.members[member.id] = { ...member, on: id !== removed.id };
  }
  const other = firstMember(teammate.id, 'Colleague', deal.createdAt);
  state.members[other.id] = other;
  state.dealLoad = {
    [loading.id]: 'loading', [loaded.id]: 'loaded', [failed.id]: 'failed',
    [removed.id]: 'loading', [teammate.id]: 'loading',
  };
  expect(ownDealsLoading(state)).toBe(false);

  state.user = user;
  expect(ownDealsLoading(state)).toBe(true);
  state.dealLoad[loading.id] = 'loaded';
  expect(ownDealsLoading(state)).toBe(true);
  state.dealLoad[unvisited.id] = 'loading';
  expect(ownDealsLoading(state)).toBe(true);
  state.dealLoad[unvisited.id] = 'failed';
  expect(ownDealsLoading(state)).toBe(false);
  delete state.deals[unvisited.id];
  state.dealLoad[unvisited.id] = 'loading';
  expect(ownDealsLoading(state)).toBe(false);
});
