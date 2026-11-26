// @vitest-environment node
/**
 * The chat's search of the records the app holds (findings and the Q&A log), at deal scale: ranked by the document
 * search's BM25 keyword scoring, 25 a page, each record whole and each Q&A row in full; the model asks for any page
 * (#1102).
 */
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiOptions } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import type { Folder } from '../../src/backend/logRepository';
import type { DocRecord } from '../../src/backend/documents';
import { pageNumber } from '../../src/backend/agentSearch';
import { inlineTools, toolSpecs } from '../../src/backend/agentPrompts';
import { qaRow } from '../../src/backend/qaRow';
import { qid } from './reviewKit';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { return this.files.get(n)?.length ?? -1; }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
/** the deal's one document: the chat answers only on a deal with documents */
const MEMO: DocRecord = {
  docId: `doc_${'1'.padStart(24, '0')}`, hash: 'h', name: 'Memo.pdf', folder: 'D:/Rooms/VDR', rel: 'Memo.pdf',
  size: 1, pages: 2,
};
type Call = { model: string; system?: string; prompt: string };
let t = 0;
const clock = () => new Date(Date.UTC(2026, 10, 26, 9, 0, 0, t++)).toISOString();
const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
const answer = { text: 'ok', sources: [] };
/** a 1,200-character response on the lock-up, with its number in it so each one is told apart */
const longText = (i: number) =>
  `Response ${i}: the lock-up ratio is conformed. ${'The lenders accept it. '.repeat(50)}`;

function setup(turn: (c: Call, n: number) => unknown, options: Partial<AiOptions> = {}) {
  const turns: Call[] = [];
  const svc = new StandInService(async (c) => {
    const call = c as Call;
    const reply = isTurn(call) ? (turns.push(call), turn(call, turns.length)) : { text: '', sources: [] };
    return JSON.stringify(reply);
  });
  (svc as { converse?: unknown }).converse = undefined;
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const repo = memRepo(clock);
  const docs = { records: () => [MEMO], wanted: async () => [] };
  const ai = nodeAi({ service: svc, keeper, repo, clock, docs, width: 8, searchPage: 25, ...options });
  return { ai, repo, turns };
}
type Repo = ReturnType<typeof setup>['repo'];
type Fields = Record<string, unknown>;

/** the id of the `i`th question (from 0) of a deal's 2,500, in the shape the app draws one */
const questionId = (i: number, dealId = 'd1') => qid(`${dealId.slice(1)}${String(i).padStart(5, '0')}`);

/** 2,500 questions, `matching` of them on the lock-up, each with a long response; `extra` sets fields on question 1 */
async function questions(repo: Repo, matching: number, dealId = 'd1', extra: Fields = {}): Promise<void> {
  const id = (i: number) => questionId(i, dealId);
  const data = (i: number) => {
    const on = i < matching;
    const text = on ? `Confirm the lock-up ratio (${i})` : `Provide permit ${i}`;
    const base = { id: id(i), dealId, n: i + 1, text, status: 'answered' };
    return { ...base, response: on ? longText(i) : 'Provided.', ...(i === 0 ? extra : {}) };
  };
  const ids = Array.from({ length: 2_500 }, (_v, i) => i);
  const writes = ids.map((i) => ({ kind: 'question' as const, id: id(i), data: data(i), expectedRev: null }));
  const add = ids.map((i) => ({ kind: 'question' as const, id: id(i) }));
  expect((await repo.transaction({ writes, index: { dealId, add } })).ok).toBe(true);
}

/** `count` findings on the lock-up, each with a long body, and 500 on others */
async function findings(repo: Repo, count: number): Promise<void> {
  const data = (i: number) => {
    const on = i < count;
    const title = on ? `Lock-up ratio differs ${i}` : `Permit ${i} is missing`;
    const body = [on ? longText(i) : 'It is not in the data room.'];
    return { id: `f_${i}`, dealId: 'd1', title, workstream: 'Legal', status: 'open', body, sources: [] };
  };
  const ids = Array.from({ length: count + 500 }, (_v, i) => i);
  const writes = ids.map((i) => ({ kind: 'finding' as const, id: `f_${i}`, data: data(i), expectedRev: null }));
  const add = ids.map((i) => ({ kind: 'finding' as const, id: `f_${i}` }));
  expect((await repo.transaction({ writes, index: { dealId: 'd1', add } })).ok).toBe(true);
}

const ask = (message: string, deals = ['d1']) =>
  ({ ...(deals.length === 1 ? { dealId: deals[0] } : { dealIds: deals }), message, history: [], model: 'standard' });
/** a turn hook that makes these tool calls in turn, then answers */
const calls = (...tools: Fields[]) => (_c: Call, n: number) => tools[n - 1] ?? answer;
/** what the tool handed back in turn `n`'s prompt (turn 2 holds turn 1's result) */
const result = (s: { turns: Call[] }, n: number) => {
  const prompt = s.turns[n - 1].prompt;
  return prompt.slice(prompt.lastIndexOf('. You searched'), prompt.lastIndexOf('This is turn'));
};
const qa = (page?: unknown) =>
  ({ tool: 'search', what: 'qa', query: 'lock-up ratio', ...(page === undefined ? {} : { page }) });

