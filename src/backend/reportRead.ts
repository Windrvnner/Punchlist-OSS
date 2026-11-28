/**
 * Step 3 of the third-party reports sweep (reports.ts). Each issue becomes a finding unless a finding on the deal
 * already covers it. A cutoff keeps verified issues so the next attempt can ask for the rest of the whole report.
 */
import { createHash } from 'node:crypto';
import type { DocRecord } from './documents';
import type { Cited } from './agent';
import type { Source } from '../domain/model';
import { list as listOf, readJson, readCutJson, isObject, strings, tagNumber, prose, PARAGRAPH_SEAM } from './lenient';
import { unknownIds } from './recordIds';
import { withFewerChanges } from './limits';
import {
  type ReportKit, type ReadLine, type ReadIssue, type Known, type Issue, type SentDoc,
  type ReportCut, type KeptReportIssue, isCut, reportPlace, reportTitleKey,
} from './reportTypes';

/** sentences of one paragraph, written out for the model */
const sentences = (...parts: string[]) => parts.join(' ');

/** the opening of the prompt: what to list, and what to leave out */
function issuesAsk(k: ReportKit, id: string) {
  const what = sentences(
    `${id} is a report by an outside advisor or consultant on this deal.`,
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
    `and "sources" citing the page of ${id} where it is raised.`,
    'Number each issue’s markers from [1].',
  );
  return `${what}\n${how}`;
}

/** the deal's findings, so an issue one already covers is named rather than raised again: each by its id (#1162) */
function knownAsk(id: string, known: Known[]) {
  if (!known.length) return '';
  const mark = (f: Known) => (f.deleted ? ' (deleted)' : f.closed ? ' (closed)' : '');
  const listed = known.map((f) => `${f.id}: ${f.title}${mark(f)}`).join('\n');
  const rule = sentences(
    'An issue an open finding, or one marked (deleted), already covers is given as {"covered": "<finding id>"}',
    `with its "sources", the page of ${id} where it is raised, and nothing else.`,
    'An issue only a finding marked (closed) covers is written up in full like any other,',
    'with "earlier": "<finding id>".',
  );
  return `\n\nThese findings are already on the deal:\n${listed}\n${rule}`;
}

/** what an earlier draft of the report raised, so a new draft raises only what is new */
function earlierAsk(id: string, before: ReadIssue[] | undefined) {
  if (!before?.length) return '';
  // an earlier draft's issue is no saved record with an id of its own: it keeps its per-prompt label (#1162)
  const listed = before.map((x, i) => `E${i + 1}: ${x.title}`).join('\n');
  const rule = sentences(
    'An issue it raised that this report still raises is given as {"still": "E2"}',
    `with its "sources", the page of ${id} where it is raised now, and nothing else.`,
    'Put in "dropped" the E numbers of those this report no longer raises.',
  );
  return `\n\nAn earlier draft of this report raised these issues:\n${listed}\n${rule}`;
}

/** the reply's shape */
function replyAsk(id: string, before: ReadIssue[] | undefined) {
  const source = (page: number) => `"sources": [{"doc": "${id}", "page": ${page}, "quote": "…"}]`;
  const full = `{"title": "…", "workstream": "…", "body": ["…"], ${source(12)}}`;
  const still = before?.length ? `, {"still": "E1", ${source(8)}}` : '';
  const dropped = before?.length ? '"dropped": ["E1"], ' : '';
  const advisor = sentences(
    'Also give "advisor": who wrote the report, in a few words (such as "the independent engineer").',
    `If ${id} is not in fact a report by an outside advisor, reply {"report": false}.`,
  );
  const order = 'Give every issue, in the order the report raises them.';
  const issues = `[${full}, {"covered": "<finding id>", ${source(30)}}${still}]`;
  const droppedPart = dropped ? `, ${dropped.replace(/, $/, '')}` : '';
  const shape = `Reply as JSON: {"advisor": "…", "issues": ${issues}${droppedPart}}`;
  return `\n${advisor}\n${order}\n${shape}`;
}

/** where a read has got to, as the prompt needs it */
interface ReadAt { k: ReportKit; s: SentDoc; before?: ReadLine; resume?: ReportCut }

function resumeAsk(resume: ReportCut | undefined) {
  if (!resume) return '';
  const kept = resume.issues.map(({ issue, sources }) => {
    const places = sources.map(({ loc, quote }) => quote ? `${loc} "${quote}"` : loc).join(', ');
    return `${issue.finding ?? issue.covered}: ${issue.title} (${places})`;
  });
  const reason = resume.invalidIssue ? 'had an incomplete finding write-up' : 'was cut off';
  return `\n\nThe previous reply ${reason}. Give the remaining issues from the entire report. `
    + 'Include issues from the previous reply that are not listed below. Omit only the exact issues already kept here:'
    + (kept.length ? `\n${kept.join('\n')}` : ' none.');
}

