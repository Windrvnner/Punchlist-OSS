// @vitest-environment node
import { expect, it } from 'vitest';
import { checklistQuestionTarget } from '../../src/app/checklistQuestion';
import { initialState } from '../../src/app/state';
import { derivedId } from '../../src/domain/derivedId';
import type { ChecklistRow } from '../../src/ports';
import { scaleMemoInput } from '../fixtures/memoScale';

const [ratio, period] = scaleMemoInput.findings.filter((f) => /lock-up ratio|distribution test/i.test(f.title));
const row: ChecklistRow = {
  id: 'distribution-test', text: 'Distribution covenants match the term sheet',
  result: 'finding', findingId: period.id, docs: [],
};

function checkedPortfolio() {
  const state = initialState();
  const regions = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'];
  const sites = ['Valley', 'Ridge', 'Plateau', 'Foothills', 'Lake', 'River', 'Plains'];
  for (const region of regions) {
    for (const site of sites) {
      for (const finding of scaleMemoInput.findings) {
        const id = derivedId('f', [region, site, finding.id]);
        state.findings[id] = { ...finding, id, title: `${region} ${site}: ${finding.title}` };
      }
    }
  }
  for (const finding of [ratio, period]) state.findings[finding.id] = { ...finding, itemId: row.id };
  return state;
}

it('uses the original finding after a recheck or turn-off, including when it is closed, deleted and restored', () => {
  const state = checkedPortfolio();
  expect(Object.keys(state.findings).length).toBeGreaterThan(2000);
  const original = state.findings[ratio.id];
  const offRow: ChecklistRow = { ...row, result: 'unchecked', findingId: undefined };
  const card = (off: boolean) => checklistQuestionTarget(state, off ? offRow : row, off, original.id);
  const links = { linkedItem: row.id, linkedFinding: original.id, workstream: original.workstream };
  expect(card(false)).toMatchObject({ title: original.title, why: null, links });
  state.findings[original.id] = { ...original, status: 'closed' };
  expect(card(true)).toMatchObject({ title: original.title, why: 'Its finding is closed', links });
  delete state.findings[original.id];
  state.tombstones[original.id] = {
    id: original.id, kind: 'finding', dealId: original.dealId, title: original.title,
    at: original.updatedAt, actor: 'reviewer', snapshot: original,
  };
  expect(card(true)).toMatchObject({ title: original.title, why: 'Its finding is no longer here' });
  state.findings[original.id] = original;
  expect(card(true)).toMatchObject({ title: original.title, why: null, links });
  expect(checklistQuestionTarget(state, row, false, period.id).links.linkedFinding).toBe(period.id);
});

it('keeps an item-only draft on the gap even if a check raises a finding meanwhile', () => {
  const state = checkedPortfolio();
  const gap = { ...row, result: 'gap' as const, findingId: undefined };
  expect(checklistQuestionTarget(state, gap, false)).toMatchObject({ title: row.text, why: null });
  expect(checklistQuestionTarget(state, gap, true).why).toBe('This item is turned off');
  expect(checklistQuestionTarget(state, row, false)).toMatchObject({
    title: row.text, why: 'This item no longer needs a question', links: { linkedFinding: undefined },
  });
});
