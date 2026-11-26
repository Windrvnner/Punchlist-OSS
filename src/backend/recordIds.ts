/**
 * The permanent ids a model is shown for questions, findings, documents and checklist items, and the checks that
 * its reply names only ids it was shown (#1105, #1162). Matching is exact: no case folding, no trimming.
 */
import { ULID } from '../domain/model';
import type { DocRecord } from './documents';
import { readJson } from './lenient';

/** a document or checklist item id carries 24 lowercase hex digits after its prefix (docIdFor, itemId) */
const HEX24 = '[0-9a-f]{24}';

/** a permanent id as a model may write it back: `q_` or `f_` and a ULID, or `doc_` or `i_` and 24 hex digits */
const RECORD_ID = new RegExp(`\\b(?:(?:q|f)_${ULID}|(?:doc|i)_${HEX24})\\b`, 'g');

/** the permanent ids a model's text names, each once */
export const recordIdsIn = (text: string): string[] => [...new Set(text.match(RECORD_ID) ?? [])];

/** whether every permanent id in a model's text is one it was shown */
export const namesOnlyShown = (text: string, shown: readonly string[]): boolean =>
  recordIdsIn(text).every((id) => shown.includes(id));

/** the reply values, each meant to be an id, that are not exactly one of the ids shown (in order, with repeats) */
export const unknownIds = (values: readonly unknown[], shown: readonly string[]): unknown[] =>
  values.filter((value) => typeof value !== 'string' || !shown.includes(value));

/**
 * The sides of a reply's id pairs (`"<id> <id>"`, or the first id alone) that are not exactly shown: the first against
 * `firsts`, each after it against `rests`; a value that is not text is unknown whole (#1162)
 */
export const unknownInPairs = (values: readonly unknown[], firsts: readonly string[], rests: readonly string[]) =>
  values.flatMap((value) => {
    if (typeof value !== 'string') return [value];
    const [first, ...rest] = value.split(' ');
    return [...unknownIds([first], firsts), ...unknownIds(rest, rests)];
  });

/** a document a prompt shows, of one deal */
type ShownDoc = { dealId: string; rec: DocRecord };

/** how a prompt names a document: its docId, or `<deal id>/<doc id>` in a prompt that spans several deals (#1162) */
export const docHandle = (doc: ShownDoc, spansDeals: boolean): string =>
  (spansDeals ? `${doc.dealId}/${doc.rec.docId}` : doc.rec.docId);

/** the values a reply gives under "doc" or "document", at any depth: the documents its citations name */
export function citedDocs(reply: unknown): unknown[] {
  if (Array.isArray(reply)) return reply.flatMap(citedDocs);
  if (!reply || typeof reply !== 'object') return [];
  return Object.entries(reply).flatMap(([key, value]) =>
    (key === 'doc' || key === 'document' ? [value] : citedDocs(value)));
}

/** the one document these that has this whole name or path, in any case, a wrapping quote taken off (#1018) */
function byName<T extends ShownDoc>(said: string, sent: readonly T[], where: (rec: DocRecord) => string) {
  const low = said.trim().replace(/^["'`]+|["'`]+$/g, '').toLowerCase();
  const named = sent.filter((x) => x.rec.name.toLowerCase() === low || where(x.rec).toLowerCase() === low);
  return named.length === 1 ? named[0] : undefined;
}

/** which of the documents sent a citation names: by its id, exactly, in either form, or by its whole name or path */
export function sentAs<T extends ShownDoc>(doc: unknown, sent: readonly T[], where: (rec: DocRecord) => string) {
  if (typeof doc !== 'string') return undefined;
  const byId = sent.filter((x) => doc === docHandle(x, false) || doc === docHandle(x, true));
  return byId.length === 1 ? byId[0] : byName(doc, sent, where);
}

/**
 * Whether a reply cites a document it was not given: a citation must name one by the id the prompt showed it by,
 * exactly, or by its whole name or path (#1162)
 */
export function citesUnsent(reply: unknown, sent: readonly ShownDoc[], spansDeals: boolean,
  where: (rec: DocRecord) => string): boolean {
  const ids = sent.map((x) => docHandle(x, spansDeals));
  return citedDocs(reply).some((doc) =>
    typeof doc !== 'string' || (!ids.includes(doc) && !byName(doc, sent, where)));
}

/** whether every document id in a model's text is one of these it was sent */
const namesOnlySentDocs = (text: string, docIds: readonly string[]): boolean =>
  recordIdsIn(text).filter((id) => id.startsWith('doc_')).every((id) => docIds.includes(id));

/**
 * A reply its caller cannot use however it reads (retry.ts): its words name a document id it was not sent, or, with
 * `shown`, any other id but those; or a citation names a document it was not given (#1162). `keys`: the fields the
 * reply is read for.
 */
export const docsUnusable = (sent: readonly ShownDoc[], spansDeals: boolean, keys: string[],
  where: (rec: DocRecord) => string, shown?: readonly string[]) => (text: string): boolean => {
  const docIds = sent.map((x) => x.rec.docId);
  const named = shown ? namesOnlyShown(text, [...shown, ...docIds]) : namesOnlySentDocs(text, docIds);
  return !named || citesUnsent(readJson(text, keys), sent, spansDeals, where);
};
