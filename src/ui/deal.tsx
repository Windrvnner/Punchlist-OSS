import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, nameDir, fmtDate } from './hooks';
import { recoveredParts } from '../app/recovered';
import { Icon } from './icons';
import { localYmd, type Deal } from '../domain/model';
import { versionsWord, DEAL_PAGES, pageHash, type Landing, askAbout, deleteWaits } from '../app/state';
import { FindingsSection } from './findings';
import { Composer } from './conversation';
import { dealNameRoom, EditDeal, GROUP_LABEL } from '../app/commands/deals';
import { MoreMenu, MenuItem } from './moreMenu';
import { Pick } from './qa';
import { dealFirstPassStatus, indexingStopped, resumeIndexing } from '../app/indexing';
import { conflictVersionCount, findingCounts, indexingTotals, questionCounts } from '../app/dealCounts';
import { EditField, ReadOnlyContext } from './editField';
import { readDeal } from '../app/fieldDrafts';
import { ConflictView } from './conflict';
import { runMemo } from '../app/memo';
import { openDeleteDeal } from '../app/dealSetup';
import { DealRename } from '../app/dealRename';
import { num } from './counts';

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

export function useDealLock(d: Deal): string | null {
  const s = useAppState();
  const inherited = useContext(ReadOnlyContext);
  const versions = conflictVersionCount(s, d.id);
  return versions === undefined ? inherited : `${d.name} has ${versionsWord(versions).toLowerCase()}. Choose one first`;
}

function indexingLabel(stalled: boolean, indexed: number) {
  if (!stalled) return 'Indexing';
  return indexed ? 'Indexing stopped' : 'Indexing not started';
}

