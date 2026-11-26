/**
 * Import a prepared table into a deal's Q&A log as one transaction: every row
 * lands or none does. Merge matches each row to a question like an XLOOKUP (`importMatches`): the same number, text and
 * sender, else the text and sender alone; it brings back a deleted question a row matches, and takes only the
 * non-empty incoming fields; a row that matches nothing, unless the person accepted a suggestion for it, is a new
 * question. Append always adds.
 * Status comes only from a mapped Status column. Undo restores each touched question to exactly what it
 * was before the batch — once, however many rows named it — and removes the
 * ones the batch created.
 */
import { z } from 'zod';
import { define, type Upsert, type AuditDraft } from '../command';
import { Question, Finding, Tombstone, DealId, QuestionId, FindingId, QuestionStatus, isRealDate } from '../../domain/model';
import { setResponse, setQuestionStatus, checkQuestion } from '../../domain/transitions';
import { numbering } from './questions';
import { matchQuestions, withAccepted, AcceptedMatch } from '../../domain/qaMatch';
import { sameText, sameWords, type ImportRow } from '../../domain/importExport';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { dealQuestions, nextQuestionNumber } from '../state';
import { derivedId } from '../../domain/derivedId';
import { key } from '../../domain/checklist';
import { changedSince } from './undo';
import { commandLabel } from '../commandLabels';
import type { Operation } from '../../domain/model';
import type { State } from '../state';

const Ymd = z.string().refine((v) => v === '' || isRealDate(v));
export const ImportRowSchema = z.object({ line: z.number().int().positive().optional(), n: z.number().int().positive().nullable(), text: z.string().min(1), askedBy: z.string(), received: Ymd, workstream: z.string(), priority: z.enum(['', 'High', 'Medium', 'Low']), response: z.string(), respondedBy: z.string(), responded: Ymd, status: z.union([QuestionStatus, z.literal('')]) });

/** a deal's deleted questions, newest deletion first: their tombstones, and each question as it was, by id */
function deletedQuestions(state: State, dealId: string) {
  const buried = Object.values(state.tombstones)
    .filter((t) => t.kind === 'question' && t.dealId === dealId && !state.questions[t.id])
    .sort((a, b) => b.at.localeCompare(a.at));
  const gone = new Map(buried.map((t) => [t.id, Question.parse({ ...(t.snapshot as object) })]));
  return { buried, gone };
}

/**
 * Which question each row is, by row index, for the import and its preview alike. Merge looks each row up
 * (`matchQuestions`) among the live questions, then the deleted ones, and adds the suggestions the person accepted;
 * Append matches nothing.
 */
export function importMatches(
  state: State, dealId: string, mode: 'merge' | 'append', rows: ImportRow[], accepted: AcceptedMatch[],
): Map<number, string> {
  if (mode !== 'merge') return new Map();
  const pools = [dealQuestions(state, dealId), [...deletedQuestions(state, dealId).gone.values()]];
  const known = new Set(pools.flat().map((q) => q.id));
  return withAccepted(matchQuestions(rows, pools), rows, accepted, known);
}

