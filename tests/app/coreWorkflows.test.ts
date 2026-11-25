// @vitest-environment node
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { MemoryLocal } from '../../src/adapters/local';
import { prepareUnresolved, retryUnresolved, submitUnresolved } from '../../src/app/addUnresolved';
import {
  checklistReviewSession, checklistSelection, listTarget, submitChecklist, type ChecklistReviewChange,
} from '../../src/app/checklistImport';
import { CreateDeal } from '../../src/app/commands/deals';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import { readDealFolder, type DealForm } from '../../src/app/dealFolders';
import { findDealTwin } from '../../src/app/dealSetup';
import { readIssuesList, reviewIssuesList } from '../../src/app/issuesList';
import { importKey, initializeKeptImports, keptImportsReady } from '../../src/app/keptImports';
import { initializeKeptText } from '../../src/app/keptText';
import {
  checklistItemsAsRead, checklistPaste, checklistReading, checklistRequests, checklistSourceLines, tieChecklistLines,
} from '../../src/app/listRead';
import { dealFindings, dealQuestions } from '../../src/app/state';
import type { Store } from '../../src/app/store';
import { firmOf, listId, norm } from '../../src/domain/checklist';
import { ok } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, type RecoveryApp } from './recoveryKit';

const applications: RecoveryApp[] = [];

function application(saved?: RecoveryApp['saved']) {
  const app = recoveryApp(saved);
  applications.push(app);
  return app;
}

async function closeApplication(app: RecoveryApp) {
  app.store.closing();
  await app.repo.close();
  applications.splice(applications.indexOf(app), 1);
}

beforeAll(() => initializeKeptText(new MemoryLocal()));

afterEach(async () => {
  for (const app of [...applications]) await closeApplication(app);
});

async function findScannedDeal(store: Store) {
  const original = { path: '/Due diligence/Southridge/Sponsor data room', label: 'Sponsor data room',
    files: 540, size: '2.4 GB' };
  val(await store.dispatch(CreateDeal, { name: 'Southridge Solar Financing', folders: [original] }));
  const [dealId] = Object.keys(store.get().deals);
  const incoming: DealForm = { name: 'Southridge Project Facility', folders: [], error: '', busy: false };
  store.ui({ newDeal: incoming });
  const path = '/Due diligence/Southridge/Lender data room';
  const scan = vi.fn(async () => ok({ files: 540, size: '2.4 GB' }));
  const room = { dealId, files: 540, matched: 478, printed: 8, same: 8 };
  const sameRoom = vi.fn(async () => ok([room]));
  store.services.docs.scanFolder = scan;
  store.services.docs.sameRoom = sameRoom;
  const { NewDealDraftSession } = await import('../../src/app/newDealDraft');
  const session = new NewDealDraftSession(false, () => {});
  try {
    expect(await readDealFolder(store, session, incoming, path)).toBe(true);
    expect(scan).toHaveBeenCalledExactlyOnceWith(path);
    const scanned = store.get().ui.newDeal!;
    expect(scanned.folders).toEqual([{ path, label: 'Lender data room', files: 540, size: '2.4 GB' }]);
    const twin = await findDealTwin(store, scanned);
    expect(sameRoom).toHaveBeenCalledExactlyOnceWith([path], [dealId]);
    expect(twin).toEqual({ dealId, named: false, room });
    return twin!.dealId;
  } finally {
    session.close();
  }
}

async function importLenderIssues(store: Store, dealId: string) {
  const points = ITEMS.map(({ t }, index) => ({
    n: String(index + 1), title: t, text: `Please address the following lender diligence point: ${t}.`,
    workstream: 'Legal',
  }));
  const subject = 'Subject: Southridge loan documentation issues';
  const body = points.map(({ n, text }) => `${n}. ${text}`).join('\r\n');
  const file = new File([`${subject}\r\n\r\n${body}`], 'Lender issues list.eml');
  const doc = { docId: 'doc_southridge1', doc: file.name };
  const attach = vi.fn(async () => ok(doc));
  const read = vi.fn(async () => ok({ points }));
  store.services.docs.attach = attach;
  store.services.ai.issuesList = read;
  const list = val((await readIssuesList(store, dealId, file))!);
  expect(attach).toHaveBeenCalledExactlyOnceWith(dealId, {
    name: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
  });
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dealId, doc }));
  const review = reviewIssuesList(store.get(), dealId, list, new Set());
  expect(review.fresh).toHaveLength(points.length);
  val(await store.dispatch(ImportIssuesList, { dealId, doc: doc.docId, list: doc.doc, points: review.input }));
  const findings = dealFindings(store.get(), dealId);
  expect(findings).toHaveLength(points.length);
  expect(findings[0].onLists).toContainEqual(expect.objectContaining({ doc: doc.docId }));
  return findings;
}

