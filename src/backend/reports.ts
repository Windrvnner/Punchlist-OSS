/**
 * Third-party reports: every issue an outside advisor raises in a report in the data room is a finding
 * (docs/decisions.md, Findings). An independent or technical engineer, an environmental, legal, insurance,
 * model audit, market or any other advisor: anything they flag as an issue is raised, whether or not a checklist item
 * covers it. Where it is unclear whether something is an issue, it is raised; a note on the limits of the advisor's own
 * work is not.
 *
 * The checklist's check raises at most one finding per item, and reads a report only when it is among the documents
 * chosen for an item, so it cannot promise this. This sweep does, in three steps, each written to the deal's check
 * log so that every PC knows what was done and nothing is paid for twice:
 *   1. Sort: the fast model is shown the paths of the deal's documents not sorted yet, a part at a time, and says
 *      which are third-party reports and which it cannot tell from the path (`sorted`).
 *   2. Look: a document it could not tell is sent to the fast model, which reads its first pages and says (`looked`).
 *   3. Read: the standard model reads the whole report for the issues it raises,
 *      and each issue becomes a finding, unless an open or deleted finding on the deal already covers it
 *      (matched by what it is about, unlike a checklist item's problem); one only a closed finding covers is
 *      raised again, naming the closed one, as a checklist item's is. A new draft of a report raises only its new
 *      issues; an issue it no longer raises marks its finding "May be out of date", which never closes it (`read`,
 *      in reportRead.ts).
 *
 * Only the newest draft of a report is read; a blackline, a document in another project's precedents folder and one
 * in a folder this person may not open are not. Reports are read one at a time, so a read is shown what the reads
 * before it raised. A cutoff records the verified issues with the attempt. The next sweep reads the whole file
 * for the remaining issues. Unfinished reads exhaust the existing attempt budget, and Overview lists the reports
 * that are still incomplete (#1212). Work is claimed first, so two PCs seldom pay for
 * the same call; two that start on one report before either claim arrives can both read it, and the second
 * raises again only what it titles differently from the first.
 */
import type { DocRecord } from './documents';
import { list as listOf, readJson, word } from './lenient';
import { unknownIds } from './recordIds';
import { read, type ReportReadResult } from './reportRead';
import { withFewerChanges, type ChangeShare } from './limits';
import {
  type ReportKit, type ReportLine, type ReadLine, type ReportCut, type Owed,
  SORT_PART, TRIES, isCut, isTooLong, isUnreachable, yes, reportPlace,
} from './reportTypes';

export type { ReportKit, ReportLine, ReadIssue, Known, Issue } from './reportTypes';
export { SORT_PART, TRIES } from './reportTypes';

function addCut(cuts: Map<string, ReportCut>, doc: string, cut: ReportCut) {
  const before = cuts.get(doc);
  const issues = [...(before?.issues ?? []), ...cut.issues];
  const unique = new Map(issues.map((row) => [JSON.stringify(row), row]));
  cuts.set(doc, { advisor: before?.advisor || cut.advisor, issues: [...unique.values()] });
}

/** a sort's reply that names a file by an id it was not shown: a failed reply, asked again (#1162) */
const sortUnusable = (part: DocRecord[]) => (text: string) => {
  const reply = readJson(text, SORT_KEYS);
  const named = [...listOf(reply?.reports), ...listOf(reply?.unsure)];
  return unknownIds(named, part.map((r) => r.docId)).length > 0;
};

/** a sort line's verdicts: true a report, false not, null not told by its path. A later sort may tell an unclear one */
function addSorted(verdict: Map<string, boolean | null>, sorted: NonNullable<ReportLine['sorted']>) {
  const reports = new Set(sorted.reports);
  const unsure = new Set(sorted.unsure);
  for (const doc of sorted.docs) {
    if (verdict.has(doc) && verdict.get(doc) !== null) continue;
    verdict.set(doc, reports.has(doc) ? true : unsure.has(doc) ? null : false);
  }
}

