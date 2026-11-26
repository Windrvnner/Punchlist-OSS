// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiDocs, type AiOptions, type Checklist, type UsageEntry } from '../../src/backend/ai';
import { StandInService, type ConverseInput } from '../../src/backend/service';
import { StoreKeeper, fromStoreName } from '../../src/backend/storeKeeper';
import { memRepo, refuse, quota, type MemRepo } from '../adapters/memRepo';
import type { Repository } from '../../src/ports';
import { Finding, WORKSTREAMS } from '../../src/domain/model';
import { memoContent } from '../../src/domain/memo';
import { scaleMemoInput } from '../fixtures/memoScale';
import type { DocRecord } from '../../src/backend/documents';
import type { Folder } from '../../src/backend/logRepository';
import { signedOut } from '../../src/backend/signInToken';
import { SERVICE } from '../../src/control';

class Mem implements Folder { files = new Map<string, string>(); list() { return [...this.files.keys()]; } size(n: string) { return this.files.get(n)?.length ?? -1; } read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); } }
import { wordIndex as makeIndex, countWords, type WordIndex } from '../../src/backend/wordIndex';
const doc = (n: number, name: string, extra: Partial<DocRecord> = {}): DocRecord => ({ docId: `doc_${String(n).padStart(24, '0')}`, hash: 'h', name, folder: 'vdr', rel: name, size: 1, ...(/\.xlsx$/.test(name) ? {} : { pages: 40 }), ...extra });
const FA = doc(1, 'Credit Agreement.pdf', { summary: 'Senior credit agreement between the borrower and the lenders.', keywords: ['lock-up', 'distribution', 'covenant'] });
const TS = doc(2, 'Term sheet (signed).pdf', { pages: 12, summary: 'Signed term sheet.', keywords: ['lock-up', 'margin'] });
const IM = doc(3, 'Information memorandum.pdf', { summary: 'Overview of the project.', keywords: ['capacity', 'sponsor'] });
const MODEL = doc(4, 'Model v12.xlsx', { summary: 'Base case model.', keywords: ['dscr', 'debt'] });
const SIDE = doc(5, 'Side letter.pdf', { pages: 4, summary: 'Side letter on step-in rights.', keywords: ['step-in'] });
const MINUTES = doc(6, 'Board minutes March.pdf', { pages: 6, summary: 'Board minutes approving the hedging strategy.', keywords: ['hedging', 'swap'] });
const OTHER = doc(7, 'Wingtip credit agreement.pdf', { summary: 'Credit agreement for another deal.', keywords: ['lock-up'] });
type Call = { model: string; system?: string; prompt: string; files: { id: string; name: string; text: string }[] };
/** the tag (D1, D2 …) a prompt gave a document */
const tag = (c: Call, d: DocRecord) => new RegExp(`^(D\\d+): (?:.*/)?${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').exec(c.prompt)?.[1] ?? 'D?';
const sentNames = (c: Call) => c.files.map((f) => fromStoreName(f.name)!.name).sort();
/** the documents a read lists, by path, in the order it gives them */
const readOrder = (c: Call) => [...c.prompt.matchAll(/^D\d+: (.+?)(?: \(\d+ pages\))?$/gm)].map((m) => m[1]);
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, t++)).toISOString();

/** the synonyms library in these tests: with no checklist its groups stand in for items, so these documents are core (core.ts) */
const TEST_LIBRARY = [['credit agreement', 'loan agreement'], ['term sheet', 'summary of terms'], ['information memorandum', 'offering memorandum'], ['financial model', 'base case model'], ['core document', 'key document']];
/** what the fast model says is core in these tests, most important first: judged from the name alone, as it would be */
const isCoreAsk = (c: { prompt: string }) => c.prompt.includes('Which are the core documents');
const isFixAsk = (c: { prompt: string }) => c.prompt.includes('It cannot be read as written');
const isAffectsAsk = (c: { prompt: string }) => c.prompt.includes('Which of them could the new documents change?');
const isVerifyAsk = (c: { prompt: string }) => c.prompt.includes('does it still stand as written?') || c.prompt.includes('does it stay closed?');
const isPickAsk = (c: { prompt: string }) => c.prompt.includes('Which of them should be read for this?');
const isQueryAsk = (c: { prompt: string }) => c.prompt.includes('write up to 3 short searches');
const isPickForAsk = (c: { prompt: string }) => c.prompt.includes('Which of them should be read for each of these?');
const isDescribeAsk = (c: { prompt: string }) => c.prompt.startsWith('Describe the document ');
const isHearAsk = (c: { prompt: string }) => c.prompt.includes('Which findings could a response change?');
/** a turn of the chat agent's main session (agent.ts), as opposed to a call that reads documents */
const isTurn = (c: { system?: string }) => !!c.system?.includes('You work in turns');
/** a call made while a check hands the items it left open to the chat agent (`fill`): its turns and its search helper's reads */
const isFillAsk = (c: { prompt: string }) => c.prompt.includes('were not settled by the documents first chosen for them');
/** what a test's script says, as the main session's answer: the same words and citations, tagged by the main session's own list; no "need", which only the search helper's reading has */
const asAnswer = (r: unknown) => { if (!r || typeof r !== 'object' || Array.isArray(r)) return r; const { need: _n, ...rest } = r as Record<string, unknown>; return rest; };
/** the numbers the listing in a prompt gives these documents, in the order asked for */
const numbersOf = (c: Call, ...docs: DocRecord[]) => docs.map((d) => +(new RegExp(`^(\\d+)\\*?: (?:.*/)?${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: — .*)?$`, 'm').exec(c.prompt)?.[1] ?? 0));

/**
 * `calls` are the questions put to the model. `coreCalls` catch any ask about which documents are core: there should be none, as core.ts works them out.
 * `pickCalls` are the asks about what to read, answered by `pick`: unless a test gives one, the stand-in cannot say, so
 * documents are matched by their words. `fixCalls` are the asks to send an unreadable reply again as valid JSON, answered by
 * `fix`: unless a test gives one, the stand-in has nothing better to say. `affectCalls` ask which findings and items new
 * documents could change (answered by `affects`; by default the stand-in cannot say, so the keyword match decides), and
 * `pickForCalls` ask which documents each of several items needs for its second look (answered by `pickFor`; by default the
 * stand-in cannot say, so each item is matched by the words of what it needs). `verifyCalls` ask whether a finding still stands (answered by `verify`; by default it does). `hearCalls` ask which
 * findings some responses could change (answered by `hears`; by default none). With `describes`, documents that are read
 * are described and the description kept (`describeCalls`, answered by `describe`); without it, as in most tests, none is.
 * Failed tries are then counted on the record; with `describes: 'here'` there is nowhere shared to count them.
 * `usage` is what each run reported of its calls. With `talks`, the service keeps conversations.
 */
function setup(script: (c: Call, n: number) => unknown, recs: Record<string, DocRecord[]> = { d1: [FA, TS, IM, MODEL, SIDE, MINUTES], d2: [OTHER] }, more: Partial<AiOptions> & { turn?: (c: Call, n: number) => unknown; pick?: (c: Call, n: number) => unknown; fix?: (c: Call, n: number) => unknown; affects?: (c: Call, n: number) => unknown; verify?: (c: Call, n: number) => unknown; hears?: (c: Call, n: number) => unknown; pickFor?: (c: Call, n: number) => unknown; query?: (c: Call, n: number) => unknown; fill?: (c: Call, n: number) => unknown; describes?: boolean | 'here'; describe?: (c: Call, n: number) => unknown; wordIndex?: WordIndex; changes?: AiDocs['changes']; talks?: boolean } = {}) {
  const calls: Call[] = []; const coreCalls: Call[] = []; const pickCalls: Call[] = []; const fixCalls: Call[] = []; const affectCalls: Call[] = []; const verifyCalls: Call[] = []; const hearCalls: Call[] = []; const pickForCalls: Call[] = []; const queryCalls: Call[] = []; const describeCalls: Call[] = []; const fillCalls: Call[] = []; const turns: Call[] = []; const usage: UsageEntry[] = [];
  const { turn, pick = () => 'I cannot say', fix = () => '{}', affects = () => 'I cannot say', verify = () => ({ stands: true, why: '' }), hears = () => ({ affected: [] }), pickFor = () => 'I cannot say', query = () => 'I cannot say', fill = (c: Call) => (isTurn(c) ? { text: 'Nothing in the data room settles them.', sources: [] } : { text: '', sources: [] }), describes = false, describe = (c: Call) => ({ summary: `This is ${/Describe the document (.*)\.\n/.exec(c.prompt)![1]}.`, keywords: ['described'] }), wordIndex, changes, talks = false, ...options } = more;
  const svc = new StandInService((c) => { const call = c as Call; const r = isFillAsk(call) ? (fillCalls.push(call), fill(call, fillCalls.length)) : isFixAsk(call) ? (fixCalls.push(call), fix(call, fixCalls.length)) : isDescribeAsk(call) ? (describeCalls.push(call), describe(call, describeCalls.length)) : isHearAsk(call) ? (hearCalls.push(call), hears(call, hearCalls.length)) : isAffectsAsk(call) ? (affectCalls.push(call), affects(call, affectCalls.length)) : isVerifyAsk(call) ? (verifyCalls.push(call), verify(call, verifyCalls.length)) : isCoreAsk(call) ? (coreCalls.push(call), {}) : isQueryAsk(call) ? (queryCalls.push(call), query(call, queryCalls.length)) : isPickForAsk(call) ? (pickForCalls.push(call), pickFor(call, pickForCalls.length)) : isPickAsk(call) ? (pickCalls.push(call), pick(call, pickCalls.length)) : isTurn(call) ? (turns.push(call), turn ? turn(call, turns.length) : asAnswer(script(call, calls.length + 1))) : (calls.push(call), script(call, calls.length)); return typeof r === 'string' ? r : JSON.stringify(r); });
  if (!talks) (svc as { converse?: unknown }).converse = undefined;      // a service that keeps no conversations, as most tests have it; `talks` for one that does
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const docs: AiDocs = { ...(wordIndex ? { wordIndex } : {}), ...(changes ? { changes } : {}), records: (d) => recs[d] ?? [], wanted: async (d, ids) => (recs[d] ?? []).filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
    ...(describes ? { describe: (d: string, id: string, r: { summary: string; keywords: string[] }) => { recs[d] = recs[d].map((x) => { if (x.docId !== id || x.summary !== undefined) return x; const { undescribed: _u, ...rest } = x; return { ...rest, ...r }; }); } } : {}),
    // failed tries are counted on the record, as the document service counts them for every PC; with 'here' there is nowhere shared to count them
    ...(describes === true ? { undescribed: (d: string, id: string) => { recs[d] = recs[d].map((x) => (x.docId === id && x.summary === undefined ? { ...x, undescribed: { tries: (x.undescribed?.tries ?? 0) + 1, at: (more.clock ?? clock)() } } : x)); } } : {}) };
  const repo = (options.repo as MemRepo | undefined) ?? memRepo(clock); const trace: { dealId: string; reason: string; docs: string[] }[] = []; const announced: string[] = []; let n = 0;
  const ai = nodeAi({ service: svc, docs, keeper, trace: (e) => trace.push(e), announce: (_k, id) => announced.push(id), usage: (e) => usage.push(e), clock, newId: () => `01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}`, retry: { sleep: async () => {} }, library: TEST_LIBRARY, ...options, repo });
  return { ai, svc, calls, turns, fillCalls, coreCalls, pickCalls, pickForCalls, queryCalls, fixCalls, affectCalls, verifyCalls, hearCalls, describeCalls, usage, repo, trace, announced, recs };
}
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const ask = (message: string, extra: object = {}) => ({ dealId: 'd1', message, history: [], model: 'thorough', ...extra });
async function deal(repo: Repository, id = 'd1', name = 'Project Proseware') { val(await repo.transaction({ writes: [{ kind: 'deal', id, data: { id, name }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id }] } })); }
async function finding(repo: Repository, id: string, title: string, extra: object = {}) { val(await repo.transaction({ writes: [{ kind: 'finding', id, data: { id, dealId: 'd1', title, workstream: 'Legal', status: 'open', body: ['As written. [1]'], sources: [], ...extra }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'finding', id }] } })); }

describe('answers', () => {
  it("sends a Word draft's tracked changes, read from the file, with the draft", async () => {
    const D = doc(51, 'SPA draft.docx', { tracked: 2 }); const asked: string[] = [];
    const changes: AiDocs['changes'] = async (_d, id) => { asked.push(id); return { ok: true, value: { tracked: 2, complete: false, passages: [{ before: 'The ratio is 1.15x.', after: 'The ratio is 1.20x.', changes: [{ kind: 'delete', by: 'sroe', at: '2026-10-01T10:00:00', text: '1.15x' }, { kind: 'insert', by: 'sroe', at: '2026-10-01T10:00:00', text: '1.20x' }] }] } }; };
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [D] }, { changes, library: [] });
    val(await s.ai.answer(ask('What ratio does the SPA draft set?')));
    expect(asked).toEqual([D.docId]);
    expect(s.calls[0].prompt).toContain([
      'D1 has 2 tracked changes. Its pages show them as markup, so its wording is proposed, not agreed.',
      '  The changes in D1, read from the file itself (these are fact, not a reading):',
      '  - was: "The ratio is 1.15x." / now: "The ratio is 1.20x." '
        + '(delete "1.15x" by sroe on 2026-10-01; insert "1.20x" by sroe on 2026-10-01)',
      '  Some changes are in parts of the file this list does not reach.',
    ].join('\n'));
  });
  it('reads the newest draft of a document first, its earlier drafts straight after it', async () => {
    const at = (n: number, rel: string, seen: string) => doc(n, rel.split('/').pop()!, { rel, seen });
    const OLD = at(41, 'Drafts/2026-03-01/EPC contract.pdf', '2026-03-02T00:00:00.000Z'), NEW = at(42, 'Drafts/2026-04-15/EPC contract.pdf', '2026-04-16T00:00:00.000Z'), MID = at(43, 'Drafts/03-20-2026/EPC contract.pdf', '2026-03-21T00:00:00.000Z');
    const OTHER_DOC = doc(44, 'EPC guarantee.pdf');
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [OLD, OTHER_DOC, MID, NEW] }, { width: 4, library: [] });
    val(await s.ai.answer(ask('What does the EPC contract say about delay damages?')));
    // 03-20-2026 is March 20
    expect(readOrder(s.calls[0])).toEqual(['vdr/Drafts/2026-04-15/EPC contract.pdf',
      'vdr/Drafts/03-20-2026/EPC contract.pdf', 'vdr/Drafts/2026-03-01/EPC contract.pdf', 'vdr/EPC guarantee.pdf']);
  });
  it('keeps each deal\'s earlier drafts after its newest when a question spans several, the deals taken in turn',
    async () => {
    const at = (n: number, rel: string) => doc(n, rel.split('/').pop()!, { rel });
    const recs = { d1: [at(61, 'Drafts/2026-03-01/EPC contract.pdf'), at(62, 'Drafts/2026-04-15/EPC contract.pdf')], d2: [at(63, 'Drafts/2026-05-01/O&M contract.pdf'), at(64, 'Drafts/2026-06-01/O&M contract.pdf')] };
    const s = setup(() => ({ text: 'ok', sources: [] }), recs, { width: 2, library: [] });
    await deal(s.repo, 'd1'); await deal(s.repo, 'd2', 'Project Wingtip'); val(await s.ai.answer({ message: 'What does each contract say about delay damages?', history: [], model: 'standard' }));
    // a page of two: each deal's newest draft, not one deal's two drafts
    expect(readOrder(s.calls[0]))
      .toEqual(['vdr/Drafts/2026-04-15/EPC contract.pdf', 'vdr/Drafts/2026-06-01/O&M contract.pdf']);
  });
  it('what the fast model said of a document adds only its own matches: a described document does not outrank an equal one not yet described', async () => {
    const ix = makeIndex(new Mem()); const A = doc(65, 'Annex A.pdf'), B = doc(66, 'Annex B.pdf', { summary: 'An annex to the agreement.' });
    for (const d of [A, B]) ix.add('d1', d.docId, countWords('Curtailment compensation is paid monthly.', 'Payment terms'));
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [B, A] }, { wordIndex: ix, width: 1, library: [] });
    val(await s.ai.answer(ask('Is curtailment compensated?')));
    expect(readOrder(s.calls[0])).toEqual(['vdr/Annex A.pdf']);   // equal scores: by path, so A has the page of one
  });
  it("reads a blackline with its clean draft, says which is which, and marks what is cited from the blackline as the model's reading", async () => {
    const BL = doc(71, 'Credit Agreement (blackline).pdf', { pages: 30 });
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [FA, BL] }, { library: [], turn: (c) => ({ text: 'It moved to 1.20x. [1] The draft says 1.20x. [2]', sources: [{ doc: tag(c, BL), page: 3 }, { doc: tag(c, FA), page: 14 }] }) });
    const r = val(await s.ai.answer(ask('What changed in the lock-up?', { attachments: [{ doc: BL.name, docId: BL.docId }] })));
    expect(sentNames(s.turns[0])).toEqual(['Credit Agreement (blackline).pdf', 'Credit Agreement.pdf']);                       // the clean draft goes with it
    const [b, f] = [tag(s.turns[0], BL), tag(s.turns[0], FA)];
    // its name says nothing of what it was compared against, so the model is told it may be another project's (docs/other-project-documents-design.md)
    expect(s.turns[0].prompt).toContain(`${b} is a blackline: a comparison of two documents with the changes marked, made by a comparison tool; its clean draft is ${f}. ${f} is what the deal's terms are.`);
    expect(s.turns[0].prompt).toContain(`${b} compares its clean draft with another document, which may be an earlier draft of this deal or another project's.`);
    expect(s.turns[0].prompt).toContain('Its strike-through and colors may not come through to you');                              // pipeline A, the default
    expect(r.sources.map((x) => [x.doc, x.reading])).toEqual([[BL.name, true], [FA.name, undefined]]);
    const sees = setup(() => ({ text: 'ok', sources: [] }), { d1: [FA, BL] }, { library: [], blackline: 'B' });
    val(await sees.ai.answer(ask('What changed?', { attachments: [{ doc: BL.name, docId: BL.docId }] }))); expect(sees.turns[0].prompt).toContain('Struck-through words are deleted and colored words are inserted.');
  });
  it('leaves out a blackline whose clean draft is not clear', async () => {
    const PAIRED = doc(72, 'Side letter blackline.pdf', { summary: 'Side letter step-in changes.' });
    const cover = 'Comparison of Lease v1.docx and Lease.pdf. Insertions 2';
    const UNCLEAR = doc(73, 'Lease redline.pdf', { summary: 'Lease step-in changes.', cover });
    const L1 = doc(76, 'Lease.pdf', { folder: 'vdr', rel: 'One/Lease.pdf' }), L2 = doc(77, 'Lease.pdf', { folder: 'vdr', rel: 'Two/Lease.pdf' });
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [SIDE, PAIRED, UNCLEAR, L1, L2] }, { library: [] });
    val(await s.ai.answer(ask('What step-in changes do the blacklines make?')));
    // the side letter's is read with it; the lease's cover names two files of one name
    expect(sentNames(s.calls[0])).toEqual(['Side letter blackline.pdf', 'Side letter.pdf']);
    const PEER = doc(75, 'Peer comparison.pdf', { summary: 'Step-in terms of peer projects.' }); const r = setup(() => ({ text: 'ok', sources: [] }), { d1: [PEER] }, { library: [] });
    val(await r.ai.answer(ask('What step-in terms do peers have?'))); expect(sentNames(r.calls[0])).toEqual(['Peer comparison.pdf']);      // a report named "comparison" is no blackline: it is read
  });
  it('reads a standalone blackline on its own: the model is told no clean draft is there, and what it cites is still a reading', async () => {
    const LONE = doc(78, 'Lease redline.pdf', { summary: 'Lease step-in changes.' });
    const s = setup((c) => ({ text: 'Step-in now needs 30 days. [1]', sources: [{ doc: tag(c, LONE), page: 2 }] }), { d1: [LONE] }, { library: [] });
    const r = val(await s.ai.answer(ask('What step-in changes does the lease redline make?'))); expect(sentNames(s.calls[0])).toEqual(['Lease redline.pdf']);
    const lone = tag(s.calls[0], LONE);
    expect(s.calls[0].prompt).toContain(`${lone} is a blackline: a comparison of two documents with the `
      + 'changes marked, made by a comparison tool; no clean draft of it was found by its cover or name.');
    expect(r.sources.map((x) => x.reading)).toEqual([true]);
  });
  it("checks a Word file's cited page against the pages counted when it was first sent", async () => {
    const W = doc(31, 'Supply contract.docx', { pages: undefined }); const recs = { d1: [W] };
    const s = setup((c) => ({ text: 'Delivery is due in June. [1] Or later. [2]', sources: [{ doc: tag(c, W), page: 3 }, { doc: tag(c, W), page: 9 }] }), recs, { library: [] });
    const wanted = s.svc.upload.bind(s.svc); s.svc.upload = async (...a: Parameters<typeof wanted>) => { recs.d1 = [{ ...W, pages: 5 }]; return wanted(...a); };   // converted as it is sent: five pages
    const r = val(await s.ai.answer(ask('When is delivery due under the supply contract?')));
    expect(r.sources.map((x) => x.loc)).toEqual(['p. 3']); expect(r.text).toBe('Delivery is due in June. [1] Or later.');
  });
  it("ranks documents by this PC's word index: a word deep in a document's body finds it, and its name still counts most", async () => {
    const ix = makeIndex(new Mem()); const A = doc(21, 'Annex 4.pdf'), B = doc(22, 'Curtailment letter.pdf'), C = doc(23, 'Schedule 7.pdf');
    ix.add('d1', A.docId, countWords(`${'General provisions. '.repeat(200)} Curtailment compensation is paid monthly.`, 'General provisions'));
    ix.add('d1', C.docId, countWords('Insurance schedule.', 'Insurance schedule'));
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [C, A, B] }, { wordIndex: ix, width: 3, library: [] });
    val(await s.ai.answer(ask('Is curtailment compensated?')));
    // B is named for it (and not yet read by this PC), A says it in its body, C does not say it at all: only B and A
    // are read, in that order
    expect(readOrder(s.calls[0])).toEqual(['vdr/Curtailment letter.pdf', 'vdr/Annex 4.pdf']);
  });
  it('reads what answers to the question\'s words, with the model the person chose, and keeps only the citations it ' +
    'can stand behind', async () => {
    const s = setup((c) => ({ text: 'The draft sets the lock-up at 1.25x. [1] An unknown file says otherwise. [2] So does a page that is not there. [3] The model uses 1.25x. [4] {Not a link|f_1}',
      sources: [{ doc: tag(c, FA), page: 14, quote: 'Lock-up Ratio means 1.25:1' }, { doc: 'D99', page: 1 }, { doc: tag(c, TS), page: 13 }, { doc: tag(c, MODEL), cell: 'Debt!B20' }] }));
    const r = val(await s.ai.answer(ask('What is the lock-up ratio?')));
    // the search helper reads on the fast model; the main session answers on the model the person chose, in one turn here
    expect(s.calls.length).toBe(1); expect(s.calls[0].model).toBe('fast'); expect(sentNames(s.calls[0]))
      .toEqual(['Credit Agreement.pdf', 'Model v12.xlsx', 'Term sheet (signed).pdf']);
    expect(s.turns.length).toBe(1); expect(s.turns[0].model).toBe('thorough'); expect(s.turns[0].files).toEqual([]);
    expect(r.text).toBe('The draft sets the lock-up at 1.25x. [1] An unknown file says otherwise. So does a page that is not there. The model uses 1.25x. [2] Not a link');
    expect(r.sources).toEqual([{ doc: 'Credit Agreement.pdf', loc: 'p. 14', docId: FA.docId, quote: 'Lock-up Ratio means 1.25:1' }, { doc: 'Model v12.xlsx', loc: 'Debt!B20', docId: MODEL.docId }]);
    expect(s.turns[0].prompt).toContain('Question: What is the lock-up ratio?'); expect(s.turns[0].system).toContain('Cite pages only');
    // plain symbols, no LaTeX
    expect(s.turns[0].system).toContain(
      'A calculation may use plain symbols (+ − × ÷ * / = %) without writing them out ' +
        'in words, like this: "CFADS / debt service = 41.2m / 31.2m = 1.32x". No LaTeX',
    );
  });

  it('which documents are core is worked out with no model, from names and folders, and again only when the documents or checklist change (core.ts)', async () => {
    const recs = { d1: [SIDE, MINUTES, MODEL, IM, TS, { ...FA, folder: 'C:\\Users\\adoe\\OneDrive\\Proseware\\VDR', rel: '01 Finance documents/Credit Agreement.pdf' }] };
    const s = setup(() => ({ text: 'ok', sources: [] }), recs, { width: 2 });
    // a draft's reading shows the core set: nothing in the question points anywhere, so its pick falls back on them
    const draft = (x: ReturnType<typeof setup>, text: string) =>
      x.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: text });
    await draft(s, 'Anything to worry about?');
    await draft(s, 'And otherwise?');
    expect(s.coreCalls.length).toBe(0);                                                                                                                   // no model is asked which are core
    expect(sentNames(s.calls[0])).toEqual(['Credit Agreement.pdf', 'Information memorandum.pdf']);                                                    // a handful, here two; nothing in the question points anywhere, so the best core documents
    expect(s.calls[0].prompt).toContain('D1: VDR/01 Finance documents/Credit Agreement.pdf (40 pages)');                                              // each by its full path from the root of the data room
    recs.d1.push(doc(9, 'Grid permit.pdf'));
    await draft(s, 'And now?');
    expect(s.coreCalls.length).toBe(0);
    const none = setup(() => ({ text: 'ok', sources: [] }), undefined, { library: [] });
    await draft(none, 'Anything?');
    // no checklist and no library: no core, and nothing answers to the question, so no model is asked
    expect(none.calls.length).toBe(0);
  });

  it('a chat search reads a page of the keyword ranking as it is, with no pick: only what answers to the words',
    async () => {
    const s = setup(() => ({ text: 'x', sources: [] }), undefined, { pick: () => ({ read: [1] }) });
    val(await s.ai.answer(ask('Was the hedging approved?', { attachments: [{ doc: FA.name, docId: FA.docId }] })));
    expect(s.pickCalls).toEqual([]);
    expect(readOrder(s.calls[0])).toEqual(['vdr/Board minutes March.pdf']);
    // what was given goes to the main session whole
    expect(sentNames(s.turns[0])).toEqual(['Credit Agreement.pdf']);
    // nothing answers to the words and nothing is core: no document is read, and the main session is told so
    const none = setup(() => ({ text: 'x', sources: [] }), { d1: [SIDE] }, { library: [] });
    expect(val(await none.ai.answer(ask('What is the tax position?'))).text).toBe('x');
    expect(none.calls.length).toBe(0);
    expect(none.turns[0].prompt).toContain('Documents: none answers to these words.');
    // a page is the handful: the rest of the ranking is the next page
    const two = setup(() => ({ text: 'x', sources: [] }), undefined, { width: 2 });
    val(await two.ai.answer(ask('lock-up and hedging')));
    expect(readOrder(two.calls[0])).toHaveLength(2);
    expect(two.turns[0].prompt).toContain('Page 1 of 2. Ask for page 2 of "documents" for more.');
  });

  it('what a draft reads is settled in two steps: a keyword ranking of the deal’s files, then the fast model’s pick ' +
    'from the top of it', async () => {
    const draft = (x: ReturnType<typeof setup>, text: string) =>
      x.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: text });
    const found = (c: Call) =>
      ({ status: 'found', text: 'The board approved the swap. [1]', sources: [{ doc: tag(c, MINUTES), page: 2 }] });
    const s = setup((c, n) => (n === 1 ? { status: 'none', need: ['what the board decided'] } : found(c)), undefined,
      { pick: (c, n) => ({ read: n === 1 ? [...numbersOf(c, TS, SIDE), 99, 0, numbersOf(c, TS)[0]] : numbersOf(c, MINUTES) }) });
    const r = val(await draft(s, 'Was the hedging approved?'));
    expect(s.pickCalls.map((c) => c.model)).toEqual(['fast', 'fast']); expect(s.pickCalls[0].files).toEqual([]);
    // ranked: the one file whose record answers to the question's words, then core documents by importance, then the
    // rest
    expect(s.pickCalls[0].prompt).toContain(
      '1: vdr/Board minutes March.pdf — Board minutes approving the hedging strategy.\n2*: vdr/Credit Agreement.pdf');
    // the handful of eight
    expect(s.pickCalls[0].prompt).toContain('Which of them should be read for this?\nWas the hedging approved?');
    expect(s.pickCalls[0].prompt).toContain('Choose up to 8,');
    expect(s.calls[0].files.map((f) => fromStoreName(f.name)!.name)).toEqual(['Term sheet (signed).pdf', 'Side letter.pdf']);                  // the pick in its order; a number not in the list, or given twice, counts for nothing
    expect(s.pickCalls[1].prompt).toContain('Still needed: what the board decided'); expect(s.pickCalls[1].prompt).not.toContain('Side letter.pdf');
    // the second pick is from what has not been read
    expect(s.pickCalls[1].prompt).toContain('1: vdr/Board minutes March.pdf');
    expect(sentNames(s.calls[1])).toContain('Board minutes March.pdf'); expect(r.sources.map((x) => x.doc)).toEqual(['Board minutes March.pdf']);
    expect(s.trace).toEqual([{ dealId: 'd1', reason: 'what the board decided', docs: [MINUTES.docId] }]);
    // nothing bears on it: no document is read
    const none = setup(() => ({ status: 'none' }), undefined, { pick: () => ({ read: [] }) });
    expect(val(await draft(none, 'What is the tax position?')).status).toBe('none');
    expect(none.calls.length).toBe(0);
    // more than the handful is cut to it
    const pickFour = (c: Call) => ({ read: numbersOf(c, MODEL, IM, FA, TS) });
    const many = setup(() => ({ status: 'none' }), undefined, { width: 2, pick: pickFour });
    val(await draft(many, 'Anything?'));
    expect(many.calls[0].files.map((f) => fromStoreName(f.name)!.name))
      .toEqual(['Model v12.xlsx', 'Information memorandum.pdf']);
    // only the top of the ranking is put to the model
    const short = setup(() => ({ status: 'none' }), undefined, { shortlist: 3, pick: () => ({ read: [1, 2, 3, 4] }) });
    val(await draft(short, 'What does the side letter say about step-in?'));
    expect(short.pickCalls[0].prompt).toContain('1: vdr/Side letter.pdf — Side letter on step-in rights.\n2*: vdr/Credit Agreement.pdf — Senior credit agreement between the borrower and the lenders.\n3*: vdr/Information memorandum.pdf — Overview of the project.\n\n'); expect(short.calls[0].files.length).toBe(3);
    // the service cannot be reached: that is the failure, not a reason to match by words
    const refused = () => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' });
    };
    const down = setup(() => ({ status: 'none' }), undefined, { pick: refused });
    const d = await draft(down, 'lock-up');
    expect(!d.ok && d.error.kind).toBe('unreachable');
    expect(down.calls.length).toBe(0);
  });

  it('a clause number, a page for a spreadsheet, or a cell for a PDF is not a citation', async () => {
    const s = setup((c) => ({ text: 'A. [1] B. [2] C. [3] D. [4]', sources: [{ doc: tag(c, FA), page: 'clause 14.2' }, { doc: tag(c, MODEL), page: 3 }, { doc: tag(c, FA), cell: 'Debt!B2' }, { doc: tag(c, FA), page: 2 }] }));
    const r = val(await s.ai.answer(ask('lock-up'))); expect(r.sources).toEqual([{ doc: 'Credit Agreement.pdf', loc: 'p. 2', docId: FA.docId }]); expect(r.text).toBe('A. B. C. D. [1]');
  });

  it('a document the person names is read even though it is not core', async () => {
    const s = setup(() => ({ text: 'ok', sources: [] })); val(await s.ai.answer(ask('What does the side letter say about step-in?')));
    expect(sentNames(s.calls[0])).toContain('Side letter.pdf'); expect(sentNames(s.calls[0])).not.toContain('Board minutes March.pdf');
  });

  it('a draft branches out once, for the reason the model gives, and records why', async () => {
    const draft = (x: ReturnType<typeof setup>, text: string) =>
      x.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: text });
    // asking again gets nothing more: one branch-out a question
    const sources = (c: Call) => [{ doc: tag(c, MINUTES), page: 2 }];
    const found = (c: Call) => ({
      status: 'found', text: 'The board approved the swap. [1]', sources: sources(c),
      need: ['the side letter on step-in'],
    });
    const s = setup((c, n) => (n === 1 ? { status: 'none', need: ['board minutes on hedging'] } : found(c)));
    // nothing in the question points at a file, so it starts from the core documents
    const r = val(await draft(s, 'Did the directors agree to it?'));
    expect(s.calls.length).toBe(2); expect(sentNames(s.calls[0])).not.toContain('Board minutes March.pdf'); expect(sentNames(s.calls[1])).toContain('Board minutes March.pdf'); expect(s.calls[0].prompt).toContain('"need"'); expect(s.calls[1].prompt).not.toContain('"need"');
    expect(r.sources).toEqual([{ doc: 'Board minutes March.pdf', loc: 'p. 2', docId: MINUTES.docId }]);
    expect(s.trace).toEqual([{ dealId: 'd1', reason: 'board minutes on hedging', docs: [MINUTES.docId] }]);
    // nothing answers to it: no second call
    const none = setup(() => ({ status: 'none', need: ['the insurance report'] }));
    expect(val(await draft(none, 'Is it insured?')).status).toBe('none');
    expect(none.calls.length).toBe(1);
  });

  it('a call never holds more than the handful: not on a draft\'s second round, and not with more attached than fits',
    async () => {
    // the second round: what is still needed takes up to half the call, and the first round's weakest documents give way
    const reply = (_c: Call, n: number) =>
      (n === 1 ? { status: 'none', need: ['board minutes on hedging'] } : { status: 'none' });
    const s = setup(reply, undefined, { width: 4 });
    val(await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Did the directors agree to it?' }));
    const first = s.calls[0].files.map((f) => fromStoreName(f.name)!.name); const second = s.calls[1].files.map((f) => fromStoreName(f.name)!.name);
    expect(first.length).toBe(4); expect(second).toEqual([...first.slice(0, 3), 'Board minutes March.pdf']);
    expect(s.calls[1].prompt).toMatch(/^D4: .*Board minutes March\.pdf/m);                                                       // tagged afresh for the new call
    // attached documents go to the main session whole, a handful at most: the first ones attached are kept
    const att = setup(() => ({ text: 'ok', sources: [] }), undefined, { width: 2 });
    val(await att.ai.answer(ask('Compare these.', { attachments: [SIDE, MINUTES, TS].map((d) => ({ doc: d.name, docId: d.docId })) })));
    expect(att.turns[0].files.map((f) => fromStoreName(f.name)!.name)).toEqual(['Side letter.pdf', 'Board minutes March.pdf']);
  });

  it('an attachment stays with the main session whatever a chat search reads, and a citation names the right document',
    async () => {
    const sources = (c: Call) => [{ doc: tag(c, MINUTES), page: 2 }, { doc: tag(c, SIDE), page: 1 }];
    const s = setup((c) => ({ text: 'Approved. [1] [2]', sources: sources(c) }), undefined, { width: 3 });
    const attachments = [{ doc: SIDE.name, docId: SIDE.docId }];
    const r = val(await s.ai.answer(ask('Did the directors agree to the hedging?', { attachments })));
    expect(sentNames(s.turns[0])).toEqual(['Side letter.pdf']);
    expect(sentNames(s.calls[0])).toEqual(['Board minutes March.pdf']);
    expect(r.sources.map((x) => x.doc)).toEqual(['Board minutes March.pdf', 'Side letter.pdf']);
  });

  it('a deal is the boundary; asked across deals, each citation says which deal it is from', async () => {
    const s = setup((c) => ({ text: 'Both have one. [1] [2]', sources: [{ doc: tag(c, FA), page: 3 }, { doc: tag(c, OTHER), page: 5 }] }));
    val(await s.ai.answer(ask('lock-up in the credit agreement'))); expect(s.calls[0].files.map((f) => f.name).join()).not.toContain('Wingtip');
    await deal(s.repo, 'd1'); await deal(s.repo, 'd2', 'Project Wingtip');
    const r = val(await s.ai.answer({ message: 'Compare the lock-up in each credit agreement', history: [], model: 'thorough' }));
    expect(sentNames(s.calls[1])).toContain('Wingtip credit agreement.pdf'); expect(s.calls[1].files.length).toBeLessThanOrEqual(8); expect(r.sources.map((x) => [x.doc, (x as { dealId?: string }).dealId])).toEqual([['Credit Agreement.pdf', 'd1'], ['Wingtip credit agreement.pdf', 'd2']]);
  });

  it("asked across deals with the person's own deals given, it reads only those", async () => {
    const s = setup(() => ({ text: 'ok', sources: [] })); await deal(s.repo, 'd1'); await deal(s.repo, 'd2', 'Project Wingtip');
    val(await s.ai.answer({ message: 'Compare the lock-up in each credit agreement', history: [], model: 'thorough', dealIds: ['d1'] }));
    expect(sentNames(s.calls[0])).toContain('Credit Agreement.pdf'); expect(sentNames(s.calls[0])).not.toContain('Wingtip credit agreement.pdf');
    const none = setup(() => ({ text: 'ok', sources: [] })); expect(val(await none.ai.answer({ message: 'Outstanding issues?', history: [], model: 'thorough', dealIds: [] })).text).toBe('No documents have been indexed yet.');
  });
  it('asked across deals, only the best few documents are read, and between equals the more important one', async () => {
    const s = setup(() => ({ text: 'ok', sources: [] }), undefined, { width: 2 });
    await deal(s.repo, 'd1'); await deal(s.repo, 'd2', 'Project Wingtip'); val(await s.ai.answer({ message: 'What is the lock-up?', history: [], model: 'standard' }));
    expect(sentNames(s.calls[0])).toEqual(['Credit Agreement.pdf', 'Wingtip credit agreement.pdf']);                                                // one from each deal: both d1 documents mention the lock-up equally, and the credit agreement is the first core document
  });

  it('what was attached, and what a finding already cites, is always read; the conversation so far goes with the question', async () => {
    const s = setup(() => ({ text: 'ok', sources: [] })); await deal(s.repo); await finding(s.repo, 'f_1', 'Step-in period is unclear', { sources: [{ doc: 'Side letter.pdf', loc: 'p. 1', docId: SIDE.docId }] });
    val(await s.ai.answer(ask('Is this still right?', { findingId: 'f_1', attachments: [{ doc: 'Board minutes March.pdf', docId: MINUTES.docId }], history: [{ role: 'me', text: 'Earlier question' }, { role: 'ai', text: 'Earlier answer' }] })));
    expect(sentNames(s.turns[0])).toEqual(['Board minutes March.pdf', 'Side letter.pdf']);                                     // attached to the main session from its first turn, the attachment first
    expect(s.turns[0].prompt).toContain('This is about the finding "Step-in period is unclear"'); expect(s.turns[0].prompt).toContain('Person: Earlier question\nYou: Earlier answer');
  });

  it("asked on Home, a file the person attached there is read from the first turn and cited from their own files, in no deal", async () => {
    const own = 'me_00112233aabbccdd';
    const s = setup((c) => ({ text: 'The minutes approve the swap. [1]', sources: [{ doc: tag(c, MINUTES), page: 2 }] }), { d1: [FA, TS], d2: [OTHER], [own]: [MINUTES] });
    const r = val(await s.ai.answer({ message: 'What do these minutes approve?', history: [], model: 'thorough', dealIds: ['d1', 'd2'], files: own, attachments: [{ doc: MINUTES.name, docId: MINUTES.docId }] }));
    expect(sentNames(s.turns[0])[0]).toBe('Board minutes March.pdf');
    expect(r.sources).toEqual([expect.objectContaining({ doc: 'Board minutes March.pdf', docId: MINUTES.docId, dealId: own })]);
  });

  it('a draft with tracked changes is sent with one line saying its wording is proposed, and nothing else about them', async () => {
    const draft = doc(8, 'SPA draft.docx', { tracked: 212 });
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [draft] }); val(await s.ai.answer(ask('What does the SPA draft say about the lock-up?')));
    expect(s.calls[0].prompt).toContain(
      'D1 has 212 tracked changes. Its pages show them as markup, so its wording is proposed, not agreed.',
    );
    expect(s.calls[0].prompt).not.toMatch(/was: "|deleted by|inserted by/i); expect(s.calls[0].files.length).toBe(1);
  });

  it('to compare two documents, both are given with the question and both are read, whatever else the deal holds', async () => {
    const many = Array.from({ length: 12 }, (_, i) => doc(20 + i, `Core document ${i + 1}.pdf`)); const v3 = doc(40, 'SPA v3 (clean).pdf', { pages: 90 }), v4 = doc(41, 'SPA v4 (redline).docx', { pages: 92, tracked: 212 });
    const s = setup((c) => ({ text: 'The lock-up moved from 1.10x to 1.15x. [1] [2]', sources: [{ doc: tag(c, v3), page: 12 }, { doc: tag(c, v4), page: 12 }] }), { d1: [...many, v3, v4] });
    const r = val(await s.ai.answer(ask('What changed between these two?', { attachments: [{ doc: v3.name, docId: v3.docId }, { doc: v4.name, docId: v4.docId }] })));
    expect(sentNames(s.turns[0])).toEqual(['SPA v3 (clean).pdf', 'SPA v4 (redline).docx']);
    // the two that were given go whole to the main session; the helper reads only what answers to the words
    expect(s.calls.flatMap(sentNames)).not.toContain('SPA v3 (clean).pdf');
    expect(s.turns[0].prompt).toContain('D2 has 212 tracked changes'); expect(r.sources.map((x) => x.docId)).toEqual([v3.docId, v4.docId]);
  });

  it('with nothing indexed, or nothing that matches, no model is asked; and a failure says which kind it is', async () => {
    const empty = setup(() => ({}), {}); expect(val(await empty.ai.answer(ask('anything'))).text).toBe('No documents have been indexed for this deal yet.'); expect(empty.calls.length).toBe(0);
    const unmarked = setup(() => ({ text: 'Nothing found on tax.', sources: [] }), { d1: [SIDE, MINUTES] }); expect(val(await unmarked.ai.answer(ask('What is the tax position?'))).text).toBe('Nothing found on tax.'); expect([unmarked.calls.length, unmarked.turns.length]).toEqual([0, 1]);   // nothing matches: no document is read, and the main session says so
    const garbled = setup(() => 'I am sorry, I cannot');
    const g = await garbled.ai.answer(ask('lock-up'));
    expect(!g.ok && g.error).toEqual({ kind: 'failed', message: 'The AI’s reply could not be read' });
    const down = setup(() => { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; }); const d = await down.ai.answer(ask('lock-up')); expect(!d.ok && d.error.kind).toBe('unreachable');
    const broke = setup(() => { throw new Error('500'); }); const b = await broke.ai.answer(ask('lock-up')); expect(!b.ok && b.error.kind).toBe('failed');
  });
});

