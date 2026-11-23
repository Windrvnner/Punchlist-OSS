import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, nameDir, fmtDate } from './hooks';
import { recoveredParts } from '../app/recovered';
import { Icon } from './icons';
import { localYmd, type Deal } from '../domain/model';
import { dealQuestions, versionsWord, DEAL_PAGES, pageHash, type Landing, askAbout, deleteWaits } from '../app/state';
import { FindingsSection } from './findings';
import { Composer } from './conversation';
import { dealNameRoom, EditDeal, GROUP_LABEL } from '../app/commands/deals';
import { MoreMenu, MenuItem } from './moreMenu';
import { Pick } from './qa';
import { resumeIndexing, liveFolders } from '../app/indexing';
import { EditField, ReadOnlyContext, readDeal } from './editField';
import { ConflictView } from './conflict';
import { runMemo } from '../app/memo';
import { keptDrafts, hasTexts } from './keptDrafts';
import { num } from './counts';

/**
 * A new deal name being typed, by deal, kept on this PC as it is typed until it is saved or let go: `text`, and `base`, the
 * name it was typed over. One that could not be saved (signed out, say) waits behind "Rename not saved" by the name.
 */
const keptNames = keptDrafts('deal-name', hasTexts('text', 'base'));

/** Why the deal's own details cannot be edited just now, if they cannot: they are in a clash until a version is chosen. */
/**
 * A recovered copy's page heading: when the whole name has no room, its own name is cut by whole letters with a "…", so
 * " (recovered)" always shows, one space after it, and nothing is clipped through a letter. The room is the
 * heading's with the whole name in it, measured again as the window changes size; the whole name is on hover.
 */
function RecoveredTitle({ name, head, tail }: { name: string; head: string; tail: string }) {
  const ref = useRef<HTMLHeadingElement>(null);   // its text is set here, not rendered: it is measured as it is set
  useLayoutEffect(() => {
    const h = ref.current; if (!h) return;
    const letters = Array.from(head);
    const fit = () => {
      h.textContent = name; const room = h.clientWidth;
      const fits = (k: number) => { h.textContent = k >= letters.length ? name : `${letters.slice(0, k).join('').trimEnd()}…${tail}`; return h.scrollWidth <= room; };
      let lo = 1, hi = letters.length;                                   // the most letters that fit; one at least
      if (fits(hi)) lo = hi; else while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
      const text = lo >= letters.length ? name : `${letters.slice(0, lo).join('').trimEnd()}…${tail}`;
      h.textContent = text;
    };
    fit();
    const row = h.parentElement; const ro = row && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; if (row) ro?.observe(row);
    return () => ro?.disconnect();
  }, [name, head, tail]);
  return <h1 class="ttl left" ref={ref} title={name} aria-label={name} dir={nameDir(name)} />;
}

/**
 * The first delete pop-up opens at once; what this PC has taken in is asked as it opens and kept on it, so work from another
 * PC that arrives while the person confirms counts as unseen and is kept there. It is back long before a name is typed.
 */
function openDelete(store: ReturnType<typeof useStore>, dealId: string) {
  store.ui({ deleteDeal: { dealId, typed: '', error: '' } });
  void store.services.repo.seen?.().then((r) => { const dd = store.get().ui.deleteDeal; if (r.ok && dd?.dealId === dealId && !dd.seen) store.ui({ deleteDeal: { ...dd, seen: r.value } }); });
}

export function useDealLock(d: Deal): string | null {
  const s = useAppState(); const inherited = useContext(ReadOnlyContext); const clash = s.conflicts[d.id];
  return clash ? `${d.name} has ${versionsWord(clash.versions.length).toLowerCase()}. Choose one first` : inherited;
}

