/**
 * Resolve: a question in two versions with the Q&A log, side by side (the conflict-screen design). The
 * app's version and the log's; a person picks one (a click, or 1 and 2), or has a merged response drafted (Merge
 * Both Versions, or 3), and keeps the one selected. It steps on to the next one, with Undo, and through all of
 * them from one place. Cells other than the response (Status, Priority) are shown as fields in each version; picking a
 * version picks its fields too, and a merged response says per field which side it keeps.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, fmtDateTime } from './hooks';
import { Modal } from './dialogs';
import { Icon } from './icons';
import { ChoiceHead, Stepper } from './choiceCards';
import { titleStyle } from './titleStyle';
import { dealQuestions, qaKept, type State } from '../app/state';
import { chooseVersion, logOf, type VersionPick } from '../app/qaLog';
import { cellValue } from '../domain/logWrite';
import { IMPORT_FIELDS, type ImportField } from '../domain/importExport';
import { AI_LABEL } from '../control';
import { keptDrafts, hasTexts } from './keptDrafts';
import type { Question } from '../domain/model';

/** the cells' labels, in title style (labels are Title Case) */
const LABEL = Object.fromEntries(IMPORT_FIELDS.map(([k, label]) => [k, titleStyle(label)]));
LABEL.responded = 'Response Date';

/** the questions on the deal in two versions with the log, in number order */
export const inTwoVersions = (s: State, dealId: string) => dealQuestions(s, dealId).filter((q) => Object.keys(qaKept(s, q)).length).sort((a, b) => a.n - b.n);

/** opens Resolve at a question, or at the first one */
export const openResolve = (store: ReturnType<typeof useStore>, dealId: string, questionId?: string) => {
  const first = questionId ?? inTwoVersions(store.get(), dealId)[0]?.id; if (!first) return;
  store.ui({ selectedQuestion: first, dialog: { kind: 'resolveQa', dealId, questionId: first } });
};

/** merged responses not yet used, by question id: the text as it stands, and as the AI drafted it ('' once none was). Kept across a restart. */
const merges = keptDrafts('qa-merge', hasTexts('text', 'ai'));
/** the merged response kept for a question, when it has any text (one emptied is as good as none) */
const mergeOf = (id: string) => { const m = merges.get(id); return m?.text.trim() ? m : undefined; };
/** the questions a merged draft is being written for: one at a time each, so a second reply never lands on what a person typed into the first */
const drafting = new Set<string>();
/** told when a draft's reply comes in (the question, and the error if it failed), so whichever Resolve is open then shows it */
const landed = new Set<(id: string, error: string) => void>();
/** a merged response's Status and Priority as the person set them (the side each keeps), by question id, kept with the draft */
const sides = keptDrafts('qa-merge-sides', (v): v is Record<string, 'app' | 'log'> => !!v && typeof v === 'object' && Object.values(v).every((x) => x === 'app' || x === 'log'));

/** the merged response's heading, once picked: it is then the choice (its card is the box to edit) */
const MERGED_RADIO = { role: 'radio', 'aria-checked': true, tabIndex: 0, 'aria-label': 'Merged response' } as const;

type MergeCardProps = { drafted: string; busy: boolean; onMerge: (byKey: boolean) => void };

/** the third choice, unpicked: the offer to merge with the AI mark, or the merged response already drafted */
function MergeCard({ drafted, busy, onMerge }: MergeCardProps) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    onMerge(true);
  };
  const tip = drafted ? 'Pick the merged response (3)' : `The ${AI_LABEL} writes one response from both versions (3)`;
  return (
    <div class={`rsv-r ${drafted ? 'rsv-draft' : 'rsv-offer'}`} id="rsv-merge" role="radio" tabIndex={0}
      aria-checked={false} aria-disabled={busy} data-pick="merged" aria-keyshortcuts="3"
      aria-label={drafted ? 'Merged response' : 'Merge Both Versions'} title={tip}
      onClick={() => onMerge(false)} onKeyDown={onKey}>
      {drafted ? <div class="rsv-t" dir="auto">{drafted}</div> : <><b class="aim">{AI_LABEL}</b>Merge Both Versions</>}
    </div>
  );
}

type ResolveFootProps = {
  at: number; total: number; onStep: (by: number) => void;
  /** still to resolve on the deal, as it stands now: the position's tip */
  left: number;
  /** Draft Again, when the merged response is picked and the AI can merge */
  again: (() => void) | null; againOff: boolean;
  canKeep: boolean; picked: boolean; onKeep: () => void;
};

