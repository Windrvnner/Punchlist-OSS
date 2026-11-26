/**
 * A deal's core documents, worked out with no model and no cap (docs/core-documents-design.md, part 1).
 *
 * Core documents are marked for the fast model when it picks what to read, break ties in the keyword ranking, and the
 * best 100 are described up front. They never limit what a check reads: every item's search ranks the whole data room.
 *
 * Only signals every PC has alike are used, so every PC gets the same set without writing it: each document's file name,
 * folder path and most-used words; each checklist item's wording, its headings and the searches already kept for it; the
 * synonyms library (control file). Not this PC's full-text index, and not summaries, which change as documents are read.
 *
 *   1. Per item: each document is scored on the item's subject terms, a word in the file name 10, in its folder path 3,
 *      among its most-used words 1, each weighted by how rare it is among the documents and among the items. The top 3
 *      are core. An item none of whose terms is in any name or path adds nothing.
 *   2. Best 100: reciprocal-rank fusion over every item's top 10. These are described up front and marked.
 *   3. Hubs (a data-room index, a request list, a tracker, or a document at the top of a fifth of the items across most
 *      sections): core once, taking no item's place and not among the best 100.
 *   4. Of the drafts of one document only the newest, and a blackline through its clean draft (`standIn`). Documents in a
 *      precedents folder are another project's and are never core.
 *   5. Complete families (related.ts, part 2): a core agreement brings in its schedules, exhibits, amendments and side
 *      letters, and a core member placed under one agreement brings in that agreement and its family; after the items'
 *      picks, never among the best 100.
 *
 * With no checklist yet, or one none of whose items names anything in the data room, each library group is taken as an
 * item. Nothing here asks a model.
 */
import { fold, indexWords as words } from './words';   // the word index's split (#1147)
import { versionOf, PRECEDENTS } from './families';
import type { DocFamilies } from './related';

export interface CoreDoc { docId: string; /** its path from the data room's own folder, name last */ path: string; words?: string[]; seen?: string }
export interface CoreItem { id: string; text: string; /** its section and subsection headings */ heads?: string; /** searches already kept for it (its trail) */ searches?: string[] }
export interface CoreInput {
  docs: CoreDoc[];
  items: CoreItem[];
  /** a document whose place goes to another (an earlier draft to its newest, a blackline to its clean draft), or to none (null: a blackline whose clean draft is unclear) */
  standIn?: Map<string, string | null>;
  /** groups of names for one thing (control file, lists.synonyms) */
  library: string[][];
  /** filler words, never terms */
  filler: Set<string>;
  /** words checklist items use to ask (executed, copy, provided...), never subject terms */
  ask: Set<string>;
  /** related documents and their agreements (related.ts, part 2): a core agreement brings its family in */
  families?: Pick<DocFamilies, 'members' | 'alone'>;
}
export interface CoreSet { /** most important first: the best 100, the rest of the items' picks, the families they complete, then hubs */ ids: string[]; /** how many of `ids` are the best 100 */ best: number; hubs: string[]; /** items that added nothing */ idle: number }

export const BEST = 100;
const PER_ITEM = 3, FUSED = 10, FUSE_K = 10, HUB_SHARE = 0.2;
const W_NAME = 10, W_FOLDER = 3, W_WORDS = 1;
/** words that tie a document to another: an amendment, a schedule. Fewer of them in a name wins a tie (the agreement before its amendment) */
const RELATION = new Set(['amendment', 'amended', 'restated', 'schedule', 'exhibit', 'annex', 'appendix', 'side', 'joinder', 'waiver', 'supplement', 'novation', 'assignment']);
/** a file named as a list of other documents: "VDR Index", "Index of documents", "Q&A tracker" (not "PPA Price Index Adjustment") */
const HUB_NAME = /(?:^|[^a-z])(tracker|request list|q ?& ?a|questions and answers)(?:$|[^a-z])/i;
/** "index" names a list only as the name's last word (a version, date or number after it aside) or as "Index of"/"Index to" */
const isHubName = (stem: string) => HUB_NAME.test(stem) || /(?:^|[^a-z])index$/i.test(stem.replace(/(?:[\s_-]*(?:v\.?\d+(?:\.\d+)*|\d[\d._-]*|\(\d+\)))+$/i, '').trim()) || /^index (?:of|to)\b/i.test(stem.trim());
/** an abbreviation as written: capitals and digits, "O&M", a plural s */
const ABBREV = /^[A-Z][A-Z0-9&]*[A-Z0-9]s?$/;