/** what the check log says so far: each document's verdict, each report read, the pages owed, and the tries */
export function stateOf(lines: ReportLine[]) {
  const verdict = new Map<string, boolean | null>();
  const read = new Map<string, ReadLine>();
  const tries = new Map<string, number>();
  const cuts = new Map<string, ReportCut>();
  const cited = new Set<string>();
  const paidPlaces = new Set<string>();
  const cutOwed: Array<Owed & { doc: string; cut: true }> = [];
  /** every read line written: two PCs that read one report at once each owe their own pages */
  const reads: ReadLine[] = [];
  const citeKey = (doc: string, finding: string) => `${doc}\u0000${finding}`;
  for (const l of lines) {
    if (l.sorted) addSorted(verdict, l.sorted);
    if (l.looked) verdict.set(l.looked.doc, l.looked.report);
    if (l.read) reads.push(l.read);
    if (l.read && !read.has(l.read.doc)) read.set(l.read.doc, l.read);   // the first read written counts, on every PC
    if (l.cited) cited.add(citeKey(l.cited.doc, l.cited.finding));
    if (l.cutCited) {
      const key = citeKey(l.cutCited.doc, l.cutCited.finding);
      for (const place of l.cutCited.places) paidPlaces.add(JSON.stringify([key, place]));
    }
    if (l.tried) {
      const key = `${l.tried.step}:${l.tried.doc}`;
      tries.set(key, (tries.get(key) ?? 0) + 1);
      if (l.tried.cut) {
        const { doc, cut } = l.tried;
        addCut(cuts, doc, cut);
        for (const o of cut.owe ?? []) cutOwed.push({ ...o, doc, cut: true });
      }
    }
  }
  /** pages owed to findings by reads written, and not added yet */
  const legacyOwed = reads.flatMap((r) =>
    (r.owe ?? []).filter((o) => !cited.has(citeKey(r.doc, o.finding))).map((o) => ({ doc: r.doc, ...o })),
  );
  const owed = [...legacyOwed, ...cutOwed.flatMap((o) => {
    const key = citeKey(o.doc, o.finding);
    const sources = o.sources.filter((s) => !paidPlaces.has(JSON.stringify([key, reportPlace(s)])));
    return sources.length ? [{ ...o, sources }] : [];
  })];
  const triesOf = (step: 'look' | 'read', doc: string) => tries.get(`${step}:${doc}`) ?? 0;
  return { verdict, read, owed, cuts, tries: triesOf };
}

type ReportState = ReturnType<typeof stateOf>;

const unreadReport = (st: ReportState, id: string) => st.verdict.get(id) === true && !st.read.has(id);
const canRead = (st: ReportState, id: string) => unreadReport(st, id) && st.tries('read', id) < TRIES;

export const incompleteReports = (docs: DocRecord[], st: ReportState) => docs
  .filter(({ docId }) => unreadReport(st, docId) && st.tries('read', docId) >= TRIES)
  .map(({ docId, name }) => ({ docId, name }));

function earlierRead(st: ReportState, doc: string): ReadLine | undefined {
  const read = st.read.get(doc);
  if (read) return read;
  const cut = st.cuts.get(doc);
  if (cut?.issues.length) return { doc, advisor: cut.advisor, issues: cut.issues.map((row) => row.issue) };
}

/** the fields a sort's reply is read for */
const SORT_KEYS = ['reports', 'unsure'];

const SORT_ASK = [
  'Which of them are reports by a third-party advisor or consultant: an outside firm’s report, review, assessment,',
  'opinion or memo on the project, such as an independent or technical engineer’s report, an environmental or social',
  'assessment, a legal due diligence report, an insurance advisor’s report, a model audit, a market study, or a tax',
  'or accounting review? Not the deal’s own documents (agreements, permits, the financial model, board papers, the',
  'information memorandum), and not the project company’s own reports.',
].join(' ');

/** the prompt that sorts a part of the deal's paths */
function sortAsk(k: ReportKit, part: DocRecord[]) {
  const paths = part.map((r) => `${r.docId}: ${k.where(r)}`).join('\n');
  return [
    `These are files in the data room of a project-finance deal, each by its id and path:\n${paths}\n`,
    SORT_ASK,
    'List under "unsure" any whose path does not say either way.',
    'Reply as JSON: {"reports": ["an id", "another id"], "unsure": ["an id"]} with the ids of the files, or empty '
      + 'lists.',
  ].join('\n');
}

