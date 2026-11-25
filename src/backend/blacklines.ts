/**
 * Blacklines: PDFs a comparison tool made of two drafts, with the changes marked.
 *
 * A PDF is a blackline when its name says so (blackline, redline) or its first page is a comparison tool's cover page,
 * which lists the two files compared and counts the insertions and deletions. A name with a weaker word (comparison,
 * compared, marked-up), or a name of two drafts of one document with "vs" between them ("Deal v4 vs Deal v3"), makes
 * one only when a draft it names is there by that name: "Peer comparison.pdf" is a report. Its clean draft, the truth
 * for the deal's terms, is the newer file named on that cover page, found in the data room; else the file of the same
 * name without the blackline word, in the same folder; else the newest draft in the family of that name. Where more
 * than one file would do, it is unclear, and it is not read for its changes. Where no file of that name is in the data
 * room at all, it stands alone: it is read by itself, still as the model's reading. Nothing here asks a model.
 */
import { families, roomPath, inPrecedents, versionOf } from './families';

const PDF = /\.pdf$/i;
/** "A vs B": two drafts' names with vs (or versus) between them, as people name a comparison */
const VS = /\s(?:vs\.?|versus)\s/i;
/** the words that make a file's name a blackline's */
const NAMED = /(?:^|[^\p{L}])(black[- ]?lines?|blacklined|red[- ]?lines?|redlined)(?![\p{L}])/iu;
/** words that may name a blackline, or an ordinary report: they count only with the clean draft beside them by name */
const MAYBE = /(?:^|[^\p{L}])(comparisons?|compared|compare|mark[- ]?up|marked(?:[- ]up)?)(?![\p{L}])/iu;
/** a file name without its extension, folded for comparing */
const base = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[()[\]\s_.-]+/g, ' ').trim().toLowerCase();
/** a blackline's name without the blackline words and what joins them, as the clean draft's would read */
const stripped = (name: string, words = NAMED) => base(name.replace(new RegExp(words.source, 'giu'), ' ').replace(/\s*(?:vs?\.?|against|to)\s*$/i, '').replace(/[\s_.-]+$/, ''));
/**
 * The names a blackline's clean draft may have, the likelier first: the name without the blackline words, then, when
 * the blackline word is followed straight away by what joins two drafts ("SPA v3 Redline to SPA v2"), the draft before
 * it, the newer. A "to" anywhere else is part of a title ("Exhibit A to SPA redline") and splits nothing.
 */
const wants = (name: string) => {
  const w = stripped(name); const b = base(name); const m = b.match(NAMED); if (!m || m.index === undefined) return [w];
  const before = b.slice(0, m.index + m[0].length - m[1].length).trim(); const after = b.slice(m.index + m[0].length);
  return before && /^\s+(?:to|vs|versus|against)\s+\S/i.test(after) ? [w, before] : [w];
};

/**
 * A comparison tool's cover page, as the text of its start, or null when the first page is not one. A cover says
 * "comparison" and counts or keys insertions and deletions (Litera Compare, Workshare, Word's own compare), and names
 * the two files compared, the original first.
 */
export function coverOf(first: string): string | null {
  const t = first.slice(0, 1500);
  return /\bcompar(?:e|ed|ison)\b/i.test(t) && /\b(?:insert(?:ed|ions?)|delet(?:ed|ions?)|legend|original (?:document|file))/i.test(t) ? t : null;
}
/** where in a cover a file is named last (by its name without extension, as whole words), or -1 */
const namedAt = (cover: string, name: string) => { const c = ` ${base(cover)} `; const n = ` ${base(name)} `; return n.trim() ? c.lastIndexOf(n) : -1; };
/** whether a cover names another file after `name`, found at `at`: then `name` is the original, not the newer draft */
const namedLater = (cover: string, name: string, at: number) => /\s(?:docx?|pdf|rtf)\s/.test(` ${base(cover)} `.slice(at + ` ${base(name)}`.length).replace(/^\s*(?:docx?|pdf|rtf)\s/, ' '));
/** a name's first word: both sides of "A vs B" share it when they are two drafts of one document */
const head = (folded: string) => folded.split(' ').find((w) => /\p{L}{2}/u.test(w));

