/**
 * "Add all unresolved to Q&A" (linking design, section 13; mock-up link-ck-add). The checklist is read again, the fast
 * model phrases one question for each gap and open finding not asked about yet, in parts sized to what the service lets
 * it reply, and the preview lists them checked; open questions that may already ask one of them follow, unchecked, to be linked instead (a point is asked anew or
 * linked, never both). Nothing is written until Add, which reads the checklist again first and is one change with one Undo.
 * Points that still got no question after the backend's retries are counted at the footer's left, beside the count, "3 points
 * could not be drafted", with Retry for just those; when no point got one, nothing is offered and the footer says why.
 */
import { useEffect, useState } from 'preact/hooks';
import { SERVICE } from '../control';
import { useStore } from './hooks';
import { Icon } from './icons';
import { Modal } from './dialogs';
import { unresolvedPoints, type Unresolved } from '../app/state';
import { AddUnresolved } from '../app/commands/addUnresolved';
import type { Question } from '../domain/model';
import { ok, type Result } from '../domain/result';
import type { AiService } from '../ports';

const plural = (n: number) => `${n.toLocaleString('en-US')} question${n === 1 ? '' : 's'}`;
const unread = 'Couldn’t load the checklist';
const choices = new Map<string, { off: Set<string>; linked: Set<string> }>();
/**
 * One phrasing per deal at a time, and no point phrased twice: closing the dialog while the model is phrasing does not stop
 * it, so opening it again waits for that run, then asks only for the points no run has phrased yet (gaps change while a deal
 * is checked). What was phrased is kept for the session; a point that got no question is not, so opening again asks for it
 * again. A run that fails keeps nothing here, but the backend keeps what it phrased, so Retry pays only for the rest.
 */
type Item = { kind: 'gap' | 'finding'; what: string; need: string };
const phrased = new Map<string, Map<string, string>>(); const inFlight = new Map<string, Promise<unknown>>();
async function phraseOnce(phrase: NonNullable<AiService['phrase']>, dealId: string, items: Item[]): Promise<Result<(string | null)[]>> {
  for (let run = inFlight.get(dealId); run; run = inFlight.get(dealId)) await run.catch(() => {});   // nothing awaits between this and the set below
  const done = phrased.get(dealId) ?? new Map<string, string>(); phrased.set(dealId, done);
  const key = (x: Item) => JSON.stringify([x.kind, x.what, x.need]);
  const missing = items.filter((x) => !done.has(key(x)));
  if (missing.length) {
    const run = phrase({ dealId, items: missing }); inFlight.set(dealId, run);
    let r: Result<(string | null)[]>; try { r = await run; } finally { if (inFlight.get(dealId) === run) inFlight.delete(dealId); }
    if (!r.ok || r.value.length !== missing.length) return r;   // the dialog says it was cut off or failed
    for (const [n, x] of missing.entries()) { const t = r.value[n]; if (t !== null) done.set(key(x), t); }
  }
  return ok(items.map((x) => done.get(key(x)) ?? null));
}
type Ready = { points: (Unresolved & { text: string })[]; links: { point: Unresolved; q: Question }[]; out: Unresolved[] };

