import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { useAppState, useStore, fmtDate, useDismiss } from './hooks';
import { EditField, ReadOnlyContext } from './editField';
import { readQuestion, keepsUnsaved, unsavedText, unsavedBase, typedResponse } from '../app/fieldDrafts';
import { questionFieldCommit, type EditableQuestionField } from '../app/questionFields';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';
import { PageTop } from './deal';
import { sharedNumbers, nextQuestionNumber, qaVersions, qaChanged, workstreamForNew, type State }
  from '../app/state';
import { hasLogVersion, qaEditorWorkstreams, qaPageView } from '../app/qaView';
import { settledQuestion } from '../app/settledView';
import { SettledLine, CloseThisQuestion } from './closeSettled';
import { ConflictView } from './conflict';
import { AskFirst } from './dialogs';
import { AskedFor } from './askedFor';
import {
  CreateQuestion, SetQuestionStatus, SetResponse, DeleteQuestion, RenumberQuestion,
} from '../app/commands/questions';
import { createdRecord } from '../app/createdRecord';
import { EditDeal } from '../app/commands/deals';
import { DiscardDraft } from '../app/commands/drafts';
import {
  draftAll, draftReplacesResponse, requestQuestionDraft, stopDraftAll, typingIn, useQuestionDraft,
} from '../app/drafting';
import { isDraftStale } from '../domain/transitions';
import { Ref } from './ref';
import { visibleDeletedNotes } from '../app/deletedView';
import { WORKSTREAMS, type Question, type QuestionStatus } from '../domain/model';
import { AI_LABEL } from '../control';
import { MenuChoice, workstreamOptions } from './filterMenu';
import { wholeRows } from './pickList';
import { chooseLogFolder, logOf, markQaLogSeen } from '../app/qaLog';
import { UndoLastImport, lastImport, undoLastImportPlan } from '../app/commands/importQuestions';
import { Modal } from './dialogs';
import { showQaLogUpdate } from './qaLogNotice';
import { showTip, hideTip } from './tip';
import { openResolve } from './resolve';
import { focusSearchResult } from './nav';

