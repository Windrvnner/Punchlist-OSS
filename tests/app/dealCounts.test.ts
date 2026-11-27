// @vitest-environment node
import { expect, it } from 'vitest';
import { checklistView } from '../../src/app/checklistView';
import { memoItems } from '../../src/app/memo';
import {
  checklistStandingParts, checkLine, checklistListCounts, checklistStandingCounts,
  checkLeftCount, findingCounts, indexingTotals, questionCounts,
  uncheckedChecklistCount,
} from '../../src/app/dealCounts';
import { removableIssuesLists, visibleDeletedNotes } from '../../src/app/deletedView';
import { findingsView } from '../../src/app/findingsView';
import { dealFirstPassStatus, folderProgress, overviewStatus } from '../../src/app/indexing';
import { initialState } from '../../src/app/state';
import { Item, itemId, key as wording, ListRecord, listId } from '../../src/domain/checklist';
import { derivedId } from '../../src/domain/derivedId';
import { Finding, Folder, Question, type QuestionStatus } from '../../src/domain/model';
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

it('gives the deal memo the same checklist counts as Overview, new and turned-off items included (#1064)', () => {
  const state = checklistDeal();
  const items = memoItems(state, dealId)!;
  const kinds = (kind: string) => items.filter((item) => item.kind === kind).length;
  expect(items).toHaveLength(2160);
  expect([kinds('satisfied') + kinds('person'), kinds('finding'), kinds('gap'), kinds('open'), kinds('off')])
    .toEqual([2017, 118, 1, 21, 3]);   // flagged: 117 open and 1 whose finding was deleted, as on Overview
  delete state.checklists[dealId];
  expect(memoItems(state, dealId)).toBeNull();   // rows not read: no counts, not only the turned-off items
});

it('keeps the reported standings until the checklist rows arrive, including after a failed read', () => {
  const state = checklistDeal();
  const checked = state.checklists[dealId];
  delete state.checklists[dealId];
  const reported = {
    all: 2140, finding: 120, gap: 2, open: 2, satisfied: 2016, person: 0, gone: 0, off: 3,
    offOpen: 1, toResolve: 122, settled: 2016,
  };
  expect(checklistStandingCounts(state, dealId)).toEqual(reported);
  state.checklists[dealId] = 'failed';
  expect(checklistStandingCounts(state, dealId)).toEqual(reported);
  delete state.progress[dealId];
  expect(checklistStandingCounts(state, dealId)).toBeNull();
  state.checklists[dealId] = checked;
  expect(checklistStandingCounts(state, dealId)).toMatchObject({ all: 2160, gap: 1, open: 21 });
});

it('shows a completed checklist with new active items even when progress is missing or reports zero', () => {
  const state = checklistDeal();
  for (const item of Object.values(state.items)) item.off = false;
  state.checklists[dealId] = [];
  const expected = { all: 2160, open: 2160, off: 0, toResolve: 0, settled: 0 };
  expect(checklistView(state, dealId).counts).toMatchObject({ all: 2160, open: 2160, off: 0 });
  delete state.progress[dealId];
  expect(checklistStandingCounts(state, dealId)).toMatchObject(expected);
  state.progress[dealId] = { folders: [], checklist: { items: 0, findings: 0, gaps: 0, unsettled: 0, satisfied: 0 } };
  expect(checklistStandingCounts(state, dealId)).toMatchObject(expected);
});

it('shows only turned-off items and drops an empty completed checklist despite stale positive progress', () => {
  const state = checklistDeal();
  for (const item of Object.values(state.items)) item.off = true;
  expect(checklistStandingCounts(state, dealId)).toMatchObject({
    all: 2160, off: 2160, offOpen: 118, open: 0, toResolve: 0, settled: 0,
  });
  state.items = {};
  state.checklists[dealId] = [];
  expect(checklistStandingCounts(state, dealId)).toBeNull();
});