describe('the chat agent', () => {
  it("stops a search run at the control file's number of calls, and the main session is told", async () => {
    const s = setup(() => ({ text: 'ok', sources: [] }), undefined, { searchCalls: 0 });
    val(await s.ai.answer(ask('What is the lock-up ratio?')));
    // the page's read was refused
    expect([s.coreCalls.length, s.pickCalls.length, s.calls.length]).toEqual([0, 0, 0]);
    expect(s.turns[0].prompt).toContain('Documents: This search made as many calls as one search may.');
  });
  /** the search helper's reading: what the script says the documents it was given say, citing each of them on page 1 */
  const helper = (c: Call) => ({ text: c.files.map((_f, i) => `Found in D${i + 1}. [${i + 1}]`).join(' '), sources: c.files.map((_f, i) => ({ doc: `D${i + 1}`, page: 1, quote: `words ${i + 1}` })) });

  it('reads a document only by its whole path or name, never by the end of another name', async () => {
    const s = setup(helper, undefined, { pick: () => ({ read: [] }), turn: (_c, n) => n === 1
      ? { tool: 'read', docs: ['Agreement.pdf', 'credit agreement.PDF'] }
      : { text: 'Done.', sources: [] } });
    val(await s.ai.answer(ask('What does the agreement say?')));
    expect(sentNames(s.turns[1])).toEqual(['Credit Agreement.pdf']);
    expect(s.turns[1].prompt).toContain('Not found: Agreement.pdf.');
  });
  it('a search finds a document by a one-letter word or one-digit number in its name', async () => {
    const recs = { d1: [doc(8, 'Schedule B.pdf'), doc(9, 'Section 5.pdf'), doc(10, 'Annex.pdf')] };
    const queries = ['B', '5'];
    const search = (n: number) => ({ tool: 'search', what: 'documents', query: queries[n - 1], notes: '' });
    const turn = (_c: Call, n: number) => (n <= 2 ? search(n) : { text: 'Done. [1]', sources: [] });
    const s = setup(helper, recs, { pick: () => 'I cannot say', turn });
    const r = val(await s.ai.answer({ ...ask('Which schedule?'), runId: 'r2' }));
    const searched = r.research!.steps.filter((x) => x.kind === 'search' && /“[B5]”/.test(x.text));
    const one = '1 listed · 1 opened · 1 passage';
    expect(searched.map((x) => x.result)).toEqual([one, one]);
  });
  it('searches, reads whole what it asks for, and answers citing only documents a model was given', async () => {
    const search =
      { tool: 'search', what: 'documents', query: 'board minutes hedging', notes: 'FA p. 1 has the ratio' };
    const s = setup(helper, undefined, { turn: (c, n) => n === 1 ? search
      : n === 2 ? { tool: 'read', docs: [tag(c, FA), 'vdr/Board minutes March.pdf', 'nowhere.pdf'] }
      : { text: 'The ratio is 1.25x. [1] The board approved. [2] A side letter agrees. [3]', sources: [{ doc: tag(c, FA), page: 14 }, { doc: tag(c, MINUTES), page: 2 }, { doc: 'D99', page: 1 }] } });
    const r = val(await s.ai.answer({ ...ask('What is the lock-up, and did the board approve the swap?'), runId: 'r1' }));
    expect(s.turns.map((c) => c.model)).toEqual(['thorough', 'thorough', 'thorough']); expect(s.calls.map((c) => c.model)).toEqual(['fast', 'fast']);   // the person's model for the turns; the fast one reads for the helper
    expect(s.turns[0].prompt).toContain('You searched documents, findings and Q&A for “What is the lock-up, and did the board approve the swap?”');     // the question is searched for before the first turn
    expect(s.turns[0].prompt).toMatch(/^D2: vdr\/Credit Agreement\.pdf \(40 pages\)$/m);
    expect(s.turns[0].prompt).toContain('Passages:\nD1 p. 1: “words 1”');
    expect(s.turns[1].prompt).toContain('You searched documents for “board minutes hedging”'); expect(s.turns[1].prompt).toContain('Your notes so far: FA p. 1 has the ratio');
    expect(sentNames(s.turns[2])).toEqual(['Board minutes March.pdf', 'Credit Agreement.pdf']); expect(s.turns[2].prompt).toContain('Not found: nowhere.pdf.');
    expect(r.text).toBe('The ratio is 1.25x. [1] The board approved. [2] A side letter agrees.'); expect(r.sources.map((x) => [x.doc, x.loc])).toEqual([['Credit Agreement.pdf', 'p. 14'], ['Board minutes March.pdf', 'p. 2']]);
    expect(r.research!.steps.map((x) => [x.kind, x.text, x.result])).toEqual([
      ['search', 'Searched documents, findings and Q&A for “What is the lock-up, and did the board approve the swap?”',
        '3 listed · 3 opened · 3 passages · 0 findings · no questions'],
      ['search', 'Searched documents for “board minutes hedging”', '1 listed · 1 opened · 1 passage'],
      ['read', 'Reviewed Credit Agreement.pdf', 'p. 14'], ['read', 'Reviewed Board minutes March.pdf', 'p. 2']]);
    expect(r.research!.read).toEqual({ docs: 3, of: 6 });
    expect(r.research!.steps[0].found![1]).toEqual({ where: 'Credit Agreement.pdf, p. 1', quote: '“words 2”' });
    expect(r.research!.steps.every((x) => x.done)).toBe(true);
    expect(val(await s.ai.research!('r1'))).toBeNull();                                                                                     // finished: nothing is being worked on by that name
  });

  it('the window can follow the steps while it works', async () => {
    let asked: Promise<unknown> | null = null; let ai: ReturnType<typeof setup>['ai'];
    const s = setup(helper, undefined, { turn: () => { asked = ai.research!('r2'); return { text: 'Done.', sources: [] }; } }); ai = s.ai;   // asked during the first turn
    val(await s.ai.answer({ ...ask('lock-up'), runId: 'r2' })); const seen = val(await asked! as { ok: boolean; value?: unknown });
    expect((seen as { steps: { text: string; done: boolean }[] }).steps.map((x) => [x.text, x.done])).toEqual([['Searched documents, findings and Q&A for “lock-up”', true]]);
  });

  it('searches findings and the Q&A log by their words, with no model call, and names no finding by its id', async () => {
    const s = setup(helper, { d1: [FA] }, { turn: (_c, n) => n === 1 ? { tool: 'search', what: 'qa', query: 'lock-up ratio' } : { text: 'Q2 says it will be conformed.', sources: [] } });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Lock-up ratio differs from the term sheet', { body: ['The draft has 1.25x.'] }); await finding(s.repo, 'f_2', 'Insurance gap');
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_2', data: { id: 'q_2', dealId: 'd1', n: 2, text: 'Confirm the lock-up ratio', response: 'It will be conformed to 1.30x.', status: 'answered' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q_2' }] } }));
    const r = val(await s.ai.answer(ask('What about the lock-up ratio?')));
    expect(s.turns[0].prompt).toContain('Finding “Lock-up ratio differs from the term sheet” (open): The draft has 1.25x.'); expect(s.turns[0].prompt).not.toContain('Insurance gap'); expect(s.turns[0].prompt).not.toContain('f_1');
    expect(s.turns[1].prompt)
      .toContain('R1 · Answered\nQuestion: Confirm the lock-up ratio\nResponse to R1: It will be conformed to 1.30x.');
    expect(r.research!.steps[1]).toMatchObject({ text: 'Searched Q&A for “lock-up ratio”', result: 'Q2', found: [{ where: 'Q2 · response received', quote: 'It will be conformed to 1.30x.' }] });
    expect(s.calls.length).toBe(1);                                                                                                        // only the first search's documents were read by a model
  });

  it('catches up on a deal with its brief: one model call, links as plain words, no finding id', async () => {
    const briefOrSearch = (c: Call) => (c.prompt.includes('These are the open findings on a deal')
      ? { paragraphs: ['The {lock-up mismatch|f_1} matters most.', 'Nothing else is open.'] }
      : helper(c));
    const answered = { text: 'The lock-up matters most.', sources: [] };
    const catchUp = (_c: Call, n: number) => (n === 1 ? { tool: 'brief' } : answered);
    const s = setup(briefOrSearch, { d1: [FA] }, { turn: catchUp });
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    const r = val(await s.ai.answer(ask('Catch me up on the deal')));
    expect(r.text).toBe('The lock-up matters most.');
    const told = s.turns[1].prompt;
    const brief = 'The lock-up mismatch matters most.\nNothing else is open.';
    expect(told).toContain(`The catch-up on the open findings:\n${brief}`);
    expect(told).not.toContain('f_1');
    expect(s.calls.filter((c) => c.prompt.includes('These are the open findings on a deal')).length).toBe(1);
    const step = { text: 'Caught up on the open findings', result: '2 paragraphs', done: true };
    expect(r.research!.steps[1]).toMatchObject(step);
    // asked again with the findings unchanged: the brief is not written again
    val(await s.ai.answer(ask('Catch me up on the deal')));
    expect(s.calls.filter((c) => c.prompt.includes('These are the open findings on a deal')).length).toBe(1);
    // a deal with no open findings is said to have none, with no model call for it
    const none = setup(helper, { d1: [FA] }, { turn: catchUp });
    await deal(none.repo);
    val(await none.ai.answer(ask('Catch me up on the deal')));
    expect(none.turns[1].prompt).toContain('The catch-up on the open findings:\nno open findings.');
  });

  it('a catch-up names each deal, says when it failed, and never takes unreadable findings for none', async () => {
    const isBrief = (c: Call) => c.prompt.includes('These are the open findings on a deal');
    const catchUp = (_c: Call, n: number) => (n === 1 ? { tool: 'brief' } : { text: 'Done.', sources: [] });
    const lockUpFirst = (c: Call) => (isBrief(c) ? { paragraphs: ['Lock-up first.'] } : helper(c));
    const two = setup(lockUpFirst, undefined, { turn: catchUp });
    await deal(two.repo);
    await deal(two.repo, 'd2', 'Project Wingtip');
    await finding(two.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    const acrossDeals = { message: 'Catch me up', history: [], model: 'thorough', dealIds: ['d1', 'd2'] };
    const both = val(await two.ai.answer(acrossDeals));
    expect(two.turns[1].prompt).toContain('Project Proseware: Lock-up first.\n\nProject Wingtip: no open findings.');
    expect(both.research!.steps[1].result).toBe('Project Proseware: 1 paragraph · Project Wingtip: no open findings');
    // stopped while the first deal is briefed: the next deal is not briefed
    let stopper: ReturnType<typeof setup> | undefined;
    const stopOnBrief = (c: Call) => {
      if (!isBrief(c)) return helper(c);
      void stopper!.ai.stop!('r1');
      return { paragraphs: ['Lock-up first.'] };
    };
    stopper = setup(stopOnBrief, undefined, { repo: two.repo, turn: catchUp });
    const stopped = val(await stopper.ai.answer({ ...acrossDeals, runId: 'r1' }));
    expect(stopped.text).toBe('Done.');
    expect(stopper.calls.filter(isBrief).length).toBe(1);
    expect(stopper.turns[1].prompt).toContain('Project Wingtip: not briefed, since the person stopped the research.');
    // a brief the model cannot write is said so, and the answer still comes
    const unread = setup((c) => (isBrief(c) ? 'no' : helper(c)), { d1: [FA] }, { turn: catchUp });
    await deal(unread.repo);
    await finding(unread.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    const failed = val(await unread.ai.answer(ask('Catch me up')));
    expect(unread.turns[1].prompt).toContain('the catch-up could not be written: The AI’s reply could not be read.');
    expect(failed.text).toBe('Done.');
    expect(failed.research!.steps[1].result).toBe('could not be written');
    // findings that cannot be read just now: named as such, no brief asked, and the answer goes on
    const repo = memRepo(clock);
    const list = repo.list.bind(repo);
    repo.list = async (kind, dealId) => (kind === 'finding'
      ? { ok: false as const, error: { kind: 'unreachable' as const, message: 'The Punchlist folder cannot be read' } }
      : list(kind, dealId));
    const away = setup(helper, { d1: [FA] }, { repo, turn: catchUp });
    await deal(away.repo);
    expect(val(await away.ai.answer(ask('Catch me up'))).text).toBe('Done.');
    expect(away.turns[1].prompt).toContain('open findings:\nits findings could not be read just now.');
    expect(away.calls.some(isBrief)).toBe(false);
    // findings that drop out between the tool's read (the 2nd, after the first search) and the brief's own: said so,
    // never taken for an outage
    const flaky = memRepo(clock);
    const flakyList = flaky.list.bind(flaky);
    let findingReads = 0;
    flaky.list = async (kind, dealId) => (kind === 'finding' && ++findingReads === 3
      ? { ok: false as const, error: { kind: 'unreachable' as const, message: 'The Punchlist folder cannot be read' } }
      : flakyList(kind, dealId));
    const dropped = setup(helper, { d1: [FA] }, { repo: flaky, turn: catchUp });
    await deal(dropped.repo);
    await finding(dropped.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    findingReads = 0;
    expect(val(await dropped.ai.answer(ask('Catch me up'))).text).toBe('Done.');
    const folderDown = 'the catch-up could not be written: The Punchlist folder cannot be read.';
    expect(dropped.turns[1].prompt).toContain(folderDown);
    // the service down while the brief is written: the answer says so, as for any tool
    const down = setup((c) => {
      if (!isBrief(c)) return helper(c);
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' });
    }, { d1: [FA] }, { turn: catchUp });
    await deal(down.repo);
    await finding(down.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    const r = await down.ai.answer(ask('Catch me up'));
    expect(!r.ok && r.error.kind).toBe('unreachable');
  });

  it('a deal whose findings and questions cannot be read just now is named as such, never searched as empty', async () => {
    const repo = memRepo(clock); const list = repo.list.bind(repo); let down = true;
    repo.list = async (kind, dealId) => (down && dealId === 'd1' && (kind === 'finding' || kind === 'question') ? { ok: false as const, error: { kind: 'unreachable' as const, message: 'The Punchlist folder cannot be read' } } : list(kind, dealId));
    const s = setup(helper, { d1: [FA] }, { repo, turn: (_c, n) => n === 1 ? { tool: 'search', what: 'all', query: 'lock-up ratio' } : { text: 'Done.', sources: [] } });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    const r = val(await s.ai.answer(ask('What about the lock-up ratio?')));
    expect(s.turns[1].prompt).toContain('Findings in Project Proseware could not be read just now.'); expect(s.turns[1].prompt).toContain('Questions in Project Proseware could not be read just now.');
    expect(s.turns[1].prompt).not.toContain('none answers'); expect(s.turns[1].prompt).not.toContain('no question answers');
    expect(r.research!.steps[0].result).toContain('findings could not be read · questions could not be read');
    // asked across two deals, one of them unreadable: the hit in the other is given, and the step says some could not be read
    await deal(s.repo, 'd2', 'Project Wingtip'); val(await s.repo.transaction({ writes: [{ kind: 'finding', id: 'f_9', data: { id: 'f_9', dealId: 'd2', title: 'Lock-up ratio waived', workstream: 'Legal', status: 'open', body: ['Waived.'] }, expectedRev: null }], index: { dealId: 'd2', add: [{ kind: 'finding', id: 'f_9' }] } }));
    const u = setup(helper, { d1: [FA], d2: [OTHER] }, { repo, turn: (_c, n) => n === 1 ? { tool: 'search', what: 'findings', query: 'lock-up ratio' } : { text: 'Done.', sources: [] } });
    const both = val(await u.ai.answer({ message: 'What about the lock-up ratio?', history: [], model: 'thorough', dealIds: ['d1', 'd2'] }));
    expect(u.turns[1].prompt).toContain('Finding “Lock-up ratio waived”'); expect(u.turns[1].prompt).toContain('Findings in Project Proseware could not be read just now.');
    expect(both.research!.steps[1].result).toBe('1 finding · some could not be read');
    down = false; const t = setup(helper, { d1: [FA] }, { repo, turn: (_c, n) => n === 1 ? { tool: 'search', what: 'all', query: 'lock-up ratio' } : { text: 'Done.', sources: [] } });
    val(await t.ai.answer(ask('What about the lock-up ratio?'))); expect(t.turns[1].prompt).not.toContain('could not be read'); expect(t.turns[1].prompt).toContain('Finding “Lock-up ratio differs from the term sheet”');
  });

  it('stops at its ceiling of turns and answers with what it has; a search asked twice is not run twice', async () => {
    const s = setup(helper, undefined, { turns: 3, turn: (c, n) => (n < 3 ? { tool: 'search', what: 'documents', query: 'lock-up', notes: `Still looking ${n}.` } : c.prompt.includes('It is your last') ? { tool: 'search', query: 'more' } : {}) });
    const r = val(await s.ai.answer(ask('What is the margin?')));
    expect(s.turns.length).toBe(3); expect(s.turns[2].prompt).toContain('This is turn 3 of at most 3. It is your last: answer now from what you have, with no tool.');
    expect(s.turns[2].prompt).toContain('You searched documents for “lock-up” already'); expect(s.calls.length).toBe(2);                    // the question's own search, then "lock-up" once
    expect(r.text).toBe('Still looking 2.');                                                                                               // it would not answer: its notes are what it has
  });

  it('a tool it does not have, or a search with no query, is told so; the service out of reach fails the answer as unreachable', async () => {
    const s = setup(helper, undefined, { turn: (_c, n) => (n === 1 ? { tool: 'browse', url: 'x' } : n === 2 ? { tool: 'search' } : { text: 'ok', sources: [] }) });
    val(await s.ai.answer(ask('lock-up'))); expect(s.turns[1].prompt).toContain('There is no tool "browse"'); expect(s.turns[2].prompt).toContain('You asked for a search without a query');
    const down = setup(helper, undefined, { turn: () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
    const d = await down.ai.answer(ask('lock-up')); expect(!d.ok && d.error.kind).toBe('unreachable');
  });
});

describe('a kept conversation', () => {
  /** searches once, then answers; the answer names the turn it came on */
  const twoTurns = (c: Call) => (c.prompt.includes('You searched documents for “ratio”') ? { text: 'It is 1.25x.', sources: [] } : { tool: 'search', what: 'documents', query: 'ratio', notes: 'looking' });
  const reader = (c: Call) => ({ text: c.files.map((_f, i) => `Found in D${i + 1}. [${i + 1}]`).join(' '), sources: c.files.map((_f, i) => ({ doc: `D${i + 1}`, page: 1, quote: `words ${i + 1}` })) });
  const said = (list: string[]) => list.flatMap((text, i) => [{ role: 'me' as const, text }, { role: 'ai' as const, text: `Answer ${i + 1}` }]);

  it('a chat is one conversation on the service: a later turn sends only what is new, and the next question carries it on, numbering documents on', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns });
    const one = val(await s.ai.answer(ask('What is the lock-up?')));
    expect(one.thread).toMatchObject({ id: 'conv_1', model: 'thorough' }); expect(one.thread!.tags.length).toBeGreaterThan(0); expect(one.thread!.transcript).toBeUndefined();
    expect(s.turns[0].prompt).toContain('Question: What is the lock-up?'); expect(s.turns[1].prompt).not.toContain('Question:');          // the second turn is only what is new
    expect(s.turns[1].prompt).toMatch(/^You searched documents for “ratio”\./); expect(s.turns[1].prompt).not.toContain('Your notes so far');
    const two = val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: one.thread })));
    expect(s.svc.conversations.size).toBe(1); expect(two.thread!.id).toBe('conv_1');                                                             // carried on, not started again
    expect(s.turns[2].prompt).toContain('Question: And the margin?'); expect(s.turns[2].prompt).not.toContain('Earlier in this conversation');    // the service has what was said
    expect(two.thread!.tags.slice(0, one.thread!.tags.length)).toEqual(one.thread!.tags); expect(two.thread!.tokens).toBeGreaterThan(one.thread!.tokens);
  });

  it('a question keeps its handle on later turns of a conversation; a new one takes the next (#1105)', async () => {
    const handleIn = (prompt: string, text: string) =>
      new RegExp(`(R\\d+) · Answered\nQuestion: ${text}`).exec(prompt)?.[1];
    let revenue = '';
    const turn = (c: Call) => {
      revenue ||= handleIn(c.prompt, 'How did revenue move') ?? '';
      const tariff = handleIn(c.prompt, 'Was the tariff reset');
      if (!tariff) return { text: `Response ${revenue} says revenue fell.`, sources: [] };
      const text = `Response ${tariff} says the tariff is R1.2 billion; response ${revenue} still stands.`;
      return { text, sources: [] };
    };
    const s = setup(reader, undefined, { talks: true, turn });
    await deal(s.repo);
    const fell = { n: 3, status: 'answered', text: 'How did revenue move?', response: 'It fell.' };
    val(await question(s.repo, 'q_3', fell));
    const one = val(await s.ai.answer(ask('How did revenue move?')));
    expect(one.text).toBe('The response to Q3 says revenue fell.');
    expect(one.thread!.questions).toEqual([{ handle: revenue, id: 'q_3', n: 3 }]);
    const reset = { n: 7, status: 'answered', text: 'Was the tariff reset?', response: 'R1.2 billion.' };
    val(await question(s.repo, 'q_7', reset));
    const later = { history: said(['How did revenue move?']), thread: one.thread };
    const two = val(await s.ai.answer(ask('Was the tariff reset?', later)));
    expect(two.text).toBe('The response to Q7 says the tariff is R1.2 billion; the response to Q3 still stands.');
    const kept = [{ handle: revenue, id: 'q_3', n: 3 }, { handle: 'R2', id: 'q_7', n: 7 }];
    expect(two.thread!.questions).toEqual(kept);
  });

  it('a full conversation is compacted: the conversation so far goes in a transcript file, attached to a new one, and the last transcript is deleted', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns, compactAt: 20_000 });
    const one = val(await s.ai.answer(ask('What is the lock-up?')));
    const two = val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: { ...one.thread!, tokens: 20_000 } })));
    expect(two.thread!.id).toBe('conv_2'); const file = two.thread!.transcript!; expect(s.svc.files.get(file)!.name).toMatch(/^conversation-[0-9a-z]+\.txt$/);
    expect(new TextDecoder().decode(s.svc.files.get(file)!.bytes)).toBe('Person: What is the lock-up?\nYou: Answer 1');
    expect(s.turns[2].files.map((f) => f.id)).toContain(file); expect(s.turns[2].prompt).toContain('Earlier in this conversation:\nPerson: What is the lock-up?'); expect(s.turns[2].prompt).toContain('in the attached transcript');
    expect(s.turns[3].files.map((f) => f.id)).not.toContain(file);                                                                                 // the conversation keeps it: not sent again
    const three = val(await s.ai.answer(ask('And the tenor?', { history: said(['What is the lock-up?', 'And the margin?']), thread: { ...two.thread!, tokens: 30_000 } })));
    expect(three.thread!.transcript).not.toBe(file); expect(s.svc.removed).toEqual([file]);                                                       // the new transcript holds it all
  });

  it('a conversation the service no longer has, or one on another model, is started again from its transcript', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns });
    const gone = val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: { id: 'conv_9', model: 'thorough', tokens: 100, tags: [{ tag: 'D4', dealId: 'd1', docId: FA.docId }, { tag: 'D6', dealId: 'd1', docId: 'deleted' }] } })));
    expect(gone.thread!.id).toBe('conv_1'); expect(gone.thread!.transcript).toBeTruthy(); expect(gone.thread!.tags[0]).toEqual({ tag: 'D4', dealId: 'd1', docId: FA.docId });   // tags keep their numbers
    expect(gone.thread!.tags.slice(1, -1).every((t) => +t.tag.slice(1) > 6)).toBe(true); expect(gone.thread!.tags.at(-1)).toEqual({ tag: 'D6', dealId: 'd1', docId: 'deleted' });   // a document no longer here keeps its number
    const other = val(await s.ai.answer(ask('And the tenor?', { model: 'standard', history: said(['What is the lock-up?', 'And the margin?']), thread: gone.thread })));
    expect(other.thread).toMatchObject({ id: 'conv_2', model: 'standard' }); expect(s.svc.removed).toEqual([gone.thread!.transcript]);
  });

  it('a reply that cannot be read is sent back once in the same conversation, to be put right', async () => {
    const s = setup(reader, undefined, { talks: true, turn: (c) => (c.prompt.startsWith('Your reply cannot be read') ? { text: 'It is 1.25x.', sources: [] } : 'I think it is 1.25x') });
    const r = val(await s.ai.answer(ask('What is the lock-up?')));
    expect(r.text).toBe('It is 1.25x.'); expect(s.svc.conversations.size).toBe(1); expect(s.svc.conversations.get('conv_1')!.said[2]).toMatch(/^Your reply cannot be read as one JSON object/);
    expect(s.usage.flatMap((u) => u.calls).some((c) => c.kind === 'fix' && c.model === 'thorough')).toBe(true);                                               // counted for the usage log as a repair
  });

  /** what the agent sent to the service's converse, turn by turn */
  const spied = (s: ReturnType<typeof setup>) => { const seen: ConverseInput[] = []; const was = s.svc.converse.bind(s.svc); s.svc.converse = (i) => { seen.push(i); return was(i); }; return seen; };

  it('hybrid: search, read and answer go as tools, and a tool\'s result goes back in the next message', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns, toolCalls: 'hybrid' }); const seen = spied(s);
    const r = val(await s.ai.answer(ask('What is the lock-up?')));
    const tools = ['search', 'read', 'folder', 'brief', 'answer'];
    expect(seen.map((i) => i.tools?.map((t) => t.name))).toEqual([tools, tools]);
    expect(seen.every((i) => !i.results)).toBe(true);
    expect(seen[1].prompt).toMatch(/^You searched documents for “ratio”\./); expect(r.text).toBe('It is 1.25x.');
  });

  it.each(['native', 'hybrid'] as const)('%s: the brief tool is called and its result goes back', async (toolCalls) => {
    const isBrief = (c: Call) => c.prompt.includes('These are the open findings on a deal');
    const catchUp = (_c: Call, n: number) => (n === 1 ? { tool: 'brief' } : { text: 'Done.', sources: [] });
    const s = setup((c) => (isBrief(c) ? { paragraphs: ['Lock-up first.'] } : reader(c)), undefined,
      { talks: true, turn: catchUp, toolCalls });
    const seen = spied(s);
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'Lock-up ratio differs from the term sheet');
    expect(val(await s.ai.answer(ask('Catch me up'))).text).toBe('Done.');
    // native: as the call's result; hybrid: in the next message
    const told = toolCalls === 'native' ? seen[1].results![0].text : seen[1].prompt;
    expect(told).toContain('The catch-up on the open findings:\nLock-up first.');
  });

  const modes = ['inline', 'hybrid', 'native'] as const;
  it.each(modes)('%s: an offer the answer makes is passed on as given (#1054)', async (toolCalls) => {
    const offer = { action: 'open page', deal: 'Kestrel', page: 'qa' };
    const offering = () => ({ text: 'Opening it.', sources: [], offer });
    const s = setup(reader, undefined, { talks: true, turn: offering, toolCalls });
    const seen = spied(s);
    const r = val(await s.ai.answer(ask('Take me to the Kestrel Q&A')));
    expect(r.text).toBe('Opening it.'); expect(r.offer).toEqual(offer);
    if (toolCalls === 'inline') expect(seen[0].system).toContain('"offer": {"action": "new deal" | "open page"');
    else expect(seen[0].tools!.find((t) => t.name === 'answer')!.parameters.properties).toHaveProperty('offer');
    const plain = () => ({ text: 'It is 1.25x.', sources: [] });
    const none = setup(reader, undefined, { talks: true, turn: plain, toolCalls });
    expect(val(await none.ai.answer(ask('What is the lock-up?')))).not.toHaveProperty('offer');
  });

  it('native: a result goes back as its call\'s result, and the next question answers the last call first; a model that refuses tool results steps down to hybrid in the same conversation', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns, toolCalls: 'native' }); const seen = spied(s);
    const one = val(await s.ai.answer(ask('What is the lock-up?')));
    expect(seen[0].tools!.map((t) => t.name)).toEqual(['search', 'read', 'folder', 'brief', 'answer']);
    expect(seen[0].system).toMatch(/^You are researching .*call one tool: search, read, folder, brief or answer\./s);
    expect(seen[0].results).toBeUndefined();
    expect(seen[1].results).toHaveLength(1);
    expect(seen[1].results![0].text).toMatch(/^You searched documents for “ratio”\./);
    expect(seen[1].prompt).toMatch(/This is turn 2 of at most \d+\.$/);
    expect(one.text).toBe('It is 1.25x.'); expect(one.thread!.call).toMatch(/^call_/);
    val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: one.thread })));
    expect(seen[2].results).toEqual([{ id: one.thread!.call, text: 'The answer was shown to the person.' }]); expect(seen[2].prompt).toContain('Question: And the margin?');
    const n = setup(reader, undefined, { talks: true, turn: twoTurns, toolCalls: 'native' }); n.svc.noToolResults = true; const asked = spied(n);
    const two = val(await n.ai.answer(ask('What is the lock-up?'))); expect(two.text).toBe('It is 1.25x.');
    expect(asked.map((i) => [!!i.tools, !!i.results, i.conversation ?? null])).toEqual([[true, false, null], [true, true, 'conv_1'], [true, false, 'conv_1']]);   // refused, then sent as a message
    expect(asked[2].prompt).toMatch(/^You searched documents for “ratio”\./);
    val(await n.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: two.thread })));   // refused again: hybrid from now on
    const at = asked.length; val(await n.ai.answer(ask('And the tenor?'))); expect(asked.slice(at).some((i) => i.results)).toBe(false);
  });

  it('a model that refuses tool calls steps down to the JSON block in a new conversation, and stays there; the block is the default', async () => {
    const s = setup(reader, undefined, { talks: true, turn: twoTurns, toolCalls: 'hybrid' }); s.svc.noTools = true; const seen = spied(s);
    const one = val(await s.ai.answer(ask('What is the lock-up?')));
    expect(one.text).toBe('It is 1.25x.'); expect(seen.map((i) => !!i.tools)).toEqual([true, false, false]); expect(seen[1].conversation).toBeUndefined(); expect(seen[1].system).toContain('reply with one JSON object');
    val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']), thread: one.thread }))); expect(seen.slice(3).some((i) => i.tools)).toBe(false);   // remembered for that model
    const inline = setup(reader, undefined, { talks: true, turn: twoTurns }); const asked = spied(inline);   // the control file's default: inline
    val(await inline.ai.answer(ask('What is the lock-up?'))); expect(asked.some((i) => i.tools)).toBe(false); expect(asked.length).toBe(2);
  });

  it('a passing failure on a later turn is asked again as a new conversation, in full, and the answer still comes (decisions: Retries)', async () => {
    for (const toolCalls of ['inline', 'hybrid'] as const) {
      let failed = false;
      const s = setup(reader, undefined, { talks: true, toolCalls, turn: (c, n) => { if (n === 2 && !failed) { failed = true; throw Object.assign(new Error('said 500: internal'), { status: 500 }); } return twoTurns(c); } }); const seen = spied(s);
      const r = val(await s.ai.answer(ask('What is the lock-up?')));
      expect(r.text).toBe('It is 1.25x.');
      expect(seen.map((i) => i.conversation ?? null)).toEqual([null, 'conv_1', null]);   // the failed turn is not sent into conv_1 again
      expect(seen[2].prompt).toContain('You searched documents for “ratio”');           // asked in full in the new one
    }
    // a failure that goes on is shown once the turn has had its three tries: one in the conversation, two in the new one
    const down = setup(reader, undefined, { talks: true, turn: (c, n) => { if (n >= 2) throw Object.assign(new Error('said 500: internal'), { status: 500 }); return twoTurns(c); } }); const tried = spied(down);
    const d = await down.ai.answer(ask('What is the lock-up?')); expect(d.ok).toBe(false); expect(tried.length).toBe(4);   // the first turn, then the failing turn's three tries
  });

  it('an empty reply on a later turn is asked again as a new conversation, in every way of calling tools, and the answer still comes', async () => {
    for (const toolCalls of ['inline', 'hybrid', 'native'] as const) {
      let empty = false;
      const s = setup(reader, undefined, { talks: true, toolCalls, turn: (c, n) => { if (n === 2 && !empty) { empty = true; return ''; } return twoTurns(c); } }); const seen = spied(s);
      const r = val(await s.ai.answer(ask('What is the lock-up?')));
      expect(r.text).toBe('It is 1.25x.'); expect(seen.map((i) => i.conversation ?? null)).toEqual([null, 'conv_1', null]);
      expect(seen[2].prompt).toContain('You searched documents for “ratio”');
    }
  });

  it('with retries off, a failed later turn is not asked again as a new conversation', async () => {
    const failing = (c: Call, n: number) => { if (n >= 2) throw Object.assign(new Error('said 500: internal'), { status: 500 }); return twoTurns(c); };
    const off = setup(reader, undefined, { talks: true, retry: { retries: 0, sleep: async () => {} }, turn: failing }); const sent = spied(off);
    expect((await off.ai.answer(ask('What is the lock-up?'))).ok).toBe(false); expect(sent.map((i) => i.conversation ?? null)).toEqual([null, 'conv_1']);
  });

  it('an outage that begins on a turn of tool results gives it 3 tries in all: the results, the step down, one new conversation', async () => {
    const s = setup(reader, undefined, { talks: true, toolCalls: 'native', turn: (c, n) => { if (n >= 2) throw Object.assign(new Error('said 500: internal'), { status: 500 }); return twoTurns(c); } }); const seen = spied(s);
    expect((await s.ai.answer(ask('What is the lock-up?'))).ok).toBe(false);
    expect(seen.map((i) => [!!i.results, i.conversation ?? null])).toEqual([[false, null], [true, 'conv_1'], [false, 'conv_1'], [false, null]]);
  });

  it('a later turn asked again as a new conversation waits as a retry does: 2 seconds, then 4', async () => {
    const waits: number[] = [];
    const s = setup(reader, undefined, { talks: true, retry: { sleep: async (ms) => { waits.push(ms); } }, turn: (c, n) => { if (n >= 2) throw Object.assign(new Error('said 500: internal'), { status: 500 }); return twoTurns(c); } });
    expect((await s.ai.answer(ask('What is the lock-up?'))).ok).toBe(false); expect(waits).toEqual([2000, 4000]);
  });

  it('one 500 on a turn of tool results moves only that answer to hybrid; the model stays native until it happens again', async () => {
    const s = setup(reader, undefined, { talks: true, toolCalls: 'native', turn: twoTurns });
    let failNext = true; const was = s.svc.converse.bind(s.svc); s.svc.converse = (i) => { if (i.results?.length && failNext) { failNext = false; return Promise.reject(Object.assign(new Error('said 500: internal'), { status: 500 })); } return was(i); };
    const seen = spied(s);
    const one = val(await s.ai.answer(ask('What is the lock-up?'))); expect(one.text).toBe('It is 1.25x.');
    expect(seen.map((i) => [!!i.results, i.conversation ?? null])).toEqual([[false, null], [true, 'conv_1'], [false, 'conv_1']]);   // this answer: sent again as a message
    let before = seen.length; val(await s.ai.answer(ask('What is the tenor?'))); expect(seen.slice(before).some((i) => i.results)).toBe(true);   // the next one: native again
    failNext = true; val(await s.ai.answer(ask('And the margin?'))); expect(failNext).toBe(false);
    before = seen.length; val(await s.ai.answer(ask('And the tenor?'))); expect(seen.slice(before).some((i) => i.results)).toBe(true);   // native took results since: that one is forgotten
    failNext = true; val(await s.ai.answer(ask('And the margin?'))); expect(failNext).toBe(false);
    failNext = true; val(await s.ai.answer(ask('And the margin?'))); expect(failNext).toBe(false);   // two in a row
    before = seen.length; val(await s.ai.answer(ask('And the fees?'))); expect(seen.slice(before).some((i) => i.results)).toBe(false);   // twice: hybrid for the run
  });

  it('only a refusal of the way tools are called steps down: any other error on a turn with tools fails the turn as it is', async () => {
    const s = setup(reader, undefined, { talks: true, toolCalls: 'hybrid', turn: () => { throw Object.assign(new Error('said 500: internal'), { status: 500 }); } }); const seen = spied(s);
    const r = await s.ai.answer(ask('What is the lock-up?')); expect(!r.ok && r.error.kind).toBe('failed'); expect(seen.map((i) => !!i.tools)).toEqual([true, true, true]);   // asked again as it was (decisions: Retries), never without tools
  });

  it('without conversations on the service, each turn is asked afresh with the last messages as text, and no thread goes back', async () => {
    const s = setup(reader, undefined, { turn: twoTurns });
    const r = val(await s.ai.answer(ask('And the margin?', { history: said(['What is the lock-up?']) })));
    expect(r.thread).toBeUndefined(); expect(s.turns[1].prompt).toContain('Earlier in this conversation:\nPerson: What is the lock-up?'); expect([...s.svc.files.values()].some((f) => f.name.startsWith('conversation-'))).toBe(false);
  });
});

