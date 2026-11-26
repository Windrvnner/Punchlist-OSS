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
import { SetResponse } from '../../src/app/commands/questions';
import { readDealFolder, type DealForm } from '../../src/app/dealFolders';
import { findDealTwin } from '../../src/app/dealSetup';
import {
  keepResponseVersion, responseMergeView, selectResponseMerge, watchResponseMerges,
} from '../../src/app/drafting';
import { readIssuesList, reviewIssuesList } from '../../src/app/issuesList';
import { importKey, initializeKeptImports, keptImportsReady } from '../../src/app/keptImports';
import { initializeKeptText } from '../../src/app/keptText';
import {
  checklistItemsAsRead, checklistPaste, checklistReading, checklistRequests, checklistSourceLines, tieChecklistLines,
} from '../../src/app/listRead';
import {
  keepQaImport, keptQaImport, loadQaImport, prepareQaImport, submitQaImport, type QaChoices,
} from '../../src/app/qaImport';
import { logOf, updateQaLog } from '../../src/app/qaLog';
import { dealFindings, dealQuestions, qaKept } from '../../src/app/state';
import type { Store } from '../../src/app/store';
import { proposeLayout } from '../../src/app/transfer';
import { firmOf, listId, norm } from '../../src/domain/checklist';
import { cell } from '../../src/domain/keptMerge';
import { ok } from '../../src/domain/result';
import type { AiService, QaLogFiles } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal, type RecoveryApp } from './recoveryKit';

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
  const file = new File([`${subject}\r\n\r\n${body}`], 'Lender issues list.txt');
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

const LOG_NAME = 'Southridge lender requests.csv';
const LOG_COLUMNS = ['Number', 'Lender inquiry', 'Sponsor reply'];
const BASE_RESPONSE = 'Lender counsel received the draft EPC contract.';
const APP_RESPONSE = 'The signed EPC contract is in the Construction folder.';
const LOG_RESPONSE = 'The first change order is in the Construction Change Orders folder.';
const MERGED_RESPONSE = `${APP_RESPONSE} ${LOG_RESPONSE}`;

async function retainLenderLog(store: Store, dealId: string, rows: string[][]) {
  const grid = [['Southridge lender requests'], LOG_COLUMNS, ...rows];
  const { bytes } = val(await store.services.sheets.write('Sheet1', grid));
  const file = new File([bytes.slice().buffer], LOG_NAME);
  store.services.fs.pathFor = () => `/Due diligence/Southridge/${LOG_NAME}`;
  const layout = vi.fn(async () => ok({
    sheet: 'Sheet1', headerRow: 2, fields: { text: 'Lender inquiry', response: 'Sponsor reply' },
  }));
  store.services.ai.layout = layout;
  const loaded = val(await loadQaImport(store, dealId, file));
  expect(loaded.askForLayout).toBe(true);
  const table = val(await proposeLayout(store, loaded.table));
  expect(layout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fileName: LOG_NAME }));
  expect(table).toMatchObject({ headerRow: 2, proposedByAi: true, mapping: { n: 0, text: 1, response: 2 } });
  const choices: QaChoices = {
    mapping: table.mapping, mode: 'append', path: loaded.path, answered: true, makeLog: true, touched: true,
  };
  keepQaImport(importKey.qa(dealId), table, choices);
  return { bytes, choices };
}

function standInForLog(store: Store, rows: string[][]) {
  const save = vi.fn<QaLogFiles['save']>(async () =>
    ok({ status: 'written', archive: 'Southridge lender archive.csv' }));
  const read = vi.fn<QaLogFiles['read']>(async () => ok({
    columns: LOG_COLUMNS, cols: [0, 1, 2], rows, lines: rows.map((_, index) => index + 3),
    lastRow: rows.length + 2, stamp: 'counsel-revision',
  }));
  store.services.qaLogs = { ...store.services.qaLogs!, read, save };
  return { read, save };
}

async function mergeAndUpdateLog(store: Store, dealId: string, rows: string[][]) {
  const [question] = dealQuestions(store.get(), dealId);
  const { read, save } = standInForLog(store, [[rows[0][0], rows[0][1], LOG_RESPONSE], ...rows.slice(1)]);
  val(await store.dispatch(SetResponse, { dealId, questionId: question.id, response: APP_RESPONSE }));
  expect(await updateQaLog(store, dealId)).toMatchObject({ kind: 'updated', versions: 1, action: { kind: 'resolve' } });
  expect(save).not.toHaveBeenCalled();
  const current = store.get().questions[question.id];
  const kept = qaKept(store.get(), current);
  expect(kept.response).toBe(LOG_RESPONSE);
  const merge = vi.fn(async () => ok({ text: MERGED_RESPONSE }));
  store.services.ai.merge = merge;
  const heard = vi.fn();
  const stop = watchResponseMerges(heard);
  try {
    expect(selectResponseMerge(store, current, kept.response)).toEqual({ text: '', busy: true });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledExactlyOnceWith(question.id, undefined));
    expect(merge).toHaveBeenCalledExactlyOnceWith({
      dealId, question: question.text, app: APP_RESPONSE, log: LOG_RESPONSE,
    });
    const shown = responseMergeView(question.id);
    expect(shown).toMatchObject({ hasDraft: true, busy: false, draft: { text: MERGED_RESPONSE } });
    const seen = logOf(store, dealId)?.last?.at;
    val(await keepResponseVersion(store, dealId, question.id, 'merged', {
      merged: shown.draft!.text, fields: shown.fields, seen,
    }));
  } finally {
    stop();
  }
  expect(store.get().questions[question.id]).toMatchObject({ response: MERGED_RESPONSE, provenance: { origin: 'ai' } });
  expect(await updateQaLog(store, dealId)).toMatchObject({ kind: 'updated', versions: 0, counts: { updated: 1 } });
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ file: LOG_NAME }), expect.anything());
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    file: LOG_NAME, steps: [cell(2, 2, MERGED_RESPONSE)], stamp: 'counsel-revision',
  }));
  expect(logOf(store, dealId)?.last?.sent[question.id].response).toBe(MERGED_RESPONSE);
}

it('restores a kept Q&A import, merges a conflicting answer, and updates the external log', async () => {
  const app = application();
  const dealId = await recoveryDeal(app);
  const port = new MemoryKeptImports();
  initializeKeptImports(port);
  await keptImportsReady;
  const questions = portfolioQuestions().slice(0, 2_000);
  const rows = questions.map((text, index) => [String(index + 1), text, index === 0 ? BASE_RESPONSE : '']);
  const { bytes, choices } = await retainLenderLog(app.store, dealId, rows);
  const key = importKey.qa(dealId);
  await vi.waitFor(async () => expect(await port.read()).toContainEqual({ key, part: 'choices', value: choices }));
  await closeApplication(app);

  const { store } = application(app.saved);
  await store.boot();
  await store.loadDeal(dealId, { gaps: false });
  initializeKeptImports(port);
  await keptImportsReady;
  const saved = keptQaImport(key);
  expect(saved).toMatchObject({ table: { bytes, rows }, choices });
  if (!saved) throw new Error('Expected the kept import to reopen');
  const { prepared } = prepareQaImport(saved.table, saved.choices.mapping);
  val(await submitQaImport(store, dealId, saved, prepared.rows));
  expect(dealQuestions(store.get(), dealId).map(({ text }) => text)).toEqual(questions);
  expect(keptQaImport(key)).toBeNull();
  await mergeAndUpdateLog(store, dealId, rows);
});
