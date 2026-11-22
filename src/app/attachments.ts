/**
 * Attach: index a file into a deal and offer it with the next message of the
 * conversation it was added in. Each attachment is bound to that conversation at
 * the moment it was added; nothing here reads the current route.
 *
 * Attaching changes no record. On a finding, the file joins the finding's sources
 * only when the person says so (addToSources).
 */
import type { Store } from './store';
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