const otherDeal = { ...scaleMemoInput.deal, id: derivedId('d', ['Project Westhaven']), name: 'Project Westhaven' };

it('shares the deal’s finding counts while keeping conflicts visible in the filtered list', () => {
  const state = checklistDeal();
  const findings = Object.values(state.findings);
  for (const finding of findings.slice(0, 47)) finding.updated = true;
  for (const finding of findings.slice(90)) {
    finding.status = 'closed';
    finding.updated = true;
    finding.workstream = 'Financial';
  }
  findings[0].workstream = '';
  for (const finding of findings.slice(19)) {
    const competing = { ...finding, title: `Updated review: ${finding.title}` };
    state.conflicts[finding.id] = {
      kind: 'finding', id: finding.id, dealId,
      versions: [finding, competing].map((data, index) => ({
        id: String(index), by: 'Reviewer', from: 'workstation', at: updatedAt, data, raw: data,
      })),
    };
  }
  const unrelated = scaleMemoInput.findings[0];
  state.findings[unrelated.id] = { ...unrelated, dealId: otherDeal.id };
  state.ui.findingFilter.status = 'reassess';

  const expected = { total: 119, open: 90, reassess: 47, closed: 29 };
  expect(findingCounts(state, dealId)).toEqual(expected);
  const view = findingsView(state, dealId);
  expect(view.counts).toEqual(expected);
  expect(view.statusOptions).toEqual(['open', 'reassess', 'closed', 'all']);
  expect(view.rows).toHaveLength(119);
  expect(view.rows.filter(({ conflictVersions }) => conflictVersions === 2)).toHaveLength(100);
  expect(view.rows.find(({ finding }) => finding.id === findings[0].id)?.conflictVersions).toBeUndefined();
  expect(view.rows.flatMap(({ heading }) => heading ? [heading] : [])).toEqual([
    { name: 'Financial', count: 29 }, { name: 'Legal', count: 89 }, { name: 'No workstream', count: 1 },
  ]);

  state.conflicts = {};
  const filtered = findingsView(state, dealId);
  expect(filtered.counts).toEqual(expected);
  expect(filtered.rows).toHaveLength(47);
  expect(filtered.rows.flatMap(({ heading }) => heading ? [heading] : [])).toEqual([
    { name: 'Legal', count: 46 }, { name: 'No workstream', count: 1 },
  ]);
});

it('falls back to Open on a short list when the requested finding status is unavailable', () => {
  const state = initialState();
  const finding = scaleMemoInput.findings[0];
  state.findings[finding.id] = finding;
  for (const status of ['reassess', 'closed'] as const) {
    state.ui.findingFilter.status = status;
    expect(findingsView(state, dealId)).toMatchObject({
      filter: { status: 'open' }, showStatus: false, statusOptions: ['open', 'all'], rows: [{ finding }],
    });
  }
});

it('counts each live question by saved status in a deal-scale Q&A log', () => {
  const state = checklistDeal();
  const statuses: QuestionStatus[] = ['open', 'answered', 'closed'];
  for (const [index, item] of Object.values(state.items).entries()) {
    const id = derivedId('q', [dealId, item.id]);
    state.questions[id] = Question.parse({
      ...record, id, text: `Please confirm the closing evidence for ${item.text}.`, n: index + 1,
      status: statuses[index % statuses.length],
    });
  }
  const other = scaleMemoInput.questions[0];
  state.questions[other.id] = { ...other, dealId: otherDeal.id };
  const deleted = scaleMemoInput.questions[1];
  state.tombstones[deleted.id] = {
    id: deleted.id, kind: 'question', dealId, title: deleted.text, snapshot: deleted, at: updatedAt, actor: 'reviewer',
  };
  expect(questionCounts(state, dealId)).toEqual({ total: 2160, open: 720, answered: 720, closed: 720 });
});