/** Step 1: the fast model sorts paths it has not seen. A part whose reply cannot be used is left for the next sweep. */
async function sort(k: ReportKit, todo: DocRecord[]) {
  for (let at = 0; at < todo.length; at += SORT_PART) {
    const part = todo.slice(at, at + SORT_PART);
    const prompt = sortAsk(k, part);
    const unusable = sortUnusable(part);
    const input = { kind: 'reportSort', split: true, model: k.models.fast, system: k.system, prompt, unusable };
    let reply: Record<string, unknown> | null;
    try {
      reply = await k.ask(input, SORT_KEYS);
    } catch (e) {
      if (isCut(e)) continue;                  // a list to choose from cut off is no answer (decisions: Cut-off output)
      throw e;
    }
    if (!reply || (!('reports' in reply) && !('unsure' in reply))) continue;
    const pick = (x: unknown) => [...new Set(listOf(x))].filter((d): d is string => typeof d === 'string');
    const reports = pick(reply.reports);
    const unsure = pick(reply.unsure).filter((d) => !reports.includes(d));
    await k.say({ sorted: { docs: part.map((r) => r.docId), reports, unsure } });
  }
}

/**
 * Step 2: the fast model reads the first pages of a document its path left unclear. Null when it cannot say. Refused
 * as too long, it is asked again with fewer of its tracked changes listed, while any are (#1381).
 */
const look = (k: ReportKit, rec: DocRecord) => withFewerChanges((share) => lookOnce(k, rec, share));
async function lookOnce(k: ReportKit, rec: DocRecord, share: ChangeShare): Promise<boolean | null> {
  const s = await k.send(rec, share);
  if (!s) return null;
  const question = SORT_ASK.replace('Which of them are', 'Is it one of the');
  const prompt = [
    `Documents:\n${s.listing}\n`,
    `Read the first pages of ${s.sent[0].rec.docId}. ${question}`,
    'Reply as JSON: {"report": true} or {"report": false}.',
  ].join('\n');
  const input = { kind: 'reportLook', model: k.models.fast, system: k.system, files: s.files, prompt };
  const reply = await k.ask(input, ['report']).catch((e) => {
    if (isCut(e)) return null;
    throw e;
  });
  if (!reply || !('report' in reply)) return null;
  if (yes(reply.report)) return true;
  return reply.report === false || ['false', 'no'].includes(word(reply.report)) ? false : null;
}

/** a step's failure that is the document's own and counts as its try at once; any other is thrown */
function tooLongIsNull(e: unknown): null {
  if (isTooLong(e)) return null;
  throw e;
}

/** Step 1, under its claim: sort the paths not sorted yet */
async function sortFresh(k: ReportKit) {
  const st = stateOf(await k.lines());
  const fresh = k.docs.filter((r) => !st.verdict.has(r.docId));
  if (!fresh.length) return;
  const held = await k.claim(['reports:sort']);
  if (!held.length) return;
  try {
    await sort(k, fresh);
  } finally {
    await k.release(held);
  }
}

/** Step 2, each under its claim: look at each document its path left unclear */
async function lookUnclear(k: ReportKit) {
  const st = stateOf(await k.lines());
  const unclear = k.docs.filter((r) => st.verdict.has(r.docId) && st.verdict.get(r.docId) === null);
  for (const rec of unclear.filter((r) => st.tries('look', r.docId) < TRIES)) {
    const held = await k.claim([`reports:look:${rec.docId}`]);
    if (!held.length) continue;
    try {
      const is = await look(k, rec).catch(tooLongIsNull);
      if (is === null) await k.say({ tried: { doc: rec.docId, step: 'look' } });
      else await k.say({ looked: { doc: rec.docId, report: is } });
    } finally {
      await k.release(held);
    }
  }
}

/** pages owed to findings by earlier reads: no call to the model; one still in two versions keeps waiting */
async function payOwed(k: ReportKit) {
  for (const o of stateOf(await k.lines()).owed) {
    if (!(await k.cite(o.finding, o.sources))) continue;
    const cited = { doc: o.doc, finding: o.finding };
    if ('cut' in o) await k.say({ cutCited: { ...cited, places: o.sources.map(reportPlace) } });
    else await k.say({ cited });
  }
}