export function PageTop({ deal: d, route, placeholder, noAsk = false }: { deal: Deal; route: Landing; placeholder: string; noAsk?: boolean }) {
  const store = useStore(); const s = useAppState();
  const open = dealQuestions(s, d.id).filter((q) => q.status === 'open').length;
  const openF = Object.values(s.findings).filter((f) => f.dealId === d.id && f.status === 'open').length;
  const [renaming, setRenaming] = useState(false);
  // the rename box closes back onto ⋯, where Rename was chosen, unless the focus has already gone elsewhere (a click
  // on ⋯ itself, which saves the name as the box loses the focus, leaves it in the menu that opens)
  const renamed = () => {
    setRenaming(false);
    const active = document.activeElement;
    if (!active || active === document.body || active.id === 'deal-name') document.getElementById('deal-more')?.focus();
  };
  const facts = [d.target, d.side, d.stage === 'indexing' ? (s.ui.indexStalled.includes(d.id) ? (liveFolders(s, d).some((f) => f.indexed > 0) ? 'Indexing stopped' : 'Indexing not started') : 'Indexing') : '', d.milestone, d.folders.length ? `${d.folders.length} folder${d.folders.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  // the deal's own details are in a clash: they are read-only until a version is chosen. Its questions and findings are not affected.
  const clash = s.conflicts[d.id];
  const locked = useDealLock(d);
  return (
    <>
      <div class="trail"><a class="th" href="#deals">Home</a><span class="sep">›</span>{route === 'overview' ? <span class="tn" title={d.name}>{d.name}</span> : <><a class="tn" href={`#overview-${d.id}`} title={d.name}>{d.name}</a><span class="sep">›</span><span class="tp">{DEAL_PAGES.find((p) => p[0] === route)![1]}</span></>}{facts && <><span class="sep">·</span><span class="facts">{facts}</span></>}
        {/* the counterparty sits at the right end of the line, on every tab; the deal's structure, sector and technology are on Overview */}
        <span class="tfacts"><ReadOnlyContext.Provider value={locked}><EditField keep={`${d.id}:counterparty`} read={readDeal(d.id, 'counterparty')} label="Counterparty" placeholder="Counterparty" className="edit inl" cap={{ cls: 'lift', icon: <Icon name="building" size={14} /> }} value={d.counterparty} rev={d.rev} maxLength={80} commit={(v, over) => store.dispatch(EditDeal, { dealId: d.id, counterparty: v }, { quiet: true, over })} /></ReadOnlyContext.Provider></span></div>
      <div class="headrow">
        <DealName deal={d} renaming={renaming} open={() => setRenaming(true)} done={renamed} />
        <div class="dtabs">{DEAL_PAGES.map(([page, label]) => {
          const count = page === 'findings' ? openF : page === 'qa' ? open : 0;
          return <a key={page} href={`#${pageHash(page, d.id)}`} class={route === page ? 'on' : ''}
            aria-current={route === page ? 'page' : undefined}>{label}{count
              ? <span>{num(count)}<i> open</i></span> : null}</a>;
        })}</div>
        <DealActions deal={d} renaming={renaming} rename={() => setRenaming(true)} />
      </div>
      {/* on Q&A an open question takes the ask box's place, at the top of the page (design G) */}
      {!noAsk && <div class="askslot"><Composer scope={{ kind: 'deal', dealId: d.id }} launch="deal" placeholder={placeholder} /></div>}
      {clash && <ConflictView conflict={clash} />}
    </>
  );
}

/**
 * The deal header's controls: Deal status as the app's own pick, in its own order
 * (decisions.md, Dropdown menus), then one ⋯ menu, lit while the name is being renamed.
 */
function DealActions({ deal: d, renaming, rename }: { deal: Deal; renaming: boolean; rename: () => void }) {
  const store = useStore();
  const locked = useDealLock(d);
  const groups = Object.keys(GROUP_LABEL) as Deal['group'][];
  const move = (group: string) => void store.dispatch(EditDeal, { dealId: d.id, group: group as Deal['group'] });
  return (
    <span class="hacts">
      <Pick name="deal-group" label="Deal status" wrap="stpick" cls="hsel" chev end value={d.group} ro={locked}
        options={groups.map((g) => ({ v: g, text: GROUP_LABEL[g] }))} onPick={move} />
      <DealMenu deal={d} lit={renaming} rename={rename} />
    </span>
  );
}

/** Runs a menu item: the menu shuts with the focus back on ⋯, then the item's action, so a dialog returns there. */
function act(done: () => void, then: () => void) {
  done();
  then();
}

/**
 * Check again, Deal memo…, Rename and Delete deal…, in one ⋯ menu. While the memo is made (its save dialog
 * comes first), ⋯ spins and the memo's item reads "Making the deal memo…", off. What cannot be used just now is off,
 * with the reason on hover; a deal that can't be deleted yet says why (decisions.md, Sync).
 */
