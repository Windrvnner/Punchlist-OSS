// The checklist item a finding or a question names (#2; linking design, section 6): by its id, from the deal's item
// records or its check's rows, and for a finding that does not name it, the item whose check line names the finding.
import { describe, it, expect } from 'vitest';
import { initialState, findingItem, namedItem, type State } from '../../src/app/state';
import type { Item } from '../../src/domain/checklist';
import type { Finding } from '../../src/domain/model';
import type { ChecklistRow } from '../../src/ports';

const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const OTHER = 'd_01HYYYYYYYYYYYYYYYYYYYYYYY';
const F = 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const LOCKUP = 'Lock-up ratio matches the term sheet';
const finding = (patch: Partial<Finding> = {}) =>
  ({ id: F, dealId: D, title: 'Lock-up ratio differs', ...patch }) as Finding;
const row = (id: string, text: string, patch: Partial<ChecklistRow> = {}): ChecklistRow =>
  ({ id, text, result: 'satisfied', docs: [], ...patch });
const item = (id: string, text: string, patch: Partial<Item> = {}) =>
  ({ id, dealId: D, text, off: false, ...patch }) as Item;
/** a deal's check over 2,000 items, as a firm's list gives, with the lock-up item near the end */
const rows = (lockup: Partial<ChecklistRow> = {}): ChecklistRow[] => [
  ...Array.from({ length: 1999 }, (_, k) => row(`i${k}`, `Condition precedent ${k + 1} is satisfied`)),
  row('i_lockup', LOCKUP, lockup),
];
const state = (patch: Partial<State> = {}): State => ({ ...initialState(), ...patch });

describe('namedItem', () => {
  it('reads the item record of the deal, and says whether it is turned off', () => {
    const s = state({ items: { i_lockup: item('i_lockup', LOCKUP, { off: true }) } });
    expect(namedItem(s, D, 'i_lockup')).toEqual({ id: 'i_lockup', text: LOCKUP, off: true });
  });
  it('reads the check\'s rows for a deal with no item records', () => {
    const s = state({ checklists: { [D]: rows() } });
    expect(namedItem(s, D, 'i_lockup')).toEqual({ id: 'i_lockup', text: LOCKUP, off: false });
  });
  it('names nothing for an item of another deal, one no longer here, or rows not read yet or failed', () => {
    const s = state({ items: { i_lockup: item('i_lockup', LOCKUP, { dealId: OTHER }) } });
    expect(namedItem(s, D, 'i_lockup')).toBeNull();
    expect(namedItem(state({ checklists: { [D]: rows() } }), D, 'i_gone')).toBeNull();
    expect(namedItem(state(), D, 'i_lockup')).toBeNull();
    expect(namedItem(state({ checklists: { [D]: 'failed' } }), D, 'i_lockup')).toBeNull();
  });
});

describe('findingItem', () => {
  it('is the item the finding names', () => {
    const s = state({ checklists: { [D]: rows() } });
    expect(findingItem(s, finding({ itemId: 'i_lockup' }))?.text).toBe(LOCKUP);
  });
  it('is the item whose check line names the finding, when the finding names none', () => {
    const s = state({ checklists: { [D]: rows({ result: 'finding', findingId: F }) } });
    expect(findingItem(s, finding())?.id).toBe('i_lockup');
  });
  it('is nothing when the item it names is no longer on the checklist, even if a line names the finding', () => {
    const s = state({ checklists: { [D]: rows({ result: 'finding', findingId: F }) } });
    expect(findingItem(s, finding({ itemId: 'i_reworded' }))).toBeNull();
  });
  it('is nothing for a finding no check raised', () => {
    expect(findingItem(state({ checklists: { [D]: rows() } }), finding())).toBeNull();
  });
});
