// What is typed into a finding's edit and its New Finding form, kept until it is saved, and where it goes when a save
// sent from one of those forms lands (#32, #115, #771).
import { toParagraphs } from '../domain/cite';
import type { Finding } from '../domain/model';
import type { Failure, Result } from '../domain/result';
import { CreateFinding, EditFinding, trimmedFindingTitle } from './commands/findings';
import { hasTexts, keptDrafts } from './keptText';
import { createdRecord } from './createdRecord';
import type { Store } from './store';

/** An open edit of a finding: what is typed, and the finding as the edit began (`base`). */
export type EditDraft = {
  title: string;
  ws: string;
  body: string;
  base: { title: string; workstream: string; body: string[] };
};
const isEditDraft = (v: unknown): v is EditDraft => hasTexts('title', 'ws', 'body')(v)
  && hasTexts('title', 'workstream')((v as EditDraft).base)
  && Array.isArray((v as EditDraft).base.body)
  && (v as EditDraft).base.body.every((x) => typeof x === 'string');
/** open edits by finding id, kept across a restart too */
export const editDrafts = keptDrafts('finding-edit', isEditDraft);

/** a form's three fields, as typed */
export type Typed = { title: string; ws: string; body: string };
/** Whether a form still holds exactly what a save sent: then the save lands it and the form closes (#32, #115). */
const sameAsSent = (d: Typed, sent: Typed) =>
  d.title === sent.title && d.ws === sent.ws && d.body === sent.body;

/** Each edit's save still out, by finding: what it sent, with the base it was measured from. An edit opened after
 *  Cancel, before that save lands, starts from it, so it is measured from it as the finding will be; with nothing
 *  typed in it, it closes when the save lands, as the finding then holds what it showed (#771). */
const editsOut = new Map<string, EditDraft>();
export const editBeingSaved = (findingId: string) => editsOut.get(findingId);

export async function saveFindingEdit(
  store: Store, { dealId, id }: Pick<Finding, 'dealId' | 'id'>, sent: EditDraft, cancelled: () => boolean,
): Promise<string | null> {
  const edit = { dealId, findingId: id, ...sentAsFinding(sent), base: sent.base };
  editsOut.set(id, sent);
  const result = await store.dispatch(EditFinding, edit, { idempotencyKey: 'f-edit-' + id })
    .finally(() => editsOut.delete(id));
  return landEdit(id, sent, result, cancelled());
}

export async function saveNewFinding(
  store: Store, dealId: string, sent: Typed, cancelled: () => boolean,
): Promise<Finding | null | undefined> {
  const input = { dealId, ...sentAsFinding(sent), origin: 'human' as const };
  const result = await store.dispatch(CreateFinding, input, { idempotencyKey: 'f-create-' + dealId });
  if (!result.ok || cancelled()) return undefined;
  return landCreated(dealId, sent, createdRecord(store.get(), result.value.opId, 'findings'));
}

/**
 * #32 and #771: an edit's save has landed. The kept draft, which an edit closed and opened again meanwhile shares, is
 * settled once: still what was sent, it is let go; more typed since stays, now measured from what that save sent (each
 * field as stored), so the next Save writes only what changed since, and a change made elsewhere meanwhile is still
 * kept or asked about. A refusal keeps the draft and is said, unless Cancel let it go. Returns the refusal to say.
 */
function landEdit(findingId: string, sent: EditDraft, r: Result<unknown>, cancelled: boolean): string | null {
  const typedNow = editDrafts.get(findingId);
  const typedSince = typedNow && !sameAsSent(typedNow, sent) ? typedNow : null;
  if (r.ok && typedSince) editDrafts.set(findingId, { ...typedSince, base: asStored(sentAsFinding(sent)) });
  else if (r.ok || cancelled) {
    if (!typedSince) editDrafts.delete(findingId);
  } else return refusalOf(r.error);
  return null;
}

/** what an edit's save sent, as the finding's fields */
const sentAsFinding = (sent: Typed): EditDraft['base'] =>
  ({ title: sent.title, workstream: sent.ws, body: toParagraphs(sent.body) });

/** why a save was refused: the field the refusal names, or its message */
const refusalOf = (error: Failure) =>
  (error.kind === 'invalid' ? Object.values(error.fields ?? {})[0] : undefined) ?? error.message;

/**
 * A new finding half written, by deal: leaving the page (another tab, another deal) or pressing Escape keeps it, and
 * the form comes back with it when the Findings page is opened again. Cancel or creating the finding clears it.
 */
export const newFindingDrafts = keptDrafts('new-finding', hasTexts('title', 'ws', 'body'));   // kept across a restart

/**
 * #115 and #771: a new finding's Create has landed. The kept form, which a form closed and opened again meanwhile
 * shares, is settled once: still what was sent, it is let go. More typed since goes to the finding made (decision:
 * typing during Create goes to the new finding), as an open edit of it measured from what was sent, and leaves the
 * form, so a second Create cannot make it twice. Unless the finding cannot be found: then the form keeps it. Returns
 * the finding the typing went to.
 */
function landCreated(dealId: string, sent: Typed, made: Finding | undefined): Finding | null {
  const typedNow = newFindingDrafts.get(dealId);
  if (!typedNow || sameAsSent(typedNow, sent)) {
    newFindingDrafts.delete(dealId);
    return null;
  }
  if (!made) return null;
  keepAsEdit(made, typedNow, sentAsFinding(sent));
  newFindingDrafts.delete(dealId);
  return made;
}

/** Text typed into a new finding since its Create was sent: an open edit of the finding made, from what was sent
 *  (#115). */
export function keepAsEdit(made: Finding, typed: Typed, sent: EditDraft['base']) {
  editDrafts.set(made.id, { ...typed, base: asStored(sent) });
}

/** What a save sent, as the finding stores it: its title trimmed, as the commands trim it, so the next Save's
 *  comparison with the finding is not thrown by a space typed at the end */
const asStored = (sent: EditDraft['base']): EditDraft['base'] =>
  ({ title: trimmedFindingTitle.parse(sent.title), workstream: sent.workstream, body: sent.body });