interface Member { n: number; group: number; seq: string[]; abbrev: string | null }
/** the library ready to match: each abbreviation as written, each phrase under its first word */
export interface Library { all: Member[]; abbrevs: Map<string, Member[]>; byFirst: Map<string, Member[]> }
const gid = (g: number) => `#${g}`;

/** the library's members, ready to match: a phrase as its words, an abbreviation as written */
export function compile(library: string[][], filler: Set<string>): Library {
  const all: Member[] = []; const abbrevs = new Map<string, Member[]>(); const byFirst = new Map<string, Member[]>();
  const add = (map: Map<string, Member[]>, k: string, m: Member) => { const l = map.get(k) ?? []; l.push(m); map.set(k, l); };
  library.forEach((group, g) => { for (const x of group) { const t = x.trim(); if (!t) continue; const m: Member = { n: all.length, group: g, seq: words(t, filler), abbrev: ABBREV.test(t) ? t : null }; if (!m.abbrev && !m.seq.length) continue; all.push(m); if (m.abbrev) add(abbrevs, m.abbrev, m); else add(byFirst, m.seq[0], m); } });
  return { all, abbrevs, byFirst };
}

/**
 * The groups a piece of text names, with the positions of the words each phrase covers. A phrase counts only whole and in
 * order; an abbreviation only as a whole word in capitals, in a text that has lower-case letters too ("PILOT PROGRAM" is
 * not PILOT).
 */
export function groupsIn(raw: string, ws: string[], lib: Library, phrasesOnly = false, cased = /\p{Ll}/u.test(raw)): { group: number; at: number[] }[] {
  const out: { n: number; group: number; at: number[] }[] = [];
  // an abbreviation is a whole run of letters, digits and "&" (so "PPA" is not in "PPAs" or "O&M" in "BO&M")
  if (!phrasesOnly && cased) for (const run of new Set(raw.match(/[A-Za-z0-9&]+/g) ?? [])) for (const m of lib.abbrevs.get(run) ?? []) out.push({ n: m.n, group: m.group, at: [] });
  ws.forEach((w, i) => { for (const m of lib.byFirst.get(w) ?? []) if (i + m.seq.length <= ws.length && m.seq.every((x, k) => ws[i + k] === x)) out.push({ n: m.n, group: m.group, at: m.seq.map((_, k) => i + k) }); });
  return out.sort((a, b) => a.n - b.n || a.at[0] - b.at[0]).map(({ group, at }) => ({ group, at }));
}