it('scans a folder, matches its deal, imports lender issues, and adds the resulting questions', async () => {
  const { store } = application();
  await store.boot();
  const dealId = await findScannedDeal(store);
  await store.loadDeal(dealId, { gaps: false });
  const findings = await importLenderIssues(store, dealId);
  expect(findings.length).toBeGreaterThan(100);
  const phraseQuestion = (title: string) => `What has been done to address the following issue: ${title}?`;
  const phrase = vi.fn<NonNullable<AiService['phrase']>>(async ({ items }) =>
    ok(items.map(({ what }) => phraseQuestion(what))));
  phrase.mockImplementationOnce(async ({ items }) =>
    ok(items.map(({ what }, index) => index === 0 ? null : phraseQuestion(what))));
  store.services.ai.phrase = phrase;
  store.services.ai.checklist = async () => ok([]);
  const preview = val((await prepareUnresolved(store, dealId))!);
  expect(preview.points).toHaveLength(findings.length - 1);
  expect(preview.out).toHaveLength(1);
  const retry = await retryUnresolved(store, dealId, preview.out);
  expect(phrase.mock.calls[1][0].items).toEqual(phrase.mock.calls[0][0].items.slice(0, 1));
  const ready = retry?.(preview);
  expect(ready?.out).toEqual([]);
  expect(await submitUnresolved(store, dealId, ready!)).toEqual({ kind: 'added' });
  const questions = dealQuestions(store.get(), dealId);
  expect(questions).toHaveLength(findings.length);
  expect(new Set(questions.map(({ linkedFinding }) => linkedFinding))).toEqual(new Set(findings.map(({ id }) => id)));
  expect(questions.find(({ linkedFinding }) => linkedFinding === findings[0].id)?.text)
    .toBe(phraseQuestion(findings[0].title));
});

async function readMasterChecklist(store: Store, questions: string[], requests: ReturnType<typeof checklistRequests>) {
  const source = checklistPaste(['Portfolio due diligence', ...questions].join('\n'));
  const lines = checklistSourceLines(source, null)!;
  store.services.ai.readList = async ({ lines }) => ok(lines.map((text, index) => ({
    n: index + 1, k: index === 0 ? 'section' : 'item', text,
  })));
  const reader = checklistReading(store, requests);
  const readings = val((await reader.sourceChanged(lines, false, { started: () => {}, finished: () => {} }))!);
  const tied = tieChecklistLines(lines, readings);
  const prepared = checklistItemsAsRead(false, null, { item: null, section: null }, tied)!;
  expect(prepared.items).toHaveLength(questions.length);
  return prepared.items;
}

it('reads, reviews, and installs the master checklist with selected model suggestions', async () => {
  const { store } = application();
  await store.boot();
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
  const key = importKey.checklist();
  const requests = checklistRequests();
  const alternate = 'Verify that the project company took the Contoso Solar interconnection agreement in FY2024.';
  const questions = [...portfolioQuestions(), alternate];
  const items = await readMasterChecklist(store, questions, requests);
  const clearer = 'Provide the executed FY2024 Contoso Solar EPC contract and each amendment and change order';
  const duplicate = { a: 1, b: questions.length - 1, inAgainst: false, why: 'Both ask about the same assignment' };
  const reword = vi.fn(async () => ok([{ at: 0, text: clearer, why: 'Put the reporting period first' }]));
  const sameMeaning = vi.fn(async () => ok({ pairs: [duplicate] }));
  store.services.ai.reword = reword;
  store.services.ai.sameMeaning = sameMeaning;
  const state = store.get();
  const target = listTarget(state, firmOf(state.firmList), 'broad', '');
  const session = checklistReviewSession(store, requests, { started: () => {}, settled: () => {} });
  const plan = session.plan(items, target, { askReword: true, askSame: true }, null, '')!;
  const show = vi.fn<(change: ChecklistReviewChange) => void>();
  await session.next(plan, show);
  expect(reword).toHaveBeenCalledExactlyOnceWith({ items: questions.map(norm) });
  expect(sameMeaning).toHaveBeenCalledExactlyOnceWith({ items: questions.map(norm), against: [] });
  const result = show.mock.lastCall?.[0];
  if (result?.kind !== 'fresh') throw new Error('Expected a checklist review');
  expect(result.review.pairs).toContainEqual(duplicate);
  const { items: selected } = checklistSelection(result.review, new Set([duplicate.b]), new Set([0]));
  expect(selected).toHaveLength(questions.length - 1);
  expect(selected[0]).toMatchObject({ text: clearer, was: items[0].text, section: 'Portfolio due diligence' });
  expect(selected.some(({ text }) => text === norm(alternate))).toBe(false);
  val(await submitChecklist(store, key, target, selected, ''));
  expect(store.get().firmList[listId('broad', '')].items).toEqual(selected);
});
