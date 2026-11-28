import type { Mapping } from './importExport';
import { fail, ok, rejected, type Result } from './result';

type LogHeader = { label: string; column: number };
export type QaLogLayout = { headers: LogHeader[]; mapping: Record<string, number | null> };
type Columns = { columns: string[]; cols?: number[] };

export function logHeaders({ columns, cols }: Columns): LogHeader[] {
  return columns.map((label, index) => ({ label, column: cols?.[index] ?? index }));
}

export function logLayoutChanged() {
  return rejected('Remap in Import Q&A Log.');
}

/** Keep a selected unnamed column in a log read when it still exists and its cells are blank. */
export function selectedUnnamedColumns(layout: QaLogLayout): number[] {
  return Object.values(layout.mapping).flatMap((index) => {
    const header = index == null ? undefined : layout.headers[index];
    return header && !header.label.trim() ? [header.column] : [];
  });
}

function sameHeadings(previous: LogHeader[], current: LogHeader[]): boolean {
  const oldLabels = previous.filter(({ label }) => label.trim());
  const newLabels = current.filter(({ label }) => label.trim());
  return oldLabels.length === newLabels.length && oldLabels.every(({ label, column }, index) =>
    newLabels[index].label === label && newLabels[index].column === column);
}

function uniqueColumn(headers: LogHeader[], label: string): number {
  const matches = headers.flatMap((header, index) => header.label === label ? [index] : []);
  return matches.length === 1 ? matches[0] : -1;
}

/** Match the person's choices to this read's compact column indexes before using any rows or planning edits (#282). */
export function resolveLogMapping(layout: QaLogLayout, read: Columns): Result<Mapping> {
  const current = logHeaders(read);
  const same = sameHeadings(layout.headers, current);
  const mapping = { ...layout.mapping } as Mapping;
  for (const field of Object.keys(mapping) as (keyof Mapping)[]) {
    const index = mapping[field];
    if (index == null) continue;
    const before = layout.headers[index];
    if (!before) return fail(logLayoutChanged());
    const { label, column } = before;
    if (same) {
      const position = current.findIndex((header) => header.column === column && header.label === label);
      if (position < 0) return fail(logLayoutChanged());
      mapping[field] = position;
      continue;
    }
    const position = uniqueColumn(current, label);
    if (!label.trim() || position < 0 || uniqueColumn(layout.headers, label) !== index) return fail(logLayoutChanged());
    mapping[field] = position;
  }
  return ok(mapping);
}

export function keptLogColumns(mapping: Record<string, number | null>) {
  const { text, n, askedBy } = mapping;
  return text == null ? undefined : {
    text, ...(n == null ? {} : { n }), ...(askedBy == null ? {} : { by: askedBy }),
  };
}