export function coreSet(input: CoreInput): CoreSet {
  const { filler, ask } = input; const members = compile(input.library, filler);
  const docs = [...input.docs].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
  // ── the documents ──
  const feats = docs.map((d) => {
    const parts = d.path.split(/[\\/]/).filter(Boolean); const file = (parts.pop() ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
    // capitals tell an abbreviation only where the path has lower-case letters somewhere ("Offtake/PPA.pdf" yes, "PILOT PROGRAM/X.PDF" no)
    const cased = /\p{Ll}/u.test(d.path.replace(/\.[a-z0-9]{1,5}$/i, ''));
    const termsOf = (raw: string) => { const ws = words(raw, filler); return [...ws, ...groupsIn(raw, ws, members, false, cased).map((x) => gid(x.group))]; };
    const name = new Set(termsOf(file)); const folder = new Set(parts.flatMap(termsOf).filter((t) => !name.has(t)));
    const ws = (d.words ?? []).map((w) => fold(w.toLowerCase())).filter((w) => !filler.has(w));
    const most = new Set([...ws, ...groupsIn(ws.join(' '), ws, members, true).map((x) => gid(x.group))].filter((t) => !name.has(t) && !folder.has(t)));
    const nameWords = words(file, filler);
    return { d, name, folder, most, relations: nameWords.filter((w) => RELATION.has(w)).length, length: file.length, mark: versionOf(`${file}.x`)?.mark ?? [], other: parts.some((p) => PRECEDENTS.test(p.trim())), hub: isHubName(file) };
  });
  const N = docs.length; const df = new Map<string, number>(); const posting = new Map<string, number[]>();
  feats.forEach((f, i) => { for (const t of new Set([...f.name, ...f.folder, ...f.most])) { df.set(t, (df.get(t) ?? 0) + 1); const p = posting.get(t) ?? []; p.push(i); posting.set(t, p); } });
  const idf = (t: string) => Math.log(1 + N / (df.get(t) ?? N));
  // ── the items ──
  const items: CoreItem[] = input.items.length ? input.items : input.library.map((g, i) => ({ id: `library:${i}`, text: g.join(' / ') }));
  const M = items.length;
  const parsed = items.map((it) => {
    const raw = [it.text, ...(it.searches ?? [])].join('\n'); const ws = words(raw, filler); const gs = groupsIn(raw, ws, members);
    const headWs = it.heads ? words(it.heads, filler) : []; const headGs = it.heads ? groupsIn(it.heads, headWs, members) : [];
    return { it, ws, gs, headWs, headGs, all: new Set([...ws, ...gs.map((g) => gid(g.group)), ...headWs, ...headGs.map((g) => gid(g.group))]) };
  });
  const idfItem = new Map<string, number>(); for (const p of parsed) for (const t of p.all) idfItem.set(t, (idfItem.get(t) ?? 0) + 1);
  const common = (t: string) => M >= 4 && (idfItem.get(t) ?? 0) >= M / 2;
  const itemW = (t: string) => Math.log(1 + M / (idfItem.get(t) ?? 1)); const FULL = Math.log(1 + M);
  /** an item's units: each a word, or a library phrase scored as the best of its group and its own words, never both */
  type Unit = { alts: string[][]; w: Map<string, number> };
  const unitMemo = new Map<(typeof parsed)[number], Unit[]>();
  const unitsOf = (p: (typeof parsed)[number]): Unit[] => unitMemo.get(p) ?? (unitMemo.set(p, unitsFor(p)), unitMemo.get(p)!);
  const unitsFor = (p: (typeof parsed)[number]): Unit[] => {
    const units: Unit[] = []; const covered = new Set<number>(); const subject = (t: string) => !ask.has(t) && !common(t);
    for (const g of p.gs) {
      const own = g.at.map((i) => p.ws[i]).filter(subject); for (const i of g.at) covered.add(i);
      // the group weighs at least what all its phrase's words weigh together: a name that matches the whole phrase by another name ("PPA.pdf") is never beaten by one that shares a single word of it ("Purchase order")
      const whole = own.reduce((n, t) => n + itemW(t), 0);
      units.push({ alts: [[gid(g.group)], own], w: new Map([[gid(g.group), Math.max(itemW(gid(g.group)), whole)], ...own.map((t) => [t, itemW(t)] as [string, number])]) });
    }
    const plain = [...new Set(p.ws.filter((t, i) => !covered.has(i) && subject(t)))]; for (const t of plain) units.push({ alts: [[t]], w: new Map([[t, itemW(t)]]) });
    // headings count at full weight before the item has kept searches, and are all an item has when nothing else is a subject term
    if (!p.it.searches?.length || !units.length) {
      const heads = [...new Set([...p.headWs.filter((t) => !ask.has(t)), ...p.headGs.map((g) => gid(g.group))])];
      for (const t of heads) if (!units.some((u) => u.alts.some((a) => a.includes(t)))) units.push({ alts: [[t]], w: new Map([[t, FULL]]) });
    }
    return units;
  };
  const credit = (f: (typeof feats)[number], t: string) => (f.name.has(t) ? W_NAME : f.folder.has(t) ? W_FOLDER : f.most.has(t) ? W_WORDS : 0) * idf(t);
  /** where a document's place goes: through every stand-in in turn (a blackline to its clean draft, that draft to its newest), null for none */
  const place = (id: string): string | null => {
    const seen = new Set<string>(); let at: string | null = id;
    while (at !== null && input.standIn?.has(at) && !seen.has(at)) { seen.add(at); at = input.standIn.get(at) ?? null; }
    return at;
  };
  const at = new Map(feats.map((f, i) => [f.d.docId, i]));
  const better = (a: { i: number; s: number; hits: number }, b: { i: number; s: number; hits: number }) => {
    const fa = feats[a.i], fb = feats[b.i];
    return b.s - a.s || fa.relations - fb.relations || b.hits - a.hits || fa.length - fb.length || cmpMark(fb.mark, fa.mark) || (fa.d.path < fb.d.path ? -1 : fa.d.path > fb.d.path ? 1 : 0);
  };
  /**
   * The families the core documents complete (part 2): every member of a core agreement (any of its drafts core), and the
   * agreement and family of a core member placed under that agreement only; each as its newest draft, another project's
   * and hubs left out, in path order. One level only, except that an agreement brought in this way (an amended and
   * restated agreement under its original) brings its own members too. A member in several families brings in none.
   */
  const complete = (core: number[]): number[] => {
    const f = input.families; if (!f) return [];
    const inSet = new Set(core); const out: number[] = [];
    const add = (id: string) => { const to = place(id); const j = to === null ? undefined : at.get(to); if (j === undefined || inSet.has(j) || feats[j].other || hubs.has(j)) return; inSet.add(j); out.push(j); };
    const placed = (ids: string[]) => ids.some((id) => { const to = place(id); return to !== null && inSet.has(at.get(to) ?? -1); });
    const family = (agreement: string) => { add(agreement); for (const m of f.members.get(agreement) ?? []) add(m); };
    // whose families the core set already holds: an agreement any of whose drafts is core, an agreement of a core member placed under it alone
    const whose = [...f.members.keys()].filter((a) => placed([a]) || (f.members.get(a) ?? []).some((m) => f.alone.has(m) && placed([m])));
    const from = out.length; for (const a of whose.sort()) family(a);
    for (const j of out.slice(from)) family(feats[j].d.docId);
    return out.sort(byPath);
  };
  /** an item's ranking: documents in its place (newest drafts, clean drafts), another project's left out, `skip` left out */
  const rank = (p: (typeof parsed)[number], skip: Set<number>) => {
    const units = unitsOf(p); let named = false;
    // scored along each term's documents (not every candidate against every term): a unit gives each document the best of its alternatives
    const score = new Map<number, number>(); const hitsOf = new Map<number, number>();
    for (const u of units) {
      const top = new Map<number, number>(); const inName = new Set<number>();
      for (const a of u.alts) {
        const v = new Map<number, number>();
        for (const t of a) for (const i of posting.get(t) ?? []) { const f = feats[i]; if (f.name.has(t)) inName.add(i); if (f.name.has(t) || f.folder.has(t)) named = true; v.set(i, (v.get(i) ?? 0) + credit(f, t) * (u.w.get(t) ?? 0)); }
        for (const [i, x] of v) if (x > (top.get(i) ?? 0)) top.set(i, x);
      }
      for (const [i, x] of top) score.set(i, (score.get(i) ?? 0) + x);
      for (const i of inName) hitsOf.set(i, (hitsOf.get(i) ?? 0) + 1);
    }
    if (!named) return null;
    const best = new Map<number, { i: number; s: number; hits: number }>();
    for (const [i, s] of score) {
      const f = feats[i]; const hits = hitsOf.get(i) ?? 0;
      if (s <= 0) continue;
      const to = place(f.d.docId); if (to === null) continue; const j = at.get(to); if (j === undefined || feats[j].other || skip.has(j)) continue;
      const had = best.get(j); if (!had || s > had.s) best.set(j, { i: j, s, hits: Math.max(hits, had?.hits ?? 0) });
    }
    return [...best.values()].sort(better).slice(0, FUSED).map((x) => x.i);
  };
  // first pass, to find the hubs; then again without them
  const first = parsed.map((p) => rank(p, new Set()));
  const tops = new Map<number, number[]>(); first.forEach((r, k) => { for (const i of r?.slice(0, PER_ITEM) ?? []) tops.set(i, [...(tops.get(i) ?? []), k]); });
  const sections = new Set(items.map((it) => it.heads ?? '')); const active = first.filter(Boolean).length;
  const hubs = new Set<number>();
  for (const [i, ks] of tops) {
    const f = feats[i]; const spread = new Set(ks.map((k) => items[k].heads ?? '')).size;
    const unnamed = ks.filter((k) => unitsOf(parsed[k]).some((u) => u.alts.some((a) => a.some((t) => f.name.has(t))))).length < ks.length / 2;
    if (f.hub || (active >= 50 && ks.length > active * HUB_SHARE && spread > sections.size / 2 && unnamed)) hubs.add(i);
  }
  const ranked = hubs.size ? parsed.map((p) => rank(p, hubs)) : first;
  const fused = new Map<number, number>(); const firstAt = new Map<number, number>(); const picked = new Set<number>();
  for (const r of ranked) r?.forEach((i, n) => { fused.set(i, (fused.get(i) ?? 0) + 1 / (n + 1 + FUSE_K)); if (n < PER_ITEM) { picked.add(i); firstAt.set(i, Math.min(firstAt.get(i) ?? n, n)); } });
  // a checklist none of whose items names anything in the data room is no better than none: the library stands in for it
  if (!picked.size && input.items.length && input.library.length) return coreSet({ ...input, items: [] });
  const byPath = (a: number, b: number) => (feats[a].d.path < feats[b].d.path ? -1 : feats[a].d.path > feats[b].d.path ? 1 : 0);
  const best = [...fused.keys()].sort((a, b) => (fused.get(b)! - fused.get(a)!) || byPath(a, b)).slice(0, BEST);
  const inBest = new Set(best);
  const rest = [...picked].filter((i) => !inBest.has(i)).sort((a, b) => firstAt.get(a)! - firstAt.get(b)! || (fused.get(b)! - fused.get(a)!) || byPath(a, b));
  const hubList = [...hubs].sort(byPath);
  const fam = complete([...best, ...rest]);
  return { ids: [...best, ...rest, ...fam, ...hubList].map((i) => feats[i].d.docId), best: best.length, hubs: hubList.map((i) => feats[i].d.docId), idle: ranked.filter((r) => !r).length };
}
function cmpMark(a: number[], b: number[]): number { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; }

/** words left out when the initials of a phrase are read: "engineering, procurement and construction" is EPC */
const JOINS = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'a', 'an']);
/**
 * Short names the deal's own paths spell out, with no model: an abbreviation in capitals whose letters are
 * the initials, one per word, of a phrase in the same folder or file name ("Power Purchase Agreement (PPA)", "PPA - Power Purchase
 * Agreement.pdf"). Joining words (and, of) are skipped. A path with no lower-case letter is not read.
 */