export const ImportQuestions = define({
  name: 'ImportQuestions',
  input: z.object({
    dealId: DealId,
    mode: z.enum(['merge', 'append']),
    rows: z.array(ImportRowSchema).min(1, 'Nothing to import'),
    /** the person checked "Mark questions that have a response as Answered" */
    answerResponded: z.boolean().default(false),
    /** suggestions the person accepted, for rows that matched nothing */
    accepted: z.array(AcceptedMatch).default([]),
  }),
  targets: (s, i) => [...dealQuestions(s, i.dealId).map((q) => q.id), ...Object.values(s.tombstones).filter((t) => t.kind === 'question' && t.dealId === i.dealId).map((t) => t.id), numbering(i.dealId)],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const c = { at: ctx.at, actor: ctx.actor };
    const originals = new Map(dealQuestions(state, d.id).map((q) => [q.id, q]));
    const work = new Map<string, Question>(originals);                 // current state of every question as rows apply
    const findings = new Map<string, Finding>(); const findingOriginals = new Map<string, Finding>();
    const created: string[] = []; const audit: AuditDraft[] = [];
    // number -> question id, kept up to date as rows apply (rebuilding it per row made large files take minutes)
    const numbers = new Map([...work.values()].map((q) => [q.n, q.id])); const editedNoted = new Set<string>();
    let maxN = nextQuestionNumber(state, d.id) - 1;                    // deleted questions keep their numbers
    // a number the file itself gives is never handed to a row without one: a later row with that number would be read as a change to it, and the first question lost
    const fileNumbers = new Set(input.rows.map((r) => r.n).filter((n): n is number => n != null));
    const nextFree = () => { let n = maxN + 1; while (fileNumbers.has(n)) n++; return n; };
    // a deleted question a row matches is brought back rather than copied
    const { buried, gone } = deletedQuestions(state, d.id);
    // a deleted question's number is never handed to another question, so it can always be restored under it
    const deadNumbers = new Set([...gone.values()].map((q) => q.n));
    const matchOf = importMatches(state, d.id, input.mode, input.rows, input.accepted);
    // A new question's id is made from the deal, the file's own number, the party and the wording, so the same list imported
    // on two PCs before they meet makes the same records, and the change files hold one of each. The id is fixed at
    // creation: an edit or renumbering later never changes it. The k-th row of the file with the same four makes its own
    // question (k is part of the id), and an id the deal already holds, live, deleted or in two versions, passes to the next k,
    // so a question already made, or a row added again by Append, is never a write over another record.
    const held = (qid: string) => !!(state.questions[qid] || state.tombstones[qid] || state.conflicts[qid] || work.has(qid));
    const nth = new Map<string, number>();
    const importedId = (row: ImportRow) => {
      const parts = [d.id, row.n == null ? '' : String(row.n), key(row.askedBy), key(row.text)]; const base = parts.join('\0');
      let k = nth.get(base) ?? 0; let qid = derivedId('q', k ? [...parts, String(k)] : parts);
      while (held(qid)) { k++; qid = derivedId('q', [...parts, String(k)]); }
      nth.set(base, k + 1); return qid;
    };
    // numbers rows of this file took as the file gave them, new or matched
    const took = new Set<number>(); const restored: Tombstone[] = [];
    const linkedOf = (q: Question) => { if (!q.linkedFinding) return undefined; const f = findings.get(q.linkedFinding) ?? state.findings[q.linkedFinding]; if (f && !findingOriginals.has(f.id)) findingOriginals.set(f.id, state.findings[f.id]); return f; };

    for (const [idx, row] of input.rows.entries()) {
      const where = `Row ${row.line ?? idx + 2}`;                       // the line in the person's file, blank rows counted
      const id = matchOf.get(idx); let existing = id ? work.get(id) : undefined;
      if (id && !existing) {                                            // a deleted question, back under its own number unless another now holds it
        const was = gone.get(id)!; const n = numbers.has(was.n) ? nextFree() : was.n; maxN = Math.max(maxN, n);
        existing = { ...was, n }; numbers.set(n, id); restored.push(buried.find((t) => t.id === id)!);
        audit.push({ kind: 'restored', recordId: id, dealId: d.id, text: 'Brought back by import' });
      }
      let q: Question;
      if (existing) {
        if (existing.n === row.n) took.add(row.n);                       // a later new row with this number is kept under it too
        q = { ...existing };
        // a cell of only spaces is as good as empty here: it never overwrites what the log holds. Any other value is
        // compared character for character, as the file holds it (decision: the log's edit wins, exactly as written).
        // A Submitted by that names no one (only a period, say) matched as naming no one, so it leaves the party as it is.
        const given = (k: string, v: string) => (k === 'askedBy' ? key(v) !== '' : v.trim() !== '');
        const fields = ['text', 'askedBy', 'received', 'workstream', 'priority', 'respondedBy', 'responded'] as const;
        for (const k of fields) {
          if (given(k, row[k]) && !sameText(row[k], (q as any)[k])) (q as any)[k] = row[k];
        }
      } else {
        // the file's own number when no question holds it, live or deleted, or when an earlier row of this file took it (both are kept under it,
        // marked so a person renumbers one); otherwise the next free number
        const n = row.n != null && ((!numbers.has(row.n) && !deadNumbers.has(row.n)) || (input.mode === 'merge' && took.has(row.n))) ? row.n : nextFree(); maxN = Math.max(maxN, n); if (n === row.n) took.add(n);
        const id = importedId(row);
        q = Question.parse({
          id,
          dealId: d.id,
          rev: 0,
          createdAt: ctx.at,
          updatedAt: ctx.at,
          n,
          text: row.text,
          askedBy: row.askedBy,
          received: row.received,
          workstream: row.workstream,
          // a row with no priority comes in as High
          priority: row.priority || 'High',
          respondedBy: row.respondedBy,
          responded: row.responded,
        });
        numbers.set(n, id); created.push(id); audit.push({ kind: 'created', recordId: id, dealId: d.id, text: 'Imported' });
      }
      if (row.response.trim() && !sameText(row.response, q.response)) {         // only spaces is no response, as when typed in the app
        const linked = linkedOf(q);
        // the response was written by whoever the file says responded, not by the person running the import (who is in the history entry); a row that names nobody claims no author.
        // The same words with other spaces or line breaks are still the words the response came with: its origin and
        // sources stay, and the file's text is what is stored (#1215).
        const prov = q.provenance && sameWords(row.response, q.response)
          ? q.provenance
          : { origin: 'human' as const, sources: [], actor: row.respondedBy, at: ctx.at };
        const r = setResponse(q, row.response, prov, linked, c);
        if (!r.ok) return r;
        q = { ...r.value.question.record, text: q.text };
        if (r.value.finding) { findings.set(r.value.finding.record.id, r.value.finding.record); audit.push(...r.value.finding.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: r.value.finding!.record.id, dealId: d.id, ref: { questionId: q.id } }))); }
      }
      // Only when the person asked for it, only where the file gives no status of its own, and only for a question still Open.
      const status = row.status || (input.answerResponded && row.response.trim() && q.status === 'open' ? 'answered' as const : '');
      if (status && status !== q.status) {
        const r = setQuestionStatus(q, status, c);
        if (!r.ok) return fail(rejected(`${where}: ${r.error.message}`));
        q = r.value.record;
      }
      const chk = checkQuestion(q); if (!chk.ok) return fail(rejected(`${where}: ${chk.error.message}`));
      q.updatedAt = ctx.at;
      if (existing && !gone.has(q.id) && !editedNoted.has(q.id) && JSON.stringify({ ...existing, updatedAt: '' }) !== JSON.stringify({ ...q, updatedAt: '' })) { editedNoted.add(q.id); audit.push({ kind: 'edited', recordId: q.id, dealId: d.id, text: 'Updated by import' }); }
      work.set(q.id, q);
    }

    const upserts: Upsert[] = []; const restore: Question[] = [];
    for (const q of work.values()) {
      const orig = originals.get(q.id);
      if (!orig) { upserts.push({ kind: 'question', record: q, expectedRev: null }); continue; }
      if (JSON.stringify({ ...orig, updatedAt: '' }) === JSON.stringify({ ...q, updatedAt: '' })) continue;
      upserts.push({ kind: 'question', record: q, expectedRev: orig.rev }); restore.push(orig);
    }
    for (const f of findings.values()) upserts.push({ kind: 'finding', record: f, expectedRev: findingOriginals.get(f.id)!.rev });
    const wroteFindings = [...findings.keys()].map((id) => findingOriginals.get(id)!);
    const updated = restore.length; const back = restored.map((t) => t.id);
    if (!upserts.length) return ok({ upserts: [], audit: [], message: 'Nothing in the file differs from the log' });
    const add = [...created, ...back].map((id) => ({ kind: 'question' as const, id }));
    return ok({
      dealId: d.id, upserts, audit,
      removes: back.map((id) => ({ kind: 'tombstone' as const, id, rev: null })),
      index: add.length ? { dealId: d.id, add, remove: back.map((id) => ({ kind: 'tombstone' as const, id })) } : undefined,
      // only findings this import wrote: a finding it left alone is never put back (#50)
      inverse: {
        command: 'RevertImport',
        input: { dealId: d.id, created, restore, findings: wroteFindings, buried: restored },
      },
      // the file's rows are needed only to run the import again after an interruption: a done import is kept without them, as
      // its last one is kept for "Undo last import" however long ago, and Undo needs only the inverse and results
      settledInput: { dealId: d.id, mode: input.mode },
      message: `Imported · ${created.length} new · ${updated} updated${back.length ? ` · ${back.length} restored` : ''}`,
    });
  },
});