export { WORKSTREAMS };
const PRIORITIES = ['High', 'Medium', 'Low'];
export const STATUS_LABEL: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };
const QA_FILTER_LABEL = { ...STATUS_LABEL, all: 'All', changed: 'Changed', versions: 'Two Versions' };
export function QaPage({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const ro = useContext(ReadOnlyContext);                 // why nothing on this deal can be changed just now, if it cannot: what cannot be used is shown as off, with the reason on hover
  const d = s.deals[dealId];
  // the checklist too, where the deal has one: a question whose item it has settled is offered to be closed
  useEffect(() => { void store.loadDealWithChecklist(dealId); }, [dealId]);
  if (!d) return null;
  const load = s.dealLoad[dealId];
  const F = s.ui.qaFilter;
  const view = qaPageView(s, dealId, typedResponse);
  const { list, outsideFilter, selected: sel } = view;
  const hide = view.oneStatus ? { ...s.prefs.hideCols, status: true } : s.prefs.hideCols;
  // The table is always the full table: an open question goes across the top of the page instead (design G)
  // In the full table nothing is selected, so the keyboard has a place of its own: the row the arrows last reached.
  const [cursor, setCursor] = useState<string | null>(null);
  const at = sel?.id ?? (cursor && list.some((r) => r.id === cursor) ? cursor : list[0]?.id ?? null);
  // A long list draws only the rows in view and a margin around them (deals run to 2,000 questions, and
  // drawing every row made opening one take a quarter of a second). Space above and below stands in for the rest, sized by
  // the rows' measured height, and one hidden row holds each column's widest value, so the columns keep their widths as it scrolls.
  const LONG = 200, MARGIN = 30; const big = list.length > LONG;
  const rowH = useRef(58); const [win, setWin] = useState({ from: 0, to: 80 });
  const span = (top: number, height: number) => { const from = Math.max(0, Math.floor(top / rowH.current) - MARGIN); return { from, to: from + Math.ceil(height / rowH.current) + 2 * MARGIN }; };
  const onScroll = () => { const l = listRef.current; if (!l) return; tuckOn(l); if (!big) return; const w = span(l.scrollTop, l.clientHeight); if (Math.abs(w.from - win.from) > MARGIN / 3) setWin(w); };
  /** the row at `i` drawn and scrolled into view, for the keyboard and for the open question */
  const reveal = (i: number) => {
    const l = listRef.current; if (!big || !l || i < 0) return;
    if (i >= win.from + 2 && i < win.to - 2) return;
    l.scrollTop = Math.max(0, i * rowH.current - l.clientHeight / 2); setWin(span(l.scrollTop, l.clientHeight));
  };
  const shownFrom = big ? Math.min(win.from, Math.max(0, list.length - 1)) : 0; const shownTo = big ? Math.min(list.length, win.to) : list.length;
  // The page reopens as it was left, per deal: the pane open on its question, or closed. Kept with the person's other view choices.
  const [readyFor, setReadyFor] = useState<string | null>(null); const ready = readyFor === dealId;
  useLayoutEffect(() => {
    if (ready || load !== 'loaded') return;
    const saved = store.get().prefs.qaOpen[dealId];
    if (!store.get().ui.selectedQuestion && saved && store.get().questions[saved]?.dealId === dealId) store.ui({ selectedQuestion: saved });
    setReadyFor(dealId);
  }, [ready, load, dealId]);
  useLayoutEffect(() => {                                  // with the frame that shows it, so leaving the page straight after closing cannot lose the change
    if (!ready) return;
    const now = sel?.id ?? null; const all = store.get().prefs.qaOpen;
    if ((all[dealId] ?? null) === now) return;
    const next = { ...all }; if (now) next[dealId] = now; else delete next[dealId];
    store.setPrefs({ qaOpen: next });
  }, [ready, sel?.id, dealId]);
  useEffect(() => {
    if (sel) markQaLogSeen(store, sel.id);
  }, [sel?.id]);
  const twice = sharedNumbers(s, dealId);                 // numbers two questions hold: both rows are marked
  // What the row's look alone doesn't say goes in its tooltip (the Draft column is gone): a question in two versions,
  // one sharing its number with another, or (dimmed) one shown although outside the filter. How two versions show is being designed.
  const mark = (r: Question) => {
    const versions = qaVersions(s, r);
    if (versions) return `${versions}: open it to choose one`;
    if (twice.has(r.n)) return 'Same number';
    return r.id === outsideFilter ? 'Outside this filter' : '';
  };
  /** a ready draft waiting in place of the response: shown in the Response cell after the AI mark, as the panel shows it in the response's place */
  const waiting = (r: Question) => (r.draft?.status === 'found' && !r.response.trim() ? r.draft.text : '');
  /**
   * a ready draft waiting beside a response: the cell keeps the response's words, and the draft is on hover. The AI mark goes only on
   * what the model wrote: a draft, or a response taken from one, until a person changes its words
   */
  const beside = (r: Question) =>
    (r.draft?.status === 'found' && r.response.trim() ? `${rowDraftNote(r)}: ${r.draft.text}` : '');
  /** the row's tooltip: its mark, and with the Response column switched off, the waiting draft's note too, so a draft is never unmarked */
  const tip = (r: Question) =>
    [mark(r), hide.response && (waiting(r) || beside(r)) ? rowDraftNote(r) : ''].filter(Boolean).join(' · ');
  // the rows' height, measured from those drawn, so the space standing in for the rest is about right; the open question stays drawn
  // Measured once, from the first rows drawn: a height that kept changing would move every row the space stands in for.
  const measured = useRef(false);
  useLayoutEffect(() => {
    const l = listRef.current; if (!big || !l || measured.current) return;
    const hs = [...l.querySelectorAll<HTMLElement>('.li:not(.vsize)')].map((e) => e.getBoundingClientRect().height).filter((h) => h > 0);
    if (hs.length < 20) return;
    measured.current = true; rowH.current = hs.reduce((a, b) => a + b, 0) / hs.length; onScroll();
  });
  // A filter changes the list under a scroll position the browser may have moved (a short list clamps it), with no scroll
  // event to say so: the rows to draw are worked out again from where the list now is, or it could show nothing.
  useLayoutEffect(() => { const l = listRef.current; if (big && l) setWin(span(l.scrollTop, l.clientHeight)); }, [list.length, F.status, F.workstream, F.text, big]);
  useLayoutEffect(() => { if (sel) reveal(list.findIndex((r) => r.id === sel.id)); }, [sel?.id, big]);
  const listRef = useRef<HTMLDivElement>(null);
  // Scrolling down the list tucks the deal's header row (name, tabs, deal buttons) away so more rows fit; scrolling up, or
  // reaching the top, brings it back. The trail, the ask box, the controls and the column heads stay (#593, design C).
  // `tuck` is the height the header row gives back, which the list takes; 0 is not tucked.
  const [tuck, setTuck] = useState(0); const lastTop = useRef(0); const settling = useRef(0);
  // where the scroll last turned, so a slow scroll in small steps (a trackpad) adds up to a tuck or an untuck
  const turnedAt = useRef(0); const going = useRef(0);
  const tuckOn = (l: HTMLElement) => {
    const top = l.scrollTop, was = lastTop.current; lastTop.current = top;
    const dir = Math.sign(top - was); if (dir && dir !== going.current) { going.current = dir; turnedAt.current = was; }
    // the list grows or shrinks as the header moves, which moves its scroll position: not the person scrolling
    if (performance.now() < settling.current) { turnedAt.current = top; return; }
    const set = (h: number) => { settling.current = performance.now() + 400; turnedAt.current = top; setTuck(h); };
    // at the end of the list a scroll up is the list growing under it (sized again late on a slow machine), not the person
    const atEnd = top >= l.scrollHeight - l.clientHeight - 1;
    if (tuck && (top < 24 || (top < turnedAt.current - 12 && !atEnd))) { set(0); return; }
    const head = document.querySelector<HTMLElement>('.headrow'); if (tuck || !head || top < 24 || top < turnedAt.current + 8) return;
    const typing = headerInUse(head);
    // what the list moves up by: the header row (its 1px rule and bottom margin stay) and the trail's margin, which goes to 0
    const trail = document.querySelector<HTMLElement>('.home.qapage .trail');
    const amount = head.offsetHeight - 1 + (trail ? parseFloat(getComputedStyle(trail).marginBottom) : 0);
    // only when the list still has room to scroll once it has taken that height, or it would come straight back
    if (!typing && l.scrollHeight - l.clientHeight > amount + 48) { headerGave = amount; set(amount); }
  };
  // tucked, nothing in the header can take the focus (a Tab or a click while it slides away)
  useEffect(() => { const h = document.querySelector<HTMLElement>('.headrow'); if (!h) return; h.inert = !!tuck; return () => { h.inert = false; }; }, [tuck]);
  // with a question open the panel sizes the list to the room left: it is sized again once the header has moved (--base, 260ms)
  useEffect(() => { const t = setTimeout(() => dispatchEvent(new Event('qa:fit')), 300); return () => clearTimeout(t); }, [tuck]);
  // coming back, it is sized at once as well, for where the header is going (headerComing), so the page never runs past the window
  useLayoutEffect(() => { if (!tuck) dispatchEvent(new Event('qa:fit')); }, [tuck]);
  // a filter can shorten the list until it no longer scrolls, with no scroll event to say so: the header comes back
  useLayoutEffect(() => { const l = listRef.current; if (tuck && l && l.scrollTop < 24) setTuck(0); }, [list.length, tuck]);

  const select = (id: string) => store.ui({ selectedQuestion: id });
  const { focusRow, close } = useQaFocus(listRef, sel?.id ?? null, setCursor, s.ui.searchFocus);
  const escClose = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
  // the open question's place in the list, and a step to the one before or after it (the panel's arrows)
  const selAt = sel ? list.findIndex((r) => r.id === sel.id) : -1;
  const step = (by: number) => { const r = list[selAt + by]; if (r) select(r.id); };
  // A question deleted from the panel moves the panel to its neighbor. If the delete is undone while the panel is still
  // there, the panel goes back to the question that came back; once the person has moved on, it stays where they are.
  const back = useRef<{ id: string; to: string | null } | null>(null);
  useLayoutEffect(() => {
    const b = back.current; if (!b) return;
    if ((sel?.id ?? null) !== b.to) back.current = null;
    else if (s.questions[b.id]) { back.current = null; select(b.id); }
  });
  // the panel is at the top of the page: opening a question from far down the table brings the top into view
  // opening a question shows the page from its top, where the question now is; stepping keeps the panel in view
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    const v = document.getElementById('view'); const p = document.querySelector('.qpanel');
    if (sel && v && p && (!wasOpen.current || p.getBoundingClientRect().top < v.getBoundingClientRect().top)) v.scrollTo({ top: 0 });
    wasOpen.current = !!sel;
  }, [sel?.id]);
  // opening or changing the open question re-flows the list: keep its row where the person can see it
  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) return;
    const i = list.findIndex((r) => r.id === at); const rowH = listRef.current?.querySelector('.li')?.getBoundingClientRect().height || 58;   // a page is the rows that fit, less one, so the last row seen stays in view
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 400) / rowH) - 1);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? page : -page);
    const j = Math.max(0, Math.min(list.length - 1, to));
    if (!list[j]) return;
    e.preventDefault();
    if (sel) select(list[j].id); else setCursor(list[j].id);      // with the pane open the arrows change the open question; in the full table they only move, and Enter opens
    reveal(j); focusRow(list[j].id);
  };
  const cols = ['auto', !hide.priority && 'auto', !hide.askedBy && 'auto', 'minmax(170px,1.1fr)', !hide.response && 'minmax(140px,1fr)',   /* the two text columns keep a width worth reading; names and dates give way first */ !hide.respondedBy && 'auto', !hide.responded && 'auto', !hide.status && 'auto'].filter(Boolean).join(' ');
  // While the new question is being saved the detail pane still shows the previous one. It is made inert for
  // that moment so nothing typed lands in the wrong question — with a real backend the save takes a while.
  const [adding, setAdding] = useState(false);
  const add = async () => {
    if (adding) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    setAdding(true);
    const workstream = workstreamForNew(F.workstream);   // the one the list is filtered to
    const r = await store.dispatch(CreateQuestion, { dealId, text: '', workstream }, { idempotencyKey: 'qa-add' });
    setAdding(false);
    if (!r.ok) return;
    const qid = createdRecord(store.get(), r.value.opId, 'questions')?.id;
    // the filter is left as the person set it: the open question is listed whatever the filter, marked if outside it
    if (qid) { store.ui({ selectedQuestion: qid }); requestAnimationFrame(() => (document.querySelector('.det textarea.qtext') as HTMLElement | null)?.focus()); }
  };

  return (
    <div class={`home top wide qapage ${tuck ? 'tuck' : ''}`} style={tuck ? `--tuck:${tuck}px` : undefined}>
      <PageTop deal={d} route="qa" noAsk={!!sel} placeholder="Ask what is still open, or type “add a question: …”" />
      {sel && (s.conflicts[sel.id]
        ? <ConflictPanel key={sel.id} q={sel} busy={adding} onClose={close} onKeyDown={escClose} />
        : <Detail q={sel} busy={adding} onClose={close} onKeyDown={escClose} pos={selAt + 1} of={list.length} step={step} nextId={(list[selAt + 1] ?? list[selAt - 1])?.id ?? null} onDeleted={(id) => { back.current = { id, to: store.get().ui.selectedQuestion }; }} />)}
      <section class="tracker">
        <SettledLine dealId={dealId} />
        <QaTools dealId={dealId} view={view} ro={ro} onAdd={() => void add()} />
        {load === 'loaded' && list.length > 0 && <Heads listRef={listRef} />}
        <div class={`md wide ${hide.priority ? 'nopr' : ''} ${hide.askedBy ? 'noby' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && sel && !e.defaultPrevented) { e.preventDefault(); close(); } }}>
          <div class="list" role="listbox" aria-label="Questions" ref={listRef} onKeyDown={onKey} onScroll={onScroll} style={`grid-template-columns:${cols}`}>
            {load === 'loaded' && list.length > 0 && <div class="lh" aria-hidden="true" data-sizes><span
              class="n">#</span>{!hide.priority && <span>Priority</span>}{!hide.askedBy &&
              <span>Submitted By</span>}<span>Question</span>{!hide.response &&
              <span>Response</span>}{!hide.respondedBy && <span>Responded By</span>}{!hide.responded &&
              <span>Response Date</span>}{!hide.status && <span>Status</span>}</div>}
            {load === 'failed' ? <p class="loadfail" style="padding:16px 12px">Couldn’t load this deal’s questions. <button type="button" class="tundo" onClick={() => void store.retryDeal(dealId)}>Retry</button></p>
              : load !== 'loaded' ? Array.from({ length: 7 }, (_, i) => <div class="phrow" key={i}><i /><i /></div>)
              : list.length ? [...(shownFrom ? [<div key="vtop" aria-hidden="true" style={{ height: `${shownFrom * rowH.current}px` }} />] : []), ...list.slice(shownFrom, shownTo).map((r) => (
                <button type="button" key={r.id} role="option" data-q={r.id}
                  class={`li ${sel?.id === r.id ? 'on' : ''} ${r.id === outsideFilter ? 'offfilter' : ''} `
                    + (qaVersions(s, r) ? 'cfrow' : '')}
                  title={tip(r) || undefined} aria-description={tip(r) || undefined}
                  data-conflict={s.conflicts[r.id] ? '' : undefined}
                  data-samenumber={!s.conflicts[r.id] && twice.has(r.n) ? '' : undefined}
                  tabIndex={at === r.id ? 0 : -1} aria-selected={sel?.id === r.id} onClick={(e) => {
                    if (!s.conflicts[r.id] && hasLogVersion(s, r)) openResolve(store, dealId, r.id);
                    else if (sel?.id === r.id && e.detail === 0) intoPanel();
                    else select(r.id);
                  }}>
                  <QaRow r={r} hide={hide} versions={qaVersions(s, r)} changed={qaChanged(s, r)}
                    was={d.qaLogs[0]?.last?.changed?.[r.id]} mark={mark(r)} waiting={waiting(r)} beside={beside(r)}
                    draftNote={waiting(r) ? rowDraftNote(r) : ''} />
                </button>)), ...(big ? [<div key="vend" aria-hidden="true" style={{ height: `${(list.length - shownTo) * rowH.current}px` }} />, <Sizer key="vsize" list={list} hide={hide} />] : [])]
              : <p class="emptyline" id="qa-empty" style="padding:28px 12px">{view.hasQuestions ? <>Nothing matches
                {F.text || F.workstream ? <>. <button type="button" class="linkb" id="qa-clear"
                  onClick={() => store.ui({ qaFilter: { ...F, text: '', workstream: '' } })}>Clear the filter</button>
                </> : '.'}</> : 'No questions yet.'}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

const ACTIVE_QA_FILTER = '.trk-tools [data-qaf][aria-pressed="true"]';

function focusQaRow(list: RefObject<HTMLDivElement | null>, id: string, afterClose: boolean) {
  requestAnimationFrame(() => {
    const row = list.current?.querySelector<HTMLElement>(`.li[data-q="${id}"]`);
    // #498: closing an out-of-filter Search result leaves a keyboard stop on the Q&A toolbar.
    const filter = afterClose ? document.querySelector<HTMLElement>(ACTIVE_QA_FILTER) : null;
    (row ?? filter)?.focus();
  });
}

// Enter on the row already open goes into it: to the Response, or while a draft is coming to its first button, else the
// Question, rather than a dozen Shift+Tabs back up the page. A click (detail > 0) only opens.
function intoPanel() {
  const target = document.querySelector<HTMLElement>('.qpanel textarea.rtext:not(:disabled)') ??
    document.querySelector<HTMLElement>('.qpanel .qright button:not(:disabled)') ??
    document.querySelector<HTMLElement>('.qpanel textarea.qtext:not(:disabled)') ??
    document.querySelector<HTMLElement>('.qpanel');
  target?.focus();
}

// #498: move focus once the Search result has rendered, and return it to the list or toolbar on close.
function useQaFocus(
  list: RefObject<HTMLDivElement | null>, selectedId: string | null, setCursor: (id: string) => void,
  searchFocus: string | null,
) {
  const store = useStore();
  useLayoutEffect(() => {
    if (selectedId && searchFocus === selectedId) focusSearchResult(store, selectedId, intoPanel);
  }, [selectedId, searchFocus]);

  const focusRow = (id: string) => focusQaRow(list, id, false);
  const close = () => {
    if (!selectedId) return;
    setCursor(selectedId);
    store.ui({ selectedQuestion: null });
    focusQaRow(list, selectedId, true);
  };
  return { focusRow, close };
}

/**
 * The row of controls over the Q&A list. The filter shows Changed and Two versions while there are any (option
 * A). One row, never two (design.md): once the select and the Filter have shrunk as far as the design lets them and the
 * controls still run past the edge, it gives way a step at a time, as measured, in this order: the
 * workstream select narrows, the buttons take their short words, the select narrows again, the filter labels drop their counts
 * (each count goes to its label's tooltip), and the Filter field folds to a search button that opens it in a small menu.
 */
function QaTools({ dealId, view, ro, onAdd }: {
  dealId: string; view: ReturnType<typeof qaPageView>; ro: string | null | undefined; onAdd: () => void;
}) {
  const store = useStore();
  const F = useAppState().ui.qaFilter;
  const n = (x: number) => x.toLocaleString('en-US');
  const tools = useRef<HTMLDivElement>(null); const [lvl, setLvl] = useState(0); const [width, setWidth] = useState(0);
  useEffect(() => { const el = tools.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width))); ro.observe(el); return () => ro.disconnect(); }, []);
  const shape = view.statuses.map(({ status }) => status).join();
  useLayoutEffect(() => { setLvl(0); }, [width, shape]);           // start again from the full row whenever the room or the choices change
  useLayoutEffect(() => {                                          // then give way a step at a time until it fits
    // the row never wraps (the select, then the Filter, shrink first), so what it no longer holds runs past its right
    // edge; at the later steps the select may shrink further, and below #430's floor (64px) that counts as not fitting too
    const el = tools.current; if (!el || lvl >= 5) return;
    const ws = el.querySelector('#qa-ws.named');      // the filter button narrows only while it shows a name
    if (el.scrollWidth > el.clientWidth + 1 || (ws && ws.getBoundingClientRect().width < 63.5)) setLvl(lvl + 1);
  });
  const [find, setFind] = useState(false); useDismiss(find, () => setFind(false), '.findwrap');
  const set = (f: Partial<State['ui']['qaFilter']>) => store.ui({ qaFilter: { ...F, ...f } });
  const field = (id?: string) => <input class="field grow" id={id} placeholder="Filter" aria-label="Filter questions" value={F.text} onInput={(e) => set({ text: (e.currentTarget as HTMLInputElement).value })} />;
  return (
    <div class="trk-head"><div class={`trk-tools sq${lvl}`} ref={tools}>
      <div class="seg">
        {view.statuses.map(({ status, count }) => {
          const label = QA_FILTER_LABEL[status];
          return <button type="button" key={status} class={F.status === status ? 'on' : ''}
            aria-pressed={F.status === status} data-qaf={status} onClick={() => set({ status })}
            title={count != null && lvl >= 4 ? `${n(count)} ${label.toLowerCase()}` : undefined}>
            {count != null && lvl < 4 ? `${label} ${n(count)}` : label}
          </button>;
        })}
      </div>
      <WorkstreamFilter names={view.workstreams} />
      {lvl < 5 ? field() : <span class="findwrap">
        <button type="button" class={`btn sm ico ${find || F.text ? 'on' : ''}`} id="qa-find" aria-label="Filter" title={F.text ? `Filter: ${F.text}` : 'Filter'} aria-haspopup="menu" aria-expanded={find} onClick={() => setFind(!find)}><Icon name="search" size={16} /></button>
        {find && <div class="colmenu glass findmenu" data-menu>{field('qa-findtext')}</div>}
      </span>}
      <span class="qacts">{view.showResolve ? <button type="button"
        class="btn sm" id="qa-resolve" title="Choose a version for each, one after another"
        onClick={() => openResolve(store, dealId)}>Resolve</button> : <DraftAllButton dealId={dealId}
        eligible={view.draftable} />}<span class="needs"
        title={ro ?? undefined}><button class="btn sm" type="button" id="qa-add" disabled={!!ro} title={ro ?? undefined}
        onClick={onAdd}><span class="long">Add Question</span><span class="short">Add</span></button></span><MoreMenu
        dealId={dealId} hasQuestions={view.hasQuestions} /></span>
    </div></div>
  );
}

/**
 * The workstream filter: the filter button Findings has, opening a menu of the workstreams, in
 * place of a dropdown. With one chosen, the button shows its name in the "on" look, cut short with its tooltip if long.
 */
function WorkstreamFilter({ names }: { names: string[] }) {
  const store = useStore(); const F = useAppState().ui.qaFilter;
  const [open, setOpen] = useState(false); useDismiss(open, () => setOpen(false), '.trk-tools .wsfilter');
  const tip = F.workstream ? `Workstream: ${F.workstream}` : 'Workstream';
  const pick = (workstream: string) => { setOpen(false); store.ui({ qaFilter: { ...F, workstream } }); };
  return (
    <span class="fwrap wsfilter">
      <button type="button" id="qa-ws" class={`btn sm ${F.workstream ? 'on named' : 'ico'}`} aria-haspopup="menu"
        aria-expanded={open} aria-label={tip} title={tip} onClick={() => setOpen(!open)}>
        <Icon name="filter" size={14} />{F.workstream && <span class="wsname">{F.workstream}</span>}
      </button>
      {open && <div class="colmenu glass wsmenu" data-menu>
        <MenuChoice title="Workstream" name="qa-ws" options={workstreamOptions(names)} value={F.workstream}
          onPick={pick} long pinLast />
      </div>}
    </span>
  );
}

/** The ⋯ menu: import and its undo, export, and which columns the list shows. */
function MoreMenu({ dealId, hasQuestions }: { dealId: string; hasQuestions: boolean }) {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext);   // read-only: what brings changes in is off
  const [open, setOpen] = useState(false); const wrap = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), '.colwrap');
  const hide = s.prefs.hideCols;
  const log = logOf(store, dealId);
  const openDialog = (kind: 'importQa' | 'exportQa' | 'deleted' | 'undoImport') => { wrap.current?.querySelector('button')?.focus(); setOpen(false); store.ui({ dialog: { kind, dealId } }); };   // focus the ⋯ button first so closing the dialog returns there
  return (
    <span class="colwrap" ref={wrap}>
      <button class={`btn sm ico ${open ? 'on' : ''}`} type="button" id="qa-cols" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" size={16} /></button>
      {open && <div class="colmenu glass" id="colmenu" role="menu">
        <button type="button" class="mi" role="menuitem" id="qa-import" disabled={!!ro} title={ro ?? undefined}
          onClick={() => openDialog('importQa')}>Import Q&A Log…</button>
        {s.can.qaLogs && <div class="mirow"><button type="button" class="mi" role="menuitem" id="qa-log"
          onClick={() => {
            setOpen(false);
            void showQaLogUpdate(store, dealId);
          }}>Update Q&A Log</button>
          {log && <button type="button" class="fb" role="menuitem" id="qa-logdir" aria-label="Log folder" aria-description={logPath(log)} onMouseEnter={(e) => showTip(e.currentTarget as HTMLElement, logPath(log))} onMouseLeave={(e) => hideTip(e.currentTarget as HTMLElement)} onClick={() => { setOpen(false); void chooseLogFolder(store, dealId).then((r) => { if (!r.ok) store.toast(r.error.message); }); }}><Icon name="folder" size={16} /></button>}</div>}
        <button type="button" class="mi" role="menuitem" id="qa-export" disabled={!hasQuestions}
          onClick={() => openDialog('exportQa')}>Export Q&A Log…</button>
        {/* the seldom used ways back, apart from Import so neither is pressed for the other */}
        <div class="msep" />
        <button type="button" class="mi" role="menuitem" id="qa-deleted"
          disabled={!!ro || !visibleDeletedNotes(s, dealId).length} title={ro ?? undefined}
          onClick={() => openDialog('deleted')}>Deleted…</button>
        {/* this PC's last import into the deal, at any time after, once confirmed */}
        <button type="button" class="mi" role="menuitem" id="qa-unimport" disabled={!!ro || !lastImport(s, dealId)}
          title={ro ?? undefined} onClick={() => openDialog('undoImport')}>Undo Last Import…</button>
        <div class="msep" /><div class="mlbl">Show in the List</div>
        <div class="mcols">{([['priority', 'Priority'], ['askedBy', 'Submitted By'], ['response', 'Response'],
          ['status', 'Status'], ['respondedBy', 'Responded By'], ['responded', 'Response Date']] as
          const).map(([k, l]) => <label key={k}><input type="checkbox" data-col={k} checked={!hide[k]}
          onChange={(e) => store.setPrefs({ hideCols: { ...hide, [k]: !(e.currentTarget as HTMLInputElement).checked }
          })} /><span>{l}</span></label>)}</div>
      </div>}
    </span>
  );
}

/** how many questions a confirmation names before "and N more" */
const LISTED = 20;
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/**
 * "Undo the last import?" (a confirmation, not an Undo afterwards). It says what will happen before
 * anything changes: how many questions go to Deleted, how many come back as they were, and which questions changed since
 * and stay as they are. Keep the import has the focus.
 */
export function UndoImportDialog({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const close = () => store.ui({ dialog: null });
  const w = undoLastImportPlan(s, dealId);
  const go = async () => { close(); await store.dispatch(UndoLastImport, { dealId }, { idempotencyKey: 'unimport-' + dealId }); };
  const what = w.ok ? [w.value.removed && `${count(w.value.removed, 'question goes', 'questions go')} to Deleted`, w.value.restored && `${count(w.value.restored, 'question comes', 'questions come')} back as ${w.value.restored === 1 ? 'it was' : 'they were'}`].filter(Boolean).join(' and ') : '';
  const named = w.ok ? w.value.named : [];
  return (
    <Modal onClose={close} label="Undo the last import?" blur className="sdlg dddlg">
      <div class="shead"><h2>Undo the last import?</h2><button type="button" class="x" aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <p class="ddtext" id="ui-what">{w.ok ? `${what}.` : w.error.message}</p>
      {named.length > 0 && <p class="ddtext" id="ui-kept">{count(named.length, 'question changed', 'questions changed')} since and {named.length === 1 ? 'stays as it is' : 'stay as they are'}: {named.slice(0, LISTED).map((n) => `Q${n}`).join(', ')}{named.length > LISTED ? ` and ${(named.length - LISTED).toLocaleString('en-US')} more` : ''}.</p>}
      <div class="xfoot"><span class="grow" /><button type="button" class="btn sm" id="ui-keep" data-autofocus
        onClick={close}>{w.ok ? 'Keep the Import' : 'Close'}</button>{w.ok && <button type="button" class="btn sm pri"
        id="ui-go" onClick={() => void go()}>Undo Import</button>}</div>
    </Modal>
  );
}

/** where the log is, as the folder writes its paths */
const logPath = (l: { folder: string; file: string }) => `${l.folder}${l.folder.includes('\\') ? '\\' : '/'}${l.file}`;
/** a question in two versions, in the panel's place: its number over its title, as in the Resolve dialog, and the
 * stepper through the deal's other questions in two versions */
function ConflictPanel({ q, busy, onClose, onKeyDown }: {
  q: Question; busy: boolean; onClose: () => void; onKeyDown: (e: KeyboardEvent) => void;
}) {
  const s = useAppState();
  return (
    <section class="det qpanel conflict glass" inert={busy}
      aria-label={`Q${q.n}`} tabIndex={-1} onKeyDown={onKeyDown}>
      <ConflictView conflict={s.conflicts[q.id]} tail={<CloseDetail onClose={onClose} />} label={`Q${q.n}`} stepper />
    </section>
  );
}

/** Closes the detail pane and gives the list the whole width again. */
function CloseDetail({ onClose }: { onClose: () => void }) {
  return <button type="button" class="btn sm ico detx" id="q-close" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={14} /></button>;
}

/**
 * A choice in the open question's header (Status, Workstream, Priority): a button that opens a list of its options
 * (Status first, then the other two the same way). Each was a native select, where the first arrow press changed
 * the value and saved it. Here the first arrow (or Enter or Space) only opens the list, at the current value; the arrows
 * then move through it, Enter or Space picks, and Escape closes it unchanged. The focus stays on the button throughout (the
 * list's options are pointed to with aria-activedescendant). Tab or a click elsewhere also closes the list unchanged.
 * `name` is the id of the button; its list is `${list}list` and each option `${list}-${slug of its value}` (`list` is `name`
 * unless given: Status keeps the ids it had, q-stlist and q-st-open).
 */
export type PickOption = { v: string; text: string; off?: boolean };
export type PickProps = {
  name: string; list?: string; label: string; value: string; options: PickOption[]; ro: string | null;
  onPick: (v: string) => void; wrap: string; cls: string; title?: string;
  /** an arrow after the value, so it reads as a choice and not a badge */
  chev?: boolean;
  /** the list's right edge under the button's, for a pick at the right end of a row (Deal status) */
  end?: boolean;
  children?: preact.ComponentChildren;
};
/** The app's own pick list: a capsule that opens a list of choices, used for a question's details and Deal status. */
export function Pick(props: PickProps) {
  const { name, list: lid = name, label, value, options, ro, onPick, wrap, cls, title, chev, end, children } = props;
  const [hi, setHi] = useState<string | null>(null);   // the option the list has reached; null while the list is shut
  // (stepping to another question shuts the list: Detail draws its panel afresh for each question, by its key)
  const btn = useRef<HTMLButtonElement>(null); const list = useRef<HTMLDivElement>(null);
  const off = (x: string) => !!options.find((o) => o.v === x)?.off;
  const can = options.filter((o) => !o.off).map((o) => o.v);
  const pick = (x: string) => { setHi(null); if (x !== value) onPick(x); };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    if (hi === null) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); setHi(value); } return; }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); setHi(null); return; }   // shuts the list only: the panel stays open
    if (k === 'Enter' || k === ' ') { e.preventDefault(); if (!off(hi)) pick(hi); return; }
    if (k === 'Tab') { setHi(null); return; }
    const at = can.indexOf(hi);   // -1 if the list opened on a value that cannot be picked now: the first arrow goes to an end
    const to = k === 'Home' ? 0 : k === 'End' ? can.length - 1 : k === 'ArrowDown' ? (at < 0 ? 0 : Math.min(can.length - 1, at + 1)) : k === 'ArrowUp' ? (at < 0 ? can.length - 1 : Math.max(0, at - 1)) : null;
    if (to !== null) { e.preventDefault(); setHi(can[to]); }
  };
  // Option ids from their values ("Environmental & social" is q-ws-environmental-social; the empty value is "none"); two
  // values that come out the same (custom workstreams can) are told apart by their place in the list.
  const seen = new Set<string>();
  const ids = options.map((o, i) => { let id = `${lid}-${o.v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'none'}`; if (seen.has(id)) id += `-${i}`; seen.add(id); return id; });
  // The list hangs under the button from whatever it is placed in. Workstream and Priority sit among the header's details,
  // which clip what overflows them, so their wrapper is not positioned and the list is placed from the header instead.
  useLayoutEffect(() => {
    const l = list.current; const b = btn.current; const p = l?.offsetParent as HTMLElement | null; if (!l || !b || !p) return;
    placeUnder(l, b, p, !!end);
    // a list too long for its height (many workstreams) scrolls and shows whole rows only, as the firm's pick lists do
    const sc = l.querySelector<HTMLElement>('.scroll'); if (sc) wholeRows(sc);
  }, [hi !== null]);
  // the option the arrows reach stays in view when the list is long enough to scroll (a deal with many workstreams)
  useLayoutEffect(() => { const l = list.current?.querySelector<HTMLElement>('.scroll'); const r = hi === null ? null : l?.querySelector<HTMLElement>('[aria-selected="true"]'); if (!l || !r) return; if (r.offsetTop < l.scrollTop) l.scrollTop = r.offsetTop; else if (r.offsetTop + r.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = r.offsetTop + r.offsetHeight - l.clientHeight; }, [hi]);
  const hiAt = options.findIndex((o) => o.v === hi); const none = options.findIndex((o) => o.v === '');
  const option = (o: PickOption, i: number) => (
    // the list opens at the chosen option: it is marked as chosen, not lit as reached, until the arrows move on
    // (the chosen row is told apart from the one under the pointer, which :hover still lights)
    <div key={o.v} class={`mi ${o.v === hi && hi !== value ? 'hi' : ''} ${o.v === value ? 'on' : ''}`} role="option"
      id={ids[i]} aria-selected={o.v === hi} aria-disabled={o.off || undefined}
      aria-setsize={options.length} aria-posinset={i + 1}
      onPointerMove={() => { if (!o.off && o.v !== hi) setHi(o.v); }} onClick={() => { if (!o.off) pick(o.v); }}>
      <span>{o.text}</span><ChoiceCheck on={o.v === value} />
    </div>);
  return (
    <span class={wrap}>
      <button type="button" class={cls} id={name} ref={btn} role="combobox" aria-label={label} aria-haspopup="listbox" aria-controls={`${lid}list`} aria-expanded={hi !== null} aria-activedescendant={hiAt >= 0 ? ids[hiAt] : undefined}
        value={value} disabled={!!ro} title={ro ?? title} onClick={() => setHi(hi === null ? value : null)} onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (e.key === ' ') e.preventDefault(); }}   /* a button acts on Space as the key comes up: the keydown above has already done it */
        onBlur={() => setHi(null)}>{children}<span class="pv">{options.find((o) => o.v === value)?.text ?? value}</span>{chev && <span class="chev"><Icon name="chev" size={13} /></span>}</button>
      {hi !== null && <div class="colmenu glass stlist" id={`${lid}list`} ref={list} role="listbox" aria-label={label} onPointerDown={(e) => e.preventDefault()}>   {/* a click in the list keeps the focus on the button */}
        {/* the choices scroll; a "No …" option (the empty value) stays in view at the foot, under a rule */}
        {/* the wrapper and the rule are layout only: to a screen reader it stays one list of options, counted as one */}
        <div class="scroll" role="none">{options.map((o, i) => o.v !== '' && option(o, i))}</div>
        {none >= 0 && <><div class="msep" aria-hidden="true" />{option(options[none], none)}</>}
      </div>}
    </span>
  );
}

/** Hangs a pick's list 6px under its button, from the box it is placed in, by its left edge or (`end`) its right. */
function placeUnder(list: HTMLElement, button: HTMLElement, box: HTMLElement, end: boolean) {
  const b = button.getBoundingClientRect();
  const p = box.getBoundingClientRect();
  const left = end ? b.right - list.offsetWidth : b.left;
  list.style.left = `${left - p.left - box.clientLeft}px`;
  list.style.top = `${b.bottom - p.top - box.clientTop + 6}px`;
}

/**
 * Something is being typed or chosen in the deal's header row: a rename, Deal status (its pick has the focus), or its ⋯
 * menu is open. The header is not tucked away then (#593).
 */
function headerInUse(head: HTMLElement): boolean {
  const focused = document.activeElement;
  const choosing = head.contains(focused) && !!focused?.matches('input, select, textarea, [role="combobox"]');
  return choosing || !!head.querySelector('[aria-expanded="true"]');
}

/**
 * The open question, across the top of the Q&A page in place of the ask box (design G).
 * The header holds what it is, its details and what can be done with it, the details running onto further lines when they
 * do not fit; under it the question on the left and the response on the right, in the same type, each right under its own
 * label. The panel is sized so that each column ends on a
 * whole line, and a longer question or response scrolls in its own place.
 */
function Detail({ q, busy, onClose, onKeyDown, pos, of, step, nextId, onDeleted }: { q: Question; busy?: boolean; onClose: () => void; onKeyDown: (e: KeyboardEvent) => void; pos: number; of: number; step: (by: number) => void; nextId: string | null; onDeleted: (id: string) => void }) {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext); const nav = useNavRoom(q.id); const panel = usePanelFit<HTMLElement>(q.id);   // the header's lines are known before the panel is sized
  const field = (name: EditableQuestionField) => questionFieldCommit(store, q, name);
  const setStatus = (status: QuestionStatus) => void store.dispatch(SetQuestionStatus, { dealId: q.dealId, questionId: q.id, status });
  // Delete asks first; an ask left open for another question is not carried over to this one
  const [asking, setAsking] = useState(false); useLayoutEffect(() => setAsking(false), [q.id]);
  // the Delete button goes with the question: the focus it held goes to the list, not to nowhere
  const del = async () => { const r = await store.dispatch(DeleteQuestion, { dealId: q.dealId, questionId: q.id }, { idempotencyKey: 'qdel-' + q.id }); const on = store.get().ui.selectedQuestion; if (r.ok && nextId && store.get().questions[nextId] && (on === q.id || !on || !store.get().questions[on])) store.ui({ selectedQuestion: nextId });   /* only if the person is still on the deleted question: one they opened while the delete was saving stays open */   /* the panel stays open on the neighboring question; with none left it closes */
    if (r.ok) onDeleted(q.id);
    if (r.ok) requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) (document.querySelector<HTMLElement>('.md .li[tabindex="0"]') ?? document.getElementById('view'))?.focus({ preventScroll: true }); }); };
  const prov = q.response && q.provenance && q.provenance.origin !== 'human' ? (q.provenance.origin === 'ai' ? `Drafted by ${AI_LABEL}` : 'From a conversation') : '';
  // What the response box holds, saved or not, as the box last said. A draft is not offered, and a waiting draft does not
  // take the box's place, while it holds text, so typed work is never hidden behind a draft or written over one.
  // What the box said is for this showing of this question only: `visit` counts the questions shown, so nothing said on an
  // earlier visit (or by a box going away after the next question is shown) carries over.
  const shownId = useRef(q.id); const visit = useRef(0);
  if (shownId.current !== q.id) { shownId.current = q.id; visit.current++; }
  const [box, setBox] = useState({ id: q.id, v: 0, text: '', over: '', elsewhere: false, focused: false });
  const mine = (b: typeof box) => b.id === q.id && b.v === visit.current;
  const holds = (mine(box) && !!box.text.trim()) || typedResponse(q);
  /** what the box holds now, saved or not: what a draft asked for starts from, and what Use as response would replace */
  const typed = mine(box) ? box.text : (typedResponse(q) ? unsavedText(`${q.id}:response`)! : q.response);
  const typedOver = mine(box) ? box.over : (typedResponse(q) ? unsavedBase(`${q.id}:response`) ?? q.response : q.response);   // the response it was typed over
  // The box also stays while it has the focus, emptied or not: a draft taking its place there would take the next keys typed.
  const drafting = !!q.draft && !q.response.trim() && !holds && !(mine(box) && box.focused);
  // A draft goes under the box while there is a response or text in it, so both are in sight. In an
  // empty box with the focus it waits, as above, until the box is left
  const stacked = !!q.draft && !drafting && (holds || !!q.response.trim());
  const offer = q.status === 'open' && !q.draft && !!q.text.trim();   // Draft from documents, with the box empty or not
  const left = useRef(false);   // the box was left empty with a draft waiting: the draft takes its place, and the focus does not go to its buttons
  // a draft held back while the empty box has the focus still says so on the label line
  const sub = drafting || (q.draft && !stacked) ? draftSub(q) : prov;
  // who responded and when gives way while a draft is offered or waiting: Draft from documents takes its place on the label line
  const answered = q.status !== 'open' || !!q.respondedBy || !!q.response;
  // Responded by and its date show once filled, or while text typed in them is kept unsaved; empty, they
  // show only while the Response line is pointed at or has the focus, so they can still be typed in. Once shown for a
  // question they stay until another question opens, so a field emptied while in use (by the person, or by another PC) never
  // vanishes under the typing, and text kept as it unmounts is never left out of sight.
  const byFor = useRef('');
  if (q.respondedBy || q.responded || keepsUnsaved(`${q.id}:respondedBy`) || keepsUnsaved(`${q.id}:responded`)) byFor.current = q.id;
  const showBy = byFor.current === q.id;
  // the panel is drawn afresh for the question stepped to, and the arrow pressed goes with the old one: the focus goes to
  // the same arrow on the new panel, or to the other arrow when this one has reached the end of the list
  const go = (by: number) => { step(by); requestAnimationFrame(() => { if (document.activeElement && document.activeElement !== document.body) return; const [same, other] = (by > 0 ? ['#q-next', '#q-prev'] : ['#q-prev', '#q-next']).map((sel) => document.querySelector<HTMLButtonElement>(sel)); (same && !same.disabled ? same : other)?.focus(); }); };
  // What can be done with the response changes under the focus when a draft is asked for, arrives, is discarded or is put
  // back by Undo, and the button that had the focus goes. The focus goes to the first of the buttons shown now, or to the
  // panel while there are none (a draft being written), not to the page. Moving to another question is not such a change.
  const area = q.draft ? `${drafting ? 'draft' : 'under'} ${q.draft.status} ${isDraftStale(q)}` : `response ${offer}`;
  const shownArea = useRef({ id: q.id, area });
  useLayoutEffect(() => {
    const was = shownArea.current; shownArea.current = { id: q.id, area };
    const fromBox = left.current; left.current = false;
    if (was.id !== q.id || was.area === area) return;
    const a = document.activeElement; if (a && a !== document.body && a !== panel.current && a.isConnected) return;   // the panel only holds the focus while there is nothing else
    // a draft that takes the place of a box just left gets no focus on its buttons, so a key meant for the box never takes it
    ((fromBox ? null : panel.current?.querySelector<HTMLElement>('.qright .racts button:not(:disabled)')) ?? panel.current)?.focus({ preventScroll: true });
  }, [q.id, area]);

  const settled = settledQuestion(s, q);
  return (
    <section class="det qpanel glass" key={q.id} inert={busy} aria-busy={busy} aria-label={`Q${q.n}`} ref={panel} tabIndex={-1} onKeyDown={onKeyDown}>
      <div class="qph">
        {/* Q1, the status and the details: details that do not fit on the top line go onto lines under it, from the left edge */}
        <div class="qlead">
          <span class="n">Q{q.n}</span>
          <Pick name="q-status" list="q-st" label="Status" wrap="stpick" cls="stsel" chev value={q.status} ro={ro} onPick={(v) => setStatus(v as QuestionStatus)}
            options={(['open', 'answered', 'closed'] as const).map((x) => ({ v: x, text: STATUS_LABEL[x], off: x === 'answered' && !q.response.trim() }))} />{/* Answered needs a response */}
          {/* the details: each still a choice, shown as plain values with an icon for what they are */}
          <div class="qprops">
            {/* the deal's own workstreams (an imported log keeps the other side's) after the app's, as the table's filter lists them */}
            <Pick name="q-ws" label="Workstream" wrap="qpick" cls="qp" chev title="Workstream" value={q.workstream}
              ro={ro} onPick={(value) => void field('workstream')(value)} options={[
                ...qaEditorWorkstreams(s, q.dealId).map((name) => ({ v: name, text: name })),
                { v: '', text: 'No workstream' },
              ]}><Icon name="tag" size={14} /></Pick>
            <Pick name="q-pr" label="Priority" wrap="qpick" cls="qp" chev title="Priority" value={q.priority} ro={ro} onPick={(v) => void field('priority')(v)} options={PRIORITIES.map((w) => ({ v: w, text: w }))}><Icon name="flag" size={14} /></Pick>
            <EditField keep={`${q.id}:askedBy`} read={readQuestion(q.id, 'askedBy')} label="Submitted by" placeholder="Submitted by" className="edit inl" cap={{ cls: 'qp lift', title: 'Submitted by', icon: <Icon name="user" size={14} /> }} value={q.askedBy} rev={q.rev} commit={field('askedBy')} />
            <EditField keep={`${q.id}:received`} read={readQuestion(q.id, 'received')} label="Received" type="date" placeholder="Received" className="dedit" cap={{ cls: 'qp', title: 'Received', icon: <Icon name="cal" size={14} /> }} value={q.received} rev={q.rev} commit={field('received')} />
          </div>
        </div>
        {/* the buttons on the right of the top line; the details' lines run under them (useNavRoom) */}
        <div class="qnav" ref={nav}>
          {/* en-US grouping at deal scale ("2 of 2,000"), as the table's counts */}
          {of > 1 && <span class="qpos">{pos.toLocaleString('en-US')} of {of.toLocaleString('en-US')}</span>}
          <button type="button" class="btn sm ico" id="q-prev" aria-label="Previous question" disabled={pos <= 1} onClick={() => go(-1)}><Icon name="chevup" size={15} /></button>
          <button type="button" class="btn sm ico" id="q-next" aria-label="Next question" disabled={pos >= of} onClick={() => go(1)}><Icon name="chev" size={15} /></button>
          {/* Delete before Discuss, so it is never next to Close */}
          <span class="needs" title={ro ?? undefined}><button type="button" class="btn sm ico del"
            aria-label="Delete question" disabled={!!ro} title={ro ?? 'Delete'}
            onClick={() => setAsking(true)}><Icon name="trash" size={15} /></button></span>
          <a class="btn sm" id="q-discuss" href={`#q-${q.dealId}-${q.id}`}>Discuss</a>
          <CloseDetail onClose={onClose} />
        </div>
      </div>
      {sharedNumbers(s, q.dealId).has(q.n) && <p class="loadfail qwarn" id="q-samenumber" role="status">Another question is also numbered {q.n}. <button type="button" class="linkb" id="q-renumber" onClick={() => void store.dispatch(RenumberQuestion, { dealId: q.dealId, questionId: q.id }, { idempotencyKey: 'renumber-' + q.id })}>Make this one Q{nextQuestionNumber(s, q.dealId)}</button></p>}
      <div class="qcol qleft">
        <div class="qlbl">Question<AskedFor q={q} /></div>
        <EditField keep={`${q.id}:text`} read={readQuestion(q.id, 'text')} label="Question" multiline className="qtext" placeholder="Type the question" value={q.text} rev={q.rev} commit={field('text')} />
      </div>
      <div class="qcol qright">
        <div class="qlbl">Response{sub && <span class="sub">{sub}</span>}
          {answered && !drafting && <span class={`sub by${showBy ? '' : ' unfilled'}`}><EditField
            keep={`${q.id}:respondedBy`} read={readQuestion(q.id, 'respondedBy')} label="Responded by"
            placeholder="Responded By" className="edit inl" cap={{ cls: 'lift', icon: <Icon name="user" size={14} /> }}
            value={q.respondedBy} rev={q.rev} commit={field('respondedBy')} /><EditField
            keep={`${q.id}:responded`} read={readQuestion(q.id, 'responded')} label="Date" type="date" className="dedit"
            cap={{ icon: <Icon name="cal" size={14} /> }} value={q.responded} rev={q.rev}
            commit={field('responded')} /></span>}
          <span class="grow" />
          {drafting ? <DraftActions q={q} typed="" over={q.response} />
            : (offer || settled) && <span class={`racts ${offer && settled ? 'two' : ''}`}>{offer && <span class="needs"
              title={ro ?? undefined}><button type="button" class="btn sm" id="q-draft" disabled={!!ro}
              title={ro ?? 'Draft from Documents'} aria-label="Draft from Documents"
              onClick={() => void requestQuestionDraft(store, q)}><span class="long">Draft from Documents</span><span
              class="short">Draft</span></button></span>}{settled && <CloseThisQuestion q={q} ro={ro}
              settled={settled} />}</span>}
        </div>
        {/* the box keeps one place in the tree whether a draft is under it or not, so it is never drawn afresh mid-typing */}
        {drafting ? <DraftBox q={q} />
          : <div class={`qstack${stacked ? ' stacked' : ''}`}><span class="rtyping" onFocusCapture={() => { typingIn.add(q.id); left.current = false; setBox((b) => ({ id: q.id, v: visit.current, text: mine(b) ? b.text : '', over: mine(b) ? b.over : q.response, elsewhere: mine(b) && b.elsewhere, focused: true })); }}
              onBlurCapture={() => { typingIn.delete(q.id); left.current = !!q.draft && !q.response.trim() && !holds; setBox((b) => (mine(b) ? { ...b, focused: false } : b)); }}><EditField keep={`${q.id}:response`} read={readQuestion(q.id, 'response')} label="Response" multiline className="rtext" placeholder="Type the response" value={q.response} rev={q.rev} onText={(text, over, elsewhere) => setBox((b) => (mine(b) && b.text === text && b.over === over && b.elsewhere === elsewhere ? b : { id: q.id, v: visit.current, text, over, elsewhere, focused: mine(b) && b.focused }))} commit={(v, over) => store.dispatch(SetResponse, { dealId: q.dealId, questionId: q.id, response: v }, { quiet: true, over })} /></span>
            {stacked && <><div class="qlbl qlbl2"><span class="sub">{stackLabel(q)}</span><span class="grow" /><DraftActions q={q} typed={typed} over={typedOver} elsewhere={mine(box) && box.elsewhere} /></div><DraftBox q={q} /></>}</div>}
      </div>
      {q.received && <span class="sr-only">{fmtDate(q.received)}</span>}
      {asking && <AskFirst ask={`Delete Q${q.n}?`} go="Delete" why="It can be restored from Deleted" onKeep={() => setAsking(false)} onGo={() => { setAsking(false); void del(); }} />}
    </section>
  );
}

