/**
 * Import an issues list into a deal's Findings. The person chooses the list (a PDF, a Word file or pasted text); it is
 * attached to the deal as a chat attachment is, and the model reads its points and says which repeat a finding already
 * raised (open or closed) or an earlier point. Those are listed under "Already raised", each saying what it joins, unless
 * the person checks "Keep separate". Every other point is listed under "New findings", read only, with the title and
 * workstream the model gave it. Nothing is recorded until Import.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { Modal, LeaveFoot } from './dialogs';
import { num, plural } from './counts';
import { FileInput, PickFileRow } from './fileDrop';
import { showTip, hideTip } from './tip';
import {
  issuesListTitle, readIssuesList, readPastedIssuesList, reviewIssuesList, type ReadIssuesList,
} from '../app/issuesList';
import { ImportIssuesList } from '../app/commands/issuesList';
import { AI_LABEL } from '../control';
import type { Finding, ListPoint } from '../domain/model';
import { keptImport, keepImport, dropImport, importKey } from '../app/keptImports';
import { useKeptImportsReady, useFreshOnCrash } from './keptImports';

/** the files a list comes as: a PDF, a Word file or pasted text */
const ACCEPT = '.pdf,.docx';

/** "#3 on issues list", or "#3, #41 on issues list" for a finding more than one point is on */
export const onListText = (marks: ListPoint[]) => `${marks.map((m) => `#${m.n}`).join(', ')} on issues list`;
/** a point's words cut to one line of the tooltip, at a word, ending in an ellipsis */
const oneLine = (t: string, most = 78) => (t.length <= most ? t : `${t.slice(0, most).replace(/\s+\S*$/, '')}…`);
/**
 * The hover on the mark: the list's name, then the point's words. One point has the tooltip's six lines for its words;
 * several have a line each, under their list's name, so every point shows some of its words.
 */
export const onListTip = (marks: ListPoint[]) => {
  if (marks.length === 1) return `${issuesListTitle(marks[0].list)}\n#${marks[0].n} · ${marks[0].text}`;
  // by list, as each list's file is its own list: two saved under one name show the name twice
  const lists = [...new Set(marks.map((m) => m.doc))];
  return lists.map((list) => {
    const points = marks.filter((mark) => mark.doc === list);
    return [issuesListTitle(points[0].list), ...points.map((mark) => `#${mark.n} · ${oneLine(mark.text)}`)].join('\n');
  }).join('\n');
};

/** The mark on a finding's page: its points, with the list and their words on hover or focus. Plain text, as the list row's. */
export function OnListMark({ f }: { f: Finding }) {
  if (!f.onLists?.length) return null;
  const tip = (e: Event) => showTip(e.currentTarget as HTMLElement, onListTip(f.onLists!));
  const off = (e: Event) => hideTip(e.currentTarget as HTMLElement);
  return <> · <span class="ilh" id="f-onlists" tabIndex={0} aria-description={onListTip(f.onLists)} onMouseEnter={tip} onMouseLeave={off} onFocus={tip} onBlur={off}>{onListText(f.onLists)}</span></>;
}

/** the issues list as it was left: the list as the model read it, and the points checked to keep separate */
interface ListKept { list: ReadIssuesList; kept: Set<number> }
const isListKept = (v: unknown): v is ListKept => {
  const k = v as ListKept | undefined;
  return !!k?.list?.doc && typeof k.list.doc.docId === 'string' && typeof k.list.doc.doc === 'string' && Array.isArray(k.list.points) && k.kept instanceof Set
    && k.list.points.every((p) => !!p && typeof p.n === 'string' && typeof p.text === 'string' && typeof p.title === 'string' && typeof p.workstream === 'string');
};

/** The issues list import picks up where it was left on this PC: it waits the moment it takes to read what was kept */
export function IssuesListDialog({ dealId }: { dealId: string }) {
  const ready = useKeptImportsReady(); const fresh = useFreshOnCrash();
  return !ready || fresh === 'gone' ? null : <IssuesListImport key={String(fresh)} dealId={dealId} fresh={fresh} />;
}