describe('drafts, reassessments, the brief, the import layout and whether an answer addresses a question', () => {
  it('a draft is found only with a document behind it', async () => {
    const found = setup((c) => ({ status: 'found', text: 'The credit agreement sets it at 1.25x. [1]', sources: [{ doc: tag(c, FA), page: 14 }] }));
    expect(val(await found.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' }))).toEqual({ status: 'found', text: 'The credit agreement sets it at 1.25x. [1]', sources: [{ doc: 'Credit Agreement.pdf', loc: 'p. 14', docId: FA.docId }] });
    expect(found.calls.map((c) => c.model)).toEqual(['standard']);                                                                                      // routed: not the model the person chose for conversations
    for (const reply of [{ status: 'none' }, { status: 'found', text: 'It is 1.25x.', sources: [] }, { status: 'found', text: 'It is 1.25x. [1]', sources: [{ doc: 'D99', page: 1 }] }])
      expect(val(await setup(() => reply).ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' }))).toEqual({ status: 'none', text: '', sources: [] });
    const empty = setup(() => ({}), {}); expect(val(await empty.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'x' })).status).toBe('none'); expect(empty.calls.length).toBe(0);
  });

  it('a person’s choice of model is never changed: a chat answer that cannot be read fails on the model they chose; a draft is sent back to the standard model once, then the thorough one', async () => {
    const s = setup(() => 'I am sorry, I cannot'); const a = await s.ai.answer(ask('lock-up', { model: 'fast' })); expect(!a.ok && a.error.kind).toBe('failed');
    const d = await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' }); expect(!d.ok && d.error.kind).toBe('failed');
    expect(s.calls.map((c) => c.model)).toEqual(['fast', 'standard', 'standard', 'thorough']);
  });

  it('a draft is asked for under 30,000 characters, and one that runs over is sent back to be cut down', async () => {
    const s = setup((c, n) => (n === 1 ? { status: 'found', text: 'x'.repeat(31_000), sources: [] } : { status: 'found', text: 'Shorter.', sources: [] }));
    await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' });
    expect(s.calls[0].system ?? s.calls[0].prompt).toMatch(/30,000 characters/);
    expect(s.calls.length).toBe(2); expect(s.calls[1].prompt).toMatch(/longer than 30,000 characters: cut it down/);
  });

  it('a draft or a reassessment resting only on another project’s document is not offered', async () => {
    const PRE = doc(88, 'Coho Credit Agreement.pdf', { rel: 'Precedents/Coho Credit Agreement.pdf', summary: 'Lock-up ratio on another project.' });
    const only = setup((c) => ({ status: 'found', text: 'It is 1.10x. [1]', sources: [{ doc: tag(c, PRE), page: 2 }] }), { d1: [FA, PRE] });
    expect(val(await only.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' }))).toEqual({ status: 'none', text: '', sources: [] });
    const both = setup((c) => ({ status: 'found', text: 'It is 1.25x [1], against 1.10x on another project. [2]', sources: [{ doc: tag(c, FA), page: 14 }, { doc: tag(c, PRE), page: 2 }] }), { d1: [FA, PRE] });
    expect(val(await both.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' })).status).toBe('found');
    const re = setup((c) => ({ body: ['Another project has 1.10x. [1]'], sources: [{ doc: tag(c, PRE), page: 2 }] }), { d1: [FA, PRE] }); await deal(re.repo);
    await finding(re.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    const r = await re.ai.reassess({ dealId: 'd1', findingId: 'f_1' }); expect(!r.ok && r.error.kind).toBe('failed');
  });
  it('a reassessment reads the finding’s own documents with the standard model, and comes back as paragraphs', async () => {
    const s = setup((c) => ({ body: ['The draft still has 1.25x. [1]', 'The term sheet has 1.30x. [2]'], sources: [{ doc: tag(c, FA), page: 14 }, { doc: tag(c, TS), page: 3 }] })); await deal(s.repo);
    await finding(s.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }, { doc: TS.name, loc: 'p. 3', docId: TS.docId }] });
    expect(val(await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }))).toEqual({ body: ['The draft still has 1.25x. [1]', 'The term sheet has 1.30x. [2]'], sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }, { doc: TS.name, loc: 'p. 3', docId: TS.docId }] });
    expect(s.calls.map((c) => c.model)).toEqual(['standard']); expect(s.calls[0].prompt).toContain('Title: Lock-up differs');
    const none = await s.ai.reassess({ dealId: 'd1', findingId: 'f_9' }); expect(!none.ok && none.error.kind).toBe('notFound');
  });

  it('the deal memo groups related findings into risks and writes each key risk up from its findings’ documents', async () => {
    const isRate = (c: Call) => c.prompt.startsWith('Rate each of these open findings');
    const isGroup = (c: Call) => c.prompt.startsWith('These are the open findings on a deal, each with');
    const isRisk = (c: Call) => c.prompt.includes('Write up this risk on the deal');
    const isSummary = (c: Call) => c.prompt.includes('Write the summary of a deal memo');
    const risk = (advise: (n: number) => boolean) => { let n = 0; return (c: Call) => (++n, { paragraphs: [`Draft 3 sets the lock-up at 1.25x over six months, f_2 says. [1] The signed term sheet has 1.30x over twelve. [2]${advise(n) ? ' The lenders should insist on 1.30x.' : ''}`], sources: [{ doc: tag(c, FA), page: 14 }, { doc: tag(c, TS), page: 3 }] }); };
    const make = async (write: (c: Call) => unknown) => {
      const s = setup((c) => (isRate(c) ? { ratings: [{ id: 'f_1', rating: 'High' }, { id: 'f_2', rating: 'Medium' }, { id: 'f_3', rating: 'Low' }] }
        : isGroup(c) ? { risks: [{ title: 'Distribution terms differ from the term sheet (f_1)', findings: ['f_1', 'f_2', 'f_9'] }] }
        : isRisk(c) ? write(c) : isSummary(c) ? { paragraphs: ['A project. [1]'], sources: [] } : 'I cannot say'));
      await deal(s.repo);
      await finding(s.repo, 'f_1', 'Lock-up ratio differs', { body: ['1.25x against 1.30x. [1]'], sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
      await finding(s.repo, 'f_2', 'Test period is shorter', { workstream: 'Financial', body: ['Six months against twelve. [1]'], sources: [{ doc: TS.name, loc: 'p. 3', docId: TS.docId }] });
      await finding(s.repo, 'f_3', 'Notice address differs');
      val(await question(s.repo, 'q_12', { n: 12, text: 'Which lock-up ratio was agreed?', response: 'The agreed ratio is 1.25x.', respondedBy: 'Sponsor counsel', responded: '2026-11-10', linkedFinding: 'f_1' }));
      return s;
    };
    const s = await make(risk(() => false)); const m = val(await s.ai.memo!('d1'));
    // one risk of the two open findings named (f_9 is not one), no id in its words; the finding no group named is a risk of its own, not written up
    expect(m.risks).toEqual([
      { title: 'Distribution terms differ from the term sheet', findings: ['f_1', 'f_2'], body: ['Draft 3 sets the lock-up at 1.25x over six months, this finding says. [1] The signed term sheet has 1.30x over twelve. [2]'], sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }, { doc: TS.name, loc: 'p. 3', docId: TS.docId }] },
      { title: 'Notice address differs', findings: ['f_3'] },
    ]);
    const asked = s.calls.filter(isRisk); expect(asked.length).toBe(1); expect(asked[0].model).toBe('standard');
    expect(asked[0].prompt).toContain('- Lock-up ratio differs (Legal): 1.25x against 1.30x.'); expect(asked[0].prompt).toContain('- Test period is shorter (Financial): Six months against twelve.');
    expect(asked[0].prompt).toContain('no next steps');
    // answered replies are not shown: no response, question or responder reaches the write-up
    for (const t of ['The agreed ratio is 1.25x', 'Which lock-up ratio was agreed', 'Sponsor counsel', 'Q12', 'response to']) expect(asked[0].prompt).not.toContain(t); expect(sentNames(asked[0])).toEqual(expect.arrayContaining([FA.name, TS.name]));   // the findings' own documents are read
    // a write-up that advises is sent back, then goes to the thorough model; if it still advises, the findings' own words stand
    const once = await make(risk((n) => n === 1)); expect(val(await once.ai.memo!('d1')).risks![0].body).toHaveLength(1);
    expect(once.calls.filter(isRisk).map((c) => c.model)).toEqual(['standard', 'standard']);
    const never = await make(risk(() => true)); const r = val(await never.ai.memo!('d1')).risks![0];
    expect(r.body).toBeUndefined(); expect(never.calls.filter(isRisk).map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
  });

  it('the thorough model is a fallback only: it is asked after the standard model has failed twice, and once', async () => {
    const good = (c: Call) => ({ body: ['Still 1.25x. [1]'], sources: [{ doc: tag(c, FA), page: 14 }] });
    for (const bad of ['I am sorry, I cannot', { body: [] }, { text: 'not the shape asked for' }]) {
      const once = setup((c, n) => (n === 1 ? bad : good(c))); await deal(once.repo); await finding(once.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
      expect(val(await once.ai.reassess({ dealId: 'd1', findingId: 'f_1' })).body).toEqual(['Still 1.25x. [1]']); expect(once.calls.map((c) => c.model)).toEqual(['standard', 'standard']);   // one failure: the standard model again, not a dearer one
      // what could be read is sent back with what is wrong with it; what could not be read at all is simply asked again
      if (typeof bad === 'object' && 'body' in bad) expect(once.calls[1].prompt).toBe(`${once.calls[0].prompt}\n\nYou replied:\n{"body":[]}\n\nThat cannot be used: "body" has no paragraphs in it. Send the whole reply again, put right.`); else expect(once.calls[1].prompt).toBe(once.calls[0].prompt);
      const twice = setup((c, n) => (n <= 2 ? bad : good(c))); await deal(twice.repo); await finding(twice.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
      expect(val(await twice.ai.reassess({ dealId: 'd1', findingId: 'f_1' })).body).toEqual(['Still 1.25x. [1]']); expect(twice.calls.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']); expect(twice.calls[2].prompt).toBe(twice.calls[0].prompt);
    }
    const never = setup(() => 'no'); await deal(never.repo); await finding(never.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    const r = await never.ai.reassess({ dealId: 'd1', findingId: 'f_1' });
    expect(!r.ok && r.error).toEqual({ kind: 'failed', message: 'The AI’s reply could not be read' });
    expect(never.calls.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
    const down = setup(() => { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; }); await deal(down.repo); await finding(down.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    const d = await down.ai.reassess({ dealId: 'd1', findingId: 'f_1' }); expect(!d.ok && d.error.kind).toBe('unreachable'); expect(down.calls.length).toBe(1);        // a service that is down is not a reason to try a dearer model
  });

  it('the brief is written by the standard model, links only to findings that exist, and is not asked for again until a finding changes', async () => {
    const s = setup(() => ({ paragraphs: ['The {lock-up mismatch|f_1} matters most. [1]', 'Also {something else|f_404}.', 'A third paragraph.'] })); await deal(s.repo);
    expect(val(await s.ai.dealBrief('d1'))).toEqual({ paragraphs: [] }); expect(s.calls.length).toBe(0);                                              // no findings: nothing to say, nothing asked
    await finding(s.repo, 'f_1', 'Lock-up differs'); await finding(s.repo, 'f_2', 'Closed already', { status: 'closed' });
    const b = val(await s.ai.dealBrief('d1')); expect(b.paragraphs).toEqual(['The {lock-up mismatch|f_1} matters most.', 'Also something else.']);
    expect(s.calls[0].model).toBe('standard'); expect(s.calls[0].files).toEqual([]); expect(s.calls[0].prompt).toContain('f_1 (Legal): Lock-up differs'); expect(s.calls[0].prompt).not.toContain('Closed already');
    val(await s.ai.dealBrief('d1')); expect(s.calls.length).toBe(1); expect(s.coreCalls.length).toBe(0);                                              // written from the findings as stored: no document is read
    val(await s.repo.transaction({ writes: [{ kind: 'finding', id: 'f_1', data: { id: 'f_1', dealId: 'd1', title: 'Lock-up differs', workstream: 'Legal', status: 'open', body: ['Rewritten.'], sources: [] }, expectedRev: 1 }] }));
    val(await s.ai.dealBrief('d1')); expect(s.calls.length).toBe(2);
    const thinBrief = setup((_c, n) => (n === 1 ? { paragraphs: [] } : { paragraphs: ['One.'] })); await deal(thinBrief.repo); await finding(thinBrief.repo, 'f_1', 'Lock-up differs');
    expect(val(await thinBrief.ai.dealBrief('d1')).paragraphs).toEqual(['One.']); expect(thinBrief.calls[1].prompt).toContain('You replied:\n{"paragraphs":[]}\n\nThat cannot be used: "paragraphs" has no paragraphs in it.');
    const twice = setup((_c, n) => (n === 1 ? 'no' : { paragraphs: ['One.'] })); await deal(twice.repo); await finding(twice.repo, 'f_1', 'Lock-up differs');
    expect(val(await twice.ai.dealBrief('d1')).paragraphs).toEqual(['One.']); expect(twice.calls.map((c) => c.model)).toEqual(['standard', 'standard']);
    const thrice = setup((_c, n) => (n <= 2 ? 'no' : { paragraphs: ['One.'] })); await deal(thrice.repo); await finding(thrice.repo, 'f_1', 'Lock-up differs');
    expect(val(await thrice.ai.dealBrief('d1')).paragraphs).toEqual(['One.']); expect(thrice.calls.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
  });

  it('the import layout comes from the fast model and keeps only headings that are in the row it names', async () => {
    const sheets = [{ name: 'Cover', first: 1, rows: [['Q&A log']] }, { name: 'Q&A', first: 5, rows: [['Lender queries'], ['Ref', 'Lender query', 'Sponsor reply', 'Raised by']] }];
    const s = setup(() => ({ sheet: 'Q&A', headerRow: 6, fields: { n: 'Ref', text: 'Lender query', response: 'Sponsor reply', askedBy: 'Not a heading', invented: 'Ref' } }));
    expect(val(await s.ai.layout!({ fileName: 'log.xlsx', bytes: new Uint8Array(), sheets, fields: ['n', 'text', 'response', 'askedBy'] }))).toEqual({ sheet: 'Q&A', headerRow: 6, fields: { n: 'Ref', text: 'Lender query', response: 'Sponsor reply' } });
    expect(s.calls.map((c) => c.model)).toEqual(['fast']); expect(s.calls[0].prompt).toContain('6: Ref | Lender query | Sponsor reply | Raised by');
    const wrong = await setup(() => ({ sheet: 'Nowhere', headerRow: 1, fields: {} })).ai.layout!({ fileName: 'log.xlsx', bytes: new Uint8Array(), sheets, fields: ['text'] }); expect(!wrong.ok && wrong.error.message).toBe('No table found');
  });

  it('whether an answer addresses a question is judged by the standard model from the two texts alone, in one short line', async () => {
    const s = setup(() => ({ verdict: ' Partly ', why: 'It gives the figure the base case uses,\n  not where it comes from.' }));
    const i = { dealId: 'd1', question: 'Which operating assumption does the base case use, and where does it come from?', answer: 'The base case uses 98% availability.' };
    expect(val(await s.ai.addresses!(i))).toEqual({ verdict: 'partly', why: 'It gives the figure the base case uses, not where it comes from.' });
    expect(s.calls.map((c) => c.model)).toEqual(['standard']); expect(s.calls[0].files).toEqual([]);   // no documents go with it
    expect(s.calls[0].prompt).toContain(i.question); expect(s.calls[0].prompt).toContain(i.answer);
    const long = setup(() => ({ verdict: 'no', why: 'x'.repeat(500) })); expect(val(await long.ai.addresses!(i)).why).toHaveLength(200);
    const odd = await setup(() => ({ verdict: 'maybe', why: 'Hard to say.' })).ai.addresses!(i);
    expect(!odd.ok && odd.error.message).toBe('The AI’s reply could not be read');
  });
});

// ── the first pass ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** A stand-in for the firm's checklist: three layers, as the real one has. The items are made up for these tests. */
const LIST: Checklist = {
  broad: [{ id: 'b1', text: 'The lock-up ratio is the same in the credit agreement and the term sheet' }, { id: 'b2', text: 'The capacity in the information memorandum matches the financial model' }, { id: 'b3', text: 'An insurance advisor report covers the construction period' }, { id: 'b4', text: 'The sponsor is named consistently' }],
  product: [{ id: 'p1', text: 'Derivatives have been signed off by the directors' }, { id: 'p2', text: ' the lock-up ratio is the same in the  credit agreement and the term sheet ' }, { id: 'b2', text: 'Same id as an earlier item' }, { id: '', text: 'No id' }, { id: 'p3', text: ' ' }],
  sector: [{ id: 's1', text: 'The interconnection permit is in place' }, { id: 's2', text: 'The debt sizing in the model follows the term sheet' }, { id: 's3', text: 'Decommissioning is provided for' }],
};
/** the checklist items a first-pass call was given (the list ends where the instructions begin) */
const itemsIn = (c: Call) => c.prompt.includes('write up to 3 short searches') ? [] : [...c.prompt.split('\n\nGive each item one')[0].matchAll(/^(I\d+): (.*)$/gm)].map((m) => ({ tag: m[1], text: m[2] }));
/** A satisfied result that says where, as a real reply must: the first document in the call that has pages, at page 1 (a cell of the first, with only spreadsheets). The fast model's quick look is not asked for a place and gives none. */
const OK = (c: Call): { result: string; where?: object[] } => {
  if (!c.prompt.includes('Add "where"')) return { result: 'ok' };
  const docs = [...c.prompt.split('\n\nCheck each of these')[0].matchAll(/^(D\d+): ([^\n]*)$/gm)]; const paged = docs.find((m) => !/\.(xlsx|xlsm|xlsb|xls|ods|csv)\b/i.test(m[2]));
  return paged ? { result: 'ok', where: [{ doc: paged[1], page: 1, quote: 'As the item requires.' }] } : docs[0] ? { result: 'ok', where: [{ doc: docs[0][1], sheet: 'Sheet1', cell: 'A1' }] } : { result: 'ok' };
};
const idOf = (text: string) => [...LIST.broad, ...LIST.product, ...LIST.sector].find((it) => it.text === text)?.id ?? '?';
/** answer a first-pass call item by item */
const itemReply = (c: Call, each: (id: string, c: Call) => object | undefined) => ({ items: itemsIn(c).map((it) => { const r = each(idOf(it.text), c); return r ? { id: it.tag, ...r } : null; }).filter(Boolean) });
const has = (c: Call, d: DocRecord) => tag(c, d) !== 'D?';
const LOCKUP = (c: Call) => ({ result: 'finding', title: 'Lock-up ratio differs between the credit agreement and the term sheet', workstream: 'Legal', body: ['The draft sets it at 1.25x. [1]', 'The term sheet has 1.30x. [2]'], next: 'Confirm with counsel which was agreed.', sources: [{ doc: tag(c, FA), page: 14 }, { doc: tag(c, TS), page: 3 }] });
const SIZING = (c: Call) => ({ result: 'finding', title: 'Debt sizing in the model departs from the term sheet', workstream: 'Financial', body: ['The model sizes to 1.20x. [1] The term sheet says 1.30x. [2]'], next: '', sources: [{ doc: tag(c, MODEL), cell: 'Debt!B2' }, { doc: tag(c, TS), page: 4 }] });
/** how the stand-in model reads the standard deal: one clear finding, one that is thin the first time, two gaps, one item that needs a minor document */
/** the asks to fix a reply of a given kind (the stand-in's unreadable picks are sent back to be fixed too) */
const fixesOf = (s: { fixCalls: Call[] }, field: string) => s.fixCalls.filter((c) => c.prompt.split('\n')[0].includes(`"${field}"`) || c.prompt.split('\n')[0].includes(`fields: ${field}`));
const usualFor = (id: string, c: Call): object | undefined => (
  id === 'b1' ? LOCKUP(c) : id === 'b2' ? OK(c)
  : id === 'b3' ? { result: 'more', need: 'insurance advisor report' }
  : id === 'b4' ? { result: 'finding', title: 'Deleted by a person before', workstream: 'Legal', body: ['A. [1] B. [2]'], sources: [{ doc: tag(c, IM), page: 2 }, { doc: tag(c, FA), page: 2 }] }
  : id === 'p1' ? (has(c, MINUTES) ? OK(c) : { result: 'more', need: 'board minutes on hedging' })
  : id === 's1' ? { result: 'more', need: 'interconnection permit' }
  : id === 's2' ? (c.model === 'thorough' ? SIZING(c) : { result: 'finding', title: 'Debt sizing', body: ['Cited nowhere that opens. [1] [2]'], sources: [{ doc: tag(c, MODEL), cell: 'B2' }, { doc: 'D99', page: 1 }] })
  : id === 's3' ? (c.model === 'thorough' ? { result: 'maybe' } : undefined) : undefined);
const usual = (c: Call) => itemReply(c, (id) => usualFor(id, c));
/** a finding a person deleted; `item` is the checklist item it was raised on, which is what a later check matches it by */
const tomb = (repo: Repository, id: string, title: string, item?: string) => repo.transaction({ writes: [{ kind: 'tombstone', id, data: { kind: 'finding', dealId: 'd1', id, title, snapshot: item ? { itemId: item } : {} }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'tombstone', id }] } });
const storedFindings = async (repo: Repository) => val(await repo.list('finding', 'd1')).map((l) => Finding.parse({ ...(l.envelope.data as object), rev: l.rev, dealId: 'd_01HZZZZZZZZZZZZZZZZ0000000' }));   // the tests' deal id is short; everything else must be exactly what the app reads

/** the same documents as indexing leaves them: no summary, only the words each uses most */
const bare = (d: DocRecord, ...words: string[]): DocRecord => { const { summary: _s, keywords: _k, ...rest } = d; return { ...rest, words }; };
const BARE = () => ({ d1: [bare(FA, 'lender', 'borrower', 'lock-up'), bare(TS, 'margin', 'tenor'), bare(IM, 'project', 'sponsor'), bare(MODEL, 'dscr', 'debt'), bare(SIDE, 'step-in', 'lender'), bare(MINUTES, 'hedging', 'board')] });

const memoWrite = (call: Call) => call.prompt.includes('Write up this risk on the deal');
const memoDeal = { ...scaleMemoInput.deal, name: 'Sample transaction', counterparty: '' };
const lockUp = {
  ...scaleMemoInput.findings.find(({ title }) => title.startsWith('Lock-up ratio'))!,
  body: ['The draft uses a 1.25x ratio. [1]'], sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }],
};
const testPeriod = {
  ...scaleMemoInput.findings.find(({ title }) => title.startsWith('Distribution test'))!,
  body: ['The draft uses a six-month period. [1]'], sources: [{ doc: TS.name, loc: 'p. 3', docId: TS.docId }],
};
const memoEvidence = new Map([lockUp, testPeriod].map((record) => [record.id, record]));
const memoFindings = scaleMemoInput.findings.map((record) => memoEvidence.get(record.id) ?? record);
const openMemoFindings = memoFindings.filter(({ status }) => status === 'open');
const closedFinding = memoFindings.find(({ status }) => status === 'closed')!;
const unratedFinding = openMemoFindings.at(-1)!;
const distributionRisk = {
  title: 'Distribution terms differ from the term sheet', findings: [lockUp.id, testPeriod.id],
};

async function setupMemoReplies(groups: unknown[], write: (call: Call, attempt: number) => unknown = () => ({})) {
  let writes = 0;
  const byId = new Map(openMemoFindings.slice(0, -1).map(({ id }) => [id, 'Low']));
  byId.set(lockUp.id, 'High');
  byId.delete(testPeriod.id);
  const standIn = setup((call) => {
    if (call.prompt.startsWith('Rate each of these open findings')) {
      const ids = [...call.prompt.matchAll(/^(f_\w+) \(/gm)].map((match) => match[1]);
      const ratings = ids.filter((id) => byId.has(id)).map((id) => ({ id, rating: byId.get(id) }));
      // The model omits this rating on the first pass and supplies it when asked again.
      if (ids.includes(testPeriod.id)) byId.set(testPeriod.id, 'Medium');
      return { ratings };
    }
    if (call.prompt.startsWith('These are the open findings on a deal, each with')) return { risks: groups };
    if (memoWrite(call)) return write(call, ++writes);
    return { paragraphs: ['The deal finances a solar project.'], sources: [] };
  }, { d1: [FA, TS] });
  await deal(standIn.repo, 'd1', memoDeal.name);
  for (const { id, title, workstream, status, body, sources } of memoFindings) {
    await finding(standIn.repo, id, title, { workstream, status, body, sources });
  }
  return standIn;
}

describe('deal memo model replies', () => {
  it('keeps valid risk groups beside malformed entries and leaves every open finding in exactly one risk', async () => {
    const offtake = openMemoFindings.find(({ title }) => title.startsWith('Offtake contract'))!;
    const merchant = openMemoFindings.find(({ title }) => title.startsWith('Merchant prices'))!;
    const offtakeRisk = { title: 'The base case overstates contracted output', findings: [offtake.id, merchant.id] };
    const standIn = await setupMemoReplies([
      { ...distributionRisk, findings: [...distributionRisk.findings, lockUp.id, closedFinding.id, 'f_unknown'] },
      null, 4, 'a risk', ['an array'], false, {},
      { ...offtakeRisk, findings: [lockUp.id, ...offtakeRisk.findings] },
    ]);
    const memo = val(await standIn.ai.memo!('d1'));
    expect(memo.ratings[lockUp.id]).toBe('High');
    expect(memo.ratings[testPeriod.id]).toBe('Medium');
    expect(memo.ratings[offtake.id]).toBe('Low');
    expect(memo.ratings[unratedFinding.id]).toBeUndefined();
    expect(memo.risks!.slice(0, 2)).toEqual([distributionRisk, offtakeRisk]);
    expect(memo.risks!.flatMap((risk) => risk.findings).sort()).toEqual(openMemoFindings.map(({ id }) => id).sort());
    expect(memo.risks!.slice(2)).toHaveLength(openMemoFindings.length - 4);
    expect(memo.risks!.slice(2).every(({ findings }) => findings.length === 1)).toBe(true);
  });

  it('uses one risk per open finding when none of the supplied groups is usable', async () => {
    const standIn = await setupMemoReplies([null, 4, ['an array'], { findings: [closedFinding.id, 'f_unknown'] }]);
    const memo = val(await standIn.ai.memo!('d1'));
    expect(memo.risks).toEqual(openMemoFindings.map(({ id, title }) => ({ title, findings: [id] })));
  });

  const creditWords = 'The credit agreement sets the distribution lock-up ratio at 1.25x for six months.';
  const termWords = 'The signed term sheet sets the distribution lock-up ratio at 1.30x for twelve months.';
  const overlong = [
    { name: 'three paragraphs', paragraphs: [`${creditWords} [1]`, `${termWords} [2]`, 'The ratios differ. [1]'] },
    {
      name: '201 words in two paragraphs',
      paragraphs: [`${'covenant '.repeat(99)}threshold. [1]`, `${'distribution '.repeat(100)}test. [2]`],
    },
    { name: 'one 100,000-character token', paragraphs: ['', '  ', `${'x'.repeat(100_000)} [1]`] },
    { name: '202 words separated by citation markers', paragraphs: ['Ratio.[1]Term '.repeat(101)] },
    {
      name: 'oversized text joined when invalid citations are removed',
      paragraphs: [`${Array(15).fill('x'.repeat(200)).join(' [999]')} The draft sets the ratio. [1]`],
    },
    {
      name: 'oversized text joined when export drops control characters',
      paragraphs: [`${Array(15).fill('x'.repeat(199)).join('\u000b')} The draft sets the ratio. [1]`],
    },
    {
      name: 'oversized text containing zero-width separators',
      paragraphs: [`${Array(15).fill('x'.repeat(199)).join('\ufeff')} The draft sets the ratio. [1]`],
    },
    {
      name: '201 words after removing a finding ID',
      paragraphs: [`${'covenant '.repeat(199)}${lockUp.id}. [1]`],
    },
    {
      name: 'three paragraphs in a single string',
      paragraphs: [`${creditWords} [1]\r\n\r\n${termWords} [2]\n \nThe ratios differ. [1]`],
    },
    {
      name: 'three paragraphs separated by NULs',
      paragraphs: [`${creditWords} [1]\0${termWords} [2]\0The ratios differ.`],
    },
  ];
  const citedRiskReply = (call: Call, paragraphs: string[]) => ({
    paragraphs, sources: [{ doc: tag(call, FA), page: 14 }, { doc: tag(call, TS), page: 3 }],
  });

  it.each(overlong)('retries and escalates a deal memo key risk write-up with $name', async ({ paragraphs }) => {
    const valid = [`${creditWords} [1]`, `${termWords} [2]`];
    const standIn = await setupMemoReplies([distributionRisk], (call, attempt) => {
      if (call.prompt.length > 100_000) throw Object.assign(new Error('Request too long'), { code: 'toolong' });
      return citedRiskReply(call, attempt <= 2 ? paragraphs : ['', valid[0], '  ', valid[1]]);
    });
    const memo = val(await standIn.ai.memo!('d1'));
    const writes = standIn.calls.filter(memoWrite);
    expect(writes.map(({ model }) => model)).toEqual(['standard', 'standard', 'thorough']);
    expect(writes[1].prompt).toContain('200 words');
    expect(writes[1].prompt).toContain('That cannot be used:');
    expect(memo.risks![0]).toEqual({
      ...distributionRisk, body: valid, sources: [...lockUp.sources, ...testPeriod.sources],
    });
  });

  it('accepts a deal memo key risk write-up of exactly 200 words with two cited paragraphs', async () => {
    const body = [`${'covenant '.repeat(99)}threshold. [1]`, `${'distribution '.repeat(99)}test. [2]`];
    const standIn = await setupMemoReplies([distributionRisk], (call) => citedRiskReply(call, body));
    const memo = val(await standIn.ai.memo!('d1'));
    expect(standIn.calls.filter(memoWrite).map(({ model }) => model)).toEqual(['standard']);
    expect(memo.risks![0]).toEqual({
      ...distributionRisk, body, sources: [...lockUp.sources, ...testPeriod.sources],
    });
  });

  it('retries an overlong deal memo write-up when Standard and Thorough share a model', async () => {
    const valid = [`${creditWords} [1]`, `${termWords} [2]`];
    const standIn = await setupMemoReplies([distributionRisk], (call, attempt) =>
      citedRiskReply(call, attempt < 3 ? overlong[0].paragraphs : valid));
    standIn.svc.offered.thorough = standIn.svc.offered.standard;
    const memo = val(await standIn.ai.memo!('d1'));
    const writes = standIn.calls.filter(memoWrite);
    expect(writes.map((call) => call.model)).toEqual(['standard', 'standard', 'standard']);
    expect(writes[1].prompt).toContain('That cannot be used:');
    expect(memo.risks![0]).toEqual({
      ...distributionRisk, body: valid, sources: [...lockUp.sources, ...testPeriod.sources],
    });
  });

  it('escalates the original deal memo request if the correction is too long for Standard', async () => {
    const valid = [`${creditWords} [1]`, `${termWords} [2]`];
    const standIn = await setupMemoReplies([distributionRisk], (call) => {
      if (call.prompt.includes('That cannot be used:')) {
        throw Object.assign(new Error('Request too long'), { code: 'toolong' });
      }
      return citedRiskReply(call, call.model === 'thorough' ? valid : overlong[0].paragraphs);
    });
    const memo = val(await standIn.ai.memo!('d1'));
    const writes = standIn.calls.filter(memoWrite);
    expect(writes.map((call) => call.model)).toEqual(['standard', 'standard', 'thorough']);
    expect(writes[2].prompt).toBe(writes[0].prompt);
    expect(writes[2].files).toEqual(writes[0].files);
    expect(memo.risks![0]).toEqual({
      ...distributionRisk, body: valid, sources: [...lockUp.sources, ...testPeriod.sources],
    });
  });

  it('uses the findings’ own cited words after every key risk write-up exceeds the limits', async () => {
    const standIn = await setupMemoReplies([distributionRisk], (call, attempt) =>
      citedRiskReply(call, overlong[attempt - 1].paragraphs));
    const memo = val(await standIn.ai.memo!('d1'));
    expect(standIn.calls.filter(memoWrite).map(({ model }) => model)).toEqual(['standard', 'standard', 'thorough']);
    expect(memo.risks![0]).toEqual(distributionRisk);
    const content = memoContent({
      ...scaleMemoInput, deal: memoDeal, findings: memoFindings,
      groups: memo.risks, ratings: memo.ratings, summary: memo.summary,
    });
    expect(content.risks[0].paras).toEqual([
      [{ text: 'The draft uses a 1.25x ratio.', refs: [1] }],
      [{ text: 'The draft uses a six-month period.', refs: [2] }],
    ]);
    expect(content.refs.slice(0, 2)).toEqual(['Credit Agreement, p. 14', 'Term sheet (signed), p. 3']);
  });
});

describe('what a document is', () => {
  it('nothing is described at indexing: the core documents are described once they are chosen, by the fast model from the document itself, and no other until it is read', async () => {
    const s = setup(() => ({ text: 'ok', sources: [] }), BARE(), { describes: true });
    val(await s.ai.answer(ask('What is the lock-up ratio?'))); await s.ai.described('d1');
    // core was worked out from paths and most-used words alone, with no model
    expect(s.coreCalls.length).toBe(0);
    expect(s.describeCalls.map((c) => [c.model, sentNames(c)]).sort()).toEqual([['fast', ['Credit Agreement.pdf']], ['fast', ['Information memorandum.pdf']], ['fast', ['Model v12.xlsx']], ['fast', ['Term sheet (signed).pdf']]]);
    const by = (n: string) => s.recs.d1.find((r) => r.name === n)!;
    expect(by('Credit Agreement.pdf')).toMatchObject({ summary: 'This is Credit Agreement.pdf.', keywords: ['described'], words: ['lender', 'borrower', 'lock-up'] }); expect(by('Side letter.pdf').summary).toBeUndefined(); expect(by('Board minutes March.pdf').summary).toBeUndefined();
    expect(s.svc.uploads).toBe(4);                                                                                                         // the side letter and the minutes were never sent anywhere
    // asked again, nothing is described twice; and the listing now shows the description
    val(await s.ai.answer(ask('And the margin?'))); await s.ai.described('d1'); expect(s.describeCalls.length).toBe(4);   // describing a document does not change which are core
    // a draft's pick lists them
    await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'And the margin?' });
    expect(s.pickCalls.at(-1)!.prompt).toContain('vdr/Credit Agreement.pdf — This is Credit Agreement.pdf.'); expect(s.pickCalls.at(-1)!.prompt).toContain('vdr/Side letter.pdf — words: step-in, lender');
    // a document outside the core is described the first time a call reads it
    const t = setup(() => ({ text: 'ok', sources: [] }), BARE(), { describes: true });
    val(await t.ai.answer(ask('Who has step-in rights?'))); await t.ai.described('d1');
    expect(t.describeCalls.map((c) => sentNames(c)[0]).sort()).toEqual(['Credit Agreement.pdf', 'Information memorandum.pdf', 'Model v12.xlsx', 'Side letter.pdf', 'Term sheet (signed).pdf']); expect(t.recs.d1.find((r) => r.name === 'Side letter.pdf')!.summary).toBe('This is Side letter.pdf.');
    // without somewhere to keep a description, none is asked for
    const off = setup(() => ({ text: 'ok', sources: [] }), BARE()); val(await off.ai.answer(ask('What is the lock-up ratio?'))); await off.ai.described('d1'); expect(off.describeCalls.length).toBe(0);
  });

  it('a search by words finds a document by the words it uses most, described or not', async () => {
    const s = setup(() => ({ text: 'ok', sources: [] }), BARE(), { library: [] });                                           // no core, no pick: the ranking alone
    val(await s.ai.answer(ask('What does the board say about hedging?'))); expect(sentNames(s.calls[0])).toEqual(['Board minutes March.pdf']);
    val(await s.ai.answer(ask('Who is the sponsor?'))); expect(sentNames(s.calls[1])).toEqual(['Information memorandum.pdf']);
  });

  it('a description is read loosely and capped; when the service cannot be reached, nothing is kept and the next read asks again', async () => {
    const bareTwo = { d1: [bare(FA, 'lender'), bare(SIDE, 'step-in')] };
    const s = setup(() => ({ text: 'ok', sources: [] }), bareTwo, { describes: true,
      describe: () => ({ summary: ' A senior credit agreement. ', keywords: ['lock-up', ' covenant ', 7, '', ...Array.from({ length: 40 }, (_, i) => `k${i}`)], type: 'Credit agreement' }) });
    val(await s.ai.answer(ask('Lender step-in?'))); await s.ai.described('d1');
    const fa = s.recs.d1.find((r) => r.name === FA.name)!; expect(fa.summary).toBe('A senior credit agreement.'); expect(fa.keywords!.slice(0, 3)).toEqual(['lock-up', 'covenant', 'k0']); expect(fa.keywords!.length).toBe(30);
    expect(s.describeCalls[0].prompt).toContain('Include the other words people use for the same things');
    // the service down while describing: nothing is kept, no try is counted against the document, the answer is not held up, and the next read asks again
    let down = true;
    const describe = () => {
      if (down) throw Object.assign(new Error('offline'), { code: 'unreachable' });
      return { summary: 'Back.', keywords: [] };
    };
    const u = setup(() => ({ text: 'ok', sources: [] }), { d1: [bare(FA, 'lender')] }, { describes: true, describe });
    val(await u.ai.answer(ask('Lender?')));
    await u.ai.described('d1');
    expect(u.recs.d1[0].summary).toBeUndefined();
    expect(u.recs.d1[0].undescribed).toBeUndefined();
    // asked when it was chosen as core, and again when the answer read it unless that ask was still under way
    const asked = u.describeCalls.length;
    expect(asked).toBeGreaterThan(0);
    down = false;
    val(await u.ai.answer(ask('Lender?')));
    await u.ai.described('d1');
    expect(u.recs.d1[0].summary).toBe('Back.');
    expect(u.describeCalls.length).toBe(asked + 1);
  });

  it('a document the model cannot describe is tried three times, each after a longer rest, and then left alone for good, on every PC', async () => {
    let now = Date.UTC(2026, 10, 10, 9); const tick = () => new Date(now++).toISOString(); const MIN = 60_000;
    const recs = { d1: [bare(FA, 'lender'), bare(SIDE, 'step-in')] };
    const opts = { describes: true as const, clock: tick, pick: (c: Call) => ({ read: numbersOf(c, FA, SIDE) }), describe: (c: Call) => (/Side letter/.test(c.prompt) ? 'no' : { summary: 'A credit agreement.', keywords: [] }) };
    const s = setup(() => ({ text: 'ok', sources: [] }), recs, opts); const side = () => recs.d1.find((r) => r.name === SIDE.name)!; const sideAsks = (x: { describeCalls: Call[] }) => x.describeCalls.filter((c) => /Side letter/.test(c.prompt)).length;
    const read = async (x: typeof s) => { val(await x.ai.answer(ask('Lender step-in?'))); await x.ai.described('d1'); };
    await read(s); expect(sideAsks(s)).toBe(1); expect(s.fixCalls.length).toBe(1); expect(side()).toMatchObject({ undescribed: { tries: 1 } }); expect(side().summary).toBeUndefined();   // "no" was sent back once to be put right, and was not
    await read(s); now += 59_000; await read(s); expect(sideAsks(s)).toBe(1);                                                    // read again within the minute: not asked
    now += 2_000; await read(s); expect(sideAsks(s)).toBe(2); expect(side().undescribed!.tries).toBe(2);                         // a minute on: the second try
    now += 4 * MIN; await read(s); expect(sideAsks(s)).toBe(2);                                                                  // the rest is longer now: five minutes
    // another PC on the deal sees the same count: it does not start again from nothing, and the third try is the last anywhere
    const home = setup(() => ({ text: 'ok', sources: [] }), recs, opts); await read(home); expect(sideAsks(home)).toBe(0);
    now += MIN; await read(home); expect(sideAsks(home)).toBe(1); expect(side().undescribed!.tries).toBe(3);
    now += 24 * 60 * MIN; await read(home); await read(s); expect(sideAsks(home) + sideAsks(s)).toBe(3);                         // a day later, on either PC: left alone
    expect(recs.d1.find((r) => r.name === FA.name)!).toMatchObject({ summary: 'A credit agreement.' }); expect(recs.d1.find((r) => r.name === FA.name)!.undescribed).toBeUndefined();
    // with nowhere shared to count them, the tries are counted for this run of the app, by the same rule
    now = Date.UTC(2026, 10, 11, 9); const lone = setup(() => ({ text: 'ok', sources: [] }), { d1: [bare(SIDE, 'step-in')] }, { ...opts, describes: 'here', library: [], pick: (c: Call) => ({ read: numbersOf(c, SIDE) }) });
    await read(lone); await read(lone); expect(sideAsks(lone)).toBe(1); now += MIN; await read(lone); expect(sideAsks(lone)).toBe(2); now += 5 * MIN; await read(lone); expect(sideAsks(lone)).toBe(3); now += 60 * MIN; await read(lone); expect(sideAsks(lone)).toBe(3);
    // a document that cannot be sent at all is a failed try too, and costs no call
    const lost = { d1: [bare(SIDE, 'step-in')] }; const gone = setup(() => ({ text: 'ok', sources: [] }), lost, { ...opts, library: [['side letter', 'letter agreement']] });   // the side letter is core here
    gone.svc.upload = async () => { throw new Error('too large'); }; await gone.ai.answer(ask('Lender step-in?')); await gone.ai.described('d1'); expect(gone.describeCalls.length).toBe(0); expect(lost.d1[0].undescribed).toMatchObject({ tries: 1 });
  });

  it('every call is counted by what it was for and which model took it, and each run reports its own', async () => {
    // the search helper's first answer cannot be read: it is sent back once
    const fix = () => ({ text: 'ok', sources: [] });
    const reply = (_c: Call, n: number) => (n === 1 ? 'not json at all' : { text: 'ok', sources: [] });
    const s = setup(reply, BARE(), { describes: true, fix });
    val(await s.ai.answer(ask('What is the lock-up ratio?'))); await s.ai.described('d1');
    const line = (e: UsageEntry) => e.calls.map((l) => `${l.kind}/${l.model} ×${l.calls} docs ${l.docs}`).sort();
    const run = (name: string, nth = 0) => s.usage.filter((e) => e.run === name)[nth];
    expect(s.usage.map((e) => [e.run, e.dealId]).sort()).toEqual([['answer', 'd1'], ['describe', 'd1']]); expect(run('answer').at).toMatch(/^2026-11-10T/);
    // the search helper reads the documents on the fast model; the main session's turn, on the person's model, has none
    expect(line(run('answer')))
      .toEqual(['answer/thorough ×1 docs 0', 'fix/fast ×1 docs 0', 'search/fast ×1 docs 2']);
    expect(line(run('describe'))).toEqual(['describe/fast ×4 docs 4']);
    const search = run('answer').calls.find((l) => l.kind === 'search')!; expect(search.sent).toBe(s.calls[0].prompt.length); expect(search.received).toBe('not json at all'.length);
    const turn = run('answer').calls.find((l) => l.kind === 'answer')!; expect(turn.sent).toBe(s.turns[0].prompt.length);
    // the same run, again
    val(await s.ai.answer(ask('And the margin?')));
    expect(line(run('answer', 1))).toEqual(['answer/thorough ×1 docs 0', 'search/fast ×1 docs 1']);
    // and the whole, since the app started
    expect(s.ai.usage().map((l) => `${l.kind}/${l.model} ×${l.calls}`).sort())
      .toEqual(['answer/thorough ×2', 'describe/fast ×4', 'fix/fast ×1', 'search/fast ×2']);
    val(await s.ai.gaps('d1')); expect(s.usage.length).toBe(3);                                                                              // a run that asks no model reports nothing
  });
});

describe('the first pass', () => {
  it('the first pass checks the documents against the three layers of the checklist: a finding with its sources, a gap where there is no document, nothing for what is satisfied', async () => {
    const asked: unknown[] = []; const s = setup(usual, undefined, { checklist: (d) => { asked.push(d); return LIST; } });
    val(await s.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Project Proseware', product: 'Construction loan', sector: 'Onshore wind' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } })); val(await tomb(s.repo, 'f_gone', 'deleted by a person before', 'b4'));
    const r = val(await s.ai.firstPass('d1'));
    expect(asked).toEqual([{ id: 'd1', name: 'Project Proseware', product: 'Construction loan', sector: 'Onshore wind' }]);                                                             // the checklist is chosen outside: it is given the deal
    // one list, broad then product then sector; an item worded like an earlier one, or with an id already used, or with no id or no words, is not checked
    expect(itemsIn(s.calls[0]).map((it) => idOf(it.text))).toEqual(['b1', 'b2', 'b3', 'b4', 'p1', 's1', 's2', 's3']);
    expect(s.calls.map((c) => [c.model, itemsIn(c).map((it) => idOf(it.text)).join()])).toEqual([['standard', 'b1,b2,b3,b4,p1,s1,s2,s3'], ['standard', 's2,s3'], ['thorough', 's2,s3'], ['standard', 'p1']]);   // what the standard model did not settle goes to it again, and only then to the thorough one
    expect(sentNames(s.calls[0])).toEqual(['Credit Agreement.pdf', 'Information memorandum.pdf', 'Model v12.xlsx', 'Term sheet (signed).pdf']);      // the core documents first
    expect(sentNames(s.calls[2])).toEqual(sentNames(s.calls[0])); expect(sentNames(s.calls[3])).toEqual(['Board minutes March.pdf']);
    // the second turn is not a blind rerun: each item goes back with what was wrong with it and what was sent
    expect(s.calls[1].prompt).toContain('This is a second look. Your first replies on these items could not be used. Put each right:\nI1: As a finding it needs at least one citation naming a document you were given, by its D number, and a page that document has (or a sheet and cell for a spreadsheet), and none of yours do. You sent: {"id":"I7","result":"finding","title":"Debt sizing"');
    expect(s.calls[1].prompt).toContain('\nI2: It was missing from your reply.'); expect(sentNames(s.calls[1])).toEqual(sentNames(s.calls[0])); expect(s.calls[2].prompt).not.toContain('second look'); expect(s.trace).toEqual([{ dealId: 'd1', reason: 'Derivatives have been signed off by the directors: board minutes on hedging', docs: [MINUTES.docId] }]);   // a minor document is read when an item needs it
    expect(s.calls[0].prompt).toContain(`one of ${WORKSTREAMS.join(' | ')}, or "" when unsure`); expect(s.calls[0].prompt).toContain('HR & benefits');   // the firm's list, from the control file
    // what it leaves
    const stored = await storedFindings(s.repo);
    // findings have no code
    expect(stored.map((f) => [f.title, f.status, f.origin, f.reviewed, f.sources.length, 'code' in f])).toEqual([['Lock-up ratio differs between the credit agreement and the term sheet', 'open', 'ai', null, 2, false], ['Debt sizing in the model departs from the term sheet', 'open', 'ai', null, 2, false]]);
    expect(stored[0].body).toEqual(['The draft sets it at 1.25x. [1]', 'The term sheet has 1.30x. [2]']); expect(stored[0].sources[1]).toEqual({ doc: TS.name, loc: 'p. 3', docId: TS.docId }); expect(stored[0].id).toMatch(/^f_[0-9A-Z]{26}$/);
    expect(stored[1].sources).toEqual([{ doc: MODEL.name, loc: 'Debt!B2', docId: MODEL.docId }, { doc: TS.name, loc: 'p. 4', docId: TS.docId }]);
    expect(r.written).toEqual(stored.map((f) => f.id)); expect(s.announced).toEqual(r.written);
    expect(r.gaps).toEqual([{ title: 'An insurance advisor report covers the construction period' }, { title: 'The interconnection permit is in place' }]);   // no document in the data room answers to what each would need
    expect(r.unsettled).toEqual(['s3']);                                                                                                               // neither model gave a usable reply: not a finding, not a gap
    const before = s.calls.length; expect(val(await s.ai.gaps('d1'))).toEqual(r.gaps); expect(s.calls.length).toBe(before);                              // gaps cost no call
  });

  it('an item is not closed on a report of other documents: the model asks for them, and they are found by their folder as well as their name', async () => {
    const P1 = doc(11, 'ENV-2024-0043.pdf', { rel: '05 Permits/ENV-2024-0043.pdf', pages: 6 }), P2 = doc(12, 'Scan 7.pdf', { rel: '05 Permits/Scan 7.pdf', pages: 3 }), LUNCH = doc(13, 'Lunch menu.pdf', { rel: '09 Misc/Lunch menu.pdf' }), OFFER = doc(14, 'Interconnection facilities study.pdf', { pages: 9 });
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(/network/.test(it.text) ? { result: 'more', need: 'interconnection facilities study' } : has(c, P1) ? { result: 'finding', title: 'The environmental permit carries a noise condition', workstream: 'Environmental & social', body: ['Condition 4 limits night-time operation. [1] The scan repeats it. [2]'], next: 'Ask the technical advisor.', sources: [{ doc: tag(c, P1), page: 4 }, { doc: tag(c, P2), page: 1 }] } : { result: 'more', need: 'the permits themselves' }) })) }),
      { d1: [FA, TS, IM, MODEL, P1, P2, LUNCH, OFFER] }, { checklist: () => ({ broad: [{ id: 'x1', text: 'Every consent is in place and unconditional' }, { id: 'x2', text: 'The link to the network is contracted' }], product: [], sector: [] }) }); await deal(s.repo);
    const r = val(await s.ai.firstPass('d1'));
    expect(s.calls[0].prompt).toContain('or they only report what other documents say (a report that says the permits are in place is not the permits)');
    expect(s.calls.length).toBe(2); expect(sentNames(s.calls[0])).not.toContain('ENV-2024-0043.pdf'); expect(sentNames(s.calls[1])).toEqual(['ENV-2024-0043.pdf', 'Interconnection facilities study.pdf', 'Scan 7.pdf']); expect(s.calls[1].prompt).toContain('vdr/05 Permits/ENV-2024-0043.pdf (6 pages)');   // judged against what is relevant to it, not the whole room
    expect(s.trace).toEqual([{ dealId: 'd1', reason: 'Every consent is in place and unconditional: the permits themselves', docs: [P1.docId, P2.docId] }, { dealId: 'd1', reason: 'The link to the network is contracted: interconnection facilities study', docs: [OFFER.docId] }]);
    expect(r.written.length).toBe(1); expect((await storedFindings(s.repo))[0].sources.map((x) => [x.doc, x.loc])).toEqual([['ENV-2024-0043.pdf', 'p. 4'], ['Scan 7.pdf', 'p. 1']]); expect(r.gaps).toEqual([{ title: 'The link to the network is contracted' }]);                // the offer was read and does not settle it: there is no document behind the item
  });

  it('an item a blackline alone supports is never settled; with its clean draft cited too, it is', async () => {
    const BL = doc(74, 'Credit Agreement (blackline).pdf', { pages: 30, summary: 'The lock-up ratio agreed, as changed.' }); const one = { broad: [{ id: 'k1', text: 'The lock-up ratio is agreed' }], product: [], sector: [] };
    const run = async (cite: (c: Call) => object[]) => { const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(c.prompt.includes('Add "where"') ? { result: 'ok', where: cite(c) } : { result: 'ok' }) })) }), { d1: [FA, BL] }, { checklist: () => one }); await deal(s.repo); return { r: val(await s.ai.firstPass('d1')), s }; };
    const only = await run((c) => [{ doc: tag(c, BL), page: 2 }]);
    expect(only.s.calls.every((c) => sentNames(c).includes(BL.name) && sentNames(c).includes(FA.name))).toBe(true); expect(only.r).toEqual({ written: [], gaps: [{ title: 'The lock-up ratio is agreed' }], unsettled: [], marked: [] });
    const both = await run((c) => [{ doc: tag(c, BL), page: 2 }, { doc: tag(c, FA), page: 14 }]);
    expect(both.r).toEqual({ written: [], gaps: [], unsettled: [], marked: [] });
  });
  it('another project’s document never settles an item or raises a finding by itself; ' +
    'beside one of this deal’s own it may', async () => {
    const PRE = doc(81, 'Coho Credit Agreement.pdf', { rel: '12. Precedents/Coho Credit Agreement.pdf', pages: 40, summary: 'The lock-up ratio agreed on another project.' }); const one = { broad: [{ id: 'k1', text: 'The lock-up ratio is agreed' }], product: [], sector: [] };
    const run = async (answer: (c: Call) => object) => { const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...answer(c) })) }), { d1: [FA, PRE] }, { checklist: () => one }); await deal(s.repo); return { r: val(await s.ai.firstPass('d1')), s }; };
    const ok = (cite: (c: Call) => object[]) => (c: Call) => (c.prompt.includes('Add "where"') ? { result: 'ok', where: cite(c) } : { result: 'ok' });
    const only = await run(ok((c) => [{ doc: tag(c, PRE), page: 2 }]));
    expect(only.r).toEqual({ written: [], gaps: [{ title: 'The lock-up ratio is agreed' }], unsettled: [], marked: [] });
    expect(only.s.calls[0].prompt).toMatch(/D\d+ is another project's document, not this deal's\. Its terms are never this deal's/);
    expect((await run(ok((c) => [{ doc: tag(c, PRE), page: 2 }, { doc: tag(c, FA), page: 14 }]))).r).toEqual({ written: [], gaps: [], unsettled: [], marked: [] });
    const finding = (cite: (c: Call) => object[]) => (c: Call) => ({ result: 'finding', title: 'Lock-up ratio is below market', workstream: 'Legal', body: ['It is 1.10x. [1]'], sources: cite(c) });
    expect((await run(finding((c) => [{ doc: tag(c, PRE), page: 2 }]))).r.written).toEqual([]);
    expect((await run(finding((c) => [{ doc: tag(c, PRE), page: 2 }, { doc: tag(c, FA), page: 14 }]))).r.written.length).toBe(1);
  });
  it('tells this deal’s own blackline from one against another project, and keeps today’s rules for its own', async () => {
    const V3 = doc(82, 'SPA v3.pdf'), V2 = doc(83, 'SPA v2.pdf'), OWN = doc(84, 'SPA v3 Redline to SPA v2.pdf', { pages: 30 });
    const LT = doc(85, 'LTSA.pdf'), BETA = doc(86, 'Coho LTSA.pdf', { rel: 'Precedents/Coho LTSA.pdf' }), OTHER = doc(87, 'LTSA Redline to Coho LTSA.pdf', { pages: 30 });
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [V3, V2, OWN, LT, BETA, OTHER] }, { library: [], turn: (c) => ({ text: 'Caps moved. [1] [2]', sources: [{ doc: tag(c, OWN), page: 3 }, { doc: tag(c, BETA), page: 4 }] }) });
    const r = val(await s.ai.answer(ask('What changed?', { attachments: [{ doc: OWN.name, docId: OWN.docId }, { doc: OTHER.name, docId: OTHER.docId }, { doc: BETA.name, docId: BETA.docId }] })));
    const p = s.turns[0].prompt; const [own, other] = [tag(s.turns[0], OWN), tag(s.turns[0], OTHER)];
    expect(p).toContain(`${own} is a blackline: a comparison of two drafts with the changes marked`); expect(p).not.toContain(`${own} compares`);
    expect(p).toContain(`${other} compares this deal's draft with another project's document. Its deleted wording is the other project's`);
    expect(r.sources.map((x) => [x.doc, x.reading, x.precedent])).toEqual([[OWN.name, true, undefined], [BETA.name, undefined, true]]);   // the chat still answers from them, tagged
  });
  it('more than two sources that are never a main one wait behind this deal’s own documents in a ranking', async () => {
    const pres = [1, 2, 3, 4].map((n) => doc(90 + n, `Coho Lock-up Memo ${n}.pdf`, { rel: `Precedents/Coho Lock-up Memo ${n}.pdf`, summary: 'Lock-up lock-up lock-up ratio.' }));
    const s = setup(() => ({ text: 'ok', sources: [] }), { d1: [...pres, FA] }, { library: [], width: 3, pick: () => null });
    val(await s.ai.answer(ask('What is the lock-up ratio?'))); expect(sentNames(s.calls[0])).toEqual([FA.name, pres[0].name, pres[1].name].sort());
  });
  it('twenty items are checked in a call unless set otherwise', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, text: `Lock-up point ${i}` }));
    const asked: unknown[] = []; const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), undefined, { checklist: (d) => { asked.push(d); return { broad: many, product: [], sector: [] }; } }); await deal(s.repo);
    expect(val(await s.ai.firstPass('d1'))).toEqual({ written: [], gaps: [], unsettled: [], marked: [] }); expect(s.calls.map((c) => itemsIn(c).length)).toEqual([20, 20, 5]);
    expect(asked).toEqual([{ id: 'd1', name: 'Project Proseware', product: '', sector: '' }]);                                                        // a deal with no product or sector set says so, as empty words
  });

  it('no call is given more than a handful of documents, and items share a second look as long as their documents fit in one: when they need more between them, that is more calls', async () => {
    const minor = ['Datum', 'Coho', 'Lamna', 'Trey'].flatMap((f, i) => [doc(50 + i * 2, `Scan ${i * 2 + 1}.pdf`, { rel: `${f}/Scan ${i * 2 + 1}.pdf` }), doc(51 + i * 2, `Scan ${i * 2 + 2}.pdf`, { rel: `${f}/Scan ${i * 2 + 2}.pdf` })]);
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(c.files.some((f) => /Scan/.test(f.name)) ? OK(c) : { result: 'more', need: `the ${{ First: 'datum', Second: 'coho', Third: 'lamna', Fourth: 'trey' }[it.text.split(' ')[0]]} schedule` }) })) }),
      { d1: [FA, TS, IM, MODEL, ...minor] }, { width: 3, checklist: () => ({ broad: [{ id: 'a', text: 'First point' }, { id: 'b', text: 'Second point' }, { id: 'c', text: 'Third point' }, { id: 'd', text: 'Fourth point' }], product: [], sector: [] }) }); await deal(s.repo);
    expect(val(await s.ai.firstPass('d1'))).toEqual({ written: [], gaps: [], unsettled: [], marked: [] });
    // the fast model could not say (the stand-in cannot), so each item brought the best match for what it needs: one document each here, three to a call
    expect(s.calls.map((c) => sentNames(c).join())).toEqual(['Credit Agreement.pdf,Information memorandum.pdf,Model v12.xlsx', 'Scan 1.pdf,Scan 3.pdf,Scan 5.pdf', 'Scan 7.pdf']);   // no item names a document, so the library's core documents stand in
    expect(s.calls.slice(1).map((c) => itemsIn(c).map((it) => it.text).join())).toEqual(['First point,Second point,Third point', 'Fourth point']);
    expect(s.pickForCalls.length).toBe(1);                                                                                                          // one question for the four of them, not four
  });

  it('on a data room nothing has described, the first pass has the core documents described before it chooses what to read, and what the run cost is reported as one run', async () => {
    let core = 0; const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), BARE(), { describes: true, checklist: () => ({ broad: [LIST.broad[0]], product: [], sector: [] }),
      describe: (c) => { core++; return { summary: `This is ${/Describe the document (.*)\.\n/.exec(c.prompt)![1]}.`, keywords: [] }; }, pick: (c) => ({ read: numbersOf(c, FA, TS) }) }); await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    expect(core).toBe(2); expect(s.pickCalls[0].prompt).toContain('*: vdr/Credit Agreement.pdf — This is Credit Agreement.pdf.'); expect(s.pickCalls[0].prompt).toContain(': vdr/Side letter.pdf — words: step-in, lender');   // the descriptions were in before the pick
    expect(s.svc.uploads).toBe(2);                                                                                                                     // the core documents (the item names the credit agreement and the term sheet); nothing else left this PC
    expect(s.usage.map((e) => e.run).sort()).toEqual(['describe', 'firstPass']);
    expect(s.usage.find((e) => e.run === 'firstPass')!.calls.map((l) => `${l.kind}/${l.model} ×${l.calls} docs ${l.docs}`).sort()).toEqual(['check/standard ×1 docs 2', 'pick/fast ×1 docs 0', 'query/fast ×1 docs 0']);   // the search was asked for; the stand-in could not say, so the pick went as before
    expect(s.usage.find((e) => e.run === 'describe')!.calls.map((l) => `${l.kind}/${l.model} ×${l.calls} docs ${l.docs}`)).toEqual(['describe/fast ×2 docs 2']);
  });

  it('in the first pass the fast model picks what each group of items is checked against, and an item it finds nothing for is a gap', async () => {
    const PERMIT = doc(11, 'ENV-2024-0043.pdf', { rel: '05 Permits/ENV-2024-0043.pdf', pages: 6, summary: 'Environmental permit.' });
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(/lock-up/.test(it.text) ? LOCKUP(c) : has(c, PERMIT) ? OK(c) : { result: 'more', need: /consent/.test(it.text) ? 'the permits themselves' : 'a decommissioning plan' }) })) }),
      { d1: [FA, TS, IM, MODEL, SIDE, PERMIT, doc(15, 'Notes.pdf', { summary: 'What is needed to settle and read.' })] }, { checklist: () => ({ broad: [LIST.broad[0], { id: 'x1', text: 'Every consent is in place and unconditional' }, LIST.sector[2]], product: [], sector: [] }),
        pick: (c) => ({ read: numbersOf(c, FA, TS) }), pickFor: (c) => ({ read: { I1: numbersOf(c, PERMIT), I2: [], I9: [1] } }) }); await deal(s.repo);
    const r = val(await s.ai.firstPass('d1'));
    expect(s.pickCalls.length).toBe(1); expect(s.pickForCalls.length).toBe(1); expect(s.pickCalls[0].prompt).toContain('Which of them should be read for this?\nThe lock-up ratio is the same in the credit agreement and the term sheet\nEvery consent is in place and unconditional\nDecommissioning is provided for');
    // the items that need more are put to the fast model together, each with what it needs; it answers for each, from what has not been read yet
    expect(s.pickForCalls[0].prompt).toContain('Which of them should be read for each of these?\nI1: Every consent is in place and unconditional Still needed: the permits themselves\nI2: Decommissioning is provided for Still needed: a decommissioning plan\n'); expect(s.pickForCalls[0].model).toBe('fast');
    expect(s.pickForCalls[0].prompt).not.toContain('Credit Agreement.pdf'); expect(s.pickForCalls[0].prompt).toContain('\n1: vdr/05 Permits/ENV-2024-0043.pdf');   // ranked by the items and what they need, not by the words of the instruction around them
    expect(s.calls.map((c) => [itemsIn(c).length, sentNames(c).join()])).toEqual([[3, 'Credit Agreement.pdf,Term sheet (signed).pdf'], [1, 'ENV-2024-0043.pdf']]);
    expect(r.written.length).toBe(1); expect(r.gaps).toEqual([{ title: 'Decommissioning is provided for' }]); expect(r.unsettled).toEqual([]);
  });

  it('what a check leaves as a gap goes to the chat agent\'s own search, a few items at a time; the documents its answer cites are read against them, and settle them', async () => {
    const PLAN = doc(16, 'DEC-77.pdf',
      { rel: '09 Misc/DEC-77.pdf', pages: 3, summary: 'Decommissioning plan for the site.' });
    const DECOM = { id: 'x1', text: 'Decommissioning is provided for' };
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(has(c, PLAN) ? OK(c) : { result: 'more', need: 'a decommissioning plan' }) })) }), { d1: [FA, TS, PLAN] }, { checklist: () => ({ broad: [DECOM], product: [], sector: [] }),
      pick: (c) => ({ read: numbersOf(c, FA) }), pickFor: () => ({ read: { I1: [] } }),
      // the agent's search finds the plan by its words, its helper reads it, and the agent's answer cites it
      fill: (c) => (isTurn(c)
        ? { text: 'DEC-77 is the decommissioning plan. [1]', sources: [{ doc: tag(c, PLAN), page: 1 }] }
        : { text: 'It is the plan. [1]', sources: [{ doc: tag(c, PLAN), page: 1, quote: 'The plan' }] }) });
    await deal(s.repo);
    const r = val(await s.ai.firstPass('d1'));
    const turn = s.fillCalls.find((c) => isTurn(c))!; expect(turn.model).toBe('standard');                                             // the check's model runs the agent
    expect(turn.prompt).toContain('1. Decommissioning is provided for Still needed: a decommissioning plan');                         // with what the check said it still needs
    expect(s.calls.map((c) => [itemsIn(c).map((it) => it.text).join(), sentNames(c).join()])).toEqual([['Decommissioning is provided for', 'Credit Agreement.pdf'], ['Decommissioning is provided for', 'DEC-77.pdf']]);   // the cited plan is read against the item, as on its last look
    expect(r.gaps).toEqual([]); expect(r.unsettled).toEqual([]);
    expect(val(await s.ai.checklist('d1')).find((x) => x.id === 'x1')).toMatchObject({ result: 'satisfied', sources: [{ doc: 'DEC-77.pdf', loc: 'p. 1' }] });
  });

  it('an item the agent finds nothing for stays the gap the check left, with its searches; the deal\'s search calls and a failed run stop the handing over', async () => {
    const items = Array.from({ length: 6 }, (_x, i) => ({ id: `g${i + 1}`, text: `Gap item ${i + 1} on decommissioning` }));
    const gapAll = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, result: 'more', need: 'a decommissioning plan' })) });
    const opts = { checklist: () => ({ broad: items, product: [], sector: [] }), pick: (c: Call) => ({ read: numbersOf(c, FA) }), pickFor: () => ({ read: {} }), query: (c: Call) => ({ queries: Object.fromEntries([...c.prompt.matchAll(/^(I\d+):/gm)].map((m) => [m[1], ['decommissioning plan']])) }) };
    // found nothing: each run hands over at most four items, and every item stays a gap with what was searched for
    const s = setup(gapAll, { d1: [FA, TS] }, opts); await deal(s.repo);
    const r = val(await s.ai.firstPass('d1')); expect(r.gaps.length).toBe(6);
    const turns = s.fillCalls.filter((c) => isTurn(c)); expect(turns.length).toBe(2); expect(turns[0].prompt).toContain('4. Gap item 4'); expect(turns[0].prompt).not.toContain('Gap item 5'); expect(turns[1].prompt).toContain('2. Gap item 6');
    expect(turns[0].prompt).toContain('(searched already, finding nothing: "decommissioning plan"');                                 // the check's searches go with them, so they are not made again
    const g1 = val(await s.ai.checklist('d1')).find((x) => x.id === 'g1')!; expect(g1.result).toBe('gap'); expect(g1.searched?.[0]).toEqual({ q: 'decommissioning plan', n: 0 });
    // the agent's allowance, as large as the check's own searches: past it, no more is handed over, and every item is still written
    const spent = setup(gapAll, { d1: [FA, TS] }, { ...opts, checkSearchCalls: 1 }); await deal(spent.repo);
    expect(val(await spent.ai.firstPass('d1')).gaps.length).toBe(6);
    expect(spent.fillCalls.length).toBeLessThanOrEqual(1);
    expect(spent.fillCalls.filter((c) => isTurn(c)).length).toBeLessThanOrEqual(1);
    // a run whose reply cannot be used: no more items are handed over in that check
    const broke = setup(gapAll, { d1: [FA, TS] }, { ...opts, fill: (c: Call) => (isTurn(c) ? 'I cannot help with that.' : { text: '', sources: [] }) }); await deal(broke.repo);
    expect(val(await broke.ai.firstPass('d1')).gaps.length).toBe(6); expect(new Set(broke.fillCalls.filter((c) => isTurn(c)).map((c) => c.prompt.split('\n\n')[0])).size).toBe(1);
  });

  it('a run changes nothing that has not changed: only what was left unsettled is tried again, and an item with a finding is never checked twice', async () => {
    const recs = { d1: [FA, TS, IM, MODEL, SIDE, MINUTES] }; let reading = usual; const s = setup((c) => reading(c), recs, { checklist: () => LIST }); await deal(s.repo); val(await tomb(s.repo, 'f_gone', 'Deleted by a person before', 'b4'));
    const one = val(await s.ai.firstPass('d1')); const n1 = s.calls.length;
    const two = val(await s.ai.firstPass('d1'));
    expect(s.calls.slice(n1).map((c) => [c.model, itemsIn(c).map((it) => idOf(it.text)).join()])).toEqual([['standard', 's3'], ['standard', 's3'], ['thorough', 's3']]); expect(two).toEqual({ written: [], gaps: one.gaps, unsettled: ['s3'], marked: [] });
    // a person deletes one of its findings: it stays deleted
    const gone = one.written[0]; const goneItem = (val(await s.repo.get('finding', gone)) as any).itemId; val(await s.repo.transaction({ writes: [], deletes: [{ kind: 'finding', id: gone, expectedRev: 1 }], index: { dealId: 'd1', remove: [{ kind: 'finding', id: gone }] } })); val(await tomb(s.repo, gone, 'Lock-up ratio differs between the credit agreement and the term sheet', goneItem));
    // a new document arrives: only what it bears on is looked at again (the insurance gap), with what was left unsettled; nothing else is asked about twice
    const INS = doc(10, 'Insurance advisor report.pdf', { summary: 'Report of the insurance advisor on the construction period.', keywords: ['insurance', 'advisor'] }); recs.d1.push(INS); const n2 = s.calls.length;
    reading = (c) => itemReply(c, (id) => (id === 'b3' ? (has(c, INS) ? OK(c) : { result: 'more', need: 'insurance advisor report' }) : id === 's3' ? OK(c) : usualFor(id, c)));
    const three = val(await s.ai.firstPass('d1'));
    expect(s.calls.slice(n2).map((c) => [c.model, itemsIn(c).map((it) => idOf(it.text)).join()])).toEqual([['standard', 's3'], ['fast', 'b3'], ['standard', 'b3']]);   // what was never settled gets the full check; the insurance gap is looked at by the fast model first, and goes to the standard model because the fast one no longer sees a gap. Not the capacity, the hedging or the grid permit: an insurance report says nothing to them
    expect(three).toEqual({ written: [], gaps: [{ title: 'The interconnection permit is in place' }], unsettled: [], marked: [] });                                // the insurance report is there now, so that gap has gone
    expect((await storedFindings(s.repo)).map((f) => f.title)).toEqual(['Debt sizing in the model departs from the term sheet']);
  });

  it('what is settled is looked at again when something that bears on it changes: its wording, or a document it was checked against going', async () => {
    const recs = { d1: [FA, TS, IM, MODEL, SIDE, MINUTES] }; let list: Checklist = { broad: [LIST.broad[1], LIST.broad[2]], product: [], sector: [] };
    const s = setup((c) => itemReply(c, (id) => (id === 'b2' ? OK(c) : { result: 'more', need: 'insurance advisor report' })), recs, { checklist: () => list }); await deal(s.repo);
    expect(val(await s.ai.firstPass('d1')).gaps.length).toBe(1); const n1 = s.calls.length; const core1 = s.coreCalls.length;
    val(await s.ai.firstPass('d1')); expect(s.calls.length).toBe(n1); expect(s.coreCalls.length).toBe(core1);                                           // nothing has changed: nothing is asked, not even which documents are core
    // a document that says nothing to either item arrives: still nothing is asked
    recs.d1.push(doc(16, 'Lunch menu.pdf', { summary: 'Canteen menu.' })); val(await s.ai.firstPass('d1')); expect(s.calls.length).toBe(n1);
    // the memorandum the capacity item was checked against is withdrawn: that item is looked at again, the gap is not
    recs.d1.splice(recs.d1.indexOf(IM), 1); val(await s.ai.firstPass('d1')); expect(s.calls.slice(n1).map((c) => itemsIn(c).map((it) => idOf(it.text)).join())).toEqual(['b2']); const n2 = s.calls.length;
    // the gap is reworded in the checklist: it is a new question
    list = { broad: [LIST.broad[1], { id: 'b3', text: 'An insurance advisor report covers construction and operation' }], product: [], sector: [] };
    val(await s.ai.firstPass('d1')); expect(s.calls.slice(n2).map((c) => itemsIn(c).map((it) => it.text).join())).toEqual(['An insurance advisor report covers construction and operation']);
    expect(val(await s.ai.gaps('d1'))).toEqual([{ title: 'An insurance advisor report covers construction and operation' }]);
  });

  it('a reply that cannot be read is sent back to the model that wrote it, once, to be put right; only if that fails is it a failed run', async () => {
    const good = { text: 'It is 1.25x. [1]', sources: [{ doc: 'D1', page: 14 }] };
    const s = setup(() => 'Here you go: text = It is 1.25x [1], source D1 page 14', undefined, { fix: () => good });
    expect(val(await s.ai.answer(ask('What is the lock-up ratio?', { model: 'fast' }))).sources).toEqual([{ doc: 'Credit Agreement.pdf', loc: 'p. 14', docId: FA.docId }]);
    expect(s.calls.length).toBe(1); expect(fixesOf(s, 'text').map((c) => [c.model, c.files.length])).toEqual([['fast', 0], ['fast', 0]]);                     // the search helper's reading and the main session's turn: each by the same model, with no documents: a small call
    const shape = '{"tool": …} or {"text": "…", "sources": […], "offer": {…}}';
    expect(fixesOf(s, 'text')[1].prompt).toContain(`in this shape: ${shape}`);
    expect(fixesOf(s, 'text')[1].prompt).toContain('Here you go: text = It is 1.25x [1], source D1 page 14');
    // it is not asked to fix a reply that could be read, however loosely it was written
    const loose = setup(() => "```json\n{'text': 'It is 1.25x. [1]', 'sources': [{'doc': '[d1]', 'page': 'p. 14',},],}\n```"); expect(val(await loose.ai.answer(ask('What is the lock-up ratio?'))).sources.length).toBe(1); expect(fixesOf(loose, 'text').length).toBe(0);
    // the fix fails too: for a person's own choice of model that is the failure; for the backend's it is one failed run of two
    const bad = setup(() => 'no'); const a = await bad.ai.answer(ask('lock-up')); expect(!a.ok && a.error.kind).toBe('failed'); expect([bad.calls.length, fixesOf(bad, 'text').length]).toEqual([1, 2]);
    const re = setup(() => 'no'); await deal(re.repo); await finding(re.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    expect((await re.ai.reassess({ dealId: 'd1', findingId: 'f_1' })).ok).toBe(false); expect(re.calls.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']); expect(fixesOf(re, 'body').map((c) => c.model)).toEqual(['standard']);   // the first attempt is sent back to be put right, which is the cheapest cure; the attempts after it are not, so one failure is not paid for three times
    // a reply that reads but is thin is not something a fix can mend: no fix is asked for
    const thin = setup((c, n) => (n === 1 ? { body: [] } : { body: ['Still 1.25x. [1]'], sources: [{ doc: tag(c, FA), page: 14 }] })); await deal(thin.repo); await finding(thin.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    val(await thin.ai.reassess({ dealId: 'd1', findingId: 'f_1' })); expect(fixesOf(thin, 'body').length).toBe(0); expect(thin.calls.map((c) => c.model)).toEqual(['standard', 'standard']);
  });

  it('replies are read for what they say, not how neatly: loose citations, lists, ids and words are understood, and the rules on what counts still hold', async () => {
    // a document by tag in any form, by name or by path; a page as words; one source not in a list; a sheet and cell apart
    const s = setup((c) => `Sure!\n{"text": ["It is 1.25x. [1]", "The term sheet agrees. [2] The model too. [3] And the memorandum. [4] Not this. [5] Nor this. [6]"], "sources": [{"document": "${tag(c, FA).toLowerCase()}", "page": "p. 14"}, {"doc": "Term sheet (signed).pdf", "page": "3-4"}, {"doc": "[${tag(c, MODEL)}]", "sheet": "Debt", "cell": "B20"}, {"doc": "vdr/Information memorandum.pdf", "page": "7"}, {"doc": "${tag(c, FA)}", "page": "clause 14.2"}, {"doc": "${tag(c, TS)}", "page": 99}], "need": "nothing more"}`);
    const r = val(await s.ai.answer(ask('What is the lock-up ratio, and the capacity?')));
    expect(r.sources.map((x) => [x.doc, x.loc])).toEqual([['Credit Agreement.pdf', 'p. 14'], ['Term sheet (signed).pdf', 'p. 3'], ['Model v12.xlsx', 'Debt!B20'], ['Information memorandum.pdf', 'p. 7']]);
    expect(r.text).toBe('It is 1.25x. [1]\n\nThe term sheet agrees. [2] The model too. [3] And the memorandum. [4] Not this. Nor this.');                     // a clause number is still not a page, and a page the document does not have is still not a citation
    // a first pass sent as a bare list, ids as numbers or in words, results in capitals, the body as one string, and the reply cut off in its last item
    const f = setup((c, n) => (n > 1 ? '[{"id": "I1", "result": "fin' : `[{"id": 1, "result": "OK", "where": {"document": "${tag(c, FA).toLowerCase()}", "page": "p. 14", "quote": "1.25x"}}, {"id": "Item 2", "result": " Finding ", "title": "Capacity differs", "workstream": "Commercial", "body": "The memorandum says 100 MW. [1] The model uses 90. [2]", "next": "Ask.", "sources": [{"doc": "${tag(c, IM)}", "page": "2"}, {"doc": "${tag(c, MODEL)}", "cell": "Debt!B2"}]}, {"id": "I3", "result": "More", "need": ["a permit", "its conditions"]}, {"id": "I4", "result": "fin`),
      undefined, { checklist: () => ({ broad: LIST.broad, product: [], sector: [] }) }); await deal(f.repo);
    const p = val(await f.ai.firstPass('d1'));
    expect((await storedFindings(f.repo)).map((x) => [x.title, x.body, x.sources.length])).toEqual([['Capacity differs', ['The memorandum says 100 MW. [1] The model uses 90. [2]'], 2]]);
    expect(p.gaps).toEqual([{ title: 'An insurance advisor report covers the construction period' }]); expect(p.unsettled).toEqual(['b4']);                // the item that was cut off is not guessed at: it is asked again, and here never completes
    // what could be read was kept; only the cut item went round again, alone (parts.ts), and cut off even alone it is not asked again
    expect(f.calls.map((c) => [c.model, itemsIn(c).length])).toEqual([['standard', 4], ['standard', 1]]); expect(fixesOf(f, 'items').length).toBe(0);
    // items keyed by id, and the lists of numbers as strings
    const k = setup((c) => ({ items: { I1: OK(c), I2: OK(c) } }), undefined, { checklist: () => ({ broad: LIST.broad.slice(0, 2), product: [], sector: [] }), pick: (c) => `["${numbersOf(c, TS)[0]}", "${numbersOf(c, FA)[0]}*"]` }); await deal(k.repo);
    expect(val(await k.ai.firstPass('d1'))).toEqual({ written: [], gaps: [], unsettled: [], marked: [] }); expect(k.calls.length).toBe(1); expect(k.calls[0].files.map((x) => fromStoreName(x.name)!.name)).toEqual(['Term sheet (signed).pdf', 'Credit Agreement.pdf']);
  });

  it('every PC on the deal shows the same gaps, and a PC that did not run the first pass does not run it again', async () => {
    const shared = new Mem(); const repo = memRepo(clock); await deal(repo);
    const office = setup(usual, undefined, { checklist: () => LIST, shared, installId: 'office', repo }); const home = setup(usual, undefined, { checklist: () => LIST, shared, installId: 'home', repo });
    const r = val(await office.ai.firstPass('d1')); expect(shared.list()).toEqual(['checks-office-d1.jsonl']);
    expect(val(await home.ai.gaps('d1'))).toEqual(r.gaps); expect(home.calls.length).toBe(0);
    const again = val(await home.ai.firstPass('d1')); expect(home.calls.map((c) => itemsIn(c).map((it) => idOf(it.text)).join())).toEqual(['s3', 's3', 's3']); expect(again.gaps).toEqual(r.gaps);   // only the item left unsettled
    expect(shared.list().sort()).toEqual(['checks-home-d1.jsonl', 'checks-office-d1.jsonl']);                                                                 // each PC writes its own file, as with every shared file
    shared.append('checks-home-d1.jsonl', '{"v":1,"at":"2099-01-01T00:00:00.000Z","item":"s1","text":"The grid conn'); expect(val(await office.ai.gaps('d1'))).toEqual(r.gaps);   // a line cut short by a sync is skipped
    expect(val(await office.ai.gaps('d2'))).toEqual([]);
  });

  it('a copy of a check file that a sync client set aside in a conflict is read like any other, whatever it is called', async () => {
    const shared = new Mem(); const repo = memRepo(clock); await deal(repo);
    const office = setup(usual, undefined, { checklist: () => LIST, shared, installId: 'office', repo }); const home = setup(usual, undefined, { checklist: () => LIST, shared, installId: 'home', repo });
    const r = val(await office.ai.firstPass('d1')); expect(r.gaps.length).toBeGreaterThan(0);
    for (const copy of ['checks-office-d1-PC-A.jsonl', 'checks-office-d1 (1).jsonl', 'checks-office-d1 - Copy.jsonl']) {
      // the office's lines survive only in the copy: the main file is the cloud's older, empty one
      const text = shared.read('checks-office-d1.jsonl')!; for (const n of shared.list()) if (n !== 'checks-office-d1.jsonl') shared.files.delete(n);
      shared.files.set(copy, text); shared.files.set('checks-office-d1.jsonl', '');
      expect(val(await home.ai.gaps('d1'))).toEqual(r.gaps);
      shared.files.set('checks-office-d1.jsonl', text); shared.files.delete(copy);
    }
    shared.files.set('checks-office-d10.jsonl', shared.read('checks-office-d1.jsonl')!.replace(/s1/g, 'zz')); expect(val(await home.ai.gaps('d1'))).toEqual(r.gaps);   // another deal's file is not read
  });

  it('a run always gets to the end; when the service cannot be reached it stops, and the next run carries on from there', async () => {
    let down = false; const s = setup((c) => { if (down && itemsIn(c).some((it) => idOf(it.text) === 'p1')) { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; } return usual(c); }, undefined, { checklist: () => LIST, batch: 4 }); await deal(s.repo);
    down = true; const r = await s.ai.firstPass('d1'); expect(!r.ok && r.error.kind).toBe('unreachable');
    expect((await storedFindings(s.repo)).map((f) => f.title)).toEqual(['Lock-up ratio differs between the credit agreement and the term sheet', 'Deleted by a person before']);   // the first four items were dealt with (no person has deleted that title on this deal)
    expect(val(await s.ai.gaps('d1'))).toEqual([{ title: 'An insurance advisor report covers the construction period' }]);                                // what is known so far
    down = false; const n = s.calls.length; const next = val(await s.ai.firstPass('d1'));
    expect(itemsIn(s.calls[n]).map((it) => idOf(it.text))).toEqual(['p1', 's1', 's2', 's3']); expect(next.written.length).toBe(1); expect(next.gaps.length).toBe(2);
    // a call that fails for another reason does not stop the run: its items are left unsettled
    const broke = setup(() => { throw new Error('500'); }, undefined, { retry: { retries: 0 }, checklist: () => ({ broad: LIST.broad.slice(0, 2), product: [], sector: [] }) }); await deal(broke.repo);
    expect(val(await broke.ai.firstPass('d1'))).toEqual({ written: [], gaps: [], unsettled: ['b1', 'b2'], marked: [] }); expect(broke.calls.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
  });

  it('with no checklist, an empty one or no documents, nothing is checked; a deal with no core documents is checked against what answers to each item', async () => {
    const none = setup(usual); await deal(none.repo); expect(val(await none.ai.firstPass('d1'))).toEqual({ written: [], gaps: [], unsettled: [], marked: [] }); expect(val(await none.ai.gaps('d1'))).toEqual([]);
    const empty = setup(usual, undefined, { checklist: () => ({ broad: [], product: [], sector: [] }) }); await deal(empty.repo); expect(val(await empty.ai.firstPass('d1')).gaps).toEqual([]);
    const bare = setup(usual, { d1: [] }, { checklist: () => LIST }); await deal(bare.repo); expect(val(await bare.ai.firstPass('d1')).gaps).toEqual([]);     // nothing indexed is not forty gaps
    expect(none.calls.length + empty.calls.length + bare.calls.length + none.coreCalls.length + bare.coreCalls.length).toBe(0);
    const lost = setup(usual, undefined, { checklist: () => { throw new Error('file missing'); } }); await deal(lost.repo); const l = await lost.ai.firstPass('d1'); expect(!l.ok && l.error.message).toBe('The checklist could not be read');
    const noDeal = await setup(usual, undefined, { checklist: () => LIST }).ai.firstPass('d1'); expect(!noDeal.ok && noDeal.error.kind).toBe('notFound');
    // only minor documents: each item is matched to documents by its own words
    const minor = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(/hedging/.test(it.text) ? OK(c) : { result: 'more', need: 'insurance advisor report' }) })) }), { d1: [SIDE, MINUTES] }, { checklist: () => ({ broad: [LIST.broad[2]], product: [{ id: 'h1', text: 'The hedging strategy has been approved' }], sector: [] }) }); await deal(minor.repo);
    expect(val(await minor.ai.firstPass('d1'))).toEqual({ written: [], gaps: [{ title: 'An insurance advisor report covers the construction period' }], unsettled: [], marked: [] });
    expect(minor.calls.map((c) => [itemsIn(c).length, sentNames(c).join()])).toEqual([[2, 'Board minutes March.pdf']]);
  });
});

