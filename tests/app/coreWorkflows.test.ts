// @vitest-environment node
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { prepareUnresolved, retryUnresolved, submitUnresolved } from '../../src/app/addUnresolved';
import { CreateDeal } from '../../src/app/commands/deals';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import { readDealFolder, type DealForm } from '../../src/app/dealFolders';
import { findDealTwin } from '../../src/app/dealSetup';
import { readIssuesList, reviewIssuesList } from '../../src/app/issuesList';
import { initializeKeptText } from '../../src/app/keptText';
import { dealFindings, dealQuestions } from '../../src/app/state';
import type { Store } from '../../src/app/store';
import { ok } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
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
