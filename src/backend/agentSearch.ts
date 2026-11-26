/**
 * The chat agent's search tool (agent.ts): documents through the search helper on the fast model, and the deal's
 * findings and Q&A log, the records the app holds, by their words with no model call.
 */
import { strings } from './lenient';
import type { AgentRun } from './agentRun';
import { foundAt, withPlaces } from './agentRun';
import type { Cited } from './agentKit';
import { findAsk, noun, oneLine, quoted, shorten } from './agentPrompts';

/** what each kind of search is called in its step and in what the main session is told */
const LABEL = {
  documents: 'documents',
  findings: 'findings',
  qa: 'Q&A',
  all: 'documents, findings and Q&A',
} as const;
export type What = keyof typeof LABEL;

/** what one search found, as it is put together: for the main session, for the step's result, and for the step */
interface Report { out: string[]; said: string[]; found: { where: string; quote: string }[] }
/** the records of each deal, with the deal's name when there are several; `missed` the deals that could not be read */
type Gathered<T> = { all: (T & { deal: string })[]; missed: string[] };

/** one search; what it found, for the main session's next prompt. Throws only when the service cannot be reached. */
export async function search(run: AgentRun, what: What, query: string): Promise<string> {
  const key = `${what}|${oneLine(query).toLowerCase()}`;
  if (run.searched.has(key)) {
    return `You searched ${LABEL[what]} for ${quoted(query)} already: the results are above. `
      + 'Search in other words, read a document, or answer.';
  }
  run.searched.add(key);
  const step = run.step({ kind: 'search', text: `Searched ${LABEL[what]} for ${quoted(query)}` });
  const report: Report = { out: [], said: [], found: [] };
  if (what === 'documents' || what === 'all') await searchDocuments(run, query, report);
  const queryWords = run.kit.words(query);
  // a search of everything gives findings half of what the documents left, and Q&A the rest
  if (what === 'findings' || what === 'all') await searchFindings(run, queryWords, report, what === 'all' ? 2 : 1);
  if (what === 'qa' || what === 'all') await searchQuestions(run, queryWords, report);
  const found = report.found.length ? { found: report.found } : {};
  Object.assign(step, { result: report.said.join(' · '), done: true }, found);
  return `You searched ${LABEL[what]} for ${quoted(query)}.\n${report.out.join('\n')}`;
}

/** the documents, through the search helper: what it opened, what it says and the passages it cites */
async function searchDocuments(run: AgentRun, query: string, report: Report): Promise<void> {
  const { kit, question } = run;
  const fast = (await kit.models()).fast;
  const ask = findAsk('these documents', query, question.message);
  const looked = await kit.look(question.deals, fast, ask, query, run.given());
  if (!looked.ok) {
    if (looked.error.kind === 'unreachable') {
      throw Object.assign(new Error(looked.error.message), { code: 'unreachable' });
    }
    report.out.push(`Documents: ${looked.error.message}.`);
    report.said.push(looked.error.message);
    return;
  }
  const { reply, sent } = looked.value;
  const { text, sources } = kit.fit(strings(reply.text).join(' '), reply.sources as Cited[], sent, true);
  // what the helper opened was read by a model: it may be cited
  for (const s of sent) run.tagOf(s.dealId, s.rec);
  const tags = run.tagsOf(sources);
  const lines = sources.map((s, i) => `${tags[i]} ${s.loc}${s.quote ? `: “${oneLine(s.quote)}”` : ''}`);
  for (const s of sources) report.found.push(foundAt(s));
  const opens = sent.map((s) => run.tagOf(s.dealId, s.rec).tag);
  if (!sent.length) report.out.push('Documents: none answers to these words.');
  else {
    const says = text ? ` It says: ${withPlaces(text, tags, sources)}` : ' They say nothing about it.';
    const passages = lines.length ? `\nPassages:\n${lines.join('\n')}` : '';
    report.out.push(`Documents: the helper opened ${opens.join(', ')}.${says}${passages}`);
  }
  const listed = kit.listed(question.deals, query);
  report.said.push(`${listed} listed · ${sent.length} opened · ${sources.length} ${noun(sources.length, 'passage')}`);
}

