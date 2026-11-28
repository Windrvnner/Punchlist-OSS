import type { AgentKit, DealDoc } from './agentKit';
import type { DocRecord } from './documents';

/** the documents in one batch and the positions of its first and last requests */
export type Batch = { first: number; last: number; recs: DealDoc[] };
/** whether two documents are the same document of the same deal */
export const sameDoc = (a: { dealId: string; rec: DocRecord }, b: { dealId: string; rec: DocRecord }) =>
  a.dealId === b.dealId && a.rec.docId === b.rec.docId;

/**
 * Documents in their order cut into batches of `width` each, one call each: a blackline goes with its clean draft
 * (which may be outside the list), and a batch it would overflow ends where it is, so the next one starts with the
 * pair. Each batch keeps the places in the list of the first and last document it reads. A folder read's batches, and
 * the pages of the chat's document search (agentSearch.ts).
 */
export function batchesOf(todo: DealDoc[], cleanDrafts: AgentKit['cleanDrafts'], width: number): Batch[] {
  const batches: Batch[] = [];
  const cleansOf = new Map<string, Map<string, DocRecord>>();
  for (let i = 0; i < todo.length; i++) {
    const doc = todo[i];
    const pair = [...withCleanDraft(doc, cleanDrafts, cleansOf), doc];
    let current = batches.at(-1);
    const notIn = (batch: Batch) => pair.filter((p) => !batch.recs.some((y) => sameDoc(y, p)));
    const full = !!current && current.recs.length > 0 && current.recs.length + notIn(current).length > width;
    if (!current || full) {
      current = { first: i + 1, last: i + 1, recs: [] };
      batches.push(current);
    }
    current.recs.push(...notIn(current));
    current.last = i + 1;
  }
  return batches;
}

/** a document's clean draft, when it is a blackline that has one; each deal's pairs looked up once (`cleansOf`) */
function withCleanDraft(doc: DealDoc, cleanDrafts: AgentKit['cleanDrafts'],
  cleansOf: Map<string, Map<string, DocRecord>>): DealDoc[] {
  if (!cleanDrafts) return [];
  let cleans = cleansOf.get(doc.dealId);
  if (!cleans) {
    cleans = cleanDrafts(doc.dealId);
    cleansOf.set(doc.dealId, cleans);
  }
  const clean = cleans.get(doc.rec.docId);
  return clean ? [{ dealId: doc.dealId, rec: clean }] : [];
}

/** A chat read can send a paired blackline only when its clean draft is available (#1213). */
export function withStoredCleanDrafts(docs: DealDoc[], stored: Record<string, string>,
  pairs?: Map<string, DocRecord>): DealDoc[] {
  if (!pairs) return docs;
  return docs.filter((doc) => {
    const clean = pairs.get(doc.rec.docId);
    return !clean || !!stored[clean.docId];
  });
}