/** what blacklines need of a document: its id, name, place in the data room, when first seen, and its cover page if it has one */
export interface BlacklineDoc { docId: string; name: string; folder: string; rel: string; seen?: string; cover?: string; /** the other places the same file is in */ copies?: { folder: string; rel: string; name?: string }[] }

/**
 * Whether a document is another project's (docs/other-project-documents-design.md): every place it is in runs through a
 * precedents folder. A precedent copied into a working folder, or this deal's executed agreement also filed in Precedents,
 * is somewhere else too, so it is this deal's own. Names and paths only, so every PC says the same.
 */
export const otherProject = (d: { folder: string; rel: string; name?: string; copies?: { folder: string; rel: string; name?: string }[] }) => [d, ...(d.copies ?? [])].every((p) => inPrecedents(roomPath(p)));

/** whether a document is a blackline: a PDF named so, or whose first page is a comparison cover */
export const isBlackline = (d: { name: string; cover?: string }) => PDF.test(d.name) && (NAMED.test(base(d.name)) || d.cover !== undefined);

/**
 * Each blackline among these documents, by id, with its clean draft's id; null when which one is not clear; false when
 * neither its cover nor its name finds one (a standalone blackline, read on its own). Documents that are not blacklines are left out:
 * what is in the map is a blackline.
 */
export function cleanDrafts(docs: BlacklineDoc[]): Map<string, string | null | false> {
  const out = new Map<string, string | null | false>(); const lines = docs.filter(isBlackline); const maybe = docs.filter((d) => !isBlackline(d) && PDF.test(d.name) && MAYBE.test(base(d.name))); const versus = docs.filter((d) => !isBlackline(d) && PDF.test(d.name) && !MAYBE.test(base(d.name)) && VS.test(` ${base(d.name)} `))   // read as folded, so "SPA_v4_vs_SPA_v3" counts too;
  if (!lines.length && !maybe.length && !versus.length) return out;
  // another project's document is never this deal's clean draft, nor does it make one unclear
  const clean = docs.filter((d) => !isBlackline(d) && !otherProject(d)); const dirs = new Map<BlacklineDoc, string>(); const dir = (d: BlacklineDoc) => dirs.get(d) ?? (dirs.set(d, roomPath(d).split('/').slice(0, -1).join('/')), dirs.get(d)!);
  /** a document's folded name, worked out once (a data room of thousands is compared with each blackline) */
  const names = new Map<BlacklineDoc, string>(); const bn = (d: BlacklineDoc) => names.get(d) ?? (names.set(d, base(d.name)), names.get(d)!);
  const fams = families(clean.map((d) => ({ docId: d.docId, path: roomPath(d), ...(d.seen ? { seen: d.seen } : {}) })));
  /** the one of `c`, or null for none; undefined when more than one would do */
  const one = (c: BlacklineDoc[]) => (c.length === 1 ? c[0].docId : c.length ? undefined : null);
  for (const b of lines) {
    // a blackline made on another project has no clean draft in this deal: it is read on its own, as another project's
    if (otherProject(b)) { out.set(b.docId, false); continue; }
    // 1 the newer file the cover names: the one named last; a name found twice is taken from the blackline's own folder, if it is there
    const at = b.cover ? clean.map((d) => ({ d, n: namedAt(b.cover!, d.name) })).filter((x) => x.n >= 0) : []; const last = Math.max(-1, ...at.map((x) => x.n));
    if (last >= 0) {
      const all = at.filter((x) => x.n === last).map((x) => x.d); const near = all.filter((d) => dir(d) === dir(b));
      // only the cover's newer file will do: when the cover names another after it, that one is the original and the newer is not here
      if (namedLater(b.cover!, all[0].name, last)) { out.set(b.docId, null); continue; }
      const got = one(all) ?? one(near) ?? undefined; if (got) { out.set(b.docId, got); continue; } if (all.length) { out.set(b.docId, null); continue; }
    }
    // 2 the same name without the blackline words, in the same folder; 3 else the newest in the family of that name
    let found = false;
    for (const want of wants(b.name)) {
      const here = one(clean.filter((d) => dir(d) === dir(b) && bn(d) === want));
      if (here !== null) { out.set(b.docId, here ?? null); found = true; break; }
      const fam = fams.filter((f) => base(f.name) === want); if (fam.length) { out.set(b.docId, fam.length === 1 ? fam[0].drafts[0].docId : null); found = true; break; }
    }
    // 4 no clean draft by cover or name: it stands alone and is read on its own, whatever else shares a word of its name
    if (!found) out.set(b.docId, false);
  }
  // a weaker word: a blackline only when the file of its name without that word is in its folder; otherwise an ordinary document
  for (const b of maybe.filter((d) => !otherProject(d))) { const here = one(clean.filter((d) => d !== b && dir(d) === dir(b) && bn(d) === stripped(b.name, MAYBE))); if (here) out.set(b.docId, here); }
  // "A vs B": two drafts of one document, so both names start with the same word ("Doe vs Roe judgment" is a case,
  // not a blackline), and A or B is in its folder. A, named first, is the newer draft, as in "A redline to B", so it
  // is the clean draft when it is there; with only B there, the newer draft is missing and it is unclear (null), not
  // read against B
  for (const b of versus.filter((d) => !otherProject(d))) {
    const sides = base(b.name).split(VS).map((x) => x.trim()); if (sides.length !== 2 || !sides[0] || !sides[1] || head(sides[0]) !== head(sides[1])) continue;
    const near = clean.filter((d) => d !== b && dir(d) === dir(b)); const a = one(near.filter((d) => bn(d) === sides[0]));
    if (a) out.set(b.docId, a); else if (a === undefined || near.some((d) => bn(d) === sides[1])) out.set(b.docId, null);
  }
  return out;
}