describe('searching the Q&A log from the chat, a page at a time', () => {
  it('page 1 lists the 25 best of 40 whole, page 2 the other 15', async () => {
    const s = setup(calls(qa(), qa(2)));
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const first = result(s, 2);
    const second = result(s, 3);
    expect((first.match(/^Question: /gm) ?? []).length).toBe(25);
    expect((second.match(/^Question: /gm) ?? []).length).toBe(15);
    for (let i = 0; i < 40; i++) expect(first + second).toContain(`${longText(i).trim()}`);
    expect(first).toContain('Page 1 of 2. Ask for page 2 for more.');
    expect(second).toContain('Page 2 of 2.');
    expect(second).not.toContain('Ask for page 3');
    expect(first + second).not.toContain('Provide permit');
  }, 60_000);

  it('a page holds fewer rows, each whole, when 25 would outgrow what the conversation holds', async () => {
    // half of 4,000 tokens of 3 characters each: about four of these rows a page
    const s = setup(calls(qa(), qa(2)), { compactAt: 4_000 });
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const first = result(s, 2);
    const shown = (first.match(/^Question: /gm) ?? []).length;
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(25);
    for (let i = 0; i < shown; i++) expect(first).toContain(longText(i).trim());
    expect(first.length).toBeLessThan(12_000 + 500);
    const pages = Number(/Page 1 of (\d+)\./.exec(first)?.[1]);
    expect(pages).toBeGreaterThan(2);
    expect(result(s, 3)).toContain(longText(shown).trim());                // page 2 starts where page 1 stopped
  }, 60_000);

  it('a search of everything keeps its findings and Q&A pages within what the conversation holds', async () => {
    const all = { tool: 'search', what: 'all', query: 'lock-up ratio' };
    const next = (what: string) => ({ tool: 'search', what, query: 'lock-up ratio', page: 2 });
    const s = setup(calls(all, next('findings'), next('qa')), { compactAt: 4_000 });
    await questions(s.repo, 40);
    await findings(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s, 2);
    const records = got.slice(got.indexOf('Findings:'));
    const [found, asked] = records.split('\nQ&A:');
    const findingsShown = (found.match(/^Finding “/gm) ?? []).length;
    const questionsShown = (asked.match(/^Question: /gm) ?? []).length;
    expect(findingsShown).toBeGreaterThan(0);
    expect(questionsShown).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(12_000 + 500);                     // 4,000 tokens of 3 characters, and footers
    expect(found).toContain('Ask for page 2 of "findings" for more.');
    // the page its footer asks for starts where the search of everything stopped: no record is skipped
    expect(result(s, 3)).toContain(`Finding “Lock-up ratio differs ${findingsShown}”`);
    expect(result(s, 4)).toContain(`Question: Confirm the lock-up ratio (${questionsShown})`);
  }, 60_000);

  it('a Q&A result is the full row, found by any of its fields', async () => {
    const extra = { askedBy: 'Lender counsel', received: '2026-10-01', workstream: 'Legal', priority: 'High',
      respondedBy: 'Sponsor', responded: '2026-11-02' };
    const s = setup(calls({ tool: 'search', what: 'qa', query: 'counsel' }));
    await questions(s.repo, 40, 'd1', extra);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s, 2);
    const details = 'asked by Lender counsel · received 2026-10-01 · workstream Legal · priority High';
    expect(got).toContain(`${questionId(0)} · Answered · ${details}`);
    expect(got).toContain('Question: Confirm the lock-up ratio (0)');
    expect(got).toContain(`Response to ${questionId(0)} from Sponsor, 2026-11-02: ${longText(0).trim()}`);
    expect(got).toContain('Page 1 of 1.');
  }, 60_000);

  it('a row with who responded and when, but no response yet, still shows them', () => {
    const asked = { id: qid(7), n: 7, status: 'open' as const, text: 'Send the permit' };
    const row = qaRow({ ...asked, respondedBy: 'Sponsor', responded: '2026-11-03' });
    expect(row.split('\n')[2]).toBe(`Response to ${qid(7)} from Sponsor, 2026-11-03: none yet`);
    const unanswered = qaRow({ id: qid(8), n: 8, status: 'open', text: 'Send the lease' });
    expect(unanswered.split('\n')[2]).toBe(`Response to ${qid(8)}: none yet`);
  });

  it('an AI draft in a Q&A row is labeled as one', async () => {
    const s = setup(calls(qa()));
    await questions(s.repo, 40, 'd1', { provenance: { origin: 'ai', sources: [] } });
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const drafted = ' (drafted by AI from the data room, not received from anyone): ';
    expect(result(s, 2)).toContain(`Response to ${questionId(0)}${drafted}`);
  }, 60_000);

  it('shows the model each question by its id, and the person its number (#1105)', async () => {
    const revenue = questionId(2);
    // amounts in rand ("R1.2 billion") are the model's words, never a question; nor is an id not named as a response
    const say = `Response ${revenue} says R1.2 billion and R50 million; ${revenue} is a label.`;
    const offer = { action: 'log question', question: `Does response ${revenue} cover R1.2 billion?` };
    const searches = calls(qa(), { tool: 'search', what: 'all', query: 'revenue' });
    const answering = setup((c, n) => (n === 3 ? { text: say, sources: [], offer } : searches(c, n)));
    await questions(answering.repo, 40);
    const fell = { id: revenue, dealId: 'd1', n: 3, status: 'answered', text: 'How did revenue move? lock-up ratio',
      response: 'Revenue fell in Q3 2026.' };
    const update = { kind: 'question' as const, id: revenue, data: fell, expectedRev: 1 };
    expect((await answering.repo.transaction({ writes: [update] })).ok).toBe(true);
    const answered = await answering.ai.answer(ask('What is outstanding?'));
    const shown = `The response to Q3 says R1.2 billion and R50 million; ${revenue} is a label.`;
    expect(answered.ok && answered.value.text).toBe(shown);
    const drafted = { action: 'log question', question: 'Does the response to Q3 cover R1.2 billion?' };
    expect(answered.ok && answered.value.offer).toEqual(drafted);
    const last = answering.turns[2].prompt;
    expect(last).toContain(`${revenue} · Answered\nQuestion: How did revenue move?`);
    expect(last).toContain(`Response to ${revenue}: Revenue fell in Q3 2026.`);
    expect(last).not.toMatch(/^[QR]\d+ · |Response to [QR]\d/m);
    const steps = answered.ok ? answered.value.research!.steps : [];
    expect(steps.some((step) => step.found?.some((x) => x.where === 'Q3 · response received'))).toBe(true);
  }, 60_000);

  it('a page past the last says how many pages there are', async () => {
    const s = setup(calls(qa(9)));
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    expect(result(s, 2)).toContain('Q&A: no page 9: there are 2 pages.');
  }, 60_000);

  it('the same page twice is refused; another page is not', async () => {
    const s = setup(calls(qa(), qa(1), qa('2')));
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    expect(s.turns[2].prompt).toContain('You searched Q&A for “lock-up ratio” already');
    expect(result(s, 4)).toContain('Page 2 of 2.');
  }, 60_000);

  it('a query of only filler words lists none', async () => {
    const s = setup(calls({ tool: 'search', what: 'qa', query: 'the of' }));
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    expect(result(s, 2)).toContain('Q&A: no question answers to these words.');
  }, 60_000);

  it('two deals share one ranking and one page count', async () => {
    const s = setup(calls(qa(), qa(2)));
    await questions(s.repo, 20, 'd1');
    await questions(s.repo, 20, 'd2');
    expect((await s.ai.answer(ask('What is outstanding?', ['d1', 'd2']))).ok).toBe(true);
    expect(result(s, 2)).toContain('Page 1 of 2.');
    expect((result(s, 3).match(/^Question: /gm) ?? []).length).toBe(15);
  }, 60_000);
  it('the first-step search of everything gives page 1 of each kind, naming the kind to page by', async () => {
    const s = setup(calls(qa(2)));
    await questions(s.repo, 40);
    await findings(s.repo, 40);
    expect((await s.ai.answer(ask('lock-up ratio'))).ok).toBe(true);
    const first = s.turns[0].prompt;
    expect(first).toContain('Page 1 of 2. Ask for page 2 of "qa" for more.');
    expect(first).toContain('Page 1 of 2. Ask for page 2 of "findings" for more.');
    expect(result(s, 2)).toContain('Page 2 of 2.');
  }, 60_000);
});

describe('searching findings from the chat, a page at a time', () => {
  it('lists 25 findings whole a page', async () => {
    const s = setup(calls({ tool: 'search', what: 'findings', query: 'lock-up ratio' }));
    await findings(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s, 2);
    expect((got.match(/^Finding “/gm) ?? []).length).toBe(25);
    expect(got).toContain(longText(0).trim());
    expect(got).toContain('Page 1 of 2. Ask for page 2 for more.');
  }, 60_000);
});

describe('the page a search asks for', () => {
  it('reads "2" as page 2, and anything that is not a whole number of 1 or more as page 1', () => {
    expect(pageNumber('2')).toBe(2);
    expect(pageNumber(3)).toBe(3);
    for (const v of [undefined, 0, -1, 1.5, 'two', null]) expect(pageNumber(v)).toBe(1);
  });
  it('is offered by the tool in both forms', () => {
    const search = toolSpecs(8).find((x) => x.name === 'search');
    expect(search).toBeTruthy();
    const params = (search ? search.parameters : {}) as { properties?: Fields };
    expect(params.properties?.page).toBeTruthy();
    expect(inlineTools(8)).toContain('"page"');
  });
});