export const RevertImport = define({
  name: 'RevertImport',
  /** buried: the deleted questions the import brought back, as they were deleted, so Undo deletes them again */
  input: z.object({ dealId: DealId, created: z.array(QuestionId), restore: z.array(Question), findings: z.array(Finding), buried: z.array(Tombstone).default([]), /** what the change it takes back was, for the notice and the history; an import when not given */ said: z.string().optional() }),
  targets: (_s, i) => [...i.created, ...i.buried.map((t) => t.id), ...i.restore.map((q) => q.id), ...i.findings.map((f) => f.id)],
  plan(state, input, ctx) {
    const upserts: Upsert[] = []; const removes = []; const reburied: string[] = []; const said = input.said ?? 'Import reverted';
    // A question the import made goes to Recently deleted, as any deleted question does, and the delete is marked as an
    // import's Undo: where another PC imported the same question (same id), that copy still stands once the two meet.
    const binned: string[] = [];
    for (const id of input.created) {
      const q = state.questions[id]; if (!q) continue;
      removes.push({ kind: 'question' as const, id, rev: q.rev, undoesImport: true as const });
      if (!state.tombstones[id]) { upserts.push({ kind: 'tombstone', record: Tombstone.parse({ kind: 'question', dealId: q.dealId, id, title: q.text.slice(0, 120), at: ctx.at, actor: ctx.actor, snapshot: q, undoesImport: true }), expectedRev: null }); binned.push(id); }
    }
    for (const t of input.buried) { const q = state.questions[t.id]; if (!q) continue; removes.push({ kind: 'question' as const, id: t.id, rev: q.rev }); upserts.push({ kind: 'tombstone', record: t, expectedRev: null }); reburied.push(t.id); }
    for (const snap of input.restore) { const q = state.questions[snap.id]; if (!q) return fail(rejected(`Q${snap.n} was deleted since the import`)); upserts.push({ kind: 'question', record: { ...snap, rev: q.rev, updatedAt: ctx.at }, expectedRev: q.rev }); }
    for (const snap of input.findings) { const f = state.findings[snap.id]; if (f) upserts.push({ kind: 'finding', record: { ...snap, rev: f.rev, updatedAt: ctx.at }, expectedRev: f.rev }); }
    return ok({
      dealId: input.dealId, upserts, removes,
      index: removes.length ? { dealId: input.dealId, remove: removes.map((r) => ({ kind: 'question' as const, id: r.id })), ...(reburied.length || binned.length ? { add: [...reburied, ...binned].map((id) => ({ kind: 'tombstone' as const, id })) } : {}) } : undefined,
      audit: [...[...binned, ...reburied].map((id) => ({ kind: 'deleted' as const, recordId: id, dealId: input.dealId, text: said })), ...input.restore.map((q) => ({ kind: 'edited' as const, recordId: q.id, dealId: input.dealId, text: said })), ...input.findings.filter((f) => state.findings[f.id]).map((f) => ({ kind: 'edited' as const, recordId: f.id, dealId: input.dealId, text: said }))],
      message: said,
    });
  },
});

