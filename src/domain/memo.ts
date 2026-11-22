/**
 * The deal memo's content: what goes in each section, worked out from the deal's records with no model and no
 * layout. The memo is objective: it reports and never suggests, so nothing here writes advice, a next
 * step or a judgment. The summary, the ratings and the key risks' write-ups come
 * from the model and are passed in; everything else is counted or quoted from the records. `memoDoc.ts` lays it out.
 *
 * Key risks are not findings ("Key risks dont correspond to findings - multiple findings can be a single
 * risk"): the model groups related open findings into risks, and each key risk is written up in a paragraph or two from
 * the documents; smaller risks stay a line or two each.
 */
import type { Deal, Finding, Question, Source } from './model';
import { byName, NO_WORKSTREAM } from './order';
import { splitCited } from './cite';

export type Rating = 'High' | 'Medium' | 'Low';
export const RATINGS: readonly Rating[] = ['High', 'Medium', 'Low'];

/** One checklist item as the memo needs it: the list it comes from, how it stands (as the Overview counts it), and what a gap needs. */
export interface MemoItem { text: string; list: string; kind: 'finding' | 'gap' | 'open' | 'person' | 'satisfied'; need?: string }

export interface MemoInput {
  deal: Deal; firm: string;
  /** the day the memo is made, YYYY-MM-DD */
  today: string;
  /** the deal's findings and questions, deleted ones left out */
  findings: Finding[]; questions: Question[];
  /** the deal's checklist items; null when the deal has none, or they could not be read */
  checklist: MemoItem[] | null;
  /** the model's summary paragraphs; may be empty */
  summary: string[];
  /** the model's rating of each open finding, by id */
  ratings: Record<string, Rating>;
  /** most High and Medium risks in the body; every High one is there whatever this says */
  keyRisks: number;
  /** the model's grouping of the open findings into risks, with the key risks written up; without it each finding is a risk */
  groups?: RiskGroup[];
}

/**
 * A risk as the model grouped it: the open findings it brings together, by id, and for a key risk its write-up, paragraphs
 * with [n] markers into `sources`. A finding in no group is a risk on its own; one named twice counts in the first.
 */
export interface RiskGroup { title: string; findings: string[]; body?: string[]; sources?: Source[] }
/** a group put right against the open findings: its rating is its most severe finding's, its age its oldest finding's */
export interface Grouped extends RiskGroup { rating: Rating | null; raisedAt: string }

