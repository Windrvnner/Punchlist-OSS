// The stand-ins for the review-*.test.ts files: the same ones ai.test.ts uses, cut down.
import { expect } from 'vitest';
import { nodeAi, type AiDocs, type AiOptions, type UsageEntry } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper, fromStoreName } from '../../src/backend/storeKeeper';
import { memRepo, Mem } from '../adapters/memRepo';
import type { Repository } from '../../src/ports';
import type { DocRecord } from '../../src/backend/documents';

export { Mem };
export const doc = (n: number, name: string, extra: Partial<DocRecord> = {}): DocRecord => ({ docId: `doc_${String(n).padStart(24, '0')}`, hash: 'h', name, folder: 'vdr', rel: name, size: 1, ...(/\.xlsx$/.test(name) ? {} : { pages: 40 }), ...extra });
export type Call = { model: string; system?: string; prompt: string; files: { id: string; name: string; text: string }[] };
export const sentNames = (c: Call) => c.files.map((f) => fromStoreName(f.name)!.name).sort();
let t = 0; export const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, t++)).toISOString();

export const isCoreAsk = (c: { prompt: string }) => c.prompt.includes('Which are the core documents');
export const isFixAsk = (c: { prompt: string }) => c.prompt.includes('It cannot be read as written');
export const isAffectsAsk = (c: { prompt: string }) => c.prompt.includes('Which of them could the new documents change?');
export const isVerifyAsk = (c: { prompt: string }) => c.prompt.includes('does it still stand as written?') || c.prompt.includes('does it stay closed?');
export const isPickAsk = (c: { prompt: string }) => c.prompt.includes('Which of them should be read for this?');
export const isQueryAsk = (c: { prompt: string }) => c.prompt.includes('write up to 3 short searches');
export const isPickForAsk = (c: { prompt: string }) => c.prompt.includes('Which of them should be read for each of these?');
export const isDescribeAsk = (c: { prompt: string }) => c.prompt.startsWith('Describe the document ');
export const isHearAsk = (c: { prompt: string }) => c.prompt.includes('Which findings could a response change?');
/**
 * A satisfied result that says where, as a real reply must: the first document in the call that has pages, at page 1
 * (or, with only spreadsheets, a cell of the first). In the fast model's quick look no place is asked for, and none is given.
 */
export const OK = (c: Call): { result: string; where?: object[] } => {
  if (!c.prompt.includes('Add "where"')) return { result: 'ok' };
  const docs = [...c.prompt.split('\n\nCheck each of these')[0].matchAll(/^(D\d+): ([^\n]*)$/gm)]; const paged = docs.find((m) => !/\.(xlsx|xlsm|xlsb|xls|ods|csv)\b/i.test(m[2]));
  return paged ? { result: 'ok', where: [{ doc: paged[1], page: 1, quote: 'As the item requires.' }] } : docs[0] ? { result: 'ok', where: [{ doc: docs[0][1], sheet: 'Sheet1', cell: 'A1' }] } : { result: 'ok' };
};
export const itemsIn = (c: Call) => c.prompt.includes('write up to 3 short searches') ? [] : [...c.prompt.split('\n\nGive each item one')[0].matchAll(/^(I\d+): (.*)$/gm)].map((m) => ({ tag: m[1], text: m[2] }));
/** the rows of a numbered listing (core or pick prompt): number and path */
export const listed = (c: Call) => [...c.prompt.matchAll(/^(\d+)\*?: ([^\n]*)$/gm)].map((m) => ({ n: +m[1], line: m[2], path: m[2].split(' — ')[0] }));

/** what the stand-in fast model knows short names to stand for, as a real one would */

