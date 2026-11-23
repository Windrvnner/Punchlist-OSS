/**
 * Search across the person's own deals: deals, findings, checklist items, the documents findings cite, and
 * questions. Pure over state; the palette loads unvisited deals' records first.
 */
import type { Store } from './store';
import { type State, type UiState, dealQuestions, dealFindings, dealHash, dealTwinLabels } from './state';
import { conversationDocs, docIndex } from './conversations';
import { docKey } from '../domain/model';
import type { Item } from '../domain/checklist';
import { isMine } from './commands/members';

export type HitKind = 'deal' | 'finding' | 'item' | 'question' | 'document';
// The deal, its disambiguator and the place within the deal (for example, Q7 or p. 4).
export interface Place {
  deal: string;
  twin: string;
  focus?: string;
  at: string;
}

export interface Hit {
  key: string;
  kind: HitKind;
  title: string;
  where: string;
  hash: string;
  tip?: string;
  place?: Place;
  twinFocus?: string;
  ui?: Partial<UiState>;
  doc?: { doc: string; docId: string };
}
export const MAX_HITS = 12;
/** How many of each type show before "+N more". */
export const GROUP_SHOWN = 5;
/**
 * How many more each "+N more" shows. A type can match thousands (a broad word across deals of 2,000 checklist items), and
 * the panel lays every row it holds out again as it moves: it opens up a page at a time, never all at once.
 */
export const GROUP_PAGE = 50;
export const GROUP_LABEL: Record<HitKind, string> = {
  deal: 'Deals', finding: 'Findings', item: 'Checklist Items', question: 'Questions', document: 'Documents',
};

/** Compare without case, accents or stray spacing: "resume" finds "Résumé", "lock  up" finds "lock up". */
export const fold = (x: string) => x.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** letters and digits only, for matching across hyphens and spaces */
const squash = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, '');
/**
 * A deal's checklist items as one text to search: every wording folded, one to a line, and again with only its letters and
 * digits, each with where its items start. Made once for as long as the items stand as they are (an item changed, added or
 * turned off is a new object, and a new set of them), so a keystroke runs one native search over each deal's text instead
 * of testing 2,000 wordings one by one: across a person's deals of 2,000 items each, that was most of a keystroke's time.
 */
interface ItemIndex { items: { id: string; text: string }[]; text: string; starts: number[]; sq: string; sqStarts: number[]; words: (string[] | undefined)[] }
const indexes = new WeakMap<object, ItemIndex>();
/** the latest index of each deal's list, kept by the deal: a change to one item elsewhere (a sync, a deal loading) leaves the others' lists the same items */
const latest = new Map<string, ItemIndex>();
function indexOf(items: { id: string; text: string }[], key: string): ItemIndex {
  let x = indexes.get(items); if (x) return x;
  const was = latest.get(key);
  if (was && was.items.length === items.length && was.items.every((it, i) => it === items[i])) { indexes.set(items, was); return was; }
  const folded = items.map((it) => fold(it.text)), squashed = folded.map(squash);
  const starts: number[] = [], sqStarts: number[] = []; let a = 0, b = 0;
  for (let i = 0; i < items.length; i++) { starts.push(a); a += folded[i].length + 1; sqStarts.push(b); b += squashed[i].length + 1; }
  indexes.set(items, (x = { items, text: folded.join('\n'), starts, sq: squashed.join('\n'), sqStarts, words: [] })); latest.set(key, x); return x;
}
/** which item a place in the joined text falls in */
const itemAt = (starts: number[], at: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= at) lo = m; else hi = m - 1; } return lo; };
/** the items whose wording holds `q`, in their order, once each */
function matching(x: ItemIndex, l: string, lq: string): number[] {
  const hit = new Set<number>(); if (!l) return [];   // an empty query would find a place at every character
  for (let at = x.text.indexOf(l); at >= 0; at = x.text.indexOf(l, at + 1)) { const i = itemAt(x.starts, at); hit.add(i); at = (x.starts[i + 1] ?? x.text.length) - 1; }
  // with or without the hyphen or space: "lockup" and "lock up" both find "Lock-up"
  if (lq.length >= 3) for (let at = x.sq.indexOf(lq); at >= 0; at = x.sq.indexOf(lq, at + 1)) { const i = itemAt(x.sqStarts, at); hit.add(i); at = (x.sqStarts[i + 1] ?? x.sq.length) - 1; }
  return hit.size === x.items.length ? x.items.map((_, i) => i) : [...hit].sort((p, q) => p - q);
}
/** how well an item's wording answers the query, from its folded text in the index */
function itemRank(x: ItemIndex, i: number, l: string) {
  const at = x.starts[i]; if (x.text.startsWith(l, at)) return 0;
  const w = (x.words[i] ??= wordsOf(x.text.slice(at, (x.starts[i + 1] ?? x.text.length + 1) - 1)));
  return w.some((v) => v.startsWith(l)) ? 1 : 2;
}
/** each deal's items, gathered once for as long as the items stand as they are, in the deal's own order */
const byDeal = new WeakMap<object, Map<string, Item[]>>();
function itemsByDeal(items: Record<string, Item>) {
  let m = byDeal.get(items); if (m) return m;
  m = new Map(); for (const it of Object.values(items)) { const of = m.get(it.dealId); if (of) of.push(it); else m.set(it.dealId, [it]); }
  byDeal.set(items, m); return m;
}
const wordsOf = (folded: string) => folded.split(/[^\p{L}\p{N}]+/u);
/** how well a folded title answers the query: it starts with it (0), a word does (1), or it holds it elsewhere (2) */
const rankOf = (t: string, l: string) => t.startsWith(l) ? 0 : wordsOf(t).some((w) => w.startsWith(l)) ? 1 : 2;

