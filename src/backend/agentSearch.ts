/**
 * The chat agent's search tool (agent.ts), a page at a time, every kind ranked by the same keyword scoring (#1102):
 * a page of documents read by the search helper on the fast model, and the deal's findings and Q&A log, the records
 * the app holds, with no model call.
 */
import { int, strings } from './lenient';
import { pageOf, rankRecords, type Page } from './recordSearch';
import { batchesOf } from './agentFolder';
import { qaRow, qaText } from './qaRow';
import type { AgentRun } from './agentRun';
import { foundAt, withPlaces } from './agentRun';
import type { Cited, DealDoc } from './agentKit';
import { findAsk, noun, oneLine, quoted, shorten } from './agentPrompts';

/** what each kind of search is called in its step and in what the main session is told */
const LABEL = {
  documents: 'documents',
  findings: 'findings',
  qa: 'Q&A',
  all: 'documents, findings and Q&A',
} as const;
export type What = keyof typeof LABEL;

/** what a search asks for: of what, which page of it, and the query's words as they are compared */
interface Asked { what: What; page: number; words: Set<string> }
/** what one search found, as it is put together: for the main session, for the step's result, and for the step */
interface Report { out: string[]; said: string[]; found: { where: string; quote: string }[] }
/** the records of each deal, with the deal's name when there are several; `missed` the deals that could not be read */
type Gathered<T> = { all: (T & { deal: string })[]; missed: string[] };

/** the page a search asks for: a whole number of 1 or more, given as a number or its digits; page 1 otherwise */
export const pageNumber = (v: unknown): number => Math.max(1, int(v) ?? 1);

/**
 * One search, page `page` of its results; what it found, for the main session's next prompt. Throws only when the
 * service cannot be reached.
 */
export async function search(run: AgentRun, what: What, query: string, page = 1): Promise<string> {
  const key = `${what}|${oneLine(query).toLowerCase()}|${page}`;
  const which = page > 1 ? `page ${page} of ` : '';
  if (run.searched.has(key)) {
    return `You searched ${LABEL[what]} for ${which}${quoted(query)} already: the results are above. `
      + 'Ask for another page, search in other words, read a document, or answer.';
  }
  run.searched.add(key);
  const onPage = page > 1 ? ` · page ${page}` : '';
  const step = run.step({ kind: 'search', text: `Searched ${LABEL[what]} for ${quoted(query)}${onPage}` });
  const report: Report = { out: [], said: [], found: [] };
  const asked: Asked = { what, page, words: queryWords(run, query) };
  if (what === 'documents' || what === 'all') await searchDocuments(run, asked, query, report);
  if (what === 'findings' || what === 'all') await searchFindings(run, asked, report);
  if (what === 'qa' || what === 'all') await searchQuestions(run, asked, report);
  const found = report.found.length ? { found: report.found } : {};
  Object.assign(step, { result: report.said.join(' · '), done: true }, found);
  return `You searched ${LABEL[what]} for ${quoted(query)}.\n${report.out.join('\n')}`;
}

/** the query's words as each deal's documents are searched by them: its short names given their long form too */
function queryWords(run: AgentRun, query: string): Set<string> {
  const out = new Set<string>();
  for (const dealId of run.question.deals) for (const w of run.kit.words(query, dealId)) out.add(w);
  return out;
}

/** a page of the documents' keyword ranking, read by the search helper: what it says and the passages it cites */
async function searchDocuments(run: AgentRun, asked: Asked, query: string, report: Report): Promise<void> {
  const { kit, question } = run;
  const ranking = await kit.ranking(question.deals, query);
  const shown = documentPage(run, ranking, asked.page);
  if (!shown.items.length) {
    const none = 'Documents: none answers to these words.';
    report.out.push(ranking.length ? noPage('Documents', 'documents', asked, shown) : none);
    report.said.push(`${shown.total} listed · none opened`);
    return;
  }
  const ask = findAsk('these documents', query, question.message);
  const looked = await kit.readPage(question.deals, (await kit.models()).fast, ask, shown.items);
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
  const says = text ? ` It says: ${withPlaces(text, tags, sources)}` : ' They say nothing about it.';
  const passages = lines.length ? `\nPassages:\n${lines.join('\n')}` : '';
  const page = pageLine('documents', asked, shown);
  const unread = notOpened(run, shown.items, sent);
  report.out.push(`Documents: the helper opened ${opens.join(', ')}.${says}${passages}${unread}\n${page}`);
  const passageCount = `${sources.length} ${noun(sources.length, 'passage')}`;
  report.said.push(`${shown.total} listed · ${sent.length} opened · ${passageCount}`);
}

/** page `page` of the documents' ranking: one call's batch of it, cut as a folder read's batches are */
function documentPage(run: AgentRun, ranking: DealDoc[], page: number): Page<DealDoc> {
  const batches = batchesOf(ranking, run.kit.cleanDrafts, run.pages.width);
  return { items: batches[page - 1]?.recs ?? [], page, pages: batches.length, total: ranking.length };
}

