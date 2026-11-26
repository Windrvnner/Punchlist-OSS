// @vitest-environment node
/**
 * The chat's search of the records the app holds (findings and the Q&A log), at deal scale: every record that shares a
 * word with the query comes back whole, best first, while it fits the room this reply has; the rest are counted (#480).
 */
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiOptions } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import type { Folder } from '../../src/backend/logRepository';
import type { DocRecord } from '../../src/backend/documents';

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
/** the characters one reply's tool results may take, at this compactAt: 60% of it, at 3 characters a token */
const roomAt = (compactAt: number) => Math.floor((compactAt * 60) / 100) * 3;
/** a 1,200-character response that names the lock-up, with its number in it so each one is told apart */
const longText = (i: number) =>
  `Response ${i}: the lock-up ratio is conformed. ${'The lenders accept it. '.repeat(52)}`;

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
  const ai = nodeAi({ service: svc, keeper, repo, clock, docs, width: 8, ...options });
  return { ai, repo, turns };
}
type Repo = ReturnType<typeof setup>['repo'];

/** 2,500 questions, `matching` of them on the lock-up (the first five also on the margin), each with a long response */
async function questions(repo: Repo, matching: number): Promise<void> {
  const data = (i: number) => {
    const on = i < matching;
    const text = on ? `Confirm the lock-up ratio${i < 5 ? ' and the margin' : ''} (${i})` : `Provide permit ${i}`;
    return { id: `q_${i}`, dealId: 'd1', n: i + 1, text, response: on ? longText(i) : 'Provided.', status: 'answered' };
  };
  const ids = Array.from({ length: 2_500 }, (_v, i) => i);
  const writes = ids.map((i) => ({ kind: 'question' as const, id: `q_${i}`, data: data(i), expectedRev: null }));
  const add = ids.map((i) => ({ kind: 'question' as const, id: `q_${i}` }));
  expect((await repo.transaction({ writes, index: { dealId: 'd1', add } })).ok).toBe(true);
}

/** `count` findings on the lock-up (the first five also on the margin), each with a long body, and 500 on others */
async function findings(repo: Repo, count: number): Promise<void> {
  const data = (i: number) => {
    const on = i < count;
    const title = on ? `Lock-up ratio${i < 5 ? ' and margin' : ''} differ ${i}` : `Permit ${i} is missing`;
    const body = [on ? longText(i) : 'It is not in the data room.'];
    return { id: `f_${i}`, dealId: 'd1', title, workstream: 'Legal', status: 'open', body, sources: [] };
  };
  const ids = Array.from({ length: count + 500 }, (_v, i) => i);
  const writes = ids.map((i) => ({ kind: 'finding' as const, id: `f_${i}`, data: data(i), expectedRev: null }));
  const add = ids.map((i) => ({ kind: 'finding' as const, id: `f_${i}` }));
  expect((await repo.transaction({ writes, index: { dealId: 'd1', add } })).ok).toBe(true);
}

const ask = (message: string) => ({ dealId: 'd1', message, history: [], model: 'standard' });
/** a turn hook that searches `what` for the query on turn 1, then answers */
const searchOnce = (what: string, query: string) => (_c: Call, n: number) =>
  (n === 1 ? { tool: 'search', what, query } : answer);
/** what the tool handed back in the second turn's prompt */
const result = (s: { turns: Call[] }) => {
  const prompt = s.turns[1].prompt;
  return prompt.slice(prompt.lastIndexOf('. You searched'), prompt.lastIndexOf('This is turn'));
};

