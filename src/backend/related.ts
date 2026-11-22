/**
 * Complete families for the core set (docs/core-families-design.md, part 2 of the core documents).
 *
 * Two things, read from names and paths only, with no model, so every PC gets the same answer:
 *   - Related documents: a schedule, exhibit, amendment, side letter or signature page belongs to its agreement. When the
 *     agreement is core, the whole family is; when one of its members is, the agreement and the family come in too.
 *   - Series: periodic records (monthly reports, board minutes, notices of borrowing) whose names differ only by a period.
 *     A series takes one place in the core set, held by its newest member.
 * When a name can't be read for sure, the document is left ordinary (ranked on its own) rather than guessed: every
 * document stays searchable, so a document left out of a family costs little, while one placed under the wrong agreement
 * or folded into a series misleads. The word lists come from the control file (lists.relationWords and the rest).
 */
import { tokens, fold } from './words';
import { folderDate, MARK, versionOf } from './families';
import { compile, groupsIn, words, type Library } from './core';
import { isBlackline } from './blacklines';

export interface FamilyDoc { docId: string; /** its path from the data room's own folder, name last */ path: string }
export interface FamilyInput {
  docs: FamilyDoc[];
  /** documents that are never an agreement, a member or a series member: blacklines (they count through their clean draft) */
  skip?: Set<string>;
  /** the synonyms library, as the core set uses it */
  library: string[][];
  filler: Set<string>;
  /** the control file's lists (lower case): relationWords, instrumentWords, seriesWords, partWords */
  relation: string[]; instrument: string[]; series: string[]; part: string[];
}
export interface DocFamilies {
  /** each agreement's members, by id; drafts of one agreement each list the same members */
  members: Map<string, string[]>;
  /** each member's agreements: one, or two or three when it can't be told which */
  of: Map<string, string[]>;
  /** each series, newest member first */
  series: string[][];
  /** members placed under one agreement only (its drafts and copies count as one) */
  alone: Set<string>;
}

/** most families a document can be put in when it can't be told which: more than this and it is left ordinary */
const MAX_TIED = 3;
/** words every agreement shares, which say nothing about which agreement ("amended and restated", "A&R" among them) */
const GENERIC = new Set(['agreement', 'contract', 'deed', 'amended', 'restated', 'ar']);
const STATUS = /\b(execution version|executed version|conformed copy|executed|signed|conformed|final|clean)\b/gi;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** a date in a name, in any of the ways people write one, or "dated"; taken out before names are compared */
const DATES = new RegExp(`\\bdated\\b|\\b\\d{4}[-_. ]\\d{1,2}[-_. ]\\d{1,2}\\b|\\b\\d{1,2}[-_. ]\\d{1,2}[-_. ]\\d{2,4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH},? \\d{4}\\b|\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b|\\b${MONTH}\\.? \\d{4}\\b|\\b\\d{1,2}[-/]\\d{4}\\b|\\b(?:19|20)\\d{2}\\b`, 'gi');
const ORD = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|\\d+(?:st|nd|rd|th))';
/** what follows a relation word to say which part: 3, 1.1(a), A, A-1, IV, One, Part B, No. 2, #2 */
const ID = '(?:(?:no\\.?|number|#)\\s*)?(?:\\d+(?:\\.\\d+)*[a-z]?(?:\\([a-z0-9]+\\))*|part\\s+[a-z0-9]+|[a-z](?:-\\d+)?|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)(?![a-z0-9])';
const CONN = '(?:to|of|re|under|for)';
/** an index in front of a name, as closing sets number them ("1.03 ", "Tab 2 - ", "Doc 4 ", "01 - "); a dotted one keeps its first number as a hint (1.03 goes with 1.01) */
const INDEX = /^(?:(?:tab|doc|document|item)\s*\d+[a-z]?|(\d{1,2})\.\d{1,3}|\d{1,3}\.?)(?:\s*[-–—.)]\s*|\s+)/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** a word list as alternatives, longest first, each with an optional plural and period ("Sch.", "Exhibits") */
const alt = (ws: string[]) => [...ws].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map((w) => `${esc(w).replace(/\s+/g, '\\s+')}(?:e?s)?\\.?${TIGHT.has(w) ? '(?![0-9])' : ''}`).join('|');
/** short relation words that a number never follows straight on: "CO #12" and "PCO-01" are change orders, "CO2" is carbon dioxide */
const TIGHT = new Set(['co', 'pco', 'vo']);
/** relation words for a part of an agreement: never the weak form ("Construction Schedule", "Credit Support Annex" are documents of their own) */
const ATTACHED = new Set(['schedule', 'sch', 'sched', 'exhibit', 'exh', 'ex', 'annex', 'annexure', 'appendix', 'app', 'attachment', 'att']);

