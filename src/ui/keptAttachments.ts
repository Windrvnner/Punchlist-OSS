/**
 * Files attached in a composer and not yet sent come back after a restart with the text kept beside them (#60).
 * Only attachments that finished are kept: their file is already saved where the deal's documents are, so the kept
 * record (its name, conversation and document id) is all a restored chip needs.
 */
import type { Attachment } from '../app/state';
import type { Store } from '../app/store';
import { hasTexts, keptDrafts } from './keptDrafts';

type Kept = Required<Pick<Attachment, 'id' | 'name' | 'dealId' | 'conv' | 'doc' | 'docId'>> & { findingId?: string };
const hasFields = hasTexts('id', 'name', 'dealId', 'conv', 'doc', 'docId');
const isKept = (value: unknown): value is Kept =>
  hasFields(value) && ['string', 'undefined'].includes(typeof (value as { findingId?: unknown }).findingId);
/** by attachment id */
const kept = keptDrafts('composer-files', isKept);

/** what is kept of a finished attachment; null for one still uploading */
function keptOf({ id, name, dealId, findingId, conv, state, doc, docId }: Attachment): Kept | null {
  if (state !== 'done' || !doc || !docId) return null;
  return { id, name, dealId, conv, doc, docId, ...(findingId ? { findingId } : {}) };
}

/** Makes the kept map hold exactly the finished attachments in `attachments`. */
function keepOnly(attachments: Attachment[]) {
  const done = new Map<string, Kept>();
  for (const attachment of attachments) {
    const record = keptOf(attachment);
    if (record) done.set(record.id, record);
  }
  for (const id of [...kept.keys()]) if (!done.has(id)) kept.delete(id);
  // one moved to its deal's recovered copy (#117) is kept as it is now
  for (const [id, record] of done) if (JSON.stringify(kept.get(id)) !== JSON.stringify(record)) kept.set(id, record);
}

/** Puts the kept attachments back, then keeps the map in step with the attachments as they change. */
export function keepAttachments(store: Pick<Store, 'get' | 'ui' | 'subscribe'>): () => void {
  const have = new Set(store.get().ui.attachments.map((a) => a.id));
  const back = [...kept.values()].filter((a) => !have.has(a.id)).map((a): Attachment => ({ ...a, state: 'done' }));
  if (back.length) store.ui((ui) => ({ attachments: [...ui.attachments, ...back] }));
  let seen: Attachment[] = [];
  const sync = () => {
    const now = store.get().ui.attachments;
    if (now === seen) return;
    seen = now;
    keepOnly(now);
  };
  sync();
  return store.subscribe(sync);
}
