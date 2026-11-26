/**
 * A record that was changed on two PCs before either saw the other's change. Both versions are shown side by side,
 * only where they differ, and a person chooses which to keep. Nothing here decides for them, and nothing else on the
 * page is affected: the clash belongs to this one record.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useAppState, useStore, shownDate, fmtDateTime } from './hooks';
import { type Conflict, type State, conflictLabel, versionsWord } from '../app/state';
import { ResolveConflict } from '../app/commands/conflicts';
import { GROUP_LABEL } from '../app/commands/deals';
import { withoutMarkers } from '../domain/cite';
import type { Deal, Finding, Question, Source } from '../domain/model';
import { compareChecklistVersion, comparedFields } from '../app/conflictView';
import type { ListRecord } from '../domain/checklist';
import { AI_LABEL } from '../control';
import { Icon } from './icons';
import { Stepper } from './choiceCards';
import { titleStyle } from './titleStyle';
import { twoVersionsQueue } from '../app/qaView';
import { openConflict } from './twoVersions';

type Fmt = (value: any, record: any, s: State) => string;
const text: Fmt = (v) => String(v ?? '');
const day: Fmt = (v) => (v ? shownDate(v) : '');
const sources = (list: Source[] | undefined) => (list ?? []).map((x) => x.doc + (x.loc ? ` · ${x.loc}` : '')).join('\n');

/** Every field a record has, in the order a person would look for a difference, with how each reads. */
const FIELDS: Record<Conflict['kind'], [string, string, Fmt][]> = {
  question: [
    ['text', 'Question', text],
    ['response', 'Response', text],
    ['status', 'Status', (v) => ({ open: 'Open', answered: 'Answered', closed: 'Closed' } as Record<string, string>)[v] ?? ''],
    ['workstream', 'Workstream', text],
    ['priority', 'Priority', text],
    ['askedBy', 'Submitted By', text],
    ['received', 'Received', day],
    ['respondedBy', 'Responded By', text],
    ['responded', 'Date', day],
    ['provenance', 'Response Origin', (v: Question['provenance']) =>
      (!v ? '' : v.origin === 'ai' ? `${AI_LABEL} draft, accepted by ${v.actor}` : v.origin === 'chat'
      ? 'From a conversation' : `Typed by ${v.actor}`)],
    ['draft', 'Draft', (v: Question['draft']) => (!v ? '' : v.status === 'found' ? v.text : v.status === 'pending' ? 'Drafting' : v.status === 'none' ? 'Not found' : 'Failed')],
    ['linkedFinding', 'Linked Finding', (v, _r, s) => (v ? s.findings[v]?.title ?? 'A finding' : '')],
    ['n', 'Number', (v) => (v ? `Q${v}` : '')],
  ],
  finding: [
    ['title', 'Title', text],
    ['body', 'Detail', (v: string[], r: Finding) => (v ?? []).map((b) => withoutMarkers(b, r.sources?.length ?? 0)).join('\n\n')],
    ['status', 'Status', (v) => (v === 'open' ? 'Open' : v === 'closed' ? 'Closed' : '')],
    ['workstream', 'Workstream', text],
    ['note', 'Note', text],
    ['reviewed', 'Review', (v: Finding['reviewed']) => (v ? `Reviewed by ${v.by}` : 'Not reviewed')],
    ['sources', 'Sources', (v: Source[]) => sources(v)],
    ['updated', 'New material since the last assessment', (v) => (v ? 'Yes' : 'No')],
    ['origin', 'Raised by', (v, r: Finding) => (v === 'ai' ? AI_LABEL : r.raisedBy ?? (v === 'chat' ? 'From a conversation' : 'A person'))],
  ],
  item: [
    ['off', 'On this deal', (v) => (v ? 'Turned off' : 'On')],
    ['text', 'Item', text],
  ],
  firmList: [
    ['items', 'Items', checklistVersionWords],
    ['file', 'File', text],
  ],
  deal: [
    ['name', 'Name', text],
    ['group', 'Deal status', (v: Deal['group']) => GROUP_LABEL[v] ?? ''],
    ['counterparty', 'Counterparty', text],
    ['product', 'Structure', text],
    ['sector', 'Sector', text],
    ['technology', 'Technology', text],
    ['folders', 'Folders', (v: Deal['folders']) => (v ?? []).map((f) => (f.label ? `${f.label} · ${f.path}` : f.path)).join('\n')],
    ['removed', 'Removed folders', (v: Deal['removed']) => (v ?? []).map((f) => (f.label ? `${f.label} · ${f.path}` : f.path)).join('\n')],
    ['target', 'Target', text],
    ['side', 'Side', text],
    ['milestone', 'Milestone', text],
    ['stage', 'Indexing', (v) => (v === 'indexing' ? 'Under way' : 'Finished')],
    ['log', 'Activity', (v: string[]) => (v ?? []).join('\n')],
  ],
};

