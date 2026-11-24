/**
 * "Add all unresolved to Q&A" (linking design, section 13; mock-up link-ck-add). The checklist is read again, the fast
 * model phrases one question for each gap and open finding not asked about yet, in parts sized to what the service lets
 * it reply, and the preview lists them checked; open questions that may already ask one of them follow, unchecked, to be linked instead (a point is asked anew or
 * linked, never both). Nothing is written until Add, which reads the checklist again first and is one change with one Undo.
 * Points that still got no question after the backend's retries are counted at the footer's left, beside the count, "3 points
 * could not be drafted", with Retry for just those; when no point got one, nothing is offered and the footer says why.
 */
import { useEffect, useState } from 'preact/hooks';
import { useStore } from './hooks';
import { Icon } from './icons';
import { Modal } from './dialogs';
import type { Unresolved } from '../app/state';
import {
  narrowUnresolved, prepareUnresolved, retryUnresolved, selectUnresolved, submitUnresolved,
  UNREAD_CHECKLIST as unread, type UnresolvedPreview,
} from '../app/addUnresolved';

const plural = (n: number) => `${n.toLocaleString('en-US')} question${n === 1 ? '' : 's'}`;
const choices = new Map<string, { off: Set<string>; linked: Set<string> }>();

export function AddUnresolvedDialog({ dealId }: { dealId: string }) {
  const store = useStore();
  const [ready, setReady] = useState<UnresolvedPreview | null>(null); const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [tries, setTries] = useState(0); const [redo, setRedo] = useState(false);
  // what the person unchecked or chose to link is kept per deal, so a stray click outside loses none of it (lost work first)
  const kept0 = choices.get(dealId);
  const [off, setOffNow] = useState<Set<string>>(kept0?.off ?? new Set()); const [linked, setLinkedNow] = useState<Set<string>>(kept0?.linked ?? new Set());
  const setOff = (o: Set<string>) => { setOffNow(o); choices.set(dealId, { off: o, linked: choices.get(dealId)?.linked ?? linked }); };
  const setLinked = (n: Set<string>) => { setLinkedNow(n); choices.set(dealId, { off: choices.get(dealId)?.off ?? off, linked: n }); };
  useEffect(() => {
    const wait = new AbortController();
    setError('');
    setReady(null);
    void prepareUnresolved(store, dealId, { count: setCount, signal: wait.signal }).then((result) => {
      if (!result || wait.signal.aborted) return;
      if (result.ok) setReady(result.value);
      else setError(result.error.message);
    });
    return () => wait.abort();
  }, [dealId, tries]);
  const shut = () => { if (!busy) store.ui({ dialog: null }); };
  const retryOut = async () => {
    if (!ready || redo || busy || !store.get().can.phrase) return;
    setRedo(true);
    const update = await retryUnresolved(store, dealId, ready.out);
    setRedo(false);
    if (update) setReady(update);
  };
  const selected = selectUnresolved(ready, off, linked);
  const { points: kept, links } = selected;
  // checking a link sets aside the new question for the same point, so it is not asked twice; it can be checked again
  const checkLink = (l: UnresolvedPreview['links'][number], on: boolean) => { const n = new Set(linked); const o = new Set(off); if (on) { n.add(l.q.id); o.add(l.point.key); } else n.delete(l.q.id); setLinked(n); setOff(o); };
  // and checking the new question again unchecks its link: a point is either asked anew or linked, never both
  const checkPoint = (key: string, on: boolean) => { const o = new Set(off); const n = new Set(linked); if (on) { o.delete(key); for (const l of ready?.links ?? []) if (l.point.key === key) n.delete(l.q.id); } else o.add(key); setOff(o); setLinked(n); };
  const run = async () => {
    if (busy || !ready || (!kept.length && !links.length)) return;
    setBusy(true);
    setError('');
    const result = await submitUnresolved(store, dealId, selected);
    setBusy(false);
    if (result.kind === 'added') {
      choices.delete(dealId);
      store.ui({ dialog: null });
    } else if (result.kind === 'changed') {
      setReady((current) => narrowUnresolved(current, result.keys));
      setError(`${plural(result.count)} changed since, so nothing was added`);
    } else setError(result.message);
  };
  const label = (p: Unresolved) => `${p.kind === 'finding' ? 'Finding' : 'Gap'} · ${p.what}`;
  const go = kept.length ? `Add ${plural(kept.length)}` : links.length ? `Link ${plural(links.length)}` : 'Add questions';
  return (
    <Modal onClose={shut} label="Add all unresolved to Q&A" blur className={`sdlg xdlg lnkdlg ${(!ready && !error) || (ready && ready.points.length + ready.links.length > 8) ? 'tall' : ''}`}>
      <div class="shead"><h2>Add All Unresolved to Q&amp;A</h2><button type="button" class="x" aria-label="Close"
        disabled={busy} onClick={shut}><Icon name="close" size={15} /></button></div>
      <div class="llist" id="au-list">
        {!ready && error === unread ? <p class="loadfail" id="au-failed">{unread}. <button type="button" class="tundo" id="au-retry" onClick={() => setTries(tries + 1)}>Retry</button></p>
          : !ready ? <>{!error && <div class="lgrp">New Questions{count !== null &&
            <span>{count.toLocaleString('en-US')}</span>}</div>}{!error
            && Array.from({ length: 9 }, (_, i) => <div class="phrow" key={i}><span
              class="bx" /><span><i /><i /></span></div>)}</>
          : !ready.points.length && !ready.out.length && !ready.links.length ? <p class="emptyline" id="au-none">Every gap and open finding has a question.</p>
          : <>
            {ready.points.length > 0 && <div
              class="lgrp">New Questions <span>{ready.points.length.toLocaleString('en-US')}</span></div>}
            {ready.points.map((p) => <label class="lrow" key={p.key}><input type="checkbox" checked={!off.has(p.key)} onChange={(e) => checkPoint(p.key, (e.currentTarget as HTMLInputElement).checked)} /><span class="lq">{p.text}<span class="lfor" title={label(p)}>{label(p)}</span></span></label>)}
            {ready.links.length > 0 && <><div
              class="lgrp">Already Asked? <span>{ready.links.length.toLocaleString('en-US')}</span></div>
              {ready.links.map((l) => <label class="lrow" key={l.q.id}><input type="checkbox" checked={linked.has(l.q.id)} onChange={(e) => checkLink(l, (e.currentTarget as HTMLInputElement).checked)} /><span class="lq"><b>Q{l.q.n}</b>{l.q.text}<span class="lfor" title={`Link to ${label(l.point)}`}>Link to {label(l.point)}</span></span></label>)}</>}
          </>}
      </div>
      {/* an unreadable checklist leaves only Retry, in the line above: no footer with a button that can do nothing */}
      {!(!ready && error === unread) && <div class="xfoot"><span id="au-count" class={error ? 'err' : ''} role={error ? 'alert' : undefined}>{(!ready && error === unread ? '' : error) || (!ready ? (count ? `Phrasing ${plural(count)}` : '') : [kept.length && plural(kept.length), links.length && `${links.length.toLocaleString('en-US')} linked`].filter(Boolean).join(' · '))}</span>
        {/* points with no question, beside the count, where it stays in view however long the list */}
        {ready && !error && ready.out.length > 0 && <span id="au-out">{kept.length || links.length ? '· ' : ''}{redo ? `Drafting ${ready.out.length.toLocaleString('en-US')} more…` : <>{ready.out.length.toLocaleString('en-US')} point{ready.out.length === 1 ? '' : 's'} could not be drafted. <button type="button" class="tundo" id="au-retry-out" disabled={busy} onClick={() => void retryOut()}>Retry</button></>}</span>}<span class="grow" />
        {error && !ready && error !== unread ? <button class="btn sm pri" type="button" id="au-retry" onClick={() => setTries(tries + 1)}>Retry</button>
          : <button class="btn sm pri" type="button" id="au-go" disabled={!ready || busy || (!kept.length && !links.length)} onClick={() => void run()}>{go}</button>}</div>}
    </Modal>
  );
}
