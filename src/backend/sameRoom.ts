/**
 * Is this data room one a deal already has? Asked when a new deal is created with folders, before anything is
 * indexed, so it has to be quick on a data room of tens of thousands of files and must never read them all.
 *
 *   1. A small fixed sample of the new folders' files (`SAMPLE`, spread evenly over their paths, so the same folders give
 *      the same sample) is matched against each deal's documents by name and size, loosely: names are compared without
 *      case, spacing, punctuation or a copy's "(1)", and sizes may differ by 2% (a re-export, a PDF re-saved).
 *   2. A deal that matches most of the sample (`SHARE`, and at least `LEAST` files), and most of each new folder's share of it,
 *      is confirmed by fingerprinting a few of the matched files, the smallest first (`PRINTS`): their SHA-256 against the
 *      deal's own. A deal that passes is then counted over all the new folders' files, by name and size alone, so the
 *      confirm can say how many of them match.
 *
 * Documents `SHARED_BY` or more other deals hold by content, such as a precedents folder many deals read, say nothing about which
 * deal a data room is: they are left out of both sides before the sample is taken (`sharedDocs`, `apart`). A folder shared
 * with fewer deals so far is not yet seen as shared, so each new folder must match on its own: one deal's data room plus such a
 * folder does not make another data room look like that deal.
 *
 * A similar deal name never blocks (decisions: Deal names), and this only asks: the person chooses.
 */
import type { DocRecord } from './documents';
import type { RoomMatch } from '../ports';
export type { RoomMatch };

export const SAMPLE = 200, SHARE = 0.6, LEAST = 3, PRINTS = 5;
/**
 * a document this many deals hold, not counting the deal being judged (at Create, the new deal; on Overview, the deal shown),
 * is shared (a precedents folder many deals read), not any one deal's own
 */
export const SHARED_BY = 3;
/** a folder holding less than this part of what is compared (a team's own working folder, a Q&A export) is not judged on its own */
export const FOLDER_PART = 0.25;
/** a file name as the match compares it: no folder, no case, no spacing or punctuation, no copy number such as "(1)" or " - Copy" */
export const plainName = (name: string) => name.split(/[\\/]/).pop()!.toLowerCase().replace(/\s*(\(\d+\)|-\s*copy(\s*\d+)?)(?=\.[a-z0-9]+$|$)/, '').replace(/[^a-z0-9.]+/g, '');
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.02;

/** the sample of a data room's files: `SAMPLE` at most, evenly spread over the files in path order */
export function sampleOf<T extends { rel: string }>(files: T[]): T[] {
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  if (sorted.length <= SAMPLE) return sorted;
  return Array.from({ length: SAMPLE }, (_, i) => sorted[Math.floor((i * sorted.length) / SAMPLE)]);
}

const byNameOf = (recs: DocRecord[]) => {
  const byName = new Map<string, DocRecord[]>();
  for (const r of recs) for (const n of new Set([r.name, ...(r.copies ?? []).map((c) => c.name)].map(plainName))) (byName.get(n) ?? byName.set(n, []).get(n)!).push(r);
  return byName;
};

/** the documents that `SHARED_BY` or more of the deals hold by content, one record each (the new deal is not among them) */
export function sharedDocs(deals: { recs: DocRecord[] }[]): DocRecord[] {
  const seen = new Map<string, { rec: DocRecord; n: number }>();
  for (const d of deals) for (const r of new Map(d.recs.map((x) => [x.docId, x])).values()) { const e = seen.get(r.docId); if (e) e.n++; else seen.set(r.docId, { rec: r, n: 1 }); }
  return [...seen.values()].filter((e) => e.n >= SHARED_BY).map((e) => e.rec);
}

/** the files that match none of `shared` by name and size */
export function apart<T extends { rel: string; size: number }>(files: T[], shared: DocRecord[]): T[] {
  if (!shared.length) return files;
  const byName = byNameOf(shared);
  return files.filter((f) => !byName.get(plainName(f.rel))?.some((r) => near(r.size, f.size)));
}

/** which files of the sample a deal's documents match, by name and size; each document matches one file at most */
export function matchesIn<T extends { rel: string; size: number }>(sample: T[], recs: DocRecord[]): { file: T; rec: DocRecord }[] {
  const byName = byNameOf(recs); const used = new Set<DocRecord>(); const out: { file: T; rec: DocRecord }[] = [];
  for (const file of sample) { const rec = byName.get(plainName(file.rel))?.find((r) => !used.has(r) && near(r.size, file.size)); if (rec) { used.add(rec); out.push({ file, rec }); } }
  return out;
}

const most = (matched: number, of: number) => matched >= Math.min(LEAST, of) && matched >= of * SHARE;

/**
 * A deal whose documents most of the sample matches, enough to be worth fingerprinting; the best first. When the files carry
 * the new folder they came from (`root`), most of each folder's share of the sample must match too, so a different data room
 * added with a folder one deal shares is not that deal. A folder with less than `FOLDER_PART` of the sample, or fewer than
 * `LEAST` files in it, is too small to judge on its own: a deal's data room added again with a small folder of the team's
 * own is still found.
 */
export function likely<T extends { rel: string; size: number; root?: string }>(sample: T[], deals: { dealId: string; recs: DocRecord[] }[]) {
  const roots = new Map<string, number>(); for (const f of sample) roots.set(f.root ?? '', (roots.get(f.root ?? '') ?? 0) + 1);
  const each = (matched: { file: T }[]) => [...roots].every(([root, of]) => of < LEAST || of < sample.length * FOLDER_PART || most(matched.filter((m) => (m.file.root ?? '') === root).length, of));
  return deals.map((d) => ({ dealId: d.dealId, recs: d.recs, matched: matchesIn(sample, d.recs) }))
    .filter((d) => most(d.matched.length, sample.length) && each(d.matched))
    .sort((a, b) => b.matched.length - a.matched.length);
}

/**
 * Fingerprint a few of a deal's matched files, the smallest first, and only those whose size is exactly the document's
 * (a file of another size cannot have the same contents). The deal is the same data room when at least half of them,
 * and at least one, are identical; otherwise it is left out. `hashOf` gives a file's SHA-256, or null when it cannot be read.
 */
export function confirm<T extends { rel: string; size: number }>(dealId: string, files: number, matched: { file: T; rec: DocRecord }[], hashOf: (file: T) => string | null): RoomMatch | null {
  const exact = matched.filter((m) => m.file.size === m.rec.size).sort((a, b) => a.file.size - b.file.size).slice(0, PRINTS);
  const same = exact.filter((m) => hashOf(m.file) === m.rec.hash).length;
  return same > 0 && same * 2 >= exact.length ? { dealId, files, matched: matched.length, printed: exact.length, same } : null;
}