type Hook = (c: Call, n: number) => unknown;
/** a call made while a check hands the items it left open to the chat agent (`fill`): its turns and its search helper's reads */
export const isFillAsk = (c: { prompt: string }) => c.prompt.includes('were not settled by the documents first chosen for them');
/** what the stand-in says when a check fills its gaps, unless a test says otherwise: the agent finds nothing more */
const nothingMore = (c: Call) => (c.system?.includes('You work in turns') ? { text: 'Nothing in the data room settles them.', sources: [] } : { text: '', sources: [] });
export function setup(script: Hook, recs: Record<string, DocRecord[]>, more: Partial<AiOptions> & { pick?: Hook; fix?: Hook; affects?: Hook; verify?: Hook; hears?: Hook; pickFor?: Hook; query?: Hook; fill?: Hook; describes?: boolean; describe?: Hook; wanted?: AiDocs['wanted']; away?: AiDocs['away'] } = {}) {
  const calls: Call[] = []; const coreCalls: Call[] = []; const pickCalls: Call[] = []; const fixCalls: Call[] = []; const affectCalls: Call[] = []; const verifyCalls: Call[] = []; const hearCalls: Call[] = []; const pickForCalls: Call[] = []; const queryCalls: Call[] = []; const describeCalls: Call[] = []; const fillCalls: Call[] = []; const usage: UsageEntry[] = []; const all: Call[] = [];
  const { pick = () => 'I cannot say', fix = () => '{}', affects = () => 'I cannot say', verify = () => ({ stands: true, why: '' }), hears = () => ({ affected: [] }), pickFor = () => 'I cannot say', query = () => 'I cannot say', fill = nothingMore, describes = false, describe = (c: Call) => ({ summary: `This is ${/Describe the document (.*)\.\n/.exec(c.prompt)![1]}.`, keywords: ['described'] }), wanted, away, ...options } = more;
  const svc = new StandInService((c) => { const call = c as Call; all.push(call); const r = isFillAsk(call) ? (fillCalls.push(call), fill(call, fillCalls.length)) : isFixAsk(call) ? (fixCalls.push(call), fix(call, fixCalls.length)) : isDescribeAsk(call) ? (describeCalls.push(call), describe(call, describeCalls.length)) : isHearAsk(call) ? (hearCalls.push(call), hears(call, hearCalls.length)) : isAffectsAsk(call) ? (affectCalls.push(call), affects(call, affectCalls.length)) : isVerifyAsk(call) ? (verifyCalls.push(call), verify(call, verifyCalls.length)) : isCoreAsk(call) ? (coreCalls.push(call), {}) : isQueryAsk(call) ? (queryCalls.push(call), query(call, queryCalls.length)) : isPickForAsk(call) ? (pickForCalls.push(call), pickFor(call, pickForCalls.length)) : isPickAsk(call) ? (pickCalls.push(call), pick(call, pickCalls.length)) : (calls.push(call), script(call, calls.length)); return typeof r === 'string' ? r : JSON.stringify(r); });
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  const docs: AiDocs = { records: (d) => recs[d] ?? [], wanted: wanted ?? (async (d, ids) => (recs[d] ?? []).filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) }))),
    ...(away ? { away } : {}),
    ...(describes ? { describe: (d: string, id: string, r: { summary: string; keywords: string[] }) => { recs[d] = recs[d].map((x) => (x.docId !== id || x.summary !== undefined ? x : { ...x, ...r })); } } : {}) };
  const repo = options.repo ?? memRepo(clock); let n = 0;
  const ai = nodeAi({ service: svc, docs, keeper, usage: (e) => usage.push(e), clock, newId: () => `01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}`, retry: { sleep: async () => {} }, ...options, repo });
  return { ai, svc, all, calls, fillCalls, coreCalls, pickCalls, pickForCalls, queryCalls, fixCalls, affectCalls, verifyCalls, hearCalls, describeCalls, usage, repo, recs };
}
export const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
export const ask = (message: string, extra: object = {}) => ({ dealId: 'd1', message, history: [], model: 'standard', ...extra });
export async function deal(repo: Repository, id = 'd1', name = 'Project Proseware') { val(await repo.transaction({ writes: [{ kind: 'deal', id, data: { id, name }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id }] } })); }
export async function finding(repo: Repository, id: string, title: string, extra: object = {}) { val(await repo.transaction({ writes: [{ kind: 'finding', id, data: { id, dealId: 'd1', title, workstream: 'Legal', status: 'open', body: ['As written. [1]'], sources: [], ...extra }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'finding', id }] } })); }
export async function question(repo: Repository, id: string, n: number, text: string, response: string, extra: object = {}) { val(await repo.transaction({ writes: [{ kind: 'question', id, data: { id, dealId: 'd1', n, text, response, ...extra }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id }] } })); }
/** what the checks file says, by item */
export const checkLines = (shared: Mem) => [...shared.files].filter(([n]) => n.startsWith('checks-')).flatMap(([, t]) => t.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
/** the items a per-item pick was asked about, by tag */
export const thingsIn = (c: Call) => [...c.prompt.split('Which of them should be read for each of these?')[1].matchAll(/^(I\d+): /gm)].map((m) => m[1]);
