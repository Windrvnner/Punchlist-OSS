import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { plural } from './counts';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { DocName } from './docName';
import { ReadOnlyContext } from './editField';
import { FoldersBody, FoldersActs } from './foldersParts';
import { versionsWord, dealHash, dealLabel, type DealKinds } from '../app/state';
import { keepNewDeal } from './newDealKept';
import { useNewDealDraft } from './useNewDealDraft';
import { firmOf } from '../domain/checklist';
import { PickList } from './pickList';
import { CreateDeal, AddFolders, RemoveFolder, RestoreFolder, DeleteDeal } from '../app/commands/deals';
import { pathKey, cleanName } from '../app/commands/deals';
import { FOLDER_LABEL_MAX, dealNameRoom } from '../app/commands/deals';
import { startIndexing } from '../app/indexing';
import { ulidIds } from '../adapters/mocks';
import { likelyTwin } from '../app/dupes';
import { TwinConfirm } from './twin';
import type { Deal, Folder } from '../domain/model';

/**
 * The one modal primitive. Only one is open at a time: while it is, the app behind is inert,
 * Tab cycles inside it, Escape closes it, and closing returns focus to whatever opened it.
 */
export function Modal({ children, onClose, label, blur, className = '' }: { children: preact.ComponentChildren; onClose: () => void; label: string; blur?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {                                 // before paint: no moment where the dialog is up but the app behind still takes keys
    const opener = document.activeElement as HTMLElement | null;
    const app = document.getElementById('app'); if (app) app.inert = true;
    // first focus: what the dialog asks for (marked), else the first field, else the first button that is not Close
    const shown = (sel: string) => [...(ref.current?.querySelectorAll<HTMLElement>(sel) ?? [])].find((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
    (shown('[data-autofocus]') ?? shown('input:not([type="hidden"]):not([type="file"]),select,textarea') ?? shown('button:not(.x)') ?? shown('button'))?.focus({ preventScroll: true });
    if (ref.current) ref.current.scrollTop = 0;         // a dialog opens at its top, wherever the focus starts
    const onKey = (e: KeyboardEvent) => {
      if (ref.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return;   // a menu opened from the dialog takes Escape and Tab itself
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length);
      if (!f.length) return;
      const a = document.activeElement; const i = f.indexOf(a as HTMLElement);
      // from a part of the dialog that is not a stop itself (a list it opened on), Tab goes on to the next stop after it, Shift Tab to the one before
      if (i === -1 && a && ref.current.contains(a)) { const after = (el: HTMLElement) => !!(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING); e.preventDefault(); (e.shiftKey ? [...f].reverse().find((el) => !after(el)) ?? f[f.length - 1] : f.find(after) ?? f[0]).focus(); return; }
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    // a sticky header or footer blurs what scrolls under it, and only then: over nothing, its blur would show as a band
    const d = ref.current; const under = () => { if (!d) return; d.classList.toggle('under-top', d.scrollTop > 0); d.classList.toggle('under-foot', d.scrollTop + d.clientHeight < d.scrollHeight - 1); };
    const ro = new ResizeObserver(under); const watch = () => { if (d) for (const c of d.children) ro.observe(c); };   // parts shown later too
    const mo = new MutationObserver(() => { watch(); under(); }); if (d) { ro.observe(d); watch(); mo.observe(d, { childList: true }); d.addEventListener('scroll', under, { passive: true }); } under();
    return () => { ro.disconnect(); mo.disconnect(); d?.removeEventListener('scroll', under); document.removeEventListener('keydown', onKey, true); if (app) app.inert = false; if (opener && opener.isConnected) opener.focus(); };
  }, []);
  // a press on the backdrop never closes a dialog, so a stray click cannot lose what was typed
  return (
    <div class={`scrim ${blur ? 'blur' : ''}`}>
      <div class={`dlg ${className}`} role="dialog" aria-modal="true" aria-label={label} ref={ref}>{children}</div>
    </div>
  );
}

/**
 * The app's confirm, for a big action that asks first rather than leaning on the Undo after (few people
 * notice an Undo). The question is the title, with a line of what it changes when there is one; the safe choice takes
 * the focus and the one that acts is filled, as in Remove from my deals. It is put over the app, wherever it is asked from.
 */
export function AskFirst({ ask, text, keep = 'Keep It', go, why, onKeep, onGo }:
  { ask: string; text?: string; keep?: string; go: string; why?: string; onKeep: () => void; onGo: () => void }) {
  return createPortal(
    <Modal onClose={onKeep} label={ask} blur className={`sdlg dddlg${text ? '' : ' uldlg'}`}>
      <div class="shead"><h2 id="ask-title">{ask}</h2><button type="button" class="x" aria-label="Close" title="Close (Esc)" onClick={onKeep}><Icon name="close" size={15} /></button></div>
      {text && <p class="ddtext" id="ask-text">{text}</p>}
      <div class="xfoot"><span class="grow" /><button type="button" class="btn sm" id="ask-keep" data-autofocus onClick={onKeep}>{keep}</button><button type="button" class="btn sm pri" id="ask-go" title={why} onClick={onGo}>{go}</button></div>
    </Modal>, document.body);
}

/** A dialog's title, and the × that closes it (Escape does too) */
export function DialogHead({ title, onClose, disabled }: { title: string; onClose: () => void; disabled?: boolean }) {
  return (
    <div class="shead">
      <h2>{title}</h2>
      <button type="button" class="x" aria-label="Close" title="Close (Esc)" disabled={disabled} onClick={onClose}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

/** In place of an import dialog's buttons, once a file has been read: close it and lose what was chosen, or keep going.
 *  Like the app's other asks, the safe choice takes the focus and the one that commits is filled. */
export function LeaveFoot({ id, ask, keep, leave, go = 'Close' }: { id: string; ask: string; keep: () => void; leave: () => void; /** the leaving button's word */ go?: string }) {
  // Keep going hands the focus back to where it was when the ask came up, such as the column picker Escape was pressed in.
  // When that is gone (it was in the footer the ask replaced) or outside the dialog, the footer's main button takes it
  const first = useRef<HTMLButtonElement>(null); const was = useRef<Element | null>(null);
  useEffect(() => { was.current = document.activeElement; first.current?.focus(); }, []);
  const back = () => {
    const el = was.current; const dlg = first.current?.closest('.dlg'); keep();
    requestAnimationFrame(() => {
      // the ask may be back before this frame (a click outside or Escape straight after Keep going): its own Keep going hands the
      // focus back then, and moving it here would leave that later ask holding a stale place to return to
      if (document.getElementById(id)) return;
      if (el instanceof HTMLElement && el.isConnected && dlg?.contains(el)) { el.focus(); return; }
      (dlg?.querySelector<HTMLElement>('.xfoot .btn.pri:not(:disabled)') ?? dlg?.querySelector<HTMLElement>('input:not([type="hidden"]):not([type="file"]):not(:disabled),select:not(:disabled)'))?.focus();
    });
  };
  return <div class="xfoot" id={id}><span role="alert">{ask}</span><span class="grow" /><button class="btn sm"
    type="button" ref={first} onClick={back}>Keep Going</button><button class="btn sm pri" type="button"
    id={`${id}-go`} onClick={leave}>{go}</button></div>;
}

/** A folder's label starts as the folder's own name: nothing is read into the path. The person can change it in the row. */
export function guessLabel(p: string, _taken: string[] = []) {
  return fitLabel(p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || p);
}
/** a label taken from a folder's name, cut to the most a label holds, at a space where there is one */
export function fitLabel(name: string) {
  const s = name.trim(); if (s.length <= FOLDER_LABEL_MAX) return s;
  const cut = s.slice(0, FOLDER_LABEL_MAX + 1).lastIndexOf(' ');                       // a space just past the limit still ends a whole word
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, FOLDER_LABEL_MAX)).trim();
}

/** Keep it puts the focus back on the × that asked, once the Folders dialog is back */
const backTo = (path: string) => requestAnimationFrame(() => {
  const xs = [...document.querySelectorAll<HTMLElement>('#folders .fdrow .x')];
  xs.find((b) => b.getAttribute('aria-label') === `Remove ${path}`)?.focus();
});
/** Enter in the New deal name and counterparty fields moves on to Browse instead of creating the deal */
const enterToBrowse = (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.getElementById('nd-browse')?.focus();
};

export function NewDealDialog() {
  const store = useStore(); const s = useAppState();
  const nd = s.ui.newDeal!; const existing = nd.forDeal ? s.deals[nd.forDeal] : null;
  const [path, setPath] = useState('');
  const [pasting, setPasting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // a folder's × asks first, in place of this dialog as the deal-twin ask is, and Keep it comes back to it
  const [removing, setRemoving] = useState<{ path: string; label: string } | null>(null);
  const set = (patch: Partial<typeof nd>) => store.ui((ui) => ({ newDeal: ui.newDeal ? { ...ui.newDeal, ...patch } : null }));
  // closed with its work done: a deal made, or folders added to one. Only the New deal form keeps a draft to let go of
  const close = () => {
    if (!existing) keepNewDeal(null);
    store.ui({ newDeal: null });
  };
  // once Create has been pressed the deal is being written and cannot be called back: Escape, the × and a click outside
  // wait for it, rather than closing as if canceled while the deal is made anyway
  const creating = () => !!store.get().ui.newDeal?.busy;
  // the New deal form is kept on this PC as it changes, folders still to be read included (#55, #113)
  const putBack = (fields: Partial<typeof nd>, typed: string) => {
    set(fields);
    setPath(typed);
    setPasting(!!typed);
  };
  const kept = useNewDealDraft({ nd, path, restore: putBack, read: (p) => addPath(p) });
  const scanning = kept.waiting.length > 0;
  // dismissed rather than canceled: what was typed comes back the next time the dialog opens
  const dismiss = () => {
    if (creating()) return;
    if (!existing) kept.keepNow();
    store.ui({ newDeal: null });
  };
  const norm = pathKey;
  const taken = () => [...nd.folders.map((f) => f.label), ...(existing?.folders ?? []).map((f) => f.label)];
  // the deal's own details are in a clash: its folder labels are read-only until that clears
  const inherited = useContext(ReadOnlyContext);
  const locked = existing && s.conflicts[existing.id] ? `${existing.name} has ${versionsWord(s.conflicts[existing.id].versions.length).toLowerCase()}. Choose one first` : inherited;

  // one removed before its indexing finished goes on being indexed: files already read are not read again
  const restore = async (f: Deal['removed'][number]) => {
    if (!existing) return false; const { at, ...folder } = f;
    const r = await store.dispatch(RestoreFolder, { dealId: existing.id, folder, at });
    if (r.ok && folder.indexed < folder.files) void startIndexing(store, existing.id, [folder]);
    return r.ok;
  };
  // a folder waiting under Add folders inside a removed one, or around it, would be refused on Add once that one is back:
  // Restore says so first, as it does for a folder on the deal
  const waitingOver = (f: { path: string; label: string }): string | null => {
    const me = pathKey(f.path); const w = nd.folders.find((x) => pathKey(x.path).startsWith(me + '\\') || me.startsWith(pathKey(x.path) + '\\'));
    return w ? `${w.label || w.path}, waiting to be added, overlaps ${f.label || f.path}` : null;
  };
  const addPath = async (p: string, label?: string) => {
    p = p.trim(); if (!p) return;
    // read afresh, not from this render: a second Enter or drop while the first was being read saw the list without it
    const listed = () => (store.get().ui.newDeal?.folders ?? nd.folders).some((f) => norm(f.path) === norm(p)) || !!existing?.folders.some((f) => norm(f.path) === norm(p));
    if (listed() || kept.isReading(p)) {
      store.toast('That folder is already on the list');
      return;
    }
    // a folder inside one already on the list, or holding one, would be read twice: it is refused, with the folder it overlaps
    const inside = (a: string, b: string) => { const x = norm(a).replace(/\\/g, '/'), y = norm(b).replace(/\\/g, '/'); return x.startsWith(y + '/'); };
    const over = [...(store.get().ui.newDeal?.folders ?? nd.folders), ...(existing?.folders ?? [])].find((f) => inside(p, f.path) || inside(f.path, p));
    if (over) { store.toast(inside(p, over.path) ? `That folder is inside ${over.label}, already on the list` : `${over.label}, already on the list, is inside that folder`); return; }
    // a removed folder's path brings it back as it was, from what was already indexed, rather than reading it again
    const gone = existing?.removed.find((f) => norm(f.path) === norm(p));
    if (gone) return await restore(gone);                 // refused (the deal is in two versions): what was typed stays, and the notice says why
    kept.started(p);
    const r = await store.services.docs.scanFolder(p);
    const folder = r.ok ? { path: p, label: label ? fitLabel(label) : guessLabel(p, taken()), ...r.value } : null;
    if (!kept.finished(p, folder)) return false;       // this dialog has closed meanwhile
    if (!r.ok) { set({ error: `Couldn’t read ${p}` }); return false; }
    set({ error: '' });
    if (listed()) return true;
    store.ui((ui) => ui.newDeal ? { newDeal: { ...ui.newDeal, folders: [...ui.newDeal.folders, folder!] } } : {});
    return true;
  };
  // what was typed stays in the field unless it was added: a path that could not be read can be corrected, not retyped.
  // A path typed while the scan was running stays too: only the path that was added is cleared (#35).
  const addTyped = async () => {
    const typed = path;
    if (await addPath(typed)) setPath((now) => (now === typed ? '' : now));
  };
  // "paste a path" shows the path field and puts the focus in it
  const pastePath = () => {
    setPasting(true);
    requestAnimationFrame(() => document.getElementById('nd-path')?.focus());
  };
  const browse = async () => {
    if (store.services.fs.pickFolders) {
      const r = await store.services.fs.pickFolders();
      if (r.ok) await kept.readEach(r.value);     // all of them kept from the moment they are chosen (#113)
      return;
    }
    fileRef.current?.click();
  };
  const onFiles = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement; const fs = [...(input.files ?? [])]; input.value = '';
    if (!fs.length) return;
    const real = store.services.fs.pathFor?.(fs[0]);
    const root = real ? real.replace(/[\\/][^\\/]*$/, '') : ((fs[0] as any).webkitRelativePath || fs[0].name).split('/')[0];
    if (nd.folders.some((f) => norm(f.path) === norm(root))) { store.toast('That folder is already on the list'); return; }
    set({ error: '', folders: [...nd.folders, { path: root, label: guessLabel(root, taken()), files: fs.length, size: (fs.reduce((a, f) => a + f.size, 0) / 1e9).toFixed(1) + ' GB' }] });
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    const files = [...(e.dataTransfer?.files ?? [])];
    const items = [...(e.dataTransfer?.items ?? [])].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
    const names = store.services.fs.pathFor ? files.map((f) => store.services.fs.pathFor!(f)) : items.length ? items.map((en: any) => en.name) : files.map((f) => f.name);
    await kept.readEach(names);                   // all of them kept from the moment they are dropped (#113)
  };
  // a new deal needs a name before it can be created: until then the button is off, and pointing at it says why
  const needName = !existing && !nd.name.trim();
  const create = async (anyway = false) => {
    if (creating() || kept.busy()) return;     // a folder still being read is part of what is being created
    if (needName) return;
    // held from the press, the typed path's read included, so Escape cannot close it before the deal is made (#36);
    // kept in the store, so a second click before the next render is turned away
    set({ busy: true, error: '' });
    // a path typed but not yet added is part of the deal: add it first (unless it is already listed), and stop if it cannot be read
    const typed = path.trim(); const listed = (p: string) => nd.folders.some((f) => norm(f.path) === norm(p)) || !!existing?.folders.some((f) => norm(f.path) === norm(p));
    if (typed && !listed(typed) && !(await addPath(typed))) {
      set({ busy: false });
      return;
    }
    if (typed) setPath('');
    const folders = store.get().ui.newDeal?.folders ?? nd.folders;   // read afresh: the typed path may have just been added
    if (existing) {
      const r = await store.dispatch(AddFolders, { dealId: existing.id, folders }, { idempotencyKey: 'nd-create', quiet: true });   // a refusal is said in the dialog, once
      if (!r.ok) { set({ busy: false, error: r.error.message }); return; }
      close(); store.toast(`${folders.length} folder${folders.length > 1 ? 's' : ''} added`); void startIndexing(store, existing.id, store.get().deals[existing.id].folders.slice(-folders.length));
      return;
    }
    if (!anyway) {
      // Is it a deal the team already has? It only asks: a check that cannot be made says nothing, and the deal is made
      const room = folders.length && store.services.docs.sameRoom ? await store.services.docs.sameRoom(folders.map((f) => f.path), Object.keys(store.get().deals)) : null;
      const t = likelyTwin(store.get(), { name: nd.name, counterparty: nd.counterparty }, room?.ok ? room.value : []);
      if (t) { set({ busy: false, twin: { dealId: t.deal.id, ...(t.room ? { room: t.room } : {}), named: t.named } }); return; }
    }
    const r = await store.dispatch(CreateDeal, { name: nd.name, folders, ...nd.kinds, ...(nd.counterparty?.trim() ? { counterparty: nd.counterparty } : {}) }, { idempotencyKey: 'nd-create', quiet: true });
    if (!r.ok) { set({ busy: false, error: r.error.kind === 'invalid' ? Object.values(r.error.fields ?? {})[0] ?? r.error.message : r.error.message }); return; }
    const made = store.get().ops[r.value.opId]?.targets.find((id) => id.startsWith('d_')); const deal = made ? store.get().deals[made] : undefined;
    if (!deal) { set({ busy: false, error: 'The deal was created but could not be opened. Find it in the list on the left.' }); return; }
    close();
    store.toast(`${deal.name} created`, undefined, { glyph: 'done' });
    location.hash = dealHash(store.get().prefs, deal.id);
    if (deal.folders.length) void startIndexing(store, deal.id, deal.folders);
  };

  const askRemove = (f: Folder) => setRemoving({ path: f.path, label: f.label.trim() || guessLabel(f.path) });
  const pasteField = <PasteField path={path} setPath={setPath} add={() => void addTyped()} busy={scanning} />;
  if (existing && removing) return <AskFirst ask={`Remove ${removing.label} from ${existing.name}?`} go="Remove" onKeep={() => { setRemoving(null); backTo(removing.path); }} onGo={() => { setRemoving(null); void store.dispatch(RemoveFolder, { dealId: existing.id, path: removing.path }); }} />;
  if (!existing && nd.twin && s.deals[nd.twin.dealId]) return <TwinConfirm found={nd.twin} kinds={nd.kinds} back={() => set({ twin: undefined })} anyway={() => { set({ twin: undefined }); void create(true); }} />;
  return (
    <Modal onClose={dismiss} label={existing ? 'Folders' : 'New deal'} className="nddlg">
      {/* one dialog style: the title with the round × beside it, and no Cancel or Close button; the × dismisses, as Escape does */}
      <div class="shead"><h2 id="nd-title">{existing ? `Folders on ${existing.name}` : 'New Deal'}</h2><button
        type="button" class="x" id="nd-x" aria-label="Close" title="Close (Esc)" onClick={dismiss}><Icon name="close"
        size={15} /></button></div>
      {!existing && <> <div class="ndtop"><div><label class="lbl" for="nd-name">Name</label>
        <input class="field" id="nd-name" placeholder="Project name" maxLength={dealNameRoom(nd.name)} value={nd.name}
          onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} onKeyDown={enterToBrowse} /></div>
        <div><label class="lbl" for="nd-cp">Counterparty</label>
        <input class="field" id="nd-cp" maxLength={80} value={nd.counterparty ?? ''}
          onInput={(e) => set({ counterparty: (e.currentTarget as HTMLInputElement).value })}
          onKeyDown={enterToBrowse} /></div></div>
        <Kinds kinds={nd.kinds ?? {}} set={(k) => set({ kinds: { ...nd.kinds, ...k } })} /></>}
      {/* Folders: the deal's folders, those waiting under To Add, then the drop area */}
      {existing && <FoldersBody deal={existing} locked={locked} waitingOver={waitingOver}
        restore={(gone) => void restore(gone)} ask={askRemove} waiting={nd.folders}
        change={(folders) => set({ folders })} onDrop={(e) => void onDrop(e)} pastePath={pastePath}
        paste={pasting && pasteField} />}
      {!existing && <><div class="lbl" id="nd-flbl">Folders</div>
      <div class="nddrop" role="group" aria-labelledby="nd-flbl" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDrop(e)}>
        {nd.folders.length > 0 && <div class="ndhd" aria-hidden="true"><span>Folder</span><span>Label</span><span>Files</span><span /></div>}
        {nd.folders.map((folder, index) => (
          <div class="ndrow" key={folder.path}>
            <span class="p"><DocName name={folder.path} /></span>
            <input class="lab" aria-label="Label" maxLength={FOLDER_LABEL_MAX} value={folder.label}
              onInput={(event) => set({
                folders: nd.folders.map((entry, at) =>
                  at === index ? { ...entry, label: event.currentTarget.value } : entry),
              })} />
            <span class="cnt">{plural(folder.files, 'file')} · {folder.size}</span>
            <button type="button" class="x" aria-label="Remove"
              onClick={() => set({ folders: nd.folders.filter((_, at) => at !== index) })}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {/* New Deal's folder box ends in two buttons; Paste a Path focuses the field it shows */}
        <div class="ndadd">
          <button type="button" class="btn sm" id="nd-browse" title="Or drop folders here"
            onClick={() => void browse()}>
            <Icon name="import" size={14} />Choose Folders…
          </button>
          <button type="button" class="btn sm" id="nd-paste" onClick={pastePath}>Paste a Path</button>
        </div>
        {pasting && pasteField}
      </div></>}
      <input ref={fileRef} type="file" id="nd-file" hidden {...({ webkitdirectory: true, directory: true } as any)}
        onChange={onFiles} />
      {/* what went wrong is said beside the buttons, which stay in view however long the list is */}
      {existing && <FoldersActs error={nd.error} waiting={nd.folders.length > 0} busy={nd.busy || scanning}
        browse={() => void browse()} add={() => void create()} />}
      {!existing && <div class="acts">
        {nd.error && <p class="emptyline err" id="nd-err" role="alert">{nd.error}</p>}<span
        class="needs" id="nd-need" title={needName ? 'Give the deal a name' : undefined}><button type="button"
        class="btn pri" id="nd-create" disabled={nd.busy || scanning || needName}
        aria-description={needName ? 'Give the deal a name' : undefined}
        onClick={() => void create()}>{nd.folders.length ? 'Create and Start Indexing' : 'Create'}</button></span>
      </div>}
    </Modal>
  );
}

/** The path field "paste a path" shows: Enter or Add reads the folder, and what was typed stays until it is added */
function PasteField({ path, setPath, add, busy }: {
  path: string;
  setPath: (path: string) => void;
  add: () => void;
  busy: boolean;
}) {
  const placeholder = `C:\\Deals\\Atlas\\VDR export`;
  const enter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  };
  return (
    <div class="ndpaste">
      <input class="field" id="nd-path" aria-label="Folder path" placeholder={placeholder} value={path}
        onInput={(e) => setPath((e.currentTarget as HTMLInputElement).value)} onKeyDown={enter} />
      <button type="button" class="btn sm" id="nd-addpath" disabled={busy} onClick={add}>Add</button>
    </div>
  );
}

/**
 * The deal's structure, sector and technology on the New deal form, picked from the firm's lists so the deal starts with
 * their items. A layer the firm has no lists for is typed, as on the Overview. Always shown, lists or not,
 * so a deal is never created only to be set up afterwards.
 */
function Kinds({ kinds, set }: { kinds: DealKinds; set: (k: DealKinds) => void }) {
  const lists = firmOf(useAppState().firmList).lists;
  const field = (label: string, k: keyof DealKinds) => {
    const names = lists.filter((l) => l.layer === k).map((l) => ({ name: l.name, n: l.items.length }));
    return (<div><span class="lbl" id={`nd-${k}-l`}>{label}</span>{names.length
      ? <PickList id={`nd-${k}`} className="field" label={label} names={names} cur={kinds[k] ?? ''} empty="None" float end={k === 'technology'} onPick={(v) => set({ [k]: v })} />
      : <input class="field" id={`nd-${k}`} aria-labelledby={`nd-${k}-l`} placeholder="Not set" maxLength={80} value={kinds[k] ?? ''} onInput={(e) => set({ [k]: (e.currentTarget as HTMLInputElement).value })} />}</div>);
  };
  return <div class="ndpicks" role="group" aria-label="What kind of deal">{field('Structure', 'product')}{field('Sector', 'sector')}{field('Technology', 'technology')}</div>;
}

/**
 * Deleting a deal takes two pop-ups: the name is typed in the first, and the second asks once more. There is no Undo,
 * so the second one opens with the focus on the way out.
 */
export function DeleteDealDialog() {
  const store = useStore(); const s = useAppState();
  const dd = s.ui.deleteDeal; const d = dd ? s.deals[dd.dealId] : undefined;
  const close = () => store.ui({ deleteDeal: null });
  if (!dd || !d) return null;
  const label = dealLabel(s, d);      // what the dialogs and the notice call it; the name alone is what is typed (#27)
  const named = cleanName(dd.typed) === cleanName(d.name);   // spaces and accents as the name was kept, not as they were typed
  const next = () => { if (named) store.ui({ deleteDeal: { ...dd, sure: true, error: '' } }); };
  const go = async () => {
    const r = await store.dispatch(DeleteDeal, { dealId: d.id, typedName: dd.typed, ...(dd.seen ? { seen: dd.seen } : {}) }, { idempotencyKey: 'dd-go', quiet: true });
    if (!r.ok) { store.ui({ deleteDeal: { ...dd, error: r.error.message } }); return; }
    close();
    store.toast(`${label} deleted`, undefined, { glyph: 'done' });
    location.hash = 'deals';
  };
  if (dd.sure) return (
    <Modal key="sure" onClose={close} label={`Delete ${label} for good?`} blur className="sdlg dddlg">
      <div class="shead"><h2 id="dd-title">Delete {label} for good?</h2><button type="button" class="x"
        aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <p class="ddtext">Its findings and its Q&amp;A will be deleted. This cannot be undone.</p>
      {dd.error && <p class="emptyline err" id="dd-err" role="alert">{dd.error}</p>}
      <div class="xfoot"><span class="grow" /><button type="button" class="btn sm" id="dd-keep" data-autofocus
        onClick={close}>Keep the Deal</button><button type="button" class="btn sm pri" id="dd-go"
        onClick={() => void go()}>Delete for Good</button></div>
    </Modal>
  );
  return (
    <Modal key="name" onClose={close} label="Delete this deal?" blur className="sdlg dddlg">
      <div class="shead"><h2 id="dd-title">Delete this deal?</h2><button type="button" class="x" aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <p class="ddtext"><b>{label}</b> will be deleted with its findings and its Q&amp;A.
        Type <b>{d.name}</b> to continue.</p>
      <input class="field in" id="dd-name" placeholder="Deal name" aria-label="Deal name" value={dd.typed} onInput={(e) => store.ui({ deleteDeal: { ...dd, typed: (e.currentTarget as HTMLInputElement).value, error: '' } })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }} />   {/* without preventDefault the same key press would go on to the button the second pop-up puts the focus on */}
      <div class="xfoot"><span class="grow" /><button type="button" class="btn sm pri" id="dd-next" disabled={!named} onClick={next}>Continue</button></div>
    </Modal>
  );
}

export { ulidIds };
