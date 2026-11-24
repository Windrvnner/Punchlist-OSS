// @vitest-environment node
import { expect, it } from 'vitest';
import { createdRecord } from '../../src/app/createdRecord';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding } from '../../src/app/commands/findings';
import { LISTED } from '../../src/app/commands/issuesList';
import { CreateQuestion } from '../../src/app/commands/questions';
import { findingHistory } from '../../src/app/findings';
import { initialState, type State } from '../../src/app/state';
import { derivedId } from '../../src/domain/derivedId';
import type { AuditEntry } from '../../src/domain/model';
import { scaleMemoInput } from '../fixtures/memoScale';
import { make } from './importKit';

const at = '2026-11-17T10:00:00.000Z';
const funding = 'The draw conditions do not match the signed term sheet';
const { deal, findings, questions } = scaleMemoInput;
const finding = findings[0];

function audit(kind: AuditEntry['kind'], op: string, fields: Partial<AuditEntry> = {}): AuditEntry {
  return { kind, opId: derivedId('op', [op]), recordId: finding.id, dealId: deal.id, actor: 'adoe', at, ...fields };
}

function dealRecords(state: State, dealId: string) {
  const sites = ['North', 'South', 'Central'];
  for (const site of sites) {
    for (const record of findings) {
      const id = derivedId('f', [dealId, site, record.id]);
      state.findings[id] = { ...record, id, dealId, title: `${site} site: ${record.title}` };
    }
  }
  const phases = ['at first draw', 'at testing', 'at completion', 'at conversion', 'at refinancing'];
  const regions = ['coastal', 'upland', 'central'];
  let number = 0;
  for (const region of regions) {
    for (const phase of phases) {
      for (const record of questions) {
        const id = derivedId('q', [dealId, region, phase, record.id]);
        const text = `For the ${region} site ${phase}: ${record.text}`;
        number += 1;
        state.questions[id] = { ...record, id, dealId, n: number, text };
      }
    }
  }
}

it('associates a closing note with the close and ignores a later undone closing', () => {
  const state = initialState();
  dealRecords(state, deal.id);
  state.findings[finding.id] = finding;
  const close = audit('status', 'close', { to: 'closed', actor: 'adoe · Office PC' });
  const note = audit('note', 'close', { text: 'Counsel confirmed clause 7.4 governs the draw.' });
  const undone = audit('status', 'undone-close', { to: 'closed', actor: 'sroe' });
  const listed = audit('edited', 'list-import', { text: LISTED });
  state.audit[finding.id] = [
    audit('created', 'raise'), close, note, undone, audit('undone', 'undo', { undoes: undone.opId }), listed,
  ];
  expect(findingHistory(state, finding.id)).toEqual({
    last: close, closedBy: 'adoe', previous: undefined, previousReview: null,
  });
  expect(findingHistory(state, 'missing').closedBy).toBe('');
});

it('pairs the cleared review with the last reassessment that changed the words', () => {
  const state = initialState();
  dealRecords(state, deal.id);
  state.findings[finding.id] = finding;
  const from = ['The term sheet gives a 1.30x lock-up test.'];
  const to = ['The executed agreement sets the lock-up test at 1.25x.'];
  const previous = audit('reassessed', 'update-from-documents', { from, to });
  const previousReview = { by: 'sroe', at: '2026-11-16T10:00:00.000Z' };
  const unchanged = audit('reassessed', 'checked-again', { from: to, to });
  const note = audit('note', 'follow-up', { text: 'Reviewed the executed credit agreement.' });
  state.audit[finding.id] = [
    previous, audit('unreviewed', 'update-from-documents', { from: previousReview }),
    unchanged, audit('unreviewed', 'checked-again', { from: { by: 'broe', at } }), note,
  ];
  expect(findingHistory(state, finding.id)).toMatchObject({ last: note, previous, previousReview });
});

it('looks up the exact deal, question and two same-title findings after the creates land', async () => {
  const { store } = make();
  await store.boot();
  const madeDeal = await store.dispatch(CreateDeal, { name: 'Southridge', folders: [] });
  if (!madeDeal.ok) throw new Error(madeDeal.error.message);
  const opened = createdRecord(store.get(), madeDeal.value.opId, 'deals');
  if (!opened) throw new Error('Could not open the created deal');
  expect(opened).toMatchObject({ name: deal.name });
  const dealId = opened.id;
  dealRecords(store.get(), dealId);

  const input = { dealId, title: funding, workstream: 'Legal' };
  const first = await store.dispatch(CreateFinding, { ...input, body: ['The term sheet requires an executed PPA.'] });
  const second = await store.dispatch(CreateFinding, { ...input, body: ['The base case assumes the draft is enough.'] });
  const text = 'Which conditions in the signed term sheet remain outstanding for first draw?';
  const question = await store.dispatch(CreateQuestion, { dealId, text });
  if (!first.ok || !second.ok || !question.ok) throw new Error('Could not create the records');

  const state = store.get();
  const original = createdRecord(state, first.value.opId, 'findings');
  const created = createdRecord(state, second.value.opId, 'findings');
  const openedQuestion = createdRecord(state, question.value.opId, 'questions');
  expect(original).toMatchObject({ title: funding, body: ['The term sheet requires an executed PPA.'] });
  expect(created).toMatchObject({ title: funding, body: ['The base case assumes the draft is enough.'] });
  expect(created?.id).not.toBe(original?.id);
  expect(openedQuestion).toMatchObject({ dealId, text, n: questions.length * 15 + 1 });
  expect(createdRecord(state, question.value.opId, 'findings')).toBeUndefined();
  expect(createdRecord(state, 'missing', 'questions')).toBeUndefined();
});
