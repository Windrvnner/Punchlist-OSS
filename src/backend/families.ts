/**
 * Document families: drafts of one agreement, ordered by when they were prepared.
 *
 * A family is the same file name in sibling dated folders: folders with one parent whose names carry a date, such as
 * "Drafts/2026-03-01/SPA.docx" and "Drafts/2026-04-15/SPA.docx". It takes at least two dated folders: one dated folder
 * beside an undated one ("Lenders/Bank A" and "Lenders/2026-03 Bank B") is as likely to hold two different documents. Drafts are ordered by their folder's date, and where a
 * folder's date cannot be read, by when the app first saw each draft. The newest is read and cited first; the earlier
 * drafts are listed under it and never hidden. Byte-identical copies are already one document, so are never two drafts.
 *
 * Versions in one folder are a family too, but only by an explicit mark (v3, version 3, draft 3, rev 3, Rev A):
 * the highest mark is the newest. A number in brackets (a download copy) or a date is no mark, so a dated series
 * (monthly reports) is never taken for drafts, and a file of the same name with no mark stays apart, as it cannot be told
 * to be an earlier draft.
 *
 * Dates are read month first, as en-US writes them (03-04-2026 is March 4); a date that is valid only day first
 * (13-04-2026) is read that way. Nothing here asks a model.
 */
/** where a file a person attached in the app is kept (documents.ts): in no deal folder, under its document's id */
export const ATTACHED = '@attachments';
/** a document's path as the data room shows it: the data room's own folder name, then its path inside; an attached file by the name it was attached under */
export const roomPath = (r: { folder: string; rel: string; name?: string }) => {
  const rel = r.folder === ATTACHED && r.name ? r.rel.replace(/[^\\/]*$/, () => r.name!.replace(/[\\/]/g, '_')) : r.rel;
  return `${r.folder.split(/[\\/]/).filter(Boolean).pop() ?? ''}/${rel}`.replace(/^\//, '');
};
/** a folder of another project's documents: "Precedents", "12. Precedent documents", never "Conditions Precedent" (core documents, part 1) */
export const PRECEDENTS = /^[\d\s._)-]*precedents?(?:\s+documents?)?$/i;
/** whether a path, from the data room's own folder, runs through a precedents folder (the data room's own folder counts) */
export const inPrecedents = (path: string) => path.split(/[\\/]/).slice(0, -1).some((p) => PRECEDENTS.test(p.trim()));
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i < 0 || (w.length > 3 && !/^(january|february|march|april|may|june|july|august|september|sept|october|november|december)$/i.test(w)) ? 0 : i + 1; };
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const year = (y: string) => (y.length === 2 ? 2000 + +y : +y);
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The date in a folder's name, as YYYY-MM-DD (a month alone counts as its first day), or null when it has none that can be read. */
export function folderDate(name: string): string | null {
  let m = /(?:^|\D)(\d{4})[-_. ]?(\d{2})[-_. ]?(\d{2})(?!\d)/.exec(name);                                   // 2026-03-01, 2026_03_01, 20260301
  if (m && valid(+m[1], +m[2], +m[3])) return iso(+m[1], +m[2], +m[3]);
  m = /(?:^|\D)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4}|\d{2})(?!\d)/.exec(name);                              // 03-04-2026: month first, unless only day first is a date
  if (m) { const y = year(m[3]); if (valid(y, +m[1], +m[2])) return iso(y, +m[1], +m[2]); if (valid(y, +m[2], +m[1])) return iso(y, +m[2], +m[1]); }
  m = /(?:^|[^\p{L}])(\p{L}{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?!\d)/iu.exec(name);               // March 4, 2026
  if (m && monthOf(m[1]) && valid(+m[3], monthOf(m[1]), +m[2])) return iso(+m[3], monthOf(m[1]), +m[2]);
  m = /(?:^|\D)(\d{1,2})(?:st|nd|rd|th)? (\p{L}{3,9})\.?,? (\d{4})(?!\d)/iu.exec(name);                    // 4 March 2026
  if (m && monthOf(m[2]) && valid(+m[3], monthOf(m[2]), +m[1])) return iso(+m[3], monthOf(m[2]), +m[1]);
  m = /(?:^|[^\p{L}])(\p{L}{3,9})\.? (\d{4})(?!\d)/iu.exec(name);                                           // March 2026
  if (m && monthOf(m[1])) return iso(+m[2], monthOf(m[1]), 1);
  m = /(?:^|\D)(\d{4})[-_.](\d{2})(?!\d|[-_.]\d)/.exec(name);                                                     // 2026-03
  if (m && +m[2] >= 1 && +m[2] <= 12) return iso(+m[1], +m[2], 1);
  return null;
}

