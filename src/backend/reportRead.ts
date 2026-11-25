/**
 * Step 3 of the third-party reports sweep (reports.ts): the standard model reads one report through for the issues it
 * raises, a page of issues at a time, and each issue becomes a finding, unless a finding on the deal already covers it.
 */
import type { DocRecord } from './documents';
import type { Cited } from './agent';
import type { Source } from '../domain/model';
import { list as listOf, strings, tagNumber } from './lenient';
import {
  type ReportKit, type ReadLine, type ReadIssue, type Known, type Issue, type SentDoc,
  ISSUE_PAGE, isCut, partialOf, yes,
} from './reportTypes';

/** sentences of one paragraph, written out for the model */
const sentences = (...parts: string[]) => parts.join(' ');

/** the opening of the prompt: what to list, and what to leave out */
function issuesAsk(k: ReportKit, tag: string) {
  const what = sentences(
    `${tag} is a report by an outside advisor or consultant on this deal.`,
    'List every issue the advisor raises in it: anything they flag as a problem, risk, concern, shortfall,',
    'non-compliance, a missing, expired or doubtful permit, consent or license, or a point still open for the',
    'lenders or the deal. Where it is unclear whether something is an issue, list it.',
    'Leave out notes on the limits of the advisor’s own work, such as what they could not verify because of their',
    'scope or method ("as this was desktop research we could not verify the soil quality"),',
    'and their plain description of the project.',
  );
  const how = sentences(
    'Write each issue up as a finding: a one-line "title",',
    `a "workstream" (one of ${k.workstreams.join(' | ')}, or "" when unsure),`,
    'a "body" of one or two paragraphs with [n] markers that names the advisor and says what they raised,',
    `and "sources" citing the page of ${tag} where it is raised.`,
    'Number each issue’s markers from [1].',
  );
  return `${what}\n${how}`;
}

/** the deal's findings, so an issue one already covers is named rather than raised again */
function knownAsk(tag: string, known: Known[]) {
  if (!known.length) return '';
  const mark = (f: Known) => (f.deleted ? ' (deleted)' : f.closed ? ' (closed)' : '');
  const listed = known.map((f, i) => `F${i + 1}: ${f.title}${mark(f)}`).join('\n');
  const rule = sentences(
    'An issue an open finding, or one marked (deleted), already covers is given as {"covered": "F3"}',
    `with its "sources", the page of ${tag} where it is raised, and nothing else.`,
    'An issue only a finding marked (closed) covers is written up in full like any other, with "earlier": "F3".',
  );
  return `\n\nThese findings are already on the deal:\n${listed}\n${rule}`;
}

/** what an earlier draft of the report raised, so a new draft raises only what is new */
function earlierAsk(tag: string, before: ReadIssue[] | undefined) {
  if (!before?.length) return '';
  const listed = before.map((x, i) => `E${i + 1}: ${x.title}`).join('\n');
  const rule = sentences(
    'An issue it raised that this report still raises is given as {"still": "E2"}',
    `with its "sources", the page of ${tag} where it is raised now, and nothing else.`,
    'Put in "dropped" the E numbers of those this report no longer raises.',
  );
  return `\n\nAn earlier draft of this report raised these issues:\n${listed}\n${rule}`;
}

/** the reply's shape, and the page of issues asked for */
function replyAsk(tag: string, before: ReadIssue[] | undefined, after: string | undefined, size: number) {
  const source = (page: number) => `"sources": [{"doc": "${tag}", "page": ${page}, "quote": "…"}]`;
  const full = `{"title": "…", "workstream": "…", "body": ["…"], ${source(12)}}`;
  const still = before?.length ? `, {"still": "E1", ${source(8)}}` : '';
  const dropped = before?.length ? '"dropped": ["E1"], ' : '';
  const advisor = sentences(
    'Also give "advisor": who wrote the report, in a few words (such as "the independent engineer").',
    `If ${tag} is not in fact a report by an outside advisor, reply {"report": false}.`,
  );
  const from = after ? `, starting after the issue you titled "${after}"` : '';
  const page = sentences(
    `Give at most ${size} issues, in the order the report raises them${from},`,
    'and set "more" to true if it raises issues after the last you give.',
  );
  const issues = `[${full}, {"covered": "F2", ${source(30)}}${still}]`;
  const shape = `Reply as JSON: {"advisor": "…", "issues": ${issues}, ${dropped}"more": false}`;
  return `\n${advisor}\n${page}\n${shape}`;
}

/** where a read has got to, as the prompt needs it */
interface ReadAt { k: ReportKit; s: SentDoc; before?: ReadLine; after?: string; size: number }

/** the prompt that reads a page of a report's issues */
export function readAsk(r: ReadAt, known: Known[]) {
  const tag = r.s.sent[0].tag;
  const body = issuesAsk(r.k, tag) + knownAsk(tag, known) + earlierAsk(tag, r.before?.issues);
  return `Documents:\n${r.s.listing}\n\n${body}${replyAsk(tag, r.before?.issues, r.after, r.size)}`;
}