/**
 * What the response label says about a draft that is waiting in place of a response. The panel's label for a ready
 * draft is "Draft Response"; the table's tooltips keep their own words.
 */
function draftSub(q: Question, ready = 'Draft Response'): string {
  const d = q.draft!;
  if (d.status === 'pending') return 'Drafting from the documents';
  if (d.status === 'failed' || d.status === 'none') return '';      // the box itself says what happened
  return isDraftStale(q) ? 'Drafted for the previous wording' : ready;
}
/** The same, in a table row's tooltips. */
const rowDraftNote = (q: Question) => draftSub(q, 'Draft from the documents');

/** What the label over a draft under the response box says. */
function stackLabel(q: Question): string {
  const d = q.draft!;
  if (d.status === 'pending') return 'Drafting';
  return d.status === 'found' && isDraftStale(q) ? 'Drafted for the previous wording' : 'Draft Response';
}

/** A waiting draft, in the response's place: dashed, as it is not the response until a person takes it. */
function DraftBox({ q }: { q: Question }) {
  const d = q.draft!;
  if (d.status === 'pending') return <div class="draft pending"><div class="rbox"><span class="dots"><i /><i /><i /></span></div></div>;
  if (d.status === 'failed') return <div class="draft nf" id="q-draft-failed" role="status"><div class="rbox"><p>Couldn’t draft a response. Nothing was changed.</p></div></div>;
  if (d.status === 'none') return <div class="draft nf"><div class="rbox"><p>Nothing in the indexed documents answers this question.</p></div></div>;
  return <div class={`draft ${isDraftStale(q) ? 'stale' : ''}`}><div class="rbox"><Ref text={d.text} sources={d.sources} className="dtext" above /></div></div>;
}