/** the foot: stepping beside Keep Selected, which steps on too (design B) */
function ResolveFoot({ at, total, onStep, left, again, againOff, canKeep, picked, onKeep }: ResolveFootProps) {
  return (
    <div class="xfoot">
      <Stepper prefix="rsv" at={at} total={total} onStep={onStep}
        prevLabel="Previous" nextLabel="Next" posTitle={`${left.toLocaleString('en-US')} left to resolve`} />
      <span class="grow" />
      {again && <button type="button" class="btn sm" id="rsv-again" disabled={againOff} onClick={again}>
        Draft Again</button>}
      <button type="button" class="btn sm pri" id="rsv-keep" disabled={!canKeep}
        title={picked ? undefined : 'Pick a version (1 or 2)'} onClick={onKeep}>Keep Selected</button>
    </div>
  );
}

export function ResolveDialog({ dealId, questionId }: { dealId: string; questionId: string }) {
  const store = useStore(); const s = useAppState();
  const close = () => store.ui({ dialog: null });
  // the ones to step through, as they were when Resolve opened: one resolved keeps its place, so "3 of 112" holds still
  const [queue] = useState(() => { const ids = inTwoVersions(store.get(), dealId).map((q) => q.id); return ids.includes(questionId) ? ids : [questionId, ...ids]; });
  const at = Math.max(0, queue.indexOf(questionId));
  const q = s.questions[questionId] as Question | undefined; const kept = q ? qaKept(s, q) : {};
  const log = logOf(store, dealId);
  const [pick, setPick] = useState<VersionPick | null>(null);
  const [merged, setMerged] = useState<{ text: string; busy: boolean; error: string }>({ text: '', busy: false, error: '' });
  const [fields, setFields] = useState<Record<string, 'app' | 'log'>>({});
  const [busy, setBusy] = useState(false);
  // who last changed the question in the app, from its history (the log does not say who changed a cell, so its side gives only when it was read)
  const [editor, setEditor] = useState('');
  useEffect(() => { let live = true; setEditor(''); void store.services.repo.audit(questionId).then((r) => { if (live && r.ok) setEditor(r.value.at(-1)?.actor ?? ''); }); return () => { live = false; }; }, [questionId, q?.rev]);
  // a merged response drafted or typed for a question stays with it (merges), so stepping on, Escape or closing never loses it:
  // the question opens with nothing picked (a choice is always the person's, made here and now), its merged response on
  // its card and the sides they set for it as they left them, until it is used
  const current = useRef(questionId); current.current = questionId;
  // the update whose versions are shown: a choice is made against it, and another update meanwhile clears the pick, so the person looks again
  const seen = useRef(log?.last?.at);
  useEffect(() => { if (seen.current !== log?.last?.at) { seen.current = log?.last?.at; setPick(null); } }, [log?.last?.at]);
  useEffect(() => { seen.current = logOf(store, dealId)?.last?.at; const m = mergeOf(questionId); setPick(null); setMerged({ text: m?.text ?? '', busy: drafting.has(questionId), error: '' }); setFields(sides.get(questionId) ?? {}); }, [questionId]);
  useEffect(() => { if (q && !Object.keys(kept).length) { merges.delete(q.id); sides.delete(q.id); } }, [q?.id, Object.keys(kept).length]);   // resolved elsewhere: nothing to keep it for
  // a reply that comes in while this question is shown (even one asked for before Resolve was last closed) is shown at once
  useEffect(() => {
    const on = (id: string, error: string) => { if (id === current.current) setMerged((m) => ({ text: merges.get(id)?.text ?? m.text, busy: false, error })); };
    landed.add(on); return () => { landed.delete(on); };
  }, []);
  const go = (id: string | undefined) => { if (id) store.ui({ selectedQuestion: id, dialog: { kind: 'resolveQa', dealId, questionId: id } }); };
  const still = (id: string) => { const x = store.get().questions[id]; return !!x && Object.keys(qaKept(store.get(), x)).length > 0; };
  const nextOpen = () => queue.slice(at + 1).find(still) ?? queue.slice(0, at).find(still);

  const resp = 'response' in kept; const others = (Object.keys(kept) as ImportField[]).filter((k) => k !== 'response');
  const appText = q?.response ?? ''; const logText = kept.response ?? '';

  const draft = async () => {
    if (!s.can.merge || !q) return;
    const merge = store.services.ai.merge!;
    const id = q.id;
    setPick('merged'); setMerged((m) => ({ text: m.text, busy: true, error: '' }));
    if (drafting.has(id)) return;   // already being written: its reply is the one to wait for
    drafting.add(id); const before = merges.get(id)?.text ?? '';
    const r = await merge({ dealId, question: q.text, app: appText, log: logText });
    drafting.delete(id);
    // a reply is dropped when the question was resolved meanwhile, or its merged text was changed (nothing typed is ever replaced)
    const use = r.ok && still(id) && (merges.get(id)?.text ?? '') === before;
    // a reply that comes after the person has stepped on is kept for its own question, and shown when they come back to it
    if (use) merges.set(id, { text: r.value.text, ai: r.value.text });
    for (const tell of landed) tell(id, r.ok ? '' : `No merged draft: ${r.error.message}`);
  };
  /** Merge Both Versions: the merge drafted for this question if any, else a new draft (or the one on its way) */
  const mergeIt = () => {
    if (busy || !q) return Promise.resolve();
    const m = mergeOf(q.id); if (!m || drafting.has(q.id)) return draft();
    setPick('merged'); setMerged({ text: m.text, busy: false, error: '' }); return Promise.resolve();
  };
  const mergeRef = useRef(mergeIt); mergeRef.current = mergeIt;
  const keep = async () => {
    if (!q || !pick || busy || (pick === 'merged' && (merged.busy || !merged.text.trim()))) return;
    setBusy(true); const r = await chooseVersion(store, dealId, q.id, pick, { merged: merged.text, drafted: merges.get(q.id)?.ai, fields: pick === 'merged' ? fields : {}, seen: seen.current }); setBusy(false);
    if (!r.ok) { store.toast(r.error.message); return; }
    merges.delete(q.id); sides.delete(q.id);
    const did = pick === 'log' ? 'the log’s version taken' : pick === 'merged' ? 'merged response used' : 'the app’s version kept';
    store.toast(`Q${q.n}: ${did}`, { label: 'Undo', opId: r.value.opId });
    // on to the next, with the focus on its first version, so 1, 2 and 3 go on working from the keyboard
    const next = nextOpen(); if (next) { go(next); requestAnimationFrame(() => document.querySelector<HTMLElement>('.rsvdlg [data-pick="app"]')?.focus()); } else close();
  };
  // 1 and 2 pick a version and 3 merges them, outside the merged text
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('textarea,input'); if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '1' || e.key === '2') { e.preventDefault(); setPick(e.key === '1' ? 'app' : 'log'); }
      if (e.key === '3' && document.querySelector('#rsv-merge')) { e.preventDefault(); void mergeRef.current(); }
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);
  // a merged draft that has come in is brought into view: at 1024x640 it is below the two versions
  useEffect(() => { if (pick === 'merged' && merged.text && !merged.busy) document.querySelector('.rsv-m')?.scrollIntoView({ block: 'nearest' }); }, [merged.busy]);
  // picking the merged response takes its card away: the focus it held goes to the choice's heading, so 1, 2 and Tab go on from there
  const lost = useRef(false);
  useEffect(() => { if (pick === 'merged' && (lost.current || !document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>('#rsv-mhead')?.focus(); lost.current = false; }, [pick]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.closest('.dlg')?.querySelector('.rsv-body')?.scrollTo({ top: 0 }); }, [questionId]);

  if (!q || !log?.last) return null;
  /** the arrow keys move between the three choices and pick the one moved to; the merge offer is only focused, as picking it asks the AI */
  const arrows = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; const from = (e.target as HTMLElement).closest('[role="radio"]');
    if (!step || !from || e.ctrlKey || e.metaKey || e.altKey) return;
    const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')]; const to = all[(all.indexOf(from as HTMLElement) + step + all.length) % all.length]; if (!to) return;
    e.preventDefault(); to.focus();
    const p = to.dataset.pick; if (p === 'app' || p === 'log') setPick(p); else if (p === 'merged' && mergeOf(q.id)) { lost.current = true; void mergeIt(); }
  };
  const has = !!mergeOf(q.id);   // a merged response is already drafted for this question
  const mine = merges.get(q.id)?.ai ?? '';   // as the AI drafted it: the label says when a person has changed it since
  const by = merged.busy ? 'Drafting' : !has ? '' : mine && (merges.get(q.id)?.text ?? '') !== mine ? `Drafted by ${AI_LABEL}, edited` : `Drafted by ${AI_LABEL}`;
  const side = (k: string) => fields[k] ?? (pick === 'log' ? 'log' : 'app');
  const mergedReady = pick !== 'merged' || (!merged.busy && !!merged.text.trim());
  const canKeep = !!pick && !busy && mergedReady && Object.keys(kept).length > 0;
  const againOn = pick === 'merged' && s.can.merge;
  const appWhen = [editor, fmtDateTime(q.updatedAt)].filter(Boolean).join(' · ');
  const version = (which: 'app' | 'log') => {
    const on = pick === which; const n = which === 'app' ? 1 : 2;
    return (
      <div class="rsv-c" key={which}>
        <ChoiceHead picked={on} name={which === 'app' ? 'In the App' : 'In the Q&A Log'}
          meta={which === 'app' ? appWhen : fmtDateTime(log.last!.at)}
          metaTitle={which === 'app' ? 'When the question was last changed in the app'
            : 'When the Q&A log was last read'}
        />
        <div class="rsv-r" role="radio" tabIndex={0} aria-checked={on} data-pick={which} title={`Pick this version (${n})`} aria-keyshortcuts={String(n)}
          onClick={() => setPick(which)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setPick(which); } }}>
          {resp && <div class="rsv-t" dir="auto">{which === 'app' ? appText : logText}</div>}
          {others.length > 0 && <dl class="rsv-f">{others.map((k) => <div key={k}><dt>{LABEL[k]}</dt><dd>{which === 'app' ? cellValue(q, k) || '—' : kept[k] || '—'}</dd></div>)}</dl>}
        </div>
      </div>
    );
  };
  return (
    <Modal onClose={close} label={`Q${q.n}, two versions`} blur className="sdlg rsvdlg">
      <div class="shead" ref={ref}><h2>Resolve Two Versions</h2>
        <button type="button" class="x" aria-label="Close" onClick={close}><Icon name="close" size={15} /></button></div>
      <div class="rsv-body" onScroll={(e) => e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 0)}>
        <div class="rsv-q"><div class="rsv-k">Q{q.n}</div><div class="rsv-qt" dir="auto">{q.text}</div></div>
        {Object.keys(kept).length ? <>
          {/* three choices in one group: the two versions, and under them the merged response (it is a third
              option), the same card as a version. Unpicked it offers the merge, or shows the one already drafted for this question */}
          <div role="radiogroup" aria-label="Versions" onKeyDown={arrows}>
          <div class="rsv-two">{version('app')}{version('log')}</div>
          {(pick === 'merged' || has || (resp && s.can.merge)) && <div class="rsv-m">
            {/* picked, the heading is the choice (its card is then the box to edit) */}
            <ChoiceHead id="rsv-mhead" picked={pick === 'merged'} name="Merged" meta={by}
              {...(pick === 'merged' ? MERGED_RADIO : {})} />
            {pick !== 'merged' && <MergeCard drafted={has ? merges.get(q.id)!.text : ''} busy={busy}
              onMerge={(byKey) => { lost.current = byKey; void mergeIt(); }} />}
            {pick === 'merged' && merged.error && <p class="emptyline" role="alert">{merged.error}</p>}
            {/* text already there stays in view under an error, so what Keep Selected would use is never unseen */}
            {pick === 'merged' && (!merged.error || merged.text) && <textarea class="rsv-r draftbox" id="rsv-merged" aria-label="Merged response" dir="auto" disabled={merged.busy} value={merged.text} onInput={(e) => { const text = (e.currentTarget as HTMLTextAreaElement).value; setMerged({ ...merged, text }); merges.set(q.id, { text, ai: mine }); }} />}
          </div>}
          </div>
          {pick === 'merged' && others.length > 0 && <div class="rsv-keep">{others.map((k) => <div key={k} class="rsv-kf"><span>{LABEL[k]}</span>
            <span class="seg">{(['app', 'log'] as const).map((w) => <button type="button" key={w} class={side(k) === w ? 'on' : ''} aria-pressed={side(k) === w} title={w === 'app' ? 'As in the app' : 'As in the Q&A log'} onClick={() => { const f = { ...fields, [k]: w }; setFields(f); sides.set(q.id, f); }}>{(w === 'app' ? cellValue(q, k) : kept[k]) || '—'}</button>)}</span></div>)}</div>}
        </> : <p class="emptyline" id="rsv-done">Resolved</p>}
      </div>
      <ResolveFoot at={at} total={queue.length} left={inTwoVersions(s, dealId).length}
        onStep={(by) => go(queue[at + by])} again={againOn ? () => void draft() : null} againOff={merged.busy || busy}
        canKeep={canKeep} picked={!!pick} onKeep={() => void keep()} />
    </Modal>
  );
}
