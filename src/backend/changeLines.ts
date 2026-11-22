/**
 * The lines of a change file, as written and as taken in: what each line holds, a version of a record as it is kept,
 * and a record's state (see changeLog.ts, which reads them).
 */
import type { AuditEntry, RecordKind } from '../domain/model';

/**
 * One record written by one transaction. `base` is what the writer had in front of them: none for a new record,
 * several when a person chose between versions.
 */
export interface RecChange {
  kind: RecordKind;
  id: string;
  ver: string;
  base: string[];
  data?: unknown;
  del?: true;
  /** the schema this version's content needs (see schemaOf); absent on older lines, which then take the line's */
  schema?: number;
  /** Original id for a save forwarded to a recovered copy; absent on direct edits and older lines. */
  recoveredFrom?: string;
  /**
   * a delete that takes back a question an import made, so another PC's import of the same question still stands
   */
  undoesImport?: true;
}
/**
 * `remove` is written but not read here: whether a filed record is listed is told by its own versions (see
 * `Combined.index`).
 */
export interface IndexChange {
  dealId: string;
  add?: { kind: RecordKind; id: string }[];
  remove?: { kind: RecordKind; id: string }[];
}
/** One committed transaction: one line of a change file. All of it is there or none of it is. */
export interface Line {
  v: 1;
  pc: string;
  seq: number;
  at: string;
  by: string;
  from: string;
  recs: RecChange[];
  audit?: AuditEntry[];
  index?: IndexChange;
  /** everything filed under this deal is gone, for good */
  purge?: string;
  /**
   * With `purge`: the lines the deleting PC had taken in, by PC, as runs of line numbers (`[first, last]`). A PC that
   * finds a line of its own about the deal outside them had work there the deleting PC never saw, and keeps it as a
   * copy.
   */
  seen?: Record<string, [number, number][]>;
  /** versions withdrawn as if never written: the undo of a choice between versions */
  retract?: string[];
  /**
   * the undo journal entry (on the PC that wrote this) for the action this line is: at its next start that PC knows the
   * action was written
   */
  op?: string;
  /**
   * the record schema of the build that wrote the line (absent: 1). A build does not change a record last written by a
   * newer schema.
   */
  schema?: number;
}
export interface Ver extends RecChange {
  at: string;
  by: string;
  from: string;
  pc: string;
  stamp: string;
  schema: number;
}
export interface RecState {
  kind: RecordKind;
  id: string;
  /**
   * current versions after equal ones are counted once; oldest first, with a delete that stands beside an edit made
   * without knowledge of it last
   */
  heads: Ver[];
  /**
   * every version no other is based on, equal ones not merged: what a new write must be based on, so that it supersedes
   * each of them
   */
  tips: string[];
  /** exactly one current version, and it is not a delete */
  live: boolean;
  /**
   * counts every version of the record taken in, plus every withdrawal, so it only grows as lines arrive; 0 when there
   * is no live record and no clash
   */
  rev: number;
}

const isRecChange = (r: any) =>
  !!r && typeof r.kind === 'string' && typeof r.id === 'string' && typeof r.ver === 'string' && Array.isArray(r.base);
export function isLine(x: any): x is Line {
  if (!x || x.v !== 1 || typeof x.pc !== 'string' || !Number.isInteger(x.seq)) return false;
  if (typeof x.at !== 'string' || typeof x.by !== 'string' || typeof x.from !== 'string') return false;
  return Array.isArray(x.recs) && x.recs.every(isRecChange);
}