/**
 * What can be done with a waiting draft: beside the Response label, where the eye already is, or beside the Draft label under
 * the box. `typed`: what the response box holds, saved or not. A draft asked for again starts from it, and Use as response
 * asks before it replaces it: the text is saved first, so Undo brings it back. `over`: the response
 * the text was typed over, so a change made elsewhere since is never written over unasked.
 */
function DraftActions({ q, typed, over, elsewhere = false }: {
  q: Question; typed: string; over: string; elsewhere?: boolean;
}) {
  const store = useStore();
  const ro = useContext(ReadOnlyContext);
  // what the box held, and what it was typed over, when the person was asked: the confirm replaces that and nothing else, so a
  // coworker's change that syncs in while it waits is never written over. A change to the question takes the ask back.
  const [ask, setAsk] = useState<null | { typed: string; over: string; rev: number }>(null);
  useEffect(() => { if (ask && ask.rev !== q.rev) setAsk(null); }, [q.rev]);
  const d = q.draft!;
  const redraft = () => void requestQuestionDraft(store, q);
  const discard = () => void store.dispatch(DiscardDraft, { dealId: q.dealId, questionId: q.id }, { idempotencyKey: 'discard-' + q.id });
  const use = async (asked: null | { typed: string; over: string }) => {
    setAsk(null);
    const result = await useQuestionDraft(store, q, asked ? { ...asked, elsewhere } : undefined);
    if (result.kind === 'responseChanged') {
      store.toast('The response was changed elsewhere, so the draft wasn’t used. Nothing was changed.');
    } else if (result.kind === 'textNotSaved') {
      store.toast('Your text couldn’t be saved, so the draft wasn’t used. Nothing was changed.');
    } else if (result.kind === 'refused') {
      store.toast(result.message);
    }
  };
  const b = (label: string, run: () => void, pri = false) => <span class="needs" title={ro ?? undefined}><button type="button" class={`btn sm${pri ? ' pri' : ''}`} disabled={!!ro} title={ro ?? undefined} onClick={run}>{label}</button></span>;
  if (d.status === 'pending') return null;
  if (d.status === 'failed') return <span class="racts">{b('Retry', redraft, true)}{b('Discard', discard)}</span>;
  if (d.status === 'none') return <span class="racts">{b('Discard', discard)}</span>;
  if (isDraftStale(q)) return <span class="racts">{b('Draft Again', redraft, true)}{b('Discard', discard)}</span>;
  // one action takes a ready draft (decisions: "a ready draft has one action"); to change it, use it and type.
  // Over text in the box it asks first, on the same button, as Draft all does: a second press replaces, leaving it does not
  const replaces = draftReplacesResponse(q, typed);
  const take = !replaces ? b('Use as Response', () => void use(null), true)
    : ask ? <span class="needs"><button type="button" class="btn sm pri" id="q-use-confirm" disabled={!!ro}
      ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus({ preventScroll: true }); } }}
      onBlur={() => setAsk(null)} onKeyDown={(e) => { if (e.key === 'Escape')
      { e.preventDefault(); e.stopPropagation(); setAsk(null); } }}
      onClick={() => void use(ask)}>Replace Your Text · Confirm</button></span>
    : b('Use as Response', () => setAsk({ typed, over, rev: q.rev }), true);
  return <span class="racts">{take}{b('Discard', discard)}</span>;
}

