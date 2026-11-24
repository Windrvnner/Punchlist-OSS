/**
 * The deal's record of its Q&A log (one per deal, see src/app/qaLog.ts): where the file is, where its table is in it,
 * and what the last update wrote. The file itself is the team's, on their drive (QaLogFiles).
 */
import { z } from 'zod';
import { define, type Upsert } from '../command';
import { DealId, QaLog, Question, QuestionId, QuestionStatus, Finding, type Deal } from '../../domain/model';
import { setResponse, editQuestionField, checkQuestion } from '../../domain/transitions';
import { ok, fail, notFound, rejected, type Result } from '../../domain/result';
import { keepAside } from './keptVersions';
import { cellValue } from '../../domain/logWrite';
import type { ImportField } from '../../domain/importExport';

/** the fields a version may set besides Response and Status (as EditQuestionField takes them) */
const QuestionFieldName = z.enum(['text', 'askedBy', 'received', 'workstream', 'priority', 'respondedBy', 'responded']);

const withLogs = (d: Deal, logs: QaLog[], at: string): Deal => ({ ...d, qaLogs: logs, updatedAt: at });

/** A log imported (the deal's first, or the same file again): the deal's log from now on. What the last update wrote stays, if it had one. */
export const KeepQaLog = define({
  name: 'KeepQaLog',
  input: z.object({ dealId: DealId, log: QaLog.omit({ last: true }) }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; if (!d) return fail(notFound('Deal not found', input.dealId));
    const had = d.qaLogs.find((l) => l.name === input.log.name);
    const log = QaLog.parse({ ...had, ...input.log });
    // one file is one deal's log, even when two PCs import it into two deals at once (#38)
    const taken = fileTaken(state, d.id, log.file, log.folder, 'Choose another file');
    if (taken) return fail(rejected(taken));
    return ok({ dealId: d.id, upserts: [{ kind: 'deal', record: withLogs(d, [...d.qaLogs.filter((l) => l.name !== log.name), log], ctx.at), expectedRev: d.rev }], audit: [], inverse: { command: 'RestoreQaLogs', input: { dealId: d.id, logs: d.qaLogs } } });
  },
});

/** a path as Windows compares it: case and slash direction don't matter, nor a separator at the end */
export const windowsPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');

/**
 * Two deals may share a name, and so may their logs' files: one file is one deal's log, or each would write the other's
 * answers into it. Why `file` in `folder` cannot be this deal's log, or null when it can; `next` says what to do
 * instead.
 */
export function fileTaken(
  state: { deals: Record<string, Deal> }, dealId: string, file: string, folder: string, next = 'Choose another folder',
): string | null {
  const same = (a: string, b: string) => windowsPath(a) === windowsPath(b);
  const sameFile = (l: QaLog) => same(l.folder, folder) && same(l.file, file);
  const taken = Object.values(state.deals).find((x) => x.id !== dealId && x.qaLogs.some(sameFile));
  if (!taken) return null;
  // the file named as the other deal holds it, however it was typed here
  const named = taken.qaLogs.find(sameFile)!.file;
  const deal = `${taken.name}${taken.counterparty ? ` (${taken.counterparty})` : ''}`;
  return `${deal} already uses “${named}” in this folder as its Q&A log. ${next}`;
}

/** The folder the log is in, when it has moved; the file keeps its name. What the app wrote stays: it is about the log's cells. */
export const SetQaLogFolder = define({
  name: 'SetQaLogFolder',
  input: z.object({ dealId: DealId, name: z.string().min(1), folder: z.string().min(1) }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; if (!d) return fail(notFound('Deal not found', input.dealId));
    const had = d.qaLogs.find((l) => l.name === input.name); if (!had) return fail(notFound('This deal has no log of that name', input.name));
    const taken = fileTaken(state, d.id, had.file, input.folder); if (taken) return fail(rejected(taken));
    const logs = d.qaLogs.map((l) => (l.name === input.name ? QaLog.parse({ ...l, folder: input.folder }) : l));
    return ok({ dealId: d.id, upserts: [{ kind: 'deal', record: withLogs(d, logs, ctx.at), expectedRev: d.rev }], audit: [{ kind: 'edited', recordId: d.id, dealId: d.id, field: 'Q&A log folder', to: input.folder }], inverse: { command: 'RestoreQaLogs', input: { dealId: d.id, logs: d.qaLogs } }, message: 'Q&A log folder set' });
  },
});