it('uses stored gaps until checklist rows are available and keeps each row’s own need', () => {
  const state = checklistDeal();
  const deal = state.deals[dealId];
  const rows = state.checklists[dealId] as ChecklistRow[];
  rows[120].need = 'Obtain the signed easement.';
  rows[121].need = 'Provide the complete executed lease.';
  const fallback = 'Confirm lender consent under the credit agreement.';
  state.gaps[dealId] = [{ title: fallback }];
  delete state.checklists[dealId];
  expect(overviewStatus(state, deal).gaps).toEqual([{ key: fallback, title: fallback }]);
  state.checklists[dealId] = 'failed';
  expect(overviewStatus(state, deal).gaps).toHaveLength(1);
  state.checklists[dealId] = rows;
  expect(overviewStatus(state, deal).gaps).toEqual([
    { key: rows[120].id, title: rows[120].text, need: 'Obtain the signed easement.' },
    { key: rows[121].id, title: rows[121].text, need: 'Provide the complete executed lease.' },
  ]);
  state.checklists[dealId] = [];
  expect(overviewStatus(state, deal).gaps).toEqual([]);
});

it('holds cached gaps until the deal’s first pass has a finding or finishes indexing', () => {
  const state = checklistDeal();
  const deal = { ...state.deals[dealId], stage: 'indexing' as const };
  const title = 'Confirm the executed construction guarantee.';
  delete state.checklists[dealId];
  state.gaps[dealId] = [{ title }];
  const [finding] = Object.values(state.findings);
  state.findings = { [finding.id]: { ...finding, dealId: otherDeal.id } };
  expect(overviewStatus(state, deal)).toMatchObject({ waiting: true, gaps: [] });
  const gaps = [{ key: title, title }];
  expect(overviewStatus(state, { ...deal, stage: 'ready' })).toMatchObject({ waiting: false, gaps });
  state.findings[finding.id] = finding;
  expect(overviewStatus(state, deal)).toMatchObject({ waiting: false, gaps });
});

it('offers Deleted for a restorable finding or removable issues list on the deal', () => {
  const state = checklistDeal();
  const [note] = Object.values(state.tombstones);
  const snapshot = note.snapshot as Finding;
  const original = state.findings;
  expect(findingsView(state, dealId).restorable).toBe(true);
  state.findings = { ...original, [note.id]: snapshot };
  expect(findingsView(state, dealId).restorable).toBe(false);
  state.findings = original;
  state.conflicts[note.id] = { id: note.id, kind: 'finding', dealId, versions: [] };
  expect(findingsView(state, dealId).restorable).toBe(false);

  const [finding] = Object.values(original);
  const mark = { doc: 'doc_closing_issues', n: '12', list: 'Closing issues.pdf', text: finding.title };
  state.findings = { ...original, [finding.id]: { ...finding, onLists: [mark] } };
  expect(findingsView(state, dealId).restorable).toBe(true);
  const ownId = derivedId('f', [dealId, mark.doc, mark.n, wording(mark.text), '0']);
  state.findings = { ...original, [ownId]: { ...finding, id: ownId, onLists: [mark] } };
  // The import made this finding, and a person has edited it since. There is nothing the import can take back.
  expect(findingsView(state, dealId).restorable).toBe(false);
});

const legal = '/Southridge/Executed agreements';
const finance = '/Southridge/Financial model';
const permits = '/Southridge/Permits';
const unlinked = '/Southridge/Banking files';