/** the prompt that reads a report's issues */
export function readAsk(r: ReadAt, known: Known[]) {
  const id = r.s.sent[0].rec.docId;
  const body = issuesAsk(r.k, id) + knownAsk(id, known) + earlierAsk(id, r.before?.issues);
  return `Documents:\n${r.s.listing}\n\n${body}${replyAsk(id, r.before?.issues)}${resumeAsk(r.resume)}`;
}

/** a finding this report raised: its id is the one `idFor` gives the report and its title */
function isOwn(k: ReportKit, doc: string, f: Known) {
  if (f.signature) return f.signature.startsWith(`${doc}:`);
  for (let n = 1; n <= 5; n++) if (k.idFor(doc, f.title, n) === f.id) return true;
  return false;
}

/** the title as the model wrote it; a blank one is none (#1215) */
const titleOf = (row: Record<string, unknown>) => (typeof row.title === 'string' && row.title.trim() ? row.title : '');

const placement = (s: Source) => JSON.stringify([reportPlace(s), s.quote ?? '']);
const atPlaces = (key: string, sources: Source[]) => JSON.stringify([key, ...sources.map(placement).sort()]);
const issueId = (issue?: ReadIssue) => issue?.finding ?? issue?.covered ?? '';

const earlierIssue = (row: Record<string, unknown>, before?: ReadLine) =>
  before?.issues[(tagNumber(row.still, 'E') ?? 0) - 1];

