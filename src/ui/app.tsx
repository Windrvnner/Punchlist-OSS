import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dealRows, interruptedOperations, isInterrupted, railDealGroups } from '../app/dealView';
import { commandLabel } from '../app/commandLabels';
import { undoFromNotice } from '../app/undoNotice';
import { StoreContext, useAppState, useStore, lastInput, nameDir } from './hooks';
import { Icon } from './icons';
import { Notice, NoticeWords } from './notice';
import type { Store } from '../app/store';
import type { State } from '../app/state';
import { QaPage, UndoImportDialog } from './qa';
import { DealPage } from './deal';
import { OverviewPage } from './overview';
import { ChecklistPage } from './checklist';
import { ConversationPage, Composer } from './conversation';
import { QueueStrip } from './queueStrip';
import { scopeOfRoute, scopeValid } from '../app/conversations';
import { NewDealDialog, DeleteDealDialog } from './dialogs';
import { AddDealDialog, DealMore, RemoveDealDialog } from './addDeal';
import { ExportQaDialog, ExportFindingsDialog } from './transfer';
import { ImportDialog } from './qaImport';
import { IssuesListDialog } from './issuesList';
import { CloseSettledDialog } from './closeSettled';
import { AddUnresolvedDialog } from './addUnresolved';
import { DeletedDialog } from './deleted';
import { ResolveDialog } from './resolve';
import { SettingsDialog } from './settings';
import { FirmChecklistDialog } from './firmChecklist';
import { LocateDialog } from './relink';
import { PlaceKeptDialog } from './placeKept';
import { SearchBox } from './search';
import { TwinLabel } from './dealLabel';
import { homeExamples } from './homeExamples';
import { AccountRow } from './connection';
import { ReadOnlyContext, SignedOutContext } from './editField';
import { SERVICE } from '../control';
import { takeNavPatch, closeDocument, takeFocusAfter } from './nav';
import { isReading, dealHash, dealTwinLabels } from '../app/state';
import { num } from './counts';

function routeFromHash(): State['ui']['route'] {
  const h = (location.hash || '#deals').slice(1);
  const fm = /^finding-(d_[0-9A-Z]{26})-(f_[0-9A-Z]{26})$/.exec(h);
  if (fm) return { name: 'finding', dealId: fm[1], findingId: fm[2] };
  const qm = /^q-(d_[0-9A-Z]{26})-(q_[0-9A-Z]{26})$/.exec(h);
  if (qm) return { name: 'question', dealId: qm[1], questionId: qm[2] };
  const cm = /^chat(?:-(d_[0-9A-Z]{26}))?(?:-(c[0-9a-z]{4,24}))?$/.exec(h);
  if (cm) return { name: 'chat', ...(cm[1] ? { dealId: cm[1] } : {}), ...(cm[2] ? { conv: cm[2] } : {}) };
  const m = /^(overview|deal|checklist|qa)-(d_[0-9A-Z]{26})$/.exec(h);
  if (m) return { name: m[1] as 'overview' | 'deal' | 'checklist' | 'qa', dealId: m[2] };
  return { name: 'home' };
}

export function App({ store }: { store: Store }) {
  return <StoreContext.Provider value={store}><Shell /></StoreContext.Provider>;
}

