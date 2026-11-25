/**
 * The Q&A import once a file is read: one row per choice (where the table is, which column holds what, what happens to
 * questions the deal already has), a preview of the first rows, what the import will overwrite, and the footer that
 * says what Import will do.
 */
import { fmtDate } from './hooks';
import { LeaveFoot } from './dialogs';
import { checkedOf, chosenOf } from './fieldValue';
import { showTip, hideTip } from './tip';
import { num, plural } from './counts';
import { titleStyle } from './titleStyle';
import { HeadingRowField } from './headingRowField';
import { IMPORT_FIELDS, type Mapping, type ImportField, type Prepared } from '../domain/importExport';
import type { ImportMode, QaPreviewRow } from '../app/qaImport';
import { logChoice } from '../app/qaLog';
import { SERVICE, AI_LABEL } from '../control';
import type { ImportTable, ImportChange } from '../app/transfer';
import type { Suggestion } from '../app/commands/importMatching';
import type { Store } from '../app/store';
import type { Busy, ImportPlan, QaImportActions, QaImportState } from './qaImport';

/** The unread dates and values the footer's tooltip names; the rest are counted */
const UNREAD_NAMED = 8;
const MERGE_TIP = 'Matched by wording, then by number';

type ReadQa = QaImportState & { table: ImportTable; mapping: Mapping };

export function QaImportForm({ store, dealId, qa, plan, actions }: {
  store: Store;
  dealId: string;
  qa: ReadQa;
  plan: ImportPlan;
  actions: QaImportActions;
}) {
  const { table, mapping, busy, mode } = qa;
  const importing = busy === 'importing';
  const onMakeLog = (on: boolean) => {
    qa.touched.current = true;
    qa.setMakeLog(on);
  };
  return (
    <>
      <FileRow table={table} importing={importing} onChange={actions.changeFile}
        onStartOver={() => qa.setRestart(true)} />
      {logChoice(store, dealId, qa.path) === 'new' && (
        <MakeLogRow makeLog={qa.makeLog} importing={importing} onPick={onMakeLog} />
      )}
      <HeadingsRow importKey={qa.key} table={table} busy={busy} wantedSheet={qa.wantedSheet} actions={actions} />
      <ColumnsRow table={table} mapping={mapping} unapplied={qa.unapplied}
        importing={importing} onMap={actions.pickColumn} />
      <PreviewRow mapping={mapping} rows={plan.previewRows} />
      <ModeRow mode={mode} importing={importing} onPick={qa.setMode} />
      {mapping.response != null && <AnsweredRow answered={qa.answered} importing={importing} onPick={qa.setAnswered} />}
      {mode === 'merge' && !!plan.preview?.changes.length && <ChangesRow changes={plan.preview.changes} />}
      {mode === 'merge' && !!plan.preview?.suggestions.length && <SuggestionsRow qa={qa} suggestions={plan.preview.suggestions} />}
      {qa.restart
        ? <LeaveFoot id="im-restart-ask" ask="Clear this import and start over?" go="Start Over"
          keep={() => qa.setRestart(false)} leave={actions.startOver} />
        : <ImportFoot qa={qa} plan={plan} onImport={() => void actions.run()} />}
    </>
  );
}

/** The file's name and size, whether the model proposed its layout, and the "change" and "start over" links */
function FileRow({ table, importing, onChange, onStartOver }: {
  table: ImportTable;
  importing: boolean;
  onChange: () => void;
  onStartOver: () => void;
}) {
  return (
    <div class="srow"><div class="k">File</div><div class="imfile">
      {table.name} · {plural(table.rows.length, 'row')}
      {table.proposedByAi ? ` · layout proposed by ${AI_LABEL}` : ''}{' '}
      <button type="button" class="linkb" id="im-back" disabled={importing} onClick={onChange}>change</button>{' '}
      <button type="button" class="linkb" id="im-restart" disabled={importing} onClick={onStartOver}>start over</button>
    </div></div>
  );
}

