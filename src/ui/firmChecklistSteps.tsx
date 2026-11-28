/**
 * The steps of importing a firm's checklist (firmChecklist.tsx): picking the list, choosing between a list's two
 * versions, and the review. The steps before the review are in firmChecklistRead.tsx.
 *
 * Each step is a function that returns the dialog, called rather than rendered as a component: the steps share one
 * mounted Modal, as when they were written inline, so its focus and key handling, set up once when it opens, carry on
 * from step to step.
 */
import { Icon } from './icons';
import { Modal } from './dialogs';
import { FileDrop, PasteNext, PasteRow } from './fileDrop';
import { ConflictView } from './conflict';
import { LIST_ACCEPT } from '../app/listRead';
import { SERVICE } from '../control';
import type { ChecklistImportView } from '../app/checklistImportSession';
import {
  checklistReviewCounts, pairKey, type ListTarget, type Pair, type Review, type Rewording,
} from '../app/checklistImport';
import { NOT_DONE } from '../app/checklistOutcome';
import { plural } from './counts';

/** the tooltip on a checklist's "choose a file…": the kinds of file it reads */
export const LIST_TIP = 'A Word document, PDF, OpenDocument file, RTF, or text file';

export const Head = ({ title, onClose, disabled }: { title: string; onClose: () => void; disabled?: boolean }) => (
  <div class="shead"><h2>{title}</h2>
    <button type="button" class="x" aria-label="Close" title="Close (Esc)" disabled={disabled} onClick={onClose}>
      <Icon name="close" size={15} />
    </button>
  </div>
);

/** Everything the steps show and do, gathered by ImportChecklistDialog on each render. */
export interface ImportView extends ChecklistImportView {
  title: string;
  exit: { restart: boolean; setRestart: (value: boolean) => void; back: () => void; close: () => void };
  change: () => void;
  startOver: () => void;
}

/** Step 1: a file, or the list pasted in. */
export function pickStep(view: ImportView) {
  const { title, exit, source, work } = view;
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} />
      <div class="srow"><div class="k">File</div><div>
        {dropZone(source)}
        {work.error && <p class="emptyline" id="cl-error" role="alert" style="margin-top:10px">{work.error}</p>}
      </div></div>
      <PasteRow id="cl-paste" value={source.paste} onInput={source.setPaste} />
      {pickFooter(view)}
    </Modal>
  );
}

function dropZone(source: ChecklistImportView['source']) {
  return <FileDrop id="cl-drop" browseId="cl-browse" fileId="cl-file" accept={LIST_ACCEPT}
    words="Drop a file here, or" browseTitle={LIST_TIP} onFile={(file) => void source.load(file)} />;
}

function pickFooter({ exit, source, work }: ImportView) {
  const typed = source.counts.pasted;
  const typedLines = typed ? plural(typed, 'line') : '';
  const line = work.busy === 'reading' ? 'Reading the file' : typedLines;
  return (
    <div class="xfoot"><span id="cl-line">{line}</span><span class="grow" />
      <button class="btn sm" type="button" onClick={exit.back}>Back</button>
      <PasteNext id="cl-paste-next" lines={typed} busy={!!work.busy} onNext={source.pasted} />
    </div>
  );
}

/** A list split in two versions while the import is open is chosen here, from the mapping or the review alike */
export function chooseStep(view: ImportView, split: NonNullable<ListTarget['split']>) {
  const { title, exit } = view;
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} />
      <ConflictView conflict={split} />
      <div class="xfoot" key="choose"><span class="grow" />
        <button class="btn sm" type="button" id="cl-choose-back" onClick={view.stopChoosing}>Back</button>
      </div>
    </Modal>
  );
}

/** Step 2's review: the wording suggestions and the duplicates, each used only if a person checks it. */
export function reviewStep(view: ImportView, review: Review) {
  const { title, exit, work } = view;
  const shownSame = review.asked.same !== 'off';
  const counts = checklistReviewCounts(review);
  const shownWording = review.asked.reword !== 'off' || counts.suggestions > 0;
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} disabled={work.busy === 'importing'} />
      {shownWording && wordingRow(view, review, counts.suggestions)}
      {shownSame && duplicatesRow(view, review, counts)}
      {!shownWording && !shownSame && <p class="fl-intro">Nothing to review</p>}
      {reviewFooter(view)}
    </Modal>
  );
}

function wordingRow(view: ImportView, review: Review, count: number) {
  const notDone = NOT_DONE[review.asked.reword];
  return (
    <div class="srow top"><div class="k">Wording</div><div>
      <div class="rv-h" title={count ? 'Only checked items take the new wording' : undefined}>
        {count > 0 && wordingSelection(view, count)}
        {notDone && <b>Not asked</b>}
        {!notDone && !count && <b>No suggestions</b>}
        {notDone && <span>{notDone}</span>}
        {notDone && view.can.reword && <button type="button" class="linkb" id="cl-reword-retry"
          title="Ask for them again" disabled={!!view.work.busy}
          onClick={() => void view.listReview.retryWording()}>Retry</button>}
      </div>
      {count > 0 && <div class="rv-list" id="cl-rewords">
        {review.rewords.map((rewording) => rewordingRow(view, review, rewording))}
      </div>}
    </div></div>
  );
}