function DealMenu({ deal: d, lit, rename }: { deal: Deal; lit: boolean; rename: () => void }) {
  const store = useStore();
  const s = useAppState();
  const locked = useDealLock(d);
  const ro = useContext(ReadOnlyContext);
  // the memo and a check need Intelligence: off while nobody is signed in
  const signedOut = s.signin?.out ? store.readOnly() : null;
  const making = s.ui.memoBusy.includes(d.id);
  const busy = making ? 'Making the deal memo' : undefined;
  return <MoreMenu id="deal-more" menuId="deal-menu" lit={lit} busy={busy} items={(done) => <>
    {store.services.ai.checkAll && <CheckAgain deal={d} signedOut={signedOut} done={done} />}
    {store.services.ai.memo && <MenuItem id="deal-memo" off={making} why={making ? null : signedOut}
      onClick={() => act(done, () => void runMemo(store, d.id))}>{busy ? `${busy}…` : 'Deal Memo…'}</MenuItem>}
    <MenuItem id="deal-rename" why={locked} onClick={() => act(done, rename)}>Rename</MenuItem>
    <div class="msep" />
    <MenuItem id="deal-delete" className="ddel" why={ro ?? deleteWaits(s, d.id)}
      onClick={() => act(done, () => openDelete(store, d.id))}>Delete Deal…</MenuItem>
  </>} />;
}

/**
 * The ⋯ menu's Check again, with when the checklist and findings were last checked. Nothing is checked again
 * before the first pass has found anything (Overview has no blocks then either).
 */
function CheckAgain({ deal: d, signedOut, done }: { deal: Deal; signedOut: string | null; done: () => void }) {
  const store = useStore();
  const s = useAppState();
  const ro = useContext(ReadOnlyContext);
  const check = s.checks[d.id];
  const found = Object.values(s.findings).some((f) => f.dealId === d.id);
  const first = d.stage === 'indexing' && !found ? 'Indexing' : null;
  const run = () => act(done, () => void store.checkEverything(d.id, false, false));
  return <MenuItem id="deal-check" off={!!check?.busy} why={ro ?? signedOut ?? first} onClick={run}>
    {check?.busy ? 'Checking…' : 'Check Again'}
    {check?.at && !check.busy && <span>Last checked {fmtDate(localYmd(check.at))}</span>}
  </MenuItem>;
}

/**
 * The deal's name; in place it becomes a field. Enter or clicking away saves. Escape leaves the name as it was: a new
 * rename is dropped, but a name already kept (one that could not be saved, or changed elsewhere) stays kept behind
 * "Rename not saved". Only a save, Take theirs, or emptying the name lets a kept name go.
 */
