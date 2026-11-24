import { Fragment } from 'preact';
import { onListText, OnListMark } from './issuesList';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { TEXT_MAX } from '../domain/importExport';
import { checkingSays, watchCheck } from '../app/checking';
import { showTip, hideTip } from './tip';
import { ReadOnlyContext } from './editField';
import { useAppState, useStore, fmtDate, whenText , useDismiss, useMinuteTick } from './hooks';
import { afterDeletingFinding } from './nav';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';
import { Ref, byDocument, fewDocuments } from './ref';
import { DocName } from './docName';
import { FindingsHead } from './findingsHead';
import { workstreamChoices } from '../domain/order';
import { versionsWord, type State } from '../app/state';
import { checkLeftCount, uncheckedChecklistCount } from '../app/dealCounts';
import { findingsView } from '../app/findingsView';
import { ConflictView } from './conflict';
import { AskFirst } from './dialogs';
import { FindingLinks, askKept } from './findingAsk';
import { CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, TITLE_MAX } from '../app/commands/findings';
import { findingHistory, reassess, type FindingHistoryEvent } from '../app/findings';
import { createdRecord } from '../app/createdRecord';
import type { Deal, Finding, Source } from '../domain/model';
import { localYmd, CHECK_REASON } from '../domain/model';
import { splitCited, toParagraphs } from '../domain/cite';
import { SERVICE, AI_LABEL } from '../control';
import { keptDrafts, hasTexts } from './keptDrafts';
import { useSaveOut } from './saveOut';
import { editDrafts, editsOut, landCreated, landEdit, newFindingDrafts } from './findingDrafts';
import type { EditDraft } from './findingDrafts';
import { SourceChips } from './research';
import { CitedEditor } from './citedEditor';

/** The mark on an open finding that something has happened since it was written: what it says, and why. */
export const OUT_OF_DATE = 'May be out of date';
export function markText(f: Finding, questions?: Record<string, { n: number } | undefined>): string {
  // a mark that came from responses names the questions by the numbers they have now; one that has since been deleted is not named
  const qs = questions ? (f.updatedOn?.questions ?? []).flatMap((id) => (questions[id] ? [`Q${questions[id]!.n}`] : [])) : [];
  const why = qs.length ? `Response received on ${qs.slice(0, 3).join(', ')}${qs.length > 3 ? ` and ${qs.length - 3} more` : ''}` : f.updatedWhy === CHECK_REASON ? `Found by the check on ${fmtDate(localYmd(f.updatedAt))}` : f.updatedWhy;
  return why ? `${OUT_OF_DATE} · ${why}` : OUT_OF_DATE;
}

/** the dot after a finding's workstream: none when it has no workstream (an imported point the model could not place), so no line starts with a dot */
const dot = (f: { workstream: string }) => (f.workstream ? ' · ' : '');
export const findingHref = (f: { dealId: string; id: string }) => `#finding-${f.dealId}-${f.id}`;

/** Text whose sentences end in [n] become cited phrases pointing at sources[n-1]. */
export function Cited({ text, sources, onOpen, whole, onMore }: { text: string; sources: Source[]; onOpen?: (s: Source) => void; whole?: boolean; onMore?: () => void }) {
  // text that came with sources but no markers (an answer saved as a finding) is supported by all of them, as the answer was
  if (whole && sources.length) return <Ref text={text} sources={sources} onOpen={onOpen ? () => onOpen(sources[0]) : undefined} onMore={onMore} />;
  // a marker supports the sentence before it (domain/cite.ts); that sentence is the phrase you hover
  return <>{splitCited(text, sources.length).map((part, i) => {
    const src = part.refs.map((n) => sources[n - 1]).filter(Boolean);
    if (!src.length) return <span key={i}>{part.text}</span>;
    return <Ref key={i} text={part.text} sources={src} onOpen={onOpen ? () => onOpen(src[0]) : undefined} onMore={onMore} />;
  })}</>;
}

/**
 * Brief paragraphs: {phrase|findingId} links a phrase to a finding. Without `onFinding` the phrase goes to the finding's
 * page; a conversation passes its own, to open the finding beside it instead. `marked` is the finding open there now.
 */