/** a passage of a risk's detail, with the numbers of the references it rests on */
export interface MemoPart { text: string; refs: number[] }
/** a key risk: a paragraph or two, the last closing on what is still open */
export interface MemoRisk { rating: Rating; title: string; workstream: string; paras: MemoPart[][]; open: string }
/** a smaller risk: its rating and title, and a sentence or two */
export interface MemoMinor { rating: Rating | null; title: string; workstream: string; detail: MemoPart[] }
export interface Memo {
  deal: string; facts: string[]; firm: string; date: string;
  summary: string[];
  /** counts the app writes itself, after the summary */
  counts: string;
  glance: { workstream: string; High: number; Medium: number; Low: number; open: number }[];
  risks: MemoRisk[];
  /** the other open risks, after the key ones: Medium, then Low, then unrated, each A to Z */
  minor: MemoMinor[];
  /** the references at the back: each once, numbered from 1 in the order the body first cites it */
  refs: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parts = (ymd: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
/** "November 15, 2026" */
export const longDate = (ymd: string) => { const p = parts(ymd); return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : ymd; };
/** "Nov 15", or "Nov 15, 2025" in another year than `today`'s */
const shortDate = (ymd: string, today: string) => { const p = parts(ymd); const t = parts(today); return p ? `${MONTHS[p.m - 1].slice(0, 3)} ${p.d}${t && t.y !== p.y ? `, ${p.y}` : ''}` : ymd; };
const days = (from: string, to: string) => { const a = parts(from); const b = parts(to); return a && b ? Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) : null; };
const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString('en-US')} ${k === 1 ? one : many}`;
/** what one open risk of each rating adds to its workstream's place in the risk-at-a-glance table */
export const RISK_WEIGHT = { High: 9, Medium: 3, Low: 1 } as const;
const weight = (g: { High: number; Medium: number; Low: number }) => g.High * RISK_WEIGHT.High + g.Medium * RISK_WEIGHT.Medium + g.Low * RISK_WEIGHT.Low;
/** most rows in the risk-at-a-glance table, the folded row included: what fits on the first page with the longest summary */
export const GLANCE_ROWS = 12;
/**
 * What is still open on a risk, as the closing sentence of its write-up: the questions asked on its findings that have no
 * response yet, each with the day it was received. Empty when none is open; what the responses said is in the write-up.
 */
export function stillOpen(findings: string[], questions: Question[], today: string): string {
  const qs = questions.filter((q) => q.linkedFinding && findings.includes(q.linkedFinding) && q.status === 'open' && !q.response.trim()).sort((a, b) => a.n - b.n);
  if (!qs.length) return '';
  const each = qs.map((q) => `Q${q.n}${q.received ? ` (${shortDate(q.received, today)})` : ''}`);
  const list = each.length === 1 ? each[0] : `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}`;
  return `${list} ${each.length === 1 ? 'is' : 'are'} still unanswered.`;
}

const byAge = (a: { raisedAt: string }, b: { raisedAt: string }) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0);
const aToZ = <T extends { title: string }>(xs: T[]) => [...xs].sort((a, b) => byName(a.title, b.title));
const severity = (r: Rating | null | undefined) => (r ? RATINGS.indexOf(r) : RATINGS.length);

/**
 * The open findings as risks: each in exactly one, the model's groups first (findings that are not open, or are named
 * again, left out of them; a group left empty dropped), then each finding no group took as a risk of its own.
 */
export function riskGroups(open: { id: string; title: string; raisedAt: string }[], ratings: Record<string, Rating>, groups: RiskGroup[] = []): Grouped[] {
  const byId = new Map(open.map((f) => [f.id, f])); const taken = new Set<string>(); const out: Grouped[] = [];
  const make = (g: RiskGroup, ids: string[]): Grouped => {
    const fs = ids.map((id) => byId.get(id)!);
    const rating = fs.map((f) => ratings[f.id]).filter(Boolean).sort((a, b) => severity(a) - severity(b))[0] ?? null;
    return { ...g, title: g.title.replace(/\s+/g, ' ').trim() || fs[0].title, findings: ids, rating, raisedAt: fs.map((f) => f.raisedAt).sort()[0] };
  };
  for (const g of groups) {
    const ids = [...new Set(g.findings)].filter((id) => byId.has(id) && !taken.has(id)); if (!ids.length) continue;
    for (const id of ids) taken.add(id);
    out.push(make(g, ids));
  }
  for (const f of open) if (!taken.has(f.id)) out.push(make({ title: f.title, findings: [f.id] }, [f.id]));
  return out;
}

/**
 * Which risks are key: every High one, then the oldest Medium ones up to `keyRisks`, each severity A to Z by title.
 * The rest are the smaller risks: the
 * Medium ones left, then Low, then unrated, each A to Z. The backend picks which to write up by the same rule.
 */
export function keyRisksOf(all: Grouped[], keyRisks: number): { key: Grouped[]; rest: Grouped[] } {
  const high = all.filter((g) => g.rating === 'High').sort(byAge); const medium = all.filter((g) => g.rating === 'Medium').sort(byAge);
  const key = [...aToZ(high), ...aToZ(medium.slice(0, Math.max(0, keyRisks - high.length)))]; const inKey = new Set(key);
  return { key, rest: [...aToZ(medium.filter((g) => !inKey.has(g))), ...aToZ(all.filter((g) => g.rating === 'Low')), ...aToZ(all.filter((g) => !g.rating))] };
}

/** the first sentence or two of a paragraph, up to about 240 characters: a smaller risk's line */
const opening = (parts: MemoPart[]) => { const out: MemoPart[] = []; let len = 0; for (const x of parts) { if (len && (len + x.text.length > 240 || out.filter((y) => y.refs.length).length >= 2)) break; out.push(x); len += x.text.length; } return out.length && !out[out.length - 1].text.trim() ? out.slice(0, -1) : out; };

export function memoContent(i: MemoInput): Memo {
  const open = i.findings.filter((f) => f.status === 'open');
  const rated = (r: Rating) => open.filter((f) => i.ratings[f.id] === r);
  const refs: string[] = []; const refOf = (s: Source) => { const label = `${s.doc.replace(/\.[a-z0-9]{2,5}$/i, '')}${s.loc ? `, ${s.loc}` : ''}`; let k = refs.indexOf(label); if (k < 0) { refs.push(label); k = refs.length - 1; } return k + 1; };
  const cited = (text: string, sources: Source[]) => splitCited(text, sources.length).map((p) => ({ text: p.text, refs: p.refs.map((r) => refOf(sources[r - 1])) }));
  const byId = new Map(open.map((f) => [f.id, f]));
  const workstreams = (g: Grouped) => [...new Set(g.findings.map((id) => byId.get(id)!.workstream.trim() || NO_WORKSTREAM))].sort(byName).join(', ');
  // a finding's own words: its first paragraph, as written
  const own = (f: Finding) => cited(f.body.find((p) => p.trim()) ?? '', f.sources);
  const { key, rest } = keyRisksOf(riskGroups(open, i.ratings, i.groups), i.keyRisks);
  const risks: MemoRisk[] = key.map((g) => {
    const fs = g.findings.map((id) => byId.get(id)!); const sources = g.sources ?? [];
    // the model's write-up when there is one; else each finding's own first paragraph, as before
    const written = (g.body ?? []).map((p) => p.trim()).filter(Boolean);
    const paras = written.length ? written.map((p) => cited(p, sources)) : fs.map(own).filter((p) => p.length);
    return { rating: g.rating!, title: g.title, workstream: workstreams(g), paras, open: stillOpen(g.findings, i.questions, i.today) };
  });
  // a smaller risk of several findings reads each one's opening in turn, held to the same length
  const minor: MemoMinor[] = rest.map((g) => ({ rating: g.rating, title: g.title, workstream: workstreams(g), detail: opening(g.findings.flatMap((id, j) => { const ps = own(byId.get(id)!); return j && ps.length ? [{ text: ' ', refs: [] }, ...ps] : ps; })) }));
  const openQs = i.questions.filter((q) => q.status === 'open');
  // one row per workstream, never merged with a workstream actually named "Other", ranked by its weighted risk
  // count: a High counts 9, a
  // Medium 3, a Low 1 (RISK_WEIGHT). Equal weights go to more High, then more Medium, then more open questions, then A to
  // Z, "No workstream" ranked the same way and after the others only on a full tie
  // It counts risks, not findings, as the counts above it do: a risk of several findings is
  // counted once, under the workstream of its most severe finding (the oldest of those on a tie), so the rows add up to
  // the number of risks.
  const head = (w: string) => w.trim() || NO_WORKSTREAM;
  const home = (g: Grouped) => head(g.findings.map((id) => byId.get(id)!).sort((a, b) => severity(i.ratings[a.id]) - severity(i.ratings[b.id]) || byAge(a, b))[0].workstream);
  const risksIn = [...key, ...rest].map((g) => ({ rating: g.rating, workstream: home(g) }));
  const ws = [...new Set([...risksIn.map((r) => r.workstream), ...openQs.map((q) => head(q.workstream))])];
  const glance = ws.map((w) => {
    const rs = risksIn.filter((r) => r.workstream === w);
    return { workstream: w, High: rs.filter((r) => r.rating === 'High').length, Medium: rs.filter((r) => r.rating === 'Medium').length, Low: rs.filter((r) => r.rating === 'Low').length, open: openQs.filter((q) => head(q.workstream) === w).length };
  }).sort((a, b) => weight(b) - weight(a) || b.High - a.High || b.Medium - a.Medium || b.open - a.open || Number(a.workstream === NO_WORKSTREAM) - Number(b.workstream === NO_WORKSTREAM) || byName(a.workstream, b.workstream));
  // the first page is the summary and nothing else: past GLANCE_ROWS rows, the
  // lowest-ranked are added up in one "Other workstreams" row, so the table and the longest summary still fit on it
  if (glance.length > GLANCE_ROWS) {
    const rest = glance.splice(GLANCE_ROWS - 1);
    glance.push(rest.reduce((t, g) => ({ ...t, High: t.High + g.High, Medium: t.Medium + g.Medium, Low: t.Low + g.Low, open: t.open + g.open }), { workstream: `Other workstreams (${rest.length})`, High: 0, Medium: 0, Low: 0, open: 0 }));
  }

  const items = i.checklist ?? [];
  const oldestQ = openQs.filter((q) => q.received).sort((a, b) => (a.received < b.received ? -1 : 1))[0];
  const age = oldestQ ? days(oldestQ.received, i.today) : null;

  const k = (kind: MemoItem['kind']) => items.filter((x) => x.kind === kind).length;
  const counts = [
    // counted as risks, as the summary and the body speak of them (several findings can be one risk)
    open.length ? `${n(open.length, 'open finding')} in ${n(key.length + rest.length, 'risk')}: ${RATINGS.map((r) => `${[...key, ...rest].filter((g) => g.rating === r).length} ${r}`).join(', ')}.` : 'No open findings.',
    items.length ? `Of ${n(items.length, 'checklist item')}, ${(k('satisfied') + k('person')).toLocaleString('en-US')} ${k('satisfied') + k('person') === 1 ? 'is' : 'are'} settled, ${k('finding').toLocaleString('en-US')} flagged and ${n(k('gap'), 'gap')}${k('open') ? `; ${k('open').toLocaleString('en-US')} not settled` : ''}.` : '',
    `${n(openQs.length, 'question')} to the counterparty ${openQs.length === 1 ? 'is' : 'are'} open${oldestQ && age !== null && age >= 0 ? `; the oldest, Q${oldestQ.n}, was received ${n(age, 'day')} ago` : ''}.`,
  ].filter(Boolean).join(' ');

  const d = i.deal;
  return {
    deal: d.name, facts: [d.counterparty, d.product, d.sector, d.technology].map((x) => x.trim()).filter(Boolean),
    firm: i.firm, date: longDate(i.today),
    summary: i.summary, counts, glance, risks, minor, refs,
  };
}