function Shell() {
  const store = useStore(); const s = useAppState();
  useEffect(() => {
    const apply = () => {
      const route = routeFromHash(); const was = store.get().ui.route;
      const deal = (r: State['ui']['route']) => ('dealId' in r && r.dealId ? r.dealId : null);
      // list filters and the selected question belong to one deal: moving to another deal starts clean
      const fresh = deal(route) !== deal(was) ? { findingFilter: { status: 'open' as const, workstream: '', text: '', reviewed: '' as const }, qaFilter: { status: 'open' as const, workstream: '', text: '' }, checklistFilter: 'all' as const, selectedQuestion: null, selectedChecklist: null } : {};
      store.ui({ route, doc: null, docAside: null, side: null, queueSearch: '', dialog: null,
        searchFocus: null, ...fresh, ...takeNavPatch() });
      // the link or button that was pressed is gone with the old page: focus goes to what opened the document being closed, else to the new page, not to nowhere
      const backTo = takeFocusAfter();
      requestAnimationFrame(() => { const back = backTo.map((sel) => document.querySelector<HTMLElement>(sel)).find(Boolean); if (back) back.focus(); else if (!document.activeElement || document.activeElement === document.body) document.getElementById('view')?.focus({ preventScroll: true }); });
    };
    apply(); window.addEventListener('hashchange', apply); return () => window.removeEventListener('hashchange', apply);
  }, []);
  useLayoutEffect(() => {                                 // title and body classes change with the frame they describe
    const r = s.ui.route; const d = 'dealId' in r && r.dealId ? s.deals[r.dealId] : null;
    const f = r.name === 'finding' ? s.findings[r.findingId] : null; const q = r.name === 'question' ? s.questions[r.questionId] : null;
    document.title = d ? `${r.name === 'qa' ? 'Q&A · ' : f ? f.title + ' · ' : q ? `Q${q.n} · ` : ''}${d.name} — Punchlist` : r.name === 'chat' ? 'Ask — Punchlist' : 'Punchlist';
    document.body.classList.toggle('booting', s.boot.stage !== 'ready');
    document.body.classList.toggle('offline', s.net.down);
  }, [s.ui.route, s.deals, s.findings, s.questions, s.boot.stage, s.net.down]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      const st = store.get().ui;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();                                             // Ctrl K puts the cursor in search, or takes it out again; it does nothing over a dialog
        if (st.palette) { store.ui({ palette: false }); (document.activeElement as HTMLElement | null)?.blur?.(); } else if (!document.querySelector('.scrim') && store.get().boot.stage === 'ready') store.ui({ palette: true });
        return;
      }
      // Ctrl Enter saves the form being typed in, as its main button would: the card whose buttons row holds the field
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter' && typing) {
        let card: HTMLElement | null = t; while (card && !card.querySelector(':scope > .cacts')) card = card.parentElement;
        const b = card?.querySelector<HTMLButtonElement>(':scope > .cacts .btn.pri');
        if (b) { e.preventDefault(); if (!b.disabled) b.click(); return; }
      }
      if (document.querySelector('.scrim')) return; // a dialog owns the keyboard
      // Ctrl Z takes back the last action while its message is still showing, the same as its Undo button
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
        const t = [...st.toasts].reverse().find((x) => x.action?.opId);
        if (t) { e.preventDefault(); void undoFromNotice(store, t); }
        return;
      }
      // Escape closes the document; from the composer too, where it has no other meaning
      if (e.key === 'Escape' && isReading(st) && (!typing || t.id === 'pask')) { closeDocument(store); return; }
      // and the finding or question open beside the conversation
      if (e.key === 'Escape' && st.side && (!typing || t.id === 'pask')) { store.ui({ side: null }); return; }
      // Left and Right step through the documents being read
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && isReading(st) && !typing && !document.querySelector('[role="menu"], [data-menu]')) { const b = document.querySelector<HTMLButtonElement>(e.key === 'ArrowRight' ? '#doc-next' : '#doc-prev'); if (b && !b.disabled) { e.preventDefault(); b.click(); } return; }
      // Page Up and Page Down step through the pages of the document being read, scrolling a zoomed page first
      if ((e.key === 'PageUp' || e.key === 'PageDown') && isReading(st) && !typing && !document.querySelector('[role="menu"], [data-menu]')) { if (document.querySelector('#page-next')) { e.preventDefault(); document.dispatchEvent(new CustomEvent('page-key', { detail: e.key === 'PageDown' ? 1 : -1 })); } return; }
      // Ctrl + and Ctrl − zoom the page, not the whole window, and Ctrl 0 puts it back to its own size
      if ((e.ctrlKey || e.metaKey) && !e.altKey && isReading(st) && ['=', '+', '-', '_', '0'].includes(e.key)) { e.preventDefault(); document.dispatchEvent(new CustomEvent('page-zoom', { detail: e.key === '0' ? 0 : e.key === '-' || e.key === '_' ? -1 : 1 })); return; }
      // Up and Down move through the queue, but never away from an open form (an edit, a closing note): that would throw it away
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && !e.defaultPrevented && !document.querySelector('[role="menu"], [data-menu], [data-holds-work]') && document.body.classList.contains('queued')) { const b = document.querySelector<HTMLElement>(`.qarrows [data-qstep="${e.key === 'ArrowDown' ? 1 : -1}"]`); if (b) { e.preventDefault(); if (!(e.repeat && b.hasAttribute('data-wraps'))) b.click(); } }   // a held key stops at the end rather than cycling round
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);
  const ready = s.boot.stage === 'ready';
  const r = s.ui.route;
  const routeDeal = 'dealId' in r && r.dealId ? s.deals[r.dealId] : null;
  const scope = scopeOfRoute(r);
  // read-only while nobody is signed in to Intelligence: every control that would change something is off, with the reason on hover
  const ro = s.signin?.out ? store.readOnly() : null;
  return (
    <SignedOutContext.Provider value={ro}><ReadOnlyContext.Provider value={ro}>
      <div id="app">
        <a class="skip" id="skip" href="#view" onClick={(e) => { e.preventDefault(); document.getElementById('view')?.focus(); }}>Skip to the page</a>
        <Rail />
        <section class="stage">
          <main class={`view homeview ${r.name !== 'home' ? 'top' : ''} ${scope ? 'chatview' : ''}`} id="view" tabIndex={-1}>
            {s.boot.error && !ready ? <BootFailed message={s.boot.error} /> : !ready ? <BootShell /> : r.name === 'home' ? <Home /> : scope ? <ConversationPage scope={scope} /> : !routeDeal ? <NotFound /> : r.name === 'qa' ? <QaPage key={routeDeal.id} dealId={routeDeal.id} /> : r.name === 'overview' ? <OverviewPage key={routeDeal.id} dealId={routeDeal.id} /> : r.name === 'checklist' ? <ChecklistPage key={routeDeal.id} dealId={routeDeal.id} /> : <DealPage key={routeDeal.id} dealId={routeDeal.id} />}
            {/* keyed by deal: going to another deal starts its pages afresh, so a rename box or a half-typed field never carries over to the wrong deal */}
          </main>
          {ready && scope && scopeValid(s, scope) === true && <Composer scope={scope} />}
        </section>
      </div>
      <Notices />
      {s.ui.addDeal && <AddDealDialog />}
      {s.ui.removeDeal && <RemoveDealDialog dealId={s.ui.removeDeal} />}
      {s.ui.newDeal && <NewDealDialog />}
      {s.ui.deleteDeal && s.deals[s.ui.deleteDeal.dealId] && <DeleteDealDialog />}
      {s.ui.dialog && s.deals[s.ui.dialog.dealId] && (s.ui.dialog.kind === 'importQa' ? <ImportDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'exportQa' ? <ExportQaDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'deleted' ? <DeletedDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'importIssues' ? <IssuesListDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'placeKept' ? <PlaceKeptDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'closeSettled' ? <CloseSettledDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'undoImport' ? <UndoImportDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'addUnresolved' ? <AddUnresolvedDialog dealId={s.ui.dialog.dealId} /> : s.ui.dialog.kind === 'resolveQa' ? <ResolveDialog key="rsv" dealId={s.ui.dialog.dealId} questionId={s.ui.dialog.questionId} /> : <ExportFindingsDialog dealId={s.ui.dialog.dealId} />)}
      {s.ui.settings && <SettingsDialog />}
      {s.ui.firmChecklist && <FirmChecklistDialog />}
      {s.ui.locate && <LocateDialog />}
    </ReadOnlyContext.Provider></SignedOutContext.Provider>
  );
}