/** An update saved: what the log holds of the app's, so the next one knows which cells are still the app's. No Undo: the file is written. */
export const RecordQaLogExport = define({
  name: 'RecordQaLogExport',
  input: z.object({ dealId: DealId, name: z.string().min(1), last: QaLog.shape.last.unwrap() }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; if (!d) return fail(notFound('Deal not found', input.dealId));
    const logs = d.qaLogs.map((l) => (l.name === input.name ? { ...l, last: input.last } : l));
    return ok({ dealId: d.id, upserts: [{ kind: 'deal', record: withLogs(d, logs, ctx.at), expectedRev: d.rev }], audit: [] });
  },
});

/** Undo for the two above that have one */
export const RestoreQaLogs = define({
  name: 'RestoreQaLogs',
  input: z.object({ dealId: DealId, logs: z.array(QaLog) }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; if (!d) return fail(notFound('Deal not found', input.dealId));
    // an undo that would put a log back where another deal's log has been since is refused, as a move there would be; only a
    // log whose place the undo changes is looked at, so undoing an import is never refused over a file it leaves alone
    const now = (l: QaLog) => d.qaLogs.find((x) => x.name === l.name);
    for (const l of input.logs) { const was = now(l); const taken = !was || was.folder !== l.folder || was.file !== l.file ? fileTaken(state, d.id, l.file, l.folder) : null; if (taken) return fail(rejected(taken)); }
    return ok({ dealId: d.id, upserts: [{ kind: 'deal', record: withLogs(d, input.logs, ctx.at), expectedRev: d.rev }], audit: [] });
  },
});

/**
 * A person chooses between the two versions of a question's cells (the app's, and the Q&A log's, as the last update left
 * them in `kept`). `set`: the fields the app takes, in its own terms (the log's version, or a merged response); empty when
 * the app's version is kept. `sent`: what the log's cells are to be recorded as holding of the app's, so the next update
 * writes the choice into the file (or leaves it, where the log already says it). The choice is kept on the question
 * (`logPick`, for the update `of`), so it writes that one record and its finding, never the deal's log record. One step,
 * so one Undo puts the question back.
 */
export const ChooseQaVersion = define({
  name: 'ChooseQaVersion',
  input: z.object({ dealId: DealId, questionId: QuestionId, /** the update the choice answers: its `last.at` */ of: z.string(), set: z.record(z.string(), z.string()), sent: z.record(z.string(), z.string()), /** 'ai': the response is a merged draft used as the AI wrote it */ origin: z.enum(['ai', 'human']).default('human') }),
  targets: (s, i) => { const q = s.questions[i.questionId]; return [i.questionId, ...(q?.linkedFinding ? [q.linkedFinding] : [])]; },
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; const log = d?.qaLogs[0]; if (!d || !log?.last) return fail(notFound('This deal has no Q&A log yet', input.dealId));
    // a choice made against an update that another has replaced since is about cells the person no longer sees
    if (log.last.at !== input.of) return fail(rejected('The Q&A log was updated since. Open the question again'));
    const q = state.questions[input.questionId]; if (!q || q.dealId !== d.id) return fail(notFound('Question not found', input.questionId));
    const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
    const r = applyVersion(q, input.set, ctx, linked, input.origin);
    if (!r.ok) return r;
    const { finding } = r.value;
    const had = q.logPick?.of === input.of ? q.logPick.sent : {};
    const next: Question = { ...r.value.next, logPick: { of: input.of, sent: { ...had, ...input.sent } }, updatedAt: ctx.at };
    // nothing is thrown away: the app's version, when the log's or a merged one is taken over it, is listed
    // under Deleted, "Superseded by" the person who chose, and can be restored there (keptVersions). The log's version, when
    // the app's is kept, is not lost either: the update saves the file it replaces to the folder's archive first.
    // the same words with only the AI label changed (a merge used as drafted that repeats the app's) set nothing aside
    const aside = keepAside('question', d.id, q.id, [{ snapshot: q, by: ctx.actor, from: 'In the app', at: q.updatedAt, edited: true }], [{ ...r.value.next, provenance: q.provenance }], state.tombstones);
    const upserts: any[] = [{ kind: 'question', record: next, expectedRev: q.rev }, ...aside.upserts];
    if (finding && linked) upserts.push({ kind: 'finding', record: finding, expectedRev: linked.rev });
    return ok({ dealId: d.id, upserts, ...(aside.ids.length ? { index: { dealId: d.id, add: aside.ids.map((id) => ({ kind: 'tombstone' as const, id })) } } : {}),
      audit: [{ kind: 'edited', recordId: q.id, dealId: d.id, text: 'Version chosen' }],
      inverse: { command: 'RestoreQaVersion', input: { dealId: d.id, questionId: q.id, of: input.of, snapshot: q, finding: finding && linked ? linked : null, entries: aside.ids } } });
  },
});