/** A retained import that changed no records has a receipt, but must not replace the last real Undo. */
function unchangedImport(operation: Operation): boolean {
  return operation.state === 'succeeded' && operation.targets.length === 0 && !!operation.results
    && Object.keys(operation.results).length === 0;
}

/**
 * This PC's most recent import into the deal, while it has not been undone: what "Undo last import" in the Q&A menu takes
 * back, at any time after. Only the last one, and only from the journal of the PC that made it.
 * Null while the latest real import is pending or undone. An unchanged import leaves the previous Undo available.
 */
export function lastImport(state: Pick<State, 'ops'>, dealId: string): Operation | undefined {
  const last = Object.values(state.ops).filter((operation) => operation.command === 'ImportQuestions'
    && (operation.state === 'succeeded' || operation.state === 'pending') && !unchangedImport(operation)
    && (operation.input as { dealId?: string } | undefined)?.dealId === dealId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))[0];
  return last?.state === 'succeeded' && !last.undoneBy && last.inverse?.command === 'RevertImport' && last.results ? last : undefined;
}

/** how many questions a notice names before "and N more": the notice shows what fits on its line, and the whole text on hover */
const NAMED = 50;
/**
 * What "Undo last import" would do now, worked out without writing anything: the confirmation shows it before the person
 * goes ahead, and the command does it. `named` are the numbers of the questions changed since, which stay as they are.
 */
