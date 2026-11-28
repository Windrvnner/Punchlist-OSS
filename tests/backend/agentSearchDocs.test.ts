// @vitest-environment node
/**
 * The chat's search of documents comes in fixed pages of 8 from the keyword ranking, which the search helper reads as
 * they are: no fast-model pick, and a blackline's clean draft beside it, within the 8 (#1102).
 */
import { describe, it, expect } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { carriedThread, localConversations } from '../../src/app/threads';
import { nodeAi } from '../../src/backend/ai';
import { StandInService, type ConverseInput } from '../../src/backend/service';
import { fromStoreName, StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo, Mem } from '../adapters/memRepo';
import { tooLong } from '../../src/backend/limits';
import type { DocRecord } from '../../src/backend/documents';

type Call = { model: string; system?: string; prompt: string; files: { name: string }[] };
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
const NO_HELP = { text: '', sources: [] };

/** `refuseOver`: a read of more documents than this is refused as too long, as a service refuses one */
function setupIn(
  room: DocRecord[],
  tools: Record<string, unknown>[],
  refuseOver = Infinity,
  help: Record<string, unknown> = NO_HELP,
  otherRooms: Record<string, DocRecord[]> = {},
  unavailable: string[] = [],
  toolCalls?: 'native',
) {
  const turns: Call[] = []; const reads: Call[] = []; const picks: Call[] = [];
  const svc = new StandInService(async (c) => {
    const call = c as Call;
    if (isTurn(call)) { turns.push(call); return JSON.stringify(tools[turns.length - 1] ?? answer); }
    if (isPick(call)) picks.push(call);
    if (isRead(call) && names(call).length > refuseOver) throw tooLong('too long', 400);
    if (isRead(call)) reads.push(call);
    return JSON.stringify(help);
  });
  const requests: ConverseInput[] = [];
  const converse = svc.converse.bind(svc);
  svc.converse = async (input) => {
    requests.push(input);
    return converse(input);
  };
  if (!toolCalls) (svc as { converse?: unknown }).converse = undefined;
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const records = (dealId: string) => otherRooms[dealId] ?? room;
  const docs = {
    records,
    wanted: async (dealId: string, ids: string[]) => records(dealId)
      .filter((r) => ids.includes(r.docId) && !unavailable.includes(r.docId))
      .map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
  };
  const ai = nodeAi({ service: svc, keeper, repo: memRepo(clock), clock, docs, width: 8, library: [],
    retry: { sleep: async () => {} }, ...(toolCalls ? { toolCalls } : {}) });
  return { ai, svc, turns, reads, picks, requests };
}
/** the documents a read was given, in the order it lists them */
const names = (c: Call) =>
  [...c.prompt.matchAll(/^(?:\w+\/)?doc_[0-9a-f]{24}: (?:.*\/)?(.+?\.pdf)/gm)].map((m) => m[1]);
const docs = (page?: number) =>
  ({ tool: 'search', what: 'documents', query: 'turbine warranty', ...(page ? { page } : {}) });
const ask = (message: string) => ({ dealId: 'd1', message, history: [], model: 'standard' });
const attachments = (docs: DocRecord[]) => docs.map((rec) => ({ doc: rec.name, docId: rec.docId }));
const sentNames = (call: Call) => call.files.map((file) => fromStoreName(file.name)!.name).sort();
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
    const left = RANKED.slice(4, 8).map((name) => ROOM.find((rec) => rec.name === name)!);
    expect(s.turns[1].prompt).toContain('with the others). Ask to read them by id:');
    for (const doc of left) expect(s.turns[1].prompt).toContain(`- ${doc.docId} (vdr/${doc.name})`);
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