function DealName({ deal: d, renaming, open, done }: { deal: Deal; renaming: boolean; open: () => void; done: () => void }) {
  const store = useStore(); const ref = useRef<HTMLInputElement>(null); const settled = useRef(false);
  const base = useRef(d.name);                                       // the name the box was opened on: what the new one is typed over
  const [moved, setMoved] = useState(false);                         // the name was changed elsewhere since: the person chooses
  const held = useRef<{ text: string; base: string } | null>(null);   // the name kept when the box opened (or when a save of it was refused): Escape puts it back
  // a name longer than the field fades out at its edges instead of being cut through a letter
  const over = () => { const i = ref.current; i?.classList.toggle('over', i.scrollWidth > i.clientWidth + 1); };
  // kept on this PC as it is typed, so a crash or a page change keeps it
  const typed = () => {
    const input = ref.current;
    if (input) {
      input.maxLength = dealNameRoom(input.value);
      keptNames.set(d.id, { text: input.value, base: base.current });
    }
    over();
  };
  useLayoutEffect(() => { if (renaming) { settled.current = false; setMoved(false); base.current = keptNames.get(d.id)?.base ?? d.name; held.current = keptNames.get(d.id) ?? null; ref.current?.focus(); ref.current?.select(); over(); } }, [renaming]);
  const kept = keptNames.get(d.id);
  // a copy kept from a deal deleted elsewhere keeps "(recovered)" in view, its own name shortened instead
  const [head, tail] = recoveredParts(d.name);
  if (!renaming) return <>{tail ? <RecoveredTitle name={d.name} head={head} tail={tail} /> : <h1 class="ttl left" title={d.name} dir={nameDir(d.name)}>{d.name}</h1>}
    {/* a name that could not be saved waits here: the person opens it when they choose, so it never takes the focus */}
    {kept && <button type="button" class="linkb keptname" id="deal-name-kept" title={kept.text} onClick={open}>Rename not saved</button>}</>;
  const letGo = () => { settled.current = true; keptNames.delete(d.id); done(); };
  // Escape: a kept name stays kept (the box only closes); a new rename never refused is dropped, as before
  const dismiss = () => { const h = held.current; if (h) { keptNames.set(d.id, h); settled.current = true; done(); } else letGo(); };
  // Enter on an emptied name says why it can't be saved and stays in the field; leaving the field keeps the old name
  const save = async (enter = false, mine = false) => {
    if (settled.current || !ref.current) return;   // the box already gone (the page left): what it held stays as it was kept
    if (moved && !mine) return;                     // waiting for Keep mine / Take theirs
    const v = ref.current.value.trim();
    if (!v && enter) { store.toast('A deal needs a name'); return; }
    settled.current = true;
    if (!v || v === d.name) { letGo(); return; }
    // typed over `base`: if the name has changed elsewhere since, nothing is written and the person chooses (as a field does)
    const r = await store.dispatch(EditDeal, { dealId: d.id, name: v }, { quiet: true, over: mine ? d.name : base.current });
    if (r.ok) { keptNames.delete(d.id); done(); return; }
    keptNames.set(d.id, { text: v, base: base.current }); settled.current = false; held.current = { text: v, base: base.current };
    if (r.error.kind === 'conflict') { setMoved(true); return; }
    const ro = store.readOnly();
    // signed out: the name is kept and the box closes, giving the page back; "Rename not saved" opens it again
    if (ro) { store.toast(ro); settled.current = true; done(); return; }
    store.toast(r.error.message); ref.current?.focus();
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  const shown = kept?.text ?? d.name;
  return <h1 class="ttl left renaming"><input class="rename" id="deal-name" ref={ref} aria-label="Deal name"
    maxLength={dealNameRoom(shown)} defaultValue={shown} onInput={typed} onBlur={() => void save()}
    onKeyDown={keyDown} />
    {moved && <span class="efstate ext" id="deal-name-moved">Changed elsewhere · <button type="button"
      onMouseDown={(e) => e.preventDefault()} onClick={() => { base.current = d.name; setMoved(false);
      void save(true, true); }}>Keep Mine</button> <button type="button" onMouseDown={(e) => e.preventDefault()}
      onClick={letGo}>Take Theirs</button></span>}</h1>;
}

/**
 * What a deal's pages say while indexing has not finished and is not running: the same line, and the same way to run it,
 * wherever it is read. How far it got comes from the backend, which keeps it on this PC; with nothing indexed it has not started.
 */
export function Stalled({ deal: d }: { deal: Deal }) {
  const store = useStore(); const s = useAppState();
  if (d.stage !== 'indexing' || !s.ui.indexStalled.includes(d.id)) return null;
  const fs = liveFolders(s, d); const got = fs.reduce((a, f) => a + f.indexed, 0); const of = fs.reduce((a, f) => a + f.files, 0);
  // not running and not finished: the app tries again by itself. Which line is shown depends on why it is waiting
  const wait = s.ui.indexWaiting[d.id];
  // the line says where it stopped and why; what happens next is on the button's hover (no explainer text on screen)
  const next = wait === 'away' ? (got ? 'It will resume when the data room can be reached.' : 'It will start when the data room can be reached.') : wait === 'retry' ? 'It will be tried again automatically.' : undefined;
  return <p class="loadfail" id="ix-stalled" role="status">{got
    ? `Indexing stopped at ${num(got)} of ${num(of)} files.` :
    'Indexing has not started.'}{s.ui.indexWhy[d.id] ? ` ${s.ui.indexWhy[d.id]}` : ''} <button type="button"
    class="tundo" id="ix-resume" title={next} onClick={() => void resumeIndexing(store, d.id)}>{wait ? 'Retry Now' : got
    ? 'Resume' : 'Start Indexing'}</button></p>;
}
/** A deal with no folders yet. */
export function NoRoom({ deal: d }: { deal: Deal }) {
  const store = useStore();
  return <p class="emptyline" title="The first pass starts once the folders have been indexed.">No data room yet. <button type="button" class="linkb" id="add-first-folder" onClick={() => store.ui({ newDeal: { name: d.name, folders: [], error: '', busy: false, forDeal: d.id } })}>Add folders</button></p>;
}
// the fact on the page; how it goes on is in the tooltip (no explainer text on screen)
export const INDEXING_LINE = 'Indexing';
export const INDEXING_TIP = 'The first pass starts when every folder has been indexed; findings appear here as they are found.';

/** The Findings page: the findings and nothing above them. The summary, the gaps and the folders are on Overview. */
export function DealPage({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const d = s.deals[dealId];
  useEffect(() => { void store.loadDeal(dealId); }, [dealId]);
  if (!d) return null;
  const none = !Object.values(s.findings).some((f) => f.dealId === d.id);
  const indexing = d.stage === 'indexing'; const stopped = indexing && s.ui.indexStalled.includes(d.id);
  return (
    <div class="home top wide">
      <PageTop deal={d} route="findings" placeholder={askAbout(d.name)} />
      <Stalled deal={d} />
      {none && !d.folders.length ? <NoRoom deal={d} />
        : none && stopped ? null
        : none && indexing ? <p class="emptyline" title={INDEXING_TIP}>{INDEXING_LINE}</p>
        : <FindingsSection deal={d} />}
    </div>
  );
}