/** Undo of a choice between versions: the question (its choice with it) and its finding's mark as they were */
export const RestoreQaVersion = define({
  name: 'RestoreQaVersion',
  input: z.object({ dealId: DealId, questionId: QuestionId, /** the update the choice answered */ of: z.string(), snapshot: Question, finding: Finding.nullable(), /** the Deleted entries the choice made */ entries: z.array(z.string()).default([]) }),
  targets: (s, i) => { const q = s.questions[i.questionId]; return [i.questionId, ...(q?.linkedFinding ? [q.linkedFinding] : []), ...i.entries]; },
  plan(state, input, ctx) {
    const q = state.questions[input.questionId]; if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    // once an update has written the choice into the file, putting the question back would not bring the two versions back
    if (state.deals[input.dealId]?.qaLogs[0]?.last?.at !== input.of) return fail(rejected('The Q&A log was updated since, with this choice in it. Change the question instead'));
    const upserts: any[] = [{ kind: 'question', record: { ...input.snapshot, rev: q.rev, updatedAt: ctx.at }, expectedRev: q.rev }];
    const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
    if (input.finding && linked) upserts.push({ kind: 'finding', record: { ...input.finding, rev: linked.rev, updatedAt: ctx.at }, expectedRev: linked.rev });
    // the version the choice set aside is the question again: its entry under Deleted goes (one restored meanwhile is gone already)
    const entries = input.entries.filter((id) => state.tombstones[id]);
    return ok({ dealId: input.dealId, upserts, ...(entries.length ? { removes: entries.map((id) => ({ kind: 'tombstone' as const, id, rev: null })), index: { dealId: input.dealId, remove: entries.map((id) => ({ kind: 'tombstone' as const, id })) } } : {}),
      audit: [{ kind: 'edited', recordId: q.id, dealId: input.dealId, text: 'Restored' }] });
  },
});

/**
 * A question with a version's fields set (`set`, in the app's own terms), as ChooseQaVersion and TakeFromQaLog set them: the
 * response first (`origin`: 'ai' for a merged draft used as the AI wrote it, as AcceptDraft labels one), so a status of
 * Answered taken with it finds one, its finding's mark with it; a status is taken as it is,
 * as a version is put back. Fails when the result is not a valid question.
 */
function applyVersion(
  q: Question,
  set: Record<string, string>,
  ctx: { at: string; actor: string },
  linked: Finding | undefined,
  origin: 'ai' | 'human' = 'human',
): Result<{ next: Question; finding?: Finding }> {
  const tx = { at: ctx.at, actor: ctx.actor };
  let next = q;
  let finding: Finding | undefined;
  if (set.response !== undefined) {
    const r = setResponse(next, set.response, set.response.trim() ? { origin, sources: [], actor: ctx.actor, at: ctx.at } : undefined, linked, tx); if (!r.ok) return r;
    next = r.value.question.record; finding = r.value.finding?.record;
  }
  for (const [k, v] of Object.entries(set)) {
    if (k === 'response') continue;
    if (k === 'status') { const st = QuestionStatus.safeParse(v); if (!st.success) return fail(rejected(`“${v}” is not a status`)); next = { ...next, status: st.data, updatedAt: ctx.at }; continue; }
    const f = QuestionFieldName.safeParse(k); if (!f.success) return fail(rejected(`${k} cannot be set here`));
    const r = editQuestionField(next, f.data, v, tx); if (!r.ok) return r; next = r.value.record;
  }
  if (!Question.safeParse(next).success) return fail(rejected(`Q${q.n}: that version cannot be used as it is`));
  const checked = checkQuestion(next); if (!checked.ok) return checked;
  return ok({ next, ...(finding ? { finding } : {}) });
}