/** what families need of a document: its id, its path inside the data room (folders and name), and when the app first saw it */
export interface Draft { docId: string; path: string; seen?: string }
/** one family: its drafts, newest first, each with the date read from its folder, if any */
export interface Family { name: string; drafts: { docId: string; date: string | null }[] }

/**
 * The families among these documents. Files of one name in sibling folders make a family when at least two of those
 * folders have a date; a draft in an undated sibling folder joins it, placed by when the app first saw it. A document in no family is left out.
 */
export function families(docs: Draft[]): Family[] {
  const groups = new Map<string, (Draft & { date: string | null })[]>();
  // another project's document is never a draft of this deal's (docs/other-project-documents-design.md), nor is its own earlier version
  docs = docs.filter((d) => !inPrecedents(d.path));
  for (const d of docs) {
    const parts = d.path.split(/[\\/]/).filter(Boolean); if (parts.length < 2) continue;
    // the family is the parent of the folder the file is in, and the file's name, compared without case
    const key = `${parts.slice(0, -2).join('/')}\u0000${parts[parts.length - 1]}`.toLowerCase();
    const g = groups.get(key) ?? []; g.push({ ...d, date: folderDate(parts[parts.length - 2]) }); groups.set(key, g);
  }
  // the date it is ordered by: its folder's, else the day the app first saw it (both read as YYYY-MM-DD…, so they compare as text)
  const when = (d: Draft & { date: string | null }) => d.date ?? d.seen ?? '';
  const out: Family[] = [];
  for (const g of groups.values()) {
    if (g.filter((d) => d.date).length < 2) continue;
    g.sort((a, b) => (when(a) !== when(b) ? (when(a) < when(b) ? 1 : -1) : (a.seen ?? '') !== (b.seen ?? '') ? ((a.seen ?? '') < (b.seen ?? '') ? 1 : -1) : a.path < b.path ? 1 : -1));
    out.push({ name: g[0].path.split(/[\\/]/).pop()!, drafts: g.map((d) => ({ docId: d.docId, date: d.date })) });
  }
  // versions in one folder: only an explicit mark counts, never a download copy "(1)" or a dated series
  const inFamily = new Set(out.flatMap((f) => f.drafts.map((d) => d.docId)));
  const marked = new Map<string, { d: Draft; mark: number[] }[]>();
  for (const d of docs) {
    if (inFamily.has(d.docId)) continue;
    const parts = d.path.split(/[\\/]/).filter(Boolean); const v = versionOf(parts[parts.length - 1]); if (!v) continue;
    const key = `${parts.slice(0, -1).join('/')}\u0000${v.base}`.toLowerCase();
    const g = marked.get(key) ?? []; g.push({ d, mark: v.mark }); marked.set(key, g);
  }
  for (const g of marked.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => compareMarks(b.mark, a.mark) || ((a.d.seen ?? '') !== (b.d.seen ?? '') ? ((a.d.seen ?? '') < (b.d.seen ?? '') ? 1 : -1) : a.d.path < b.d.path ? 1 : -1));
    out.push({ name: g[0].d.path.split(/[\\/]/).pop()!, drafts: g.map((x) => ({ docId: x.d.docId, date: null })) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** an explicit version mark in a file name: v3, v.3, v3.1, version 3, draft 3, rev 3, Rev A (a letter only after "rev"; a number of one or two digits) */
export const MARK = /(?:^|[\s_(\[-])(?:(v|ver|version|draft|rev|revision)\.?[\s_-]?(\d+(?:\.\d+)*)|(rev|revision)\.?[\s_-]?([A-Z]))(?=$|[\s_)\].-])/;
/**
 * A file name's version mark, as numbers to compare (a letter A is 1, B is 2), and the name with the mark taken off, or
 * null when it has none. The last mark in the name counts ("SPA v2 draft 3": draft 3).
 */
export function versionOf(name: string): { base: string; mark: number[] } | null {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  let m: RegExpExecArray | null = null; const re = new RegExp(MARK.source, 'gi');
  for (let x = re.exec(stem); x; x = re.exec(stem)) { if ((x[4] && !/^[A-Z]$/.test(x[4])) || (x[2] && x[2].split('.')[0].length > 2)) { re.lastIndex = x.index + 1; continue; } m = x; re.lastIndex = x.index + 1; }   // a letter mark only in capitals ("Rev A", not "rev a"); a number of three digits or more is a model or a year ("V150", "Draft 2025"), not a version
  if (!m) return null;
  const mark = m[2] ? m[2].split('.').map(Number) : [m[4].charCodeAt(0) - 64];
  const base = `${stem.slice(0, m.index)} ${stem.slice(m.index + m[0].length)}`.replace(/[\s_()[\].-]+/g, ' ').trim().toLowerCase();
  return base ? { base, mark } : null;
}
/** order of two version marks: 10 after 9, 2.1 after 2 */
function compareMarks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; }
  return 0;
}
