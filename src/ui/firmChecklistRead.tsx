/**
 * The import's steps before the review (firmChecklist.tsx): the list as the model read it, or by columns chosen by hand
 * when it could not. Called as functions, like the other steps in firmChecklistSteps.tsx, so they share its one Modal.
 */
import { Modal, LeaveFoot } from './dialogs';
import type { ChecklistMapping } from '../domain/checklistImport';
import { LAYERS, LAYER_NAMES, LIST_NAME_MAX, findList, key, type Layer } from '../domain/checklist';
import { alphabetical } from '../domain/order';
import { SERVICE } from '../control';
import type { ListSource } from './firmChecklistImport';
import { NOT_DONE, plural } from './firmChecklistReview';
import { Head, chooseButton, statusLine, type ImportView } from './firmChecklistSteps';

type Table = NonNullable<ListSource['table']>;

/** Why Next is off, as its tooltip says */
function whyNoNext({ source, target }: ImportView): string | undefined {
  if (source.readFailed && !source.byColumns) return 'The list was not read';
  if (!target.named) return `Name the ${LAYER_NAMES[target.layer].one.toLowerCase()}, as deals will pick it`;
  if (target.split) return `${target.splitSays}. Choose one first`;
  return undefined;
}

/** The footer of step 2, before the review: Next asks for the review, and the line says what Next will take. */
function nextFooter(view: ImportView, line: string, tip?: string) {
  const { exit } = view;
  if (exit.restart) {
    return <LeaveFoot id="cl-restart-ask" ask="Clear this import and start over?" go="Start Over"
      keep={() => exit.setRestart(false)} leave={view.startOver} />;
  }
  const { work, source, target, listReview } = view;
  const { split } = target;
  const why = whyNoNext(view);
  const noColumn = source.byColumns && source.mapping.item === null;
  const waiting = listReview.waiting && !why && !noColumn;
  const status = waiting && !work.error ? `Asking ${SERVICE}` : line;
  return (
    <div class="xfoot">{statusLine(view, status, tip)}<span class="grow" />
      {split && chooseButton(view)}
      <span class="needs" title={why}>
        <button key={split ? 'held' : 'next'} class={`btn sm${split ? '' : ' pri'}`} type="button" id="cl-next"
          title={why} disabled={!(source.prepared?.items.length) || !!why || !!work.busy || noColumn || waiting}
          onClick={() => void listReview.next()}>Next</button>
      </span>
    </div>
  );
}

function fileRow({ change, exit }: ImportView, label: string, said: string) {
  // spaced as "change" is from the name
  const restartLink = <>{' '}<button type="button" class="linkb" id="cl-restart"
    onClick={() => exit.setRestart(true)}>start over</button></>;
  return (
    <div class="srow"><div class="k">{label}</div><div class="imfile">{said} <button type="button" class="linkb"
      id="cl-back" onClick={change}>change</button>{restartLink}</div></div>
  );
}

const rowsSaid = (table: Table) => `${table.name} · ${plural(table.rows.length, 'row')}`;

const sheetOptions = (sheets: string[]) => sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>);

function namePlaceholder(layer: Layer) {
  if (layer === 'product') return 'Warehouse facility';
  if (layer === 'sector') return 'Data centers';
  return 'Solar';
}

/** Which list: the general one, or a named product, sector or technology list. */
function listRow({ firm, target, setLayer, setName }: ImportView) {
  const { layer, name, replaces } = target;
  const one = LAYER_NAMES[layer].one.toLowerCase();
  const nameNote = !key(name) ? undefined : replaces ? `Replaces the ${replaces.name} list` : `A new ${one} list`;
  const names = alphabetical((firm?.lists ?? []).filter((list) => list.layer === layer).map((list) => list.name));
  const generalTip = findList(firm, 'broad', '') ? 'Replaces the general list' : undefined;
  return (
    <div class="srow top"><div class="k">List</div><div>
      <div class="seg" id="cl-layer" role="group" aria-label="Which list">{LAYERS.map((each) => (
        <button type="button" key={each} data-layer={each} title={each === 'broad' ? generalTip : undefined}
          class={layer === each ? 'on' : ''} aria-pressed={layer === each}
          onClick={() => setLayer(each)}>{LAYER_NAMES[each].one}</button>))}</div>
      {layer !== 'broad' && <div class="cl-name">
        <input class="field" id="cl-name" title={nameNote} list="cl-names" aria-label={`Name of the ${one}`}
          maxLength={LIST_NAME_MAX} placeholder={namePlaceholder(layer)} value={name}
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <datalist id="cl-names">{names.map((listName) => <option key={listName} value={listName} />)}</datalist>
      </div>}
    </div></div>
  );
}