function IssuesListImport({ dealId, fresh: afresh }: { dealId: string; fresh: boolean }) {
  const store = useStore(); const s = useAppState();
  const KEY = importKey.issues(dealId); const [left] = useState(() => { const k = afresh ? null : keptImport(KEY); return isListKept(k) ? k : null; });
  const [list, setList] = useState<ReadIssuesList | null>(left?.list ?? null);
  const [kept, setKept] = useState<Set<number>>(left?.kept ?? new Set());   // points the person keeps as their own finding
  const [busy, setBusy] = useState<'' | 'reading' | 'importing'>('');
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(false); const [swapping, setSwapping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null); const token = useRef(0);
  // The list as read and the check marks are kept on this PC as they change, so closing, a reload or a restart loses neither,
  // nor the model call that read the list: opening the import again picks it up where it was left. Another
  // list read in its place, "start over" (which asks first) or the import itself lets it go.
  const holding = useRef(false);
  const keep = () => { if (list && !holding.current) keepImport(KEY, { list, kept }); };
  const keepNow = useRef(keep); keepNow.current = keep;   // a failed import keeps the state as it is then, not as Import found it
  // biome-ignore lint/correctness/useExhaustiveDependencies: written as soon as what is kept changes, before the next frame
  useLayoutEffect(keep, [list, kept]);
  const close = () => { if (busy === 'importing') return; setSwapping(false); token.current++; store.ui({ dialog: null }); };
  const startOver = () => { token.current++; dropImport(KEY); setRestart(false); setSwapping(false); setBusy(''); setError(''); setList(null); setKept(new Set()); };

  type Reader = (current: () => boolean) => ReturnType<typeof readIssuesList>;
  const load = async (name: string, reader: Reader) => {
    if (busy === 'importing') return;
    const mine = ++token.current;
    setBusy('reading');
    setError('');
    const read = await reader(() => token.current === mine);
    if (!read || token.current !== mine) return;
    setBusy('');
    if (!read.ok) {
      setError(`Couldn’t read ${name}: ${read.error.message}`);
      return;
    }
    setList(read.value);
    setKept(new Set());
  };
  const read = (file: File) => void load(file.name, (current) => readIssuesList(store, dealId, file, current));
  // the paste listener calls the latest load, so it sees the state of the render at the paste
  const loadNow = useRef(load);
  loadNow.current = load;
  // text pasted (Ctrl+V) while no list is read is the list, as a pasted checklist is
  useEffect(() => {
    if (list) return;
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      event.preventDefault();
      void loadNow.current('the pasted list', (current) => readPastedIssuesList(store, dealId, text, current));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [list, store, dealId]);
  const pick = <FileInput id="il-file" accept={ACCEPT} inputRef={fileRef} onFile={read} />;
  const browse = () => fileRef.current?.click();

  if (!list) return (
    <Modal onClose={close} label="Import an issues list" blur className="sdlg imdlg ilf">
      <Head onClose={close} />
      <PickFileRow dropId="il-drop" errorId="il-error" error={error} onFile={read}>
        Drop or paste the list here, or{' '}
        <button type="button" class="linkb" id="il-browse" onClick={browse}>choose a file…</button>
        {pick}
      </PickFileRow>
      {busy === 'reading' && <div class="xfoot"><span>Reading the list</span></div>}
    </Modal>
  );

  const { points } = list;
  const { shown, raised, fresh, input } = reviewIssuesList(s, dealId, list, kept);
  const was = (k: number): [string, string] => { const t = shown[k]!; return typeof t === 'number' ? ['Joins', `#${points[t].n} ${points[t].title}`] : [t.status === 'closed' ? 'Joins closed finding' : 'Joins', t.title]; };
  // the point numbers' column is as wide as the longest, so every title starts at the same place in both sections
  const nw = `calc(${Math.min(6, points.reduce((m, p) => Math.max(m, p.n.length), 1))}ch + .7em)`;   // the digits, and the #; a longer number is cut, and whole on hover
  const run = async () => {
    if (busy) return;
    setBusy('importing'); setError(''); setRestart(false); setSwapping(false);
    // let go of the kept list first, so a reload while it runs never offers it again; a failure keeps it again
    holding.current = true; dropImport(KEY);
    const r = await store.dispatch(ImportIssuesList, { dealId, doc: list.doc.docId, list: list.doc.doc, points: input }, { idempotencyKey: `issues-${dealId}-${list.doc.docId}` });
    setBusy(''); holding.current = false;
    if (!r.ok) { keepNow.current(); setError(`Couldn’t import: ${r.error.message}`); return; }
    store.ui({ dialog: null });
  };
  const name = issuesListTitle(list.doc.doc);
  return (
    <Modal onClose={close} label="Import an issues list" blur className="sdlg imdlg ilf">
      <Head onClose={close} disabled={busy === 'importing'} />
      <div class="ilf-body" style={{ '--nw': nw }}>
        {/* the end of the name stays in sight when it is cut: lists from one counsel differ by their date */}
        <div class="srow"><div class="k">File</div><div class="ilfile"><span class="fnw" title={list.doc.doc}><span class="fn">{name.slice(0, -9)}</span><span>{name.slice(-9)}</span></span><span class="c" id="il-count">{plural(points.length, 'point')}</span><button type="button" class="linkb" id="il-change" disabled={!!busy} onClick={() => { setRestart(false); if (kept.size) setSwapping(true); else fileRef.current?.click(); }}>change</button><button type="button" class="linkb" id="il-restart" disabled={!!busy} onClick={() => { setSwapping(false); setRestart(true); }}>start over</button>{pick}<span class="grow" /></div></div>
        {raised.length > 0 && <div class="srow top"><div class="k">Already Raised<span
          class="cnt">{num(raised.length)}</span></div><div id="il-raised">
          {raised.map((k) => { const p = points[k]; const [what, words] = was(k); return (
            <div class="rv-row ilr" key={k}><span class="n" title={`#${p.n}`}>#{p.n}</span><div><div class="pt">{p.text}</div><div class={`was ${kept.has(k) ? 'off' : ''}`}><i>{what}</i>{words}</div></div>
              <label class="keep"><input type="checkbox" aria-label={`Keep #${p.n} separate`} disabled={busy === 'importing'} checked={kept.has(k)} onChange={(e) => { const on = (e.currentTarget as HTMLInputElement).checked; setKept((x) => { const y = new Set(x); if (on) y.add(k); else y.delete(k); return y; }); }} />Keep separate</label></div>
          ); })}
        </div></div>}
        {/* every finding Import will make, read only: its title and workstream are the model's */}
        {fresh.length > 0 && <div class="srow top"><div class="k">New Findings<span
          class="cnt">{num(fresh.length)}</span><b class="aim"
          title={`Titles written by ${AI_LABEL}`}>{AI_LABEL}</b></div><div id="il-new">
          {fresh.map((k) => <div class="iln" key={k}><span class="n" title={`#${points[k].n}`}>#{points[k].n}</span><span class="t">{points[k].title}</span><span class="ws">{points[k].workstream}</span></div>)}
        </div></div>}
      </div>
      {/* another list would drop the points checked on this one: asked first, as closing is */}
      {swapping ? <LeaveFoot id="il-swap" ask="Choose another list?" go="Choose" keep={() => setSwapping(false)} leave={() => { setSwapping(false); fileRef.current?.click(); }} />
        : restart ? <LeaveFoot id="il-restart-ask" ask="Clear this import and start over?" go="Start Over"
          keep={() => setRestart(false)} leave={startOver} />
        : <div class="xfoot"><span id="il-line" class={error ? 'err' : ''} role={error ? 'alert' : undefined}>{error || (busy === 'reading' ? 'Reading the list' : busy === 'importing' ? 'Importing' : plural(fresh.length, 'new finding'))}</span><span class="grow" /><button class="btn sm pri" type="button" id="il-go" disabled={!!busy} onClick={() => void run()}>Import</button></div>}
    </Modal>
  );
}

const Head = ({ onClose, disabled }: { onClose: () => void; disabled?: boolean }) => (
  <div class="shead"><h2>Import an Issues List</h2><button type="button" class="x" aria-label="Close"
    disabled={disabled} onClick={onClose}><Icon name="close" size={15} /></button></div>
);
