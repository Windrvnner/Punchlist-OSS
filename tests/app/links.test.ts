// @vitest-environment node
import { expect, it } from 'vitest';
import { briefParts, scopeHash, withoutFindingLinks, type Scope } from '../../src/app/conversations';
import { allHits } from '../../src/app/search';
import { DEAL_PAGES, dealHash, initialState, pageHash, routeFromHash } from '../../src/app/state';
import { Finding, Question, firstMember } from '../../src/domain/model';
import { derivedId } from '../../src/domain/derivedId';
import { scaleMemoInput } from '../fixtures/memoScale';

const deal = scaleMemoInput.deal;
const dealId = deal.id;
const findingId = derivedId('f', ['permits']);
const questionId = derivedId('q', ['permits']);

it('opens every deal landing, conversation and record route', () => {
  for (const [page, , name] of DEAL_PAGES) {
    for (const hash of [pageHash(page, dealId), dealHash({ landing: page }, dealId)]) {
      expect(routeFromHash('#' + hash)).toEqual({ name, dealId });
    }
  }
  const conv = 'cabcd';
  const routes: [Scope, object][] = [
    [{ kind: 'all' }, { name: 'chat' }], [{ kind: 'all', conv }, { name: 'chat', conv }],
    [{ kind: 'deal', dealId }, { name: 'chat', dealId }],
    [{ kind: 'deal', dealId, conv }, { name: 'chat', dealId, conv }],
    [{ kind: 'finding', dealId, findingId }, { name: 'finding', dealId, findingId }],
    [{ kind: 'question', dealId, questionId }, { name: 'question', dealId, questionId }],
  ];
  for (const [scope, route] of routes) expect(routeFromHash('#' + scopeHash(scope))).toEqual(route);
  for (const hash of ['', '#deals', '#unknown', '#finding-invalid']) {
    expect(routeFromHash(hash)).toEqual({ name: 'home' });
  }
});

it('retains loose text and complete literal braces around several finding links', () => {
  const paragraph = ` Keep {literal} {Permit A|${findingId}} and {cl. 4|other} {B|${findingId}}.  `;
  const parts = briefParts(paragraph).map((part) => typeof part === 'string' ? part : [part[1], part[2]]);
  expect(parts).toEqual([' Keep {literal} ', ['Permit A', findingId], ' and {cl. 4|other} ', ['B', findingId], '.  ']);
  expect(withoutFindingLinks(paragraph)).toBe(' Keep {literal} Permit A and {cl. 4|other} B.  ');
});

it('opens actual search hits with their document, checklist and question selections', () => {
  const state = initialState();
  state.user = { name: 'Morgan', initials: 'M' };
  state.deals[dealId] = { ...deal, name: 'Permit review' };
  const member = firstMember(dealId, 'Morgan', deal.createdAt);
  state.members[member.id] = member;
  const record = { dealId, createdAt: deal.createdAt, updatedAt: deal.updatedAt, rev: 1 };
  const source = { doc: 'Permit.pdf', docId: 'permit', loc: 'p. 0012' };
  state.questions[questionId] = Question.parse({ ...record, id: questionId, text: 'Permit granted?', n: 3 });
  state.findings[findingId] = Finding.parse({ ...record, id: findingId, title: 'Permit renewal',
    workstream: 'Legal', raisedAt: deal.createdAt, origin: 'human', sources: [source] });
  state.checklists[dealId] = [{ id: 'permit-item', text: 'Permit in force', result: 'gap', docs: [] }];
  const hit = (kind: string) => allHits(state, 'permit').find((entry) => entry.kind === kind)!;
  const route = (kind: string) => routeFromHash('#' + hit(kind).hash);
  expect(route('deal')).toEqual({ name: 'overview', dealId });
  expect(route('finding')).toEqual({ name: 'finding', dealId, findingId });
  expect(route('document')).toEqual({ name: 'finding', dealId, findingId });
  expect(hit('document').ui).toEqual({ doc: 0 });
  expect(route('item')).toEqual({ name: 'checklist', dealId });
  expect(hit('item').ui).toEqual({ selectedChecklist: 'permit-item', checklistFilter: 'all' });
  expect(route('question')).toEqual({ name: 'qa', dealId });
  expect(hit('question').ui).toEqual({
    selectedQuestion: questionId, qaFilter: { status: 'all', workstream: '', text: '' },
  });
  state.ui.route = { name: 'checklist', dealId };
  expect(hit('question').ui).toEqual({ selectedQuestion: questionId });
});
