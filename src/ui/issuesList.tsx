/**
 * Import an issues list into a deal's Findings. The person chooses the list (a PDF, a Word file or an email) or pastes
 * its text; it is attached to the deal as a chat attachment is, and the model reads its points and says which repeat
 * a finding already raised (open or closed) or an earlier point. Those are listed under "Already raised", each saying
 * what it joins, unless the person checks "Keep separate". Every other point is listed under "New findings", read
 * only, with the title and workstream the model gave it. Nothing is recorded until Import.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { Modal, LeaveFoot } from './dialogs';
import { num, plural } from './counts';
import { FileInput, PasteNext, PasteRow, PickFileRow } from './fileDrop';
import { pastedLineCount } from '../app/listRead';
import { showTip, hideTip } from './tip';
import {
  issuesListTitle, keepIssuesPaste, keptIssuesList, keptIssuesPaste, pointsByList, readIssuesList,
  readPastedIssuesList, reviewIssuesList, submitIssuesList, type IssuesListKept, type ReadIssuesList,
} from '../app/issuesList';
import type { Finding, ListPoint } from '../domain/model';
import { keepImport, dropImport, importKey } from '../app/keptImports';
import { useKeptImportsReady, useFreshOnCrash } from './keptImports';

/** the files a list comes as; pasted text is the other way in */
const ACCEPT = '.pdf,.docx,.msg,.eml';

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
  const lines = ({ title, points }: ReturnType<typeof pointsByList>[number]) =>
    [title, ...points.map((mark) => `#${mark.n} · ${oneLine(mark.text)}`)];
  return pointsByList(marks).flatMap(lines).join('\n');
};

/** The mark on a finding's page: its points, with the list and their words on hover or focus. Plain text, as the list row's. */
export function OnListMark({ f }: { f: Finding }) {
  if (!f.onLists?.length) return null;
  const tip = (e: Event) => showTip(e.currentTarget as HTMLElement, onListTip(f.onLists!));
  const off = (e: Event) => hideTip(e.currentTarget as HTMLElement);
  return <> · <span class="ilh" id="f-onlists" tabIndex={0} aria-description={onListTip(f.onLists)} onMouseEnter={tip} onMouseLeave={off} onFocus={tip} onBlur={off}>{onListText(f.onLists)}</span></>;
}

/** The issues list import picks up where it was left on this PC: it waits the moment it takes to read what was kept */
export function IssuesListDialog({ dealId }: { dealId: string }) {
  const ready = useKeptImportsReady(); const fresh = useFreshOnCrash();
  return !ready || fresh === 'gone' ? null : <IssuesListImport key={String(fresh)} dealId={dealId} fresh={fresh} />;
}

