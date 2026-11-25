// @vitest-environment node
import { expect, it } from 'vitest';
import { qaPageView } from '../../src/app/qaView';
import { initialState, NO_WORKSTREAM } from '../../src/app/state';
import {
  findingExportView, findingFilterFromPage, qaExportView, qaFilterFromPage, questionRowsFor,
} from '../../src/app/transfer';
import { derivedId } from '../../src/domain/derivedId';
import { Question } from '../../src/domain/model';
import { scaleMemoInput } from '../fixtures/memoScale';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const { deal, findings } = scaleMemoInput;
const firms = ['', 'Fabrikam Credit', 'Northwind Capital', 'Northwind Capital '];
const workstreams = ['', 'Legal', 'Technical', '   '];
const statuses = ['open', 'answered', 'closed'] as const;

function portfolioState() {
  const state = initialState();
  state.deals[deal.id] = deal;
  const rows = portfolioQuestions().map((text, index) => Question.parse({
    id: derivedId('q', [deal.id, text]), dealId: deal.id, n: index + 1, text,
    rev: 1, createdAt: deal.createdAt, updatedAt: deal.updatedAt,
    askedBy: firms[index % firms.length],
    workstream: workstreams[Math.floor(index / firms.length) % workstreams.length],
    status: statuses[Math.floor(index / (firms.length * workstreams.length)) % statuses.length],
  }));
  state.questions = Object.fromEntries(rows.map((row) => [row.id, row]));
  return state;
}

it('exports the same rows as the Q&A page for every shared status and workstream filter', () => {
  const state = portfolioState();
  expect(Object.keys(state.questions).length).toBeGreaterThan(2_000);
  for (const status of [...statuses, 'all'] as const) {
    for (const workstream of ['', 'Legal', 'Technical', NO_WORKSTREAM]) {
      state.ui.qaFilter = { status, workstream, text: '' };
      const page = qaPageView(state, deal.id, () => false);
      const filter = qaFilterFromPage(state, deal.id);
      expect(filter).toEqual({ status, workstream, askedBy: firms });
      expect(page.list.length).toBeGreaterThan(0);
      expect(questionRowsFor(state, deal.id, filter)).toEqual(page.list);

      for (const askedBy of [firms, ['', 'Northwind Capital '], []]) {
        const selection = { ...filter, askedBy };
        const view = qaExportView(state, deal.id, selection);
        const selected = page.list.filter((row) => askedBy.includes(row.askedBy));
        expect(view.firms).toEqual(firms);
        expect(view.workstreams).toEqual(page.workstreams);
        expect(view.firmsTotal).toBe(page.list.length);
        expect(view.total).toBe(selected.length);
        expect([...view.firmCounts]).toEqual(firms.map((firm) =>
          [firm, page.list.filter((row) => row.askedBy === firm).length]));
        expect(questionRowsFor(state, deal.id, selection)).toEqual(selected);
      }
    }
  }
});

it('keeps screen-only Q&A filters out of the export and shows zero counts for firms without matching rows', () => {
  const state = portfolioState();
  for (const status of ['changed', 'versions'] as const) {
    state.ui.qaFilter = { status, workstream: 'Technical', text: 'unlisted transfer agent' };
    const filter = qaFilterFromPage(state, deal.id);
    expect(filter).toEqual({ status: 'all', workstream: 'Technical', askedBy: firms });
    expect(questionRowsFor(state, deal.id, filter).length).toBeGreaterThan(0);
  }
  const filter = { ...qaFilterFromPage(state, deal.id), workstream: 'Insurance' };
  const view = qaExportView(state, deal.id, filter);
  expect(view.firms).toEqual(firms);
  expect([...view.firmCounts.values()]).toEqual([0, 0, 0, 0]);
  expect(view.firmsTotal).toBe(0);
  expect(view.total).toBe(0);
});

it('exports saved status even when the page also shows another version or a selected row outside the filter', () => {
  const state = portfolioState();
  const open = Object.values(state.questions).filter((row) => row.status === 'open');
  const conflicts = open.slice(0, 120);
  expect(conflicts).toHaveLength(120);
  for (const row of conflicts) {
    const alternate = { ...row, status: 'answered' as const };
    state.conflicts[row.id] = {
      kind: 'question', id: row.id, dealId: deal.id,
      versions: [
        { id: 'saved', by: 'Reviewer', from: 'Office', at: deal.updatedAt, data: row, raw: row },
        { id: 'alternate', by: 'Colleague', from: 'Office', at: deal.updatedAt, data: alternate, raw: alternate },
      ],
    };
  }
  state.ui.selectedQuestion = open.at(-1)?.id ?? null;
  state.ui.qaFilter = { status: 'answered', workstream: '', text: '' };
  const filter = qaFilterFromPage(state, deal.id);
  const page = qaPageView(state, deal.id, () => false);
  expect(page.outsideFilter).toBe(state.ui.selectedQuestion);
  const saved = page.list.filter((row) => row.status === 'answered');
  expect(page.list.length - saved.length).toBe(121);
  expect(questionRowsFor(state, deal.id, filter)).toEqual(saved);
  expect(qaExportView(state, deal.id, filter).total).toBe(saved.length);
});

it('opens the findings export on Open when the page shows Reassess and keeps the reviewed choice', () => {
  const state = initialState();
  const [base, other] = findings;
  const reviewed = { ...base, workstream: ' Legal ', status: 'open' as const,
    reviewed: { by: 'Reviewer', at: deal.updatedAt } };
  const unreviewed = { ...other, workstream: 'Technical', status: 'open' as const, reviewed: null };
  state.findings = { [reviewed.id]: reviewed, [unreviewed.id]: unreviewed };
  state.ui.findingFilter = { status: 'reassess', workstream: 'Legal', text: 'due diligence', reviewed: 'yes' };
  const filter = findingFilterFromPage(state);
  expect(filter).toEqual({ status: 'open', workstream: 'Legal', reviewedOnly: true });
  expect(findingExportView(state, deal.id, filter)).toEqual({ workstreams: ['Legal', 'Technical'], total: 1 });
  state.ui.findingFilter.reviewed = 'no';
  expect(findingFilterFromPage(state).reviewedOnly).toBe(false);
});
