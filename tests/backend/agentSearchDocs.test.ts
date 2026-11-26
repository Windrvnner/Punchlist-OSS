// @vitest-environment node
/**
 * The chat's search of documents comes in fixed pages of 8 from the keyword ranking, which the search helper reads as
 * they are: no fast-model pick, and a blackline's clean draft beside it, within the 8 (#1102).
 */
import { describe, it, expect } from 'vitest';
import { nodeAi } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo, Mem } from '../adapters/memRepo';
import { tooLong } from '../../src/backend/limits';
import type { DocRecord } from '../../src/backend/documents';

type Call = { model: string; system?: string; prompt: string };
let t = 0;
const clock = () => new Date(Date.UTC(2026, 10, 26, 9, 0, 0, t++)).toISOString();
const doc = (n: number, name: string): DocRecord =>
  ({ docId: `doc_${String(n).padStart(24, '0')}`, hash: 'h', name, folder: 'vdr', rel: name, size: 1, pages: 4 });
const two = (i: number) => String(i).padStart(2, '0');
/** 30 turbine warranties, a blackline of one of them, and 30 permits that share no word with the query */
const roomWith = (blacklined: string): DocRecord[] => [
  ...Array.from({ length: 30 }, (_v, i) => doc(i + 1, `Turbine warranty ${two(i + 1)}.pdf`)),
  doc(31, `Turbine warranty ${blacklined} (blackline).pdf`),
  ...Array.from({ length: 30 }, (_v, i) => doc(i + 40, `Permit ${two(i + 1)}.pdf`)),
];
const ROOM = roomWith('05');
const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
const isPick = (c: Call) => c.prompt.includes('Which of them should be read');
const isRead = (c: Call) => c.prompt.startsWith('Documents:\n');
const answer = { text: 'ok', sources: [] };

const setup = (...tools: Record<string, unknown>[]) => setupIn(ROOM, tools);

/** `refuseOver`: a read of more documents than this is refused as too long, as a service refuses one */
function setupIn(room: DocRecord[], tools: Record<string, unknown>[], refuseOver = Infinity) {
  const turns: Call[] = []; const reads: Call[] = []; const picks: Call[] = [];
  const svc = new StandInService(async (c) => {
    const call = c as Call;
    if (isTurn(call)) { turns.push(call); return JSON.stringify(tools[turns.length - 1] ?? answer); }
    if (isPick(call)) picks.push(call);
    if (isRead(call) && names(call).length > refuseOver) throw tooLong('too long', 400);
    if (isRead(call)) reads.push(call);
    return JSON.stringify({ text: '', sources: [] });
  });
  (svc as { converse?: unknown }).converse = undefined;
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const docs = {
    records: () => room,
    wanted: async (_d: string, ids: string[]) => room.filter((r) => ids.includes(r.docId))
      .map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
  };
  const ai = nodeAi({ service: svc, keeper, repo: memRepo(clock), clock, docs, width: 8, library: [] });
  return { ai, turns, reads, picks };
}
/** the documents a read was given, in the order it lists them */
const names = (c: Call) =>
  [...c.prompt.matchAll(/^(?:\w+\/)?doc_[0-9a-f]{24}: (?:.*\/)?(.+?\.pdf)/gm)].map((m) => m[1]);
const docs = (page?: number) =>
  ({ tool: 'search', what: 'documents', query: 'turbine warranty', ...(page ? { page } : {}) });
const ask = (message: string) => ({ dealId: 'd1', message, history: [], model: 'standard' });
const RANKED = ['01', '02', '03', '04', '05', '05 (blackline)', '06', '07', '08', '09', '10', '11', '12', '13', '14',
  '15',
  ...Array.from({ length: 15 }, (_v, i) => two(i + 16))].map((x) => `Turbine warranty ${x}.pdf`);

describe('searching documents from the chat, a page at a time', () => {
  it('reads the first and second 8 of the ranking, with no pick, and says how many pages there are', async () => {
    const s = setup(docs(), docs(2));
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    const [first, second] = s.reads.slice(-2);
    expect(names(first)).toEqual(RANKED.slice(0, 8));
    expect(names(second)).toEqual(RANKED.slice(8, 16));
    expect(s.picks).toHaveLength(0);
    expect(s.turns[1].prompt).toContain('Page 1 of 4. Ask for page 2 for more.');
  }, 60_000);

  it('puts a blackline\'s clean draft just before it, within the 8', async () => {
    const s = setup(docs());
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    const got = names(s.reads[s.reads.length - 1]);
    expect(got).toHaveLength(8);
    expect(got.indexOf('Turbine warranty 05.pdf') + 1).toBe(got.indexOf('Turbine warranty 05 (blackline).pdf'));
  }, 60_000);

  it('never splits a blackline from its clean draft across pages: the pair starts the next page', async () => {
    const s = setupIn(roomWith('08'), [docs(), docs(2)]);
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    const [first, second] = s.reads.slice(-2).map(names);
    const warranty = (x: string) => `Turbine warranty ${x}.pdf`;
    expect(first).toEqual(['01', '02', '03', '04', '05', '06', '07'].map(warranty));
    expect(second).toEqual(['08', '08 (blackline)', '09', '10', '11', '12', '13', '14'].map(warranty));
    expect(s.turns[1].prompt).toContain('Page 1 of 4. Ask for page 2 for more.');
  }, 60_000);

  it('names the documents of a page the service took as too long to read together, so none is lost', async () => {
    const s = setupIn(ROOM, [docs()], 4);
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    expect(names(s.reads[s.reads.length - 1])).toEqual(RANKED.slice(0, 4));
    const left = RANKED.slice(4, 8).map((name) => `vdr/${name}`).join('; ');
    expect(s.turns[1].prompt).toContain(`with the others): ${left}. Read them by name`);
  }, 60_000);

  it('can be asked for the last page first: it holds the last 7', async () => {
    const s = setup(docs(4));
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    expect(names(s.reads[s.reads.length - 1])).toEqual(RANKED.slice(24));
    expect(s.turns[1].prompt).toContain('Page 4 of 4.');
  }, 60_000);

  it('after the first-step search of everything, page 2 is the second 8', async () => {
    const s = setup(docs(2));
    expect((await s.ai.answer(ask('turbine warranty'))).ok).toBe(true);
    expect(names(s.reads[0])).toEqual(RANKED.slice(0, 8));
    expect(s.turns[0].prompt).toContain('Page 1 of 4. Ask for page 2 of "documents" for more.');
    expect(names(s.reads[s.reads.length - 1])).toEqual(RANKED.slice(8, 16));
  }, 60_000);

  it('a page past the last says how many pages there are, and reads nothing', async () => {
    const s = setup(docs(9));
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    expect(s.turns[1].prompt).toContain('Documents: no page 9: there are 4 pages.');
  }, 60_000);
});
