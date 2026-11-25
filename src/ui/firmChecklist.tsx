/**
 * The firm's checklist: its lists, and bringing one in from a spreadsheet. Mapped and previewed like
 * the Q&A import, then reviewed: suggested rewordings and duplicates, each used only if a person checks it.
 * The import's steps are in firmChecklistSteps.tsx and firmChecklistRead.tsx, what it
 * wires up in firmChecklistImport.ts, how it is kept in firmChecklistKept.ts, and its review in app/checklistImport.ts.
 */
import { useEffect, useState } from 'preact/hooks';
import { versionsWord } from '../app/state';
import { useAppState, useStore, fmtDateTime } from './hooks';
import { Modal } from './dialogs';
import { ConflictView } from './conflict';
import { LAYER_NAMES, firmOf, type Layer } from '../domain/checklist';
import { checklistShelf, listTarget, type ListTarget } from '../app/checklistImport';
import { plural } from './counts';
import { useLeaving, useListReview, useListSource, useWork } from './firmChecklistImport';
import type { ListReview, ListSource } from './firmChecklistImport';
import { useKeepImport, useKeeper, dropKept, type KeptNow } from './firmChecklistKept';
import { useKeptImportsReady, useFreshOnCrash } from './keptImports';
import { FileDrop } from './fileDrop';
import { LIST_ACCEPT } from '../app/listRead';
import { Head, LIST_TIP, chooseStep, pickStep, reviewStep, type ImportView } from './firmChecklistSteps';
import { columnsStep, readStep } from './firmChecklistRead';

/** What the firm has brought in, and the way to bring in another list or replace one. */
export function FirmChecklistDialog() {
  const store = useStore();
  const state = useAppState();
  const at = state.ui.firmChecklist;
  // each list is a record of its own: one in two versions is chosen between here, and the others carry on
  const [choosing, setChoosing] = useState<string | null>(null);
  // a file dropped on the empty dialog, handed to the import it opens
  const [dropped, setDropped] = useState<File | null>(null);
  if (at?.step === 'import') {
    return <KeptChecklistImport layer={at.layer} name={at.name} dropped={dropped} taken={() => setDropped(null)} />;
  }
  const { sections, totals } = checklistShelf(state);
  const clash = choosing ? state.conflicts[choosing] : undefined;
  const close = () => store.ui({ firmChecklist: null });
  const open = (layer?: Layer, name?: string) => store.ui({ firmChecklist: { step: 'import', layer, name } });
  const importFile = (file: File) => {
    setDropped(file);
    open();
  };
  const actions: ShelfActions = { choose: setChoosing, replace: open };
  return (
    <Modal onClose={close} label="Firm’s checklist" blur
      className={`sdlg imdlg fldlg${totals.lists ? '' : ' empty'}`}>
      <Head title="Firm’s Checklist" onClose={close} />
      {clash ? <ConflictView conflict={clash} />
        : totals.lists ? <>{sections.map((section) => layerSection(actions, section))}</> : noListsDrop(importFile)}
      {/* keyed, so Back is never the Import button reused, with its accent fill fading out */}
      {clash ? <div class="xfoot" key="back"><span class="grow" />
        <button class="btn sm" type="button" id="fl-back" onClick={() => setChoosing(null)}>Back</button>
      </div> : <div class="xfoot" key="lists">
        {totals.lists > 0 && <span id="fl-count">{plural(totals.lists, 'list')} · {plural(totals.items, 'item')}</span>}
        <span class="grow" />
        <button class="btn sm pri" type="button" id="fl-import" title="Importing a list again replaces it"
          onClick={() => open()}>Import a List…</button>
      </div>}
    </Modal>
  );
}

/**
 * With no lists yet, one drop area for a checklist file stands in for the empty sections:
 * a file dropped or chosen opens the import with it, as Import a list… does.
 */
function noListsDrop(importFile: (file: File) => void) {
  return <FileDrop id="fl-drop" browseId="fl-browse" fileId="fl-file" accept={LIST_ACCEPT} tall
    words="Drop a checklist here, or" browseTitle={LIST_TIP} onFile={importFile} />;
}

/** The firm's lists as the dialog shows them, and what their buttons do */
interface ShelfActions {
  /** opens the choice between a list's two versions, by the list's record */
  choose: (id: string) => void;
  replace: (layer: Layer, name: string) => void;
}

type ShelfSection = ReturnType<typeof checklistShelf>['sections'][number];

function layerSection(actions: ShelfActions, { layer, rows, count }: ShelfSection) {
  const noneTip = layer === 'broad'
    ? 'Deals are checked against their own lists only'
    : `A deal with a ${LAYER_NAMES[layer].one.toLowerCase()} is checked without one`;
  return (
    <div class="fl-sec" key={layer} data-layer={layer}>
      <div class="fl-h"><b>{LAYER_NAMES[layer].many}</b>
        {layer !== 'broad' && count > 0 && <span class="c">{count}</span>}
      </div>
      {count ? rows.map((row) => firmListRow(actions, row)) : <div class="fl-none" title={noneTip}>None yet</div>}
    </div>
  );
}

