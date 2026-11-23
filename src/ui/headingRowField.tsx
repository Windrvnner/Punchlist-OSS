import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ImportTable } from '../app/transfer';
import { num } from './counts';

type Heading = Pick<ImportTable, 'sheet' | 'headerRow' | 'lastRow'>;
type ReadRow = (row: number, accept: (heading: Heading) => void) => Promise<void>;

/** Keep an unused heading row in the field while the preview shows the accepted table (#380). */
export function HeadingRowField({ id, table, sheet = table.sheet, read, disabled }: {
  id: string;
  table: Heading;
  sheet?: string;
  read: ReadRow;
  disabled?: boolean;
}) {
  const { text, pick, reason } = useHeadingDraft(table, sheet, read);
  const noteId = `${id}-unused`;
  return (
    <label><span>Row</span>
      <input class="field" id={id} inputMode="numeric" aria-label="Heading row" value={text}
        disabled={disabled} onInput={(e) => void pick(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (sheet === table.sheet) stepRow(e, table.lastRow, pick);
        }}
        aria-invalid={!!reason || undefined} aria-describedby={reason ? noteId : undefined} title={reason} />
      {reason && <span id={noteId} class="efstate fail" role="alert" title={reason}
        style={{ color: 'light-dark(var(--ink), var(--high))', cursor: 'default' }}>Not used</span>}
    </label>
  );
}

function useHeadingDraft(table: Heading, sheet: string, read: ReadRow) {
  const { headerRow, lastRow } = table;
  const [text, setText] = useState(String(headerRow));
  const [reading, setReading] = useState(false);
  const base = useRef(table);
  const queuedSheet = useRef<string | null>(null);
  const pending = useRef<{ sheet: string; row: number } | null>(null);

  const pick = async (typed: string) => {
    setText(typed);
    // Bounds belong to the accepted sheet. Wait for the selected sheet before reading its row.
    if (sheet !== table.sheet) {
      queuedSheet.current = sheet;
      return;
    }
    queuedSheet.current = null;
    const row = rowNumber(typed, lastRow);
    const going = pending.current?.sheet === sheet ? pending.current.row : headerRow;
    if (row === null || row === going) return;
    const request = { sheet, row };
    pending.current = request;
    setReading(true);
    await read(row, (accepted) => {
      // A read from this field updates the preview and leaves the latest typed text in place.
      base.current = accepted;
    });
    if (pending.current === request) {
      pending.current = null;
      setReading(false);
    }
  };
  useLayoutEffect(() => {
    if (base.current.sheet === table.sheet && base.current.headerRow === headerRow) {
      if (sheet === table.sheet) queuedSheet.current = null;
      return;
    }
    base.current = table;
    if (queuedSheet.current === table.sheet) void pick(text);
    else {
      queuedSheet.current = null;
      setText(String(headerRow));
    }
  });

  const row = rowNumber(text, lastRow);
  let reason: string | undefined;
  if (row === null) reason = `Enter a whole row from 1 to ${num(lastRow)}`;
  else if (!reading && sheet === table.sheet && row !== headerRow) reason = `The preview uses row ${num(headerRow)}`;
  return { text, pick, reason };
}

/** Preserve the number field's keyboard stepping without giving up its raw input text. */
function stepRow(event: KeyboardEvent, lastRow: number, pick: (text: string) => Promise<void>) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const row = rowNumber((event.currentTarget as HTMLInputElement).value, lastRow);
  if (row === null) return;
  const next = row + (event.key === 'ArrowUp' ? 1 : -1);
  event.preventDefault();
  if (next >= 1 && next <= lastRow) void pick(String(next));
}

/** The text field keeps incomplete numbers that a native number input exposes as an empty value. */
function rowNumber(text: string, lastRow: number): number | null {
  const value = Number(text);
  return /^\d+$/.test(text) && value >= 1 && value <= lastRow ? value : null;
}