/** a related document's name, read: `strong` when the relation word is used as one on its own (Schedule 3, First Amendment);
 * weak ("PPA Amendment") counts only if the agreement it names is found. `phrase`: the words naming its agreement, which
 * that agreement's name must hold; `own`: all its words that can point to an agreement; `restated`: it is itself an amended
 * and restated agreement; `toRestated`: it belongs to one ("First Amendment to Amended and Restated Credit Agreement") */
interface Rel { strong: boolean; phrase: string[]; own: string[]; restated?: boolean; toRestated?: boolean }
interface Doc {
  docId: string; path: string; dirs: string[];
  /** its name as compared, lower case: extension, index, version mark, status words, download copy and brackets off; `name`: the same with its case kept */
  pl: string; name: string;
  /** its words, library names as their group, a number joined to the word before it ("parcel#12") */
  key: string[]; keySet: Set<string>;
  /** the words its numbers follow ("parcel#" for "parcel#12") */
  stems: Set<string>;
  /** its own words without the generic ones, for telling a tie apart; `words`: all its own words, library phrases' included */
  raw: string[]; words: Set<string>;
  hint: string[]; rel: Rel | null;
  /** it has a version mark (v3, Rev A); `out`: a blackline, a precedent or skipped, so in no family or series; `cased`: its path has lower-case letters */
  versioned: boolean; out: boolean; cased: boolean;
  /** it can be an agreement others belong to; `parents`: the agreements it belongs to, by index */
  agreement: boolean; parents: number[];
}