export function undoLastImportPlan(state: State, dealId: string) {
  const op = lastImport(state, dealId);
  if (!op) return fail(notFound('No import to undo'));
  const parsed = RevertImport.input.safeParse(op.inverse!.input);
  if (!parsed.success) return fail(rejected('This import cannot be undone on this version of Punchlist'));
  const moved = changedSince(state, op.results!);
  if (moved === null) return fail(rejected('This import cannot be undone on this version of Punchlist'));
  const inv = parsed.data;
  const changed = new Set(moved.map((k) => k.slice(k.indexOf('/') + 1)));   // a question and its tombstone share an id
  // a question whose response marked a finding that has changed since stays as it is too, so the two still agree
  const linkOf = (id: string, snap?: Question) => state.questions[id]?.linkedFinding ?? snap?.linkedFinding;
  const gone = new Map(inv.buried.map((t) => [t.id, t.snapshot as Question | undefined]));
  const theirs = [...inv.restore.map((q) => [q.id, q] as const), ...inv.buried.map((t) => [t.id, gone.get(t.id)] as const)];
  for (const [id, snap] of theirs) { const f = linkOf(id, snap); if (f && changed.has(f)) changed.add(id); }
  const left = new Set([...theirs.map(([id]) => id), ...inv.created].filter((id) => changed.has(id)));
  const held = new Set([...left].map((id) => linkOf(id, inv.restore.find((q) => q.id === id) ?? gone.get(id))).filter(Boolean));
  const keep = { dealId: inv.dealId, created: inv.created.filter((id) => !left.has(id)), restore: inv.restore.filter((q) => !left.has(q.id)), buried: inv.buried.filter((t) => !left.has(t.id)), findings: inv.findings.filter((f) => !changed.has(f.id) && !held.has(f.id)) };
  // named: what is still there to see, and a question the import updated that has been deleted since (it is in Deleted as the import left it)
  const named = [...left].filter((id) => state.questions[id] || inv.restore.some((q) => q.id === id)).map((id) => state.questions[id]?.n ?? inv.restore.find((q) => q.id === id)!.n).sort((a, b) => a - b);
  if (!keep.created.length && !keep.restore.length && !keep.buried.length) return fail(rejected('Nothing to undo: all of the import changed since'));
  // what goes to Deleted: the questions it added, and the deleted ones it brought back, that are still there
  const removed = keep.created.filter((id) => state.questions[id]).length + keep.buried.filter((t) => state.questions[t.id]).length;
  return ok({ op, keep, named, removed, restored: keep.restore.length });
}

/**
 * Takes back the last import, however long ago, as far as it still can. What the import wrote and nobody has
 * changed since is taken back as the notice's Undo would: the questions it added go to Deleted, deleted questions it
 * brought back are deleted again, and the questions it updated are put back as they were. A question changed since, by
 * anyone, is left as it is and named in the notice, with the finding its response marked. A question the import added
 * and someone has deleted since is already gone, and is not named.
 */
export const UndoLastImport = define({
  name: 'UndoLastImport',
  input: z.object({ dealId: DealId }),
  targets: (s, i) => lastImport(s, i.dealId)?.targets ?? [],
  plan(state, input, ctx) {
    const w = undoLastImportPlan(state, input.dealId);
    if (!w.ok) return w;
    const { op, keep, named, removed } = w.value;
    // the notice is one line: the count leads, then the numbers, and what does not fit shows on hover
    const kept = named.length ? `, except ${named.length} changed since: ${named.slice(0, NAMED).map((n) => `Q${n}`).join(', ')}${named.length > NAMED ? ` and ${named.length - NAMED} more` : ''}` : '';
    const r = RevertImport.plan(state, keep, ctx);
    if (!r.ok) return r;
    return ok({
      ...r.value,
      // the import is marked undone in the same transaction, so neither its notice nor the menu offers it again
      upserts: [...r.value.upserts, { kind: 'op', record: { ...op, undoneBy: ctx.opId }, expectedRev: 'any' }],
      audit: r.value.audit.map((a) => ({ ...a, kind: 'undone' as const, text: a.text ?? `Undid ${commandLabel(op.command, op.input)}`, undoes: op.id })),
      inverse: undefined,
      message: `Import undone${kept || [removed && ` · ${removed} to Deleted`, keep.restore.length && ` · ${keep.restore.length} back as they were`].filter(Boolean).join('')}`,   // in the words of its confirmation
    });
  },
});
export { FindingId };