describe('searching the Q&A log from the chat', () => {
  it('lists every question that shares a word, whole, best first', async () => {
    const s = setup(searchOnce('qa', 'lock-up margin'));
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s);
    for (let i = 0; i < 40; i++) expect(got).toContain(`Response to Q${i + 1}: ${longText(i).trim()}`);
    expect(got).not.toContain('Provide permit');
    expect(got).not.toContain('more matched');
    expect(got.indexOf('(4)')).toBeLessThan(got.indexOf('(5)'));
  }, 30_000);

  it('past the room, the rest are counted, and what is listed fits it', async () => {
    const s = setup(searchOnce('qa', 'lock-up margin'), { compactAt: 8_000 });
    await questions(s.repo, 40);
    const r = await s.ai.answer(ask('What is outstanding?'));
    expect(r.ok).toBe(true);
    const got = result(s);
    expect(got.length).toBeLessThan(roomAt(8_000));
    expect(got).toContain(`Response to Q1: ${longText(0).trim()}`);
    const counted = /and (\d+) more matched; search with more words/.exec(got);
    expect(Number(counted?.[1])).toBeGreaterThan(0);
    const listed = (got.match(/^Response to Q/gm) ?? []).length;
    expect(listed + Number(counted?.[1])).toBe(40);
    const step = r.ok ? r.value.research!.steps[1] : undefined;
    expect(step?.found?.length).toBe(listed);
  }, 30_000);
});

describe('searching findings from the chat', () => {
  it('lists every finding that shares a word, whole, best first', async () => {
    const s = setup(searchOnce('findings', 'lock-up margin'));
    await findings(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s);
    for (let i = 0; i < 40; i++) expect(got).toContain(`differ ${i}” (open): ${longText(i).trim()}`);
    expect(got).not.toContain('is missing');
    expect(got).not.toContain('more matched');
    expect(got.indexOf('differ 4”')).toBeLessThan(got.indexOf('differ 5”'));
  }, 30_000);

  it('past the room, the rest are counted, and what is listed fits it', async () => {
    const s = setup(searchOnce('findings', 'lock-up margin'), { compactAt: 8_000 });
    await findings(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    const got = result(s);
    expect(got.length).toBeLessThan(roomAt(8_000));
    const counted = /and (\d+) more matched; search with more words/.exec(got);
    const listed = (got.match(/^Finding “/gm) ?? []).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed + Number(counted?.[1])).toBe(40);
  }, 30_000);
});

describe('what the searches of one reply hand back, together', () => {
  it("the first turn's search of everything keeps findings and Q&A within the room together", async () => {
    const s = setup(() => answer, { compactAt: 8_000 });
    await findings(s.repo, 40);
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What about the lock-up ratio?'))).ok).toBe(true);
    const prompt = s.turns[0].prompt;
    const got = prompt.slice(prompt.indexOf('You searched'), prompt.lastIndexOf('This is turn'));
    expect(got.length).toBeLessThan(roomAt(8_000));
    expect(got).toMatch(/^Finding “/m);
    expect(got).toMatch(/^Response to Q/m);
  }, 30_000);

  it("a search after the first turn's search still has room, however much that one matched", async () => {
    const s = setup(searchOnce('qa', 'margin'));
    await questions(s.repo, 2_000);
    expect((await s.ai.answer(ask('What about the lock-up ratio?'))).ok).toBe(true);
    const got = result(s);
    for (let i = 0; i < 5; i++) expect(got).toContain(`Response to Q${i + 1}: ${longText(i).trim()}`);
    expect(got).not.toContain('more matched');
  }, 60_000);

  it('a search once the room is used comes back counted, and the reply answers on its last turn', async () => {
    const queries = (n: number) => `lock-up ${n}`;
    const turn = (c: Call, n: number) =>
      (c.prompt.includes('It is your last') ? answer : { tool: 'search', what: 'qa', query: queries(n) });
    const s = setup(turn, { compactAt: 8_000, turns: 25 });
    await questions(s.repo, 40);
    expect((await s.ai.answer(ask('What is outstanding?'))).ok).toBe(true);
    expect(s.turns.length).toBe(25);
    const last = s.turns[24].prompt;
    const results = last.slice(last.indexOf('What you have done so far'), last.lastIndexOf('This is turn'));
    // past the room, each turn adds only its count line
    expect(results.length).toBeLessThan(roomAt(8_000) + 25 * 200);
    expect(last).toContain('Q&A: 40 matched, past what fits here: search with more words.');
  }, 60_000);
});