/** What the review will ask for: clearer wording (when the model offers it) and duplicates. */
function reviewChoices({ can, target, listReview }: ImportView) {
  const where = target.layer === 'broad' ? '' : ', here and in the general list';
  const sameTip = `Items that ask for the same thing${where}; only what you check is removed`;
  return (
    <div class="srow top"><div class="k">Review</div><div class="cl-checks">
      {can.reword && <label class="xcheck"
        title={`${SERVICE} suggests wording for unclear or two-part items; you check the ones to use`}>
        <input type="checkbox" id="cl-askreword" checked={listReview.askReword}
          onChange={(e) => listReview.setAskReword((e.currentTarget as HTMLInputElement).checked)} />
        <span>Suggest clearer wording</span>
      </label>}
      <label class="xcheck" title={sameTip}>
        <input type="checkbox" id="cl-asksame" checked={listReview.askSame}
          onChange={(e) => listReview.setAskSame((e.currentTarget as HTMLInputElement).checked)} />
        <span>Look for duplicates</span>
      </label>
    </div></div>
  );
}

interface PreviewRow { text: string; section?: string; subsection?: string }

/** The first items, as they will come in, with their section and subsection when shown. */
function previewTable(rows: PreviewRow[], withSection: boolean, withSub: boolean, empty: string, headClass?: string) {
  return (
    <div class="imprev"><table>
      <thead><tr>
        {withSection && <th class={headClass}>Section</th>}
        {withSub && <th class={headClass}>Subsection</th>}
        <th>Item</th>
      </tr></thead>
      <tbody>{rows.length ? rows.map((row, i) => <tr key={i}>
        {withSection && <td>{row.section ?? ''}</td>}
        {withSub && <td>{row.subsection ?? ''}</td>}
        <td title={row.text}>{row.text}</td>
      </tr>) : <tr><td colSpan={3} class="emptyline" style="margin:0;padding:10px">{empty}</td></tr>}</tbody>
    </table></div>
  );
}

/** How every line of the list was accounted for, as the footer's tooltip ties it out */
function tieOutTip(count: NonNullable<ListSource['tied']>['count']) {
  const wrapped = count.more ? ` (${plural(count.more, 'more line')} of wrapped items)` : '';
  const items = `${plural(count.items, 'item')}${wrapped}`;
  const others = `${plural(count.headings, 'heading')}, ${plural(count.blank, 'blank line')}`;
  return `${plural(count.lines, 'line')}: ${items}, ${others}, ${plural(count.left, 'line')} left out`;
}

/**
 * Step 2, as the model read it: the items in a preview, and every line it left out, each with a checkbox to bring it in
 * where it sits. The footer counts what comes in; its tooltip ties every line out.
 */
export function readStep(view: ImportView, lines: string[]) {
  const { title, exit, work, source } = view;
  const { table, text, tied, readFailed } = source;
  const count = tied?.count;
  // until the reading is in (it starts just after the lines are shown), the line says it is being asked
  const reading = work.busy === 'asking' || (!count && !readFailed && !work.error);
  const lineCount = plural(lines.length, 'line');
  const said = text ? `${text.name || 'Pasted'} · ${lineCount}` : rowsSaid(table!);
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} />
      {fileRow(view, text && !text.name ? 'Text' : 'File', said)}
      {table && table.sheets.length > 1 && <div class="srow"><div class="k">Sheet</div><div class="imwhere">
        <select class="field" id="cl-sheet" aria-label="Sheet" value={table.sheet} disabled={!!work.busy}
          onChange={(e) => void source.reread({ sheet: (e.currentTarget as HTMLSelectElement).value })}>
          {sheetOptions(table.sheets)}
        </select>
      </div></div>}
      {listRow(view)}
      <div class="srow top"><div class="k">Preview</div><div>
        {readFailed ? notReadLine(view, readFailed) : readPreview(source, reading)}
      </div></div>
      {leftOutRow(source, lines)}
      {reviewChoices(view)}
      {nextFooter(view, readLine(view, lines, reading), count ? tieOutTip(count) : undefined)}
    </Modal>
  );
}

/** What the footer says while the model reads the list, and once it has: what Next will take. */
function readLine({ work, source, target }: ImportView, lines: string[], reading: boolean): string {
  const count = source.tied?.count;
  if (reading || work.busy === 'reviewing') return `Asking ${SERVICE}`;
  if (work.error) return work.error;
  if (target.split) return target.splitSays;
  if (!count) return plural(lines.length, 'line');
  if (!target.named) return `Name the ${LAYER_NAMES[target.layer].one.toLowerCase()}`;
  return `${plural(count.items, 'item')}${count.left ? ` · ${plural(count.left, 'line')} left out` : ''}`;
}

/** The model could not read the list: Retry asks again, and a table can have its columns chosen by hand instead. */
function notReadLine({ work, source }: ImportView, readFailed: Exclude<ListSource['readFailed'], ''>) {
  return (
    <div class="rv-h" id="cl-notread"><b>Not read</b><span>{NOT_DONE[readFailed]}</span>
      <button type="button" class="linkb" id="cl-read-retry" title="Ask again" disabled={!!work.busy}
        onClick={() => void source.readNow()}>Retry</button>
      {source.table && <button type="button" class="linkb" id="cl-bycolumns" title="Choose the item column yourself"
        disabled={!!work.busy} onClick={source.chooseColumns}>Choose Columns</button>}
    </div>
  );
}