// ── following a change through, and checking everything again ─────────────────────────────────────────────────────────
const TWELVE: Checklist = { broad: Array.from({ length: 12 }, (_, i) => ({ id: `i${i + 1}`, text: i === 0 ? 'The lock-up ratio is the same in the credit agreement and the term sheet' : `Point ${i + 1} of the finance documents is in order` })), product: [], sector: [] };
const numOf = (text: string) => (/lock-up/.test(text) ? 1 : +/Point (\d+)/.exec(text)![1]);
/** a first pass that raises the lock-up finding on item 1 and is satisfied on the rest; `say` changes what later calls answer for an item */
const twelve = (say: (n: number, c: Call) => object | undefined = () => undefined) => (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(say(numOf(it.text), c) ?? (numOf(it.text) === 1 ? LOCKUP(c) : OK(c))) })) });
const question = (repo: Repository, id: string, data: object) => repo.transaction({ writes: [{ kind: 'question', id, data: { id, dealId: 'd1', ...data }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id }] } });
const findingData = async (repo: Repository, id: string) => (val(await repo.get('finding', id))!.envelope.data as { updated?: boolean; updatedWhy?: string; body: string[]; title: string; status: string; reviewed: unknown });

describe('when something changes', () => {
  it('new documents are followed through: the fast model says what they could affect, and a finding that no longer stands is marked for a person', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] }; const NOTICE = doc(30, 'Offtake termination notice.pdf', { rel: 'Notes/Offtake termination notice.pdf', pages: 2, summary: 'Notice terminating the offtake agreement.' });
    let stands = false;
    const s = setup(twelve(), recs, { checklist: () => TWELVE, affects: () => ({ affected: ['F1', 'C7', 'C99', 'nonsense'] }), verify: () => ({ stands, why: 'The offtake has been terminated.' }) }); await deal(s.repo);
    const first = val(await s.ai.firstPass('d1')); expect(first.written.length).toBe(1); expect(first.marked).toEqual([]); expect(s.affectCalls.length + s.verifyCalls.length).toBe(0);   // nothing has changed yet: nothing to follow
    const f1 = first.written[0]; const n1 = s.calls.length; recs.d1.push(NOTICE);
    const next = val(await s.ai.firstPass('d1'));
    expect(s.affectCalls.map((c) => [c.model, c.files.length])).toEqual([['fast', 0]]);
    expect(s.affectCalls[0].prompt).toContain('vdr/Notes/Offtake termination notice.pdf — Notice terminating the offtake agreement.'); expect(s.affectCalls[0].prompt).toContain('F1: Lock-up ratio differs between the credit agreement and the term sheet');
    expect(s.affectCalls[0].prompt).toContain('C1: Point 2 of the finance documents is in order'); expect(s.affectCalls[0].prompt).not.toContain('The lock-up ratio is the same');   // an item with a finding is the finding's business
    expect(s.calls.slice(n1).map((c) => [c.model, itemsIn(c).map((it) => it.text).join()])).toEqual([['fast', 'Point 8 of the finance documents is in order']]);      // C7: no word in common with the notice, but the fast model saw the link. It still comes out satisfied, so the standard model is not asked
    expect(s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']); expect(sentNames(s.verifyCalls[1])).toEqual(expect.arrayContaining(['Credit Agreement.pdf', 'Term sheet (signed).pdf', 'Offtake termination notice.pdf']));   // the finding's own documents and the new one
    expect(next.marked).toEqual([f1]); expect(s.announced).toContain(f1);
    expect(await findingData(s.repo, f1)).toMatchObject({ updated: true, updatedWhy: 'Offtake termination notice.pdf arrived', status: 'open', reviewed: null, body: ['The draft sets it at 1.25x. [1]', 'The term sheet has 1.30x. [2]'] });   // marked, and not a word of it changed
    // a finding that still stands is left alone
    stands = true; recs.d1.push(doc(31, 'Offtake side letter.pdf', { summary: 'Side letter to the offtake agreement.' }));
    val(await s.repo.transaction({ writes: [{ kind: 'finding', id: f1, data: { ...(await findingData(s.repo, f1)), updated: false, updatedWhy: '' }, expectedRev: 2 }] }));
    const v = s.verifyCalls.length; expect(val(await s.ai.firstPass('d1')).marked).toEqual([]); expect((await findingData(s.repo, f1)).updated).toBe(false);
    expect(s.verifyCalls.slice(v).map((c) => c.model)).toEqual(['fast']);                                                                              // the fast model sees it stands: the standard model is not asked
  });

  it('a re-check always reads the new document that prompted it, even when the finding’s own sources fill the handful', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] }; const s = setup(twelve(), recs, { width: 2, checklist: () => TWELVE, affects: () => ({ affected: ['F1'] }) }); await deal(s.repo);
    const f1 = val(await s.ai.firstPass('d1')).written[0]; expect(((await findingData(s.repo, f1)) as any).sources.length).toBeGreaterThanOrEqual(2);
    recs.d1.push(doc(35, 'Lock-up waiver letter.pdf', { summary: 'Lenders waive the lock-up ratio test.' })); val(await s.ai.firstPass('d1'));
    expect(s.verifyCalls.length).toBeGreaterThan(0); expect(s.verifyCalls[0].files.map((f) => fromStoreName(f.name)!.name)[0]).toBe('Lock-up waiver letter.pdf');
  });

  it('marks two independent same-name document arrivals and leaves a repeated poll alone (#326)', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] };
    const { ai, repo } = setup(twelve(), recs, {
      checklist: () => TWELVE,
      affects: () => ({ affected: ['F1'] }),
      verify: () => ({ stands: false, why: 'The notice changes the covenant.' }),
    });
    await deal(repo);
    const [id] = val(await ai.firstPass('d1')).written;
    const name = 'Covenant notice.pdf';
    recs.d1.push(doc(52, name, { summary: 'The lock-up ratio is suspended for the current period.' }));
    expect(val(await ai.firstPass('d1')).marked).toEqual([id]);
    const first = val(await repo.get('finding', id))!;
    expect(val(await ai.firstPass('d1')).marked).toEqual([]);
    expect(val(await repo.get('finding', id))!.rev).toBe(first.rev);
    recs.d1.push(doc(53, name, { summary: 'The lock-up ratio is suspended for the following period.' }));
    expect(val(await ai.firstPass('d1')).marked).toEqual([id]);
    const second = val(await repo.get('finding', id))!;
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.envelope.data).toMatchObject({ updated: true, updatedWhy: `${name} arrived` });
  });

  it('a draft fails, rather than throwing, when the model service cannot say which models it has', async () => {
    const s = setup(() => ({ status: 'found', text: 'x', sources: [] })); s.svc.models = async () => { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; };
    const d = await s.ai.draft({ dealId: 'd1', questionId: 'q_1', questionText: 'Confirm the lock-up ratio.' }); expect(!d.ok && d.error.kind).toBe('unreachable');
  });

  it('the fast model’s doubt alone marks nothing, and when it says nothing is affected a shared word sets off nothing', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] }; const s = setup(twelve(), recs, { checklist: () => TWELVE, affects: (_c, n) => ({ affected: n === 1 ? ['F1'] : [] }), verify: (c) => ({ stands: c.model !== 'fast', why: '' }) }); await deal(s.repo);
    const f1 = val(await s.ai.firstPass('d1')).written[0]; recs.d1.push(doc(35, 'Lock-up waiver letter.pdf', { summary: 'Lenders waive the lock-up ratio test.' }));
    expect(val(await s.ai.firstPass('d1')).marked).toEqual([]); expect(s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']); expect((await findingData(s.repo, f1)).updated ?? false).toBe(false);
    const n = s.calls.length; const v = s.verifyCalls.length; recs.d1.push(doc(36, 'Finance documents index.pdf', { summary: 'Index of the finance documents and the lock-up ratio, point by point.' }));
    val(await s.ai.firstPass('d1')); expect(s.affectCalls.length).toBe(2); expect(s.calls.length).toBe(n); expect(s.verifyCalls.length).toBe(v);              // it shares words with every item and with the finding; the fast model said none is affected, and that is the answer
  });

  it('one batch of new documents is one question; everything it is said to affect is looked at, by the fast model first; and nothing written sets off more', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] };
    const s = setup(twelve(), recs, { checklist: () => TWELVE, affects: () => ({ affected: ['F2', 'F1', 'F3', 'C4', 'C1', 'C9', 'C2', 'C6', 'C11'] }), verify: (c) => ({ stands: !c.prompt.includes('Second finding'), why: '' }) }); await deal(s.repo);
    const f1 = val(await s.ai.firstPass('d1')).written[0];
    await finding(s.repo, 'f_two', 'Second finding', { sources: [{ doc: IM.name, loc: 'p. 2', docId: IM.docId }] }); await finding(s.repo, 'f_three', 'Third finding', { sources: [{ doc: FA.name, loc: 'p. 9', docId: FA.docId }] });
    const n = s.calls.length; recs.d1.push(doc(40, 'Board pack.pdf', { summary: 'Everything at once.' }), doc(41, 'Second pack.pdf', { summary: 'More of everything.' }));
    const r = val(await s.ai.firstPass('d1'));
    expect(s.affectCalls.length).toBe(1); expect(s.affectCalls[0].prompt).toContain('Board pack.pdf'); expect(s.affectCalls[0].prompt).toContain('Second pack.pdf');   // one question for the whole batch, not one a document
    expect(s.calls.slice(n).map((c) => [c.model, itemsIn(c).map((it) => numOf(it.text)).join()])).toEqual([['fast', '5,2,10,3,7,12']]);                    // all six items it named, in its order, in one call of the fast model: each still comes out as it was, so the standard model is not asked
    expect(s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard', 'fast', 'fast']); expect(r.marked).toEqual(['f_two']); expect((await findingData(s.repo, f1)).updated ?? false).toBe(false);   // all three findings: the fast model doubts one, and only that one goes to the standard model
    const again = s.calls.length + s.verifyCalls.length + s.affectCalls.length; expect(val(await s.ai.firstPass('d1')).marked).toEqual([]); expect(s.calls.length + s.verifyCalls.length + s.affectCalls.length).toBe(again);   // the mark it wrote, and the looks it took, start nothing further
  });

  it('when the fast model cannot say, the keyword match decides; and a finding that cites a document no longer in the data room is marked without asking anyone', async () => {
    const recs = { d1: [FA, TS, IM, MODEL] }; const s = setup(twelve(), recs, { checklist: () => TWELVE, verify: () => ({ stands: false, why: '' }) }); await deal(s.repo);
    const f1 = val(await s.ai.firstPass('d1')).written[0];
    recs.d1.push(doc(32, 'Lunch menu.pdf', { summary: 'Canteen menu.' })); expect(val(await s.ai.firstPass('d1')).marked).toEqual([]); expect(s.verifyCalls.length).toBe(0);   // nothing in it answers to the finding
    recs.d1.push(doc(33, 'Lock-up waiver letter.pdf', { summary: 'Lenders waive the lock-up ratio test.' })); expect(val(await s.ai.firstPass('d1')).marked).toEqual([f1]); expect((await findingData(s.repo, f1)).updatedWhy).toBe('Lock-up waiver letter.pdf arrived');
    const t = setup(twelve(), { d1: [FA, TS, IM, MODEL] }, { checklist: () => TWELVE }); await deal(t.repo); const g1 = val(await t.ai.firstPass('d1')).written[0];
    t.recs.d1.splice(t.recs.d1.indexOf(TS), 1); const v = t.verifyCalls.length;
    expect(val(await t.ai.firstPass('d1')).marked).toEqual([g1]); expect((await findingData(t.repo, g1)).updatedWhy).toBe('A document it cites is no longer in the data room'); expect(t.verifyCalls.length).toBe(v);
  });

  it('a response on a question linked to a finding goes with its reassessment, named as a response and not cited as a document', async () => {
    const s = setup((c) => ({ body: ['The response to Q12 confirms 1.25x was agreed. The draft says the same. [1]'], sources: [{ doc: tag(c, FA), page: 14 }] })); await deal(s.repo);
    await finding(s.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    val(await question(s.repo, 'q_12', { n: 12, text: 'Which lock-up ratio was agreed?', response: 'The agreed ratio is 1.25x;\nthe term sheet is out of date.', respondedBy: 'Sponsor counsel', responded: '2026-11-10', linkedFinding: 'f_1' }));
    val(await question(s.repo, 'q_13', { n: 13, text: 'Not answered yet', response: '  ', linkedFinding: 'f_1' })); val(await question(s.repo, 'q_14', { n: 14, text: 'About something else', response: 'Unrelated.', linkedFinding: 'f_2' })); val(await question(s.repo, 'q_15', { n: 15, text: 'Linked to nothing', response: 'Also unrelated.' }));
    expect(val(await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }))).toEqual({ body: ['The response to Q12 confirms 1.25x was agreed. The draft says the same. [1]'], sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    expect(s.calls[0].prompt).toContain([
      'Responses received on the questions asked about this finding:',
      'R1: Which lock-up ratio was agreed?',
      'Response to R1 from Sponsor counsel, 2026-11-10: The agreed ratio is 1.25x; the term sheet is out of date.',
      'Take these into account. A response is not a document: '
        + 'refer to it as "response R<k>" and give it no [n] marker.',
    ].join('\n'));
    expect(s.calls[0].prompt).not.toMatch(/Q13|Q14|Q15|Unrelated/);
    // a response that was an AI draft from the data room is said to be one, not passed off as received from the firm
    // (no separate "closed internally")
    val(
      await question(s.repo, 'q_16', {
        n: 16,
        text: 'What does the draft set?',
        response: 'The draft sets 1.25x.',
        respondedBy: '[firm name]',
        responded: '2026-11-12',
        linkedFinding: 'f_1',
        provenance: { origin: 'ai', sources: [], actor: 'adoe', at: '2026-11-12T10:00:00.000Z' },
      }),
    );
    val(await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }));
    const drafted = 'Response to R2 (drafted by AI from the data room, not received from anyone), 2026-11-12';
    expect(s.calls.at(-1)!.prompt).toContain(`${drafted}: The draft sets 1.25x.`);
    const none = setup((c) => ({ body: ['Still so. [1]'], sources: [{ doc: tag(c, FA), page: 14 }] })); await deal(none.repo); await finding(none.repo, 'f_1', 'Lock-up differs', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    val(await none.ai.reassess({ dealId: 'd1', findingId: 'f_1' })); expect(none.calls[0].prompt).not.toContain('Responses received');
  });

  it('a reassessment shows the model each question by a neutral handle, never its number (#1105)', async () => {
    const sources = (c: Call) => [{ doc: tag(c, FA), page: 14 }];
    // amounts in rand ("R1.2 billion") are the documents' own words, never a handle
    const said = 'Revenue fell, per response R1; the tariff is R1.2 billion and capex R50 million. [1]';
    const reply = (c: Call) => ({ body: [said], sources: sources(c) });
    const s = setup(reply);
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'Revenue below plan', { sources: [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }] });
    const fell = { n: 3, text: 'How did revenue move?', response: 'Revenue fell in Q3 2026.', linkedFinding: 'f_1' };
    val(await question(s.repo, 'q_3', fell));
    const reassessed = val(await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }));
    const kept = 'Revenue fell, per the response to Q3; the tariff is R1.2 billion and capex R50 million. [1]';
    expect(reassessed.body).toEqual([kept]);
    const prompt = s.calls[0].prompt;
    expect(prompt).toContain('R1: How did revenue move?\nResponse to R1: Revenue fell in Q3 2026.');
    expect(prompt).not.toMatch(/Q3:|Response to Q3/);
  });

  it('a response on a question linked to no finding is followed through like a new document: the fast model says which findings it could change, and one that no longer stands is marked', async () => {
    const shared = new Mem(); const src = [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }];
    const s = setup((c) => ({ body: ['Settled by the response to Q12. [1]'], sources: [{ doc: tag(c, FA), page: 14 }] }), undefined, { shared, installId: 'office',
      hears: () => ({ affected: ['F1 R1', 'F2: R2', 'F9 R1', 'nonsense'] }),
      verify: (c) => (c.model === 'fast' && c.prompt.includes('Title: Lock-up differs')
        ? { stands: false, why: 'the response settles it' }
        : c.model === 'standard' ? { stands: false, why: 'agreed' } : { stands: true, why: '' }) });
    await deal(s.repo); await finding(s.repo, 'f_1', 'Lock-up differs', { sources: src }); await finding(s.repo, 'f_2', 'Hedging not approved', { sources: src }); await finding(s.repo, 'f_3', 'Closed already', { status: 'closed', sources: src });
    val(await question(s.repo, 'q_12', { n: 12, text: 'Which lock-up ratio was agreed?', response: 'The agreed ratio is 1.25x; the term sheet is out of date.', respondedBy: 'Sponsor counsel', responded: '2026-11-10' }));
    val(await question(s.repo, 'q_13', { n: 13, text: 'Not answered yet', response: ' ' })); val(await question(s.repo, 'q_14', { n: 14, text: 'Tied to a finding', response: 'The app marks that one itself.', linkedFinding: 'f_2' })); val(await question(s.repo, 'q_15', { n: 15, text: 'Has the board approved the hedging?', response: 'Not yet.' }));
    expect(val(await s.ai.responses('d1'))).toEqual({ heard: ['q_12', 'q_15'], marked: ['f_1'] });
    // one question to the fast model, with no documents: the two responses tied to nothing, and the open findings
    expect(s.hearCalls.length).toBe(1); expect(s.hearCalls[0].model).toBe('fast'); expect(s.hearCalls[0].files).toEqual([]);
    expect(s.hearCalls[0].prompt).toContain([
      'R1: Which lock-up ratio was agreed?',
      'Response to R1 from Sponsor counsel, 2026-11-10: The agreed ratio is 1.25x; the term sheet is out of date.',
      'R2: Has the board approved the hedging?',
      'Response to R2: Not yet.\n',
    ].join('\n'));
    expect(s.hearCalls[0].prompt).toContain('F1: Lock-up differs\nF2: Hedging not approved\n');
    expect(s.hearCalls[0].prompt).toContain('Reply as JSON: {"affected": ["F2 R1", "F5 R3"]}');
    expect(s.hearCalls[0].prompt).not.toMatch(/Q\d|Tied to a finding|Closed already/);
    // each finding it named was looked at with its response beside it, by the fast model first; only the one that doubted went to the standard model
    const firstResponse = (c: { prompt: string }) => /Response to R1[^:]*: (.*)/.exec(c.prompt)![1];
    expect(s.verifyCalls.map((c) => [c.model, /Title: (.*)/.exec(c.prompt)![1], firstResponse(c)])).toEqual([
      ['fast', 'Lock-up differs', 'The agreed ratio is 1.25x; the term sheet is out of date.'],
      ['standard', 'Lock-up differs', 'The agreed ratio is 1.25x; the term sheet is out of date.'],
      ['fast', 'Hedging not approved', 'The app marks that one itself.'],
    ]);
    // its own linked response, and the one said to bear on it
    expect(s.verifyCalls[2].prompt).toContain('Response to R2: Not yet.');
    const f = async (id: string) => val(await s.repo.get('finding', id))!.envelope.data as { updated?: boolean; updatedWhy?: string; title: string; body: string[] };
    expect(await f('f_1')).toMatchObject({ updated: true, updatedWhy: 'Response received on Q12', updatedOn: { questions: ['q_12'] }, title: 'Lock-up differs', body: ['As written. [1]'] });   // which question, by id as well as in words expect((await f('f_2')).updated).toBeUndefined(); expect(s.announced).toEqual(['f_1']);
    expect(s.usage.at(-1)!.run).toBe('responses'); expect(s.usage.at(-1)!.calls.map((l) => `${l.kind}/${l.model} ×${l.calls}`).sort()).toContain('affects/fast ×1');
    // asked again, nothing is new: no model is asked. Another PC on the deal knows it too.
    const before = s.svc.calls.length; expect(val(await s.ai.responses('d1'))).toEqual({ heard: [], marked: [] }); expect(s.svc.calls.length).toBe(before);
    const home = setup(() => ({}), undefined, { shared, installId: 'home', repo: s.repo }); expect(val(await home.ai.responses('d1'))).toEqual({ heard: [], marked: [] }); expect(home.svc.calls.length).toBe(0);
    // when a person reassesses the finding, the response that set it off is read with it, though the question is tied to nothing
    val(await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }));
    const counsel = 'Response to R1 from Sponsor counsel, 2026-11-10';
    expect(s.calls.at(-1)!.prompt).toContain(`${counsel}: The agreed ratio is 1.25x; the term sheet is out of date.`);
    expect(s.calls.at(-1)!.prompt).not.toContain('Has the board approved the hedging?');
    // a response reworded is a new response; one left as it was is not
    val(await s.repo.transaction({ writes: [{ kind: 'question', id: 'q_15', data: { id: 'q_15', dealId: 'd1', n: 15, text: 'Has the board approved the hedging?', response: 'Approved on November 3.' }, expectedRev: 1 }] }));
    expect(val(await s.ai.responses('d1')).heard).toEqual(['q_15']); expect(s.hearCalls.length).toBe(2);
    expect(s.hearCalls[1].prompt).not.toContain('Which lock-up ratio was agreed?');
  });

  it('a response mark adds its questions to an earlier one from responses, and leaves a mark set for another reason as it is', async () => {
    const src = [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }];
    const verify = (c: any) => ({ stands: c.model === 'never', why: 'the response settles it' });
    const opts = { hears: () => ({ affected: ['F1 R1'] }), verify };
    const data = async (s: any) => (val(await s.repo.get('finding', 'f_1')) as any).envelope.data as { updated?: boolean; updatedWhy?: string; updatedOn?: { questions: string[] } };
    // marked by a response to a question linked to it: the backend's mark adds Q12 to it
    const a = setup(() => ({}), undefined, opts); await deal(a.repo); await finding(a.repo, 'f_1', 'Lock-up differs', { sources: src, updated: true, updatedWhy: 'Response received on Q3', updatedOn: { questions: ['q_3'] } });
    val(await question(a.repo, 'q_12', { n: 12, text: 'Which ratio?', response: '1.25x.' })); expect(val(await a.ai.responses('d1')).marked).toEqual(['f_1']);
    expect(await data(a)).toMatchObject({ updated: true, updatedOn: { questions: ['q_3', 'q_12'] } });
    // marked by the check: the response does not take its place
    const b = setup(() => ({}), undefined, opts); await deal(b.repo); await finding(b.repo, 'f_1', 'Lock-up differs', { sources: src, updated: true, updatedWhy: 'A document it cites is no longer in the data room' });
    val(await question(b.repo, 'q_12', { n: 12, text: 'Which ratio?', response: '1.25x.' })); val(await b.ai.responses('d1'));
    const d = await data(b); expect(d).toMatchObject({ updated: true, updatedWhy: 'A document it cites is no longer in the data room' }); expect(d.updatedOn).toBeUndefined();
  });

  it('a mark that cannot be written leaves the work undone: the response is set against the finding again next time, and the finding is marked then', async () => {
    const src = [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }];
    const verify = () => ({ stands: false, why: 'the response settles it' });
    const s = setup(() => ({}), undefined, { hears: () => ({ affected: ['F1 R1'] }), verify });
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'Lock-up differs', { sources: src });
    val(await question(s.repo, 'q_12', { n: 12, text: 'Which ratio?', response: '1.25x.' }));
    const back = refuse(s.repo.shared, (t) => t.includes('"kind":"finding"'), quota);  // the shared folder takes no finding changes just now
    const first = await s.ai.responses('d1'); expect(first.ok).toBe(false);
    expect(((await s.repo.get('finding', 'f_1')) as any).value.envelope.data.updated).toBeUndefined();
    back();
    expect(val(await s.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: ['f_1'] });
  });

  it('a response is set against each open finding once: nothing to set it against costs nothing, a finding raised later is a new one to set it against, and a look that gave no answer is not a look', async () => {
    const q12 = { n: 12, text: 'Which lock-up ratio was agreed?', response: 'The agreed ratio is 1.25x.' }; const src = [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }];
    // no open findings: nothing to ask, and nothing written down, so the response is still there to be set against the first finding that is raised
    const empty = setup(() => ({})); await deal(empty.repo); val(await question(empty.repo, 'q_12', q12));
    expect(val(await empty.ai.responses('d1'))).toEqual({ heard: [], marked: [] }); expect(empty.svc.calls.length).toBe(0); expect(empty.usage).toEqual([]);
    await finding(empty.repo, 'f_1', 'Lock-up differs'); expect(val(await empty.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: [] }); expect(empty.hearCalls.length).toBe(1);
    // nothing said to be affected: the one call, no finding is looked at, and it is not asked again
    const none = setup(() => ({})); await deal(none.repo); await finding(none.repo, 'f_1', 'Lock-up differs'); val(await question(none.repo, 'q_12', q12));
    expect(val(await none.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: [] }); expect(none.svc.calls.length).toBe(1); expect(none.verifyCalls.length).toBe(0);
    expect(val(await none.ai.responses('d1'))).toEqual({ heard: [], marked: [] }); expect(none.svc.calls.length).toBe(1);
    // a finding raised afterwards: the same response is put to the fast model again, against that finding only
    await finding(none.repo, 'f_2', 'Hedging not approved'); expect(val(await none.ai.responses('d1')).heard).toEqual(['q_12']); expect(none.hearCalls.length).toBe(2);
    expect(none.hearCalls[1].prompt).toContain('F1: Hedging not approved'); expect(none.hearCalls[1].prompt).not.toContain('Lock-up differs'); expect(val(await none.ai.responses('d1')).heard).toEqual([]);
    // the fast model doubts, the standard model does not: nothing is marked
    const doubt = setup(() => ({}), undefined, { hears: () => ({ affected: ['F1'] }), verify: (c) => ({ stands: c.model !== 'fast', why: '' }) }); await deal(doubt.repo); await finding(doubt.repo, 'f_1', 'Lock-up differs', { sources: src }); val(await question(doubt.repo, 'q_12', q12));
    expect(val(await doubt.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: [] });
    expect(doubt.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']);
    // named with no question: the response in the call goes beside it
    expect(doubt.verifyCalls[0].prompt).toContain('Response to R1: The agreed ratio is 1.25x.');
    expect(val(await doubt.ai.responses('d1')).heard).toEqual([]);                                                                              // the standard model answered: that was a look
    // neither model gives a usable answer on the finding: that was not a look, and the next call tries again
    let ok = false;
    const unsure = () => (ok ? { stands: false, why: 'settled' } : 'no idea');
    const mute = setup(() => ({}), undefined, { hears: () => ({ affected: ['F1 R1'] }), verify: unsure });
    await deal(mute.repo);
    await finding(mute.repo, 'f_1', 'Lock-up differs', { sources: src });
    val(await question(mute.repo, 'q_12', q12));
    expect(val(await mute.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: [] }); ok = true; expect(val(await mute.ai.responses('d1'))).toEqual({ heard: ['q_12'], marked: ['f_1'] }); expect(mute.hearCalls.length).toBe(2);
    expect(val(await mute.ai.responses('d1')).heard).toEqual([]);
    // a reply that cannot be read, or a service that cannot be reached: nothing is recorded, and the next call asks again
    let n = 0; const bad = setup(() => ({}), undefined, { hears: () => (++n === 1 ? 'I cannot say' : { affected: [] }) }); await deal(bad.repo); await finding(bad.repo, 'f_1', 'Lock-up differs'); val(await question(bad.repo, 'q_12', q12));
    const first = await bad.ai.responses('d1'); expect(!first.ok && first.error).toEqual({ kind: 'failed', message: 'The responses could not be looked at' }); expect(val(await bad.ai.responses('d1')).heard).toEqual(['q_12']); expect(bad.hearCalls.length).toBe(2);
    const off = setup(() => ({}), undefined, { hears: () => { throw Object.assign(new Error('offline'), { code: 'unreachable' }); } }); await deal(off.repo); await finding(off.repo, 'f_1', 'Lock-up differs'); val(await question(off.repo, 'q_12', q12));
    const down = await off.ai.responses('d1'); expect(!down.ok && down.error.kind).toBe('unreachable');
    // two asks at once on one deal: the second waits, and finds nothing left to look at
    const twice = setup(() => ({})); await deal(twice.repo); await finding(twice.repo, 'f_1', 'Lock-up differs'); val(await question(twice.repo, 'q_12', q12));
    const [a, b] = await Promise.all([twice.ai.responses('d1'), twice.ai.responses('d1')]); expect([val(a).heard, val(b).heard]).toEqual([['q_12'], []]); expect(twice.hearCalls.length).toBe(1);
  });
});