export function AddUnresolvedDialog({ dealId }: { dealId: string }) {
  const store = useStore();
  const [ready, setReady] = useState<Ready | null>(null); const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [tries, setTries] = useState(0); const [redo, setRedo] = useState(false);
  // what the person unchecked or chose to link is kept per deal, so a stray click outside loses none of it (lost work first)
  const kept0 = choices.get(dealId);
  const [off, setOffNow] = useState<Set<string>>(kept0?.off ?? new Set()); const [linked, setLinkedNow] = useState<Set<string>>(kept0?.linked ?? new Set());
  const setOff = (o: Set<string>) => { setOffNow(o); choices.set(dealId, { off: o, linked: choices.get(dealId)?.linked ?? linked }); };
  const setLinked = (n: Set<string>) => { setLinkedNow(n); choices.set(dealId, { off: choices.get(dealId)?.off ?? off, linked: n }); };
  useEffect(() => {
    let live = true; setError(''); setReady(null);
    void (async () => {
      await store.refreshChecklist(dealId); if (!live) return;
      // a checklist that could not be read offers nothing, rather than an empty list that says every gap has a question
      if (!Array.isArray(store.get().checklists[dealId])) { setError(unread); return; }
      const { points, links } = unresolvedPoints(store.get(), dealId); setCount(points.length);
      if (!points.length) { setReady({ points: [], links: [], out: [] }); return; }
      const ai = store.services.ai; if (!ai.phrase) { setError('Questions can’t be phrased here'); return; }
      const r = await phraseOnce(ai.phrase.bind(ai), dealId, points.map((p) => ({ kind: p.kind, what: p.what, need: p.need }))); if (!live) return;
      if (!r.ok || r.value.length !== points.length) { setError(r.ok ? `${SERVICE}’s reply was cut off, so nothing was added` : r.error.message); return; }
      const byKey = new Map(points.map((p) => [p.key, p]));
      // a point the model gave no question is counted in the line at the foot; an open question may still be linked to it
      const text = new Map(points.map((p, i) => [p.key, r.value[i]]));
      setReady({ points: points.flatMap((p) => { const t = text.get(p.key); return t ? [{ ...p, text: t }] : []; }), links: links.map((l) => ({ point: byKey.get(l.point)!, q: l.q })), out: points.filter((p) => !text.get(p.key)) });
    })();
    return () => { live = false; };
  }, [dealId, tries]);
  const shut = () => { if (!busy) store.ui({ dialog: null }); };
  // Retry on the line at the foot asks for just the points with no question; what comes back joins the list, in checklist
  // order, and the check marks already made stay
  const retryOut = async () => {
    const ai = store.services.ai; if (!ready || redo || busy || !ai.phrase) return; setRedo(true);
    const r = await phraseOnce(ai.phrase.bind(ai), dealId, ready.out.map((p) => ({ kind: p.kind, what: p.what, need: p.need }))); setRedo(false);
    // a Retry that brings nothing leaves the count as it was: the questions listed can still be added
    if (!r.ok || r.value.length !== ready.out.length) return;
    // Add stays usable meanwhile, so the list is taken as it stands when the Retry comes back, not as it was when asked
    const text = new Map(ready.out.map((p, i) => [p.key, r.value[i]])); const order = new Map(unresolvedPoints(store.get(), dealId).points.map((p, i) => [p.key, i]));
    setReady((cur) => {
      if (!cur) return cur; const back = cur.out.filter((p) => text.get(p.key));
      const points = [...cur.points, ...back.map((p) => ({ ...p, text: text.get(p.key)! }))].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
      return { ...cur, points, out: cur.out.filter((p) => !text.get(p.key)) };
    });
  };
  const kept = ready ? ready.points.filter((p) => !off.has(p.key)) : []; const links = ready ? ready.links.filter((l) => linked.has(l.q.id)) : [];
  // checking a link sets aside the new question for the same point, so it is not asked twice; it can be checked again
  const checkLink = (l: Ready['links'][number], on: boolean) => { const n = new Set(linked); const o = new Set(off); if (on) { n.add(l.q.id); o.add(l.point.key); } else n.delete(l.q.id); setLinked(n); setOff(o); };
  // and checking the new question again unchecks its link: a point is either asked anew or linked, never both
  const checkPoint = (key: string, on: boolean) => { const o = new Set(off); const n = new Set(linked); if (on) { o.delete(key); for (const l of ready?.links ?? []) if (l.point.key === key) n.delete(l.q.id); } else o.add(key); setOff(o); setLinked(n); };
  const target = (p: Unresolved) => (p.kind === 'finding' ? { linkedFinding: p.findingId } : { linkedItem: p.itemId });
  const run = async () => {
    if (busy || !ready || (!kept.length && !links.length)) return; setBusy(true); setError('');
    // the checklist is read again just before writing (section 13): a point settled or asked about since is taken out of the
    // list, and nothing is written until the person has seen the list as it now stands and pressed again
    await store.refreshChecklist(dealId);
    if (!Array.isArray(store.get().checklists[dealId])) { setBusy(false); setError(`${unread}, so nothing was added`); return; }   // the list stays as it was, to add once it can be read
    const now = new Set(unresolvedPoints(store.get(), dealId).points.map((p) => p.key));
    const gone = [...kept.map((p) => p.key), ...links.map((l) => l.point.key)].filter((k) => !now.has(k)).length;
    // the list as it then stands is narrowed: a Retry may have come back while the checklist was read
    if (gone) { setReady((cur) => cur && { points: cur.points.filter((p) => now.has(p.key)), links: cur.links.filter((l) => now.has(l.point.key)), out: cur.out.filter((p) => now.has(p.key)) }); setBusy(false); setError(`${plural(gone)} changed since, so nothing was added`); return; }
    const r = await store.dispatch(AddUnresolved, { dealId, add: kept.map((p) => ({ text: p.text, workstream: p.workstream, ...target(p) })), link: links.map((l) => ({ questionId: l.q.id, ...target(l.point) })) }, { idempotencyKey: 'add-unresolved-' + dealId, quiet: false });
    setBusy(false); if (r.ok) { choices.delete(dealId); store.ui({ dialog: null }); } else setError(r.error.message);
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