function wordingSelection(view: ImportView, suggestions: number) {
  const count = plural(suggestions, 'suggestion');
  const { eligible, allChecked } = view.listReview.wording!;
  return (
    <label class="xcheck" style="min-height:24px" title="Select or clear all available wording suggestions">
      <input id="cl-reword-all" type="checkbox" aria-label={`${count}, select or clear all`} aria-controls="cl-rewords"
        checked={allChecked} disabled={!eligible.length}
        onChange={(event) => view.listReview.setAllWording(event.currentTarget.checked)} />
      <b>{count}</b>
    </label>
  );
}

function rewordingRow(view: ImportView, review: Review, rewording: Rewording) {
  const { listReview } = view;
  const { at } = rewording;
  return (
    <label class="rv-row" key={at} title={rewording.earlier ? 'Taken when this list was last imported' : undefined}>
      <input type="checkbox" data-reword={at} checked={listReview.useReword.has(at)}
        disabled={listReview.wording!.locked(at)} onChange={() => listReview.flipReword(at)} />
      <div>
        <div class="rv-was"><i>Was</i>{review.items[at].text}</div>
        {[rewording.text, ...(rewording.also ?? [])].map((text, k) => (
          <div class="rv-new" key={k}><i>New</i>{text}</div>))}
      </div>
    </label>
  );
}

function duplicatesRow(
  view: ImportView, review: Review, { duplicates, missed }: ReturnType<typeof checklistReviewCounts>,
) {
  const { pairs, sameMissed } = review;
  const notDone = NOT_DONE[review.asked.same];
  return (
    <div class="srow top"><div class="k">Duplicates</div><div>
      <div class="rv-h" title={duplicates ? 'Only checked items are removed' : undefined}>
        <b>{duplicates ? `${duplicates.toLocaleString('en-US')} found` : 'None found'}</b>
        {notDone && <span>{notDone}; only same wording was checked</span>}
        {sameMissed && <span id="cl-missed">
          {NOT_DONE[sameMissed.kind]} for {plural(missed, 'item')}
        </span>}
        {(sameMissed || notDone) && view.can.sameMeaning && <button type="button" class="linkb" id="cl-retry"
          title="Ask about them again" disabled={!!view.work.busy}
          onClick={() => void view.listReview.retry()}>Retry</button>}
      </div>
      {duplicates > 0 && <div class="rv-list" id="cl-pairs">{pairs.map((pair) => pairRow(view, review, pair))}</div>}
    </div></div>
  );
}

function pairRow(view: ImportView, review: Review, pair: Pair) {
  return (
    <div class="rv-pair" key={pairKey(pair)}>
      {removeBox(view, review, pair.a)}
      {pair.inAgainst
        ? <div class="rv-row"><span class="nobox" />
          <div class="rv-new">{view.target.generalTexts[pair.b]}<span class="tag">General</span></div>
        </div>
        : removeBox(view, review, pair.b)}
      {pair.why && <div class="rv-why">{pair.why}</div>}
    </div>
  );
}

// the check marks are locked while the list is brought in
function removeBox({ listReview, work }: ImportView, review: Review, at: number) {
  return (
    <label class="rv-row">
      <input type="checkbox" data-remove={at} disabled={work.busy === 'importing'} checked={listReview.remove.has(at)}
        onChange={() => listReview.flipRemove(at)} />
      <div class="rv-new">{review.items[at].text}</div>
    </label>
  );
}

/** What the review's footer says: why it waits, what it is doing, or what Import will import. */
function reviewLine({ work, target, listReview }: ImportView): string {
  if (work.error) return work.error;
  if (target.split && !work.busy) return target.splitSays;
  if (work.busy === 'importing') return 'Importing';
  if (work.busy === 'reviewing') return `Asking ${SERVICE}`;
  const { items, reworded, split, removed } = listReview.counts;
  const parts = [`Import ${plural(items, 'item')}`];
  if (reworded) parts.push(`${reworded.toLocaleString('en-US')} reworded`);
  if (split) parts.push(`${split.toLocaleString('en-US')} split`);
  if (removed) parts.push(`${removed.toLocaleString('en-US')} removed`);
  return parts.join(' · ');
}

function reviewFooter(view: ImportView) {
  const { work, target } = view;
  const { split } = target;
  return (
    <div class="xfoot" key="review">{statusLine(view, reviewLine(view))}<span class="grow" />
      <button class="btn sm" type="button" disabled={work.busy === 'importing'}
        onClick={view.listReview.backToList}>Back</button>
      {split && chooseButton(view)}
      <span class="needs" title={view.whyBringIn}>
        <button key={split ? 'held' : 'go'} class={`btn sm${split ? '' : ' pri'}`} type="button" id="cl-go"
          disabled={!view.canBringIn} onClick={view.bringItIn}>Import</button>
      </span>
    </div>
  );
}

export function statusLine({ work }: ImportView, line: string, tip?: string) {
  const { error } = work;
  return <span id="cl-line" class={error ? 'err' : ''} role={error ? 'alert' : undefined} title={tip}>{line}</span>;
}

export function chooseButton(view: ImportView) {
  return (
    <button class="btn sm pri" type="button" id="cl-choose" disabled={!!view.work.busy}
      onClick={view.chooseHere}>Choose…</button>
  );
}
