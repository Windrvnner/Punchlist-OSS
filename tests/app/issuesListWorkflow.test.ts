// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CreateDeal } from '../../src/app/commands/deals';
import { DeleteFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import { readIssuesList, reviewIssuesList } from '../../src/app/issuesList';
import { dealFindings } from '../../src/app/state';
import { WORKSTREAMS } from '../../src/domain/model';
import { ok } from '../../src/domain/result';
import type { AiService, DocumentService, IssuePoint } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
import { make } from './importKit';
import { issuesListClock, planIssuesListSeed } from './issuesListKit';

const DOC = { docId: 'doc_sponsorlist14', doc: 'Credit agreement issues list.pdf' };
const FILE = {
  name: DOC.doc,
  async arrayBuffer() {
    return new TextEncoder().encode('Sponsor comments on the draft project credit agreement').buffer;
  },
};
const POINTS = ITEMS.map(({ t }, index) => ({
  n: String(index + 1), title: t, text: `Please address this diligence point in the revised closing checklist: ${t}.`,
  workstream: 'Legal',
}));

async function seedDeal() {
  const { store, repo } = make();
  await store.boot();
  val(await store.dispatch(CreateDeal, { name: 'Southridge Solar Financing', folders: [] }));
  const dealId = Object.keys(store.get().deals)[0];
  const { writes, index } = planIssuesListSeed(store, dealId, issuesListClock(), ITEMS.map(({ t }) => ({
    dealId, title: t, body: [`The financing diligence file lacks support for this requirement: ${t}.`],
    workstream: 'Legal',
  })));
  val(await repo.transaction({ writes, index }));
  await store.loadDeal(dealId);
  const findings = dealFindings(store.get(), dealId);
  const byTitle = new Map(findings.map((finding) => [finding.title, finding.id]));
  return { store, dealId, findings, byTitle };
}

const proposedIssues: NonNullable<AiService['issuesList']> = async ({ findings }) => {
  const points: IssuePoint[] = POINTS.map((point) => ({ ...point }));
  for (const index of [0, 4, 6]) {
    const named = findings.find((finding) => finding.title === points[index].title)!;
    points[index].same = { finding: named.id };
  }
  points[1].same = { point: 0 };
  points[2] = { ...points[2], text: points[1].text, same: { point: 1 } };
  points[3].same = { point: 2 };
  return ok({ points });
};

it('attaches and reads a deal-scale list, then imports every point to the destination in the preview', async () => {
  const { store, dealId, findings, byTitle } = await seedDeal();
  expect(findings.length).toBeGreaterThan(100);
  const closed = byTitle.get(POINTS[4].title)!;
  const gone = byTitle.get(POINTS[6].title)!;
  const namedListFinding = byTitle.get(POINTS[8].title)!;
  const sameFileFinding = byTitle.get(POINTS[9].title)!;
  val(await store.dispatch(SetFindingStatus, { dealId, findingId: closed, status: 'closed' }));
  val(await store.dispatch(ImportIssuesList, {
    dealId, doc: 'doc_sponsorlist12', list: DOC.doc, points: [{ ...POINTS[0], join: namedListFinding }],
  }));
  val(await store.dispatch(ImportIssuesList, {
    dealId, doc: DOC.docId, list: DOC.doc, points: [{ ...POINTS[3], join: sameFileFinding }],
  }));

  const attach = vi.fn<DocumentService['attach']>(async () => ok(DOC));
  const read = vi.fn(proposedIssues);
  store.services.docs.attach = attach;
  store.services.ai.issuesList = read;
  const list = val((await readIssuesList(store, dealId, FILE))!);
  expect(attach).toHaveBeenCalledExactlyOnceWith(dealId, {
    name: FILE.name, bytes: new Uint8Array(await FILE.arrayBuffer()),
  });
  expect(read).toHaveBeenCalledExactlyOnceWith({
    dealId, doc: DOC, workstreams: WORKSTREAMS,
    findings: findings.map(({ id, title, body }) => ({ id, title, text: body.join('\n\n') })),
  });
  expect(list.points.length).toBeGreaterThan(100);
  expect(dealFindings(store.get(), dealId)).toHaveLength(findings.length);

  val(await store.dispatch(DeleteFinding, { dealId, findingId: gone }));
  const before = new Set(dealFindings(store.get(), dealId).map(({ id }) => id));
  const review = reviewIssuesList(store.get(), dealId, list, new Set([1]));
  expect(review.goes.slice(0, 7)).toEqual([
    store.get().findings[namedListFinding], undefined, 1,
    store.get().findings[sameFileFinding], store.get().findings[closed], undefined, undefined,
  ]);
  expect(review.shown[1]).toBe(store.get().findings[namedListFinding]);
  expect(review.raised).toEqual([0, 1, 2, 3, 4]);
  val(await store.dispatch(ImportIssuesList, { dealId, doc: DOC.docId, list: DOC.doc, points: review.input }));
  const after = dealFindings(store.get(), dealId);
  const made = after.filter(({ id }) => !before.has(id));
  expect(made).toHaveLength(review.fresh.length);
  expect(store.get().findings[closed].status).toBe('closed');

  const written: string[] = [];
  for (const [index, point] of list.points.entries()) {
    const target = review.goes[index];
    const expected = target === undefined
      ? made.find((finding) => finding.onLists?.[0]?.n === point.n && finding.body[0] === point.text)?.id
      : typeof target === 'number' ? written[target] : target.id;
    const marked = after.filter((finding) => finding.onLists?.some((mark) => (
      mark.doc === DOC.docId && mark.n === point.n
    )));
    expect(expected, `point ${point.n} needs a target`).toBeDefined();
    expect(marked.map(({ id }) => id), `point ${point.n}`).toEqual([expected]);
    written.push(marked[0].id);
  }
});

it('stops before the model call when a file selection changes during attachment', async () => {
  const { store } = make();
  let current = true;
  const read = vi.fn(proposedIssues);
  store.services.ai.issuesList = read;
  store.services.docs.attach = async () => {
    current = false;
    return ok(DOC);
  };
  expect(await readIssuesList(store, 'deal', FILE, () => current)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it('keeps an attached name with surrounding spaces as given, and the import agrees with the preview', async () => {
  const { store, dealId, byTitle } = await seedDeal();
  const prior = byTitle.get(POINTS[8].title)!;
  const proposed = byTitle.get(POINTS[0].title)!;
  val(await store.dispatch(ImportIssuesList, {
    dealId, doc: DOC.docId, list: DOC.doc,
    points: POINTS.slice(0, 2).map((point) => ({ ...point, join: prior })),
  }));

  const revised = { docId: 'doc_sponsorlist15', doc: ` ${DOC.doc} ` };
  store.services.docs.attach = async () => ok(revised);
  store.services.ai.issuesList = async () => ok({ points: [
    { ...POINTS[0], same: { finding: proposed } }, POINTS[1], { ...POINTS[2], same: { point: 1 } },
  ] });
  const list = val((await readIssuesList(store, dealId, { ...FILE, name: revised.doc }))!);
  const review = reviewIssuesList(store.get(), dealId, list, new Set());
  // no earlier mark is on a list of this name, so only the model's proposals join
  const goes = review.goes.map((target) => (typeof target === 'number' ? target : target?.id));
  expect(goes).toEqual([proposed, undefined, 1]);
  val(await store.dispatch(ImportIssuesList, { dealId, doc: revised.docId, list: revised.doc, points: review.input }));

  const marks = dealFindings(store.get(), dealId).flatMap((finding) => (finding.onLists ?? [])
    .filter((mark) => mark.doc === revised.docId).map((mark) => ({ n: mark.n, list: mark.list, id: finding.id })));
  expect(marks.map(({ list }) => list)).toEqual([revised.doc, revised.doc, revised.doc]);
  const on = (n: string) => marks.find((mark) => mark.n === n)!.id;
  expect(on(POINTS[0].n)).toBe(proposed);
  expect(on(POINTS[1].n)).toBe(on(POINTS[2].n));
  expect([prior, proposed]).not.toContain(on(POINTS[1].n));
});