function folderDeal() {
  const state = checklistDeal();
  const deal = { ...state.deals[dealId] };
  state.deals[dealId] = deal;
  deal.folders = [
    Folder.parse({ path: legal, label: 'Legal', files: 112, indexed: 80, size: '84 MB' }),
    Folder.parse({ path: finance, label: '', files: 40, indexed: 40, size: '13 MB' }),
    Folder.parse({ path: permits, label: 'Permits', files: 25, indexed: 25, size: '16 MB' }),
  ];
  state.indexing[dealId] = { folders: [
    Folder.parse({ path: legal, label: 'Old label', files: 120, indexed: 120, size: '94 MB' }),
    Folder.parse({ path: unlinked, label: 'Banking', files: 400, indexed: 391, size: '9 MB' }),
  ], log: [] };
  state.progress[dealId].folders = [
    { folder: legal, files: 115, read: 59, core: 12, coreRead: 8, copies: 5 },
    { folder: finance, files: 36, read: 23, core: 8, coreRead: 5, copies: 4 },
    { folder: permits, files: 25, read: 10, core: 3, coreRead: 2 },
  ];
  return { state, deal };
}

it('overlays live indexing totals and counts distinct documents once the folders are indexed', () => {
  const { state, deal } = folderDeal();
  const progress = folderProgress(state, deal);
  expect(indexingTotals(state, deal)).toEqual({ folders: 3, files: 185, indexed: 185 });
  expect(progress.rows).toEqual([
    { key: legal, title: legal, name: 'Legal', files: 120, indexed: 120, indexing: false, read: 59, docs: 115,
      copies: 5, notice: undefined },
    { key: finance, title: finance, name: finance, files: 40, indexed: 40, indexing: false, read: 23, docs: 36,
      copies: 4, notice: undefined },
    { key: permits, title: permits, name: 'Permits', files: 25, indexed: 25, indexing: false, read: 10, docs: 25,
      copies: 0, notice: undefined },
  ]);
  expect(progress.total).toEqual({
    files: 185, indexed: 185, indexing: false, read: 92, docs: 176, copies: 0, notice: undefined,
  });
  expect(progress.core).toEqual({ files: 23, read: 15, unavailable: 0 });

  delete state.indexing[dealId];
  expect(indexingTotals(state, deal)).toEqual({ folders: 3, files: 177, indexed: 145 });
  const unfinished = folderProgress(state, deal);
  expect(unfinished.rows[0]).toMatchObject({ key: legal, indexing: true, read: undefined });
  expect(unfinished.total).toEqual({
    files: 177, indexed: 145, indexing: true, read: undefined, docs: 173, copies: 0, notice: undefined,
  });
});

it('merges missing folders for this deal and preserves the first two reported matching deals', () => {
  const { state, deal } = folderDeal();
  deal.stage = 'indexing';
  state.ui.indexStalled = [dealId];
  state.ui.missingFolders = {
    placed: 0, missing: 3,
    tops: [{ top: '/Southridge', folders: [
      { dealId, folder: legal }, { dealId, folder: finance }, { dealId: otherDeal.id, folder: permits },
    ] }],
    empty: [{ dealId, folder: finance }],
  };
  state.deals[otherDeal.id] = otherDeal;
  state.progress[dealId].alsoIn = [
    { dealId: derivedId('d', ['Project Harbour']), docs: 150, of: 185 },
    { dealId: otherDeal.id, docs: 140, of: 135 },
    { dealId, docs: 120, of: 185 },
  ];
  const progress = folderProgress(state, deal);
  expect(progress).toMatchObject({ stopped: true, folderCount: 3, showLocate: true, showFolders: false });
  expect(progress.total?.notice).toEqual({ kind: 'away', label: { count: 1, all: false } });
  expect(progress.rows.map(({ key, notice }) => ({ key, notice }))).toEqual([
    { key: legal, notice: { kind: 'away' } },
    { key: finance, notice: { kind: 'empty', label: { count: 1, all: true } } },
    { key: permits, notice: undefined },
  ]);
  expect(progress.core.unavailable).toBe(20);
  expect(progress.alsoIn).toEqual([{ deal: otherDeal, docs: 140, of: 140 }]);
});

