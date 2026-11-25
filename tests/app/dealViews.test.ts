// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDealFromForm } from '../../src/app/dealSetup';
import { folderDealLabels } from '../../src/app/dealLabel';
import { dealRows, interruptedOperations, railDealGroups } from '../../src/app/dealView';
import { compareChecklistVersion } from '../../src/app/conflictView';
import { deletedGroups, deletedIssuesLists, issuesListRemoval, visibleDeletedNotes } from '../../src/app/deletedView';
import { locateFoldersView } from '../../src/app/relink';
import { initialState, type Conflict } from '../../src/app/state';
import { DeleteFinding } from '../../src/app/commands/findings';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import { Deal, Operation, firstMember } from '../../src/domain/model';
import { ListRecord, listId } from '../../src/domain/checklist';
import { formatDateTime } from '../../src/domain/dateTime';
import { PORTFOLIO_ASSETS, portfolioQuestions } from '../fixtures/portfolioQuestions';
import { pc } from './pcs';

const old = '2026-10-12T10:00:00.000Z';
const recent = '2026-11-15T10:00:00.000Z';
const identify = (number: number) => String(number).padStart(26, '0');

function deal(id: number, name: string, group = 'live', createdAt = recent, counterparty = 'Northwind Infrastructure') {
  return Deal.parse({ id: 'd_' + identify(id), rev: 0, name, group, counterparty, createdAt, updatedAt: createdAt });
}

function dealState() {
  const state = initialState();
  const olderMine = deal(1, 'Project Alpine', 'monitor', old);
  const newerMine = deal(4, 'Project Alpine', 'live');
  const named = [olderMine, newerMine, deal(2, 'Alpine'), deal(3, 'Project Alpine')];
  const transactions = [
    'Refinancing', 'Acquisition', 'Warehouse Facility', 'Construction Loan', 'Holdco Loan',
    'Tax Equity', 'JV Buyout', 'Grid Upgrade', 'Insurance Renewal',
  ];
  const background = PORTFOLIO_ASSETS.flatMap((asset) => transactions.map((transaction) => asset + ' ' + transaction))
    .map((name, index) => deal(index + 10, 'Project ' + name, 'closed'));
  state.deals = Object.fromEntries([...named, ...background].map((entry) => [entry.id, entry]));
  state.user = { name: 'Reviewer', initials: 'R' };
  state.members = Object.fromEntries([olderMine, newerMine].map((entry) => {
    const member = firstMember(entry.id, 'Reviewer', recent);
    return [member.id, member];
  }));
  return { state, named, olderMine, newerMine };
}

describe('headless views for deals and folders', () => {
  it('keeps membership, order, grouping, case-insensitive search, and interrupted operations', () => {
    const { state, named, olderMine, newerMine } = dealState();
    expect(Object.keys(state.deals)).toHaveLength(112);
    expect(dealRows(state, 'add', '  ALPINE ').slice(-4).map(({ deal }) => deal.id)).toEqual([
      named[3].id, named[2].id, newerMine.id, olderMine.id,
    ]);
    expect(dealRows(state, 'add', 'northwind')).toHaveLength(112);
    expect(dealRows(state, 'rail').map(({ deal }) => deal.id)).toEqual([newerMine.id, olderMine.id]);
    expect(dealRows(state, 'home').map(({ deal }) => deal.id)).toEqual([olderMine.id, newerMine.id]);
    expect(railDealGroups(state).map(({ group, deals }) => [group, deals.length])).toEqual([
      ['live', 1], ['monitor', 1], ['pitch', 0], ['closed', 0],
    ]);
    const ops = ['pending', 'succeeded', 'interrupted', 'failed', 'discarded'].map((status, index) =>
      Operation.parse({
        id: 'op_' + identify(index), state: status, command: 'EditDeal', targets: [newerMine.id],
        input: { dealId: newerMine.id, name: 'Project Alpine refinancing' }, startedAt: recent,
      }));
    state.ops = Object.fromEntries(ops.map((op) => [op.id, op]));
    expect(interruptedOperations(state)).toEqual([ops[2]]);
  });

  it('disambiguates otherwise identical labels and distinguishes empty folders from missing paths', () => {
    const { state, named } = dealState();
    const paths = ['D:/Deals/Legal', 'D:/Deals/Finance', 'E:/Reports', 'F:/Technical'];
    const places = named.map(({ id }, index) => ({ dealId: id, folder: paths[index] }));
    const labels = folderDealLabels(state, places);
    expect(labels.get(places[2].dealId)).toBe('Alpine');
    expect(labels.get(places[3].dealId)).toMatch(/^Project Alpine \(Northwind Infrastructure · .*\) \(2\)$/);
    expect(new Set(labels.values()).size).toBe(4);
    state.ui.missingFolders = {
      placed: 0, missing: 3, empty: [places[2]],
      tops: [{ top: 'Previous location', folders: places }],
    };
    state.ui.locate = {
      busy: false, error: '',
      located: [{
        top: 'D:/Deals', picked: 'C:/Workspace', places: places.slice(0, 2).map((place) => ({
          ...place, local: 'C:/Workspace/' + place.folder.split('/').at(-1),
        })),
      }],
    };
    const view = locateFoldersView(state);
    expect(view.found).toBe(2);
    expect(view.located.map(({ count }) => count)).toEqual([2]);
    expect(view.missing.map(({ why }) => why).sort()).toEqual(['Files not found', 'Not found on this PC']);
    expect(new Set([...view.located, ...view.missing].flatMap(({ deals }) => deals)).size).toBe(4);
  });
});