/** reads names with the control file's word lists and the library */
function reader(input: FamilyInput) {
  const lib: Library = compile(input.library, input.filler); const filler = input.filler;
  const REL = `(?:${alt(input.relation)})`; const WEAK = `(?:${alt(input.relation.filter((w) => !ATTACHED.has(w)))})`;
  const REL_WORD = new RegExp(`(?:^|[^a-z0-9])(?:${alt(input.relation)}|amended|supplemental)(?![a-z])`, 'i');
  const INSTRUMENT = new RegExp(`\\b(?:${alt(input.instrument)})(?![a-z])`);
  const SERIES = new RegExp(`\\b(?:${alt(input.series)})(?![a-z])`);
  const PART = new RegExp(`\\b(?:${alt(input.part)})\\s*$`);
  /** the library's groups in a text (case kept, so an abbreviation counts only in capitals; `cased`: the path it is from has lower-case letters, as core.ts asks), as ids */
  /** each group's one-word members, as compared */
  const single = input.library.map((g) => g.map((m) => words(m, filler)).filter((w) => w.length === 1).map((w) => w[0]));
  const groupIds = (text: string, cased: boolean) => { const ws = words(text, filler); return { ws, gs: groupsIn(text, ws, lib, false, cased) }; };
  /** a text's words as compared: library phrases as their group, a number joined to the word before it */
  const keyOf = (text: string, cased: boolean): string[] => {
    const t = text.replace(DATES, ' '); const { ws, gs } = groupIds(t, cased); const covered = new Set(gs.flatMap((g) => g.at));
    // an abbreviation found ("EPC") covers its own word too, so "EPC Exhibit A" and "EPC Contract" share the group, not a stray "epc"
    const short = new Set(gs.filter((g) => !g.at.length).flatMap((g) => single[g.group]));
    const out = [...new Set([...ws.filter((w, i) => !covered.has(i) && !short.has(w)), ...gs.map((g) => `#${g.group}`)])];
    const tk = tokens(t); for (let i = 1; i < tk.length; i++) if (/^\d+$/.test(tk[i])) { let j = i - 1; while (j >= 0 && filler.has(tk[j])) j--; if (j >= 0 && !/^\d+$/.test(tk[j])) out.push(`${fold(tk[j])}#${+tk[i]}`); }
    return out;
  };
  /** a text's own words without the generic ones; `wide`: with the words of every name in the library groups it holds too */
  const rawOf = (text: string, cased: boolean, wide = false): string[] => { const { ws, gs } = groupIds(text.replace(DATES, ' '), cased); return [...new Set([...ws, ...(wide ? gs.flatMap((g) => input.library[g.group].flatMap((m) => words(m, filler))) : [])])].filter((w) => !GENERIC.has(w)); };
  /** a name as compared, with its case kept (for abbreviations), and the hint its index gives */
  const tidy = (file: string) => {
    let s = file.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(); let hint: string[] = [];
    const m = INDEX.exec(s); if (m) { s = s.slice(m[0].length); if (m[1]) hint = [`idx#${+m[1]}`]; }
    s = s.replace(new RegExp(MARK.source, 'gi'), ' ').replace(/\((?:\d+|copy|[^)]*\b(?:execution version|executed|signed|conformed|final|clean)\b[^)]*)\)/gi, ' ').replace(STATUS, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/(\b(?![A-Z0-9&]+\s)[A-Za-z][\w&]*\s+)(?:Co|co)\b\.?(?=\s|$)/g, '$1Company');   // after a name ("Relecloud Co 2", "Contoso Co."): a company; first in a name or after an abbreviation ("Co 12 - Fence", "EPC Co 12"): a change order
    return { cased: s, hint };
  };
  /** "&" between words is "and", but O&M and A&R stay one word */
  const amp = (s: string) => s.replace(/\s*&\s*/g, (m) => (m.trim() === m ? m : ' and ')).replace(/\s+/g, ' ').trim();
  /** words after "form of" describe the form, not the agreement it belongs to */
  const noForm = (s: string) => s.replace(/\bform of\b.*$/i, ' ');
  /** the patterns a name is read with, made once; they ignore case */
  const RX = {
    relId: new RegExp(`(?:^|\\s)${REL}\\s*-?\\s*${ID}`, 'gi'), ord: new RegExp(`\\b${ORD}\\b`, 'gi'), relWord: new RegExp(REL_WORD.source, 'gi'),
    whole: new RegExp(`^(?:${REL})(?:\\s+(?:no\\.?\\s*)?\\d+)?$`, 'i'),
    forms: [
      new RegExp(`^(?:part\\s+\\w+\\s+of\\s+)?(.*?)(?:^|\\s)(?:${ORD}\\s+)?${REL}\\s*-?\\s*${ID}(?:\\s+${CONN}\\s+(?:the\\s+)?(.*)|[\\s,]+\\S.*)?$`, 'i'),
      new RegExp(`^(.*?)\\b${ORD}\\s+${REL}(?:\\s+${CONN}\\s+(?:the\\s+)?(.*))?$`, 'i'),
      new RegExp(`^()${REL}\\s+${CONN}\\s+(?:the\\s+)?(.+)$`, 'i'),
      new RegExp(`^()(?:${ORD}\\s+)?${REL}$`, 'i'),
    ],
    weak: new RegExp(`^(.+?)\\s+(?:${ORD}\\s+)?${WEAK}$`, 'i'), after: new RegExp(`^(.+?)\\s+${REL}$`, 'i'),
  };
  /** reads a name (case kept, brackets in) as a related document's, or null */
  function relation(withBrackets: string, cased: boolean): Rel | null {
    const whole = withBrackets.replace(/[()]/g, ' '); const p = withBrackets.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const own = (rest: string) => keyOf(noForm(rest).replace(RX.relId, ' ').replace(RX.ord, ' ').replace(/\b(amended and restated|a&r)\b/gi, ' ').replace(RX.relWord, ' '), cased);
    const flat = p.replace(DATES, ' ').replace(/\s+/g, ' ').trim();
    // the whole name a relation word ("Joinder", "Side Letter", "Supplemental Agreement 1")
    if (RX.whole.test(flat)) return { strong: true, phrase: [], own: [] };
    const segs = p.split(/\s+[-–—]\s+/);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i].replace(DATES, ' ').replace(/\s+/g, ' ').trim(); const before = segs.slice(0, i).join(' ');
      const ar = /^(?:amended and restated|a&r)\s+(.+)$/i.exec(s);
      if (ar) return { strong: true, restated: true, phrase: own(ar[1]), own: own(whole) };
      if (/\bsupplemental indentures?\b/i.test(s)) return { strong: true, phrase: ['indenture'], own: own(whole) };
      for (const f of RX.forms) { const r = f.exec(s); if (r) return { strong: true, phrase: own(`${r[1]} ${r[2] ?? ''} ${!r[1] && !r[2] ? before : ''}`), own: own(whole) }; }
      // after a name, a word for a change ("PPA Amendment") will do; a word for a part only after a library name ("ISDA
      // Schedule"), since "Construction Schedule" and "Credit Support Annex" are documents of their own
      const w = RX.weak.exec(s);
      if (w) return { strong: false, phrase: own(w[1]), own: own(whole) };
      const x = RX.after.exec(s); const named = x ? own(x[1]) : [];
      if (named.length && named.every((t) => t.startsWith('#'))) return { strong: false, phrase: named, own: own(whole) };
    }
    return null;
  }
  /** an instrument by its name: an instrument word, or a library name in a name that is not a series' */
  const isInstrument = (pl: string, name: string, cased: boolean) => INSTRUMENT.test(pl) || (!SERIES.test(pl) && groupIds(name, cased).gs.length > 0);
  return { REL, REL_WORD, SERIES, PART, keyOf, rawOf, tidy, amp, relation, isInstrument };
}

