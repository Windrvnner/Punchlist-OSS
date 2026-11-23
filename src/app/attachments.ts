/**
 * Attach: index a file into a deal and offer it with the next message of the
 * conversation it was added in. Each attachment is bound to that conversation at
 * the moment it was added; nothing here reads the current route.
 *
 * Attaching changes no record. On a finding, the file joins the finding's sources
 * only when the person says so (addToSources).
 */
import type { Store } from './store';
import type { Attachment } from './state';
import { AttachDocumentToFinding } from './commands/findings';
import { control } from '../control';

/** how many files can go with one message: as many documents as one model call is given */
export const MAX_ATTACHED = control.limits.docsPerCall;

let seq = 0;
export async function attachFiles(store: Store, ctx: { dealId: string; findingId?: string; conv: string }, files: File[]) {
  // past the most one message can take, a file is not attached, and the person is told, rather than it being dropped when sent
  const room = Math.max(0, MAX_ATTACHED - store.get().ui.attachments.filter((a) => a.conv === ctx.conv).length);
  if (files.length > room) store.toast(`${files.length - room} not attached: ${MAX_ATTACHED} files is the most for one message`);
  for (const file of files.slice(0, room)) {
    const id = `a${Date.now().toString(36)}${seq++}`;
    store.ui((ui) => ({ attachments: [...ui.attachments, { id, name: file.name, dealId: ctx.dealId, findingId: ctx.findingId, conv: ctx.conv, state: 'pending' }] }));
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await store.services.docs.attach(ctx.dealId, { name: file.name, bytes });
      if (!store.get().ui.attachments.some((a) => a.id === id)) return; // removed while uploading
      if (!r.ok) {
        store.ui((ui) => ({ attachments: ui.attachments.filter((a) => a.id !== id) }));
        const dealName = store.get().deals[ctx.dealId]?.name;             // on Home the file goes in no deal
        store.toast(`Couldn’t attach ${file.name}${dealName ? ` to ${dealName}` : ''} ·`, { label: 'Retry', run: () => void attachFiles(store, ctx, [file]) });
        return;
      }
      store.ui((ui) => ({ attachments: ui.attachments.map((a) => (a.id === id ? { ...a, state: 'done' as const, doc: r.value.doc, docId: r.value.docId } : a)) }));
      store.touchCached();
    })();
  }
}
/** The person adds an attached file to a finding's sources. */
export const addToSources = (store: Store, dealId: string, findingId: string, file: { doc: string; docId: string }) =>
  store.dispatch(AttachDocumentToFinding, { dealId, findingId, doc: file.doc, docId: file.docId }, { idempotencyKey: `src-${findingId}-${file.docId}` });
export const removeAttachment = (store: Store, id: string) => store.ui((ui) => ({ attachments: ui.attachments.filter((a) => a.id !== id) }));

/** each copy's deleted deal by the copy's id, while the app runs: a file attached as a copy is made is carried later */
const copiedFrom = new WeakMap<Store, Map<string, string>>();
/** the carrying under way, so a send made meanwhile waits for it rather than find its file missing */
const carrying = new WeakMap<Store, Promise<unknown>>();

/** The attachment, moved to the copy's ids when its deal was kept as a copy; else as it was. */
function movedAttachment(attachment: Attachment, ids: Record<string, string>): Attachment {
  const dealId = ids[attachment.dealId];
  if (!dealId) return attachment;
  const conv = attachment.conv.split(':').map((part) => ids[part] ?? part).join(':');
  const findingId = attachment.findingId ? ids[attachment.findingId] ?? attachment.findingId : undefined;
  return { ...attachment, dealId, conv, ...(findingId ? { findingId } : {}) };
}

/**
 * A deal deleted on another PC has been kept here as a copy (#117). Files attached and not yet sent follow their
 * conversation to the copy, as its typed text does (renameKept), and the files attached on the deal become the copy's.
 */
export function followCopies(store: Store): () => void {
  return store.onRenamed((ids) => {
    // the deal's own id among its records' (a deal's id starts d_), whether or not the copy has loaded yet
    const deals = Object.entries(ids).filter(([was, now]) => was !== now && was.startsWith('d_'));
    if (!deals.length) return;
    store.ui((ui) => ({ attachments: ui.attachments.map((attachment) => movedAttachment(attachment, ids)) }));
    const from = copiedFrom.get(store) ?? new Map<string, string>();
    copiedFrom.set(store, from);
    for (const [was, now] of deals) from.set(now, was);
    const docs = store.services.docs;
    if (!docs.carryAttached) return;
    const carried = deals.map(([was, now]) => docs.carryAttached!(was, now));
    // a carry that fails is tried again at the next send; it never stops a send by itself
    carrying.set(store, Promise.all([carrying.get(store), ...carried]).catch(() => undefined));
  });
}

/** Whether a deal has been kept here as a copy (deleted on another PC) while the app runs. */
export const dealCopied = (store: Store, dealId: string) =>
  [...(copiedFrom.get(store)?.values() ?? [])].includes(dealId);

/** Of these documents of a deal, those this PC can't send now. A file attached as a copy was made is carried first. */
async function unsendableOf(store: Store, dealId: string, docIds: string[]): Promise<string[]> {
  const docs = store.services.docs;
  if (!docs.unsendable || !docIds.length) return [];
  await carrying.get(store);
  const first = await docs.unsendable(dealId, docIds);
  // not checked (the shared folder can't be reached just now): the send goes ahead and says so itself if it fails
  if (!first.ok || !first.value.length) return [];
  const original = copiedFrom.get(store)?.get(dealId);
  if (!original || !docs.carryAttached) return first.value;
  await docs.carryAttached(original, dealId);
  const again = await docs.unsendable(dealId, first.value);
  return again.ok ? again.value : first.value;
}

/** Chips of these files show whether their file was found, so a person can see which to attach again (#671). */
function markMissing(store: Store, dealId: string, checked: string[], missing: string[]) {
  const marked = (attachment: Attachment): Attachment => {
    if (attachment.dealId !== dealId || !attachment.docId || !checked.includes(attachment.docId)) return attachment;
    const { missing: _was, ...rest } = attachment;
    return missing.includes(attachment.docId) ? { ...rest, missing: true } : rest;
  };
  store.ui((ui) => ({ attachments: ui.attachments.map(marked) }));
}

/**
 * Whether attached files can all go with a message (#671). When one can no longer be sent from this PC (its copy in
 * the shared folder was removed, or has not synced here yet), nothing is sent and a notice names it, rather than the
 * message going without it.
 */
export async function filesSendable(store: Store, dealId: string, files: { doc: string; docId: string }[]) {
  const checked = files.map((file) => file.docId);
  const missing = await unsendableOf(store, dealId, checked);
  markMissing(store, dealId, checked, missing);
  if (!missing.length) return true;
  const names = [...new Set(files.filter((file) => missing.includes(file.docId)).map((file) => file.doc))];
  // one file is named, its name giving way when the line is too short; several are counted, and named on hover
  const [only] = names;
  if (names.length === 1) {
    store.toast(`Couldn’t find ${only} — attach it again`, undefined, false, undefined, only);
  } else {
    store.toast(`Couldn’t find ${names.length} files — attach them again`, undefined, false, names.join(', '));
  }
  return false;
}