/**
 * Read-only while nobody is signed in (decisions: "Intelligence sign-in"): the offline bar's capsule says so and stays until
 * someone signs in, with Sign in as its one, filled, action. With single sign-on the only way, Sign in opens its
 * window; otherwise Settings, at its sign-in row.
 */
function SignInBar() {
  const store = useStore();
  const [hidden, setHidden] = useState(false);   // until it shows again: the account row still says Read-only
  if (hidden) return null;
  return (
    <Notice class="robar" id="signin-bar" role="alert" glyph="warn" onClose={() => setHidden(true)}
      actions={[{ label: 'Sign In', run: () => store.signInFromNotice(), id: 'signin-bar-go' }]}>
      <NoticeWords text={`Read-only · Not signed in to ${SERVICE}`} />
    </Notice>
  );
}

function BootShell() {
  return <div class="home"><div class="center"><h1 class="ttl">What would you like to know?</h1><form
    class="askbox glass" id="homeask" aria-hidden="true"><div class="chips" /><textarea rows={1} disabled
    aria-label="Ask" /><div class="bar" /></form></div></div>;
}

/** Start-up failed for a reason other than a lost connection (which the offline bar covers): say what, and offer Retry. */
function BootFailed({ message }: { message: string }) {
  const store = useStore(); const [busy, setBusy] = useState(false);
  return (
    <div class="home firstrun" role="alert">
      <div class="center">
        <h1 class="ttl">Punchlist couldn’t start</h1>
        <p class="fr-line" id="boot-error">
          {message}{' '}
          <button
            type="button"
            class="linkb"
            id="boot-retry"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await store.retryBoot();
              setBusy(false);
            }}
          >
            Retry
          </button>
        </p>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div class="home firstrun">
      <div class="center">
        <h1 class="ttl">That deal isn’t here</h1>
        <p class="fr-line">
          It may have been deleted. <a class="linkb" href="#deals">Back to Home</a>
        </p>
      </div>
    </div>
  );
}

