// @vitest-environment node
/**
 * Asking the chat to read a whole folder: which folder a name means, the ranked list of its documents, and
 * reading them a batch at a time, at realistic scale (a data room of 700 documents, 400 of them in the folder).
 */
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiOptions } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import type { DocRecord } from '../../src/backend/documents';
import type { Folder } from '../../src/backend/logRepository';
import { folderKey, foldersOf, matchFolders } from '../../src/backend/folderList';

class Mem implements Folder { files = new Map<string, string>(); list() { return [...this.files.keys()]; } size(n: string) { return this.files.get(n)?.length ?? -1; } read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); } }
type Call = { model: string; system?: string; prompt: string; files: { id: string; name: string; text: string }[] };
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 16, 9, 0, 0, t++)).toISOString();
let n = 0;
const doc = (rel: string, extra: Partial<DocRecord> = {}): DocRecord => ({ docId: `doc_${String(++n).padStart(24, '0')}`, hash: 'h', name: rel.split('/').pop()!, folder: 'D:/Rooms/VDR', rel, size: 1, pages: 10, ...extra });

/** 400 permits (one of them the interconnection permit, which matters most), 300 other documents, and a folder named like the permits one inside another */
function room() {
  const permits = Array.from({ length: 399 }, (_v, i) => doc(`07. Permits/Local/Permit ${String(i + 1).padStart(3, '0')}.pdf`, { summary: `Local permit number ${i + 1}.` }));
  const grid = doc('07. Permits/Interconnection permit.pdf', { summary: 'Interconnection permit, expiry 2031.' });
  const other = Array.from({ length: 300 }, (_v, i) => doc(`03. Finance/Report ${i + 1}.pdf`, { summary: 'A finance report.' }));
  return { all: [...other, ...permits, grid] };
}

const isTurn = (c: Call) => !!c.system?.includes('You work in turns');
const isPriority = (c: Call) => c.prompt.includes('In what order should they be read?');
const isBatch = (c: Call) => c.prompt.includes('which is being read a batch at a time');
/** the tags a batch's listing gives its documents, in order */
const listed = (c: Call) => [...c.prompt.matchAll(/^(D\d+): (.*?)(?: \(\d+ pages\))?$/gm)].map((m) => ({ tag: m[1], path: m[2] }));

function setup(recs: DocRecord[], turn: (c: Call, n: number) => unknown, more: Partial<AiOptions> & { reads?: (c: Call, n: number) => unknown; talks?: boolean } = {}) {
  const turns: Call[] = []; const priorities: Call[] = []; const batches: Call[] = []; const others: Call[] = [];
  const { reads = () => ({ text: '', sources: [] }), talks = false, ...options } = more;
  const svc = new StandInService(async (c) => {
    const call = c as Call;
    const r = isTurn(call) ? (turns.push(call), turn(call, turns.length)) : isPriority(call) ? (priorities.push(call), { order: [] }) : isBatch(call) ? (batches.push(call), reads(call, batches.length)) : (others.push(call), call.prompt.includes('It cannot be read as written') ? 'still not JSON' : { text: '', sources: [] });
    const got = await r; return typeof got === 'string' ? got : JSON.stringify(got);
  });
  if (!talks) (svc as { converse?: unknown }).converse = undefined;      // a service that keeps no conversations, unless `talks`
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const ai = nodeAi({ service: svc, keeper, repo: memRepo(clock), clock, docs: { records: (d) => (d === 'd1' ? recs : []), wanted: async (_d, ids) => recs.filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })) }, width: 8, ...options });
  return { ai, svc, turns, priorities, batches, others };
}
const ask = (message: string) => ({ dealId: 'd1', message, history: [], model: 'standard' });

