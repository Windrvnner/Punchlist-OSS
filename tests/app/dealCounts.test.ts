// @vitest-environment node
import { expect, it } from 'vitest';
import { checklistView } from '../../src/app/checklistView';
import { checklistStandingCounts } from '../../src/app/dealCounts';
import { initialState } from '../../src/app/state';
import { Item, itemId } from '../../src/domain/checklist';
import { derivedId } from '../../src/domain/derivedId';
import { Finding } from '../../src/domain/model';
import type { ChecklistRow } from '../../src/ports';
import { scaleMemoInput } from '../fixtures/memoScale';
import { ITEMS } from '../fixtures/pastedList';

const { id: dealId, rev, createdAt, updatedAt } = scaleMemoInput.deal;
const record = { dealId, rev, createdAt, updatedAt };
const sites = ['coastal', 'central', 'upland', 'eastern', 'western', 'southern'];
const phases = ['first draw', 'completion', 'term conversion'];
const lastProgress = { items: 2140, findings: 120, gaps: 2, unsettled: 2, satisfied: 2016 };

function checklistDeal() {
  const state = initialState();
  state.deals[dealId] = scaleMemoInput.deal;
  state.dealLoad[dealId] = 'loaded';
  state.progress[dealId] = { folders: [], checklist: lastProgress };
  const rows: ChecklistRow[] = [];
  for (const site of sites) {
    for (const phase of phases) {
      for (const { t, s, sub } of ITEMS) {
        const text = `${site} site, ${phase}: ${t}`;
        const id = itemId(dealId, text);
        state.items[id] = Item.parse({ ...record, id, text, section: s, subsection: sub });
        rows.push({ id, text, result: 'satisfied', docs: [] });
      }
    }
  }
  for (const row of rows.slice(0, 120)) {
    const id = derivedId('f', [dealId, row.id]);
    row.result = 'finding';
    row.findingId = id;
    state.findings[id] = Finding.parse({
      ...record, id, itemId: row.id, raisedAt: createdAt, origin: 'ai', title: `Evidence outstanding: ${row.text}`,
      body: ['The signed supporting document is missing from the closing package.'], sources: [], workstream: 'Legal',
    });
  }
  const gone = state.findings[rows[118].findingId!];
  delete state.findings[gone.id];
  state.tombstones[gone.id] = {
    id: gone.id, title: gone.title, kind: 'finding', dealId, snapshot: gone, at: updatedAt, actor: 'reviewer',
  };
  state.findings[rows[119].findingId!].status = 'closed';
  rows[120].result = 'gap';
  rows[121].result = 'gap';
  rows[122].result = 'unchecked';
  rows[123].result = 'unsettled';
  // The last check predates twenty additions and three items being switched off.
  state.checklists[dealId] = rows.slice(0, 2140);
  for (const row of [rows[0], rows[120], rows[2159]]) state.items[row.id].off = true;
  return state;
}

it('counts the same standings as the Checklist when a check predates additions and items being turned off', () => {
  const state = checklistDeal();
  expect(Object.keys(state.findings)).toHaveLength(119);
  const { counts } = checklistView(state, dealId);
  expect(counts).toEqual({ all: 2160, finding: 117, gone: 1, person: 1, gap: 1, open: 21, satisfied: 2016, off: 3 });
  expect(checklistStandingCounts(state, dealId)).toEqual({ ...counts, toResolve: 119, settled: 2017, offOpen: 1 });
});