export function PageTop({ deal: d, route, placeholder, noAsk = false }: { deal: Deal; route: Landing; placeholder: string; noAsk?: boolean }) {
  const store = useStore(); const s = useAppState();
  const tabCounts = {
    findings: findingCounts(s, d.id).open,
    qa: questionCounts(s, d.id).open,
    checklist: 0,
    overview: 0,
  };
  const { folders, indexed } = indexingTotals(s, d);
  const rename = useDealRename(d.id);
  const indexing = d.stage === 'indexing' ? indexingLabel(s.ui.indexStalled.includes(d.id), indexed) : '';
  const folderLabel = folders ? `${folders} folder${folders > 1 ? 's' : ''}` : '';
  const facts = [d.target, d.side, indexing, d.milestone, folderLabel].filter(Boolean).join(' · ');
  // the deal's own details are in a clash: they are read-only until a version is chosen. Its questions and findings are not affected.
  const clash = s.conflicts[d.id];
  const locked = useDealLock(d);
  return (
    <>
      <div class="trail">
        <a class="th" href="#deals">Home</a><span class="sep">›</span>
        {route === 'overview' ? <span class="tn" title={d.name}>{d.name}</span> : <>
          <a class="tn" href={'#' + pageHash('overview', d.id)} title={d.name}>{d.name}</a><span class="sep">›</span>
          <span class="tp">{DEAL_PAGES.find((p) => p[0] === route)![1]}</span>
        </>}
        {facts && <><span class="sep">·</span><span class="facts">{facts}</span></>}
        {/* the counterparty sits at the right end of the line, on every tab; the deal's structure, sector and technology are on Overview */}
        <span class="tfacts"><ReadOnlyContext.Provider value={locked}><EditField keep={`${d.id}:counterparty`} read={readDeal(d.id, 'counterparty')} label="Counterparty" placeholder="Counterparty" className="edit inl" cap={{ cls: 'lift', icon: <Icon name="building" size={14} /> }} value={d.counterparty} rev={d.rev} maxLength={80} commit={(v, over) => store.dispatch(EditDeal, { dealId: d.id, counterparty: v }, { quiet: true, over })} /></ReadOnlyContext.Provider></span></div>
      <div class="headrow">
        <DealName deal={d} {...rename} />
        <div class="dtabs">{DEAL_PAGES.map(([page, label]) => {
          const count = tabCounts[page];
          return <a key={page} href={`#${pageHash(page, d.id)}`} class={route === page ? 'on' : ''}
            aria-current={route === page ? 'page' : undefined}>{label}{count
              ? <span>{num(count)}<i> open</i></span> : null}</a>;
        })}</div>
        <DealActions deal={d} renaming={rename.field.editing} rename={() => rename.field.open()} />
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
    {s.can.checkAll && <CheckAgain deal={d} signedOut={signedOut} done={done} />}
    {s.can.memo && <MenuItem id="deal-memo" off={making} why={making ? null : signedOut}
      onClick={() => act(done, () => void runMemo(store, d.id))}>{busy ? `${busy}…` : 'Deal Memo…'}</MenuItem>}
    <MenuItem id="deal-rename" why={locked} onClick={() => act(done, rename)}>Rename</MenuItem>
    <div class="msep" />
    <MenuItem id="deal-delete" className="ddel" why={ro ?? deleteWaits(s, d.id)}
      onClick={() => act(done, () => void openDeleteDeal(store, d.id))}>Delete Deal…</MenuItem>
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
  const first = dealFirstPassStatus(s, d).waiting ? 'Indexing' : null;
  const run = () => act(done, () => void store.checkEverything(d.id, false, false));
  return <MenuItem id="deal-check" off={!!check?.busy} why={ro ?? signedOut ?? first} onClick={run}>
    {check?.busy ? 'Checking…' : 'Check Again'}
    {check?.at && !check.busy && <span>Last checked {fmtDate(localYmd(check.at))}</span>}
  </MenuItem>;
}

function useDealRename(dealId: string) {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [, redraw] = useState(0);
  const render = () => redraw((version) => version + 1);
  const [field] = useState(() => new DealRename(store, dealId, {
    render,
    focus: () => input.current?.focus(),
    close: () => {
      render();
      // Return to ⋯ unless clicking away already moved focus to another control.
      const active = document.activeElement;
      if (!active || active === document.body || active === input.current) {
        document.getElementById('deal-more')?.focus();
      }
    },
  }));
  useLayoutEffect(() => () => field.dispose(), [field]);
  return { field, input };
}

function DealName({ deal: d, field, input }: { deal: Deal } & ReturnType<typeof useDealRename>) {
  const overflow = () => {
    const box = input.current;
    if (box) box.classList.toggle('over', box.scrollWidth > box.clientWidth + 1);
  };
  useLayoutEffect(() => {
    if (field.editing) {
      input.current?.focus();
      input.current?.select();
      overflow();
    }
  }, [field.editing]);
  if (!field.editing) {
    const [head, tail] = recoveredParts(d.name);
    return <>{tail ? <RecoveredTitle name={d.name} head={head} tail={tail} />
      : <h1 class="ttl left" title={d.name} dir={nameDir(d.name)}>{d.name}</h1>}
      {field.kept && <button type="button" class="linkb keptname" id="deal-name-kept" title={field.kept.text}
        onClick={() => field.open()}>Rename not saved</button>}</>;
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void field.submit('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      field.escape();
    }
  };
  return <h1 class="ttl left renaming"><input class="rename" id="deal-name" ref={input} aria-label="Deal name"
    maxLength={dealNameRoom(field.text)} defaultValue={field.text} onKeyDown={keyDown}
    onInput={({ currentTarget }) => {
      currentTarget.maxLength = dealNameRoom(currentTarget.value);
      field.typed(currentTarget.value);
      overflow();
    }} onBlur={() => void field.submit('blur')} />
    {field.changedElsewhere && <span class="efstate ext" id="deal-name-moved">Changed elsewhere · <button type="button"
      onMouseDown={(event) => event.preventDefault()} onClick={() => void field.submit('mine')}>Keep Mine</button>
      {' '}<button type="button" onMouseDown={(event) => event.preventDefault()}
        onClick={() => field.takeTheirs()}>Take Theirs</button></span>}</h1>;
}

/**
 * What a deal's pages say while indexing has not finished and is not running: the same line, and the same way to run it,
 * wherever it is read. How far it got comes from the backend, which keeps it on this PC; with nothing indexed it has not started.
 */
export function Stalled({ deal: d }: { deal: Deal }) {
  const store = useStore(); const s = useAppState();
  if (!indexingStopped(s, d)) return null;
  const { indexed: got, files: of } = indexingTotals(s, d);
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
  const { noRoom, waiting, showIndexing } = dealFirstPassStatus(s, d);
  return (
    <div class="home top wide">
      <PageTop deal={d} route="findings" placeholder={askAbout(d.name)} />
      <Stalled deal={d} />
      {noRoom ? <NoRoom deal={d} />
        : showIndexing ? <p class="emptyline" title={INDEXING_TIP}>{INDEXING_LINE}</p>
        : !waiting && <FindingsSection deal={d} />}
    </div>
  );
}
