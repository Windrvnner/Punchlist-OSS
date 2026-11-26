/**
 * The permanent ids a model is shown for questions, findings, documents and checklist items, and the checks that
 * its reply names only ids it was shown (#1105, #1162). Matching is exact: no case folding, no trimming.
 */
import { ULID } from '../domain/model';

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
