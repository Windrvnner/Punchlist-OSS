// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { watchCheck } from '../../src/app/checking';
import { initialState, type State } from '../../src/app/state';
import { scaleMemoInput } from '../fixtures/memoScale';

const dealId = scaleMemoInput.deal.id;
const idle = { at: null, offerDeep: null };
const busy = { ...idle, busy: 'quick' } as const;
const shared = { ...idle, checking: { with: [{ who: 'adoe', pc: 'Office PC', same: false }], quiet: [] } };

function checkStore(check = idle) {
  const state = initialState();
  state.deals[dealId] = scaleMemoInput.deal;
  state.checks[dealId] = check;
  let listener: ((state: State) => void) | undefined;
  const refreshChecked = vi.fn(async () => {});
  const store = {
    get: () => state,
    refreshChecked,
    subscribe(update: (state: State) => void) {
      listener = update;
      return () => { listener = undefined; };
    },
  };
  const change = (next: State['checks'][string]) => {
    state.checks[dealId] = next;
    listener?.(state);
  };
  return { store, change, refreshChecked };
}

afterEach(() => vi.useRealTimers());

it('polls every three seconds while busy and stops when the check ends', () => {
  vi.useFakeTimers();
  const { store, change, refreshChecked } = checkStore(busy);
  const stop = watchCheck(store, dealId);
  vi.advanceTimersByTime(2999);
  expect(refreshChecked).not.toHaveBeenCalled();
  vi.advanceTimersByTime(3001);
  expect(refreshChecked.mock.calls).toEqual([[dealId], [dealId]]);
  change(idle);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(9000);
  expect(refreshChecked).toHaveBeenCalledTimes(2);
  stop();
});

it('starts following a shared check and stops following when the page closes', () => {
  vi.useFakeTimers();
  const { store, change, refreshChecked } = checkStore();
  const stop = watchCheck(store, dealId);
  vi.advanceTimersByTime(9000);
  expect(refreshChecked).not.toHaveBeenCalled();
  change(shared);
  vi.advanceTimersByTime(3000);
  expect(refreshChecked).toHaveBeenCalledWith(dealId);
  stop();
  change(idle);
  change(busy);
  vi.advanceTimersByTime(9000);
  expect(refreshChecked).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
