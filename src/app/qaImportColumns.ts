import { IMPORT_FIELDS, type ImportField, type Mapping } from '../domain/importExport';
import type { ImportTable } from './transfer';

interface ColumnSource {
  sheet: string;
  headerRow: number;
  index: number;
  position?: number;
  heading?: string;
}

interface ColumnPick {
  field: ImportField;
  source: ColumnSource | null;
  unapplied?: true;
}

/** Kept with the accepted table and its mapping so unresolved choices survive reopening (#741). */
export interface QaImportTable extends ImportTable {
  columnPicks?: ColumnPick[];
}

/** The fields whose manual choice could not be found in the accepted read; Import must wait for a new choice (#741). */
export function unappliedImportColumns(table: QaImportTable | null): ImportField[] {
  return (table?.columnPicks ?? []).filter((pick) => pick.unapplied).map(({ field }) => field);
}

/** Older kept layouts include the mapping but lack the explicit pick history and source positions. */
export function restoreImportColumnPicks(table: QaImportTable | null, mapping: Mapping | null) {
  if (!table || !mapping || Array.isArray(table.columnPicks)) return table;
  const columnPicks: ColumnPick[] = [];
  for (const [field] of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column === undefined || column === table.mapping?.[field]) continue;
    columnPicks.push({ field, source: column === null ? null : sourceAt(table, column) });
  }
  return columnPicks.length || table.columnPicks !== undefined ? { ...table, columnPicks } : table;
}

/** A direct choice replaces only the previous choice for its own field. */
export function pickImportColumn(table: QaImportTable, field: ImportField, column: number | null) {
  const source = column === null ? null : sourceAt(table, column);
  const others = table.columnPicks?.filter((pick) => pick.field !== field) ?? [];
  return { ...table, columnPicks: [...others, { field, source }] };
}

/** Reconcile each manual choice against the read that the workflow accepted (#741). */
export function applyImportColumnPicks(before: ImportTable, after: ImportTable, picks: ColumnPick[]) {
  const mapping = { ...after.mapping };
  const columnPicks = picks.map((pick) => {
    const source = withSourcePosition(before, pick.source);
    const column = source ? findColumn(after, source) : null;
    mapping[pick.field] = column;
    if (column !== null) return { field: pick.field, source: sourceAt(after, column) };
    return source ? { ...pick, source, unapplied: true as const } : pick;
  });
  return { table: { ...after, columnPicks }, mapping };
}

function withSourcePosition(table: ImportTable, source: ColumnSource | null): ColumnSource | null {
  if (!source || source.position !== undefined) return source;
  if (source.sheet !== table.sheet || source.headerRow !== table.headerRow) return source;
  return { ...source, position: table.cols?.[source.index] };
}

function sourceAt(table: ImportTable, index: number): ColumnSource {
  const heading = table.columns[index]?.trim().toLowerCase();
  const unique = heading && uniqueHeading(table.columns, heading) !== null;
  return {
    sheet: table.sheet, headerRow: table.headerRow, index, position: table.cols?.[index],
    heading: unique ? heading : undefined,
  };
}

function findColumn(table: ImportTable, source: ColumnSource) {
  if (source.sheet === table.sheet && source.position !== undefined && table.cols) {
    const index = table.cols.indexOf(source.position);
    return index === -1 ? null : index;
  }
  return source.heading ? uniqueHeading(table.columns, source.heading) : null;
}

function uniqueHeading(columns: string[], heading: string) {
  const matches = columns.flatMap((name, index) => name.trim().toLowerCase() === heading ? [index] : []);
  return matches.length === 1 ? matches[0] : null;
}