describe('which folder a name means', () => {
  const dirs = foldersOf(['VDR/07. Permits/Local/A.pdf', 'VDR/07. Permits/B.pdf', 'VDR/03. Finance/Permits/C.pdf', 'VDR/Permits - Environmental/D.pdf', 'VDR/Old/E.pdf']);
  it('compares names as people say them: no leading number, no case, no word "folder"', () => {
    expect(folderKey('04.1. Permits')).toBe('permits'); expect(folderKey('the Permits folder')).toBe('permits'); expect(folderKey('Site_Photos')).toBe('site photos');
    expect(matchFolders(dirs, 'permits')).toEqual(['VDR/03. Finance/Permits', 'VDR/07. Permits']);
    expect(matchFolders(dirs, 'Permits folder')).toEqual(['VDR/03. Finance/Permits', 'VDR/07. Permits']);
  });
  it('a path says which one; a folder inside a match is read with it', () => {
    expect(matchFolders(dirs, 'Finance/Permits')).toEqual(['VDR/03. Finance/Permits']);
    expect(matchFolders(dirs, '07 Permits > Local')).toEqual(['VDR/07. Permits/Local']);
    expect(matchFolders([...dirs, 'VDR/07. Permits/Permits'], '07. Permits')).toEqual(['VDR/07. Permits']);
  });
  it('failing a whole name, a folder whose own name has every word said; nothing for a name that is not there', () => {
    expect(matchFolders(dirs, 'environmental permits')).toEqual(['VDR/Permits - Environmental']);
    expect(matchFolders(dirs, 'insurance')).toEqual([]); expect(matchFolders(dirs, ' / ')).toEqual([]);
  });
});