it('shares no-room, waiting and stopped decisions across the deal’s pages', () => {
  const { state, deal } = folderDeal();
  const [finding] = Object.values(state.findings);
  state.findings = { [finding.id]: { ...finding, dealId: otherDeal.id } };
  const noRoom = { ...deal, stage: 'indexing' as const, folders: [] };
  expect(dealFirstPassStatus(state, noRoom)).toEqual({
    noRoom: true, waiting: true, stopped: false, showIndexing: false,
  });

  deal.stage = 'indexing';
  expect(dealFirstPassStatus(state, deal)).toEqual({
    noRoom: false, waiting: true, stopped: false, showIndexing: true,
  });
  state.ui.indexStalled = [dealId];
  const paused = { noRoom: false, waiting: true, stopped: true, showIndexing: false };
  expect(dealFirstPassStatus(state, deal)).toEqual(paused);
  expect(overviewStatus(state, deal)).toEqual({ ...paused, gaps: [] });

  state.findings = { [finding.id]: finding };
  expect(dealFirstPassStatus(state, deal)).toEqual({
    noRoom: false, waiting: false, stopped: true, showIndexing: false,
  });
  expect(dealFirstPassStatus(state, { ...deal, stage: 'ready' })).toEqual({
    noRoom: false, waiting: false, stopped: false, showIndexing: false,
  });
});

it('assigns a single summary notice when all folders are away or only empty folders need notices', () => {
  const { state, deal } = folderDeal();
  const locations = [legal, finance, permits].map((folder) => ({ dealId, folder }));
  state.ui.missingFolders = {
    placed: 0, missing: 3, tops: [{ top: '/Southridge', folders: locations }],
  };

  const away = folderProgress(state, deal);
  expect(away).toMatchObject({ showLocate: true, showFolders: false });
  expect(away.total?.notice).toEqual({ kind: 'away', label: { count: 3, all: true } });
  expect(away.rows.map(({ notice }) => notice)).toEqual([
    { kind: 'away' }, { kind: 'away' }, { kind: 'away' },
  ]);

  state.ui.missingFolders = { placed: 1, missing: 2, tops: [], empty: locations.slice(0, 2) };
  const empty = folderProgress(state, deal);
  expect(empty).toMatchObject({ showLocate: true, showFolders: true });
  expect(empty.total?.notice).toEqual({ kind: 'empty', label: { count: 2, all: false } });
  expect(empty.rows.map(({ notice }) => notice)).toEqual([{ kind: 'empty' }, { kind: 'empty' }, undefined]);

  deal.folders = [deal.folders[0]];
  const onlyFolder = folderProgress(state, deal);
  expect(onlyFolder.total).toBeNull();
  expect(onlyFolder.rows[0].notice).toEqual({ kind: 'empty', label: { count: 1, all: true } });
});

it('supplies Deleted notes newest first and removable issues lists by name, time and file id', () => {
  const state = checklistDeal();
  const [deleted] = Object.values(state.tombstones);
  const older = { ...deleted, id: derivedId('f', ['Missing loan agreement']), at: createdAt };
  state.tombstones = { [older.id]: older, [deleted.id]: deleted };
  expect(visibleDeletedNotes(state, dealId, 'finding').map(({ id }) => id)).toEqual([deleted.id, older.id]);

  const imports = [
    { doc: 'doc_z', list: 'Closing issues.pdf', at: updatedAt },
    { doc: 'doc_b', list: 'Closing issues.pdf', at: createdAt },
    { doc: 'doc_a', list: 'Closing issues.pdf', at: createdAt },
    { doc: 'doc_c', list: 'Advisor review.pdf', at: updatedAt },
  ];
  const findings = Object.values(state.findings).slice(0, imports.length);
  for (const [index, finding] of findings.entries()) {
    finding.onLists = [{ ...imports[index], n: '12', text: finding.title }];
  }
  expect(removableIssuesLists(state, dealId).map(({ doc }) => doc)).toEqual([
    'doc_c', 'doc_a', 'doc_b', 'doc_z',
  ]);
});