function Rail() {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext);
  // which groups are unfolded is one of the person's view choices: it is kept with the others, so a reload does not unfold them
  const open = s.prefs.railOpen; const setOpen = (next: Record<string, boolean>) => store.setPrefs({ railOpen: next });
  const r = s.ui.route; const cur = 'dealId' in r && r.dealId ? r.dealId : null;
  const groups = railDealGroups(s);
  // the group holding the deal on screen opens when you arrive there or it moves group; after that it folds like any other
  const curGroup = cur ? s.deals[cur]?.group : undefined;
  // The exception is the deal the app was opened on: if its group was folded by hand, a reload leaves it folded.
  // (The deal is read from the address the app was opened at, because the route is not applied until after the first render. It counts once.)
  const startedOn = useRef<string | null>((/d_[0-9A-Za-z]+/.exec(location.hash) ?? [null])[0]);
  useLayoutEffect(() => {
    if (!curGroup) return;
    const reopened = cur === startedOn.current; startedOn.current = null;
    const o = store.get().prefs.railOpen;
    if (o[curGroup] || (reopened && o[curGroup] === false)) return;
    setOpen({ ...o, [curGroup]: true });
  }, [cur, curGroup]);
  const scope = scopeOfRoute(r);
  const queued = scope && (scope.kind === 'finding' || scope.kind === 'question') && scopeValid(s, scope) === true ? scope : null;
  const booting = s.boot.stage !== 'ready';
  return (
    <aside class="rail glass pane">
      <div class="brand"><span class="mark" id="brand-mark" aria-hidden="true"><Icon name="mark" size={16} /></span><button type="button" id="new-deal" class="plus" title={ro ?? 'Add deal'} aria-label="Add deal" disabled={!!ro} onClick={() => store.ui({ addDeal: true })}><Icon name="plus" size={16} /></button></div>
      {queued || isReading(s.ui) ? (s.ui.palette && <SearchBox float />) : <SearchBox />}
      {(queued || isReading(s.ui)) && <div class="rtools">
        <button type="button" class="railx" id="rt-search" aria-label="Search" title="Search (Ctrl K)" onMouseDown={(e) => e.preventDefault()} onClick={() => store.ui({ palette: !store.get().ui.palette })}><Icon name="search" size={15} sw={2} /></button>
        <button type="button" class="railx" id="rt-settings" aria-label="Settings" title="Settings" aria-haspopup="dialog" onClick={() => store.ui({ settings: true })}><Icon name="gear" size={15} /></button>
      </div>}
      <nav id="rail-nav" aria-label="Primary">
        {booting ? <div class="ph" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          : queued ? <QueueStrip scope={queued} />
          : isReading(s.ui) ? <a href="#deals" class="railx" title="Home" aria-label="Home">
            <Icon name="home" size={16} />
          </a> : <>
        <a href="#deals" class={r.name === 'home' ? 'on' : ''} aria-current={r.name === 'home' ? 'page' : undefined}>Home</a>
        {/* a group shows once it has a deal */}
        {groups.map(({ group, label, deals }) => (
          <RailGroup key={group} label={label} deals={deals}
            open={!!open[group]} toggle={() => setOpen({ ...open, [group]: !open[group] })} cur={cur} />))}
        </>}
      </nav>
      <AccountRow />
    </aside>
  );
}

/**
 * A group of deals in the sidebar, folding under its heading. It lists deals only: a deal's pages are its tabs
 *. A group with no deal is not shown.
 */