/** a finding this report raised: its id is the one `idFor` gives the report and its title */
function isOwn(k: ReportKit, doc: string, f: Known) {
  for (let n = 1; n <= 5; n++) if (k.idFor(doc, f.title, n) === f.id) return true;
  return false;
}

const titleOf = (row: Record<string, unknown>) => (typeof row.title === 'string' ? row.title.trim() : '');

/** One read of one report through, a page of issues at a time: what it has found so far. */
class ReportRead {
  issues: ReadIssue[] = [];
  advisor = '';
  /** findings of the earlier draft's issues this draft no longer raises */
  dropped = new Set<string>();
  /** the title of the last issue given, for the next page to start after */
  after: string | undefined;
  size = ISSUE_PAGE;
  /** the pages each title was raised on: the same title on the same page is a page given again */
  titles = new Map<string, Set<string>>();
  /** issues given with no page that opens */
  unplaced = 0;
  /** pages that could not be added to a finding now: a later sweep adds them */
  owe = new Map<string, Source[]>();

  constructor(
    readonly k: ReportKit,
    readonly rec: DocRecord,
    readonly s: SentDoc,
    readonly before: ReadLine | undefined,
  ) {}

  /** the places in the report a row cites, kept only where they open */
  placed(row: Record<string, unknown>) {
    return this.k.fit('', row.sources as Cited[], this.s.sent).sources;
  }

  /** add the report's pages to a finding's sources; one that cannot be added now is owed */
  async cite(id: string, places: Source[]) {
    if (!places.length || (await this.k.cite(id, places))) return;
    this.owe.set(id, [...(this.owe.get(id) ?? []), ...places]);
  }

  /** One row of a reply. False when a finding could not be written: the read is not done, and is asked again. */
  async take(row: Record<string, unknown>, known: Known[]): Promise<boolean> {
    // an issue the earlier draft raised and this one still does: the report's page is added to its finding
    const was = this.before?.issues[(tagNumber(row.still, 'E') ?? 0) - 1];
    const stillAt = was?.finding ?? was?.covered;
    if (stillAt) { await this.cite(stillAt, this.placed(row)); return true; }
    const covering = known[(tagNumber(row.covered, 'F') ?? 0) - 1];
    const title = titleOf(row);
    // one only a closed finding covers is raised again, so it must come written out: as covered only, it has no page
    if (covering?.closed && !covering.deleted && !title) { this.unplaced++; return true; }
    if (covering && !(covering.closed && title)) { await this.covered(row, covering); return true; }
    if (!title) return true;
    return this.raise(row, title, known, covering);
  }

  /** an issue a finding already covers raises none, whatever else the reply gives with it */
  async covered(row: Record<string, unknown>, f: Known) {
    // the report is a source of the finding that covers its issue, whoever raised it; a deleted one is left as it is
    if (!f.deleted) await this.cite(f.id, this.placed(row));
    // a finding this report raised itself, in a read that did not finish, is its own: a later draft that drops it
    // marks it
    const own = isOwn(this.k, this.rec.docId, f);
    this.issues.push(own ? { title: f.title, finding: f.id } : { title: f.title, covered: f.id });
  }

  /** a new issue: a finding of its own */
  async raise(row: Record<string, unknown>, title: string, known: Known[], covering?: Known): Promise<boolean> {
    const k = this.k;
    const fitted = k.fit(strings(row.body).join('\n\u0000\n'), row.sources as Cited[], this.s.sent);
    // an issue stands on a page of the report a person can open, as any finding does
    if (!fitted.text || !fitted.sources.length) { this.unplaced++; return true; }
    // the same title on the same page is a page given again; on another page it is another issue of that name
    const same = title.toLowerCase().replace(/\s+/g, ' ');
    const pages = this.titles.get(same) ?? new Set<string>();
    if (pages.has(fitted.sources[0].loc)) return true;
    pages.add(fitted.sources[0].loc);
    this.titles.set(same, pages);
    const id = k.idFor(this.rec.docId, title, pages.size);
    const issue: Issue = {
      title,
      workstream: k.workstreamOf(row.workstream),
      body: k.fitParas(fitted.text.split(/\s*\u0000\s*/).filter(Boolean)),
      sources: fitted.sources,
    };
    // a closed finding on the same issue is named: a wrong number falls back to the one given as covering it
    const was = known[(tagNumber(row.earlier, 'F') ?? 0) - 1] ?? covering;
    if (was?.closed && !was.deleted) issue.earlier = was.id;
    if (!(await k.raise(id, issue))) return false;
    this.issues.push({ title, finding: id });
    return true;
  }

  /** each row of a reply, in order. False when a finding could not be written */
  async takeAll(rows: Record<string, unknown>[], known: Known[]) {
    for (const row of rows) {
      if (row && typeof row === 'object' && !(await this.take(row, known))) return false;
    }
    return true;
  }

  /** ask for fewer issues a page; false when one at a time is already too long */
  smaller() {
    if (this.size === 1) return false;
    this.size = Math.max(1, Math.floor(this.size / 2));
    return true;
  }

