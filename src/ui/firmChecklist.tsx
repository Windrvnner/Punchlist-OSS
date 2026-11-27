/** The firm's checklists and the steps of its import, presented in one mounted dialog. */
import { useEffect, useLayoutEffect, useReducer, useState } from 'preact/hooks';
import { versionsWord } from '../app/state';
import { useAppState, useStore, fmtDateTime } from './hooks';
import { Modal } from './dialogs';
import { ConflictView } from './conflict';
import { LAYER_NAMES, type Layer } from '../domain/checklist';
import { checklistShelf } from '../app/checklistImport';
import { plural } from './counts';
import { ChecklistImportSession } from '../app/checklistImportSession';
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
  const [session] = useState(() => new ChecklistImportSession(store, props));
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const off = session.subscribe(() => redraw(null));
    void session.start();
    return () => {
      off();
      session.dispose();
    };
  }, [session]);
  const { dropped, taken } = props;
  useEffect(() => {
    if (dropped) {
      taken?.();
      void session.loadDropped(dropped);
    }
  }, [session, dropped]);
  const [restart, setRestart] = useState(false);
  const current = session.view;
  const { target, step, source, listReview } = current;
  const isSplit = !!target.split;
  useEffect(() => {
    const unfocused = !document.activeElement || document.activeElement === document.body;
    if (isSplit && unfocused) document.getElementById('cl-choose')?.focus();
  }, [isSplit]);
  const list = target.layer === 'broad' ? 'General' : target.name;
  const view: ImportView = {
    ...current, title: listReview.review ? `Import a Checklist · ${list}` : 'Import a Checklist',
    exit: { restart, setRestart, back: session.back, close: session.close },
    change: () => {
      setRestart(false);
      session.change();
    },
    startOver: () => {
      setRestart(false);
      session.startOver();
    },
  };
  switch (step) {
    case 'pick': return pickStep(view);
    case 'choose': return chooseStep(view, target.split!);
    case 'review': return reviewStep(view, listReview.review!);
    case 'read': return readStep(view);
    case 'columns': return columnsStep(view, source.table!);
  }
}