function RailGroup({ label, deals, open, toggle, cur }: {
  label: string; deals: State['deals'][string][]; open: boolean; toggle: () => void; cur: string | null;
}) {
  const s = useAppState();
  const twinOf = useMemo(() => dealTwinLabels(Object.values(s.deals)), [s.deals]);
  if (!deals.length) return null;
  const row = (d: State['deals'][string]) => {
    const twin = twinOf(d);
    const label = twin ? `${d.name} · ${twin}` : d.name;
    return (
      <div class="drow" key={d.id}>
        <a href={`#${dealHash(s.prefs, d.id)}`} class={`dealrow ${cur === d.id ? 'on' : ''}`}
          aria-current={cur === d.id ? 'true' : undefined} title={label} aria-label={twin ? label : undefined}>
          <span class="dn1" dir={nameDir(d.name)}>{d.name}</span>
          {twin && <span class="dtw"><TwinLabel text={twinOf(d, true)} focus={twinOf(d, 'focus')} /></span>}
        </a>
        <DealMore dealId={d.id} />
      </div>
    );
  };
  return (
    <div>
      <button type="button" class="grp-h" aria-expanded={open} onClick={toggle}>
        <span class={`tri ${open ? 'open' : ''}`}><Icon name="chevr" size={12} /></span>
        {label}<span class="cnt">{num(deals.length)}</span>
      </button>
      {open && deals.map(row)}
    </div>
  );
}

function Home() {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext);
  const deals = dealRows(s, 'home');
  if (!deals.length) return (
    <div class="home firstrun"><div class="center">
      <h1 class="ttl">Start with a deal</h1>
      {/* no line of explanation on screen: it is the button's tooltip instead */}
      {/* with deals in the shared folder already, the way in is Add deal, which also offers New deal */}
      {Object.keys(s.deals).length ? <button type="button" class="btn pri fr-new" id="fr-new"
        title={ro ?? 'Add a deal the team already has, or start a new one'} disabled={!!ro}
        onClick={() => store.ui({ addDeal: true })}><Icon name="plus" size={15} /> Add Deal</button>
        : <button type="button" class="btn pri fr-new" id="fr-new"
          title={ro ??
          'Name the deal and point it at the data-room folders. Indexing and the first pass start on their own.'}
          disabled={!!ro} onClick={() => store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } })}><Icon
          name="plus" size={15} /> New Deal</button>}
    </div></div>
  );
  return (
    <div class="home"><div class="center">
      <h1 class="ttl">What would you like to know?</h1>
      {/* the heading and the box at the window's center, with example questions in the box */}
      <Composer scope={{ kind: 'all' }} launch="home" examples={homeExamples(deals.map(({ deal }) => deal.name))} />
      {/* Home is the composer alone: the deals are in the sidebar, records in two versions on their own deal */}
    </div></div>
  );
}

/** A long deal name shortened in the middle, so the words after it ("moved to Monitoring") still show. */
export function middleName(name: string): string {
  const w = name.split(' ');
  if (name.length <= 32 || w.length < 5) return name;
  return `${w.slice(0, 2).join(' ')}…${w.slice(-2).join(' ')}`;
}

/**
 * Notices sit in one stack at the top of the page column (right of the sidebar), clear of the composer and the
 * reading bar at the bottom. Up to three toasts stack as a deck: the newest in front and the
 * older ones peeking behind it; pointing at the deck or tabbing into it spreads them, so each keeps its Undo.
 */
export function Notices() {
  const store = useStore(); const s = useAppState();
  const shown = s.ui.toasts.slice(-3);
  const newest = shown[shown.length - 1];
  // The clock stops while the pointer or the keyboard focus is on a toast. The two are tracked apart (leaving with
  // one must not restart the clock while the other is still there) and re-read from the page whenever the set of
  // toasts changes, because a toast that vanishes under the pointer or with the focus on it sends no leave event.
  const box = useRef<HTMLDivElement>(null);
  const sync = () => { const el = box.current; if (el && (el.matches(':hover') || el.contains(document.activeElement))) store.holdToasts(); else store.releaseToasts(); };
  useLayoutEffect(sync, [shown.map((t) => t.id).join()]);
  // the page column, measured from #view as it lays out (the sidebar folds and widens, so CSS alone can't know it)
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const v = document.getElementById('view'); const n = root.current; if (!v || !n) return;
    const place = () => { const r = v.getBoundingClientRect(); n.style.setProperty('--colmid', `${r.left + r.width / 2}px`); n.style.setProperty('--colw', `${r.width}px`); };
    // how far down the notices reach, so an open dialog starts below them instead of under them
    const reach = () => { const r = n.getBoundingClientRect(); document.documentElement.style.setProperty('--notices-h', r.height ? `${Math.ceil(r.bottom)}px` : '0px'); };
    place(); reach(); const ro = new ResizeObserver(place); ro.observe(v); const rn = new ResizeObserver(reach); rn.observe(n); return () => { ro.disconnect(); rn.disconnect(); };
  }, []);
  const said = (text: string) => Object.values(s.deals).reduce((t, d) => (t.includes(d.name) ? t.split(d.name).join(middleName(d.name)) : t), text);
  const run = (t: typeof shown[number]) => {
    const act = t.action;
    if (act?.opId) {
      void undoFromNotice(store, t);
      return;
    }
    act?.run?.();
    store.dismissToast(t.id);
  };
  return (
    <div class="notices" ref={root}>
      {s.net.down && <NetBar />}
      {s.signin?.out && <SignInBar />}
      <InterruptedBar />
      <div class="toasts" role="status" ref={box} onMouseEnter={sync} onMouseLeave={sync} onFocusIn={sync} onFocusOut={() => requestAnimationFrame(sync)}>
        {shown.map((t) => (
          <Notice key={t.id} id={t === newest ? 'toast' : undefined} glyph={t.glyph}
            tip={t.more ?? (t.cut || said(t.text) !== t.text ? t.text : undefined)} full={t.text}
            actions={t.action ? [{ label: t.action.label, run: () => run(t) }] : []}
            onClose={() => store.dismissToast(t.id)}>
            {/* the whole text on hover when it is shortened: a long deal name, or a line that doesn't fit */}
            <NoticeWords text={t.cut ? t.text : said(t.text)} cut={t.cut} />
          </Notice>))}
      </div>
    </div>
  );
}