it('counts the firm lists for the selected layer and the latest check’s unfinished rows', () => {
  const state = checklistDeal();
  const deal = { ...state.deals[dealId], stage: 'ready' as const };
  for (const [layer, name, count] of [
    ['sector', 'Wind', 24], ['sector', 'Solar', 110], ['technology', 'Storage', 97],
  ] as const) {
    const id = listId(layer, name);
    state.firmList[id] = ListRecord.parse({
      id, rev, createdAt, updatedAt, layer, name, at: createdAt, by: 'Reviewer',
      items: ITEMS.slice(0, count).map(({ t }) => ({ text: t })),
    });
  }
  expect(checklistListCounts(state, 'sector')).toEqual([{ name: 'Solar', n: 110 }, { name: 'Wind', n: 24 }]);
  expect(uncheckedChecklistCount(state, deal)).toBe(1);
  expect(uncheckedChecklistCount(state, { ...deal, stage: 'indexing' })).toBe(0);
  const check = { at: updatedAt, offerDeep: null, left: { at: updatedAt, items: 21, findings: 12 } };
  expect(checkLeftCount(check, false)).toBe(33);
  expect(checkLeftCount(check, true)).toBe(0);
  expect(checkLeftCount({ ...check, left: { ...check.left, changed: true } }, false)).toBe(0);
});

it('selects the Overview check independently of the run mode and warning tone', () => {
  const state = checklistDeal();
  state.deals[dealId] = { ...state.deals[dealId], stage: 'ready' };
  const deep = { size: 12, overturned: 4 };
  const left = { at: updatedAt, items: 3, findings: 2 };
  const check = { at: null, offerDeep: deep };
  function line(patch: Partial<typeof state.checks[string]>) {
    state.checks[dealId] = { ...check, ...patch };
    return checkLine(state, dealId);
  }
  const normal = { deep: false, rest: 0 };
  expect(line({ busy: 'deep', failedAt: updatedAt, left })).toMatchObject({ kind: 'running', warn: false, ...normal });
  expect(line({ failedAt: updatedAt, left })).toMatchObject({ kind: 'failed', warn: true, ...normal });
  expect(line({ left })).toMatchObject({ kind: 'left', warn: true, deep: false, rest: 5 });
  expect(line({ left: { ...left, changed: true } })).toMatchObject({ kind: 'left', warn: true, ...normal });
  expect(line({})).toMatchObject({ kind: 'deep', warn: true, deep: true, rest: 0 });
  expect(line({ offerDeep: null })).toMatchObject({ kind: 'unchecked', warn: true, unchecked: 1, ...normal });
  const checking = { quiet: [], with: [], signIn: true };
  expect(line({ checking, left })).toMatchObject({ kind: 'running', warn: true, deep: false, rest: 5 });
  expect(line({ busy: 'quick', left })).toMatchObject({ kind: 'running', warn: false, deep: false, rest: 5 });
  state.deals[dealId] = { ...state.deals[dealId], stage: 'indexing' };
  expect(line({ offerDeep: null })).toBeNull();
  expect(line({ checking, offerDeep: null })).toMatchObject({ kind: 'running', warn: false, ...normal });
});

it('describes the standing segments and exactly which checklist filters they open', () => {
  const counts = checklistStandingCounts(checklistDeal(), dealId)!;
  expect(checklistStandingParts(counts)).toEqual([
    { k: 'open', n: 119, filter: 'all', sub: [
      { filter: 'finding', n: 117 }, { filter: 'gap', n: 1 }, { filter: 'gone', n: 1 },
    ] },
    { k: 'prog', n: 21, filter: 'open' },
    { k: 'done', n: 2017, sub: [{ filter: 'satisfied', n: 2016 }, { filter: 'person', n: 1 }] },
  ]);
  const plain = checklistStandingParts({ ...counts, person: 0, settled: 2016 });
  expect(plain.at(-1)).toEqual({ k: 'done', n: 2016, filter: 'satisfied' });
});
