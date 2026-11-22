/**
 * The account row at the foot of the sidebar, with its connection card. The card sits right above the row, at its
 * width (placed by ui.css), while the row is pointed at or focused from the keyboard, and only when something is wrong;
 * the dot on the avatar says when to look (the rules are in app/connection.ts).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { connection } from '../app/connection';

/** whether the window has a network, kept up to date */
function useOnline(): boolean {
  const [online, set] = useState(() => navigator.onLine);
  useEffect(() => { const on = () => set(navigator.onLine); window.addEventListener('online', on); window.addEventListener('offline', on); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); }; }, []);
  return online;
}
/** the time, moved on every half minute: the dot appears once a wait has lasted, with nothing else changing */
function useNow(): number {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => set(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return now;
}

export function AccountRow() {
  const store = useStore(); const s = useAppState();
  const c = connection(s, useOnline(), useNow());
  const ro = !!s.signin?.out;                       // read-only: nobody is signed in to Intelligence (decisions: "Intelligence sign-in")
  const me = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(false);
  // shown while pointed at, or focused from the keyboard (a click leaves focus here, and the card would then sit over the sidebar)
  const show = (e: FocusEvent | MouseEvent) => { if (e.type === 'focusin' && !(e.target as Element).matches?.(':focus-visible')) return; setAt(true); };
  const hide = (e: FocusEvent | MouseEvent) => { if (e.type === 'focusout' && me.current?.contains((e as FocusEvent).relatedTarget as Node | null)) return; if (e.type === 'mouseleave' && me.current?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')) return; setAt(false); };
  // like the app's other tooltips, it goes on Escape from anywhere, and on a click or a scroll
  useEffect(() => {
    if (!at) return;
    const off = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      // Escape here closes the card only, not the document or panel the page would also close
      if (e.type === 'keydown' && me.current?.contains(document.activeElement)) e.stopPropagation();
      setAt(false);
    };
    for (const t of ['keydown', 'mousedown', 'wheel']) document.addEventListener(t, off, true);
    return () => { for (const t of ['keydown', 'mousedown', 'wheel']) document.removeEventListener(t, off, true); };
  }, [at]);
  // OneDrive out for 15 minutes: said once for each time it drops, as an ordinary notice
  const told = useRef<string | null>(null); const out = s.sync?.outOfTouchSince ?? null;
  useEffect(() => { if (c.notice && told.current !== out) { told.current = out; store.toast(c.notice); } }, [c.notice, out]);
  return (
    <div class="me" ref={me} onMouseEnter={show} onMouseLeave={hide} onFocusIn={show} onFocusOut={hide}>
      <button type="button" class="merow" id="u-menu" aria-haspopup="dialog" aria-label={`${s.user?.name ?? ''} · Settings`.trim()} aria-describedby={c.wrong ? 'conncard' : undefined} onClick={() => store.ui({ settings: true })}>
        <span class="avatar" id="u-ini" aria-hidden="true">{s.user?.initials ?? ''}{ro ? <i class="netdot out" id="u-dot" /> : c.dot && <i class="netdot" id="u-dot" />}</span>{ro ? <span class="ronm" id="u-name">{s.user?.name ?? ''}<small id="u-ro">Read-only</small></span> : <span id="u-name">{s.user?.name ?? ''}</span>}<span class="gear" id="u-gear"><Icon name="gear" size={15} /></span>
      </button>
      {c.wrong && (
        <div class="conncard" id="conncard" role="tooltip" hidden={!at}>
          {/* the hidden punctuation makes the card read as sentences ("Network: Connected.") where it describes the row */}
          {c.rows.map((r) => <div class="cr" key={r.name}><i class={r.tone} /><b>{r.name}<span class="sr">: </span></b>{r.lines.map((l, i) => <span key={i} title={l}>{l}<span class="sr">. </span></span>)}</div>)}
        </div>)}
    </div>
  );
}