describe('first-turn attachments use the same batches as the read tool (#1213)', () => {
  const first = [
    'Term Sheet.pdf', 'Land Lease.pdf', 'Side Letter.pdf', 'Board Minutes.pdf',
    'Power Purchase Agreement.pdf', 'Environmental Permit.pdf', 'Grid Connection Agreement.pdf',
  ].map((name, index) => doc(index + 1, name));

  it('names the blackline for another read before listing it as opened or allowing citations', async () => {
    const clean = doc(8, 'Credit Agreement.pdf');
    const blackline = doc(9, 'Credit Agreement (blackline).pdf');
    const blacklinePath = `vdr/${blackline.name}`;
    const s = setupIn([...first, clean, blackline], [
      { tool: 'read', docs: [blacklinePath] },
      { text: 'The ratio changed. [1] The draft sets it at 1.20x. [2]',
        sources: [{ doc: blackline.docId, page: 3 }, { doc: clean.docId, page: 4 }] },
    ]);
    const result = await s.ai.answer({ ...ask('Summarize.'), attachments: attachments([...first, blackline]),
      runId: 'read-boundary' });
    expect(sentNames(s.turns[0])).toEqual(first.map(({ name }) => name).sort());
    expect(s.turns[0].prompt).toContain(blacklinePath);
    expect(names(s.turns[0])).not.toContain(blackline.name);
    expect(names(s.turns[0])).not.toContain(clean.name);
    expect(sentNames(s.turns[1])).toEqual([blackline.name, clean.name]);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [{ docId: blackline.docId, loc: 'p. 3', reading: true }, { docId: clean.docId, loc: 'p. 4' }],
      research: { read: { docs: 9, of: 9 } },
    } });
  });

  it('uses the deal-qualified id to defer a file on Home when a deal has the same path', async () => {
    const own = 'me_00112233aabbccdd';
    const credit = doc(10, 'Credit Agreement.pdf');
    const room = [...first, doc(9, 'Technical Due Diligence.pdf'), credit];
    const handle = `${own}/${credit.docId}`;
    const s = setupIn(room, [
      { tool: 'read', docs: [handle] },
      { text: 'The facility is secured. [1]', sources: [{ doc: handle, page: 2 }] },
    ], Infinity, NO_HELP, { d1: [doc(11, credit.name)] });
    const result = await s.ai.answer({ message: 'Summarize.', history: [], model: 'standard',
      dealIds: ['d1'], files: own, attachments: attachments(room) });
    expect(s.turns[0].prompt).toContain(`${handle} (vdr/${credit.name})`);
    expect(sentNames(s.turns[0])).toEqual(room.slice(0, 8).map(({ name }) => name).sort());
    expect(sentNames(s.turns[1])).toEqual([credit.name]);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [{ docId: credit.docId, dealId: own, loc: 'p. 2' }],
    } });
  });

  it.each([undefined, 'native'] as const)('retries the selected file when two attachments share a path (%s)',
    async (mode) => {
      const name = 'Credit Agreement.pdf';
      const copy = (n: number): DocRecord => {
        const rec = doc(n, name);
        return { ...rec, folder: '@attachments', rel: `d1/pc-one/${rec.docId}.pdf` };
      };
      const other = copy(10);
      const selected = copy(11);
      const requested = [...first, doc(9, 'Technical Due Diligence.pdf'), selected];
      const s = setupIn([other, ...requested], [
        { tool: 'read', docs: [selected.docId] },
        { text: 'The facility is secured. [1]', sources: [{ doc: selected.docId, page: 2 }] },
      ], Infinity, NO_HELP, {}, [], mode);
      const result = await s.ai.answer({ ...ask('Summarize.'), attachments: attachments(requested) });
      expect(s.turns[0].prompt).toContain(`${selected.docId} (@attachments/d1/pc-one/${name})`);
      expect(s.turns[1].files.map(({ name }) => fromStoreName(name)?.docId)).toEqual([selected.docId]);
      expect(result).toMatchObject({ ok: true, value: { sources: [{ docId: selected.docId, loc: 'p. 2' }] } });
    });

  it('names an unavailable clean draft and counts the files actually sent', async () => {
    const clean = doc(8, 'Credit Agreement.pdf');
    const blackline = doc(9, 'Credit Agreement (blackline).pdf');
    const s = setupIn([clean, blackline, first[0]], [
      { tool: 'read', docs: [blackline.name, first[0].name] },
      { text: 'The facility is secured. [1]', sources: [{ doc: blackline.docId, page: 2 }] },
      { text: 'The term sheet sets the terms. [1]', sources: [{ doc: first[0].docId, page: 1 }] },
    ], Infinity, NO_HELP, {}, [clean.docId]);
    const result = await s.ai.answer({ ...ask('Summarize.'), runId: 'unavailable-draft' });
    expect(sentNames(s.turns[1])).toEqual([first[0].name]);
    expect(s.turns[1].prompt).toContain(`These files could not be attached.\n- ${clean.docId} (vdr/${clean.name})`);
    expect(s.turns[1].prompt).toContain(`- ${blackline.docId} (vdr/${blackline.name})`);
    expect(names(s.turns[1])).not.toContain(clean.name);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [{ docId: first[0].docId, loc: 'p. 1' }], research: { read: { docs: 1, of: 3 } },
    } });
    if (result.ok) expect(result.value.research?.steps.filter(({ kind }) => kind === 'read'))
      .toEqual([expect.objectContaining({ text: `Reviewed ${first[0].name}` })]);
  });

  it('reads a blackline after the kept conversation has received its clean draft', async () => {
    const clean = doc(8, 'Credit Agreement.pdf');
    const blackline = doc(9, 'Credit Agreement (blackline).pdf');
    const unavailable: string[] = [];
    const s = setupIn([clean, blackline], [
      { tool: 'read', docs: [clean.name] },
      { toJSON() {
        unavailable.push(clean.docId);
        return { tool: 'read', docs: [blackline.name] };
      } },
      { text: 'The ratio changed. [1]', sources: [{ doc: blackline.docId, page: 2 }] },
    ], Infinity, NO_HELP, {}, unavailable, 'native');
    const result = await s.ai.answer(ask('Summarize.'));
    expect(sentNames(s.turns[1])).toEqual([clean.name]);
    expect(sentNames(s.turns[2])).toEqual([blackline.name]);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [{ docId: blackline.docId, loc: 'p. 2', reading: true }], research: { read: { docs: 2, of: 2 } },
    } });
  });
});