function checklistVersionWords(items: ListRecord['items'], record: ListRecord, state: State) {
  const { count, compared, same, only, lacks } = compareChecklistVersion(state, record, items);
  const head = count.toLocaleString('en-US');
  if (!compared) return head;
  if (same) return `${head}\nThe same items, ordered or grouped differently`;
  return [head, ...versionItemWords('only in this version', only), ...versionItemWords('not in this version', lacks)]
    .join('\n');
}

function versionItemWords(label: string, items: ReturnType<typeof compareChecklistVersion>['only']) {
  if (!items.count) return [];
  return [
    `${items.count.toLocaleString('en-US')} ${label}:`,
    ...items.names.map((text) => `· ${text}`),
    ...(items.more ? [`and ${items.more.toLocaleString('en-US')} more`] : []),
  ];
}

/** the record's own title, as its page shows it: a question's text, a finding's title, an item's words */
function conflictTitle(s: State, c: Conflict): string {
  const data = (c.versions.find((v) => v.data)?.data ?? null) as { title?: string; text?: string } | null;
  if (c.kind === 'finding') return s.findings[c.id]?.title ?? data?.title ?? '';
  if (c.kind === 'question') return s.questions[c.id]?.text ?? data?.text ?? '';
  if (c.kind === 'item') return s.items[c.id]?.text ?? data?.text ?? '';
  return conflictLabel(s, c);
}

/** what happened, in a sentence: the "Two Versions" line's tooltip (no helper text on screen) */
function whatHappened(s: State, c: Conflict): string {
  const label = conflictLabel(s, c);
  const n = c.versions.length;
  const deletedOn = c.versions.filter((v) => v.deleted).map((v) => v.from).join(' and ');
  if (!deletedOn) return `${label} was changed in ${n === 2 ? 'two' : n} places at once. Choose the version to keep.`;
  const changedOn = c.versions.filter((v) => !v.deleted).map((v) => v.from).join(' and ');
  return `${label} was deleted on ${deletedOn} while it was being changed on ${changedOn}.`;
}

/**
 * Design B: the record's title in its page's title style (`.qtxt`, as the finding page draws it), and
 * "Two Versions" under it with what happened as its tooltip; `tail` (a panel's close) ends the title's row
 */
function ConflictHeading({ conflict: c, tail, label }: {
  conflict: Conflict; tail?: ComponentChildren; label?: string;
}) {
  const s = useAppState();
  const ownPage = c.kind === 'question' || c.kind === 'finding';
  return (
    <>
      <div class="cfl-top">
        <div class="cfl-head">
          {/* a question's number over its title, set as the Resolve dialog's (.rsv-k) */}
          {label && <div class="rsv-k">{label}</div>}
          <p class="qtxt cfl-title" role="heading" aria-level={ownPage ? 1 : 2} dir="auto">{conflictTitle(s, c)}</p>
        </div>
        {tail}
      </div>
      <p class="cfl-sub" title={whatHappened(s, c)}>{titleStyle(versionsWord(c.versions.length))}</p>
    </>
  );
}

/** the main button names the choice once one is picked (decisions.md: two versions of a record) */
const keepLabel = (picked: Conflict['versions'][number] | undefined) => {
  if (!picked) return 'Keep';
  if (picked.deleted) return 'Keep It Deleted';
  return `Keep ${picked.here ? 'This PC’s' : `${picked.from}’s`} Version`;
};

/** "1 of 104", Previous and Next through the records of its kind on the deal in two versions, when it is among them */
function ConflictStepper({ conflict: c }: { conflict: Conflict }) {
  const store = useStore();
  const s = useAppState();
  const queue = twoVersionsQueue(s, c);
  const at = queue.findIndex((x) => x.id === c.id);
  if (at < 0) return null;
  const word = c.kind;   // 'question' or 'finding': the queue holds only this one's kind
  return <Stepper prefix="cfl" at={at} total={queue.length} onStep={(by) => openConflict(store, queue[at + by])}
    prevLabel={`Previous ${word} with two versions`} nextLabel={`Next ${word} with two versions`} />;
}