/** what a blackline was compared against: this deal's own earlier draft, another project's document, or not known */
export type Against = 'own' | 'other' | 'unknown';
/** words a draft's name carries that do not change which document it is: its status, and the blackline words */
const STATUS = /(?:^|\s)(?:execution version|executed|signed|conformed|final|clean|draft|black ?lines?|blacklined|red ?lines?|redlined|comparison|compared|marked up|markup)(?=\s|$)/g;
/** a draft's name as compared with another draft's: no extension, version mark, date, status word or bracket character (the words inside stay) */
const draftKey = (name: string) => {
  const v = versionOf(/\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.x`); const b = v ? v.base : base(name);
  return b.replace(/\b\d{1,4}[-_. ]\d{1,2}[-_. ]\d{1,4}\b|\b\d{8}\b/g, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(STATUS, ' ').replace(/\s+/g, ' ').trim();
};
/** a comparison cover's file names in the order it gives them, each with the path it is given under, as written */
export function coverFiles(cover: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []; const re = /\.(?:docx?|pdf|rtf)(?![a-z0-9])/gi; let from = 0;
  for (let m = re.exec(cover); m; m = re.exec(cover)) {
    // the text since the last name, then from the start of a path (a drive, file://, a share) or after the last label or joining word
    const seg = cover.slice(from, m.index + m[0].length); from = m.index + m[0].length;
    const lineSeg = seg.split(/[\n\t]/).pop() ?? seg;
    const at = lineSeg.search(/(?:file:\/\/\/?|[A-Za-z]:[\\/]|\\\\[^\\\s])/);
    const path = (at >= 0 ? lineSeg.slice(at) : lineSeg.replace(/^.*:\s+/, '')).replace(/^file:\/\/\/?/i, '').trim();
    const name = (path.split(/[\\/]/).pop() ?? '').replace(/^.*?\b(?:compar(?:ison|e|ed) (?:of|with|to|between))\s+/i, '').replace(/^(?:and|to|with|vs\.?|versus|against)\s+/i, '')
      // a label before it ("Original Document [#1234567] [v6] EPC Contract v6.docx", Litera)
      .replace(/^(?:original|modified|revised|current|document \d+)(?:\s+(?:document|file|filename|version))?(?:\s+id)?\s*:?\s*/i, '').replace(/^(?:\[[^\]]*\]\s*)+/, '').trim();
    if (name.replace(/\.[a-z0-9]{1,5}$/i, '').trim()) out.push({ name, path: at >= 0 ? path : name });
  }
  return out;
}
/** the name a blackline's own name gives the draft it was compared against: B in "A Redline to B", "A blackline against B", "A vs B" */
const namedOriginal = (name: string): string | null => {
  const b = base(name); const m = b.match(NAMED);
  if (m && m.index !== undefined) { const after = b.slice(m.index + m[0].length).match(/^\s+(?:to|vs|versus|against)\s+(.+)$/i); if (after) return after[1]; }
  const sides = ` ${b} `.split(VS).map((x) => x.trim()); return sides.length === 2 && sides[0] && sides[1] ? sides[1] : null;
};

/**
 * What each blackline was compared against (docs/other-project-documents-design.md), with no model, from names, paths and
 * its cover only. "other": it, or the original it names, is another project's (in a precedents folder); "own": the original
 * is a draft of the same document as its clean draft ("SPA v3 Redline to SPA v2" beside "SPA v3.docx"); "unknown" else,
 * including a blackline with no clean draft and one whose original is named differently. `pairs` is `cleanDrafts` of the same documents.
 */
export function againstOf(docs: BlacklineDoc[], pairs: Map<string, string | null | false>): Map<string, Against> {
  const out = new Map<string, Against>(); if (!pairs.size) return out;
  const byId = new Map(docs.map((d) => [d.docId, d])); const fams = families(docs.filter((d) => !pairs.has(d.docId)).map((d) => ({ docId: d.docId, path: roomPath(d), ...(d.seen ? { seen: d.seen } : {}) })));
  const famOf = new Map<string, string[]>(); for (const f of fams) for (const x of f.drafts) famOf.set(x.docId, f.drafts.map((y) => y.docId));
  /** this deal's documents that are not blacklines, by their folded name, so an original is looked up once */
  const byBase = new Map<string, BlacklineDoc[]>(); for (const d of docs) if (!pairs.has(d.docId)) { const k = base(d.name); const l = byBase.get(k) ?? []; l.push(d); byBase.set(k, l); }
  for (const [id, c] of pairs) {
    const b = byId.get(id); if (!b) continue;
    if (otherProject(b)) { out.set(id, 'other'); continue; }
    const named = b.cover ? coverFiles(b.cover) : []; const original = named.length >= 2 ? named[0] : undefined;
    const name = original?.name ?? namedOriginal(b.name);
    // the original is another project's: its path on the cover runs through a precedents folder, or the file of that name here is in one
    const here = name ? (byBase.get(base(name)) ?? []) : [];
    if ((original && inPrecedents(original.path.replace(/\\/g, '/'))) || (here.length && here.every(otherProject))) { out.set(id, 'other'); continue; }
    const clean = c ? byId.get(c) : undefined;
    if (!clean || !name) { out.set(id, 'unknown'); continue; }
    // own: the original is a draft of the clean draft's document, by its family or by its name once marks, dates and status words are off
    const sameFamily = here.some((d) => famOf.get(clean.docId)?.includes(d.docId));
    out.set(id, sameFamily || (draftKey(name) !== '' && draftKey(name) === draftKey(clean.name)) ? 'own' : 'unknown');
  }
  return out;
}
