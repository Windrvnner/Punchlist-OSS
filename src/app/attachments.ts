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
import { hasTexts, keptDrafts } from './keptText';
import { control } from '../control';

/** how many files can go with one message: as many documents as one model call is given */
export const MAX_ATTACHED = control.limits.docsPerCall;

type AttachmentTarget = Pick<Attachment, 'dealId' | 'findingId' | 'conv'>;
const retryTargets = new WeakMap<() => void, AttachmentTarget>();

/** A failed attachment no longer has a chip to move when its deal is recovered (#745). */
function offerAttachmentRetry(store: Store, target: AttachmentTarget, file: File) {
  const run = () => void attachFiles(store, retryTargets.get(run) ?? target, [file]);
  retryTargets.set(run, target);
  const dealName = store.get().deals[target.dealId]?.name;
  const destination = dealName ? ` to ${dealName}` : '';
  store.toast(`Couldn’t attach ${file.name}${destination} ·`, { label: 'Retry', run });
}

let seq = 0;
export async function attachFiles(store: Store, ctx: AttachmentTarget, files: File[]) {
  // past the most one message can take, a file is not attached, and the person is told, rather than it being dropped when sent
  const room = Math.max(0, MAX_ATTACHED - store.get().ui.attachments.filter((a) => a.conv === ctx.conv).length);
  if (files.length > room) store.toast(`${files.length - room} not attached: ${MAX_ATTACHED} files is the most for one message`);
  for (const file of files.slice(0, room)) {
    const id = `a${Date.now().toString(36)}${seq++}`;
    store.ui((ui) => ({ attachments: [...ui.attachments, { id, name: file.name, dealId: ctx.dealId, findingId: ctx.findingId, conv: ctx.conv, state: 'pending' }] }));
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await store.services.docs.attach(ctx.dealId, { name: file.name, bytes });
      const chip = store.get().ui.attachments.find((attachment) => attachment.id === id);
      if (!chip) return; // removed while uploading
      if (!r.ok) {
        store.ui((ui) => ({ attachments: ui.attachments.filter((a) => a.id !== id) }));
        offerAttachmentRetry(store, chip, file);
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

type KeptAttachment = Required<Pick<Attachment, 'id' | 'name' | 'dealId' | 'conv' | 'doc' | 'docId'>> & {
  findingId?: string;
};
const hasFields = hasTexts('id', 'name', 'dealId', 'conv', 'doc', 'docId');
const isKept = (value: unknown): value is KeptAttachment =>
  hasFields(value) && ['string', 'undefined'].includes(typeof (value as { findingId?: unknown }).findingId);
let keptAttachments: Map<string, KeptAttachment> | undefined;

/** Only finished uploads are kept. The file itself is already saved with the deal or conversation (#60). */
function keptOf({ id, name, dealId, findingId, conv, state, doc, docId }: Attachment): KeptAttachment | null {
  if (state !== 'done' || !doc || !docId) return null;
  return { id, name, dealId, conv, doc, docId, ...(findingId ? { findingId } : {}) };
}

function keepOnly(kept: Map<string, KeptAttachment>, attachments: Attachment[]) {
  const done = new Map<string, KeptAttachment>();
  for (const attachment of attachments) {
    const record = keptOf(attachment);
    if (record) done.set(record.id, record);
  }
  for (const id of [...kept.keys()]) {
    if (!done.has(id)) kept.delete(id);
  }
  // A file moved to a deal's recovered copy keeps its current conversation and document reference (#117).
  for (const [id, record] of done) {
    if (JSON.stringify(kept.get(id)) !== JSON.stringify(record)) kept.set(id, record);
  }
}

/** Restores unsent files and keeps the saved references in step with the composer. */
export function keepAttachments(store: Pick<Store, 'get' | 'ui' | 'subscribe'>): () => void {
  const kept = keptAttachments ??= keptDrafts('composer-files', isKept);
  const have = new Set(store.get().ui.attachments.map((attachment) => attachment.id));
  const back = [...kept.values()]
    .filter((attachment) => !have.has(attachment.id))
    .map((attachment): Attachment => ({ ...attachment, state: 'done' }));
  if (back.length) store.ui((ui) => ({ attachments: [...ui.attachments, ...back] }));
  let seen: Attachment[] = [];
  const sync = () => {
    const now = store.get().ui.attachments;
    if (now === seen) return;
    seen = now;
    keepOnly(kept, now);
  };
  sync();
  return store.subscribe(sync);
}

/** each copy's deleted deal by the copy's id, while the app runs: a file attached as a copy is made is carried later */
const copiedFrom = new WeakMap<Store, Map<string, string>>();
/** the carrying under way, so a send made meanwhile waits for it rather than find its file missing */
const carrying = new WeakMap<Store, Promise<unknown>>();

/** The attachment, moved to the copy's ids when its deal was kept as a copy; else as it was. */
function movedAttachment<T extends AttachmentTarget>(attachment: T, ids: Record<string, string>): T {
  const dealId = ids[attachment.dealId];
  if (!dealId) return attachment;
  const conv = attachment.conv.split(':').map((part) => ids[part] ?? part).join(':');
  const findingId = attachment.findingId ? ids[attachment.findingId] ?? attachment.findingId : undefined;
  return { ...attachment, dealId, conv, ...(findingId ? { findingId } : {}) };
}

function moveRetryTargets(store: Store, ids: Record<string, string>) {
  for (const toast of store.get().ui.toasts) {
    const run = toast.action?.run;
    if (!run) continue;
    const target = retryTargets.get(run);
    if (target) retryTargets.set(run, movedAttachment(target, ids));
  }
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
    moveRetryTargets(store, ids);
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

export const composerChips = (state: { ui: { attachments: Attachment[] } }, key: string) =>
  state.ui.attachments.filter((chip) => chip.conv === key);

type ReadyChip = Attachment & { doc: string; docId: string };

const readyChips = (chips: Attachment[]): ReadyChip[] =>
  chips.filter((chip): chip is ReadyChip => chip.state === 'done' && !!chip.doc && !!chip.docId);

/** A conversation may hold files from different deals. Name any missing file before sending. */
async function filesOk(store: Store, chips: ReadyChip[]) {
  for (const dealId of new Set(chips.map((chip) => chip.dealId))) {
    if (!(await filesSendable(store, dealId, chips.filter((chip) => chip.dealId === dealId)))) return false;
  }
  return true;
}

const checking = new WeakMap<Store, Set<string>>();

/** While this conversation's files are being checked, a second Enter sends nothing twice. */
export async function chipsSendable(store: Store, key: string) {
  const active = checking.get(store) ?? new Set<string>();
  checking.set(store, active);
  if (active.has(key)) return false;
  active.add(key);
  try {
    const checked = new Set<string>();
    for (;;) {
      const chips = composerChips(store.get(), key);
      if (chips.some((chip) => chip.state === 'pending')) {
        store.toast('Still attaching — send when it finishes');
        return false;
      }
      // A file which finished attaching during the previous check is checked too.
      const fresh = readyChips(chips).filter((chip) => !checked.has(chip.id));
      if (!fresh.length) return true;
      if (!(await filesOk(store, fresh))) return false;
      for (const chip of fresh) checked.add(chip.id);
    }
  } finally {
    active.delete(key);
  }
}