/** a sweep's count: reports read, and findings raised by them */
interface Count { read: number; raised: number }

async function triedRead(k: ReportKit, st: ReportState, doc: string, cut?: ReportCut) {
  await k.say({ tried: { doc, step: 'read', ...(cut ? { cut } : {}) } });
  if ((cut || st.cuts.has(doc)) && st.tries('read', doc) < TRIES - 1) k.again?.();
}

/** Write what a read came to. True when the model answered, which shows the service is taking calls. */
async function readDone(
  k: ReportKit, st: ReportState, rec: DocRecord, got: Exclude<ReportReadResult, 'lost'>,
  before: ReadLine | undefined, count: Count,
) {
  if (got === 'not') {
    await k.say({ looked: { doc: rec.docId, report: false } });
    return true;
  }
  if (!got || 'cut' in got) {
    await triedRead(k, st, rec.docId, got?.cut);
    return true;
  }
  for (const f of got.dropped ?? []) await k.mark(f, `No longer raised in ${rec.name}`);
  await k.say({ read: got });
  const isNew = (finding?: string) => finding && !before?.issues.some((b) => b.finding === finding);
  count.read++;
  count.raised += got.issues.filter((x) => isNew(x.finding)).length;
  return true;
}

/** Read one report, under its claim. True when the model was asked and answered. */
async function readOne(k: ReportKit, rec: DocRecord, count: Count): Promise<boolean> {
  const held = await k.claim([`reports:read:${rec.docId}`]);
  if (!held.length) return false;
  try {
    const now = stateOf(await k.lines());
    if (!canRead(now, rec.docId)) return false;
    const before = (k.earlier.get(rec.docId) ?? []).map((doc) => earlierRead(now, doc)).find(Boolean);
    const last = now.tries('read', rec.docId) >= TRIES - 1;
    const got = await read(k, rec, before, last, now.cuts.get(rec.docId)).catch(tooLongIsNull);
    if (got === 'lost') return false;          // another PC took the read over, or this PC cannot send it
    return await readDone(k, now, rec, got, before, count);
  } finally {
    await k.release(held);
  }
}

/** A deferred failure can count only if the report is still due when the claim is reacquired. */
async function triedDeferred(k: ReportKit, doc: string) {
  const held = await k.claim([`reports:read:${doc}`]);
  if (!held.length) return;
  try {
    const st = stateOf(await k.lines());
    if (canRead(st, doc)) await triedRead(k, st, doc);
  } finally {
    await k.release(held);
  }
}

/**
 * Step 3: every report not read yet, one at a time. Each read is shown the findings the reads before it raised, so two
 * reports that raise the same issue make one finding. The service out of reach stops the sweep. Any other failure may
 * be the document's (a file the service will not take) or the deal's (a usage limit, a bad key), so the sweep goes on
 * to the next report, and one that failed is the document's only if a later report is read: then it counts as that
 * document's try. Failures with none read after them stop the sweep with no try counted, to be tried again; a failing
 * report never holds up the rest.
 */
async function readAll(k: ReportKit, count: Count) {
  const st = stateOf(await k.lines());
  const todo = k.docs.filter(({ docId }) => canRead(st, docId));
  const failed: { doc: string; e: unknown }[] = [];
  for (const rec of todo) {
    try {
      if (!(await readOne(k, rec, count))) continue;
      for (const f of failed.splice(0)) await triedDeferred(k, f.doc);
    } catch (e) {
      if (isUnreachable(e)) throw e;
      failed.push({ doc: rec.docId, e });
    }
  }
  if (failed.length) throw failed[0].e;
}

/**
 * One sweep over a deal: sort what has not been sorted, look at what could not be told, add the pages owed, and read
 * every report not read yet. Throws when the service fails; whatever was written by then stands.
 */
export async function sweep(k: ReportKit): Promise<Count> {
  await sortFresh(k);
  await lookUnclear(k);
  await payOwed(k);
  const count: Count = { read: 0, raised: 0 };
  await readAll(k, count);
  return count;
}
