/**
 * What the chat agent did to find an answer (decisions page, Conversations). While it works, a
 * "Researching" button with the time so far; answered, "Researched · N steps · N of M documents searched · time" (the
 * read count folds into this line). Either opens the full trace: each
 * step, with the passages a search found. Answered, the answer's sources sit under the button as compact one-line chips,
 * each opening its page. While it works, Stop beside the button has it answer at once from what it has
 * found so far; it reads "Stopping" until the answer comes.
 */
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './icons';
import { AI_LABEL } from '../control';
import { DocName } from './docName';
import { useDrafts, newerThan, draftDate } from './drafts';
import { docKey, type Source } from '../domain/model';
import type { Research } from '../ports';

/** a span of time as a person reads it: "38s", "2m 05s"; under a second reads as "1s" */
export const took = (ms: number) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
/** the step being taken now, in the present: "Searching documents for …", "Reviewing …", "Listing …" */
const now = (text: string) => text.replace(/^Searched /, 'Searching ').replace(/^Reviewed /, 'Reviewing ').replace(/^Listed /, 'Listing ');

/**
 * `working`: the answer is still being worked on, since `since` (an ISO time); `research` is then the steps so far, if
 * the backend has said any. Otherwise `research` is what it did, and `sources` the answer's sources.
 */
/** an earlier draft's date beside its citation, the newest named in the tooltip */
function DraftOf({ dealId, docId }: { dealId: string; docId: string }) {
  const drafts = useDrafts(dealId, docId); const newer = newerThan(drafts, docId); const me = drafts.find((d) => d.docId === docId);
  return newer && me ? <span class="dr" title={`An earlier draft; the newest is ${draftDate(newer, true)}`}>{draftDate(me)}</span> : null;
}

/** a page read from a blackline: the AI's reading of its markup, not the text itself */
const READING_TIP = `From a blackline: the ${AI_LABEL}'s reading of its markup. Check this page.`;

export function ResearchView({ research, working, since, sources = [], onOpen, dealId, onStop, waiting }: { research?: Research; working?: boolean; since?: string; sources?: Source[]; onOpen?: (s: Source) => void; dealId?: string; onStop?: () => void; /** what the answer is waiting for, said in place of "Researching" (nobody signed in) */ waiting?: string }) {
  const [open, setOpen] = useState(false); const [stopping, setStopping] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (!working) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [working]);
  const steps = research?.steps ?? [];
  const ms = working ? Date.now() - (since ? Date.parse(since) : Date.now()) : research?.ms ?? 0;
  /** the line's counts once answered: steps, documents searched and the time taken */
  const meta = `· ${steps.length} step${steps.length === 1 ? '' : 's'}${research?.read ? ` · ${research.read.docs.toLocaleString('en-US')} of ${research.read.of.toLocaleString('en-US')} document${research.read.of === 1 ? '' : 's'} searched` : ''} · ${took(ms)}`;
  return (
    <div class="rsch">
      <div class="rsch-row"><button type="button" class={`rsch-pill ${open ? 'on' : ''}`} aria-expanded={open} title={working ? undefined : `Researched ${meta}`} onClick={() => setOpen(!open)}>
        {working ? <span class="rsch-spin" aria-hidden="true" /> : <Icon name="check" size={13} />}
        {working ? waiting ?? 'Researching' : 'Researched'}
        <span class={`rsch-m ${working ? 'rsch-tm' : ''}`}>{working ? `· ${took(ms)}` : meta}</span>
        <Icon name={open ? 'chevup' : 'chev'} size={13} />
      </button>
      {working && onStop && <button type="button" class="rsch-stop" id="rsch-stop" disabled={stopping} title={stopping ? undefined : 'Answer now from what has been found so far'} onClick={() => { setStopping(true); onStop(); }}><Icon name="stop" size={13} />{stopping ? 'Stopping' : 'Stop'}</button>}</div>
      {open && <div class="rsch-trace">
        {!steps.length && <div class="rsch-step now"><i><Icon name="search" size={14} /></i><span>Starting…</span><em /></div>}
        {steps.map((st, i) => <div key={i}>
          <div class={`rsch-step ${st.done ? '' : 'now'}`}><i><Icon name={st.kind === 'read' ? 'doc' : st.kind === 'stop' ? 'stop' : 'search'} size={14} /></i><span>{st.done ? st.text : now(st.text)}</span><em>{st.done ? st.result : ''}</em></div>
          {st.done && st.found?.map((f, j) => <div class="rsch-psg" key={j}><b>{f.where}</b>{f.quote}</div>)}
        </div>)}
      </div>}
      {!working && <SourceChips sources={sources} onOpen={onOpen} dealId={dealId} />}
    </div>
  );
}

/**
 * The sources as compact one-line chips, one per page cited, in their order: under an answer, and above a finding's
 * or a question's text so every chat shows its sources the same way.
 */
export function SourceChips({ sources, onOpen, dealId }: {
  sources: Source[]; onOpen?: (s: Source) => void; dealId?: string;
}) {
  const chips = sources.filter((s, i) => sources.findIndex((x) => docKey(x) === docKey(s) && x.loc === s.loc) === i);
  if (!chips.length) return null;
  return (
    <div class="rsch-chips">
      {chips.map((s) => (
        <button type="button" class="rsch-chip" key={`${docKey(s)}|${s.loc}`} onClick={() => onOpen?.(s)}
          aria-label={`Open ${s.doc}${s.loc ? `, ${s.loc}` : ''}`}>
          <Icon name="doc" size={13} /><DocName name={s.doc} />{s.loc && <em>{s.loc}</em>}
          {s.reading && <span class="rdg" title={READING_TIP}>reading</span>}
          {s.precedent && <span class="rdg" title="Another project's document, not this deal's terms.">precedent</span>}
          {(s.dealId ?? dealId) && <DraftOf dealId={(s.dealId ?? dealId)!} docId={s.docId} />}
        </button>
      ))}
    </div>
  );
}
