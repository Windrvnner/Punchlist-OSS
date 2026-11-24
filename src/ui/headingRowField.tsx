import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ImportTable } from '../app/transfer';
import { num } from './counts';
import { keptImport, keepImport } from './keptImports';

type Heading = Pick<ImportTable, 'sheet' | 'headerRow' | 'lastRow'>;
type ReadRow = (row: number, accept: (heading: Heading) => void) => Promise<void>;
// The numeric forms a native number input accepts, including integral decimals and exponents.
const NUMBER_TEXT = /^-?(?:(\d+)(?:\.(\d+))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/** Keep an unused heading row in the field while the preview shows the accepted table (#380). */
export function HeadingRowField({ id, importKey, table, sheet = table.sheet, read, disabled, onEdit }: {
  id: string;
  importKey: string;
  table: Heading;
  sheet?: string;
  read: ReadRow;
  disabled?: boolean;
  onEdit?: () => void;
}) {
  const { text, pick, reason } = useHeadingDraft(importKey, table, sheet, read, onEdit);
  const noteId = `${id}-unused`;
  // The native number input keeps its step arrows and arrow keys (#380). Its max applies to the accepted sheet only,
  // so a step taken while another sheet is read is not clamped to the old sheet's last row.
  return (
    <label><span>Row</span>
      <input class="field" id={id} type="number" aria-label="Heading row" min={1} step={1} value={text}
        max={sheet === table.sheet ? table.lastRow : undefined}
        disabled={disabled} onInput={(e) => void pick(e.currentTarget.value)}
        aria-invalid={!!reason || undefined} aria-describedby={reason ? noteId : undefined} title={reason} />
      {reason && <span id={noteId} class="efstate fail" role="alert" title={reason}
        style={{ color: 'light-dark(var(--ink), var(--high))', cursor: 'default' }}>Not used</span>}
    </label>
  );
}

function useHeadingDraft(importKey: string, table: Heading, sheet: string, read: ReadRow, onEdit?: () => void) {
  const { headerRow, lastRow } = table;
  const [text, setText] = useState(() => keptHeadingText(importKey, table));
  const latestText = useRef(text);
  const [reading, setReading] = useState(false);
  const base = useRef(table);
  const queuedSheet = useRef<string | null>(null);
  const pending = useRef<{ sheet: string; row: number } | null>(null);

  const keepText = (typed: string) => {
    latestText.current = typed;
    setText(typed);
    keepHeadingText(importKey, table, typed);
  };
  const pick = async (typed: string) => {
    onEdit?.();
    keepText(typed);
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
      keepHeadingText(importKey, accepted, latestText.current);
    });
    if (pending.current === request) {
      pending.current = null;
      setReading(false);
    }
  };
  useLayoutEffect(() => {
    if (pending.current && pending.current.sheet !== sheet) {
      pending.current = null;
      setReading(false);
    }
    if (base.current.sheet === table.sheet && base.current.headerRow === headerRow) {
      if (sheet === table.sheet) queuedSheet.current = null;
      return;
    }
    base.current = table;
    if (queuedSheet.current === table.sheet) void pick(latestText.current);
    else {
      queuedSheet.current = null;
      keepText(String(headerRow));
    }
  });

  // While another sheet is read its last row is unknown, so only the accepted sheet's range is enforced or named.
  const accepted = sheet === table.sheet;
  const row = rowNumber(text, accepted ? lastRow : Number.POSITIVE_INFINITY);
  let reason: string | undefined;
  if (row === null) reason = accepted ? `Enter a whole row from 1 to ${num(lastRow)}` : 'Enter a whole row from 1';
  else if (!reading && accepted && row !== headerRow) reason = `The preview uses row ${num(headerRow)}`;
  return { text, pick, reason };
}

type HeadingDraft = Pick<Heading, 'sheet' | 'headerRow'> & { text: string };

function keptHeadingText(key: string, { sheet, headerRow }: Heading) {
  const draft = keptImport(key)?.headingDraft as Partial<HeadingDraft> | null | undefined;
  return draft?.sheet === sheet && draft.headerRow === headerRow && typeof draft.text === 'string'
    ? draft.text : String(headerRow);
}

function keepHeadingText(key: string, { sheet, headerRow }: Heading, text: string) {
  const headingDraft: HeadingDraft | null = text === String(headerRow) ? null : { sheet, headerRow, text };
  keepImport(key, { headingDraft });
}

/** The heading row a number input's text names, or null when it is not a whole row on the sheet. */
function rowNumber(text: string, lastRow: number): number | null {
  const number = NUMBER_TEXT.exec(text);
  if (!number) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > lastRow) return null;
  // A decimal near an integer can round to that integer as a Number. Check the original digits.
  const [, whole = '', fraction, fractionOnly = '', exponent = '0'] = number;
  const afterDot = fraction ?? fractionOnly;
  const decimalPlaces = afterDot.length - Number(exponent);
  return decimalPlaces > 0 && /[1-9]/.test((whole + afterDot).slice(-decimalPlaces)) ? null : value;
}
