// @vitest-environment node
import { expect, it } from 'vitest';
import { commandPlace } from '../../src/app/commandLabels';
import { dismissInterrupted, interruptedView } from '../../src/app/dealView';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { initialState } from '../../src/app/state';
import { derivedId } from '../../src/domain/derivedId';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { Operation } from '../../src/domain/model';
import { ELSEWHERE } from '../adapters/memRepo';
import { scaleMemoInput } from '../fixtures/memoScale';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal } from './recoveryKit';

it('retains each dismissed and overflowed action through recovery with 104 unresolved questions', async () => {
  const before = recoveryApp();
  const dealId = await recoveryDeal(before);
  const texts = portfolioQuestions().slice(0, 104);
  const { rows } = prepareImport(texts.map((text) => [text]), suggestMapping(['Question']));
  expect(await before.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows })).toMatchObject({ ok: true });
  for (const q of Object.values(before.store.get().questions)) {
    const peer = { ...q, response: 'Counsel is confirming the executed instrument.' };
    before.repo.peer.edit('question', q.id, peer, ELSEWHERE);
  }
  const ops = texts.slice(0, 11).map((text) => Operation.parse({
    id: derivedId('op', [text]), command: 'CreateQuestion', startedAt: ELSEWHERE.at,
    state: 'pending', input: { dealId, text }, targets: [],
  }));
  expect(await before.repo.transaction({ writes: ops.map((op) => ({
    kind: 'op', id: op.id, data: op, expectedRev: null,
  })) })).toMatchObject({ ok: true });
  before.store.closing();
  await before.repo.close();
  const after = recoveryApp(before.saved);
  try {
    await after.store.boot();
    await after.store.loadDeal(dealId, { gaps: false });
    const state = after.store.get();
    expect(Object.keys(state.conflicts)).toHaveLength(104);
    const ids = ops.map((op) => op.id);
    const view = (first?: string, hidden: string[] = []) => interruptedView(after.store.get(), first, hidden);
    const showing = (first?: string, hidden?: string[]) => view(first, hidden).showing.map((op) => op.id);
    expect(showing()).toEqual(ids.slice(0, 3));
    expect(view().hidden).toHaveLength(8);
    expect(showing(ids[10])).toEqual([ids[10], ids[0], ids[1]]);
    expect(showing(undefined, [ids[0], ids[2]])).toEqual([ids[1], ids[3], ids[4]]);
    const allDismissed = view(undefined, ids);
    expect(allDismissed.showing).toEqual([]);
    expect(allDismissed.hidden.map((op) => op.id)).toEqual(ids);
    expect(showing(allDismissed.hidden[0].id)).toEqual(ids.slice(0, 3));
    expect(await after.store.retryOp(ids[0])).toMatchObject({ ok: true });
    expect(dismissInterrupted(after.store.get(), [ids[0], ids[2]], ids[3])).toEqual([ids[2], ids[3]]);
    expect(view(ids[0], [ids[2]]).hidden).toHaveLength(7);
    expect(showing(ids[0], [ids[2]])).toEqual([ids[1], ids[3], ids[4]]);
  } finally {
    after.store.closing();
    await after.repo.close();
  }
});

it('names an interrupted action using the exact finding title and gives questions precedence', () => {
  const state = initialState();
  const { deal, findings, questions } = scaleMemoInput;
  const title = '  ' + 'Lender consent for the proposed transfer  under the facilities agreement. '.repeat(5);
  const f = { ...findings[0], title };
  const q = questions[0];
  state.deals[deal.id] = deal;
  state.findings[f.id] = f;
  state.questions[q.id] = q;
  const target = { dealId: deal.id, findingId: f.id };
  expect(commandPlace(state, target)).toBe(`“${title}” on ${deal.name}`);
  expect(commandPlace(state, { ...target, questionId: q.id })).toBe(`Q${q.n} on ${deal.name}`);
  expect(commandPlace(state, { dealId: deal.id })).toBe(deal.name);
  expect(commandPlace(state, null)).toBe('');
});
