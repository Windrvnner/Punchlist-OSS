// @vitest-environment node
import { expect, it } from 'vitest';
import { checklistFindings, checklistView } from '../../src/app/checklistView';
import { initialState, type State } from '../../src/app/state';
import { itemId, type Item } from '../../src/domain/checklist';
import type { ChecklistRow } from '../../src/ports';
import { scaleMemoInput } from '../fixtures/memoScale';
import { ITEMS } from '../fixtures/pastedList';

const deal = scaleMemoInput.deal;
const otherDeal = 'd_01HYYYYYYYYYYYYYYYYYYYYYYY';
const sites = ['north site', 'south site', 'east site', 'west site', 'central site', 'coastal site'];
const facilities = ['solar array', 'battery yard', 'substation'];
const items = sites.flatMap((site) => facilities.flatMap((facility) => ITEMS.map(({ t, s, sub }): Item => {
  const text = `${site}, ${facility}: ${t}`;
  return {
    id: itemId(deal.id, text), dealId: deal.id, text, section: s, subsection: sub, from: [{ layer: 'broad', value: '' }],
    createdAt: deal.createdAt, updatedAt: deal.updatedAt, rev: 1, normV: 1, off: false,
  };
})));
const [stale, offUnseen, added, gap, flagged, resolved, deleted, unsettled] = items;
const [openFinding, closedFinding, goneFinding] = scaleMemoInput.findings;
const legacy: ChecklistRow = {
  id: 'legacy', text: 'Executed intercreditor agreement and all amendments', result: 'gap', docs: [],
};

function checkedRow(item: Item): ChecklistRow {
  const row: ChecklistRow = { id: item.id, text: item.text, result: 'satisfied', docs: [] };
  if (item === stale || item === flagged) return { ...row, result: 'finding', findingId: openFinding.id };
  if (item === resolved) return { ...row, result: 'finding', findingId: closedFinding.id };
  if (item === deleted) return { ...row, result: 'finding', findingId: goneFinding.id };
  if (item === gap) return { ...row, result: 'gap', need: 'Signed agreement' };
  if (item === unsettled) return { ...row, result: 'unsettled' };
  return row;
}

function checklistDeal() {
  const state = initialState();
  state.deals[deal.id] = deal;
  state.dealLoad[deal.id] = 'loaded';
  for (const item of items) state.items[item.id] = { ...item, off: item === stale || item === offUnseen };
  const foreign = { ...added, id: itemId(otherDeal, added.text), dealId: otherDeal, off: true };
  state.items[foreign.id] = foreign;
  const checked = items.filter((item) => item !== offUnseen && item !== added).map(checkedRow);
  state.checklists = { [deal.id]: [legacy, ...checked.reverse()], [otherDeal]: [checkedRow(foreign)] };
  state.findings[openFinding.id] = { ...openFinding, itemId: flagged.id, status: 'open' };
  state.findings[closedFinding.id] = { ...closedFinding, itemId: resolved.id, status: 'closed' };
  state.tombstones[goneFinding.id] = {
    id: goneFinding.id, title: goneFinding.title, snapshot: goneFinding, at: deal.updatedAt,
    actor: 'reviewer', dealId: deal.id, kind: 'finding',
  };
  return state;
}

type Filter = State['ui']['checklistFilter'];
function viewFor(state: State, checklistFilter: Filter, selectedChecklist: string | null = null) {
  return checklistView({ ...state, ui: { ...state.ui, checklistFilter, selectedChecklist } }, deal.id);
}

it('replaces stale results for off items and lists newly added items after the check is read', () => {
  const state = checklistDeal();
  const { shown, counts, offIds } = viewFor(state, 'all');
  expect(items.length).toBeGreaterThan(2000);
  expect(counts.all).toBe(items.length + 1);
  expect(new Set(shown.map(({ row }) => row.id))).toEqual(new Set([...items.map((item) => item.id), legacy.id]));
  expect(offIds).toEqual(new Set([stale.id, offUnseen.id]));
  for (const item of [stale, offUnseen, added]) {
    expect(shown.find(({ row }) => row.id === item.id)?.row)
      .toEqual({ id: item.id, text: item.text, result: 'unchecked', docs: [] });
  }
  expect(shown.find(({ row }) => row.id === gap.id)?.row).toEqual(checkedRow(gap));
  for (const checklists of [{}, { [deal.id]: 'failed' as const }]) {
    const waiting = viewFor({ ...state, checklists }, 'all');
    expect(waiting.shown.map(({ row }) => row.id)).toEqual([stale.id, offUnseen.id]);
    expect(waiting.filters).toEqual(['all', 'off']);
  }
});