/** The height the deal's header row last gave the list when it tucked away (its own height and the trail's margin below it). */
let headerGave = 0;
/**
 * While the header row slides back, how much more it will take: the list is sized for where the header will be, not where it is
 * mid-slide, or the page overflows until the header has stopped and scrolls under the wheel meanwhile. 0 once it is back.
 */
function headerComing() {
  const page = document.querySelector<HTMLElement>('.home.qapage'); if (!page || page.classList.contains('tuck')) return 0;
  const head = page.querySelector<HTMLElement>('.headrow'), trail = page.querySelector<HTMLElement>('.trail');
  if (!head || !(head.getAnimations().length || trail?.getAnimations().length)) return 0;
  const now = head.offsetHeight - 1 + (trail ? parseFloat(getComputedStyle(trail).marginBottom) : 0);   // as `amount` in tuckOn
  return Math.max(0, headerGave - now);
}

/**
 * The height the Q&A table can have before the page scrolls: from its top to the bottom of the view, less the padding
 * of what holds it (the table is the last thing on the page). Worked out from positions, so nothing is laid out again:
 * with 2,000 questions, letting the table grow to measure it took up to 290ms a keystroke.
 */
function listRoom(l: HTMLElement, v: HTMLElement) {
  let pad = headerComing();
  for (let e = l.parentElement; e && e !== v; e = e.parentElement) { const cs = getComputedStyle(e); pad += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth); }
  const vr = v.getBoundingClientRect();
  return vr.top + v.clientTop + v.clientHeight - parseFloat(getComputedStyle(v).paddingBottom) - pad - (l.getBoundingClientRect().top + v.scrollTop);   // where the table starts with the page at its top
}