const conflictVersion = (data: Conflict['versions'][number]['data'], id: string) => ({
  id, from: 'Office', by: 'Reviewer', at: recent, data, raw: data,
});

describe('kept records and list revisions', () => {
  it('compares realistic master lists, including reorderings and gaps across three versions', () => {
    const state = initialState();
    const items = portfolioQuestions().map((text) => ({ text }));
    expect(items.length).toBeGreaterThan(2_000);
    const first = ListRecord.parse({
      id: listId('sector', 'Solar'), rev: 1, createdAt: old, updatedAt: recent,
      name: 'Solar', layer: 'sector', at: recent, by: 'Reviewer', items: items.slice(0, 2000),
    });
    const second = { ...first, items: [...first.items].reverse() };
    const conflict: Conflict = {
      id: first.id, dealId: '', kind: 'firmList',
      versions: [conflictVersion(first, 'first'), conflictVersion(second, 'second')],
    };
    state.conflicts[first.id] = conflict;
    expect(compareChecklistVersion(state, first, first.items)).toEqual({
      count: 2000, compared: true, same: true,
      only: { count: 0, names: [], more: 0 }, lacks: { count: 0, names: [], more: 0 },
    });
    second.items = [...items.slice(1, 1999), items[2001]];
    const third = { ...first, items: [...items.slice(1, 1999), items[2001], items[2002]] };
    conflict.versions.push(conflictVersion(third, 'third'), conflictVersion(null, 'deleted'));
    expect(compareChecklistVersion(state, first, first.items)).toEqual({
      count: 2000, compared: true, same: false,
      only: { count: 2, names: [items[0].text, items[1999].text], more: 0 },
      lacks: { count: 2, names: [items[2001].text, items[2002].text], more: 0 },
    });
    second.items = items.slice(0, 8);
    conflict.versions = [conflictVersion(first, 'first'), conflictVersion(second, 'second')];
    expect(compareChecklistVersion(state, second, second.items).lacks).toEqual({
      count: 1992, names: items.slice(8, 13).map(({ text }) => text), more: 1987,
    });
  });

  it('keeps conflict copies separate and shows distinct imports of one list after a re-import', async () => {
    const { store } = pc('Deleted view fixture', 'reviewer');
    await store.boot();
    const { deal: created } = await createDealFromForm(store, { name: 'Alpine', folders: [], busy: false, error: '' });
    const dealId = created!.id;
    const points = portfolioQuestions().slice(0, 110).map((text, index) => ({
      n: String(index + 1), text, title: text.slice(0, 75), workstream: 'Financial',
    }));
    const first = { dealId, doc: 'doc_credit_v1', list: 'Credit diligence.pdf', points };
    const second = { ...first, doc: 'doc_credit_v2', list: 'Credit diligence.docx' };
    expect((await store.dispatch(ImportIssuesList, first)).ok).toBe(true);
    const removed = Object.values(store.get().findings)[0];
    expect((await store.dispatch(DeleteFinding, { dealId, findingId: removed.id })).ok).toBe(true);
    expect((await store.dispatch(ImportIssuesList, second)).ok).toBe(true);
    const stored = store.get();
    const lists = deletedIssuesLists(stored, dealId);
    expect(lists.map(({ doc, twin, title }) => [doc, twin, title])).toEqual([
      [second.doc, true, 'Credit diligence'], [first.doc, true, 'Credit diligence'],
    ]);
    expect(lists.every(({ when, at }) => when === formatDateTime(at, true))).toBe(true);
    expect(lists.map((list) => issuesListRemoval(list, dealId))).toMatchObject([
      {
        ask: `Remove Credit diligence.docx (imported ${lists[0].when})?`,
        text: '110 findings go to Deleted.',
      },
      {
        ask: `Remove Credit diligence.pdf (imported ${lists[1].when})?`,
        text: '109 findings go to Deleted.',
      },
    ]);
    const note = stored.tombstones[removed.id];
    const withCopy = {
      ...note, copies: [{ ver: 'another', from: 'Other PC', actor: 'Reviewer', at: recent, snapshot: removed }],
    };
    const state = { ...stored, tombstones: { [removed.id]: withCopy } };
    expect(deletedGroups(state, dealId)[0].rows.map(({ key }) => key)).toEqual([
      removed.id + '@another', removed.id,
    ]);
    const conflict: Conflict = {
      id: removed.id, dealId, kind: 'finding',
      versions: [conflictVersion(removed, 'edited'), conflictVersion(null, 'deleted')],
    };
    expect(visibleDeletedNotes({ ...state, conflicts: { [removed.id]: conflict } }, dealId)).toEqual([]);
    expect(visibleDeletedNotes(stored, dealId)).toHaveLength(1);

    const finding = lists[1].made[0];
    const point = points.find(({ text }) => text === finding.body[0])!;
    const join = { dealId, doc: 'doc_joined', list: 'Loan covenants.pdf', points: [{ ...point, join: finding.id }] };
    expect((await store.dispatch(ImportIssuesList, join)).ok).toBe(true);
    const joined = deletedIssuesLists(store.get(), dealId).find(({ doc }) => doc === join.doc)!;
    expect(issuesListRemoval(joined, dealId)).toMatchObject({
      ask: 'Remove Loan covenants.pdf?',
      text: 'No findings go to Deleted. Marks are removed from 1 finding.',
    });
  });
});