/**
 * The log's cells for a question, without any the app changed after the update compared it: that is the person's newer
 * edit, so the cell is left for two versions (#40)
 */
function stillAsCompared(q: Question, set: Record<string, string>, expected: Record<string, string> | undefined) {
  const changedSince = (k: string) => expected?.[k] !== undefined && cellValue(q, k as ImportField) !== expected[k];
  return Object.fromEntries(Object.entries(set).filter(([k]) => !changedSince(k)));
}

/**
 * An update takes in the cells only the Q&A log changed (an edit in the log is the latest), in one step:
 * `set` by question id, each field in the app's terms. The questions are marked Changed by the log's record (`changed`),
 * which the update writes. A question whose cells cannot be used as they are is left as it is (`skipped`); the next
 * update offers them again. Undo puts the questions back.
 */
export const TakeFromQaLog = define({
  name: 'TakeFromQaLog',
  input: z.object({
    dealId: DealId,
    set: z.record(z.string(), z.record(z.string(), z.string())),
    /** the app's values by question and field as the update compared them */
    expect: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  }),
  targets: (s, i) => [...Object.keys(i.set), ...Object.keys(i.set).map((id) => s.questions[id]?.linkedFinding).filter((x): x is string => !!x)],
  plan(state, input, ctx) {
    const upserts: Upsert[] = [];
    const snapshots: Question[] = [];
    // Apply responses to the same finding in order, then write one revision for the entire update (#336).
    const findingEdits = new Map<string, { original: Finding; latest: Finding }>();
    for (const [id, all] of Object.entries(input.set)) {
      const question = state.questions[id];
      if (!question || question.dealId !== input.dealId) continue;
      const set = stillAsCompared(question, all, input.expect?.[id]);
      if (!Object.keys(set).length) continue;
      const original = question.linkedFinding ? state.findings[question.linkedFinding] : undefined;
      const linked = original && (findingEdits.get(original.id)?.latest ?? original);
      const applied = applyVersion(question, set, ctx, linked);
      if (!applied.ok || applied.value.next === question) continue;
      upserts.push({ kind: 'question', record: applied.value.next, expectedRev: question.rev });
      snapshots.push(question);
      const { finding } = applied.value;
      if (finding && original) findingEdits.set(original.id, { original, latest: finding });
    }
    const findings: Finding[] = [];
    for (const { original, latest } of findingEdits.values()) {
      upserts.push({ kind: 'finding', record: latest, expectedRev: original.rev });
      findings.push(original);
    }
    if (!upserts.length) return ok({ upserts: [], audit: [] });
    return ok({
      dealId: input.dealId,
      upserts,
      audit: snapshots.map((q) => ({
        kind: 'edited', recordId: q.id, dealId: input.dealId, text: 'Changed in the Q&A log',
      })),
      inverse: { command: 'RestoreQuestionSnapshots', input: { dealId: input.dealId, snapshots, findings } },
    });
  },
});

/** Undo of TakeFromQaLog: each question (and its finding's mark) as it was */
export const RestoreQuestionSnapshots = define({
  name: 'RestoreQuestionSnapshots',
  input: z.object({ dealId: DealId, snapshots: z.array(Question), findings: z.array(Finding) }),
  targets: (_s, i) => [...i.snapshots.map((q) => q.id), ...i.findings.map((f) => f.id)],
  plan(state, input, ctx) {
    const upserts: any[] = [];
    for (const snap of input.snapshots) { const q = state.questions[snap.id]; if (q) upserts.push({ kind: 'question', record: { ...snap, rev: q.rev, updatedAt: ctx.at }, expectedRev: q.rev }); }
    for (const was of input.findings) { const f = state.findings[was.id]; if (f) upserts.push({ kind: 'finding', record: { ...was, rev: f.rev, updatedAt: ctx.at }, expectedRev: f.rev }); }
    return ok({ dealId: input.dealId, upserts, audit: input.snapshots.map((q) => ({ kind: 'edited', recordId: q.id, dealId: input.dealId, text: 'Restored' })) });
  },
});