/**
 * The deal's findings that share a word with the query, the most first, each whole while they fit `1 / parts` of what
 * is left of the room; the rest are counted.
 */
async function searchFindings(run: AgentRun, queryWords: Set<string>, report: Report, parts: number): Promise<void> {
  const deals = run.question.deals;
  const { all, missed } = await gather(run, (dealId) => run.kit.findings(dealId));
  const matched = bestMatches(run, queryWords, all, (f) => `${f.title} ${f.body.join(' ')}`);
  const line = (f: (typeof matched)[number]) =>
    `Finding “${f.title}” (${f.status}${f.deal ? `, ${f.deal}` : ''}): ${oneLine(f.body.join(' '))}`;
  const lines = matched.map(line);
  const listed = fitting(lines, roomLeft(run, report) / parts);
  const got = matched.slice(0, listed);
  const listing = matched.length
    ? fitted('Findings', lines, listed)
    : noneFound('Findings', 'none answers to these words', missed.length, deals.length);
  report.out.push(listing + await unread(run, 'Findings', missed));
  for (const f of got) {
    report.found.push({ where: `Finding · ${f.title}`, quote: shorten(oneLine(f.body.join(' ')), 160) });
  }
  const some = missed.length ? ' · some could not be read' : '';
  report.said.push(missed.length === deals.length
    ? 'findings could not be read'
    : `${got.length} ${noun(got.length, 'finding')}${moreMatched(matched.length - listed)}${some}`);
}

/**
 * The deal's questions and their responses that share a word with the query, the most first, each whole while they
 * fit this result's share of the room; the rest are counted.
 */
async function searchQuestions(run: AgentRun, queryWords: Set<string>, report: Report): Promise<void> {
  const deals = run.question.deals;
  const { all, missed } = await gather(run, (dealId) => run.kit.questions(dealId));
  const matched = bestMatches(run, queryWords, all, (x) => `${x.text ?? ''} ${x.response ?? ''}`);
  const line = (x: (typeof matched)[number]) => {
    const state = `${x.status ?? 'open'}${x.deal ? `, ${x.deal}` : ''}`;
    const asked = `Q${x.n} (${state}): ${oneLine(x.text ?? '')}`;
    const response = x.response?.trim() ? oneLine(x.response) : 'none yet';
    return `${asked}\nResponse to Q${x.n}: ${response}`;
  };
  const lines = matched.map(line);
  const listed = fitting(lines, roomLeft(run, report));
  const got = matched.slice(0, listed);
  const listing = matched.length
    ? fitted('Q&A', lines, listed)
    : noneFound('Q&A', 'no question answers to these words', missed.length, deals.length);
  report.out.push(listing + await unread(run, 'Questions', missed));
  for (const x of got) {
    const where = `Q${x.n}${x.response?.trim() ? ' · response received' : ''}`;
    report.found.push({ where, quote: shorten(oneLine(x.response?.trim() || x.text || ''), 160) });
  }
  const more = got.length > 4 ? ` and ${got.length - 4} more` : '';
  const named = got.slice(0, 4).map((x) => `Q${x.n}`).join(', ') + more;
  const unlisted = matched.length - listed;
  const which = got.length ? named + moreMatched(unlisted)
    : unlisted ? `${unlisted} matched`
    : missed.length === deals.length ? 'questions could not be read' : 'no questions';
  report.said.push(which + (missed.length && missed.length < deals.length ? ' · some could not be read' : ''));
}

/**
 * The catch-up tool: each deal's brief on its open findings, named by deal when there are several, one deal at a time.
 * The brief is one model call, which is not made again while the deal's findings are unchanged (ai.ts dealBrief). A
 * deal whose findings cannot be read just now is named as such, as a search of findings does, never taken for empty.
 */
export async function catchUp(run: AgentRun): Promise<string> {
  const { kit, question } = run;
  const step = run.step({ kind: 'search', text: 'Caught up on the open findings' });
  const multi = question.deals.length > 1;
  const parts: string[] = [];
  const said: string[] = [];
  for (const dealId of question.deals) {
    const heading = multi ? `${await kit.dealName(dealId)}: ` : '';
    // stopped by the person: no further deal is briefed (decisions: Stop answers from what was found)
    const { text, result } = run.progress.stopped
      ? { text: 'not briefed, since the person stopped the research.', result: 'stopped' }
      : await briefOf(run, dealId);
    parts.push(heading + text);
    said.push(heading + result);
  }
  Object.assign(step, { result: said.join(' · '), done: true });
  return `The catch-up on the open findings:\n${parts.join('\n\n')}`;
}

