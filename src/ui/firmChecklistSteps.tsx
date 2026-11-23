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
import { FileDrop } from './fileDrop';
import { ConflictView } from './conflict';
import { pastedLines, LIST_ACCEPT } from '../app/listRead';
import type { FirmList, Layer } from '../domain/checklist';
import { SERVICE } from '../control';
import type { AiService } from '../ports';
import type { Leaving, ListReview, ListSource, Work } from './firmChecklistImport';
import { NOT_DONE, pairKey, plural } from './firmChecklistReview';
import type { ListTarget, Pair, Review, Rewording } from './firmChecklistReview';

/** the tooltip on a checklist's "choose a file…": the kinds of file it reads */
export const LIST_TIP = 'A spreadsheet, a Word file, a PDF or a text file';

export const Head = ({ title, onClose, disabled }: { title: string; onClose: () => void; disabled?: boolean }) => (
  <div class="shead"><h2>{title}</h2>
    <button type="button" class="x" aria-label="Close" title="Close (Esc)" disabled={disabled} onClick={onClose}>
      <Icon name="close" size={15} />
    </button>
  </div>
);

/** Everything the steps show and do, gathered by ImportChecklistDialog on each render. */
export interface ImportView {
  title: string;
  ai: AiService;
  firm: FirmList;
  work: Work;
  source: ListSource;
  listReview: ListReview;
  target: ListTarget;
  exit: Leaving;
  setLayer: (layer: Layer) => void;
  setName: (name: string) => void;
  /** back to step 1, the paste box as it was left */
  change: () => void;
  /** clears the import, once the person has said so */
  startOver: () => void;
  /** to the choice between a list's two versions, and back */
  chooseHere: () => void;
  stopChoosing: () => void;
  bringItIn: () => void;
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
      <div class="srow top cl-pasterow"><div class="k">Paste</div><div>
        <textarea class="field cl-paste" id="cl-paste" aria-label="Paste a list" placeholder="Paste a list"
          spellcheck={false} value={source.paste}
          onInput={(e) => source.setPaste((e.currentTarget as HTMLTextAreaElement).value)} />
      </div></div>
      {pickFooter(view)}
    </Modal>
  );
}

function dropZone(source: ListSource) {
  return <FileDrop id="cl-drop" browseId="cl-browse" fileId="cl-file" accept={LIST_ACCEPT}
    words="Drop a file here, or" browseTitle={LIST_TIP} onFile={(file) => void source.load(file)} />;
}

