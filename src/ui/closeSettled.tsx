/**
 * Closing the questions the checklist has settled (decisions: "Close this question"; linking design, section 13). The app
 * never closes a question by itself: the Q&A page offers one line, which opens a preview, and a question whose item is
 * settled offers Close this question in its panel. Both are one change with Undo.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { Modal } from './dialogs';
import { settledQuestions } from '../app/state';
import { SetQuestionsStatus } from '../app/commands/questions';
import type { Question } from '../domain/model';

const unchecked = new Map<string, Set<string>>();
const plural = (n: number) => `${n.toLocaleString('en-US')} question${n === 1 ? '' : 's'}`;

/** The line above the Q&A table, while any question not closed has its item settled. */
export function SettledLine({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const n = useMemo(() => settledQuestions(s, dealId).close.length, [s.questions, s.checklists[dealId], s.findings, s.conflicts, s.dealLoad[dealId], s.items]);
  if (!n) return null;
  return <p class="loadfail qnote" id="qa-settled" role="status">{n === 1 ? 'One open question is' : `${n.toLocaleString('en-US')} open questions are`} settled on the checklist. <button type="button" class="tundo" id="qa-settled-review" onClick={() => store.ui({ dialog: { kind: 'closeSettled', dealId } })}>Review</button></p>;
}

/**
 * The preview. It reads the checklist again first, so what it offers is how the items stand now; a question that was
 * offered and no longer is, and a question in two versions, are named under Left out. Each question can be unchecked.
 */
export function CloseSettledDialog({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const [fresh, setFresh] = useState(false); const [busy, setBusy] = useState(false);
  const [offered] = useState(() => new Set(settledQuestions(store.get(), dealId).close.map((x) => x.q.id)));
  // unchecked questions are kept per deal, so a stray click outside loses none of them (lost work first)
  const [off, setOffNow] = useState<Set<string>>(unchecked.get(dealId) ?? new Set()); const setOff = (o: Set<string>) => { setOffNow(o); unchecked.set(dealId, o); };
  const [tries, setTries] = useState(0);
  useEffect(() => { let live = true; setFresh(false); void store.refreshChecklist(dealId).finally(() => { if (live) setFresh(true); }); return () => { live = false; }; }, [dealId, tries]);
  // a checklist that could not be read says so, with Retry, rather than an empty list that says nothing is settled
  const failed = fresh && !Array.isArray(s.checklists[dealId]);
  const { close, left } = useMemo(() => settledQuestions(s, dealId), [s.questions, s.checklists[dealId], s.findings, s.conflicts, s.dealLoad[dealId], s.items]);
  const now = new Set(close.map((x) => x.q.id));
  const dropped = [...offered].filter((id) => !now.has(id) && s.questions[id] && !left.some((l) => l.q.id === id)).map((id) => { const q = s.questions[id] as Question; return { q, why: q.status !== 'open' ? `${q.status.charAt(0).toUpperCase()}${q.status.slice(1)} since` : 'Its item is no longer settled' }; });
  const out = [...left, ...dropped].sort((a, b) => a.q.n - b.q.n);
  const picked = close.filter((x) => !off.has(x.q.id));
  const shut = () => { if (!busy) store.ui({ dialog: null }); };
  const [moved, setMoved] = useState(0); const [wrote, setFailed] = useState('');   // why the close was refused, said in the footer
  // the checklist is read again just before writing (section 13): if any checked question is no longer settled, nothing is
  // closed; the list now shows it under Left out, and the footer says so, for the person to look and press again
  const run = async () => {
    if (busy || !picked.length) return; setBusy(true); setMoved(0); setFailed('');
    await store.refreshChecklist(dealId);
    if (!Array.isArray(store.get().checklists[dealId])) { setBusy(false); return; }   // the list now says the checklist couldn't be read; nothing is closed
    const still = new Set(settledQuestions(store.get(), dealId).close.map((x) => x.q.id)); const gone = picked.filter((x) => !still.has(x.q.id)).length;
    if (gone) { setBusy(false); setMoved(gone); return; }
    const r = await store.dispatch(SetQuestionsStatus, { dealId, set: picked.map((x) => ({ questionId: x.q.id, status: 'closed' as const })) }, { idempotencyKey: 'close-settled-' + dealId });
    setBusy(false); if (r.ok) { unchecked.delete(dealId); store.ui({ dialog: null }); } else setFailed(r.error.message);
  };
  return (
    <Modal onClose={shut} label="Close settled questions" blur className={`sdlg xdlg lnkdlg ${!failed && (!fresh || close.length + out.length > 8) ? 'tall' : ''}`}>
      <div class="shead"><h2>Close Settled Questions</h2><button type="button" class="x" aria-label="Close"
        disabled={busy} onClick={shut}><Icon name="close" size={15} /></button></div>
      <div class="llist" id="cs-list">
        {failed ? <p class="loadfail" id="cs-failed">Couldn’t load the checklist. <button type="button" class="tundo" id="cs-retry" onClick={() => setTries(tries + 1)}>Retry</button></p>
          : !fresh ? <><div class="lgrp">To Close</div>{Array.from({ length: 6 }, (_, i) => <div class="phrow"
            key={i}><span class="bx" /><span><i /><i /></span></div>)}</>
          : <>
            {close.length > 0 && <div class="lgrp">To Close <span>{close.length.toLocaleString('en-US')}</span></div>}
            {close.map((x) => <label class="lrow" key={x.q.id}><input type="checkbox" checked={!off.has(x.q.id)} onChange={(e) => { const n = new Set(off); if ((e.currentTarget as HTMLInputElement).checked) n.delete(x.q.id); else n.add(x.q.id); setOff(n); }} /><span class="lq"><b>Q{x.q.n}</b>{x.q.text}<span class="lfor" title={`${x.item} · ${x.where}`}>{x.item} · {x.where}</span></span></label>)}
            {out.length > 0 && <div class="lgrp">Left Out <span>{out.length.toLocaleString('en-US')}</span></div>}
            {out.map((x) => <div class="lout" key={x.q.id}><b>Q{x.q.n}</b>{x.why}</div>)}
            {!close.length && !out.length && <p class="emptyline">No question is settled on the checklist now.</p>}
          </>}
      </div>
      {!failed && <div class="xfoot"><span id="cs-count" class={moved || wrote ? 'err' : ''}
        role={moved || wrote ? 'alert' : undefined}>{wrote || (moved
        ? `${plural(moved)} changed since, so nothing was closed` : fresh && !failed ? plural(picked.length)
        : '')}</span><span class="grow" /><button class="btn sm pri" type="button" id="cs-go"
        disabled={!fresh || !picked.length || busy} onClick={() => void run()}>{picked.length
        ? `Close ${plural(picked.length)}` : 'Close Questions'}</button></div>}
    </Modal>
  );
}

/**
 * Close this question, in the open question's panel beside Draft from documents, while its item is settled. What settled
 * it is the tooltip, after the button's full name (a short window shows "Close Q3"); the page number is kept with its "p."
 * so it never stands alone on a line.
 */
export function CloseThisQuestion({ q, ro }: { q: Question; ro: string | null }) {
  const store = useStore(); const s = useAppState();
  const x = settledQuestions(s, q.dealId).close.find((c) => c.q.id === q.id); if (!x) return null;
  const tip = ro ?? `Close this question · ${x.item}: ${x.where === 'finding closed' ? 'its finding was closed' : `satisfied · ${x.where.replace(/ /g, (m, i) => (i > x.where.lastIndexOf(',') ? ' ' : m))}`}`;
  // the checklist is read again first: an item another PC has since found a gap or flagged is not closed, and the button goes
  const close = async () => {
    await store.refreshChecklist(q.dealId);
    if (!Array.isArray(store.get().checklists[q.dealId])) { store.toast(`Couldn’t load the checklist, so Q${q.n} was not closed`); return; }
    if (!settledQuestions(store.get(), q.dealId).close.some((c) => c.q.id === q.id)) { store.toast(`Q${q.n}’s item is no longer settled, so it was not closed`); return; }
    await store.dispatch(SetQuestionsStatus, { dealId: q.dealId, set: [{ questionId: q.id, status: 'closed' }] }, { idempotencyKey: 'close-settled-' + q.id });
  };
  // why it is off, on a read-only deal, is on the wrapper: a disabled button takes no pointer
  return <span class="needs" id="q-close-wrap" title={ro ?? undefined}><button type="button" class="btn sm"
    id="q-close-settled" disabled={!!ro} title={tip} onClick={() => void close()}><span
    class="long">Close This Question</span><span class="short">Close Q{q.n}</span></button></span>;
}