  /** the next page starts after the last issue given */
  moveOn(rows: Record<string, unknown>[]) {
    const lastRow = rows[rows.length - 1];
    this.after = (lastRow && titleOf(lastRow)) || this.issues[this.issues.length - 1]?.title || this.after;
  }

  /** what the reply says beside its issues: who wrote the report, and which of the earlier draft's it drops */
  heard(reply: Record<string, unknown>) {
    const advisor = typeof reply.advisor === 'string' ? reply.advisor.trim() : '';
    if (advisor && !this.advisor) this.advisor = advisor.slice(0, 120);
    for (const e of strings(reply.dropped)) {
      const f = this.before?.issues[(tagNumber(e, 'E') ?? 0) - 1]?.finding;
      if (f) this.dropped.add(f);
    }
  }

  /** the line to write. What the earlier draft raised and this one still does is carried over, for the next draft */
  line(): ReadLine {
    const kept = (this.before?.issues ?? []).filter((x) => !(x.finding && this.dropped.has(x.finding)));
    const owe = [...this.owe].map(([finding, sources]) => ({ finding, sources }));
    return {
      doc: this.rec.docId,
      advisor: this.advisor || this.before?.advisor || '',
      issues: [...kept, ...this.issues],
      ...(this.before ? { from: this.before.doc, dropped: [...this.dropped] } : {}),
      ...(this.unplaced ? { unplaced: this.unplaced } : {}),
      ...(owe.length ? { owe } : {}),
    };
  }
}

/** one page of issues from the model; a reply cut off comes back with `cut` and what came back whole */
async function askPage(r: ReportRead, known: Known[]) {
  const k = r.k;
  const prompt = readAsk(r, known);
  const input = { kind: 'report', split: true, model: k.models.standard, system: k.system, files: r.s.files, prompt };
  try {
    return { reply: await k.ask(input, ['issues', 'report']), cut: false };
  } catch (e) {
    if (!isCut(e)) throw e;
    return { reply: partialOf(e), cut: true };
  }
}

/** a reply that says the document is not a report by an outside advisor, and gives no issues */
const notReport = (reply: Record<string, unknown>) => 'report' in reply && !yes(reply.report) && !('issues' in reply);

/** a reply that does not say whether more follow, and is a full page, is taken to have more */
function hasMore(reply: Record<string, unknown>, rows: unknown[], size: number) {
  return yes(reply.more) || (!('more' in reply) && rows.length >= size);
}

/** the rows of a reply; the last before a cut may itself be cut short, so it is left for the next page */
function rowsOf(reply: Record<string, unknown> | null, cut: boolean) {
  const all = reply ? (listOf(reply.issues) as Record<string, unknown>[]) : [];
  return cut ? all.slice(0, -1) : all;
}

/** what one page of a read comes to: the read's end, or `'next'` to ask for the next page */
type Step = { end: ReadLine | 'not' | 'lost' | null } | 'next';

/** Ask for one page of issues and take what comes back. */
async function readPage(r: ReportRead, call: number, last: boolean): Promise<Step> {
  // the claim is kept up while the read goes on, so a long read does not lapse and let another PC read it too
  if (call && !(await r.k.claim([`reports:read:${r.rec.docId}`])).length) return { end: 'lost' };
  const known = await r.k.findings();
  const page = await askPage(r, known);
  // only the first page can say it is not a report: findings raised from earlier pages say otherwise
  if (!call && page.reply && notReport(page.reply)) return { end: 'not' };
  const reply = page.reply && notReport(page.reply) ? null : page.reply;
  const rows = rowsOf(reply, page.cut);
  if (page.cut && !rows.length) return r.smaller() ? 'next' : { end: null };   // too long to come back whole
  if (!reply) return { end: null };
  r.heard(reply);
  if (!(await r.takeAll(rows, known))) return { end: null };
  r.moveOn(rows);
  if (!page.cut && (!rows.length || !hasMore(reply, rows, r.size))) return { end: finish(r, last) };
  return 'next';
}

/**
 * Read one report through. Returns the line to write; `'not'` when the model says it is not a report; `'lost'` when
 * another PC took the read over or this PC cannot send it; or null when the read could not finish: nothing is written
 * then, and the next sweep reads it again. Throws when the service fails.
 */
export async function read(
  k: ReportKit, rec: DocRecord, before: ReadLine | undefined, last: boolean,
): Promise<ReadLine | 'not' | 'lost' | null> {
  const s = await k.send(rec);
  if (!s) return 'lost';                       // cannot be sent from this PC: left for one that can, not a try
  const r = new ReportRead(k, rec, s, before);
  for (let call = 0; ; call++) {               // page after page until the report ends: no length is too long
    const step = await readPage(r, call, last);
    if (step !== 'next') return step.end;
  }
}

/**
 * An issue that came back with no page that opens is not dropped quietly: the read is done again, and what it raised
 * already comes back covered. Only the last try is written as it stands.
 */
function finish(r: ReportRead, last: boolean) {
  if (r.unplaced && !last) return null;
  return r.line();
}