function pickFooter({ exit, source, work }: ImportView) {
  const typed = source.paste.trim();
  const typedLines = typed ? plural(pastedLines(source.paste).length, 'line') : '';
  const line = work.busy === 'reading' ? 'Reading the file' : typedLines;
  return (
    <div class="xfoot"><span id="cl-line">{line}</span><span class="grow" />
      <button class="btn sm" type="button" onClick={exit.back}>Back</button>
      <span class="needs" title={typed ? undefined : 'Paste a list, or choose a file'}>
        <button class="btn sm pri" type="button" id="cl-paste-next" disabled={!typed || !!work.busy}
          onClick={source.pasted}>Next</button>
      </span>
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
  const nothing = review.asked.reword === 'off' && !review.rewords.length && !shownSame;
  return (
    <Modal onClose={exit.close} label={title} blur className="sdlg imdlg">
      <Head title={title} onClose={exit.close} disabled={work.busy === 'importing'} />
      {(review.asked.reword !== 'off' || review.rewords.length > 0) && wordingRow(view, review)}
      {shownSame && duplicatesRow(view, review)}
      {nothing && <p class="fl-intro">Nothing to review</p>}
      {reviewFooter(view)}
    </Modal>
  );
}

function wordingRow(view: ImportView, review: Review) {
  const notDone = NOT_DONE[review.asked.reword];
  const count = review.rewords.length;
  return (
    <div class="srow top"><div class="k">Wording</div><div>
      <div class="rv-h" title={count ? 'Only checked items take the new wording' : undefined}>
        {count > 0 && wordingSelection(view, review)}
        {notDone && <b>Not asked</b>}
        {!notDone && !count && <b>No suggestions</b>}
        {notDone && <span>{notDone}</span>}
        {notDone && view.ai.reword && <button type="button" class="linkb" id="cl-reword-retry"
          title="Ask for them again" disabled={!!view.work.busy}
          onClick={() => void view.listReview.retryWording()}>Retry</button>}
      </div>
      {count > 0 && <div class="rv-list" id="cl-rewords">
        {review.rewords.map((rewording) => rewordingRow(view, review, rewording))}
      </div>}
    </div></div>
  );
}

function rewordingLocked({ listReview, work }: ImportView, at: number) {
  return listReview.remove.has(at) || work.busy === 'importing';
}

function wordingSelection(view: ImportView, { rewords }: Review) {
  const { useReword, setUseReword } = view.listReview;
  const count = plural(rewords.length, 'suggestion');
  const eligible = rewords.map(({ at }) => at).filter((at) => !rewordingLocked(view, at));
  const allChecked = eligible.length > 0 && eligible.every((at) => useReword.has(at));
  // #377: Retain checkmarks on locked rows so restoring a removed item also restores its wording choice.
  const setAll = (checked: boolean) => setUseReword((previous) => {
    const next = new Set(previous);
    for (const at of eligible) {
      if (checked) next.add(at);
      else next.delete(at);
    }
    return next;
  });
  return (
    <label class="xcheck" style="min-height:24px" title="Select or clear all available wording suggestions">
      <input id="cl-reword-all" type="checkbox" aria-label={`${count}, select or clear all`} aria-controls="cl-rewords"
        checked={allChecked} disabled={!eligible.length} onChange={(event) => setAll(event.currentTarget.checked)} />
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
        disabled={rewordingLocked(view, at)} onChange={() => listReview.flipReword(at)} />
      <div>
        <div class="rv-was"><i>Was</i>{review.items[at].text}</div>
        {[rewording.text, ...(rewording.also ?? [])].map((text, k) => (
          <div class="rv-new" key={k}><i>New</i>{text}</div>))}
      </div>
    </label>
  );
}

function duplicatesRow(view: ImportView, review: Review) {
  const { pairs, sameMissed } = review;
  const notDone = NOT_DONE[review.asked.same];
  return (
    <div class="srow top"><div class="k">Duplicates</div><div>
      <div class="rv-h" title={pairs.length ? 'Only checked items are removed' : undefined}>
        <b>{pairs.length ? `${pairs.length.toLocaleString('en-US')} found` : 'None found'}</b>
        {notDone && <span>{notDone}; only same wording was checked</span>}
        {sameMissed && <span id="cl-missed">
          {NOT_DONE[sameMissed.kind]} for {plural(sameMissed.at.length, 'item')}
        </span>}
        {(sameMissed || notDone) && view.ai.sameMeaning && <button type="button" class="linkb" id="cl-retry"
          title="Ask about them again" disabled={!!view.work.busy}
          onClick={() => void view.listReview.retry()}>Retry</button>}
      </div>
      {pairs.length > 0 && <div class="rv-list" id="cl-pairs">{pairs.map((pair) => pairRow(view, review, pair))}</div>}
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
  const { items, useReword, remove, rewordAt } = listReview;
  const taken = [...useReword].filter((at) => !remove.has(at));
  const splitCount = taken.filter((at) => (rewordAt.get(at)?.length ?? 1) > 1).length;
  const reworded = taken.length - splitCount;
  const parts = [`Import ${plural(items.length, 'item')}`];
  if (reworded) parts.push(`${reworded.toLocaleString('en-US')} reworded`);
  if (splitCount) parts.push(`${splitCount.toLocaleString('en-US')} split`);
  if (remove.size) parts.push(`${remove.size.toLocaleString('en-US')} removed`);
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
      <span class="needs" title={split ? `${target.splitSays}. Choose one first` : undefined}>
        <button key={split ? 'held' : 'go'} class={`btn sm${split ? '' : ' pri'}`} type="button" id="cl-go"
          disabled={!view.listReview.items.length || !!work.busy || !!split} onClick={view.bringItIn}>Import</button>
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