/**
 * The documents of a page the helper did not open, because they could not be opened on this PC or the service took
 * them as too long to read with the rest (ai.ts `read`): named, so that the main session can read them (#1102)
 */
function notOpened(run: AgentRun, page: DealDoc[], sent: DealDoc[]): string {
  const left = page.filter((d) => !sent.some((s) => s.dealId === d.dealId && s.rec.docId === d.rec.docId));
  if (!left.length) return '';
  const paths = left.map((d) => run.kit.where(d.rec)).join('; ');
  const why = 'could not be opened on this PC, or too long to read with the others';
  return `\nNot opened (${why}): ${paths}. Read them by name to see them.`;
}

/** the deal's findings ranked by the query's words, a page of them, each whole */
async function searchFindings(run: AgentRun, asked: Asked, report: Report): Promise<void> {
  const deals = run.question.deals;
  const { all, missed } = await gather(run, (dealId) => run.kit.findings(dealId));
  const ranked = rankRecords(all, asked.words, (f) => `${f.title} ${f.body.join(' ')}`);
  const line = (f: (typeof all)[number]) =>
    `Finding “${f.title}” (${f.status}${f.deal ? `, ${f.deal}` : ''}): ${oneLine(f.body.join(' '))}`;
  const shown = pageOf(ranked, asked.page, run.pages.searchPage, run.pages.chars, line);
  const listing = ranked.length
    ? listed('Findings', 'findings', asked, shown, line)
    : noneFound('Findings', 'none answers to these words', missed.length, deals.length);
  report.out.push(listing + await unread(run, 'Findings', missed));
  for (const f of shown.items) {
    report.found.push({ where: `Finding · ${f.title}`, quote: shorten(oneLine(f.body.join(' ')), 160) });
  }
  const some = missed.length ? ' · some could not be read' : '';
  report.said.push(missed.length === deals.length
    ? 'findings could not be read'
    : `${shown.items.length} ${noun(shown.items.length, 'finding')}${some}`);
}

/** the deal's questions ranked by the query's words over their full rows, a page of them, each row in full */
async function searchQuestions(run: AgentRun, asked: Asked, report: Report): Promise<void> {
  const deals = run.question.deals;
  const { all, missed } = await gather(run, async (dealId) => byNumber(await run.kit.questions(dealId)));
  const ranked = rankRecords(all, asked.words, qaText);
  const row = (x: (typeof all)[number]) => qaRow(x, x.deal);
  const shown = pageOf(ranked, asked.page, run.pages.searchPage, run.pages.chars, row);
  const listing = ranked.length
    ? listed('Q&A', 'qa', asked, shown, row)
    : noneFound('Q&A', 'no question answers to these words', missed.length, deals.length);
  report.out.push(listing + await unread(run, 'Questions', missed));
  for (const x of shown.items) {
    const where = `Q${x.n}${x.response?.trim() ? ' · response received' : ''}`;
    report.found.push({ where, quote: shorten(oneLine(x.response?.trim() ? x.response : x.text || ''), 160) });
  }
  const got = shown.items;
  const more = got.length > 4 ? ` and ${got.length - 4} more` : '';
  const named = got.slice(0, 4).map((x) => `Q${x.n}`).join(', ') + more;
  const which = got.length ? named : missed.length === deals.length ? 'questions could not be read' : 'no questions';
  report.said.push(which + (missed.length && missed.length < deals.length ? ' · some could not be read' : ''));
}

/** a deal's questions in the order of their numbers, so that equal matches keep that order; null as it came */
function byNumber<T extends { n?: number }>(questions: T[] | null): T[] | null {
  return questions ? [...questions].sort((a, b) => (a.n ?? 0) - (b.n ?? 0)) : null;
}

/** "there is 1 page", "there are 3 pages" */
const pagesThere = (pages: number) => (pages === 1 ? 'there is 1 page' : `there are ${pages} pages`);

/**
 * A page of a kind of record, under its heading, with which page it is and how many there are; one past the last
 * says how many there are. Searching everything names the kind the next page is asked for by.
 */
function listed<T>(heading: string, kind: What, asked: Asked, shown: Page<T>, line: (x: T) => string): string {
  if (!shown.items.length) return noPage(heading, kind, asked, shown);
  return `${heading}:\n${shown.items.map(line).join('\n')}\n${pageLine(kind, asked, shown)}`;
}

/** how a search of everything names a kind, so that the next page is asked for by it */
const kindOf = (kind: What, asked: Asked) => (asked.what === 'all' ? ` of "${kind}"` : '');

/** which page this is of how many, and the next page to ask for while there is one */
function pageLine<T>(kind: What, asked: Asked, shown: Page<T>): string {
  const next = shown.page < shown.pages ? ` Ask for page ${shown.page + 1}${kindOf(kind, asked)} for more.` : '';
  return `Page ${shown.page} of ${shown.pages}.${next}`;
}

/** a page past the last: how many pages there are */
function noPage<T>(heading: string, kind: What, asked: Asked, shown: Page<T>): string {
  return `${heading}: no page ${shown.page}${kindOf(kind, asked)}: ${pagesThere(shown.pages)}.`;
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