/** The Q&A header's buttons sit at the right of its top line, over the details' lines, which run under them once past the
 *  top line. The details make room for them there with a float as wide as they are (`--qnav`, .qlead::before in ui.css). */
function useNavRoom(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const n = ref.current, h = n?.parentElement; if (!n || !h) return;
    // a change after the panel was sized (the position, 9 of 9 to 10 of 10) may move the details' lines: the panel is sized again
    const set = (again = false) => { const w = Math.ceil(n.getBoundingClientRect().width) + 'px'; if (h.style.getPropertyValue('--qnav') === w) return; h.style.setProperty('--qnav', w); if (again) dispatchEvent(new Event('qa:fit')); };
    set(); if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => set(true)); ro.observe(n); return () => ro.disconnect();
  }, [key]);
  return ref;
}

/**
 * Sizes the panel: as tall as it needs, up to about 64% of the window (300 to 680px), then trimmed so the response
 * (and so the question beside it) ends on a whole line, never through one. The table below then gets the height that
 * is left. Runs again when the window or what the panel shows changes.
 */
function usePanelFit<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const list = () => document.querySelector<HTMLElement>('.md .list');
  useLayoutEffect(() => () => { const l = list(); if (l) l.style.maxHeight = ''; }, []);   // closed, the list has its own height again
  useLayoutEffect(() => {
    const fit = () => {
      const p = ref.current; if (!p) return;
      // "Not saved" under a box comes and goes without the panel being sized again: the height is worked out without it,
      // so the panel keeps its height through a save and the box has a part line only while the note shows
      p.classList.add('fitting'); try { size(p); } finally { p.classList.remove('fitting'); }
      fitList();
    };
    // The table below takes the height left in the window, so with a question open the page itself does not scroll: the wheel
    // scrolls the list and the page's headings stay in view. It keeps about two rows however short the window; then the page scrolls.
    const fitList = () => {
      const l = list(), v = document.getElementById('view'); if (!l || !v) return;
      const room = listRoom(l, v), natural = l.scrollHeight + l.offsetHeight - l.clientHeight;
      const want = natural <= room ? '' : Math.max(140, Math.floor(room)) + 'px';
      if (l.style.maxHeight !== want) l.style.maxHeight = want;   // written only when it changes: a write lays out every row again
    };
    const size = (p: T) => {
      // as tall as what it shows needs, up to about 64% of the window; the table scrolls below it
      const most = Math.round(Math.min(680, Math.max(300, innerHeight * 0.64)));
      // Worked out at the height the panel has, as if it were `most`, and written once at the end, and only when it
      // changes: each height written lays the table below out again, every row of it. A box's room
      // goes up and down with the panel's height, one for one.
      // a draft under the response box: each has a set height of its own (ui.css), and the panel is as tall as both
      // need, up to `most`. Measured with the panel's own height let go for a moment, and written only when it changes
      if (p.querySelector('.qstack.stacked')) {
        const had = p.style.height; p.style.height = '';
        const want = Math.min(most, Math.ceil(p.getBoundingClientRect().height)) + 'px';
        p.style.height = had; if (had !== want) p.style.height = want;
        const qs = p.querySelector<HTMLElement>('.qleft .qtext'); if (qs) qs.style.maxHeight = '';
        return;
      }
      const first = !p.style.height; if (first) p.style.height = most + 'px';
      const base = first ? most : p.getBoundingClientRect().height;
      let h = most; const done = () => { if (first || Math.abs(h - base) >= 1) p.style.height = h + 'px'; };   // within a pixel is the same: the boxes measure in whole pixels
      const qt = p.querySelector<HTMLElement>('.qleft .qtext'); if (qt) qt.style.maxHeight = '';
      const box = p.querySelector<HTMLElement>('.qright .rtext, .qright .rbox'); if (!box) { done(); return; }
      const inner = (el: HTMLElement) => { const cs = getComputedStyle(el); const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom); return { lh: parseFloat(cs.lineHeight) || 24, padT, padB, room: el.clientHeight - padT - padB, need: el.scrollHeight - padT - padB }; };
      const r = inner(box); const lh = r.lh; r.room += most - base;
      // Less, when that height would leave the table under its smallest (140px, as fitList) with the page scrolling, as a
      // long question did at 1024×640. It keeps four lines to write in, however short the window.
      const l = list(), v = document.getElementById('view');
      if (l && v && r.room > 0) {
        const over = Math.min(140, l.scrollHeight + l.offsetHeight - l.clientHeight) - (listRoom(l, v) - (most - base));
        if (over > 0) { h = Math.min(most, Math.max(most - over, most - r.room + 4 * lh)); r.room += h - most; }
      }
      if (r.room <= 0) { done(); return; }
      // how tall a field's text is, not the box it fills: measured with the field collapsed for a moment
      const natural = (el: HTMLElement) => { const cs = getComputedStyle(el); el.style.setProperty('flex', 'none', 'important'); el.style.setProperty('height', '0px', 'important'); const h = el.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); el.style.removeProperty('flex'); el.style.removeProperty('height'); return h; };
      let ends: number[] = [];
      if (box.classList.contains('rbox')) { const top = box.getBoundingClientRect().top + r.padT - box.scrollTop; const rg = document.createRange(); ends = [...box.querySelectorAll('p, .dtext')].flatMap((x) => { rg.selectNodeContents(x); return [...rg.getClientRects()].map((c) => c.bottom - top); }); }
      const respNeed = box.classList.contains('rbox') ? (ends.length ? Math.max(...ends) : 2 * lh) : natural(box);
      const qNeed = qt ? natural(qt) : 0;
      // at least four lines to write in; no more than the room there is
      let target = Math.min(r.room, Math.max(4 * lh, respNeed, qNeed));
      target = Math.floor(target / lh + 0.02) * lh;                      // whole lines of the response's type
      if (ends.length && ends.some((e) => e > target + 0.5)) { const fits = ends.filter((e) => e <= target + 0.5); if (fits.length) target = Math.max(...fits); }   // a long draft ends on its last whole line
      const trim = r.room - target; if (trim > 0.5) h -= trim;
      done();
      // the question, beside it, shows whole lines of its own and scrolls for the rest
      if (qt) { const q = inner(qt); qt.style.maxHeight = (Math.floor(q.room / q.lh + 0.1) * q.lh + q.padT + q.padB + qt.offsetHeight - qt.clientHeight) + 'px'; }
    };
    fit(); addEventListener('resize', fit); addEventListener('qa:fit', fit); return () => { removeEventListener('resize', fit); removeEventListener('qa:fit', fit); };   // qa:fit: the header row tucked away or came back
  });
  return ref;
}