/** Every match, best first within its type (titles that start with the query, then a word that does, then the rest), checklist items after the other types. */
export const allHits = (s: State, query: string): Hit[] => gather(s, query, Infinity).hits;

/**
 * The matches, best first within each type, with only the first `itemsShown` checklist items made into results and the rest
 * counted. A broad word can match most of 20,000 items across a person's deals: making and sorting a result for each of them,
 * to show five, was most of each keystroke's time (#2), so the items' matches are kept by rank as they are found.
 */
function gather(s: State, query: string, itemsShown: number): { hits: Hit[]; items: number } {
  const l = fold(query); const out: Hit[] = []; const lq = squash(l);
  // each item that matches, with the deal's way of making it a result, kept by rank in the order found (no sort needed)
  type Found = { it: { id: string; text: string }; make: (it: { id: string; text: string }) => Hit }; const found: [Found[], Found[], Found[]] = [[], [], []]; let items = 0;
  // with or without the hyphen or space: "lockup" and "lock up" both find "Lock-up"
  const has = (...parts: (string | number)[]) => { const t = fold(parts.join(' ')); return t.includes(l) || (lq.length >= 3 && squash(t).includes(lq)); };
  const twinOf = dealTwinLabels(Object.values(s.deals));
  const itemsOf = itemsByDeal(s.items);
  for (const d of Object.values(s.deals).filter((x) => isMine(s, x.id))) {   // the person's own deals: others are joined through Add deal
    // a deal that shares its name says on its second line only what differs, as the sidebar does; the hover gives both
    if (!l || has(d.name, d.target, d.counterparty, d.product, d.sector, d.technology)) {
      const focus = twinOf(d, 'focus');
      out.push({
        key: d.id, kind: 'deal', title: d.name, where: twinOf(d, true) || d.sector,
        tip: twinOf(d) || d.sector, ...(focus && { twinFocus: focus }), hash: dealHash(s.prefs, d.id),
      });
    }
    if (!l) continue;
    // a hit inside a deal names it, and where another deal has the same name, its counterparty and the day it was made
    // whole in `where` (the hover); the row, short of room, shows only what differs, as the sidebar does
    // Work out the labels only for deals with a match.
    let twins: [string, string, string] | undefined;
    const inDeal = (place = ''): Pick<Hit, 'where' | 'place'> => {
      const [twin, short, focus] = twins ??= [twinOf(d), twinOf(d, true), twinOf(d, 'focus')];
      const at = place.replace(/\s+/g, ' ').trim();
      return {
        where: [d.name, twin, at].filter(Boolean).join(' · '),
        place: { deal: d.name, twin: short, ...(focus && { focus }), at },
      };
    };
    for (const f of dealFindings(s, d.id)) {
      const hash = `finding-${d.id}-${f.id}`;
      if (has(f.title, f.workstream, f.body.join(' ').replace(/\s*\[\d+\]/g, ''))) out.push({ key: f.id, kind: 'finding', title: f.title, ...inDeal(), hash });
      const docs = conversationDocs(s, { kind: 'finding', dealId: d.id, findingId: f.id });
      const seen = new Set<string>();
      for (const src of f.sources) {
        const k = `${docKey(src)}|${src.loc ?? ''}`; if (seen.has(k) || !fold(src.doc).includes(l)) continue; seen.add(k);
        out.push({ key: `${f.id}|${k}`, kind: 'document', title: src.doc, ...inDeal(src.loc ?? ''), hash, ui: { doc: docIndex(docs, src) }, doc: { doc: src.doc, docId: src.docId } });
      }
    }
    // a deal's checklist items (decisions: "Checklist items appear in search"), turned off ones too, as its Checklist lists
    // them; a deal with no items of its own lists what its check holds, once its Checklist has been read
    const own: { id: string; text: string }[] = itemsOf.get(d.id) ?? []; const rows = s.checklists[d.id];
    let here: ReturnType<typeof inDeal> | undefined;   // an item has no place in the deal, so every item hit in it says the same
    const make = (it: { id: string; text: string }): Hit => ({ key: `item|${d.id}|${it.id}`, kind: 'item', title: it.text, ...(here ??= inDeal()), hash: `checklist-${d.id}`, ui: { selectedChecklist: it.id, checklistFilter: 'all' } });
    const list = own.length || !Array.isArray(rows) ? own : rows;
    if (list.length) { const x = indexOf(list, `${list === own ? 'items' : 'rows'}|${d.id}`); for (const i of matching(x, l, lq)) { found[itemRank(x, i, l)].push({ it: x.items[i], make }); items++; } }
    for (const q of dealQuestions(s, d.id)) if (has(q.text, 'q' + q.n, q.response)) out.push({ key: q.id, kind: 'question', title: q.text || `Q${q.n}`, ...inDeal(`Q${q.n}`), hash: `qa-${d.id}`, ui: { selectedQuestion: q.id, qaFilter: { status: 'all', workstream: '', text: '' } } });
  }
  if (!l) return { hits: out, items: 0 };
  const rank = (h: Hit) => rankOf(fold(h.title), l);
  const hits = out.map((h, i) => ({ h, r: rank(h), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.h);
  // the items shown, best rank first and in the order found within a rank, made into results only now
  for (const rank of found) for (let i = 0; i < rank.length && hits.length - out.length < itemsShown; i++) hits.push(rank[i].make(rank[i].it));
  return { hits, items };
}

/** The first few matches, best first within each type; checklist items come after the other types. */
export const search = (s: State, query: string): Hit[] => allHits(s, query).slice(0, MAX_HITS);

export interface HitGroup { kind: HitKind; label: string; hits: Hit[]; /** how many more of this type match but are not shown (its "+N more" names at most a page of them, what a click adds) */ more: number }
/** Matches grouped by type. A type shows its first few; `expanded` names a type once for each "+N more" chosen on it, each showing a page more. */
export function searchGroups(s: State, query: string, expanded: readonly HitKind[] = []): HitGroup[] {
  const shown = (kind: HitKind) => GROUP_SHOWN + GROUP_PAGE * expanded.filter((k) => k === kind).length;
  const all = gather(s, query, shown('item'));
  return (['deal', 'finding', 'item', 'question', 'document'] as const).map((kind) => {
    const of = all.hits.filter((h) => h.kind === kind); const hits = of.slice(0, shown(kind));
    return { kind, label: GROUP_LABEL[kind], hits, more: (kind === 'item' ? all.items : of.length) - hits.length };
  }).filter((g) => g.hits.length);
}

/**
 * Load the records of every deal not yet visited, so search covers them. No AI calls. A deal with no checklist items of its
 * own has its check's items read too, once, so they can be found as well.
 */
export async function loadAllForSearch(store: Store) {
  const mine = Object.keys(store.get().deals).filter((id) => isMine(store.get(), id));
  await Promise.all(mine.map((id) => store.loadDeal(id, { gaps: false })));
  const s = store.get(); const withItems = new Set(Object.values(s.items).map((it) => it.dealId));
  await Promise.all(mine.filter((id) => s.deals[id] && s.checklists[id] === undefined && !withItems.has(id)).map((id) => store.refreshChecklist(id)));
  // every deal's items indexed now, while the person is still typing their first letter, not on that letter
  const now = store.get(); for (const [id, list] of itemsByDeal(now.items)) indexOf(list, `items|${id}`);
  for (const [id, rows] of Object.entries(now.checklists)) if (Array.isArray(rows) && rows.length) indexOf(rows, `rows|${id}`);
}