/** Where an interrupted action was: the question or finding and its deal, so Retry says what it would write. */
function opPlace(s: State, input: unknown): string {
  const i = (input ?? {}) as { dealId?: unknown; questionId?: unknown; findingId?: unknown };
  const d = typeof i.dealId === 'string' ? s.deals[i.dealId] : undefined;
  const q = typeof i.questionId === 'string' ? s.questions[i.questionId] : undefined;
  const f = typeof i.findingId === 'string' ? s.findings[i.findingId] : undefined;
  const what = q ? `Q${q.n}` : f ? `“${f.title.length > 48 ? f.title.slice(0, 47).trimEnd() + '…' : f.title}”` : '';
  return [what, d?.name].filter(Boolean).join(' on ');
}

/** Offline: says so until the connection is back, with Retry Now; ✕ hides it until the next time. */
function NetBar() {
  const store = useStore();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <Notice class="netbar" role="alert" glyph="warn" onClose={() => setHidden(true)}
      actions={[{ label: 'Retry Now', run: () => void store.probeOnce() }]}>
      <NoticeWords text="Not connected · Retrying" />
    </Notice>
  );
}

const INTERRUPTED_ROWS = 3;

/** Hidden and overflowed actions stay counted, and Show starts the next group with the first hidden action (#565). */
function InterruptedBar() {
  const s = useAppState();
  const [first, setFirst] = useState<string>();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const bar = useRef<HTMLDivElement>(null);
  const ops = interruptedOperations(s);
  const start = Math.max(0, ops.findIndex((op) => op.id === first));
  const ordered = [...ops.slice(start), ...ops.slice(0, start)];
  const showing = ordered.filter((op) => !dismissed.includes(op.id)).slice(0, INTERRUPTED_ROWS);
  const hidden = ordered.filter((op) => !showing.includes(op));
  const show = () => {
    setFirst(hidden[0].id);
    setDismissed([]);
    requestAnimationFrame(() => bar.current?.querySelector<HTMLElement>('.intop .tundo')?.focus());
  };
  const hide = (id: string) => {
    setDismissed([...dismissed.filter((key) => isInterrupted(s.ops[key])), id]);
  };
  if (!ops.length) return null;
  return (
    <div class="intbar" role="status" ref={bar}>
      {showing.map((op) => (
        <Interrupted key={op.id} id={op.id} what={commandLabel(op.command, op.input)} where={opPlace(s, op.input)}
          onHide={() => hide(op.id)} />))}
      {hidden.length > 0 && (
        <Notice glyph="warn" actions={[{ label: 'Show', run: show }]}>
          <NoticeWords text={`${hidden.length} more interrupted`} />
        </Notice>)}
    </div>
  );
}

function Interrupted({ id, what, where, onHide }: { id: string; what: string; where: string; onHide: () => void }) {
  const store = useStore();
  const text = `${what} interrupted${where ? ` · ${where}` : ''}`;
  return (
    <Notice id={`interrupted-${id}`} class="intop" glyph="warn" full={text} onClose={onHide}
      actions={[
        { label: 'Retry', run: () => void store.retryOp(id) },
        { label: 'Discard', run: () => void store.discardOp(id) },
      ]}>
      <NoticeWords text={text} />
    </Notice>
  );
}