/** a folder of precedents: documents from other deals, never an agreement or a member here */
const PRECEDENT = /^(?:\d+\.?\s*)?precedents?(?: documents)?$/i;
const BLACKLINE = /\b(?:redline|blackline)\b/;   // besides blacklines.ts, which reads only PDFs

/**
 * The related documents and series in a data room. Placing is decided from the whole room at once and the documents are
 * read in path order, so the same room gives the same answer on every PC whatever order its files arrive in.
 */
export function docFamilies(input: FamilyInput): DocFamilies {
  const rd = reader(input); const skip = input.skip ?? new Set<string>();
  /** a folder named only by a relation word ("Schedules", "02 Exhibits") says nothing about which agreement */
  const GENERIC_DIR = new RegExp(`^(?:\\d+\\.?\\s*)?(?:${alt(input.relation)}|disclosure schedules?|part \\w+|contract documents)$`, 'i');
  const docs: Doc[] = [...input.docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.docId < b.docId ? -1 : 1)).map((d) => {
    const dirs = d.path.split(/[\\/]/).filter(Boolean); const file = dirs.pop() ?? '';
    const cased = /\p{Ll}/u.test(d.path); const t = rd.tidy(file); const withBrackets = rd.amp(t.cased); const name = withBrackets.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    const pl = name.toLowerCase(); const out = skip.has(d.docId) || BLACKLINE.test(pl) || isBlackline({ name: file }) || dirs.some((f) => PRECEDENT.test(f.trim()));
    const key = rd.keyOf(name, cased);
    return { docId: d.docId, path: d.path, dirs, pl, name, key, keySet: new Set(key), stems: new Set(key.filter((w) => /^[^#]+#/.test(w)).map((w) => `${w.split('#')[0]}#`)), raw: rd.rawOf(name, cased), words: new Set(words(name.replace(DATES, ' '), input.filler)), hint: t.hint, rel: out ? null : rd.relation(withBrackets, cased), versioned: versionOf(file) !== null, agreement: false, parents: [], out, cased };
  });
  // who can be an agreement is decided once, before any document is placed, so the order of placing changes nothing: an
  // instrument with no relation word (or an amended and restated one, or a name ending "Agreement" whose relation word
  // has no number or ordinal and is not "to" another, as in "Supplemental Agreement"), never a "Form of" document
  const ENDS = new RegExp(`(?:^|\\s)${rd.REL}\\s*-?\\s*${ID}`, 'i');
  /** "First Amendment", "Amendment to": a change to another agreement ("Schedule of Rates Agreement" and "Deed of Amendment" stay agreements) */
  const TO = new RegExp(`\\b${ORD}\\s+${rd.REL}|(?:^|\\s)${rd.REL}\\s+(?:to|under|re)\\s`, 'i');
  for (const d of docs) {
    const name = d.pl.replace(DATES, ' ').replace(/\s+/g, ' ').trim();
    d.agreement = !d.out && !/\bform of\b/.test(d.pl) && rd.isInstrument(d.pl, d.name, d.cased) && ((!d.rel && !rd.REL_WORD.test(d.pl)) || !!d.rel?.restated || (/\b(?:agreement|contract|deed)$/.test(name) && !ENDS.test(d.pl) && !TO.test(d.pl)));
    if (d.rel && !d.rel.restated && /\b(?:to|of|under)\s+(?:the\s+)?(?:amended and restated|a&r)\b/.test(d.pl)) d.rel.toRestated = true;
  }
  // each folder's agreements, and those of every folder beneath it
  const under = new Map<string, Doc[]>();
  const push = (m: Map<string, Doc[]>, k: string, d: Doc) => { const l = m.get(k); if (l) l.push(d); else m.set(k, [d]); };
  for (const d of docs) if (d.agreement) for (let k = 0; k <= d.dirs.length; k++) push(under, d.dirs.slice(0, k).join('/'), d);
  // each folder's words, worked out once (".dir" stands for the extension tidy takes off, so a folder keeps its whole name)
  const fwCache = new Map<string, string[]>();
  const fw = (f: string, cased: boolean) => { const k = `${+cased}${f}`; let w = fwCache.get(k); if (!w) { const t = rd.amp(rd.tidy(`${f}.dir`).cased); w = GENERIC_DIR.test(t) ? [] : rd.keyOf(t, cased); fwCache.set(k, w); } return w; };
  const frCache = new Map<string, string[]>();
  const folderRaw = (f: string, cased: boolean) => { const k = `${+cased}${f}`; let w = frCache.get(k); if (!w) frCache.set(k, (w = rd.rawOf(f, cased, true))); return w; };
  const ftCache = new Map<Doc, string[][]>();
  const folderToks = (d: Doc, from: number) => { let l = ftCache.get(d); if (!l) ftCache.set(d, (l = [])); return (l[from] ??= d.dirs.slice(from).flatMap((f) => fw(f, d.cased))); };
  const expand = (ws: Iterable<string>) => [...ws].flatMap((w) => (/^#\d+$/.test(w) ? input.library[+w.slice(1)].flatMap((m) => words(m, input.filler)) : [w]));
  const index = new Map(docs.map((d, i) => [d, i]));
  /** the agreements holding each word, in their name, index hint or folders: where a shared word can be found */
  const byWord = new Map<string, Doc[]>();
  for (const p of docs) if (p.agreement) for (const w of new Set([...p.keySet, ...p.words, ...p.hint, ...folderToks(p, 0)])) push(byWord, w, p);
  /** whether an agreement's name holds a word, as compared or as written ("lease" in "Lease Agreement", which compares as its library group) */
  const has = (p: Doc, w: string) => p.keySet.has(w) || p.words.has(w);

  /** the agreements a related document belongs to: one, or up to three when it can't be told which; none when it can't be placed */
  function place(r: Doc): number[] {
    const rel = r.rel!; const rName = new Set([...rel.own, ...r.hint].filter((w) => !GENERIC.has(w)));
    const need = rel.restated ? rel.own : rel.phrase;
    // its numbers: an agreement that numbers the same thing differently ("Parcel 3", "Parcel 603") is not its agreement
    const nums = rel.own.filter((w) => /^[^#]+#/.test(w)).map((w) => [w, `${w.split('#')[0]}#`] as const);
    const rawR = new Set([...expand([...rName, ...folderToks(r, 0)]), ...r.dirs.flatMap((f) => folderRaw(f, r.cased))]);
    for (let k = r.dirs.length; k >= 0; k--) {
      const up = r.dirs.length - k; const anc = r.dirs.slice(0, k).join('/');
      // words shared below the folder they have in common (that folder's own name is the same for all, so it does not count)
      const rDirs = new Set(folderToks(r, k).filter((w) => !GENERIC.has(w)));
      // two folders up or more only shared words will do, so only agreements that hold one of them are looked at
      let pool = under.get(anc) ?? [];
      if (up > 1) { const hit = new Set<Doc>(); for (const w of [...rName, ...rDirs]) for (const p of byWord.get(w) ?? []) hit.add(p); pool = pool.length > hit.size ? [...hit].filter((p) => !anc || p.dirs.slice(0, k).join('/') === anc).sort((x, y) => index.get(x)! - index.get(y)!) : pool.filter((p) => hit.has(p)); }
      const c = pool.filter((p) => p !== r && !(rel.restated && p.rel)
        && need.every((w) => has(p, w) || (rel.strong && folderToks(p, k).includes(w)))
        && !!rel.toRestated === !!p.rel?.restated && !nums.some(([x, stem]) => !p.keySet.has(x) && p.stems.has(stem)));
      if (!c.length) continue;
      const score = (p: Doc) => { let s = 0; const pd = folderToks(p, k); for (const w of rName) if (has(p, w) || pd.includes(w) || p.hint.includes(w)) s += 2; for (const w of rDirs) if (has(p, w)) s += 1; return s; };
      // then, to break a tie, how much of the agreement's own name the document's name and all its folders cover ("EPC"
      // folder: all of "EPC Contract", a quarter of "Parent Company Guarantee - EPC Contractor")
      const cover = (p: Doc) => { const w = p.raw.length ? p.raw : p.key; return w.filter((x) => rawR.has(x)).length / Math.max(1, w.length); };
      const scored = c.map((p) => ({ p, s: score(p) })); const best = Math.max(...scored.map((x) => x.s));
      let top = scored.filter((x) => x.s === best).map((x) => x.p);
      const covered = top.map(cover); const bc = Math.max(...covered); if (bc > 0) top = top.filter((_, i) => covered[i] === bc);
      // nothing in common with any of them, by name or folder: the one agreement in its own folder will do; anything else can't be told
      if (best === 0 && bc === 0) { if (up === 0 && agreements(top) === 1) return top.map((p) => index.get(p)!); if (up <= 1) return []; continue; }
      if (best === 0 && up > 1) continue;
      return agreements(top) <= MAX_TIED ? top.map((p) => index.get(p)!) : [];
    }
    return [];
  }
  for (const d of docs) if (d.rel) d.parents = place(d);
  // numbered parts in one folder that don't name their agreement ("Schedules/Schedule 1 - Scope", "Schedule 6 - Performance
  // Guarantees") are one set: when two thirds or more of a set of three or more went to one agreement, the rest go there too,
  // so a part's description ("Guarantees") never takes it to another agreement whose name shares a word. A closing set's
  // index ("3.02 Exhibit A") already says whose part it is, so an indexed part is in no set
  const LEAD = new RegExp(`^(?:${ORD}\\s+)?(${rd.REL})\\s*-?\\s*${ID}`, 'i'); const sets = new Map<string, Doc[]>();
  for (const d of docs) { const m = d.rel?.strong && !d.rel.phrase.length && !d.rel.restated && !d.hint.length ? LEAD.exec(d.pl) : null; if (m) push(sets, `${d.dirs.join('/')}\u0000${m[1].replace(/\.$/, '').replace(/e?s$/, '')}`, d); }
  for (const l of sets.values()) {
    if (l.length < 3) continue;
    const votes = new Map<string, number>(); for (const d of l) if (d.parents.length) { const k = d.parents.join(); votes.set(k, (votes.get(k) ?? 0) + 1); }
    const [win, n] = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? ['', 0];
    if (n * 3 >= l.length * 2) for (const d of l) d.parents = win.split(',').map(Number);
  }

  // series: periodic records of one kind (seriesWords) whose names, or folders, differ only by a period. Never a related
  // document, a draft with a version mark or an instrument, and a varying number that names a part (Phase 2, Parcel 12)
  // or is a reference (5 digits or more) makes no series
  const keys = new Map<string, Doc[]>();
  /** a record's own word, or how often it is made: the word a running number follows ("Report 7", "Monthly 7") */
  const RECORD = new RegExp(`^(?:${alt(input.series.flatMap((w) => w.split(/\s+/).slice(-1)))}|daily|weekly|monthly|quarterly|annual|yearly)$`);
  for (const d of docs) {
    if (d.out || d.rel || rd.REL_WORD.test(d.pl) || d.versioned || rd.isInstrument(d.pl, d.name, d.cased) || !rd.SERIES.test(d.pl)) continue;
    const f = (d.dirs.at(-1) ?? '').toLowerCase(); const part = partNumbered(d.pl, rd.PART);
    const tn = tmpl(d.pl, RECORD), tf = tmpl(f, RECORD);
    if (tn.includes('#') && !part && periodic(d.pl)) push(keys, `${d.dirs.join('/')}\u0000${tn}`, d);
    if (tf !== f.replace(/\s+/g, ' ').trim() && periodic(f) && !partNumbered(f, rd.PART) && !part) push(keys, `${d.dirs.slice(0, -1).join('/')}\u0000${tf}/${tn}`, d);
  }
  // the largest first, so a document that could be in two is in the larger; ties by key, so the answer never depends on order
  const seriesOf = new Map<Doc, Doc[]>();
  for (const [, l] of [...keys].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    const free = l.filter((d) => !seriesOf.has(d)); if (free.length >= 3) for (const d of free) seriesOf.set(d, free);
  }
  const series = [...new Set(seriesOf.values())].map((l) => { const yy = twoDigitYears(l); return l.map((d) => ({ d, o: order(d, yy) })); }).map((l) => l.sort((a, b) => (a.o < b.o ? 1 : a.o > b.o ? -1 : 0)).map((x) => x.d.docId));

  const members = new Map<string, string[]>(); const of = new Map<string, string[]>(); const alone = new Set<string>();
  for (const d of docs) if (d.parents.length) {
    of.set(d.docId, d.parents.map((i) => docs[i].docId)); if (oneAgreement(d.parents.map((i) => docs[i]))) alone.add(d.docId);
    for (const i of d.parents) { const l = members.get(docs[i].docId); if (l) l.push(d.docId); else members.set(docs[i].docId, [d.docId]); }
  }
  return { members, of, series, alone };
}

/** the patterns a series is read with, made once */
const MONTH_DATE = new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?${MONTH}\\b\\.?(?:[\\s-]+\\d{1,2}(?:st|nd|rd|th)?\\b)?,?(?:\\s+(?:19|20)\\d{2}\\b)?`, 'g');
const MONTH_YY = new RegExp(`\\b(${MONTH})\\.?[\\s-](\\d{2})(?!\\d)(?![\\s,-]*(?:19|20)\\d{2})`);
const MM_YYYY = new RegExp(`(?<!\\b${MONTH}\\.?[\\s-])\\b(\\d{1,2})[-/]((?:19|20)\\d{2})\\b`);
const PERIOD_WORD = new RegExp(`\\b${MONTH}\\b|\\b(?:q[1-4]|h[12]|fy\\s?\\d{2,4})\\b`);
const MONTH_NN = new RegExp(`\\b${MONTH}\\.?[\\s-](\\d{2})(?!\\d)`);
const MONTH_WORD = new RegExp(`\\b${MONTH}\\b`);
/**
 * A name with its periods each as "#": members of a series share it. A period is a date, month, quarter, half, fiscal
 * year or year, or a running number (No. 7, #7, Week 7, Day 7, or a number right after the record's own word in a daily,
 * weekly, monthly, quarterly or annual record with no other period: "Monthly Report 7"). Any other number stays, so
 * "Q1 2025 Report - Solar 1" and "- Solar 2", or "Monthly Report - Solar 1" and "- Solar 2", differ.
 */
const tmpl = (s: string, record: RegExp) => {
  let t = s.replace(/\b\d{4}[-_. ]\d{1,2}(?:[-_. ]\d{1,2})?\b|\b\d{1,2}[-_. ]\d{1,2}[-_. ]\d{2,4}\b|\b\d{1,2}[-/]\d{4}\b/g, '#')
    .replace(MONTH_DATE, '#')
    .replace(/\b(?:q[1-4]|h[12]|fy\s?\d{2,4})\b|\b(?:19|20)\d{2}\b/g, '#');
  const dated = t !== s;
  t = t.replace(/(\bno\.?|\bnumber|#|\bweek|\bday|\bmonth|\bissue|\bperiod|\bp(?=\d{2}\b))\s*\d+/g, '$1 #');
  if (!dated && /\b(?:daily|weekly|monthly|quarterly|annual|yearly)\b/.test(s)) t = t.replace(/([a-z]+)([\s_-]*)(\d+)\b/g, (m, w: string, sep: string) => (record.test(w) ? `${w}${sep}#` : m));
  return t.replace(/#(?:[-_./ ]*#)+/g, '#').replace(/\s+/g, ' ').trim();
};
/** whether a number names a part (Phase 2, Parcel 12, WTG 07) or is a reference (5 digits or more): then what varies is no period */
const partNumbered = (s: string, part: RegExp) => [...s.matchAll(/\d+/g)].some((m) => m[0].length >= 5 || part.test(s.slice(0, m.index).replace(/[-_. #]+$/, '')));
/** when a member was made, as YYYY-MM-DD, to find the newest: a date, a month, a quarter, a half or a fiscal year; '' if none */
function period(s: string, yy = false): string {
  const d = folderDate(s); if (d) return d;
  const my = yy ? MONTH_YY.exec(s) : null;   // "Nov 24", "Nov-24": a month and a two-digit year (`yy`)
  if (my) return `20${my[2]}-${String(monthNo(my[1])).padStart(2, '0')}-01`;
  let m = /\b(?:q([1-4])[\s-]*((?:19|20)\d{2})|((?:19|20)\d{2})[\s-]*q([1-4]))\b/.exec(s); if (m) return `${m[2] ?? m[3]}-${String((+(m[1] ?? m[4]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  m = /\bh([12])[\s-]*((?:19|20)\d{2})\b/.exec(s); if (m) return `${m[2]}-${m[1] === '1' ? '01' : '07'}-01`;
  // "11-2024", but not the day in "Jun-02-2025"
  m = MM_YYYY.exec(s); if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${m[1].padStart(2, '0')}-01`;
  m = /\bfy\s?((?:19|20)?\d{2})\b/.exec(s) ?? /\b((?:19|20)\d{2})\b/.exec(s); if (m) return `${m[1].length === 2 ? `20${m[1]}` : m[1]}-12-31`;
  return '';
}
/** what varies is a period: a date, month, quarter, half or year, or a running number (No. 7, #7, Week 7, Day 7, or in a monthly, weekly, daily or quarterly record) */
const periodic = (s: string) => !!period(s) || PERIOD_WORD.test(s) || /(?:\bno\.?|\bnumber|#|\bweek|\bday|\bmonth|\bissue|\bperiod|\bp(?=\d{2}\b))\s*\d+/.test(s) || /\b(?:daily|weekly|monthly|quarterly|annual|yearly)\b/.test(s);
/** a member's place in its series, oldest to newest: its period, then its month ("October" in an FY2025 folder), then its numbers, then its path */
const order = (d: Doc, yy: boolean) => { const f = (d.dirs.at(-1) ?? '').toLowerCase(); const nums = `${f} ${d.pl}`.match(/\d+/g)?.map((x) => x.padStart(8, '0')).join('') ?? ''; const mo = MONTH_WORD.exec(d.pl)?.[0]; return `${period(d.pl, yy) || period(f)}|${String(mo ? monthNo(mo) : 0).padStart(2, '0')}|${nums}|${d.path}`; };
/** whether a series names months with a two-digit year ("Nov 24" to "Feb 25"): the numbers after its months repeat, a
 * year's worth of months to each, as years do and days don't ("May 31", "Jun 10", "Jun 11"); members with a four-digit year aside */
const twoDigitYears = (l: Doc[]) => { const ns = l.flatMap((d) => MONTH_NN.exec(d.pl)?.[1] ?? []); return ns.length >= 2 && new Set(ns).size <= Math.max(2, Math.ceil(ns.length / 6)); };
/** a month's number, from its name or short name */
const monthNo = (w: string) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w.slice(0, 3).toLowerCase()) + 1;

/** a folder for a stage of a document ("Executed", "Drafts", "Final"): copies in it and its siblings are in one place */
const STAGE = /^(?:\d+\.?\s*)?(?:executed|execution|signed|final|conformed|clean|drafts?|versions?)(?:\s+(?:copies|copy|versions?|documents?|drafts?))?$/i;
/** one agreement however many drafts and copies: one name, each in the folder of another or beneath it once dated
 * folders are set aside ("PPA/" and "PPA/Drafts/2024-09-10/"), not two projects' contracts of one name */
const oneAgreement = (l: Doc[]) => {
  if (agreements(l) !== 1) return false;
  const at = l.map((p) => `${p.dirs.filter((f) => !folderDate(f) && !STAGE.test(f.trim())).join('/')}/`).sort((a, b) => a.length - b.length);
  return at.every((x) => x.startsWith(at[0]));
};
/** drafts of one agreement (the same name once version marks and status words are off) count as one */
const agreements = (l: Doc[]) => new Set(l.map((p) => p.pl)).size;
