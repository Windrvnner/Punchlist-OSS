import { useAppState, useStore, fmtDateTime } from './hooks';
import { Modal } from './dialogs';
import { Icon } from './icons';
import { RestoreFinding } from '../app/commands/findings';
import { RestoreQuestion } from '../app/commands/questions';
import { RemoveIssuesList } from '../app/commands/issuesList';
import { deletedGroups, deletedIssuesLists, visibleDeletedNotes, type DeletedRow } from '../app/deletedView';
import { type Finding, type Question } from '../domain/model';
import { RestoreVersion } from '../app/commands/keptVersions';

/**
 * What has been deleted from a deal and can be put back. A delete still asks first: few people would think to look
 * here. Each version a choice did not keep is listed too, as an entry of its own (`keptVersions.ts`), and so is each
 * copy of a record that two PCs deleted with different words: those rows name the PC each came from, and show the
 * response (or detail) that tells them apart, whole.
 */
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
/** A group's label in title style, with how many it holds beside it in gray. */
function GroupLabel({ label, count }: { label: string; count: number }) {
  return <div class="lbl">{label}<span class="n">{count.toLocaleString('en-US')}</span></div>;
}

export function DeletedDialog({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const close = () => store.ui({ dialog: null });
  const groups = deletedGroups(s, dealId);
  const lists = deletedIssuesLists(s, dealId);
  // with the last one put back there is nothing left to show: the dialog closes, and because the button that opened it
  // has gone with the list, the focus goes to the page's list instead of to nowhere
  const buttons = () => [...document.querySelectorAll<HTMLElement>('.deldlg [data-restore]')];
  const restore = (r: DeletedRow) => {
    const { t } = r;
    const copy = r.copy ? { copy: r.copy.ver } : {};
    return act(r.key, () => (t.of
      ? store.dispatch(RestoreVersion, { dealId, entryId: t.id }, { idempotencyKey: 'restore-' + t.id })
      : t.kind === 'finding'
        ? store.dispatch(RestoreFinding, { dealId, findingId: t.id, ...copy }, { idempotencyKey: 'restore-' + r.key })
        : store.dispatch(RestoreQuestion, { dealId, questionId: t.id, ...copy }, { idempotencyKey: 'restore-' + r.key })));
  };
  // a removed list's findings join the deleted ones below, so the dialog stays open on them
  const remove = (doc: string) => act('list:' + doc, () => store.dispatch(RemoveIssuesList, { dealId, doc }));
  const act = async (key: string, run: () => Promise<{ ok: boolean }>) => {
    const at = buttons().findIndex((b) => b.dataset.restore === key);
    if (!(await run()).ok) return;
    // its row has gone with the button that had the focus: the focus goes to the button that took its place, else the last one
    // (two frames: a removed list's findings are new rows, drawn a frame later)
    const current = store.get();
    if (visibleDeletedNotes(current, dealId).length || deletedIssuesLists(current, dealId).length) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const left = buttons();
        if (at >= 0 && left.length && (!document.activeElement || document.activeElement === document.body)) {
          left[Math.min(at, left.length - 1)].focus();
        }
      }));
      return;
    }
    close();
    requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) (document.querySelector<HTMLElement>('.flags .flagrow, .md .li[tabindex="0"]') ?? document.getElementById('view'))?.focus({ preventScroll: true }); });
  };
  const text = (row: DeletedRow) => row.t.kind === 'finding'
    ? (row.snapshot as Finding | undefined)?.title || row.t.title
    : (row.snapshot as Question | undefined)?.text || row.t.title || 'No text';
  // what tells two versions of one record apart: a question's response, a finding's detail
  const said = (row: DeletedRow) => row.t.kind === 'question'
    ? (row.snapshot as Question | undefined)?.response ?? ''
    : ((row.snapshot as Finding | undefined)?.body ?? []).join('\n\n');
  return (
    <Modal onClose={close} label="Deleted" blur className="sdlg deldlg">
      <div class="shead"><h2>Deleted</h2><button type="button" class="x" aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      {/* it opens on the list, to be read before anything is put back: not on Close, and not on the first Restore */}
      <div class="delscroll" tabIndex={-1} role="group" aria-label="Deleted items" data-autofocus={groups.length ? true : undefined}>
        {!groups.length && !lists.length && <p class="emptyline" id="del-none">Nothing deleted on {s.deals[dealId]?.name ?? 'this deal'}.</p>}
        {groups.map((g) => (
          <div key={g.kind}>
            {(groups.length > 1 || lists.length > 0) && (
              <GroupLabel label={g.kind === 'finding' ? 'Findings' : 'Questions'} count={g.rows.length} />)}
            {g.rows.map((r) => { const who = r.actor.split(' · ')[0]; const q = r.t.kind === 'question' ? (r.snapshot as Question | undefined) : undefined; const words = r.from ? said(r) : null;
              return (
              <div class={`delrow ${r.from ? 'twin' : ''} ${q ? '' : 'nocode'}`} key={r.key} data-del={r.t.kind}>
                {/* a question's number sits in a column of its own, so every title starts at one edge; a cut title shows whole on hover; a version's title and words are never cut */}
                <span class="dtext">{q && <span class="dcode">Q{q.n ?? ''}</span>}<b title={text(r)}>{text(r)}</b>
                  {words !== null && <span class={`dresp ${words ? '' : 'none'}`}>{words || (q ? 'No response' : 'No detail')}</span>}
                  <span class="dmeta">{r.from ? <><span class="dpc">{r.from}</span>{` · ${r.t.edited ? 'Superseded' : 'Deleted'} by ${who} · ${fmtDateTime(r.at)}`}</> : `Deleted by ${who} · ${fmtDateTime(r.at)}`}</span></span>
                <button type="button" class="btn sm" data-restore={r.key} onClick={() => void restore(r)}>Restore</button>
              </div>); })}
          </div>))}
        {lists.length > 0 && (
          <div>
            <GroupLabel label="Issues Lists" count={lists.length} />
            {lists.map((l) => (
              <div class="delrow nocode" key={l.doc} data-del="list">
                <span class="dtext"><b title={l.list}>{l.title}</b>
                  <span class="dmeta">
                    {l.twin && l.when ? `Imported ${l.when} · ` : ''}
                    {`${plural(l.made.length, 'finding')} · ${l.raised.toLocaleString('en-US')} already raised`}
                  </span>
                </span>
                <button type="button" class="btn sm" data-restore={'list:' + l.doc} title={`Send its ${plural(l.made.length, 'finding')} to Deleted and take its marks off the findings it joined${l.kept ? `. ${plural(l.kept, 'finding')} changed since ${l.kept === 1 ? 'stays' : 'stay'}` : ''}`} onClick={() => void remove(l.doc)}>Remove</button>
              </div>))}
          </div>)}
      </div>
    </Modal>
  );
}
