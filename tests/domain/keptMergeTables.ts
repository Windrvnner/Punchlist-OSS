// The tables the kept-edit merge tests read: a log's sheet as the import reads it, and the log with a merge's steps.
import type { KeptTable, KeptMerge } from '../../src/domain/keptMerge';
import { tableFrom, withSteps, type Sheet } from '../../src/domain/sheets';

/** questions in a log at deal scale */
export const N = 2000;
/** a grid read as the import reads the log's sheet */
export const table = (g: string[][]): KeptTable =>
  tableFrom([{ name: 'Log', grid: g }], { sheet: 'Log', headerRow: 1 })!;
/** the log with the merge's steps made, as a grid */
export const after = (log: string[][], steps: KeptMerge['steps']) =>
  (withSteps([{ name: 'Log', grid: log }], 'Log', steps) as Sheet[])[0].grid;
