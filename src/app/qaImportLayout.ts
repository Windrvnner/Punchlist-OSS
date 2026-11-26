import { type ImportField, type Mapping } from '../domain/importExport';
import type { Store } from './store';
import {
  applyImportColumnPicks, pickImportColumn, restoreImportColumnPicks, unappliedColumnsWarning, unappliedImportColumns,
  type QaImportTable,
} from './qaImportColumns';
import { proposeLayout, readImportBytes, type ImportLocation, type ImportTable } from './transfer';
import { SERVICE } from '../control';

export interface QaImportLayoutView {
  table: QaImportTable | null;
  mapping: Mapping | null;
  reading: boolean;
  /** the model is proposing the layout */
  asking: boolean;
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
    if (this.current.asking) this.show({ ...this.current, asking: false });
  }

  /** A manual heading edit takes over from an outstanding proposal only (#380): a sheet read in flight still lands. */
  cancelAsk() {
    if (this.current.asking) this.cancel();
  }

  /**
   * The model proposes the sheet, the heading row and the columns; the app checks the proposal against the file and
   * shows it. Anything the person does meanwhile overtakes it, and it overtakes a sheet read in flight. Returns the
   * error the dialog shows ('' clears it), or undefined to leave it as it is.
   */
  async ask(asked: ImportTable): Promise<string | undefined> {
    const mine = ++this.request;
    this.show({ ...this.current, asking: true, reading: false, wantedSheet: undefined });
    const proposal = await proposeLayout(this.store, asked);
    if (this.request !== mine) return undefined;
    if (proposal.ok) {
      this.propose(proposal.value);
      return '';
    }
    this.show({ ...this.current, asking: false });
    return asked.mapping.text != null ? `${SERVICE} had no better proposal` : undefined;
  }

  replace(table: ImportTable | null, mapping = table?.mapping ?? null) {
    this.cancel();
    this.show(layoutView(restoreImportColumnPicks(table, mapping), mapping));
  }

  /** A proposed layout keeps the choices made while it was awaited; they win over the proposal's columns (#741). */
  propose(proposal: ImportTable) {
    const before = this.current.table;
    const picks = before?.columnPicks ?? [];
    if (!before || !picks.length) return this.replace(proposal);
    this.cancel();
    const { table, mapping } = applyImportColumnPicks(before, proposal, picks);
    this.show(layoutView(table, mapping));
  }

  pick(field: ImportField, column: number | null) {
    const { table, mapping, reading, wantedSheet } = this.current;
    if (!table || !mapping) return;
    const picked = pickImportColumn(table, field, column);
    const view = layoutView(picked, { ...mapping, [field]: column });
    this.show({ ...view, reading, wantedSheet, asking: this.current.asking });
  }

  async reread(where: ImportLocation, accept?: (table: ImportTable) => void) {
    const before = this.current.table;
    if (!before) return;
    const mine = ++this.request;
    this.show({ ...this.current, reading: true, asking: false, wantedSheet: where.sheet, error: '' });
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
  const unapplied = unappliedImportColumns(table);
  const warning = unappliedColumnsWarning(unapplied);
  return { table, mapping, reading: false, asking: false, error: '', unapplied, warning };
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