function readPreview({ tied }: ListSource, reading: boolean) {
  const rows = tied ? tied.items.slice(0, 5) : [];
  const withSection = rows.some((row) => row.section);
  const withSub = rows.some((row) => row.subsection);
  return previewTable(rows, withSection, withSub, reading ? 'Reading the list' : 'No items', 'cl-sec');
}

/** Every line the model left out, each with a checkbox to bring it in as an item where it sits. */
function leftOutRow(source: ListSource, lines: string[]) {
  const leftOut = source.tiedBase?.left ?? [];
  return leftOut.length > 0 && (
    <div class="srow top" id="cl-leftout"><div class="k" title="Lines not read as items">Left out</div><div>
      <div class="rv-list">{leftOut.map((line) => (
        <label class="rv-row" key={line} title={`Line ${line}. Check to import it as an item, where it sits`}>
          <input type="checkbox" data-bringin={line} checked={source.bringIn.has(line)}
            onChange={() => source.flipBringIn(line)} />
          <div class="rv-new">{lines[line - 1].trim()}</div>
        </label>))}
      </div>
    </div></div>
  );
}

/** Step 2 by the columns chosen by hand: the fallback for a table the model could not read. */
export function columnsStep(view: ImportView, table: Table) {
  const { title, exit, source } = view;
  const { mapping, prepared } = source;
  const rows = mapping.item === null ? [] : (prepared?.items ?? []).slice(0, 5);
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} />
      {fileRow(view, 'File', rowsSaid(table))}
      {listRow(view)}
      {headingsRow(source, table)}
      <div class="srow top"><div class="k">Columns</div><div class="immap three">
        {COLUMNS.map(([column, label]) => columnPicker(view, table, column, label))}
      </div></div>
      <div class="srow top"><div class="k">Preview</div>
        {previewTable(rows, mapping.section !== null, mapping.subsection != null, 'No rows with an item')}
      </div>
      {reviewChoices(view)}
      {nextFooter(view, columnsLine(view))}
    </Modal>
  );
}

/** Where the headings are: the sheet, and the row they sit on. */
function headingsRow(source: ListSource, table: Table) {
  const typed = (value: number) => {
    const fits = Number.isInteger(value) && value >= 1 && value <= table.lastRow;
    if (fits && value !== table.headerRow) void source.reread({ sheet: table.sheet, headerRow: value });
  };
  return (
    <div class="srow"><div class="k">Headings</div><div class="imwhere">
      {table.sheets.length > 1 && <label><span>Sheet</span>
        <select class="field" id="cl-sheet" aria-label="Sheet" value={table.sheet}
          onChange={(e) => void source.reread({ sheet: (e.currentTarget as HTMLSelectElement).value })}>
          {sheetOptions(table.sheets)}
        </select>
      </label>}
      <label><span>Row</span>
        <input class="field" id="cl-header" type="number" aria-label="Heading row" min={1} max={table.lastRow} step={1}
          value={table.headerRow} onInput={(e) => typed(+(e.currentTarget as HTMLInputElement).value)} />
      </label>
    </div></div>
  );
}

const COLUMNS = [['item', 'Item'], ['section', 'Section'], ['subsection', 'Subsection']] as const;

function columnPicker(view: ImportView, table: Table, column: keyof ChecklistMapping, label: string) {
  const { mapping, setMapping } = view.source;
  const chosen = (value: string) => {
    setMapping({ ...mapping, [column]: value === '' ? null : +value });
    view.work.setError('');
  };
  return (
    <label key={column}><span>{label}</span>
      <select class="field" aria-label={label} data-clmap={column}
        value={mapping[column] == null ? '' : String(mapping[column])}
        onChange={(e) => chosen((e.currentTarget as HTMLSelectElement).value)}>
        {column === 'item' && <option value="">Choose a Column</option>}
        {/* the file's columns in its own order, left to right, as the preview shows them; "not in file" last */}
        {table.columns.map((name, i) => <option key={i} value={String(i)}>{name || `(column ${i + 1})`}</option>)}
        {column !== 'item' && <option value="">— not in file —</option>}
      </select>
    </label>
  );
}

/** What the footer says when the columns are chosen by hand: what is missing, or what Next will take. */
function columnsLine({ work, source, target }: ImportView): string {
  const { mapping, prepared } = source;
  const count = prepared?.items.length ?? 0;
  if (work.busy === 'reviewing') return `Asking ${SERVICE}`;
  if (work.error) return work.error;
  if (target.split) return target.splitSays;
  if (mapping.item === null) return 'Choose the item column';
  if (!target.named) return `Name the ${LAYER_NAMES[target.layer].one.toLowerCase()}`;
  if (!count) return 'No rows with an item';
  const skipped = prepared?.skipped ? `${plural(prepared.skipped, 'row')} without an item left out` : '';
  return [plural(count, 'item'), skipped].filter(Boolean).join(' · ');
}