export function Brief({ paragraphs, deal, onFinding, marked }: { paragraphs: string[]; deal: Deal; onFinding?: (f: Finding) => void; marked?: string }) {
  const s = useAppState();
  return <>{paragraphs.map((p, i) => <p key={i}>{p.split(/(\{[^|}]+\|f_[0-9A-Z]{26}\})/).map((seg, j) => {
    const m = /^\{([^|}]+)\|(f_[0-9A-Z]{26})\}$/.exec(seg);
    if (!m) return <span key={j}>{seg}</span>;
    const f = s.findings[m[2]];
    if (!f) return <span key={j}>{m[1]}</span>;
    const open = () => { if (onFinding) onFinding(f); else location.hash = findingHref(f).slice(1); };
    // a finding raised by hand with nothing cited still opens from here; it has no sources to show on hover
    if (!f.sources.length) return <span key={j} class="ref"><span class={`rb ${f.id === marked ? 'on' : ''}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>{m[1]}</span></span>;
    // every source is within reach: a long list shows a few and "N more", which opens the finding at its full list
    return <Ref key={j} text={m[1]} sources={f.sources} className={f.id === marked ? 'on' : ''} onOpen={open} openText="Open finding" onMore={() => { const shown = sourceLists.get(f.id); wantSources = f.id; open(); requestAnimationFrame(() => { if (shown && wantSources === f.id && sourceLists.get(f.id) === shown) { wantSources = null; shown(); } }); }} />;
  })}</p>)}</>;
}

/** when a closed finding was closed, as its row says it: "Closed yesterday", "Closed 3 days ago", "Closed Nov 14" */
const closedText = (at: string) => { const w = whenText(at); return `Closed ${/^[A-Z][a-z]{2} \d/.test(w) ? w : w[0].toLowerCase() + w.slice(1)}`; };

/**
 * The Findings ⋯ menu, matching Q&A's: Import…, Export…, then the seldom used Deleted… apart from them
 * (decisions.md, Findings). New finding stays the one visible button.
 */
function FindingsMore({ dealId, empty, restorable }: { dealId: string; empty: boolean; restorable: boolean }) {
  const store = useStore();
  const { can } = useAppState();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), '.fhead .fmore');
  // focus the ⋯ button first, so closing the dialog returns there
  const openDialog = (kind: 'importIssues' | 'exportFindings' | 'deleted') => {
    wrap.current?.querySelector('button')?.focus(); setOpen(false); store.ui({ dialog: { kind, dealId } });
  };
  return (
    <span class="colwrap fmore" ref={wrap}>
      <button type="button" class={`btn sm ico ${open ? 'on' : ''}`} id="f-more" aria-label="More" title="More"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" size={16} /></button>
      {open && <div class="colmenu glass" role="menu">
        {can.issuesList && <button type="button" class="mi" role="menuitem" id="f-import"
          onClick={() => openDialog('importIssues')}>Import…</button>}
        <button type="button" class="mi" role="menuitem" id="f-export" disabled={empty}
          onClick={() => openDialog('exportFindings')}>Export…</button>
        <div class="msep" />
        <button type="button" class="mi" role="menuitem" id="f-deleted" disabled={!restorable}
          onClick={() => openDialog('deleted')}>Deleted…</button>
      </div>}
    </span>
  );
}

/** A finding's status menu, Open or Closed, the current one checked (design.md, Menus). */
function StatusMenu({ status, choose }: { status: string; choose: (x: 'open' | 'closed') => void }) {
  return <div class="colmenu glass stmenu" role="menu">{(['open', 'closed'] as const).map((x) => (
    <button type="button" role="menuitemradio" aria-checked={x === status} key={x}
      class={`mi ${x === status ? 'on' : ''}`} onClick={() => choose(x)}>
      {x === 'open' ? 'Open' : 'Closed'}<ChoiceCheck on={x === status} />
    </button>))}</div>;
}

/**
 * Check again, shown on Overview under the three blocks only when a check is due: while one runs; when
 * the latest check did not finish, left something out, or its spot check disagreed with the quick results; and when
 * checklist items have not been checked yet. It names what a check covers (the checklist and the findings, not every
 * document). What the latest check left out stays until a later check clears it; after a spot check that disagreed,
 * the button runs the check in depth.
 */
export function CheckLine({ deal: d }: { deal: Deal }) {
  const store = useStore(); const s = useAppState(); const c = s.checks[d.id]; const ro = useContext(ReadOnlyContext);
  useEffect(() => s.can.checkAll ? watchCheck(store, d.id) : undefined, [store, d.id, s.can.checkAll]);
  const on = (iso: string) => fmtDate(localYmd(iso)); const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const out = c?.left ? [c.left.items ? n(c.left.items, 'checklist item', 'checklist items') : '', c.left.findings ? n(c.left.findings, 'finding', 'findings') : ''].filter(Boolean).join(' and ') : '';
  const deep = !!c?.offerDeep && !c.left && !c.failedAt;
  // what the latest check left out can be checked on its own while the documents are the ones it checked
  const rest = checkLeftCount(c, deep);
  const shared = checkingSays(c?.checking, c?.busy === 'deep');
  // checklist items no check has reached yet, such as items brought in since the last one; not while the first pass is still reading
  const unchecked = uncheckedChecklistCount(s, d);
  // the names shown on hover go when the line no longer has them
  // the names go in the same frame as the line that named them, not a frame after it (#695)
  const lineRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!shared?.who && lineRef.current) hideTip(lineRef.current);
  }, [shared?.who]);
  const said = shared ? shared.text : c?.busy ? `Checking the checklist and findings${c.busy === 'deep' ? ' in depth' : ''}`
    : c?.failedAt ? `The check on ${on(c.failedAt)} did not finish`
    : c?.left ? `${on(c.left.at)} check left out ${out}`
    : deep ? `${c!.at ? `${on(c!.at)} spot` : 'Spot'} check disagreed with ${c!.offerDeep!.overturned} of its ${c!.offerDeep!.size} results`
    : unchecked ? `${n(unchecked, 'checklist item', 'checklist items')} not checked yet` : '';
  const warn = !c?.busy && (!!c?.failedAt || !!c?.left || deep || unchecked > 0);
  // the line goes once nothing is due; if the focus was in it, it moves to the deal's ⋯, where Check again stays, not to the page
  const had = useRef(false);
  useEffect(() => { if (!said && had.current) { had.current = false; if (!document.activeElement || document.activeElement === document.body) document.getElementById('deal-more')?.focus(); } }, [!!said]);
  if (!s.can.checkAll || !said) return null;
  return <div class="ovcheck" id="ov-check" onFocusIn={() => { had.current = true; }} onFocusOut={(e) => { if (e.relatedTarget && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) had.current = false; }}>
    {said && <span ref={lineRef} class={`when ${warn ? 'warn' : ''}`} id="f-checked" role="status" {...(shared?.who ? { tabIndex: 0, 'aria-description': shared.who, onMouseEnter: (e: MouseEvent) => showTip(e.currentTarget as HTMLElement, shared.who!), onMouseLeave: (e: MouseEvent) => hideTip(e.currentTarget as HTMLElement), onFocus: (e: FocusEvent) => showTip(e.currentTarget as HTMLElement, shared.who!, 0), onBlur: (e: FocusEvent) => hideTip(e.currentTarget as HTMLElement) } : {})}>{warn && <i class="dot" aria-hidden="true" />}{said}</span>}
    {/* while a check runs the button is off but keeps the focus (aria-disabled, not disabled, which would drop the focus to the page) */}
    <span class="needs" title={ro ?? undefined}><button type="button" class="btn sm"
      id={deep ? 'f-check-deep' : rest ? 'f-check-left' : 'f-check'} disabled={!!ro}
      aria-disabled={c?.busy ? true : undefined} title={ro ?? undefined}
      onClick={() => { if (!c?.busy) void store.checkEverything(d.id, deep, !!rest); }}>{c?.busy ? 'Checking' : deep
      ? 'Check Again in Depth' : rest ? `Check the ${rest} Left Out` : 'Check Again'}</button></span>
  </div>;
}

/** A workstream's heading in the Findings list, styled as the Checklist's group headings; read out as "Legal, 12", not "Legal12". */
const GroupHead = ({ name, n }: { name: string; n: number }) => <div class="ckgroup fgroup" role="heading" aria-level={3} aria-label={`${name}, ${n}`}>{name}<span class="n">{n}</span></div>;

function findingActivity(finding: Finding, questions: State['questions'], status?: string) {
  const opening = dot(finding);
  if (finding.status === 'closed' && finding.closedAt) return opening + closedText(finding.closedAt);
  const when = finding.status === 'open' && finding.updated
    ? markText(finding, questions) : whenText(finding.raisedAt);
  return opening + (status ? `${status} · ` : '') + when;
}

function FindingListRow({ finding: f, questions, conflictVersions, showStatus }: {
  finding: Finding; questions: State['questions']; conflictVersions?: number; showStatus: boolean;
}) {
  const open = f.status === 'open';
  const status = open ? 'Open' : 'Closed';
  const activity = findingActivity(f, questions, showStatus ? status : undefined);
  return <a href={findingHref(f)} class="flagrow">
    <span class={`stripe ${open ? 'High' : ''}`} title={status} />
    <span class="ft">
      {f.updated && (open ? <i class="upd" aria-hidden="true" /> : <i class="upd" title="May need reopening" />)}
      {f.aiTitle && <AiTitle />}{f.title}
      {f.reviewed && <i class="rvd" title={`Reviewed by ${f.reviewed.by}`}><Icon name="checkfill" size={13} /></i>}
    </span>
    <span class="fm" title={!open && f.note ? f.note : undefined}>
      {conflictVersions !== undefined &&
        <><span class="cf" data-conflict>{versionsWord(conflictVersions)}</span> · </>}
      {f.workstream}{activity}{f.onLists?.length ? ` · ${onListText(f.onLists)}` : ''}
    </span>
  </a>;
}

export function FindingsSection({ deal: d }: { deal: Deal }) {
  const s = useAppState();
  useMinuteTick();
  const [adding, setAdding] = useState(() => newFindingDrafts.has(d.id));   // a half-written new finding comes back open
  const view = findingsView(s, d.id);
  const { many, rows, counts } = view;
  return (
    <>
      <section class={`twocol one ${many ? 'many' : ''}`}><div>
        <FindingsHead view={view} adding={adding} onNew={() => setAdding(true)}>
          <FindingsMore dealId={d.id} empty={!counts.total} restorable={view.restorable} />
        </FindingsHead>
        {adding && <NewFindingCard deal={d} onDone={() => { setAdding(false); requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) document.getElementById('f-new')?.focus(); }); }} />}
        <div class={`flags ${many ? 'scroll' : ''}`}>
          {rows.length ? rows.map(({ finding, heading, conflictVersions }) => <Fragment key={finding.id}>
            {heading && <GroupHead name={heading.name} n={heading.count} />}
            <FindingListRow finding={finding} questions={s.questions} conflictVersions={conflictVersions}
              showStatus={view.filter.status === 'all'} />
          </Fragment>) : <p class="emptyline" style="margin-top:14px">
            {counts.total ? 'Nothing matches.' : 'Nothing has been flagged.'}
          </p>}
        </div>
      </div></section>
    </>
  );
}

/** A finding's own words, edited in place. Save and Cancel are the only ways out; nothing is saved as you type. */
/**
 * Work half done on a finding, by finding id: an open edit and a half-typed closing or reopening note. Moving to another
 * finding, another tab or another deal, or pressing Escape, keeps it, and it comes back when the finding is opened again.
 * Cancel, Save, or the change being made clears it.
 */
const isNoteDraft = (v: unknown): v is { status: 'open' | 'closed'; text: string } => hasTexts('text', 'status')(v) && (v.status === 'open' || v.status === 'closed');
const noteDrafts = keptDrafts('closing-note', isNoteDraft);
/** a summary's "N more" opens its finding with the focus on the full list of sources: the page that mounts for it takes the wish;
 *  if the finding was already showing and stays, nothing mounts, so a frame later its list is shown. Any other finding opening drops the wish */
const sourceLists = new Map<string, () => void>();
let wantSources: string | null = null;

/** the Detail label's tooltip in the finding editor */
const CITE_TIP = 'A tag after a sentence names the source it cites. It moves with its sentence.';

function EditFindingCard({ f, onDone }: { f: Finding; onDone: () => void }) {
  const store = useStore();
  // what was typed and kept, or, after Cancel while a save is out, what that save sent (#771)
  const kept = editDrafts.get(f.id) ?? editsOut.get(f.id);
  // the finding as this edit began (kept with the draft, so a change made elsewhere meanwhile is still caught on Save)
  const start: EditDraft = kept ?? {
    title: f.title, ws: f.workstream, body: f.body.join('\n\n'),
    base: { title: f.title, workstream: f.workstream, body: f.body },
  };
  const [title, setTitleState] = useState(start.title);
  const [ws, setWsState] = useState(start.ws);
  const [body, setBodyState] = useState(start.body);
  const [error, setError] = useState('');   // why Save was refused: said beside the buttons, and the edit stays open
  const draft = useRef(start); const base = useRef(start.base);
  // remembered as it is typed (not after the next draw), so leaving the finding straight after typing keeps it
  // the base kept with the draft wins: a save sent from this edit before it was closed and opened again moves it on
  const keptBase = () => editDrafts.get(f.id)?.base ?? base.current;
  const remember = (patch: Partial<EditDraft>) => {
    draft.current = { ...draft.current, base: keptBase(), ...patch };
    editDrafts.set(f.id, draft.current);
  };
  const setTitle = (v: string) => { setTitleState(v); remember({ title: v }); }; const setWs = (v: string) => { setWsState(v); remember({ ws: v }); };
  const setBody = (v: string) => {
    setBodyState(v);
    remember({ body: v });
  };
  // #771: once a save lands, this edit (or the one drawn for the finding since) shows a refusal, or closes when
  // nothing typed is kept
  const settle = (refusal: string | null) => {
    if (refusal) setError(refusal);
    else if (!editDrafts.has(f.id)) onDone();
  };
  const out = useSaveOut('finding-edit:' + f.id, settle);
  const busy = out.busy;
  const cancel = () => {
    out.cancel();
    editDrafts.delete(f.id);
    onDone();
  };
  const wsOptions = workstreamChoices([f.workstream]);   // a name of its own (from an import) takes its place A to Z
  const save = () => {
    if (busy) return;
    remember({});   // the kept draft holds what is sent, so the save can tell what is typed after it (#771)
    const sent = draft.current;
    const edit = {
      dealId: f.dealId, findingId: f.id, title, workstream: ws, body: toParagraphs(body), base: sent.base,
    };
    void out.send(async (cancelled) => {
      editsOut.set(f.id, sent);
      const r = await store.dispatch(EditFinding, edit, { idempotencyKey: 'f-edit-' + f.id })
        .finally(() => editsOut.delete(f.id));
      return landEdit(f.id, sent, r, cancelled());
    });
  };
  return (
    <div class="card addf fedit" data-holds-work onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); } }}>
      <div class="lbl">Title</div>
      <input class="in" id="fe-title" aria-label="Title" maxLength={Math.max(TITLE_MAX, f.title.length)} value={title} ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      <select class={`field ${ws ? '' : 'unset'}`} id="fe-ws" aria-label="Workstream" value={ws} onChange={(e) => setWs((e.currentTarget as HTMLSelectElement).value)}>{wsOptions.map((w) => <option key={w} value={w}>{w}</option>)}</select>
      {/* #636: each citation is a tag after the sentence it supports; the tooltip says so, the screen does not */}
      <div class="lbl" title={CITE_TIP}>Detail</div>
      <CitedEditor id="fe-body" label="Detail" text={body} sources={f.sources} onText={setBody} />
      <div class="cacts">{error && <p class="emptyline err" id="fe-err" role="alert">{error}</p>}<button type="button" class="btn sm pri" id="fe-save" disabled={busy || !title.trim() || !ws} onClick={() => void save()}>Save</button><button type="button" class="btn sm" id="fe-cancel" onClick={cancel}>Cancel</button></div>
    </div>
  );
}

function NewFindingCard({ deal: d, onDone }: { deal: Deal; onDone: () => void }) {
  const store = useStore();
  const kept = newFindingDrafts.get(d.id);
  const [title, setTitleState] = useState(kept?.title ?? '');
  const [ws, setWsState] = useState(kept?.ws ?? '');
  const [body, setBodyState] = useState(kept?.body ?? '');
  // remembered as it is typed (not after the next draw), so leaving the page straight after typing keeps it
  const draft = useRef({ title: kept?.title ?? '', ws: kept?.ws ?? '', body: kept?.body ?? '' });
  const remember = (patch: Partial<typeof draft.current>) => { const n = { ...draft.current, ...patch }; draft.current = n; if (n.title || n.ws || n.body) newFindingDrafts.set(d.id, n); else newFindingDrafts.delete(d.id); };
  const setTitle = (v: string) => { setTitleState(v); remember({ title: v }); }; const setWs = (v: string) => { setWsState(v); remember({ ws: v }); }; const setBody = (v: string) => { setBodyState(v); remember({ body: v }); };
  // #771: once Create lands, the form on screen (this one, or one opened again since) closes when nothing typed is
  // kept, and opens the finding made when what was typed since went to it. Left alone (undefined) after a refusal,
  // or when Cancel let the save go
  const settle = (made: Finding | null | undefined) => {
    if (made === undefined || newFindingDrafts.has(d.id)) return;
    onDone();
    if (made) location.hash = findingHref(made);
  };
  const out = useSaveOut('new-finding:' + d.id, settle);
  const busy = out.busy;
  const cancel = () => {
    out.cancel();
    newFindingDrafts.delete(d.id);
    onDone();
  };
  const create = () => {
    const sent = { title, ws, body };
    const input = { dealId: d.id, title, workstream: ws, body: toParagraphs(body), origin: 'human' as const };
    void out.send(async (cancelled) => {
      const r = await store.dispatch(CreateFinding, input, { idempotencyKey: 'f-create-' + d.id });
      // cancelled while it was out: a form opened since is left alone
      if (!r.ok || cancelled()) return undefined;
      return landCreated(d.id, sent, createdRecord(store.get(), r.value.opId, 'findings'));
    });
  };
  return (
    <div class="card addf" data-holds-work onKeyDown={(e) =>
      { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); } }}><div
      class="lbl">New Finding on {d.name}</div>
      <input class="in" id="af-title" placeholder="What did you find?" aria-label="Title" maxLength={TITLE_MAX} ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      <select class={`field ${ws ? '' : 'unset'}`} id="af-ws" aria-label="Workstream" value={ws} onChange={(e) => setWs((e.currentTarget as HTMLSelectElement).value)}><option value="">Workstream</option>{workstreamChoices().map((w) => <option key={w} value={w}>{w}</option>)}</select>
      <textarea class="in ta" id="af-body" maxLength={TEXT_MAX} rows={3} placeholder="What you found and where" aria-label="Detail" value={body} onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
      <div class="cacts"><button type="button" class="btn sm pri" id="af-create" disabled={busy || !title.trim() || !ws}
        onClick={() => void create()}>Create Finding</button><button type="button" class="btn sm" id="af-cancel"
        onClick={cancel}>Cancel</button></div>
    </div>
  );
}

const HIST_TEXT: Record<FindingHistoryEvent['kind'], string> = {
  edited: 'Edited', status: 'Status changed', response: 'Response received', responseWithdrawn: 'Response removed',
  document: 'Document attached', reassessed: 'Updated', note: 'Note added',
};

function historyText(event: FindingHistoryEvent): string {
  if (event.kind === 'status' && (event.to === 'closed' || event.to === 'open')) {
    return `${event.to === 'closed' ? 'closed' : 'reopened'} by ${event.actor}`;
  }
  if (event.kind === 'note') return HIST_TEXT.note;
  return event.text ?? HIST_TEXT[event.kind];
}

/** The finding as its page shows it. In the side pane beside a conversation (`pane`) it has no Edit or Delete: those are on its page. */
export function FindingOpening({ dealId, findingId, onOpen, pane }: { dealId: string; findingId: string; onOpen: (s: Source) => void; pane?: boolean }) {
  const store = useStore(); const s = useAppState(); useMinuteTick();
  const f = s.findings[findingId];
  const [menu, setMenu] = useState(false); const [note, setNoteState] = useState(() => noteDrafts.get(findingId) ?? null);
  const [asking, setAsking] = useState(false);   // Delete asks first
  // a finding that comes into two versions while asked shows the choice instead, and the ask does not come back after it
  const split = !!s.conflicts[findingId]; useLayoutEffect(() => { if (split) setAsking(false); }, [split]);
  const [editing, setEditing] = useState(() => editDrafts.has(findingId));
  // the full list of sources, for a finding citing more documents than a pop shows: open, and focused when reached from "N more"
  const [srcOpen, setSrcOpen] = useState(true); const srcList = useRef<HTMLDetailsElement>(null);
  const showSources = () => { setSrcOpen(true); requestAnimationFrame(() => (srcList.current?.querySelector('.sgp button') as HTMLElement | null)?.focus()); };
  useLayoutEffect(() => { setSrcOpen(true); if (wantSources === findingId) showSources(); wantSources = null; }, [findingId]);
  useEffect(() => { sourceLists.set(findingId, showSources); return () => { if (sourceLists.get(findingId) === showSources) sourceLists.delete(findingId); }; });
  // a note is remembered as it is typed; null closes the box and forgets it (Cancel, or the change made)
  const setNote = (n: null | { status: 'open' | 'closed'; text: string }) => { setNoteState(n); if (n) noteDrafts.set(findingId, n); else noteDrafts.delete(findingId); };
  // another finding opened in this page: its own half-done edit or note comes back, this one's stays remembered.
  // A layout effect, so it has run before the person can press anything: run after paint, it closed a menu opened at once
  useLayoutEffect(() => { void store.loadAudit(findingId); setMenu(false); setAsking(false); setNoteState(noteDrafts.get(findingId) ?? null); setEditing(editDrafts.has(findingId)); }, [findingId]);
  useDismiss(menu, () => setMenu(false), '.stwrap');
  if (!f) return null;
  if (s.conflicts[f.id]) {
    // the stepper only on the finding's own page: from the side pane it would leave the page behind
    const clash = <ConflictView conflict={s.conflicts[f.id]} stepper={!pane} />;
    // #340: a question being typed stays in sight while the finding is in two versions
    const typing = askKept(f.id) && <FindingLinks key={f.id} dealId={dealId} f={f} pane={pane} />;
    return <div class="opening"><div class="lbl fmeta"><span>{f.workstream}</span></div>{clash}{typing}</div>;
  }
  const { last, previous: prev, previousReview: wasReviewed } = findingHistory(s, f.id);
  const lastText = last ? historyText(last) : '';
  const busy = s.ui.reassessing.includes(f.id);
  // which sources the detail's markers point at
  const marked = new Set(f.body.flatMap((b) => splitCited(b, f.sources.length).flatMap((p) => p.refs)));
  const docs = byDocument(f.sources);
  const listed = !fewDocuments(f.sources);
  const raised = f.origin !== 'ai' && f.raisedBy ? `Raised by ${f.raisedBy} · ${fmtDate(localYmd(f.raisedAt))}` : `identified ${whenText(f.raisedAt).toLowerCase()}`;
  const commit = async (status: 'open' | 'closed', text: string) => { const r = await store.dispatch(SetFindingStatus, { dealId, findingId, status, note: text.trim() || undefined }, { idempotencyKey: 'fst-' + f.id }); if (r.ok) setNote(null); };
  const del = async () => { const r = await store.dispatch(DeleteFinding, { dealId, findingId }, { idempotencyKey: 'fdel-' + f.id }); if (r.ok) location.hash = afterDeletingFinding(dealId); };
  return (
      <div class="opening">
        <div class="lbl fmeta"><span>{f.workstream}{dot(f)}{raised}{f.reviewed ? ` · reviewed by ${f.reviewed.by}, ${fmtDate(localYmd(f.reviewed.at))}` : ''}{last ? ` · ${lastText} · ${whenText(last.at).toLowerCase()}` : ''}<OnListMark f={f} /></span>
          <span class="fctl">
            {/* each control keeps its place and its width whatever the finding's state, so the hand finds it without looking */}
            <button type="button" class={`btn sm rev ${f.reviewed ? 'on' : ''}`} id="f-review" aria-pressed={!!f.reviewed} onClick={() => void store.dispatch(ReviewFinding, { dealId, findingId, reviewed: !f.reviewed }, { idempotencyKey: 'frev-' + f.id })}><Icon name={f.reviewed ? 'check' : 'checkbox'} size={14} /> Reviewed</button>
            <span class="stwrap"><button type="button" class="btn sm" id="f-status" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{f.status === 'open' ? 'Open' : 'Closed'} <span class="chev"><Icon name="chev" size={13} /></span></button>
              {menu && <StatusMenu status={f.status} choose={(x) => {
                setMenu(false);
                const kept = noteDrafts.get(findingId);
                if (x !== f.status) setNote(kept?.status === x ? kept : { status: x, text: '' });
              }} />}</span>
            {!pane && <><button type="button" class="btn sm ico" id="f-edit" aria-label="Edit finding" title="Edit" aria-pressed={editing} disabled={busy} onClick={() => setEditing(true)}><Icon name="edit" size={15} /></button>
            <button type="button" class="btn sm ico del" id="f-delete" aria-label="Delete finding" title="Delete" onClick={() => setAsking(true)}><Icon name="trash" size={15} /></button></>}
          </span>
        </div>
        {f.updated && f.status === 'open' && <p class="fnotice" id="f-outdated" role="status"><span><i class="dot"
          aria-hidden="true" />{markText(f, s.questions)}</span><button type="button" class="btn sm" id="f-reassess"
          disabled={busy} onClick={() => void reassess(store, dealId, findingId)}>{busy ? 'Updating'
          : 'Update from Documents'}</button></p>}
        {/* a closed finding the documents bring into question: one Reopen, through the same note as the status menu;
           doing nothing leaves it closed */}
        {f.updated && f.status === 'closed' && !note && <p class="fnotice" id="f-maybe" role="status"><span><i class="dot" aria-hidden="true" />{markText(f, s.questions)}</span><button type="button" class="btn sm" id="f-reopen" onClick={() => setNote(noteDrafts.get(findingId)?.status === 'open' ? noteDrafts.get(findingId)! : { status: 'open', text: '' })}>Reopen</button></p>}
        {editing ? <EditFindingCard key={f.id} f={f} onDone={() => { setEditing(false); requestAnimationFrame(() => document.getElementById('f-edit')?.focus()); }} /> : <>
        <p class="qtxt" role="heading" aria-level={1}>{f.aiTitle && <AiTitle />}{f.title}</p>
        {/* the note for closing or reopening opens under the title, so the title stays where it was */}
        {note && <div class="fnote" data-holds-work onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNoteState(null); requestAnimationFrame(() => document.getElementById('f-status')?.focus()); } }}><div class="lbl">{note.status === 'open' ? 'Reopen' : 'Mark closed'}</div><textarea maxLength={TEXT_MAX} id="fnote-text" rows={2} placeholder="Note (optional)" aria-label="Note" ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} value={note.text} onInput={(e) => setNote({ ...note, text: (e.currentTarget as HTMLTextAreaElement).value })} /><div class="cacts"><button type="button" class="btn sm pri" id="fnote-save" onClick={() => void commit(note.status, note.text)}>Save</button><button type="button" class="btn sm" onClick={() => setNote(null)}>Cancel</button></div></div>}
        {/* up to four documents, its sources as chips above the detail, as under an answer */}
        {!busy && !listed && <SourceChips sources={f.sources} onOpen={onOpen} dealId={dealId} />}
        {busy ? <div class="ai pending" aria-label="Updating"><span class="dots"><i /><i /><i /></span></div> : f.body.map((b, i) => <p class="dtxt" key={i}><Cited text={b} sources={f.sources} onOpen={onOpen} whole={!marked.size && !f.ownWords} onMore={listed ? showSources : undefined} /></p>)}
        {/* more documents than a pop shows: every one, with its places, in a list like Previous version */}
        {!busy && listed && <details class="prev fsrcs" id="f-sources" ref={srcList} open={srcOpen} onToggle={(e) => setSrcOpen((e.currentTarget as HTMLDetailsElement).open)}><summary>{docs.length} sources</summary>
          <div class="sgl">{docs.map((g) => <div class="sgr" key={g.doc.docId}><span class="sgd"><DocName name={g.doc.doc} /></span><span class="sgp">{g.items.filter((x, j) => g.items.findIndex((y) => y.loc === x.loc) === j).map((x, j) => <button type="button" class="srcbtn" key={j} aria-label={`${g.doc.doc}, ${x.loc || 'open'}`} onClick={() => onOpen(x)}>{x.loc || 'Open'}</button>)}</span></div>)}</div></details>}
        {f.note && <><div class="lbl" style="margin-top:12px">Note</div><p class="dtxt" style="white-space:pre-wrap">{f.note}</p></>}
        {prev && <details class="prev"><summary>Previous version · {fmtDate(localYmd(prev.at))}{wasReviewed ? ` · reviewed by ${wasReviewed.by}` : ''}</summary><p class="dtxt">{(prev.from as string[]).join(' ').replace(/\s*\[\d+\]/g, '')}</p></details>}
        </>}
        {/* drawn afresh for each finding, so a question still saving for one never touches the next one's */}
        <FindingLinks key={f.id} dealId={dealId} f={f} pane={pane} />
        {asking && <AskFirst ask="Delete this finding?" go="Delete" why="It can be restored from Deleted" onKeep={() => setAsking(false)} onGo={() => { setAsking(false); void del(); }} />}
      </div>
  );
}

/** the mark before a title the model wrote: the words beneath it are counsel's own */
const AiTitle = () => <b class="aim" title={`Title written by ${AI_LABEL}`}>{AI_LABEL}</b>;