describe('checking everything again', () => {
  const start = async (more: Parameters<typeof setup>[2] = {}, say?: Parameters<typeof twelve>[0]) => { const s = setup(twelve(say), { d1: [FA, TS, IM, MODEL] }, { checklist: () => TWELVE, ...more }); await deal(s.repo); const first = val(await s.ai.firstPass('d1')); return { s, f1: first.written[0], n: s.calls.length }; };

  it('the fast model goes over everything, the standard model confirms what it flags and checks a sample of what it passed', async () => {
    // on the second look the fast model doubts point 5; the standard model does not; in the sample the standard model finds the first point it was given has no document behind it
    const lowest = (c: Call) => Math.min(...itemsIn(c).map((it) => numOf(it.text)));
    const { s, f1, n } = await start({}, (k, c) => (c.model === 'fast' && k === 5 ? { result: 'more', need: 'something' } : c.model === 'standard' && s0.done && k !== 5 && k === lowest(c) ? { result: 'more', need: 'a document nobody has' } : undefined));
    expect(val(await s.ai.checked('d1'))).toMatchObject({ offerDeep: null }); expect(val(await s.ai.checked('d1')).at).not.toBeNull();                 // the first pass getting to the end was a check of everything
    s0.done = true; const r = val(await s.ai.checkAll({ dealId: 'd1' }));
    const after = s.calls.slice(n).map((c) => [c.model, itemsIn(c).map((it) => numOf(it.text)).join()]);
    // everything settled, by the fast model; what it flagged; then the sample: five of the eleven it passed (ten items and the finding), drawn by hash from the round's id, so every PC draws the same
    expect(after.slice(0, 2)).toEqual([['fast', '2,3,4,5,6,7,8,9,10,11,12'], ['standard', '5']]); expect(after.length).toBe(3); expect(after[2][0]).toBe('standard');
    const drawn = after[2][1].split(',').map(Number); expect(drawn).not.toContain(5); expect(drawn.length + (s.verifyCalls.length - 1)).toBe(5);
    expect(s.verifyCalls[0].model).toBe('fast'); expect(s.verifyCalls.slice(1).map((c) => c.model)).toEqual(drawn.length === 5 ? [] : ['standard']);   // the one finding: the fast model says it stands; if it was drawn, the standard model looks too
    expect(r).toMatchObject({ items: 11, findings: 1, toReassess: 0, newFindings: 0, sample: { size: 5, overturned: 1 }, offerDeep: false });           // one in five overturned is not more than one in five
    expect(val(await s.ai.gaps('d1'))).toEqual([{ title: `Point ${Math.min(...drawn)} of the finance documents is in order` }]);                       // where they disagree the standard model's answer stands
    expect(val(await s.ai.checked('d1'))).toEqual({ at: r.at, offerDeep: null, left: null }); expect((await findingData(s.repo, f1)).updated ?? false).toBe(false);
  });
  const s0 = { done: false };

  it('a finding the fast model doubts is marked only if the standard model agrees; the mark changes nothing else', async () => {
    const { s, f1 } = await start({ verify: (c) => ({ stands: false, why: 'The term sheet has been replaced.' }) });
    const r = val(await s.ai.checkAll({ dealId: 'd1' })); expect(s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']); expect(r.toReassess).toBe(1);
    expect(await findingData(s.repo, f1)).toMatchObject({ updated: true, updatedWhy: 'Check of everything', title: 'Lock-up ratio differs between the credit agreement and the term sheet', status: 'open' });
    const calm = await start({ verify: (c) => ({ stands: c.model !== 'fast', why: '' }) }); const q = val(await calm.s.ai.checkAll({ dealId: 'd1' }));
    expect(calm.s.verifyCalls.map((c) => c.model)).toEqual(['fast', 'standard']); expect(q.toReassess).toBe(0); expect((await findingData(calm.s.repo, calm.f1)).updated ?? false).toBe(false);
  });

  it('a later explicit check renews the finding warning while keeping the same reason (#326)', async () => {
    const { s: { ai, repo }, f1: findingId } = await start({
      verify: () => ({ stands: false, why: 'The covenant still needs review.' }),
    });
    const request = { dealId: 'd1' };
    expect(val(await ai.checkAll(request)).toReassess).toBe(1);
    const first = val(await repo.get('finding', findingId))!;
    expect(val(await ai.checkAll(request)).toReassess).toBe(1);
    const second = val(await repo.get('finding', findingId))!;
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.envelope.data).toMatchObject({ updated: true, updatedWhy: 'Check of everything' });
  });

  it('pays both checks after a person resolves crossed finding versions (#326)', async () => {
    const shared = new Mem();
    const { s: { ai, repo }, f1: findingId } = await start({
      shared,
      verify: () => ({ stands: false, why: 'The covenant still needs review.' }),
    });
    const finding = await findingData(repo, findingId);
    repo.peer.edit('finding', findingId, { ...finding, note: 'The covenant is still under review.' }, {
      by: 'peer', from: 'Another PC', at: clock(),
    });
    await repo.sync();
    const crossed = val(await repo.get('finding', findingId))!;
    expect(crossed.conflict?.length).toBeGreaterThan(0);
    for (let check = 0; check < 2; check++) val(await ai.checkAll({ dealId: 'd1' }));
    const entries = () => (shared.read('checks-local-d1.jsonl') ?? '').trim().split('\n')
      .map((line) => JSON.parse(line));
    const pending = entries().flatMap((line) => line.owed?.finding === findingId ? [line.owed.round] : []);
    expect(new Set(pending).size).toBe(2);
    val(await repo.transaction({ writes: [{
      kind: 'finding', id: findingId, data: finding, expectedRev: crossed.rev,
      resolves: crossed.conflict!.map((version) => version.id),
    }] }));
    expect(val(await ai.firstPass('d1')).marked).toContain(findingId);
    const paid = entries().flatMap((line) => line.paid?.finding === findingId ? [line.paid.round] : []);
    expect(paid).toEqual(pending);
    expect(await findingData(repo, findingId)).toMatchObject({ updated: true, markedRound: pending[1] });
  });

  it('when the sample overturns more than one in five, a check of everything by the standard model is offered; that check has no sample', async () => {
    const flag = { on: false };
    const two = (c: Call) => itemsIn(c).map((it) => numOf(it.text)).sort((a, b) => a - b).slice(0, 2);                                                  // the two lowest points in the sample's call
    const { s, n } = await start({}, (k, c) => (flag.on && c.model === 'standard' && two(c).includes(k) ? { result: 'more', need: 'a document nobody has' } : undefined));
    flag.on = true; const r = val(await s.ai.checkAll({ dealId: 'd1' }));
    expect(r.sample).toEqual({ size: 5, overturned: 2 }); expect(r.offerDeep).toBe(true); expect(val(await s.ai.checked('d1'))).toEqual({ at: r.at, offerDeep: { size: 5, overturned: 2 }, left: null });
    flag.on = false; const m = s.calls.length; const v = s.verifyCalls.length; const deep = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(s.calls.slice(m).map((c) => [c.model, itemsIn(c).length]).reduce((n, [, k]) => n + (k as number), 0)).toBe(11); expect(s.calls.slice(m).every((c) => c.model === 'standard')).toBe(true);   // every item, each satisfied one from the documents it was settled on
    expect(s.verifyCalls.slice(v).map((c) => c.model)).toEqual(['standard']);
    expect(deep).toMatchObject({ sample: null, offerDeep: false }); expect(val(await s.ai.checked('d1'))).toEqual({ at: deep.at, offerDeep: null, left: null }); expect(val(await s.ai.gaps('d1'))).toEqual([]);
    expect(n).toBeGreaterThan(0);
  });

  it('a check held up because no one is signed in says so, not that the service is down', async () => {
    const out = await start({ timing: { lapse: 5000, retryFirst: 20, retryMax: 100, watch: 10, giveUp: 200, retryEvery: 60_000 }, now: () => Date.now() }); out.s.svc.script = () => { throw signedOut(); };
    const r = await out.s.ai.checkAll({ dealId: 'd1' }); expect(!r.ok && r.error).toEqual({ kind: 'rejected', message: `Waiting for ${SERVICE} sign-in. The check resumes once someone signs in.` });
    (out.s.ai as any).close();
  }, 20000);

  it('a check asked for by one document arriving does not count as everything checked; nor is there anything to check without documents', async () => {
    const { s } = await start(); const at = val(await s.ai.checked('d1')).at;
    s.recs.d1.push(doc(34, 'Lunch menu.pdf', { summary: 'Canteen menu.' })); val(await s.ai.firstPass('d1')); expect(val(await s.ai.checked('d1')).at).toBe(at);
    const bare = setup(twelve(), { d1: [] }, { checklist: () => TWELVE }); await deal(bare.repo); const r = await bare.ai.checkAll({ dealId: 'd1' }); expect(!r.ok && r.error).toEqual({ kind: 'rejected', message: 'No documents have been indexed for this deal yet' });
    expect(val(await bare.ai.checked('d1'))).toEqual({ at: null, offerDeep: null, left: null });
    // a model service that cannot be reached: the check is tried again for a while (two minutes in the product, short here); then the person is told it will carry on by itself, and it does once the service is back
    const down = await start({ timing: { lapse: 5000, retryFirst: 20, retryMax: 100, watch: 10, giveUp: 300, retryEvery: 50 }, now: () => Date.now() }); const was = down.s.svc.script; down.s.svc.script = () => { const e: any = new Error('ECONNREFUSED'); e.code = 'unreachable'; throw e; };
    const t0 = Date.now(); const d = await down.s.ai.checkAll({ dealId: 'd1' }); expect(!d.ok && d.error).toEqual({ kind: 'rejected', message: 'Intelligence can’t be reached. The check resumes once Intelligence is back.' }); expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(val(await down.s.ai.checked('d1')).checking).toMatchObject({ away: true });
    down.s.svc.script = was; const end = Date.now() + 5000; let told: unknown; while (Date.now() < end && !told) { await new Promise((r) => setTimeout(r, 50)); told = val(await down.s.ai.checked('d1')).ended; }
    expect(told).toMatchObject({ summary: { items: 11, unchecked: { items: 0, findings: 0 } } }); (down.s.ai as any).close();
  }, 20000);
});