/** One list: its items, who brought it in and when, or that it is in two versions and waits for a choice */
function firmListRow(actions: ShelfActions, { list, items, clash, versions }: ShelfSection['rows'][number]) {
  return (
    <div class="fl-row" key={list.name} data-list={list.name}>
      <span class="nm">{list.layer === 'broad' ? 'General' : list.name}</span>
      {clash ? <>
        <span class="meta"><span class="cf">{versionsWord(versions)}</span></span>
        <button type="button" class="linkb" data-choose={list.name}
          onClick={() => actions.choose(clash.id)}>Choose…</button>
      </> : <>
        <span class="meta">{plural(items, 'item')} · {list.by}, {fmtDateTime(list.at)}</span>
        <button type="button" class="linkb" onClick={() => actions.replace(list.layer, list.name)}>Replace…</button>
      </>}
    </div>
  );
}

interface ImportProps {
  layer?: Layer;
  name?: string;
  /** a file dropped on the empty firm's checklist, read as the import opens */
  dropped?: File | null;
  /** called once the dropped file is taken, so it is read only once */
  taken?: () => void;
}

/** The checklist import picks up where it was left on this PC: it waits the moment it takes to read what was kept */
function KeptChecklistImport(props: ImportProps) {
  const ready = useKeptImportsReady();
  const fresh = useFreshOnCrash();
  return !ready || fresh === 'gone' ? null : <ImportChecklistDialog key={String(fresh)} {...props} fresh={fresh} />;
}

/** Bringing a list in: a file or a paste, read by the model, reviewed, then brought in. */
function ImportChecklistDialog(props: ImportProps & { fresh: boolean }) {
  const store = useStore();
  const state = useAppState();
  const keeper = useKeeper(props.layer, props.name, props.fresh);
  const kept = keeper.left?.choices;
  const work = useWork();
  const source = useListSource(store, work, keeper);
  useDroppedFile(source, props.dropped, props.taken);
  const [layer, setLayer] = useState<Layer>(kept?.layer ?? props.layer ?? 'broad');
  const [name, setName] = useState(kept?.name ?? props.name ?? '');
  const firm = firmOf(state.firmList);
  const target = listTarget(state, firm, layer, name);
  const listReview = useListReview(store, work, source.prepared, target, keeper);
  useKeepImport(keeper, keptNow(source, listReview, layer, name));
  const exit = useLeaving(store, work);
  const { split } = target;
  const [choosingHere, setChoosingHere] = useChoosingHere(split);

  const { review } = listReview;
  const { table, text, lines } = source;
  const fileName = table?.name ?? text?.name ?? '';
  const view: ImportView = {
    title: review ? `Import a Checklist · ${layer === 'broad' ? 'General' : name}` : 'Import a Checklist',
    can: state.can, work, source, listReview, target, exit, setLayer, setName,
    change: () => {
      work.drop();
      source.forget();
      work.setError('');
      exit.setRestart(false);
    },
    startOver: () => {
      work.newToken();
      dropKept(keeper);
      exit.setRestart(false);
      work.setBusy('');
      work.setError('');
      source.reset();
      listReview.reset();
      setLayer(props.layer ?? 'broad');
      setName(props.name ?? '');
    },
    chooseHere: () => {
      work.setError('');
      setChoosingHere(true);
    },
    stopChoosing: () => setChoosingHere(false),
    bringItIn: () => void listReview.run(fileName),
  };
  if (!table && !text) return pickStep(view);
  // from the mapping or the review alike, and Back returns to that step as it was left
  if (choosingHere && split) return chooseStep(view, split);
  if (review && listReview.shown) return reviewStep(view, review);
  if (!source.byColumns && lines) return readStep(view, lines);
  if (!table) return null;
  return columnsStep(view, table);
}

/** A list split while its review is open is chosen from here, and Back returns to the review, check marks and all */
function useChoosingHere(split: ListTarget['split']) {
  const [choosingHere, setChoosingHere] = useState(false);
  useEffect(() => {
    if (!split && choosingHere) setChoosingHere(false);
  }, [split, choosingHere]);
  // a split turns Next or Import off under the focus, which then drops to the page: Choose…, the one step left,
  // takes it
  const isSplit = !!split;
  useEffect(() => {
    const dropped = !document.activeElement || document.activeElement === document.body;
    if (isSplit && dropped) document.getElementById('cl-choose')?.focus();
  }, [isSplit]);
  return [choosingHere, setChoosingHere] as const;
}

/** The import's state as it is kept */
function keptNow(source: ListSource, listReview: ListReview, layer: Layer, name: string): KeptNow {
  const { paste, table, text, reads, mapping, readFailed, byColumns, bringIn } = source;
  const { review, askReword, askSame, shown, useReword, remove } = listReview;
  const choices = {
    mapping, layer, name, askReword, askSame, shown, useReword, remove, readFailed, byColumns, bringIn,
  };
  return { paste, table, text, reads, review, askedFor: listReview.askedFor, choices };
}

/**
 * Reads a file dropped on the empty firm's checklist, as if dropped on the import's own drop area. An import already
 * under way on this PC opens as it was left instead, with its list, reading and choices, so nothing in it is lost.
 */
function useDroppedFile(source: ListSource, dropped?: File | null, taken?: () => void) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once for each file dropped, not on every render
  useEffect(() => {
    if (!dropped) return;
    taken?.();
    if (!source.table && !source.text) void source.load(dropped);
  }, [dropped]);
}
