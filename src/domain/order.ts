import { WORKSTREAMS } from './model';

/**
 * The order of every list a person picks from: A to Z, whoever named the entries (the app, the firm, a rename or an
 * import). Case and accents are ignored and numbers go in number order ("Phase 2" before "Phase 10"), as a person reads
 * them. Names that differ only in case or accents keep a fixed order between them, so a list never shuffles from one
 * look to the next. A "No …", "None", "Not recorded" or "Custom" option is not a name: the caller puts it after the
 * list.
 */
const collator = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });
export const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The names A to Z, each once, blanks left out (the caller adds its own "No …" option after them). */
export const alphabetical = (names: Iterable<string>): string[] => [...new Set([...names].filter((x) => x.trim()))].sort(byName);

/** The workstreams to pick from: the app's own and any other a record uses (an import can bring its own), A to Z. */
export const workstreamChoices = (used: Iterable<string> = []): string[] => alphabetical([...WORKSTREAMS, ...used]);

/** What a record with no workstream is listed under, last in every list. */
export const NO_WORKSTREAM = 'No workstream';
