import { useLayoutEffect, useReducer, useState } from 'preact/hooks';
import { HeadingRowDraft, type Heading, type ReadRow } from '../app/listRead';
import { num } from './counts';

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
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [draft] = useState(() => new HeadingRowDraft(importKey, table, () => redraw(null)));
  useLayoutEffect(() => draft.update(table, sheet, read));
  useLayoutEffect(() => () => draft.dispose(), [draft]);
  const { text, max, headerRow, reason: unused } = draft.view;
  const range = max === undefined ? 'Enter a whole row from 1' : `Enter a whole row from 1 to ${num(max)}`;
  const preview = `The preview uses row ${num(headerRow)}`;
  const reason = unused === 'range' ? range : unused === 'preview' ? preview : undefined;
  const pick = (value: string) => {
    onEdit?.();
    void draft.pick(value, read);
  };
  const noteId = `${id}-unused`;
  // The native number input keeps its step arrows and arrow keys (#380). Its max applies to the accepted sheet only,
  // so a step taken while another sheet is read is not clamped to the old sheet's last row.
  return (
    <label><span>Row</span>
      <input class="field" id={id} type="number" aria-label="Heading row" min={1} step={1} value={text}
        max={max}
        disabled={disabled} onInput={(e) => void pick(e.currentTarget.value)}
        aria-invalid={!!reason || undefined} aria-describedby={reason ? noteId : undefined} title={reason} />
      {reason && <span id={noteId} class="efstate fail" role="alert" title={reason}
        style={{ color: 'light-dark(var(--ink), var(--high))', cursor: 'default' }}>Not used</span>}
    </label>
  );
}