describe('documents and runners together, on a real folder', () => {
  it('index, first pass, ask: every citation that comes back opens, and only what was read was sent or described', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { nodeDocuments } = await import('../../src/backend/documents'); const { nodeFolder } = await import('../../src/backend/nodeFolder');
    const pdf = (text: string, pages: number) => { const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
      for (let i = 0; i < pages; i++) { const st = `BT /F1 12 Tf 72 720 Td (${text} ${i + 1}) Tj ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${st.length} >>\nstream\n${st}\nendstream`); }
      let out = '%PDF-1.4\n'; const at: number[] = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; }); const x = out.length;
      return new TextEncoder().encode(out + `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`); };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-ai-')); const vdr = path.join(root, 'vdr'); fs.mkdirSync(path.join(vdr, '01 Finance'), { recursive: true }); fs.mkdirSync(path.join(vdr, '09 Misc'));
    fs.writeFileSync(path.join(vdr, '01 Finance', 'Credit Agreement.pdf'), pdf('facility', 20)); fs.writeFileSync(path.join(vdr, '01 Finance', 'Term sheet.pdf'), pdf('term sheet', 5)); fs.writeFileSync(path.join(vdr, '09 Misc', 'Lunch menu.pdf'), pdf('menu', 1));
    const svc = new StandInService((c) => {
      const call = c as Call; const d = (name: string) => new RegExp(`^(D\\d+): (?:.*/)?${name}`, 'm').exec(call.prompt)?.[1];
      if (call.prompt.startsWith('Describe the document')) { const name = /Describe the document (.*)\.\n/.exec(call.prompt)![1]; return JSON.stringify({ summary: `This is ${name}.`, keywords: ['lock-up'] }); }
      if (itemsIn(call).length) return JSON.stringify({ items: itemsIn(call).map((it) => (/lock-up/.test(it.text) ? { id: it.tag, result: 'finding', title: 'Lock-up differs', workstream: 'Legal', body: ['One says 1.25x. [1] The other 1.30x. [2]'], next: 'Ask counsel.', sources: [{ doc: d('Credit Agreement.pdf'), page: 14 }, { doc: d('Term sheet.pdf'), page: 3 }] } : { id: it.tag, result: 'more', need: 'model audit report' })) });
      return JSON.stringify({ text: 'It is 1.25x in the agreement. [1]', sources: [{ doc: d('Credit Agreement.pdf'), page: 14 }] });
    });
    const shared = nodeFolder(path.join(root, 'shared')), local = nodeFolder(path.join(root, 'local')); const keeper = new StoreKeeper(svc, local, { recheckMs: 0 }); const repo = memRepo(); await deal(repo);
    const passes: Promise<unknown>[] = []; let ai: ReturnType<typeof nodeAi>;
    const docs = nodeDocuments({ shared, local, sharedPath: path.join(root, 'shared'), installId: 'office', keeper, folders: async () => [vdr], onIndexed: (d) => { passes.push(ai.firstPass(d)); } });
    ai = nodeAi({ service: svc, docs: { records: docs.records, wanted: docs.wanted, describe: docs.describe, undescribed: docs.undescribed }, keeper, repo, shared, installId: 'office', checklist: () => ({ broad: [{ id: 'b1', text: 'The lock-up ratio is the same in the credit agreement and the term sheet' }], product: [], sector: [{ id: 's1', text: 'The model has been audited' }] }) });
    val(await docs.index('d1', [{ path: vdr, label: 'VDR', files: 0, size: '', indexed: 0, reviewed: 0 }])); await docs.settled('d1'); await Promise.all(passes);
    expect(docs.records('d1').map((r) => [r.rel, r.pages, r.words, r.summary])).toEqual([['01 Finance/Credit Agreement.pdf', 20, ['facility'], 'This is Credit Agreement.pdf.'], ['01 Finance/Term sheet.pdf', 5, ['sheet', 'term'], 'This is Term sheet.pdf.'], ['09 Misc/Lunch menu.pdf', 1, ['menu'], undefined]]);   // indexing counted the words; only the two that were read were described
    expect(svc.uploads).toBe(2);                                                                                                                // and only those two were ever sent
    const found = val(await repo.list('finding', 'd1')).map((l) => l.envelope.data as { title: string; sources: { doc: string; docId: string; loc: string }[] }); expect(found.map((f) => f.title)).toEqual(['Lock-up differs']);
    const a = val(await ai.answer({ dealId: 'd1', message: 'What is the lock-up?', history: [], model: 'standard' })); expect(a.sources.length).toBe(1);
    for (const src of [...found[0].sources, ...a.sources]) expect(val(await docs.page('d1', { doc: src.doc, docId: src.docId }, src.loc))).toMatchObject({ kind: 'pdf', page: Number(src.loc.slice(3)) });
    expect(val(await ai.gaps('d1'))).toEqual([{ title: 'The model has been audited' }]);
    expect(fs.readdirSync(path.join(root, 'shared')).filter((n) => n.startsWith('checks-'))).toEqual(['checks-office-d1.jsonl']);                       // beside the deal's other shared files, and a second window on the same folder reads it
    expect(val(await nodeAi({ service: svc, docs: { records: docs.records, wanted: docs.wanted }, keeper, repo, shared, installId: 'home' }).gaps('d1'))).toEqual([{ title: 'The model has been audited' }]);
    await ai.described('d1'); expect(svc.calls.filter((c) => c.prompt.startsWith('Describe')).length).toBe(2);                                          // two documents read, two descriptions, once each
    expect(svc.calls.filter(isCoreAsk).length).toBe(0);                                                                        // and no model is asked which are core
    fs.rmSync(root, { recursive: true, force: true });
  });
});