/** one deal's brief, for the main session (`text`) and for the step (`result`); throws when the service is down */
async function briefOf(run: AgentRun, dealId: string): Promise<{ text: string; result: string }> {
  if (!await run.kit.findings(dealId)) {
    return { text: 'its findings could not be read just now.', result: 'findings could not be read' };
  }
  const brief = await run.kit.brief(dealId);
  if (brief.ok) {
    const count = brief.value.length;
    const result = count ? `${count} ${noun(count, 'paragraph')}` : 'no open findings';
    return { text: brief.value.join('\n') || 'no open findings.', result };
  }
  if (brief.error.kind === 'unreachable') throw Object.assign(new Error(brief.error.message), { code: 'unreachable' });
  return { text: `the catch-up could not be written: ${brief.error.message}.`, result: 'could not be written' };
}

/**
 * Every deal's records, each with its deal's name when the question is about several deals. A deal whose records
 * cannot be read just now is `missed`, in the order the reads failed.
 */
async function gather<T>(run: AgentRun, read: (dealId: string) => Promise<T[] | null>): Promise<Gathered<T>> {
  const { kit, question } = run;
  const multi = question.deals.length > 1;
  const missed: string[] = [];
  const perDeal = await Promise.all(question.deals.map(async (dealId) => {
    const deal = multi ? await kit.dealName(dealId) : '';
    const records = await read(dealId);
    if (!records) missed.push(dealId);
    return (records ?? []).map((x) => ({ ...x, deal }));
  }));
  return { all: perDeal.flat(), missed };
}

/** the records that share a word with the query, those that share the most first */
function bestMatches<T>(run: AgentRun, queryWords: Set<string>, all: T[], text: (x: T) => string): T[] {
  const scored = all.map((x) => {
    const has = run.kit.words(text(x));
    let shared = 0;
    for (const word of queryWords) if (has.has(word)) shared++;
    return { x, shared };
  });
  return scored.filter((h) => h.shared > 0).sort((a, b) => b.shared - a.shared).map((h) => h.x);
}

/** the characters of this result's share of the room left for the search's next part: less what earlier parts found */
function roomLeft(run: AgentRun, report: Report): number {
  return Math.max(0, run.share() - report.out.join('\n').length);
}

/** how many of these lines, from the first, fit in `room` characters with their line breaks */
function fitting(lines: string[], room: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > room) break;
    count++;
  }
  return count;
}

/** a heading with the first `listed` lines under it, and the rest counted; only the count when none fits */
function fitted(heading: string, lines: string[], listed: number): string {
  const rest = lines.length - listed;
  // the best matches come first: those past what fits share as many of the query's words or fewer
  if (!listed) return `${heading}: ${rest} matched, past what fits here.`;
  const more = rest ? `\nand ${rest} more matched, past what fits here.` : '';
  return `${heading}:\n${lines.slice(0, listed).join('\n')}${more}`;
}

/** the step's note of the records that matched but were not listed */
const moreMatched = (count: number) => (count ? ` · ${count} more matched` : '');

/**
 * What a search of records says when none answers: only the heading when no deal's records could be read (the deals
 * are named after it), and otherwise that none answers, in the deals that could be read when some could not.
 */
function noneFound(heading: string, none: string, missed: number, deals: number): string {
  if (missed === deals) return `${heading}:`;
  return missed ? `${heading}: ${none} in the deals that could be read.` : `${heading}: ${none}.`;
}

/** the deals whose records could not be read just now, named, so that the answer does not take them for empty */
async function unread(run: AgentRun, what: string, missed: string[]): Promise<string> {
  if (!missed.length) return '';
  const names = await Promise.all(missed.map((dealId) => run.kit.dealName(dealId)));
  return `\n${what} in ${names.join(', ')} could not be read just now.`;
}