describe('reading a whole folder from the chat', () => {
  /** the grid permit's tag, as the batch that read it gave it, and a stand-in that finds the expiry in it alone */
  const gridReads = (seen: { tag?: string }) => (c: Call) => { const g = listed(c).find((x) => x.path.endsWith('Interconnection permit.pdf')); if (g) seen.tag = g.tag; return g ? { text: 'It expires on March 1, 2031. [1]', sources: [{ doc: g.tag, page: 1, quote: 'expires on March 1, 2031' }] } : { text: '', sources: [] }; };

  it('lists the folder by priority and reads all of it, a batch at a time; a folder over the size set is read only once the person agrees', async () => {
    const { all } = room(); const seen: { tag?: string } = {};
    // first question: the folder is over the size set, so the person is asked; second: they agreed, and it is read whole
    const s = setup(all, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'the permits folder', lookFor: 'expiry dates' } : k === 2 ? { text: 'The permits folder has 400 documents. Shall I read all of them?', sources: [] } : k === 3 ? { tool: 'folder', folder: '07. Permits', lookFor: 'expiry dates', all: true } : k === 4 ? { tool: 'folder', folder: 'permits', lookFor: 'Expiry  dates' } : { text: 'The grid permit expires in 2031. [1]', sources: [{ doc: seen.tag, page: 1 }] }), {
      folderDocs: 160,
      reads: gridReads(seen),
    });
    const asked = await s.ai.answer({ ...ask('Review the permits folder: when do they expire?'), conversation: 'c1' }); expect(asked.ok).toBe(true);
    expect(s.turns[1].prompt).toContain('VDR/07. Permits has 400 documents, more than the 160 that are read without asking. Nothing more has been read. Answer now, with no tool, by asking the person whether to read all 400 of them');
    expect(s.batches.length).toBe(0);
    // the folder's order is the code's ranking: no model is asked for it
    expect(s.priorities.length).toBe(0);
    const r = await s.ai.answer({ ...ask('Yes, read all of it'), conversation: 'c1', history: [{ role: 'me' as const, text: 'Review the permits folder: when do they expire?' }, { role: 'ai' as const, text: 'The permits folder has 400 documents. Shall I read all of them?' }] }); expect(r.ok).toBe(true); const v = r.ok ? r.value : null;
    // all 400, 8 a batch: 50 batches; nothing outside the folder; never more than 8 at once; the ranking's first document first
    expect(s.batches.length).toBe(50); expect(s.batches.every((b) => b.model === 'fast' && b.files.length <= 8 && b.files.length > 0)).toBe(true);
    const order = s.batches.flatMap((b) => listed(b).map((x) => x.path));
    expect(new Set(order).size).toBe(400); expect(order.every((p) => p.startsWith('VDR/07. Permits/'))).toBe(true);
    expect(order[0]).toBe('VDR/07. Permits/Interconnection permit.pdf');
    expect(s.turns[3].prompt).toContain('You had all 400 documents in VDR/07. Permits read for “expiry dates”, the most important first; 400 were read.');
    expect(s.turns[3].prompt).toMatch(/What they say:\nDocuments 1–8: D\d+(, D\d+){7}\. It expires on March 1, 2031\. \[D\d+ p\. 1\]\n49 batches said nothing about it/);
    // only the document that said something is listed to cite; the 399 that said nothing are not
    expect(s.turns[3].prompt).toContain(`${seen.tag}: VDR/07. Permits/Interconnection permit.pdf`); expect(s.turns[3].prompt).not.toContain('Local/Permit 001.pdf');
    // the same folder for the same thing, however written, is not read again
    expect(s.turns[4].prompt).toContain('You have had all 400 documents in VDR/07. Permits read for “Expiry dates” in this conversation already');
    // the trace: one listing step, then a step per batch, each with what it found; the answer cites the permit; all 400 counted as searched
    const steps = v!.research!.steps; const folderSteps = steps.filter((x) => x.text.includes('in “VDR/07. Permits”'));
    expect(steps.filter((x) => x.text.startsWith('Listed the documents in')).map((x) => [x.text, x.result])).toEqual([['Listed the documents in “07. Permits” by priority', '400 documents']]);
    expect(folderSteps.length).toBe(50); expect(folderSteps[0]).toMatchObject({ kind: 'read', text: 'Reviewed documents 1–8 of 400 in “VDR/07. Permits”', result: '1 passage', done: true });
    expect(folderSteps[0].found?.[0]).toEqual({ where: 'Interconnection permit.pdf, p. 1', quote: '“expires on March 1, 2031”' }); expect(folderSteps[1].result).toBe('nothing on this');
    expect(v!.sources.map((x) => [x.doc, x.loc])).toEqual([['Interconnection permit.pdf', 'p. 1']]);
    expect(v!.read!.docs).toBeGreaterThanOrEqual(400); expect(v!.read!.of).toBe(700);
  });

  it('read for something else, the same folder is read again from the top', async () => {
    const recs = Array.from({ length: 30 }, (_v, i) => doc(`07. Permits/P${i + 1}.pdf`));
    const s = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits', lookFor: 'expiry' } : k === 2 ? { tool: 'folder', folder: 'permits', lookFor: 'environmental conditions' } : { text: 'ok', sources: [] }));
    expect((await s.ai.answer(ask('Permits?'))).ok).toBe(true);
    expect(s.turns[2].prompt).toContain('You had all 30 documents in VDR/07. Permits read for “environmental conditions”'); expect(s.batches.length).toBe(8); expect(s.priorities.length).toBe(0);
  });

  it('a folder of 2,000 documents that all say something keeps the main session\'s prompt bounded', async () => {
    const recs = Array.from({ length: 2000 }, (_v, i) => doc(`Permits/Permit ${String(i + 1).padStart(4, '0')}.pdf`));
    const s = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits', lookFor: 'expiry' } : { text: 'ok', sources: [] }), {
      folderDocs: 5000,
      // every batch finds something in each of its documents, at length
      reads: (c) => { const l = listed(c); return { text: l.map((x, i) => `${x.path} expires in 2030 and carries conditions on noise, dust, water use, traffic and reporting that the sponsor must meet every quarter. [${i + 1}]`).join(' '), sources: l.map((x) => ({ doc: x.tag, page: 1, quote: 'expires in 2030' })) }; },
    });
    expect((await s.ai.answer(ask('Review the permits folder'))).ok).toBe(true);
    expect(s.batches.length).toBe(250);
    const next = s.turns[1].prompt; expect(next.length).toBeLessThan(40_000);
    expect(next).toContain('You had all 2000 documents in VDR/Permits read'); expect(next).toMatch(/Documents \d+–\d+: passages at D\d+ p\. 1/); expect(next).toMatch(/\d+ more batches found passages, past what fits here/);
  }, 30_000);

  it('a folder read through says so; a name that matches none gets the folders that are there', async () => {
    const small = Array.from({ length: 20 }, (_v, i) => doc(`Insurance/Policy ${i + 1}.pdf`));
    const s = setup(small, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits' } : k === 2 ? { tool: 'folder', folder: 'insurance' } : k === 3 ? { tool: 'folder', folder: 'Insurance' } : k === 4 ? { tool: 'folder' } : { text: 'Done.', sources: [] }));
    const r = await s.ai.answer(ask('What do the policies cover?')); expect(r.ok).toBe(true);
    expect(s.turns[1].prompt).toContain('No folder answers to “permits”. The data room\'s folders include: VDR; VDR/Insurance. Name a folder that is there, or search instead.');
    expect(s.turns[2].prompt).toContain('You had all 20 documents in VDR/Insurance read'); expect(s.turns[2].prompt).toContain('None of them says anything about it.'); expect(s.batches.length).toBe(3);
    expect(s.turns[3].prompt).toContain('You have had all 20 documents in VDR/Insurance read for');
    expect(s.turns[4].prompt).toContain('You asked for a folder without naming it');
  });

  it('the ranking is the order: what the words ask for first, then by path', async () => {
    const recs = [doc('Permits/Aaa note.pdf'), doc('Permits/Zzz expiry schedule.pdf'), doc('Permits/Bbb environmental report.pdf')];
    const s = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'Permits', lookFor: 'expiry' } : { text: 'ok', sources: [] }), { width: 1, library: [] });   // no library group names these, so none of them is core
    expect((await s.ai.answer(ask('When do they expire?'))).ok).toBe(true);
    expect(s.batches.map((b) => listed(b)[0].path)).toEqual(['VDR/Permits/Zzz expiry schedule.pdf', 'VDR/Permits/Aaa note.pdf', 'VDR/Permits/Bbb environmental report.pdf']);
  });

  it('a batch whose reply cannot be read, or whose documents cannot be opened, is said so, and its documents are not counted as searched; the service out of reach fails the answer', async () => {
    const recs = Array.from({ length: 24 }, (_v, i) => doc(`Permits/P${i + 1}.pdf`)); const missing = new Set(recs.filter((r) => /^P(24|[3-9])\.pdf$/.test(r.name)).map((r) => r.docId));   // the third batch, as the ranking orders them by path (P1, P10 … P16; P17 … P23; P24, P3 … P9)
    const s = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits' } : { text: 'ok', sources: [] }), { reads: (_c, k) => (k === 2 ? 'not json at all' : { text: '', sources: [] }) });
    expect((await s.ai.answer(ask('Anything odd?'))).ok).toBe(true);
    // also: the third batch cannot be opened on this PC; with the second unreadable, 8 were searched
    const w = setupWithout(recs, missing); const r = await w.ai.answer(ask('Anything odd?')); expect(r.ok).toBe(true);
    expect(w.turns[1].prompt).toContain('Not read: documents 9–16 (the reply on them could not be read); documents 17–24 (they could not be opened on this PC).');
    expect(s.turns[1].prompt).toContain('Not read: documents 9–16 (the reply on them could not be read).'); expect(s.turns[1].prompt).toContain('16 were read');
    const v = r.ok ? r.value : null; expect(v!.read!.docs).toBe(8); expect(w.turns[1].prompt).not.toContain('Permits/P3.pdf');
    const down = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits' } : { text: 'ok', sources: [] }), { reads: () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
    const d = await down.ai.answer(ask('Anything odd?')); expect(!d.ok && d.error.kind).toBe('unreachable');
  });

  it('stopped by the person: no new batch is started, the main session answers at once, and asked to read on later it carries on where it stopped', async () => {
    const recs = Array.from({ length: 200 }, (_v, i) => doc(`Permits/P${String(i + 1).padStart(3, '0')}.pdf`)); let ai: ReturnType<typeof setup>['ai'] | null = null; let stopAt = 4;
    const s = setup(recs, (_c, k) => (k === 1 || k === 3 ? { tool: 'folder', folder: 'permits', lookFor: 'expiry' } : { text: 'Read part of it.', sources: [] }), {
      reads: async (_c, k) => { if (k === stopAt) expect((await ai!.stop!('run-1')).ok).toBe(true); return { text: '', sources: [] }; },
    });
    ai = s.ai;
    const r = await s.ai.answer({ ...ask('Review the permits folder'), runId: 'run-1', conversation: 'c1' }); expect(r).toMatchObject({ ok: true });
    // three batches at a time: the fourth stops it, and the ones already started finish; none after
    const first = s.batches.length; expect(first).toBeLessThanOrEqual(6); expect(s.turns.length).toBe(2);
    const m = /The person stopped the reading of VDR\/Permits for “expiry” after (\d+) of 200 documents/.exec(s.turns[1].prompt); expect(m).not.toBeNull(); const upto = +m![1]; expect(upto).toBe(first * 8);
    expect(s.turns[1].prompt).toContain('The person stopped the research: answer now from what you have, with no tool');
    const v = r.ok ? r.value : null; const steps = v!.research!.steps;
    expect(steps.at(-1)).toEqual({ kind: 'stop', text: 'Stopped', result: 'answered from what was found', done: true });
    expect(v!.text).toBe('Read part of it.');
    expect(await s.ai.stop!('run-1')).toEqual({ ok: true, value: false });   // no longer being worked on
    // the next message, "read the rest": it reads on from the next document, in the same order, and not from the top
    stopAt = -1; const before = s.batches.length;
    expect((await s.ai.answer({ ...ask('Read the rest'), conversation: 'c1' })).ok).toBe(true);
    const again = s.batches.slice(before).flatMap((b) => listed(b).map((x) => x.path));
    expect(again[0]).toBe(`VDR/Permits/P${String(upto + 1).padStart(3, '0')}.pdf`); expect(again.length).toBe(200 - upto);
    expect(s.turns[3].prompt).toContain(`You had the other ${200 - upto} documents in VDR/Permits read for “expiry”`); expect(s.turns[3].prompt).toContain(`${upto} of its documents were read for this earlier in this conversation; these are the other ${200 - upto}.`);
  });

  it('what was read is kept per conversation: a batch that failed, and documents added since, are read on the next ask; another conversation reads afresh', async () => {
    const recs = Array.from({ length: 20 }, (_v, i) => doc(`Permits/P${String(i + 1).padStart(2, '0')}.pdf`));
    const s = setup(recs, (_c, k) => (k % 2 === 0 ? { text: 'ok', sources: [] } : { tool: 'folder', folder: 'permits', lookFor: 'expiry' }), { reads: (_c, k) => (k === 2 ? 'not json at all' : { text: '', sources: [] }) });
    const paths = (from: number) => s.batches.slice(from).flatMap((b) => listed(b).map((x) => x.path)).sort();
    expect((await s.ai.answer({ ...ask('Review the permits folder'), conversation: 'c1' })).ok).toBe(true);
    expect(s.batches.length).toBe(3); expect(s.turns[1].prompt).toContain('Not read: documents 9–16 (the reply on them could not be read).');
    // asked again: only the batch whose reply could not be read is read again
    let from = s.batches.length; expect((await s.ai.answer({ ...ask('Read the permits folder again'), conversation: 'c1' })).ok).toBe(true);
    expect(paths(from)).toEqual(recs.slice(8, 16).map((r) => `VDR/${r.rel}`)); expect(s.turns[3].prompt).toContain('12 of its documents were read for this earlier in this conversation; these are the other 8.');
    // documents added to the folder since are listed and read; the rest are not read again
    const added = [doc('Permits/New A.pdf'), doc('Permits/New B.pdf')]; recs.push(...added);
    from = s.batches.length; expect((await s.ai.answer({ ...ask('And now?'), conversation: 'c1' })).ok).toBe(true);
    expect(paths(from)).toEqual(['VDR/Permits/New A.pdf', 'VDR/Permits/New B.pdf']);
    from = s.batches.length; expect((await s.ai.answer({ ...ask('Once more'), conversation: 'c1' })).ok).toBe(true);
    expect(s.batches.length).toBe(from); expect(s.turns.at(-1)!.prompt).toContain('You have had all 22 documents in VDR/Permits read for “expiry” in this conversation already');
    // another conversation starts from nothing
    from = s.batches.length; expect((await s.ai.answer({ ...ask('Review the permits folder'), conversation: 'c2' })).ok).toBe(true);
    expect(paths(from).length).toBe(22);
  });

  it('a large folder is read whole only in an answer after the one that asked, whatever the model says', async () => {
    const recs = Array.from({ length: 120 }, (_v, i) => doc(`Permits/P${String(i + 1).padStart(3, '0')}.pdf`));
    const s = setup(recs, (_c, k) => (k === 3 || k === 5 ? { text: 'Shall I read all 120?', sources: [] } : k === 7 ? { text: 'Done.', sources: [] } : { tool: 'folder', folder: 'permits', lookFor: 'expiry', all: true }), { folderDocs: 100 });
    // "all" before the person was asked, and again in the same answer: asked, and nothing read
    expect((await s.ai.answer({ ...ask('Review the permits folder'), conversation: 'c1' })).ok).toBe(true);
    expect(s.batches.length).toBe(0); expect(s.turns[1].prompt).toContain('more than the 100 that are read without asking'); expect(s.turns[2].prompt).toContain('more than the 100 that are read without asking');
    // in another conversation it was never asked
    expect((await s.ai.answer({ ...ask('Yes'), conversation: 'c2' })).ok).toBe(true); expect(s.batches.length).toBe(0);
    // the person's next message in the conversation that asked: read whole
    expect((await s.ai.answer({ ...ask('Yes, all of it'), conversation: 'c1' })).ok).toBe(true); expect(s.batches.length).toBe(15);
  });

  it('agreed, the folder is read for what the person was asked about, however the model words it or if it leaves it out', async () => {
    const recs = Array.from({ length: 120 }, (_v, i) => doc(`Permits/P${String(i + 1).padStart(3, '0')}.pdf`));
    for (const again of [{}, { lookFor: 'expiry date of each permit' }]) {
      const s = setup(recs, (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits', lookFor: 'expiry dates' } : k === 3 ? { tool: 'folder', folder: '07 permits folder', all: true, ...again } : { text: 'ok', sources: [] }), { folderDocs: 100 });
      expect((await s.ai.answer({ ...ask('Review the permits folder'), conversation: 'c1' })).ok).toBe(true); expect(s.batches.length).toBe(0);
      const r = await s.ai.answer({ ...ask('Yes, read all of them'), conversation: 'c1' }); expect(r.ok).toBe(true);
      expect(s.batches.length).toBe(15); expect(s.batches[0].prompt).toContain('Find what they say about: expiry dates\n');
      expect(s.turns[3].prompt).toContain('You had all 120 documents in VDR/Permits read for “expiry dates”');
      // one listing step in the trace, for what was asked
      const v = r.ok ? r.value : null; expect(v!.research!.steps.filter((x) => x.text.startsWith('Listed')).length).toBe(1);
    }
  });

  it('stopped while the main session was thinking: the tool it asked for is not used, and it answers next', async () => {
    let ai: ReturnType<typeof setup>['ai'] | null = null;
    const s = setup([doc('Permits/A.pdf')], async (_c, k) => { if (k === 1) { await ai!.stop!('run-2'); return { tool: 'folder', folder: 'permits' }; } return { text: 'Nothing read yet.', sources: [] }; });
    ai = s.ai;
    expect(await s.ai.answer({ ...ask('Review the permits folder'), runId: 'run-2' })).toMatchObject({ ok: true, value: { text: 'Nothing read yet.' } });
    expect(s.turns.length).toBe(2); expect(s.batches.length).toBe(0); expect(s.priorities.length).toBe(0);
    expect(s.turns[1].prompt).toContain('The person stopped the research before this tool was used.');
  });

  it('tells the main session the folder tool and the per-call cap as set, in every way of calling tools', async () => {
    const s = setup([doc('Permits/A.pdf')], () => ({ text: 'ok', sources: [] }), { width: 12 });
    expect((await s.ai.answer(ask('Hello'))).ok).toBe(true);
    expect(s.turns[0].system).toContain('{"tool": "folder", "folder": "Permits"'); expect(s.turns[0].system).toContain('Have up to 12 documents attached');
    for (const toolCalls of ['hybrid', 'native'] as const) {
      const t = setup(Array.from({ length: 12 }, (_v, i) => doc(`Permits/P${i + 1}.pdf`)), (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits', lookFor: 'expiry' } : { text: 'ok', sources: [] }), { width: 12, talks: true, toolCalls });
      const seen: { tools?: { name: string; description: string }[]; results?: unknown[]; prompt: string }[] = []; const was = t.svc.converse!.bind(t.svc); t.svc.converse = (i) => { seen.push(i); return was(i); };
      expect((await t.ai.answer(ask('Review the permits folder'))).ok, toolCalls).toBe(true);
      expect(seen[0].tools!.map((x) => x.name), toolCalls).toEqual(['search', 'read', 'folder', 'answer']);
      expect(seen[0].tools!.find((x) => x.name === 'read')!.description).toContain('up to 12 documents');
      expect(t.batches.length, toolCalls).toBe(1);
      const result = toolCalls === 'native' ? String((seen[1].results as { text: string }[])[0].text) : seen[1].prompt; expect(result, toolCalls).toContain('You had all 12 documents in VDR/Permits read for “expiry”');
    }
  });
});

/** the same stand-in, with some documents that cannot be opened on this PC */
function setupWithout(recs: DocRecord[], missing: Set<string>) {
  const s = setup(recs.map((r) => r), (_c, k) => (k === 1 ? { tool: 'folder', folder: 'permits' } : { text: 'ok', sources: [] }), { reads: (_c, k) => (k === 2 ? 'not json at all' : { text: '', sources: [] }), docs: { records: (d) => (d === 'd1' ? recs : []), wanted: async (_d, ids) => recs.filter((r) => ids.includes(r.docId) && !missing.has(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })) } });
  return s;
}
