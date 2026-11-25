/**
 * How citations are grouped, ordered and counted wherever they are shown (#950): the reading-mode document list,
 * a cited phrase's pop and a finding's list of sources, the source chips under an answer, a finding or a question,
 * and whether an attached file can be added to a finding's sources. The screens only show what these return.
 */
import { docKey, type Finding, type Source } from '../domain/model';
import type { DocRef } from './conversations';
import type { DraftRef } from '../ports';

/** Up to this many documents a pop lists them all; beyond it, with somewhere to send the rest, it lists POP_SHOWN. */
export const POP_ALL = 4;
/** How many documents a capped pop lists before "N more". */
export const POP_SHOWN = 3;

/** One document's citations: its first citation, its places joined ("p. 41, p. 44"), and each place once. */
export interface DocumentSources {
  doc: Source;
  /** the places as one line, each once, without empty places */
  places: string;
  /** every citation of the document, in order */
  items: Source[];
  /** the first citation of each place, an unplaced one included, in order */
  pages: Source[];
}

/** The first of each group of items that share a key, in order. */
function firstOfEach<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Sources by document, in the order each document is first cited, told apart by id rather than by name. */
export function byDocument(sources: Source[]): DocumentSources[] {
  const out = new Map<string, DocumentSources>();
  for (const source of sources) {
    const group = out.get(docKey(source));
    if (group) group.items.push(source);
    else out.set(docKey(source), { doc: source, places: '', items: [source], pages: [] });
  }
  for (const group of out.values()) {
    group.places = [...new Set(group.items.map((x) => x.loc).filter(Boolean))].join(', ');
    group.pages = firstOfEach(group.items, (x) => x.loc);
  }
  return [...out.values()];
}

/** Sources from no more documents than a pop shows: shown in full as chips rather than as a list. */
export const fewDocuments = (sources: Source[]) => byDocument(sources).length <= POP_ALL;

/** The documents a cited phrase's pop lists, and whether the rest are left to "N more" elsewhere. */
export function popDocuments(sources: Source[], canShowMore: boolean) {
  const docs = byDocument(sources);
  const capped = canShowMore && docs.length > POP_ALL;
  return { docs, capped, shown: capped ? docs.slice(0, POP_SHOWN) : docs, more: docs.length - POP_SHOWN };
}

/** One chip per page cited, in order: the first citation of each document and place. */
export const sourceChips = (sources: Source[]) => firstOfEach(sources, (x) => `${docKey(x)}|${x.loc}`);

/** An entry of the reading list, with its place in it; -1 for a document opened on its own. */
export interface MenuItem { x: DocRef; i: number }
/** A document in the reading-mode list: its entries in list order, and the same entries in page order. */
export interface MenuGroup { key: string; ref: DocRef; items: MenuItem[]; pages: MenuItem[] }
/** What cited the documents below a heading, and the documents. */
export interface MenuSection { key: string; title: string; groups: MenuGroup[] }

/** A place's page number, for ordering; a place with none ("cl. 7.2", "Ops!F12") goes last. */
const pageNo = (loc: string) => {
  const match = /p\.\s*(\d+)/.exec(loc);
  return match ? +match[1] : Number.MAX_SAFE_INTEGER;
};
/** What cited it, as a heading: the question that was asked, or the finding / draft / response. */
const heading = (x: DocRef) => x.ask ?? x.from.replace(/^From /, '').replace(/^./, (c) => c.toUpperCase());

function menuGroups(items: MenuItem[]): MenuGroup[] {
  const out = new Map<string, MenuGroup>();
  for (const item of items) {
    const key = docKey(item.x);
    const group = out.get(key) ?? { key, ref: item.x, items: [], pages: [] };
    out.set(key, group);
    group.items.push(item);
  }
  for (const group of out.values()) group.pages = [...group.items].sort((a, b) => pageNo(a.x.loc) - pageNo(b.x.loc));
  return [...out.values()];
}

/**
 * The reading-mode document list: grouped by what cited the documents (the question asked, or the finding, draft or
 * response), each document once with its pages, and a document opened from a follow-up answer in a group of its own.
 */
export function menuSections(docs: DocRef[], aside: DocRef | null): MenuSection[] {
  const buckets = new Map<string, { title: string; items: MenuItem[] }>();
  docs.forEach((x, i) => {
    const bucket = buckets.get(x.from) ?? { title: heading(x), items: [] };
    buckets.set(x.from, bucket);
    bucket.items.push({ x, i });
  });
  const sections = [...buckets].map(([key, b]) => ({ key, title: b.title, groups: menuGroups(b.items) }));
  if (aside) sections.push({ key: 'aside', title: heading(aside), groups: menuGroups([{ x: aside, i: -1 }]) });
  return sections;
}

/** A document's drafts as shown: none unless it has an earlier or later draft. */
export const shownDrafts = (drafts: DraftRef[] | undefined) => (drafts && drafts.length > 1 ? drafts : []);

/** The newest draft, when this document is an earlier one. */
export const newerThan = (drafts: DraftRef[], docId: string) =>
  drafts.length > 1 && drafts[0].docId !== docId && drafts.some((d) => d.docId === docId) ? drafts[0] : null;

/** Whether the document is among the finding's sources: the same document, not merely the same name. */
export const inSources = (finding: Pick<Finding, 'sources'>, docId: string) =>
  finding.sources.some((source) => docKey(source) === docId);

/**
 * Whether a file attached or sent under a finding can be added to its sources: it has finished attaching and is not
 * among them already.
 */
export function canAddToSources<F extends Pick<Finding, 'sources'>>(
  finding: F | null | undefined,
  file: { doc?: string; docId?: string; state?: 'pending' | 'done' },
): finding is F {
  if (!finding || file.state === 'pending' || !file.doc || !file.docId) return false;
  return !inSources(finding, file.docId);
}