function MakeLogRow({ makeLog, importing, onPick }: {
  makeLog: boolean;
  importing: boolean;
  onPick: (on: boolean) => void;
}) {
  return (
    <div class="srow"><div class="k">Q&A log</div><label class="xcheck">
      <input type="checkbox" id="im-makelog" checked={makeLog} disabled={importing}
        onChange={(e) => onPick(checkedOf(e))} />
      <span>Make this the deal’s Q&A log</span>
    </label></div>
  );
}

/** Where the table is: its sheet and heading row, which the person can change or ask the model to find */
function HeadingsRow({ importKey, table, busy, wantedSheet, actions }: {
  importKey: string; table: ImportTable; busy: Busy; wantedSheet?: string; actions: QaImportActions;
}) {
  const importing = busy === 'importing';
  const sheet = (busy === 'reading' && wantedSheet) || table.sheet;
  return (
    <div class="srow"><div class="k">Headings</div><div class="imwhere">
      {table.sheets.length > 1 && <label><span>Sheet</span>
        <select class="field" id="im-sheet" aria-label="Sheet" value={sheet} disabled={importing}
          onChange={(e) => void actions.reread({ sheet: chosenOf(e) })}>
          {table.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
        </select>
      </label>}
      <HeadingRowField id="im-header" importKey={importKey} table={table} sheet={sheet} disabled={importing}
        onEdit={actions.cancelProposal}
        read={(headerRow, accept) => actions.reread({ sheet, headerRow }, accept)} />
      {actions.canAsk && (
        <button type="button" class="linkb" id="im-ask" disabled={!!busy} onClick={() => void actions.askAi(table)}>
          {busy === 'asking' ? `Asking ${SERVICE}` : `Ask ${SERVICE} to Find the Table`}
        </button>
      )}
    </div></div>
  );
}

/** Which of the file's columns holds each field. The question must have one; any other can be "not in file" */
function ColumnsRow({ table, mapping, unapplied, importing, onMap }: {
  table: ImportTable;
  mapping: Mapping;
  unapplied: ImportField[];
  importing: boolean;
  onMap: (field: ImportField, column: number | null) => void;
}) {
  return (
    <div class="srow top"><div class="k">Columns</div><div class="immap">
      {IMPORT_FIELDS.map(([field, label]) => (
        <ColumnPick key={field} field={field} label={label} columns={table.columns} value={mapping[field]}
          unapplied={unapplied.includes(field)} importing={importing} onMap={onMap} />))}
    </div></div>
  );
}

function ColumnPick({ field, label, columns, value, unapplied, importing, onMap }: {
  field: ImportField;
  label: string;
  columns: string[];
  value: number | null;
  unapplied: boolean;
  importing: boolean;
  onMap: (field: ImportField, column: number | null) => void;
}) {
  const chosen = unapplied ? 'unapplied' : value == null ? '' : String(value);
  return (
    <label><span>{label}</span>
      <select class="field" aria-label={label} data-immap={field} disabled={importing}
        value={chosen} aria-invalid={unapplied || undefined} aria-describedby={unapplied ? 'im-line' : undefined}
        onChange={(event) => {
          const option = chosenOf(event);
          if (option !== 'unapplied') onMap(field, option === '' ? null : +option);
        }}>
        {unapplied && <option value="unapplied" disabled>Choose a Column</option>}
        {field === 'text' && !unapplied && <option value="">Choose a Column</option>}
        {/* Columns stay in file order, with “not in file” last. */}
        {columns.map((name, i) => <option key={i} value={String(i)}>{name || `(column ${i + 1})`}</option>)}
        {field !== 'text' && <option value="">— not in file —</option>}
      </select>
    </label>
  );
}

/** The first rows with a question, in the mapped columns */
function PreviewRow({ mapping, rows }: { mapping: Mapping; rows: QaPreviewRow[] }) {
  // the number is left out of the preview: the question and response need the width
  const shown = IMPORT_FIELDS.filter(([field]) => field !== 'n' && mapping[field] != null);
  return (
    <div class="srow top"><div class="k">Preview</div><div class="imprev"><table>
      <thead><tr>{shown.map(([field, label]) => <th key={field} data-k={field}>{titleStyle(label)}</th>)}</tr></thead>
      <tbody>{rows.length
        ? rows.map((row, i) => <tr key={i}>
          {shown.map(([field]) => {
            const value = previewCell(field, row, mapping);
            return <td key={field} title={value}>{value}</td>;
          })}
        </tr>)
        : <tr><td colSpan={shown.length || 1} class="emptyline" style="margin:0;padding:10px">
          No rows with a question
        </td></tr>}
      </tbody>
    </table></div></div>
  );
}

/**
 * A preview cell's words. A date shows as the import will read it, so one valid both ways shows the reading its
 * context chose; one that can't be read shows a dash.
 */
function previewCell(field: ImportField, row: QaPreviewRow, mapping: Mapping) {
  const value = String(row.cells[mapping[field]!] ?? '');
  if (field !== 'received' && field !== 'responded') return value;
  const iso = row.dates[field];
  if (iso) return fmtDate(iso);
  return value.trim() ? '—' : '';
}

/** What happens to questions the deal already has: merged, or added again as new */
function ModeRow({ mode, importing, onPick }: {
  mode: ImportMode;
  importing: boolean;
  onPick: (mode: ImportMode) => void;
}) {
  const tip = (e: Event) => showTip(e.currentTarget as HTMLElement, MERGE_TIP);
  const untip = (e: Event) => hideTip(e.currentTarget as HTMLElement);
  return (
    <div class="srow"><div class="k">Existing Questions</div><div class="seg">
      <button type="button" data-immode="merge" disabled={importing} class={mode === 'merge' ? 'on' : ''}
        aria-description={MERGE_TIP} onMouseEnter={tip} onMouseLeave={untip} onClick={() => onPick('merge')}>
        Merge
      </button>
      <button type="button" data-immode="append" disabled={importing} class={mode === 'append' ? 'on' : ''}
        onClick={() => onPick('append')}>Append as New</button>
    </div></div>
  );
}

function AnsweredRow({ answered, importing, onPick }: {
  answered: boolean;
  importing: boolean;
  onPick: (on: boolean) => void;
}) {
  return (
    <div class="srow"><div class="k">Responses</div><label class="xcheck">
      <input type="checkbox" id="im-answered" checked={answered} disabled={importing}
        onChange={(e) => onPick(checkedOf(e))} />
      <span>Mark questions that have a response as Answered</span>
    </label></div>
  );
}

/**
 * Rows that matched no question, with the one each could slot in as. Nothing is applied until the person accepts it;
 * a row left alone is added as a new question.
 */
function SuggestionsRow({ qa, suggestions }: { qa: ReadQa; suggestions: Suggestion[] }) {
  const accept = (s: Suggestion) => qa.setAccepted([...qa.accepted, { line: s.line, questionId: s.questionId }]);
  return (
    <div class="srow top"><div class="k">Could Match</div><div class="imprev imchg" id="im-suggest"><table>
      <thead><tr><th>Row</th><th>In the file</th><th>Could be</th><th /></tr></thead>
      <tbody>
        {suggestions.map((s) => <tr key={s.line}>
          <td>{s.line}</td>
          <td title={s.text}>{s.text}</td>
          <td title={s.questionText}>Q{s.n}: {s.questionText}</td>
          <td><button class="btn sm" type="button" data-accept={s.line} onClick={() => accept(s)}>Accept</button></td>
        </tr>)}
      </tbody>
    </table></div></div>
  );
}

/** Every field a merge will overwrite, in the existing scrollable preview. */
function ChangesRow({ changes }: { changes: ImportChange[] }) {
  return (
    <div class="srow top"><div class="k">Will Overwrite</div><div class="imprev imchg" id="im-changes"><table>
      <thead><tr><th>Q</th><th>Field</th><th>Now</th><th>After Import</th></tr></thead>
      <tbody>
        {changes.map((change, i) => <tr key={i}>
          <td>{change.n}</td>
          <td>{change.field}{change.spacing ? ' (only spaces or line breaks)' : ''}</td>
          <td title={change.from}>{changeText(change, change.from)}</td>
          <td title={change.to}>{changeText(change, change.to)}</td>
        </tr>)}
      </tbody>
    </table></div></div>
  );
}

/** A value in the changes table as the Q&A page shows it: dates formatted, the status capitalized, a dash for none */
function changeText(change: { field: string }, value: string) {
  if (!value) return '—';
  if (change.field === 'Received' || change.field === 'Date') return fmtDate(value);
  if (change.field === 'Status') return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

/** The footer: what Import will do (or why it can't), and the Import button */
function ImportFoot({ qa, plan, onImport }: { qa: ReadQa; plan: ImportPlan; onImport: () => void }) {
  const { error, warning, busy, mapping } = qa;
  const { total, dryError } = plan;
  const failed = !!(error || warning || dryError);
  const unread = !failed && !busy ? unreadText(plan.prepared) : '';
  const blocked = !total || mapping.text == null || !!busy || !!dryError || !!warning;
  return (
    <div class="xfoot">
      <span id="im-line" class={failed ? 'err' : ''} role={failed ? 'alert' : undefined} {...unreadTipProps(unread)}>
        {footLine(qa, plan)}
      </span>
      <span class="grow" />
      <button class="btn sm pri" type="button" id="im-go" disabled={blocked} onClick={onImport}>Import</button>
    </div>
  );
}

/** Which dates and values were not read, for the tooltip on the line that counts them */
function unreadText(prepared: Prepared | null) {
  const unread = prepared?.unread ?? [];
  if (!unread.length) return '';
  const more = unread.length - UNREAD_NAMED;
  return `${unread.slice(0, UNREAD_NAMED).join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`;
}

/** The footer line takes the focus and shows the unread dates and values on hover or focus, when there are some */
function unreadTipProps(unread: string) {
  if (!unread) return {};
  const off = (e: Event) => hideTip(e.currentTarget as HTMLElement);
  return {
    tabIndex: 0,
    'aria-description': unread,
    onMouseEnter: (e: MouseEvent) => showTip(e.currentTarget as HTMLElement, unread),
    onMouseLeave: off,
    onFocus: (e: FocusEvent) => showTip(e.currentTarget as HTMLElement, unread, 0),
    onBlur: off,
  };
}

/** The footer's words: what the dialog is doing, why it can't import, or what Import will do */
function footLine(qa: ReadQa, plan: ImportPlan) {
  if (qa.busy === 'asking') return `Asking ${SERVICE} where the table is`;
  if (qa.busy === 'reading') return 'Reading the file';
  if (qa.error) return qa.error;
  if (qa.warning) return qa.warning;
  if (qa.busy === 'importing') return 'Importing';
  if (qa.mapping.text == null) return 'Choose the question column';
  if (plan.dryError) return `Can’t import this file: ${plan.dryError}`;
  if (!plan.total) return 'No rows with a question';
  return importSummary(qa.mode, plan).join(' · ');
}

/** "Import 2,000 questions · 1,950 new · 50 existing will change", then what was left out or not read */
function importSummary(mode: ImportMode, plan: ImportPlan) {
  const { preview, counts, total } = plan;
  const created = preview ? preview.created : counts.add;
  const updated = preview ? preview.updated : counts.match;
  return [
    `Import ${plural(total, 'question')}`,
    `${num(created)} new`,
    mode === 'merge' ? `${num(updated)} existing will change` : '',
    preview?.restored ? `${num(preview.restored)} deleted brought back` : '',
    ...leftOutNotes(plan.prepared),
  ].filter(Boolean);
}

/** The rows, dates and values the file holds that the import leaves out or could not read */
function leftOutNotes(prepared: Prepared | null): string[] {
  if (!prepared) return [];
  return [
    prepared.skipped ? `${plural(prepared.skipped, 'row')} without a question left out` : '',
    prepared.badDates ? `${plural(prepared.badDates, 'date')} not read` : '',
    prepared.unknownValues ? `${plural(prepared.unknownValues, 'value')} not recognized` : '',
  ].filter(Boolean);
}
