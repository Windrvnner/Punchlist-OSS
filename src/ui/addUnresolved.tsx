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
  chooseUnresolvedDraft, chooseUnresolvedLink, clearUnresolvedChoices, keepUnresolvedChoices,
  pruneUnresolvedChoices, unresolvedChoices,
} from '../app/addUnresolvedChoices';
import {
  narrowUnresolved, prepareUnresolved, retryUnresolved, selectUnresolved, submitUnresolved,
  UNREAD_CHECKLIST as unread, type UnresolvedPreview,
} from '../app/addUnresolved';

const plural = (n: number) => `${n.toLocaleString('en-US')} question${n === 1 ? '' : 's'}`;

type UnresolvedRowsProps = {
  preview: UnresolvedPreview;
  draftPoints: ReadonlySet<string>;
  linkedPoints: ReadonlySet<string>;
  checkPoint: (key: string, on: boolean) => void;
  checkLink: (link: UnresolvedPreview['links'][number], on: boolean) => void;
};
const label = (point: Unresolved) => `${point.kind === 'finding' ? 'Finding' : 'Gap'} · ${point.what}`;

function UnresolvedRows({ preview, draftPoints, linkedPoints, checkPoint, checkLink }: UnresolvedRowsProps) {
  return <>
    {preview.points.length > 0 && <div
      class="lgrp">New Questions <span>{preview.points.length.toLocaleString('en-US')}</span></div>}
    {preview.points.map((point) => <label class="lrow" key={point.key}>
      <input type="checkbox" checked={draftPoints.has(point.key)}
        onChange={(event) => checkPoint(point.key, event.currentTarget.checked)} />
      <span class="lq">{point.text}<span class="lfor" title={label(point)}>{label(point)}</span></span>
    </label>)}
    {preview.links.length > 0 && <><div
      class="lgrp">Already Asked? <span>{preview.links.length.toLocaleString('en-US')}</span></div>
      {preview.links.map((link) => <label class="lrow" key={link.q.id}>
        <input type="checkbox" checked={linkedPoints.has(link.point.key)}
          onChange={(event) => checkLink(link, event.currentTarget.checked)} />
        <span class="lq"><b>Q{link.q.n}</b>{link.q.text}
          <span class="lfor" title={`Link to ${label(link.point)}`}>Link to {label(link.point)}</span>
        </span>
      </label>)}
    </>}
  </>;
}

export function AddUnresolvedDialog({ dealId }: { dealId: string }) {
  const store = useStore();
  const [ready, setReady] = useState<UnresolvedPreview | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [tries, setTries] = useState(0); const [redo, setRedo] = useState(false);
  const [choices, setChoices] = useState(() => unresolvedChoices(store, dealId));
  const syncChoices = (preview: UnresolvedPreview) => {
    const current = unresolvedChoices(store, dealId);
    setChoices(keepUnresolvedChoices(store, dealId, pruneUnresolvedChoices(preview, current)));
  };
  useEffect(() => {
    const wait = new AbortController();
    setError('');
    setReady(null);
    const { linked } = unresolvedChoices(store, dealId);
    void prepareUnresolved(store, dealId, { count: setCount, signal: wait.signal }, linked).then((result) => {
      if (!result || wait.signal.aborted) return;
      if (result.ok) {
        setReady(result.value);
        syncChoices(result.value);
        // the rows open even when the open questions could not be checked for links; the footer says so (#1120)
        if (result.value.unlinked) setError(result.value.unlinked);
      } else setError(result.error.message);
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
  const selected = selectUnresolved(ready, choices.off, choices.linked);
  const { points: kept, links, draftPoints, linkedPoints } = selected;
  const checkLink = (link: UnresolvedPreview['links'][number], on: boolean) => {
    setChoices(keepUnresolvedChoices(store, dealId, chooseUnresolvedLink(choices, link, on)));
  };
  const checkPoint = (key: string, on: boolean) => {
    setChoices(keepUnresolvedChoices(store, dealId, chooseUnresolvedDraft(choices, key, on)));
  };
  const run = async () => {
    if (busy || !ready || (!kept.length && !links.length)) return;
    setBusy(true);
    setError('');
    const result = await submitUnresolved(store, dealId, selected);
    setBusy(false);
    if (result.kind === 'added') {
      clearUnresolvedChoices(store, dealId);
      store.ui({ dialog: null });
    } else if (result.kind === 'changed') {
      setReady((current) => narrowUnresolved(current, result));
      const remaining = narrowUnresolved(ready, result);
      if (remaining) syncChoices(remaining);
      setError(`${plural(result.count)} changed since, so nothing was added`);
    } else setError(result.message);
  };
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
          : <UnresolvedRows preview={ready} draftPoints={draftPoints} linkedPoints={linkedPoints}
              checkPoint={checkPoint} checkLink={checkLink} />}
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