function DraftAllButton({ dealId, eligible }: { dealId: string; eligible: number }) {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext);
  const b = s.ui.batch;
  // every state in the same wrapper, so the button stays the same element and keeps the focus as its state changes
  // each state has a short label for a narrow window, so the controls stay on one row at 1024px with four-digit counts;
  // its name for a screen reader is the full sentence whatever the window
  if (b && b.dealId === dealId) return <span class="needs"><button class="btn sm pri" type="button" id="qa-draftall" aria-label={`Drafting ${b.done} of ${b.total}, ${b.stopping ? 'stopping' : 'stop'}`} onClick={() => stopDraftAll(store, dealId)}><span class="long">Drafting {b.done} of {b.total} · {b.stopping ? 'Stopping' : 'Stop'}</span><span class="short">{b.stopping ? 'Stopping' : `${b.done}/${b.total} · Stop`}</span></button></span>;
  if (s.ui.confirmDraftAll) return <span class="needs"><button class="btn sm pri" type="button" id="qa-draftall" aria-label={`Draft ${eligible} question${eligible === 1 ? '' : 's'}, confirm`} onBlur={() => store.ui({ confirmDraftAll: false })} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); store.ui({ confirmDraftAll: false }); } }} onClick={() => { store.ui({ confirmDraftAll: false }); void draftAll(store, dealId, typedResponse); }}><span class="long">Draft {eligible} question{eligible === 1 ? '' : 's'} · confirm</span><span class="short">Draft {eligible} · confirm</span></button></span>;
  // off, it says why: on hover (the wrapper takes the pointer from the disabled button) and to a screen reader, as Create does in the new-deal dialog
  const why = ro ?? (!eligible ? 'Nothing left to draft' : null);
  return <span class="needs" title={why ?? undefined}><button class="btn sm pri" type="button" id="qa-draftall"
    disabled={!!why} aria-description={why ?? undefined} onClick={() => store.ui({ confirmDraftAll: true })}><span
    class="long">Draft All Open</span><span class="short">Draft All</span></button></span>;
}

