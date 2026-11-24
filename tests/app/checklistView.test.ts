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

it('counts exactly the matching rows for every filter and keeps a selected exception visible', () => {
  const state = checklistDeal();
  const expected = {
    all: [...items, legacy], finding: [flagged], gone: [deleted], gap: [gap, legacy], open: [added, unsettled],
    person: [resolved], satisfied: items.slice(8), off: [stale, offUnseen],
  };
  expect(viewFor(state, 'all').filters).toEqual(Object.keys(expected));
  for (const filter of viewFor(state, 'all').filters) {
    const { counts, shown, on } = viewFor(state, filter);
    expect(on).toBe(filter);
    expect(counts[filter]).toBe(expected[filter].length);
    expect(shown.length).toBe(counts[filter]);
    expect(new Set(shown.map(({ row }) => row.id))).toEqual(new Set(expected[filter].map((item) => item.id)));
  }
  for (const [filter, selected] of [['off', flagged], ['finding', gap], ['gap', stale]] as const) {
    const pinned = viewFor(state, filter, selected.id);
    expect(pinned.shown.map(({ row }) => row.id)).toContain(selected.id);
    expect(pinned.selected?.id).toBe(selected.id);
    expect(pinned.shown.length).toBe(pinned.counts[filter] + 1);
  }
});

it('hides empty optional filters, falls back to All, and keeps the standard filters on an active list', () => {
  const state = checklistDeal();
  state.items = {};
  state.checklists = { [deal.id]: [legacy] };
  const { filters, counts, on } = viewFor(state, 'off');
  expect(filters).toEqual(['all', 'finding', 'gap', 'satisfied']);
  expect(counts).toEqual({ all: 1, finding: 0, gone: 0, gap: 1, open: 0, person: 0, satisfied: 0, off: 0 });
  expect(on).toBe('all');
  state.checklists[deal.id] = [];
  expect(viewFor(state, 'open').filters).toEqual(['all']);
  for (const item of items) state.items[item.id] = { ...item, off: true };
  expect(viewFor(state, 'finding').filters).toEqual(['all', 'off']);
  expect(viewFor(state, 'finding').on).toBe('all');
});

it('puts each list, section and subsection in first-item order and counts its visible rows', () => {
  const state = checklistDeal();
  const product = { layer: 'product', value: 'Construction finance' } as const;
  const sector = { layer: 'sector', value: 'Energy' } as const;
  const technology = { layer: 'technology', value: 'Storage' } as const;
  const onDeal = { layer: 'deal', value: '' } as const;
  state.items[offUnseen.id].from = [sector, { layer: 'broad', value: '' }];
  state.items[added.id].from = [technology, sector];
  state.items[gap.id].from = [onDeal];
  state.items[flagged.id].from = [onDeal, technology];
  for (const [item, section, subsection] of [
    [stale, 'Execution', 'Consents'], [resolved, 'Conditions', ''], [deleted, 'Execution', 'Waivers'],
    [unsettled, 'Execution', 'Consents'],
  ] as const) {
    Object.assign(state.items[item.id], { from: [sector, product], section, subsection });
  }
  const { shown } = viewFor(state, 'all');
  const lists = shown.flatMap(({ heads }) => heads.filter((head) => head.level === 'list').map((head) => head.text));
  expect(lists).toEqual(['Construction finance', 'General', 'Energy', 'Added on This Deal', 'Storage', 'Other']);
  expect(shown.slice(0, 4).map(({ row }) => row.id)).toEqual([stale.id, unsettled.id, deleted.id, resolved.id]);
  const names = (heads: typeof shown[number]['groups']) => heads.map(({ text, count }) => [text, count]);
  expect(shown.slice(0, 4).map(({ heads }) => names(heads))).toEqual([
    [['Construction finance', 4], ['Execution', 3], ['Consents', 2]], [], [['Waivers', 1]], [['Conditions', 1]],
  ]);
  expect(names(shown[1].groups)).toEqual(names(shown[0].heads));
  expect(shown.at(-1)?.row).toBe(legacy);
  const filtered = viewFor(state, 'off', deleted.id);
  expect(names(filtered.shown[0].heads)).toEqual([['Construction finance', 2], ['Execution', 2], ['Consents', 1]]);
});

it('groups a checklist without item records by standing, keeping check order within each standing', () => {
  const state = checklistDeal();
  state.items = {};
  const { shown } = viewFor(state, 'all');
  const heads = shown.flatMap((entry) => entry.heads);
  expect(heads.map(({ text }) => text)).toEqual(['finding', 'gone', 'gap', 'open', 'person', 'satisfied']);
  expect(heads.map(({ count }) => count)).toEqual([2, 1, 2, 1, 1, items.length - 8]);
  expect(shown.slice(0, 5).map(({ row }) => row.id)).toEqual([flagged.id, stale.id, deleted.id, legacy.id, gap.id]);
  expect(viewFor(state, 'gap').shown.map(({ groups }) => groups)).toEqual([[], []]);
});