export function shortNamesIn(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  // both forms in one folder or file name: a phrase in another part of the path ("Project Proseware Acquisition/PPA.pdf") is not what it stands for
  for (const path of paths) for (const seg of /\p{Ll}/u.test(path) ? path.split(/[\\/]/) : []) {
    const abbrevs = [...new Set(seg.match(/(?<![A-Za-z0-9&])[A-Z][A-Z&]{1,7}(?![A-Za-z0-9&])/g) ?? [])].filter((a) => a.replace(/&/g, '').length >= 2);
    if (!abbrevs.length) continue;
    const ws = seg.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
    for (const a of abbrevs) {
      const letters = a.replace(/&/g, '').toLowerCase(); if (out[a]) continue;
      for (let i = 0; i < ws.length && !out[a]; i++) {
        if (JOINS.has(ws[i].toLowerCase()) || ws[i] === a) continue;
        const phrase: string[] = []; let k = 0;
        for (let j = i; j < ws.length && k < letters.length; j++) {
          const w = ws[j]; if (w === a) break;
          if (JOINS.has(w.toLowerCase())) { if (phrase.length) phrase.push(w); continue; }
          if (w[0].toLowerCase() !== letters[k] || /^[A-Z&]+$/.test(w)) break;
          phrase.push(w); k++;
        }
        if (k === letters.length && phrase.length >= 2) out[a] = phrase.join(' ').toLowerCase();
      }
    }
  }
  return out;
}