/** where each field the Q&A log holds shows in a row: its column's class (a field with no column of its own, or whose column is off, marks the question) */
const COLUMN: Record<string, string> = { priority: 'pr', askedBy: 'by', text: 'q', response: 'rs', respondedBy: 'rby', responded: 'rdt', status: 'stc' };
const FIELD_NAME: Record<string, string> = { text: 'Question', askedBy: 'Submitted by', received: 'Received', workstream: 'Workstream', priority: 'Priority', status: 'Status', response: 'Response', respondedBy: 'Responded by', responded: 'Response date' };

/**
 * One row of the Q&A list. Option A: a question in two versions has the stripe an open finding has and its
 * Response cell says only "Two versions", in --high (the Status cell does, with the Response column off); a cell taken in
 * from the Q&A log at the last update, and not yet seen by this person, has the log icon at its right, its value in full ink.
 */
function QaRow({ r, hide, versions, changed, was = {}, mark, waiting, beside, draftNote }: { r: Question; hide: Record<string, boolean>; versions: string; changed: string[]; /** what each changed field held before, for the tooltip */ was?: Record<string, string>; mark: string; waiting: string; /** a ready draft beside a response, for the cell's tooltip */ beside: string; draftNote: string }) {
  const shown = (c: string) => ({ pr: !hide.priority, by: !hide.askedBy, q: true, rs: !hide.response, rby: !hide.respondedBy, rdt: !hide.responded, stc: !hide.status })[c];
  // a changed field with no column showing marks the question cell
  const at = new Set(changed.map((k) => (COLUMN[k] && shown(COLUMN[k]) ? COLUMN[k] : 'q')));
  const names = (c: string) => changed.filter((k) => (COLUMN[k] && shown(COLUMN[k]) ? COLUMN[k] : 'q') === c).map((k) => FIELD_NAME[k] ?? k).join(', ');
  const cls = (c: string) => `${c}${at.has(c) ? ' chg' : ''}`;
  // the tooltip says what the cell held before, shortened to a line: "Response changed in the Q&A log · was: Fabrikam"
  const before = (c: string) => changed.filter((k) => (COLUMN[k] && shown(COLUMN[k]) ? COLUMN[k] : 'q') === c && was[k] !== undefined).map((k) => { const v = was[k].replace(/\s+/g, ' ').trim(); return v.length > 80 ? `${v.slice(0, 79)}…` : v || '(blank)'; });
  const chg = (c: string) => { if (!at.has(c)) return null; const tip = [`${names(c)} changed in the Q&A log`, ...before(c).map((v) => `was: ${v}`)].join(' · ');
    return <i class="chgi" role="img" aria-label={tip} title={tip}><Icon name="logedit" size={15} /></i>; };
  const vword = <b class="cfw">{versions}</b>;
  return (<>
    <span class="n">{r.n}</span>
    {!hide.priority && <span class={cls('pr')}>{r.priority || null}{chg('pr')}</span>}
    {!hide.askedBy && <span class={cls('by')}>{r.askedBy || '—'}{chg('by')}</span>}
    <span class={cls('q')} dir="auto">{r.text.trim() ? r.text : <i>New question</i>}{chg('q')}</span>
    {shown('rs') && (versions ? <span class="rs cfrs" title={mark}>{vword}</span>
      : waiting ? <span class="rs dr" title={draftNote} data-draft><b class="aim">{AI_LABEL}</b><span dir="auto">{waiting}</span></span>
      : beside ? <span class={cls('rs')} title={beside} data-draft dir="auto">{r.response}{chg('rs')}</span>
      : r.response && r.provenance?.origin === 'ai' ? <span class={`${cls('rs')} dr has`}><b class="aim">{AI_LABEL}</b><span dir="auto">{r.response}</span>{chg('rs')}</span>
      : <span class={cls('rs')} dir="auto">{r.response || null}{chg('rs')}</span>)}
    {shown('rby') && <span class={cls('rby')}>{r.respondedBy || null}{chg('rby')}</span>}
    {shown('rdt') && <span class={cls('rdt')}>{fmtDate(r.responded)}{chg('rdt')}</span>}
    {shown('stc') && (versions && !shown('rs') ? <span class="stc cfrs" title={mark}>{vword}</span> : <span class={cls('stc')}>{STATUS_LABEL[r.status]}{chg('stc')}</span>)}
  </>);
}

/** The column heads, above the list rather than in it, so they stay in view however far the list scrolls. The list keeps
 *  its own copy of the heads, hidden, for its columns to size around; each head here is placed over that copy's cell. */
function Heads({ listRef }: { listRef: RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState<{ t: string; n: boolean; l: number; w: number }[]>([]);
  const place = () => {
    const l = listRef.current; const box = own.current; if (!l || !box) return;
    const x0 = box.getBoundingClientRect().left;
    const next = [...(l.querySelector('.lh')?.children ?? [])].map((c) => { const b = c.getBoundingClientRect(); return { t: c.textContent ?? '', n: c.classList.contains('n'), l: Math.round(b.left - x0), w: Math.round(b.width) }; });
    setCells((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  };
  useLayoutEffect(place);                                  // after every render: a column switched on or off moves the others
  useEffect(() => { const l = listRef.current; if (!l) return; const ro = new ResizeObserver(() => place()); ro.observe(l); return () => ro.disconnect(); }, []);
  return <div class="lhout" ref={own} aria-hidden="true">{cells.map((c) => <span key={c.t} class={c.n ? 'n' : undefined} style={{ left: `${c.l}px`, width: `${c.w}px` }}>{c.t}</span>)}</div>;
}

/** A hidden row holding each column's widest value, so a long list drawn a part at a time keeps its column widths. */
function Sizer({ list, hide }: { list: Question[]; hide: Record<string, boolean> }) {
  const widest = (f: (r: Question) => string) => list.reduce((w, r) => { const v = f(r) ?? ''; return v.length > w.length ? v : w; }, '');
  return (
    <div class="li vsize" aria-hidden="true">
      <span class="n">{widest((r) => String(r.n))}</span>{!hide.priority && <span class="pr">{widest((r) => r.priority)}</span>}{!hide.askedBy && <span class="by">{widest((r) => r.askedBy)}</span>}<span class="q" />{!hide.response && <span class="rs" />}{!hide.respondedBy && <span class="rby">{widest((r) => r.respondedBy)}</span>}{!hide.responded && <span class="rdt">{widest((r) => fmtDate(r.responded))}</span>}{!hide.status && <span class="stc">{widest((r) => STATUS_LABEL[r.status])}</span>}
    </div>
  );
}

