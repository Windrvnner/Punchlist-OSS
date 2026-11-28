import type { KeptAsk } from '../domain/keptMerge';
import type { QaLogLayout } from '../domain/qaLogLayout';
import type { Result } from '../domain/result';
import type { SheetEdit } from '../domain/sheets';

/**
 * The team owns the Q&A log file and can edit it with or without the app. `folder` and `file` identify it.
 */
type QaLogPlace = { folder: string; file: string };
type QaLogReadOptions = {
  sheet: string;
  headerRow: number;
  layout?: QaLogLayout;
  kept?: { text: number; n?: number; by?: number };
};

export interface QaLogFiles {
  /**
   * Read the log as an import reads it. `stamp` identifies those bytes. A linked update verifies `layout` first.
   * With `kept`, resolve the question, number, and Submitted by columns for retained edits. The table reflects
   * `kept.steps`. The update saves those steps with its own and reports `kept.clashes` where the log's value wins.
   * `kept.files` identifies the copies to settle, with `left` for omitted edits and the rows and steps each supplied.
   */
  read(at: QaLogPlace, opts: QaLogReadOptions): Promise<Result<{
    columns: string[];
    cols: number[];
    rows: string[][];
    lines: number[];
    lastRow: number;
    stamp: string;
    kept?: {
      files: { name: string; hash: string; left?: true; clashes?: number[]; steps?: true }[];
      steps: SheetEdit[];
      clashes: number[];
      /** rows that read alike, for the person to say where each goes */
      ask?: (KeptAsk & { file: string })[];
    };
  }>>;
  /**
   * Archive retained edits after saving the update, then remove them from the log folder. An edit the archive refuses
   * is marked as brought in and filed at a later update.
   */
  settle?(req: QaLogPlace & { kept: { name: string; hash: string; left?: boolean }[] })
    : Promise<Result<{ gone: string[] }>>;
  /**
   * Write `steps` into the bytes identified by `stamp`, archiving the version being replaced. An open or changed
   * workbook returns `later`. Its lock file may name the person who has it open.
   */
  save(req: QaLogPlace & { sheet: string; steps: SheetEdit[]; stamp: string })
    : Promise<Result<{ status: 'written'; archive: string } | { status: 'later'; by?: string }>>;
  /** a new log in `folder`, under `file` or, if that name is taken, the first free "name (2).ext"; the name it got */
  create(req: QaLogPlace & { bytes: Uint8Array }): Promise<Result<{ file: string }>>;
}

