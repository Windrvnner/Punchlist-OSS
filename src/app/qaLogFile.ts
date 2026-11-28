import { cell, type KeptAsk } from '../domain/keptMerge';
import { logWrite, type LogWrite } from '../domain/logWrite';
import { keptLogColumns, resolveLogMapping } from '../domain/qaLogLayout';
import { ok, fail, invalid, type Result } from '../domain/result';
import type { Mapping } from '../domain/importExport';
import type { QaLog, Question } from '../domain/model';
import type { SheetEdit } from '../domain/sheets';
import type { QaLogFiles } from '../ports';

/**
 * Where each of a kept edit's rows that the log can't say for sure goes: for each, the index of the row picked in its
 * `rows`, -1 for a row of its own, or -2 to leave it in the archive. Closing the ask returns null for a later update.
 */
export type PlaceKept = (ask: KeptAsk[]) => Promise<number[] | null>;

export const NEW_KEPT_ROW = -1;
export const LEAVE_KEPT_OUT = -2;

/** Each existing row can take at most one of the edits being placed. */
export function keptRowTaken(asks: KeptAsk[], choices: (number | undefined)[], edit: number, candidate: number) {
  const row = asks[edit]?.rows[candidate]?.row;
  return row !== undefined && choices.some((choice, index) =>
    index !== edit && choice !== undefined && asks[index]?.rows[choice]?.row === row);
}

function validKeptPlacement(asks: KeptAsk[], choices: number[]) {
  return choices.length === asks.length && asks.every((ask, edit) => {
    const choice = choices[edit];
    return choice === NEW_KEPT_ROW || choice === LEAVE_KEPT_OUT ||
      (Number.isInteger(choice) && !!ask.rows[choice] && !keptRowTaken(asks, choices, edit, choice));
  });
}

type LogTable = Extract<Awaited<ReturnType<QaLogFiles['read']>>, { ok: true }>['value'];
type KeptLogEdits = NonNullable<LogTable['kept']>;

/** Kept steps rejected by the file are filed as they are, with the omitted edits reported. */
function leftInArchive(kept: KeptLogEdits): KeptLogEdits {
  const files = kept.files.map(({ name, hash, left, steps, clashes }) => ({
    name, hash, ...(left || steps || clashes?.length ? { left: true as const } : {}),
  }));
  return { files, steps: [], clashes: [] };
}

/** Place each retained edit where chosen. Edits left out will be filed in the archive. */
function placeLogEdits(kept: KeptLogEdits, choices: number[], below: number) {
  const picked: SheetEdit[] = [];
  const own: SheetEdit[] = [];
  const clashes = [...kept.clashes];
  const out = new Set<string>();
  let nextNewRow = below + 1;
  for (const [index, edit] of (kept.ask ?? []).entries()) {
    if (choices[index] === LEAVE_KEPT_OUT) {
      out.add(edit.file);
      continue;
    }
    const target = edit.rows[choices[index]];
    if (target) {
      picked.push(...target.steps);
      if (target.clash && !clashes.includes(target.row)) clashes.push(target.row);
      continue;
    }
    const row = nextNewRow++;
    own.push({ kind: 'rows', after: row - 1, count: 1 }, ...edit.add.map(({ col, value }) => cell(row, col, value)));
  }
  const files = kept.files.map((file) => out.has(file.name) ? { ...file, left: true as const } : file);
  return { picked, own, kept: { ...kept, files, clashes: clashes.sort((left, right) => left - right) } };
}

export async function readLinkedLog(files: QaLogFiles, log: QaLog, includeKept: boolean) {
  const { folder, file, sheet, headerRow, headers, mapping } = log;
  const kept = includeKept ? keptLogColumns(mapping) : undefined;
  const table = await files.read({ folder, file }, { sheet, headerRow, layout: { headers, mapping }, kept });
  if (!table.ok) return table;
  const resolved = resolveLogMapping(log, table.value);
  return resolved.ok ? ok({ table: table.value, mapping: resolved.value }) : resolved;
}

type LinkedRead = { table: LogTable; mapping: Mapping };
type WrittenTable =
  | { status: 'written'; table: LogTable; mapping: Mapping; plan: LogWrite; kept?: KeptLogEdits; archive: string }
  | { status: 'later'; by?: string }
  | { status: 'canceled' };

/** Ask only when a retained edit needs the person's choice of row. */
async function placePending(kept: KeptLogEdits | undefined, table: LogTable, plan: LogWrite, place?: PlaceKept) {
  if (!kept?.ask?.length) return ok({ kept, picked: [] as SheetEdit[], own: [] as SheetEdit[] });
  const choices = await place?.(kept.ask);
  if (!choices) return ok(null);
  if (!validKeptPlacement(kept.ask, choices)) {
    return fail(invalid('Each kept edit needs its own log row or placement'));
  }
  const below = table.lastRow - 1 + plan.steps.reduce((count, step) =>
    count + (step.kind === 'rows' ? step.count : 0), 0);
  return ok(placeLogEdits(kept, choices, below));
}

/** Write the current file snapshot, or resolve the layout again if a rejected retained edit requires a reread. */
export async function writeLinkedLog(
  files: QaLogFiles, log: QaLog, current: LinkedRead, questions: Question[], sent: Map<string, Record<string, string>>,
  place?: PlaceKept,
): Promise<Result<WrittenTable>> {
  let { table, mapping } = current;
  let plan = logWrite(table, mapping, questions, sent);
  const placement = await placePending(table.kept, table, plan, place);
  if (!placement.ok) return placement;
  if (!placement.value) return ok({ status: 'canceled' });
  const { picked, own } = placement.value;
  let { kept } = placement.value;
  const steps = [...(kept?.steps ?? []), ...picked, ...plan.steps, ...own];
  // nothing to write (a log just made holds everything) leaves the file alone; what it holds of ours is still recorded
  if (!steps.length) return ok({ status: 'written', table, mapping, plan, kept, archive: '' });
  const { folder, file, sheet } = log;
  const save = (steps: SheetEdit[], stamp: string) => files.save({ folder, file, sheet, steps, stamp });
  let r = await save(steps, table.stamp);
  // A save the log's content refuses with a kept edit's steps (for example, a table ending in a totals row) is retried.
  // it is made again without them, from the log read afresh, and the kept edits go to the archive as they are, never
  // hidden (they would be refused at every update). Any other failure (the share is gone) touches nothing.
  if (!r.ok && r.error.kind === 'rejected' && kept?.steps.length) {
    const reread = await readLinkedLog(files, log, false);
    if (!reread.ok) return reread;
    ({ table, mapping } = reread.value);
    plan = logWrite(table, mapping, questions, sent);
    kept = leftInArchive(kept);
    r = plan.steps.length ? await save(plan.steps, table.stamp) : ok({ status: 'written' as const, archive: '' });
  }
  if (!r.ok) return r;
  if (r.value.status === 'later') return ok({ status: 'later', ...(r.value.by ? { by: r.value.by } : {}) });
  return ok({ status: 'written', table, mapping, plan, kept, archive: r.value.archive });
}
