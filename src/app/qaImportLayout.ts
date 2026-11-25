import { IMPORT_FIELDS, type ImportField, type Mapping } from '../domain/importExport';
import type { Store } from './store';
import {
  applyImportColumnPicks, pickImportColumn, restoreImportColumnPicks, type QaImportTable,
} from './qaImportColumns';
import { readImportBytes, type ImportLocation, type ImportTable } from './transfer';

export interface QaImportLayoutView {
  table: QaImportTable | null;
  mapping: Mapping | null;
  reading: boolean;
  wantedSheet?: string;
  error: string;
  unapplied: ImportField[];
  warning: string;
}

/** Owns the accepted Q&A layout and carries manual choices through successive reads (#741). */
export class QaImportLayout {
  private request = 0;
  private current: QaImportLayoutView;

  constructor(
    private store: Store, table: ImportTable | null, mapping: Mapping | null,
    private onChange: (view: QaImportLayoutView) => void,
  ) {
    this.current = layoutView(restoreImportColumnPicks(table, mapping), mapping);
  }

  get view() { return this.current; }

  cancel() {
    this.request++;
  }

  replace(table: ImportTable | null, mapping = table?.mapping ?? null) {
    this.cancel();
    this.show(layoutView(restoreImportColumnPicks(table, mapping), mapping));
  }

  pick(field: ImportField, column: number | null) {
    const { table, mapping, reading, wantedSheet } = this.current;
    if (!table || !mapping) return;
    const picked = pickImportColumn(table, field, column);
    const view = layoutView(picked, { ...mapping, [field]: column });
    this.show({ ...view, reading, wantedSheet });
  }

  async reread(where: ImportLocation, accept?: (table: ImportTable) => void) {
    const before = this.current.table;
    if (!before) return;
    const mine = ++this.request;
    this.show({ ...this.current, reading: true, wantedSheet: where.sheet, error: '' });
    const read = await readImportBytes(this.store, before.name, before.bytes, where);
    if (this.request !== mine) return;
    if (!read.ok) {
      const error = `Could not read ${before.name}: ${read.error.message}`;
      this.show({ ...this.current, reading: false, wantedSheet: undefined, error });
      return;
    }
    const beforeWithPositions = this.hasLegacyPicks(before)
      ? await restorePositions(this.store, before) : before;
    if (this.request !== mine) return;
    const columnPicks = this.current.table?.columnPicks ?? [];
    const { table, mapping } = applyImportColumnPicks(beforeWithPositions, read.value, columnPicks);
    this.show(layoutView(table, mapping));
    accept?.(read.value);
  }

  private hasLegacyPicks(before: ImportTable) {
    return !before.cols && this.current.table?.columnPicks?.some(({ source }) =>
      source?.sheet === before.sheet && source.headerRow === before.headerRow);
  }

  private show(view: QaImportLayoutView) {
    this.current = view;
    this.onChange(view);
  }
}

function layoutView(table: QaImportTable | null, mapping: Mapping | null): QaImportLayoutView {
  const unapplied = (table?.columnPicks ?? []).filter((pick) => pick.unapplied).map(({ field }) => field);
  const labels = IMPORT_FIELDS.filter(([field]) => unapplied.includes(field)).map(([, label]) => label);
  const warning = labels.length ? `Column choice not applied for ${labels.join(', ')}.` : '';
  return { table, mapping, reading: false, error: '', unapplied, warning };
}

/** Recover the old layout's source positions from the same saved bytes, without altering its accepted preview. */
async function restorePositions(store: Store, table: ImportTable) {
  const { name, bytes, sheet, headerRow, columns } = table;
  const read = await readImportBytes(store, name, bytes, { sheet, headerRow }).catch(() => null);
  if (!read?.ok || read.value.sheet !== sheet || read.value.headerRow !== headerRow) return table;
  if (columns.length !== read.value.columns.length) return table;
  if (!columns.every((heading, index) => heading === read.value.columns[index])) return table;
  return { ...table, cols: read.value.cols };
}