function issueSignature(doc: string, title: string, body: string[], sources: Source[]) {
  // Source order matters because the body numbers refer to it.
  const parts = [title, body, ...sources.map(placement)];
  return `${doc}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

const hasWriteup = (row: Record<string, unknown>) => !!titleOf(row) && prose(row.body).length > 0;

function needsClosedWriteup(row: Record<string, unknown>, known: Known[], before?: ReadLine) {
  if (issueId(earlierIssue(row, before)) || hasWriteup(row)) return false;
  return known.some((f) => f.id === row.covered && f.closed && !f.deleted);
}

/** One read of one report, in one call: what it has found. */
class ReportRead {
  issues: ReadIssue[];
  advisor: string;
  kept: KeptReportIssue[] = [];
  retaining = false;
  private seen = new Set<string>();
  private reserved = new Set<string>();
  /** findings of the earlier draft's issues this draft no longer raises */
  dropped = new Set<string>();
  /** how many issues of each title the report has given: another of the same title gets its own finding id */
  titles = new Map<string, number>();
  /** issues given with no page that opens */
  unplaced = 0;
  /** pages that could not be added to a finding now: a later sweep adds them */
  owe = new Map<string, Source[]>();

  constructor(
    readonly k: ReportKit,
    readonly rec: DocRecord,
    readonly s: SentDoc,
    readonly before: ReadLine | undefined,
    readonly resume?: ReportCut,
  ) {
    this.issues = resume?.issues.filter((row) => !row.still).map((row) => row.issue) ?? [];
    this.advisor = resume?.advisor ?? '';
    for (const row of resume?.issues ?? []) {
      this.remember(row);
      if (row.issue.finding) this.reserved.add(row.issue.finding);
    }
  }

  private remember({ issue, sources, signature }: KeptReportIssue) {
    this.seen.add(atPlaces(issueId(issue), sources));
    if (signature) this.seen.add(signature);
  }

  private keep(row: KeptReportIssue) {
    this.remember(row);
    if (row.issue.finding) this.reserved.add(row.issue.finding);
    if (this.retaining) this.kept.push(row);
  }

  private get verifying() { return this.retaining || !!this.resume; }

  private miss() {
    this.unplaced++;
    return true;
  }

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
    const was = earlierIssue(row, this.before);
    const stillAt = issueId(was);
    if (was && stillAt) return this.still(row, was, stillAt);
    const covering = known.find((f) => f.id === row.covered);
    const title = titleOf(row);
    // one only a closed finding covers is raised again, so it must come written out: as covered only, it has no page
    if (covering?.closed && !covering.deleted && !hasWriteup(row)) return this.miss();
    if (covering && !(covering.closed && title)) { await this.covered(row, covering); return true; }
    if (!title) return this.verifying ? this.miss() : true;
    return this.raise(row, title, known, covering);
  }

  private async still(row: Record<string, unknown>, was: ReadIssue, id: string) {
    const places = this.placed(row);
    if (this.verifying && !places.length) return this.miss();
    if (this.verifying) this.dropped.delete(id);
    if (this.seen.has(atPlaces(id, places))) return true;
    await this.cite(id, places);
    this.keep({ issue: was, sources: places, still: true });
    return true;
  }

  /** an issue a finding already covers raises none, whatever else the reply gives with it */
  async covered(row: Record<string, unknown>, f: Known) {
    const places = this.placed(row);
    if (this.verifying && !places.length) { this.miss(); return; }
    if (this.seen.has(atPlaces(f.id, places))) return;
    // the report is a source of the finding that covers its issue, whoever raised it; a deleted one is left as it is
    if (!f.deleted) await this.cite(f.id, places);
    // a finding this report raised itself, in a read that did not finish, is its own: a later draft that drops it
    // marks it
    const own = isOwn(this.k, this.rec.docId, f);
    const issue = own ? { title: f.title, finding: f.id } : { title: f.title, covered: f.id };
    this.issues.push(issue);
    this.keep({ issue, sources: places, ...(own && f.signature ? { signature: f.signature } : {}) });
  }

  /** Continue the existing title ordinals, including a finding written before its cutoff was logged. */
  private idFor(title: string, signature: string, known: Known[]) {
    const same = known.find((finding) => finding.signature === signature);
    if (same) return same.id;
    const key = reportTitleKey(title);
    let nth = (this.titles.get(key) ?? 0) + 1;
    for (;;) {
      const id = this.k.idFor(this.rec.docId, title, nth);
      const had = known.find((finding) => finding.id === id);
      // Legacy findings and deletions keep their existing title ordinal.
      if (!this.reserved.has(id) && had?.signature === undefined) {
        this.titles.set(key, nth);
        return id;
      }
      nth++;
    }
  }

  /** a new issue: a finding of its own */
  async raise(row: Record<string, unknown>, title: string, known: Known[], covering?: Known): Promise<boolean> {
    const k = this.k;
    const fitted = k.fit(prose(row.body).join(PARAGRAPH_SEAM), row.sources as Cited[], this.s.sent);
    // an issue stands on a page of the report a person can open, as any finding does
    if (!fitted.text || !fitted.sources.length) { this.unplaced++; return true; }
    const body = k.fitParas(fitted.text.split(PARAGRAPH_SEAM).filter((p) => p.trim()));
    const signature = issueSignature(this.rec.docId, title, body, fitted.sources);
    if (this.seen.has(signature)) return true;
    const id = this.idFor(title, signature, known);
    const issue: Issue = {
      title,
      workstream: k.workstreamOf(row.workstream),
      body,
      sources: fitted.sources,
      signature,
    };
    // a closed finding on the same issue is named, by its id: with none named, the one given as covering it
    const was = known.find((f) => f.id === row.earlier) ?? covering;
    if (was?.closed && !was.deleted) issue.earlier = was.id;
    if (!(await k.raise(id, issue))) return false;
    const saved = { title, finding: id };
    this.issues.push(saved);
    this.keep({ issue: saved, sources: fitted.sources, signature });
    return true;
  }

  /** each row of a reply, in order. False when a finding could not be written */
  async takeAll(rows: unknown[], known: Known[]) {
    let saved = true;
    for (const row of rows) {
      if (!isObject(row)) {
        if (this.verifying) this.miss();
        continue;
      }
      if (await this.take(row, known)) continue;
      if (!this.retaining) return false;
      saved = false;
    }
    return saved;
  }

  /** what the reply says beside its issues: who wrote the report, and which of the earlier draft's it drops */
  heard(reply: Record<string, unknown>) {
    this.hearAdvisor(reply);
    const still = new Set(this.resume?.issues.filter((row) => row.still).map(({ issue }) => issueId(issue)));
    for (const e of strings(reply.dropped)) {
      const f = this.before?.issues[(tagNumber(e, 'E') ?? 0) - 1]?.finding;
      if (f && !still.has(f)) this.dropped.add(f);
    }
  }

  hearAdvisor(reply: Record<string, unknown>) {
    const said = reply.advisor;
    const advisor = typeof said === 'string' && said.trim() ? said : '';
    if (advisor && !this.advisor) this.advisor = advisor;
  }

  cutoff(invalidIssue?: true): { cut: ReportCut } {
    const owe = [...this.owe].map(([finding, sources]) => ({ finding, sources }));
    return { cut: { advisor: this.advisor, issues: this.kept, ...(owe.length ? { owe } : {}),
      ...(invalidIssue ? { invalidIssue } : {}),
    } };
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

/**
 * A reply whose "covered" or "earlier" is not exactly the id of a finding it was shown, asked again (#1162); none
 * given, or "", is not an id
 */
export const knownUnusable = (known: Known[], keys: string[]) => (text: string) => {
  const ids = known.map((f) => f.id);
  const rows = listOf(readJson(text, keys)?.issues).filter(isObject);
  const named = rows.flatMap((row) => [row.covered, row.earlier]).filter((v) => v !== undefined && v !== '');
  return unknownIds(named, ids).length > 0;
};

/** The explicit reply that the document is not a report, as the prompt asks. */
const notReport = (reply: Record<string, unknown>) => reply.report === false && !('issues' in reply);

/** Keep the existing single-row form. Only an explicit empty list says the report raises no issues (#1212). */
function reportIssueRows(reply: Record<string, unknown>, before?: ReadLine): Record<string, unknown>[] | null {
  const issues = reply.issues;
  if (Array.isArray(issues)) return issues.every((row) => issueRow(row, before)) ? issues : null;
  return issueRow(issues, before) ? [issues] : null;
}

function issueRow(row: unknown, before?: ReadLine): row is Record<string, unknown> {
  if (!isObject(row)) return false;
  const covered = typeof row.covered === 'string' && row.covered !== '';
  const drafted = hasWriteup(row);
  return drafted || covered || !!issueId(earlierIssue(row, before));
}

/** the report's issues from the model in one call; a reply cut off at the length limit comes back with `cut` */
async function ask(r: ReportRead, known: Known[]) {
  const k = r.k;
  const prompt = readAsk(r, known);
  const keys = ['issues', 'report'];
  // a reply citing a document other than the report, or naming a finding it was not shown, is asked again (#1162)
  const cites = k.unusable(r.s.sent, keys, known.map((f) => f.id));
  const named = knownUnusable(known, keys);
  const unusable = async (text: string) => (await cites(text)) || named(text);
  const input = { kind: 'report', split: true, model: k.models.standard, system: k.system, files: r.s.files, prompt,
    unusable };
  const correction = (reply: Record<string, unknown>) => notReport(reply) || reportIssueRows(reply, r.before) !== null
    ? undefined
    : 'provide an issues array with complete write-ups or valid references. Give an empty array only when the report'
      + ' raises no issues, or {"report":false} for a non-report';
  try {
    return { reply: await k.ask(input, keys, correction), cut: false };
  } catch (e) {
    if (!isCut(e)) throw e;
    return { reply: await checkedPrefix(e as { text?: string; partial?: unknown }, unusable), cut: true };
  }
}

async function checkedPrefix(failure: { text?: string; partial?: unknown },
  unusable: (text: string) => Promise<boolean>) {
  const partial = failure.text ? readCutJson(failure.text, ['issues']) : failure.partial;
  if (!isObject(partial)) return null;
  const read = listOf(partial.issues);
  // A repaired partial without its original text cannot prove that its last entry was complete.
  const issues = failure.text ? read : read.slice(0, -1);
  const prefix = { advisor: partial.advisor, issues };
  return await unusable(JSON.stringify(prefix)) ? null : prefix;
}

export type ReportReadResult = ReadLine | { cut: ReportCut } | 'not' | 'lost' | null;

/**
 * A full read finishes the report. A cutoff checkpoints verified issues for the next sweep. An unusable
 * read returns null, and a report this PC cannot send returns 'lost'. Service failures throw.
 */
export async function read(
  k: ReportKit, rec: DocRecord, before: ReadLine | undefined, last: boolean, resume?: ReportCut,
): Promise<ReportReadResult> {
  const known = await k.findings();
  // refused as too long, it is sent again with fewer of its tracked changes listed, while any are (#1381)
  const sentAndAsked = await withFewerChanges(async (share) => {
    const s = await k.send(rec, share);
    if (!s) {
      return null;
    }
    const r = new ReportRead(k, rec, s, before, resume);
    return { r, got: await ask(r, known) };
  });
  // cannot be sent from this PC: left for one that can, not a try
  if (!sentAndAsked) {
    return 'lost';
  }
  const { r, got } = sentAndAsked;
  if (got.cut) return keepCut(r, got.reply, known);
  if (!got.reply) return null;
  if (notReport(got.reply)) return resume ? null : 'not';
  const issues = reportIssueRows(got.reply, before);
  if (!issues) return null;
  r.heard(got.reply);
  const invalid = issues.some((row) => needsClosedWriteup(row, known, before));
  r.retaining = invalid;
  const saved = await r.takeAll(issues, known);
  if (invalid) return r.cutoff(true);
  if (!saved) return null;
  return finish(r, last && (!resume || !!resume.invalidIssue));
}

async function keepCut(r: ReportRead, reply: Record<string, unknown> | null, known: Known[]) {
  if (reply) {
    r.retaining = true;
    r.hearAdvisor(reply);
    await r.takeAll(listOf(reply.issues), known);
  }
  return r.cutoff();
}

/**
 * An issue that came back with no page that opens is not dropped quietly: the read is done again, and what it raised
 * already comes back covered. Only the last try is written as it stands.
 */
function finish(r: ReportRead, last: boolean) {
  if (r.unplaced && !last) return null;
  return r.line();
}