/**
 * `tail` (the panel's own close button) joins the title's row, so a panel that shows only this needs no header row.
 * `stepper` only where stepping stays on the page: the Q&A panel and a finding's page (a question's Discuss page and
 * the side pane show none, as stepping would leave them). `label` heads the title (the Q&A panel's "Q1").
 */
export function ConflictView({ conflict: c, tail, stepper, label }: {
  conflict: Conflict; tail?: ComponentChildren; stepper?: boolean; label?: string;
}) {
  const store = useStore(); const s = useAppState();
  const [busy, setBusy] = useState(false);
  const fields = FIELDS[c.kind];
  // the app picks which fields are compared (for a question with a delete: its text and response)
  const compared = comparedFields(c, fields.map(([k]) => k));
  const shown = fields.filter(([k]) => compared.shown.includes(k));
  const [picked, setPicked] = useState<string | null>(null);   // design B: nothing is picked until a person picks
  const pv = c.versions.find((v) => v.id === picked);
  const others = c.versions.filter((v) => v.id !== picked).map((v) => `${v.here ? 'This PC' : v.from}’s version`).join(' and ');
  const keep = async (id: string) => {
    if (busy) return;
    setBusy(true);
    const input = { dealId: c.dealId, recordId: c.id, keep: id };
    await store.dispatch(ResolveConflict, input, { idempotencyKey: 'resolve-' + c.id });
    setBusy(false);
  };
  const toDeleted = c.kind === 'question' || c.kind === 'finding';
  const tip = !pv ? 'Pick a version' : toDeleted ? `${others} goes to Deleted` : undefined;
  const st = compared.statusOnLine ? fields.find(([k]) => k === 'status') : undefined;
  const stOf = (v: (typeof c.versions)[number]) => (st && v.data ? st[2]((v.data as any)[st[0]], v.data, s) : '');
  // every version's fields sit on the same rows, so a difference is read straight across
  const rows = 1 + Math.max(1, shown.length);
  return (
    <div class="cfl" id="conflict" data-record={c.id} aria-busy={busy}>
      <ConflictHeading conflict={c} tail={tail} label={label} />
      <div class="cfl-vs" role="radiogroup" aria-label="Versions">
        {c.versions.map((v) => (
          <section class={`cfl-v pick ${picked === v.id ? 'on' : ''}`} key={v.id} data-version={v.id} role="radio" aria-checked={picked === v.id} tabIndex={0} aria-label={`Version from ${v.from}`} style={{ gridRow: `span ${rows}` }} onClick={() => setPicked(v.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(v.id); } }}>
            <div class="cfl-who"><b>{v.from}{v.here && v.from.toLowerCase() !== 'this pc' ? ' (this PC)' : ''}{v.deleted && <span class="cfl-tag">Deleted</span>}</b><span>{v.by} · {fmtDateTime(v.at)}{stOf(v) ? ` · ${stOf(v)}` : ''}</span></div>{picked === v.id && <span class="cfl-chk" aria-hidden="true"><Icon name="check" size={14} sw={2.25} /></span>}
            {v.deleted && !v.data ? <p class="cfl-val" style={{ gridRow: `span ${rows - 1}` }}>Deleted.</p>
              : !v.data ? <p class="cfl-val" style={{ gridRow: `span ${rows - 1}` }}>This version can’t be read.</p>
              : shown.length ? shown.map(([k, label, fmt]) => { const val = fmt((v.data as any)[k], v.data, s); return (
                <div class="cfl-f" key={k} data-field={k}><div class="lbl">{label}</div><div class={`cfl-val ${val ? '' : 'none'}`}>{val.includes('\n· ') ? val.split('\n').map((line, i) => <div key={i} class={line.startsWith('· ') ? 'bl' : undefined}>{line}</div>) : val || (k === 'response' ? 'No response' : 'Empty')}</div></div>); })
              : <p class="cfl-val">This version reads the same as the other.</p>}
          </section>))}
      </div>
      {/* the stepper and Keep share one row under the versions (design B) */}
      <div class="cfl-foot">
        {stepper && <ConflictStepper conflict={c} />}
        <span class="grow" />
        <button type="button" class="btn sm pri cfl-keep" disabled={!pv || busy} title={tip}
          onClick={() => pv && void keep(pv.id)}>{keepLabel(pv)}</button>
      </div>
    </div>
  );
}