function IssuesListImport({ dealId, fresh: afresh }: { dealId: string; fresh: boolean }) {
  const store = useStore(); const s = useAppState();
  const KEY = importKey.issues(dealId);
  const [left] = useState(() => (afresh ? null : keptIssuesList(KEY)));
  const [list, setList] = useState<ReadIssuesList | null>(left?.list ?? null);
  const [kept, setKept] = useState<Set<number>>(left?.kept ?? new Set());   // points the person keeps as their own finding
  const [busy, setBusy] = useState<'' | 'reading' | 'importing'>('');
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(false); const [swapping, setSwapping] = useState(false);
  const token = useRef(0);
  // The list as read and the check marks are kept on this PC as they change, so closing, a reload or a restart loses neither,
  // nor the model call that read the list: opening the import again picks it up where it was left. Another
  // list read in its place, "start over" (which asks first) or the import itself lets it go.
  const holding = useRef(false);
  const keep = () => { if (list && !holding.current) keepImport(KEY, { list, kept }); };
  // a failed import keeps the state as it is then, not as Import found it
  const nowKept = useRef<IssuesListKept | null>(null);
  nowKept.current = list && { list, kept };
  // biome-ignore lint/correctness/useExhaustiveDependencies: written as soon as what is kept changes, before the next frame
  useLayoutEffect(keep, [list, kept]);
  const close = () => { if (busy === 'importing') return; setSwapping(false); token.current++; store.ui({ dialog: null }); };
  const startOver = () => { token.current++; dropImport(KEY); setRestart(false); setSwapping(false); setBusy(''); setError(''); setList(null); setKept(new Set()); };
  // back to the file and the paste box, the paste as it was left, as the checklist's change; the list stays kept
  const change = () => {
    setSwapping(false);
    setRestart(false);
    setError('');
    setList(null);
  };

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
  const pasted = (text: string) => void load('the pasted list',
    (current) => readPastedIssuesList(store, dealId, text, current));

  if (!list) return <PickStep keyName={KEY} fresh={afresh} error={error} reading={busy === 'reading'} onFile={read}
    onPaste={pasted} onClose={close} />;

  const { points } = list;
  const { shown, raised, fresh, input } = reviewIssuesList(s, dealId, list, kept);
  const was = (k: number): [string, string] => { const t = shown[k]!; return typeof t === 'number' ? ['Joins', `#${points[t].n} ${points[t].title}`] : [t.status === 'closed' ? 'Joins closed finding' : 'Joins', t.title]; };
  // the point numbers' column is as wide as the longest, so every title starts at the same place in both sections
  const nw = `calc(${Math.min(6, points.reduce((m, p) => Math.max(m, p.n.length), 1))}ch + .7em)`;   // the digits, and the #; a longer number is cut, and whole on hover
  const run = async () => {
    if (busy) return;
    setBusy('importing'); setError(''); setRestart(false); setSwapping(false);
    holding.current = true;
    const result = await submitIssuesList(store, KEY, { dealId, list, points: input }, () => nowKept.current);
    setBusy('');
    holding.current = false;
    if (!result.ok) {
      setError(`Couldn’t import: ${result.error.message}`);
      return;
    }
    store.ui({ dialog: null });
  };
  return (
    <Modal onClose={close} label="Import an issues list" blur className="sdlg imdlg ilf">
      <Head onClose={close} disabled={busy === 'importing'} />
      <div class="ilf-body" style={{ '--nw': nw }}>
        <ListFileRow file={list.doc.doc} points={points.length} busy={!!busy}
          onChange={() => (kept.size ? setSwapping(true) : change())}
          onRestart={() => { setSwapping(false); setRestart(true); }} />
        {raised.length > 0 && <div class="srow top"><div class="k">Already Raised<span
          class="cnt">{num(raised.length)}</span></div><div id="il-raised">
          {raised.map((k) => { const p = points[k]; const [what, words] = was(k); return (
            <div class="rv-row ilr" key={k}><span class="n" title={`#${p.n}`}>#{p.n}</span><div><div class="pt">{p.text}</div><div class={`was ${kept.has(k) ? 'off' : ''}`}><i>{what}</i>{words}</div></div>
              <label class="keep"><input type="checkbox" aria-label={`Keep #${p.n} separate`} disabled={busy === 'importing'} checked={kept.has(k)} onChange={(e) => { const on = (e.currentTarget as HTMLInputElement).checked; setKept((x) => { const y = new Set(x); if (on) y.add(k); else y.delete(k); return y; }); }} />Keep separate</label></div>
          ); })}
        </div></div>}
        {/* every finding Import will make, read only: its title the point's own words, its workstream the model's */}
        {fresh.length > 0 && <div class="srow top"><div class="k">New Findings<span
          class="cnt">{num(fresh.length)}</span></div><div id="il-new">
          {fresh.map((k) => <div class="iln" key={k}><span class="n" title={`#${points[k].n}`}>#{points[k].n}</span><span class="t">{points[k].title}</span><span class="ws">{points[k].workstream}</span></div>)}
        </div></div>}
      </div>
      {/* another list would drop the points checked on this one: asked first, as closing is */}
      {swapping ? <LeaveFoot id="il-swap" ask="Choose another list?" go="Choose" keep={() => setSwapping(false)}
        leave={change} />
        : restart ? <LeaveFoot id="il-restart-ask" ask="Clear this import and start over?" go="Start Over"
          keep={() => setRestart(false)} leave={startOver} />
        : <div class="xfoot"><span id="il-line" class={error ? 'err' : ''} role={error ? 'alert' : undefined}>{error || (busy === 'reading' ? 'Reading the list' : busy === 'importing' ? 'Importing' : plural(fresh.length, 'new finding'))}</span><span class="grow" /><button class="btn sm pri" type="button" id="il-go" disabled={!!busy} onClick={() => void run()}>Import</button></div>}
    </Modal>
  );
}

interface PickProps {
  keyName: string;
  /** opened past a kept import it could not show: the paste kept with it is not shown either */
  fresh: boolean;
  error: string;
  reading: boolean;
  onFile: (file: File) => void;
  onPaste: (text: string) => void;
  onClose: () => void;
}

/** Step 1: a file, or the list pasted into the box and sent with Next, as a checklist is pasted (firmChecklistSteps) */
function PickStep({ keyName, fresh, error, reading, onFile, onPaste, onClose }: PickProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState(() => (fresh ? '' : keptIssuesPaste(keyName)));
  // what is typed in the box is kept on this PC as it changes, so closing, a reload or a restart loses none of it
  useLayoutEffect(() => keepIssuesPaste(keyName, paste, fresh), [keyName, fresh, paste]);
  const lines = pastedLineCount(paste);
  const line = reading ? 'Reading the list' : lines ? plural(lines, 'line') : '';
  return (
    <Modal onClose={onClose} label="Import an issues list" blur className="sdlg imdlg ilf">
      <Head onClose={onClose} />
      <PickFileRow dropId="il-drop" errorId="il-error" error={error} onFile={onFile}>
        Drop a file here, or{' '}
        <button type="button" class="linkb" id="il-browse" onClick={() => fileRef.current?.click()}>
          choose a file…</button>
        <FileInput id="il-file" accept={ACCEPT} inputRef={fileRef} onFile={onFile} />
      </PickFileRow>
      <PasteRow id="il-paste" value={paste} onInput={setPaste} />
      <div class="xfoot"><span id="il-line">{line}</span><span class="grow" />
        <PasteNext id="il-paste-next" lines={lines} busy={reading} onNext={() => onPaste(paste)} />
      </div>
    </Modal>
  );
}

interface FileRowProps {
  file: string;
  points: number;
  busy: boolean;
  onChange: () => void;
  onRestart: () => void;
}

/** The list's file, its points, change and start over. The end of the name stays in sight when it is cut: lists from
 * one counsel differ by their date. */
function ListFileRow({ file, points, busy, onChange, onRestart }: FileRowProps) {
  const name = issuesListTitle(file);
  return (
    <div class="srow"><div class="k">File</div><div class="ilfile">
      <span class="fnw" title={file}><span class="fn">{name.slice(0, -9)}</span><span>{name.slice(-9)}</span></span>
      <span class="c" id="il-count">{plural(points, 'point')}</span>
      <button type="button" class="linkb" id="il-change" disabled={busy} onClick={onChange}>change</button>
      <button type="button" class="linkb" id="il-restart" disabled={busy} onClick={onRestart}>start over</button>
      <span class="grow" />
    </div></div>
  );
}

const Head = ({ onClose, disabled }: { onClose: () => void; disabled?: boolean }) => (
  <div class="shead"><h2>Import an Issues List</h2><button type="button" class="x" aria-label="Close"
    disabled={disabled} onClick={onClose}><Icon name="close" size={15} /></button></div>
);
