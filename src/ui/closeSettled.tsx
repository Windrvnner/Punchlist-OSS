/**
 * Closing the questions the checklist has settled (decisions: "Close this question"; linking design, section 13). The app
 * never closes a question by itself: the Q&A page offers one line, which opens a preview, and a question whose item is
 * settled offers Close this question in its panel. Both are one change with Undo.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { Modal } from './dialogs';
import { closeSettledQuestions } from '../app/commands/closeSettled';
import { settledChecklistAvailable, settledPreview, settledQuestionCount, settledQuestionIds }
  from '../app/settledView';
import type { Settled } from '../app/state';
import type { Question } from '../domain/model';

const unchecked = new Map<string, Set<string>>();
const plural = (n: number) => `${n.toLocaleString('en-US')} question${n === 1 ? '' : 's'}`;

/** The line above the Q&A table, while any question not closed has its item settled. */
export function SettledLine({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const n = useMemo(() => settledQuestionCount(s, dealId),
    [s.questions, s.checklists[dealId], s.findings, s.conflicts, s.dealLoad[dealId], s.items]);
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
  const [offered] = useState(() => settledQuestionIds(store.get(), dealId));
  // unchecked questions are kept per deal, so a stray click outside loses none of them (lost work first)
  const [off, setOffNow] = useState<Set<string>>(unchecked.get(dealId) ?? new Set()); const setOff = (o: Set<string>) => { setOffNow(o); unchecked.set(dealId, o); };
  const [tries, setTries] = useState(0);
  useEffect(() => { let live = true; setFresh(false); void store.refreshChecklist(dealId).finally(() => { if (live) setFresh(true); }); return () => { live = false; }; }, [dealId, tries]);
  // a checklist that could not be read says so, with Retry, rather than an empty list that says nothing is settled
  const failed = fresh && !settledChecklistAvailable(s, dealId);
  const { close, out, pickedIds } = useMemo(() => settledPreview(s, dealId, offered, off),
    [s.questions, s.checklists[dealId], s.findings, s.conflicts, s.dealLoad[dealId], s.items, offered, off]);
  const shut = () => { if (!busy) store.ui({ dialog: null }); };
  const [moved, setMoved] = useState(0); const [wrote, setFailed] = useState('');   // why the close was refused, said in the footer
  // the checklist is read again just before writing (section 13): if any checked question is no longer settled, nothing is
  // closed; the list now shows it under Left out, and the footer says so, for the person to look and press again
  const run = async () => {
    if (busy || !pickedIds.length) return;
    setBusy(true);
    setMoved(0);
    setFailed('');
    const outcome = await closeSettledQuestions(store, dealId, pickedIds, 'close-settled-' + dealId);
    setBusy(false);
    if (outcome.kind === 'changed') setMoved(outcome.count);
    if (outcome.kind === 'failed') setFailed(outcome.message);
    if (outcome.kind === 'closed') {
      unchecked.delete(dealId);
      store.ui({ dialog: null });
    }
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
        ? `${plural(moved)} changed since, so nothing was closed` : fresh ? plural(pickedIds.length)
        : '')}</span><span class="grow" /><button class="btn sm pri" type="button" id="cs-go"
        disabled={!fresh || !pickedIds.length || busy} onClick={() => void run()}>{pickedIds.length
        ? `Close ${plural(pickedIds.length)}` : 'Close Questions'}</button></div>}
    </Modal>
  );
}

/**
 * Close this question, in the open question's panel beside Draft from documents, while its item is settled. What settled
 * it is the tooltip, after the button's full name (a short window shows "Close Q3"); the page number is kept with its "p."
 * so it never stands alone on a line.
 */
export function CloseThisQuestion({ q, ro, settled }: { q: Question; ro: string | null; settled: Settled }) {
  const store = useStore();
  const { item, where } = settled;
  const evidence = where === 'finding closed' ? 'its finding was closed'
    : `satisfied · ${where.replace(/ /g, (space, index) => (index > where.lastIndexOf(',') ? ' ' : space))}`;
  const tip = ro ?? `Close this question · ${item}: ${evidence}`;
  // the checklist is read again first: an item another PC has since found a gap or flagged is not closed, and the button goes
  const close = async () => {
    const outcome = await closeSettledQuestions(store, q.dealId, [q.id], 'close-settled-' + q.id);
    if (outcome.kind === 'checklist-unavailable') {
      store.toast(`Couldn’t load the checklist, so Q${q.n} was not closed`, 'warn');
    }
    if (outcome.kind === 'changed') store.toast(`Q${q.n}’s item is no longer settled, so it was not closed`, 'warn');
  };
  // why it is off, on a read-only deal, is on the wrapper: a disabled button takes no pointer
  return <span class="needs" id="q-close-wrap" title={ro ?? undefined}><button type="button" class="btn sm"
    id="q-close-settled" disabled={!!ro} title={tip} onClick={() => void close()}><span
    class="long">Close This Question</span><span class="short">Close Q{q.n}</span></button></span>;
}
