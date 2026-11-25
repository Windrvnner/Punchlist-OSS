import { useEffect, useState } from 'preact/hooks';
import { useAppState, useStore, fmtDateTime } from './hooks';
import { AskFirst, Modal } from './dialogs';
import { Icon } from './icons';
import { RestoreFinding } from '../app/commands/findings';
import { RestoreQuestion } from '../app/commands/questions';
import { RemoveIssuesList } from '../app/commands/issuesList';
import {
  deletedGroups, deletedIssuesLists, issuesListRemoval, visibleDeletedNotes, type DeletedRow,
} from '../app/deletedView';
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

const buttons = () => [...document.querySelectorAll<HTMLElement>('.deldlg [data-restore]')];
type RemovalConfirmation = ReturnType<typeof issuesListRemoval>;
type RemovalInput = RemovalConfirmation['input'];

/** Replace the Deleted modal with the ask, then return to the selected row (#410). */
function useListRemoval(
  lists: ReturnType<typeof deletedIssuesLists>, dealId: string, remove: (input: RemovalInput, at: number) => void,
) {
  const [request, setRequest] = useState<{ confirmation: RemovalConfirmation; key: string; at: number } | null>(null);
  const valid = request?.confirmation.input.dealId === dealId &&
    lists.some((list) => list.doc === request.confirmation.input.doc);
  const dismiss = () => {
    setRequest(null);
    requestAnimationFrame(() => buttons().find((button) => button.dataset.restore === request?.key)?.focus());
  };
  useEffect(() => {
    if (request && !valid) setRequest(null);
  }, [request, valid]);

  const askRemove = (list: (typeof lists)[number]) => {
    const key = `list:${list.doc}`;
    const at = buttons().findIndex((button) => button.dataset.restore === key);
    setRequest({ confirmation: issuesListRemoval(list, dealId), key, at });
  };
  const confirm = request && valid ? (
    <AskFirst ask={request.confirmation.ask} text={request.confirmation.text} go="Remove" onKeep={dismiss} onGo={() => {
      dismiss();
      remove(request.confirmation.input, request.at);
    }} />
  ) : null;
  return { askRemove, confirm };
}

/** Keep keyboard focus in Deleted as rows go away, or return it to the page when the last row is gone. */
function useDeletedActions(dealId: string) {
  const store = useStore();
  const close = () => store.ui({ dialog: null });
  const restore = (r: DeletedRow) => {
    const { t } = r;
    const copy = r.copy ? { copy: r.copy.ver } : {};
    return act(r.key, () => (t.of
      ? store.dispatch(RestoreVersion, { dealId, entryId: t.id }, { idempotencyKey: 'restore-' + t.id })
      : t.kind === 'finding'
        ? store.dispatch(RestoreFinding, { dealId, findingId: t.id, ...copy }, { idempotencyKey: 'restore-' + r.key })
        : store.dispatch(RestoreQuestion, { dealId, questionId: t.id, ...copy }, { idempotencyKey: 'restore-' + r.key })));
  };
  const act = async (key: string, run: () => Promise<{ ok: boolean }>, fromAsk?: number) => {
    const at = fromAsk ?? buttons().findIndex((b) => b.dataset.restore === key);
    if (!(await run()).ok) return;
    // its row has gone with the button that had the focus: the focus goes to the button that took its place, else the last one
    // (two frames: a removed list's findings are new rows, drawn a frame later)
    const current = store.get();
    if (current.ui.dialog?.kind !== 'deleted' || current.ui.dialog.dealId !== dealId) return;
    if (visibleDeletedNotes(current, dealId).length || deletedIssuesLists(current, dealId).length) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const left = buttons();
        const focus = document.activeElement;
        const defaultFocus = fromAsk !== undefined && focus?.matches('.deldlg .delscroll');
        if (at >= 0 && left.length && (!focus || focus === document.body || defaultFocus)) {
          left[Math.min(at, left.length - 1)].focus();
        }
      }));
      return;
    }
    close();
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const pageList = document.querySelector<HTMLElement>('.flags .flagrow, .md .li[tabindex="0"]');
      (pageList ?? document.getElementById('view'))?.focus({ preventScroll: true });
    });
  };
  const remove = (input: RemovalInput, at: number) =>
    void act('list:' + input.doc, () => store.dispatch(RemoveIssuesList, input), at);
  return { close, restore, remove };
}

export function DeletedDialog({ dealId }: { dealId: string }) {
  const s = useAppState();
  const groups = deletedGroups(s, dealId);
  const lists = deletedIssuesLists(s, dealId);
  const { close, restore, remove } = useDeletedActions(dealId);
  const removal = useListRemoval(lists, dealId, remove);
  const text = (row: DeletedRow) => row.t.kind === 'finding'
    ? (row.snapshot as Finding | undefined)?.title || row.t.title
    : (row.snapshot as Question | undefined)?.text || row.t.title || 'No text';
  // what tells two versions of one record apart: a question's response, a finding's detail
  const said = (row: DeletedRow) => row.t.kind === 'question'
    ? (row.snapshot as Question | undefined)?.response ?? ''
    : ((row.snapshot as Finding | undefined)?.body ?? []).join('\n\n');
  if (removal.confirm) return removal.confirm;
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
                    {l.revision ? `Revision ${l.revision} · ` : ''}
                    {`${plural(l.made.length, 'finding')} · ${l.raised.toLocaleString('en-US')} already raised`}
                  </span>
                </span>
                <button type="button" class="btn sm" data-restore={'list:' + l.doc}
                  title={`Send its ${plural(l.made.length, 'finding')} to Deleted`
                    + ' and take its marks off the findings it joined'
                    + (l.kept ? `. ${plural(l.kept, 'finding')} changed since ${l.kept === 1 ? 'stays' : 'stay'}` : '')}
                  onClick={() => removal.askRemove(l)}>Remove</button>
              </div>))}
          </div>)}
      </div>
    </Modal>
  );
}