describe('what the search helper writes is kept as written', () => {
  it('reaches the next turn with its leading and trailing spacing', async () => {
    const s = setupIn(ROOM, [docs()], Infinity, { text: ' Helper words.\t', sources: [] });
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    expect(s.turns[1].prompt).toContain('opened');
    expect(s.turns[1].prompt).toContain(' Helper words.\t');
  }, 60_000);
});

describe('a blackline needs its clean draft in the same model context (#1430)', () => {
  const clean = doc(8, 'Credit Agreement.pdf');
  const blackline = doc(9, 'Credit Agreement (blackline).pdf');
  const room = [clean, blackline];
  const read = (document: DocRecord) => ({ tool: 'read', docs: [document.name] });
  const facts = { text: 'The ratio changed. [1]', sources: [{ doc: blackline.docId, page: 2 }] };

  async function reopenCleanDraft(s: ReturnType<typeof setupIn>) {
    const first = await s.ai.answer({ ...ask('Summarize.'), attachments: attachments([clean]) });
    if (!first.ok || !first.value.thread) throw Error('The clean draft was not kept in its model conversation.');
    expect(sentNames(s.turns[0])).toEqual([clean.name]);
    const local = new MemoryLocal();
    await localConversations(local).save('d1', [{ id: 'one', role: 'ai', text: 'ok', state: 'done',
      at: clock(), thread: first.value.thread,
    }]);
    const saved = await localConversations(local).load();
    if (!saved.ok) throw Error('The conversation could not be loaded.');
    const thread = carriedThread(saved.value.d1);
    expect(thread).toMatchObject({ whole: [{ dealId: 'd1', docId: clean.docId }] });
    if (!thread) throw Error('The model thread was lost.');
    return thread;
  }

  function expectRetryContext(change: string, requests: ConverseInput[], id: string) {
    const [initial, accepted] = requests.slice(1);
    if (change === 'gone') {
      expect(initial.conversation).toBe(id);
      expect(initial.files).toHaveLength(1);
      expect(accepted.conversation).toBeUndefined();
      expect(accepted.files).toBeUndefined();
    }
    if (change === 'hybrid') {
      expect(initial.results).toHaveLength(1);
      expect(accepted.conversation).toBe(id);
      expect(accepted.results).toBeUndefined();
      expect(accepted.files).toEqual(initial.files);
    }
  }

  function changeContext(context: string, svc: StandInService, thread: Awaited<ReturnType<typeof reopenCleanDraft>>) {
    if (context === 'gone') svc.conversations.delete(thread.id);
    if (context === 'compacted') thread.tokens = 1_000_000;
    if (context === 'hybrid') svc.noToolResults = true;
  }

  it('names both unopenable files in automatic search and first-turn attachments', async () => {
    const s = setupIn(room, [], Infinity, NO_HELP, {}, [clean.docId]);
    const result = await s.ai.answer({
      ...ask('Summarize the credit agreement.'), attachments: attachments([blackline]),
    });
    expect(s.reads).toEqual([]);
    expect(sentNames(s.turns[0])).toEqual([]);
    const prompt = s.turns[0].prompt;
    expect(prompt.split(`vdr/${clean.name}`)).toHaveLength(3);
    expect(prompt.split(`vdr/${blackline.name}`)).toHaveLength(3);
    expect(result).toMatchObject({ ok: true, value: { sources: [], research: { read: { docs: 0, of: 2 } } } });
  });

  it('retries the exact omitted search result when two deals share a path', async () => {
    const other = doc(10, clean.name);
    const handle = `d2/${other.docId}`;
    const unavailable = [clean.docId, other.docId];
    const s = setupIn(room, [{
      toJSON() { unavailable.length = 0; return { tool: 'read', docs: [handle] }; },
    }, { text: 'The facility is secured. [1]', sources: [{ doc: handle, page: 2 }] }],
    Infinity, NO_HELP, { d2: [other] }, unavailable, 'native');
    const result = await s.ai.answer({ message: 'Credit Agreement', history: [], model: 'standard',
      dealIds: ['d1', 'd2'],
    });
    expect(s.turns[0].prompt).toContain(`d1/${clean.docId} (vdr/${clean.name})`);
    expect(s.turns[0].prompt).toContain(`${handle} (vdr/${other.name})`);
    expect(s.turns[1].files.map(({ name }) => fromStoreName(name)?.docId)).toEqual([other.docId]);
    expect(result).toMatchObject({ ok: true, value: { sources: [{ dealId: 'd2', docId: other.docId }] } });
  });

  it('names omitted folder evidence and reads the pair when files become available again', async () => {
    const other = doc(7, 'Board Minutes.pdf');
    const unavailable = [clean.docId];
    const folder = { tool: 'folder', folder: 'vdr', lookFor: 'facility terms' };
    const s = setupIn([...room, other], [folder, {
      toJSON() { unavailable.pop(); return folder; },
    }, facts], Infinity, NO_HELP, {}, unavailable);
    const result = await s.ai.answer(ask('Summarize.'));
    expect(s.reads.map(sentNames)).toEqual([[other.name], [blackline.name, clean.name].sort()]);
    expect(s.turns[1].prompt).toContain(`vdr/${clean.name}`);
    expect(s.turns[1].prompt).toContain(`vdr/${blackline.name}`);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [{ docId: blackline.docId, reading: true }], research: { read: { docs: 3, of: 3 } },
    } });
  });

  it('a clean draft searched by a helper cannot authorize the main chat to read the blackline', async () => {
    const unavailable: string[] = [];
    const s = setupIn(room, [{
      toJSON() { unavailable.push(clean.docId); return read(blackline); },
    }], Infinity, NO_HELP, {}, unavailable, 'native');
    const result = await s.ai.answer(ask('Summarize the credit agreement.'));
    expect(s.reads.map(sentNames)).toEqual([[blackline.name, clean.name].sort()]);
    expect(sentNames(s.turns[1])).toEqual([]);
    expect(s.turns[1].prompt).toContain(`vdr/${blackline.name}`);
    expect(result).toMatchObject({ ok: true });
  });

  it('does not credit a clean draft when the model rejects the turn that tried to send it', async () => {
    const unavailable: string[] = [];
    const s = setupIn(room, [read(clean), {
      toJSON() {
        unavailable.push(clean.docId);
        throw Object.assign(new Error('The conversation is gone'), { code: 'gone' });
      },
    }, read(blackline)], Infinity, NO_HELP, {}, unavailable, 'native');
    const result = await s.ai.answer(ask('Summarize.'));
    expect(s.turns.map(sentNames)).toEqual([[], [clean.name], [], []]);
    expect(s.requests.map(({ conversation }) => Boolean(conversation))).toEqual([false, true, false, true]);
    expect(result).toMatchObject({ ok: true, value: {
      sources: [], thread: { opened: [] }, research: { read: { docs: 0, of: 2 } },
    } });
  });

  it('does not borrow a similarly named clean draft from another deal', async () => {
    const unavailable: string[] = [];
    const other = room.map((rec) => ({ ...rec, folder: 'legal' }));
    const s = setupIn([clean], [{ tool: 'read', docs: [`vdr/${clean.name}`] }, {
      toJSON() {
        unavailable.push(clean.docId);
        return { tool: 'read', docs: [`legal/${blackline.name}`] };
      },
    }], Infinity, NO_HELP, { d2: other }, unavailable, 'native');
    const result = await s.ai.answer({ dealIds: ['d1', 'd2'], message: 'Summarize.', model: 'standard', history: [] });
    expect(s.turns.map(sentNames)).toEqual([[], [clean.name], []]);
    expect(s.turns[2].prompt).toContain(`d2/${blackline.docId} (legal/${blackline.name})`);
    expect(result).toMatchObject({ ok: true, value: { research: { read: { docs: 1, of: 3 } } } });
  });

  it.each(['kept', 'hybrid', 'gone', 'compacted', 'changed'] as const)(
    'qualifies a previously attached clean draft only in its kept model context (%s)', async (context) => {
      const unavailable: string[] = [];
      const allowed = context === 'kept' || context === 'hybrid';
      const s = setupIn(room, [answer, allowed ? facts : answer], Infinity, NO_HELP, {}, unavailable, 'native');
      const thread = await reopenCleanDraft(s);
      unavailable.push(clean.docId);
      changeContext(context, s.svc, thread);
      const result = await s.ai.answer({ ...ask('What changed?'), thread, attachments: attachments([blackline]),
        ...(context === 'changed' ? { model: 'thorough' } : {}),
      });
      expectRetryContext(context, s.requests, thread.id);
      expect(sentNames(s.turns[1])).toEqual(allowed ? [blackline.name] : []);
      expect(result).toMatchObject({ ok: true, value: { sources: allowed
        ? [{ docId: blackline.docId, reading: true }] : [], research: { read: { docs: allowed ? 1 : 0, of: 2 } },
      } });
      if (!allowed) expect(s.turns[1].prompt).toContain(`vdr/${blackline.name}`);
    },
  );

  it('still lets a standalone blackline through a stateless turn', async () => {
    const s = setupIn([blackline], [facts]);
    const result = await s.ai.answer({ ...ask('Summarize.'), attachments: attachments([blackline]) });
    expect(sentNames(s.turns[0])).toEqual([blackline.name]);
    expect(result).toMatchObject({ ok: true, value: { sources: [{ docId: blackline.docId, reading: true }] } });
  });

  it('a stateless call cannot use a previous turn’s clean draft', async () => {
    const unavailable: string[] = [];
    const s = setupIn(room, [read(clean), {
      toJSON() { unavailable.push(clean.docId); return read(blackline); },
    }], Infinity, NO_HELP, {}, unavailable);
    const result = await s.ai.answer(ask('Summarize.'));
    expect(s.turns.map(sentNames)).toEqual([[], [clean.name], []]);
    expect(s.turns[2].prompt).toContain(`vdr/${blackline.name}`);
    expect(result).toMatchObject({ ok: true, value: { research: { read: { docs: 1, of: 2 } } } });
  });
});
