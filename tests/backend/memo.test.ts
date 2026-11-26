// @vitest-environment node
// The deal memo's model-written parts: a rating of each open finding, kept in the deal's shared check log until the
// finding's words change, and a summary of facts with no advice in it.
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiDocs } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import type { Folder } from '../../src/backend/logRepository';
import { TOO_LONG_REPLY } from '../../src/backend/limits';
import { memoContent, type Rating } from '../../src/domain/memo';
import { memoDocument } from '../../src/domain/memoDoc';
import { memRepo, type MemRepo } from '../adapters/memRepo';
import { scaleMemoInput } from '../fixtures/memoScale';

class Mem implements Folder { files = new Map<string, string>(); list() { return [...this.files.keys()]; } size(n: string) { return this.files.get(n)?.length ?? -1; } read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); } }
type Call = { model: string; prompt: string };
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 15, 9, 0, 0, t++)).toISOString();
const isRate = (c: Call) => c.prompt.startsWith('Rate each of these open findings');
const isGroup = (c: Call) => c.prompt.startsWith('These are the open findings on a deal, each with');

/** a backend on a stand-in model: `rate` answers the asks for ratings, `sum` those for the summary; `shared` is the deal's shared folder, `pc` this PC */
function setup(rate: (c: Call, n: number) => unknown, sum: (c: Call, n: number) => unknown = () => ({ paragraphs: ['A solar project. The yield is above the advisor’s figure.'] }), shared = new Mem(), repo: MemRepo = memRepo(clock), pc = 'pc1', group: (c: Call) => unknown = () => ({ risks: [] })) {
  const rates: Call[] = []; const sums: Call[] = []; const groups: Call[] = [];
  const svc = new StandInService((c) => { const call = c as Call; const r = isRate(call) ? (rates.push(call), rate(call, rates.length)) : isGroup(call) ? (groups.push(call), group(call)) : (sums.push(call), sum(call, sums.length)); return typeof r === 'string' ? r : JSON.stringify(r); });
  const docs: AiDocs = { records: () => [], wanted: async () => [] };
  const keeper = new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock });
  // retries without the waits
  const retry = { sleep: async () => {} };
  const ai = nodeAi({ service: svc, docs, keeper, repo, shared, installId: pc, clock, retry });
  return { ai, rates, sums, groups, repo, shared };
}
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
async function deal(repo: MemRepo) { val(await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Project Southridge', counterparty: 'Southridge Solar', sector: 'Solar' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } })); }
async function finding(repo: MemRepo, id: string, title: string, extra: object = {}, rev: number | null = null) { val(await repo.transaction({ writes: [{ kind: 'finding', id, data: { id, dealId: 'd1', title, workstream: 'Technical', status: 'open', body: ['As written. [1]'], sources: [], ...extra }, expectedRev: rev }], index: { dealId: 'd1', add: [{ kind: 'finding', id }] } })); }
/** rate every finding the ask lists as given, by id */
const by = (given: Record<string, string>) => (c: Call) => ({ ratings: [...c.prompt.matchAll(/^(f_\w+) \(/gm)].map((m) => ({ id: m[1], rating: given[m[1]] })) });

const SCALE_FINDINGS = scaleMemoInput.findings.filter((f) => f.status === 'open');
const UNRESOLVED = 'there are open findings with unresolved ratings';
const HIGH_RISKS = 'each of these High risks in one sentence';
const NO_HIGH = 'that no open risk is rated High';
const NO_OPEN = 'that it has no open findings';

function summaryFromPrompt({ prompt }: Call) {
  const risks: string[] = [];
  if (prompt.includes(UNRESOLVED)) risks.push('Open findings have unresolved ratings.');
  if (prompt.includes(HIGH_RISKS)) risks.push('The model uses a higher yield than the advisor’s estimate.');
  if (prompt.includes(NO_HIGH)) risks.push('No open risk is rated High.');
  if (prompt.includes(NO_OPEN)) risks.push('The deal has no open findings.');
  return { paragraphs: ['The proposed financing is for a solar project with battery storage.', risks.join(' ')] };
}

const ratingCases = [
  { name: 'all missing', rated: 0, expected: [UNRESOLVED] },
  { name: 'some missing', rated: 4, expected: [UNRESOLVED] },
  { name: 'some missing with a known High', rated: 1, firstRating: 'High', expected: [UNRESOLVED, HIGH_RISKS] },
  { name: 'all present', rated: SCALE_FINDINGS.length, expected: [NO_HIGH] },
  { name: 'no open findings', rated: 0, closedOnly: true, expected: [NO_OPEN] },
] as const;

async function scriptedScaleMemo(testCase: (typeof ratingCases)[number]) {
  const findings = 'closedOnly' in testCase ? scaleMemoInput.findings.map((f) => ({ ...f, status: 'closed' as const }))
    : scaleMemoInput.findings;
  const ratings = Object.fromEntries(SCALE_FINDINGS.slice(0, testCase.rated).map((f): [string, Rating] => [
    f.id, 'firstRating' in testCase ? testCase.firstRating : 'Low',
  ]));
  const rate = by(ratings);
  const reply = (call: Call) => ({ ratings: rate(call).ratings.filter((row) => row.rating) });
  const s = setup(reply, summaryFromPrompt);
  await deal(s.repo);
  for (const f of findings) await finding(s.repo, f.id, f.title, { ...f, dealId: 'd1' });
  const result = val(await s.ai.memo!('d1'));
  const content = memoContent({
    ...scaleMemoInput, findings, summary: result.summary, ratings: result.ratings, groups: result.risks,
  });
  const [pageOne] = memoDocument(content, 'AI').split('<text:h text:style-name="HBreak"');
  return { actualRatings: result.ratings, expectedRatings: ratings, sums: s.sums, pageOne };
}

describe('the deal memo’s ratings and summary', () => {
  it('rates each open finding against the definitions, and with none rates nothing but still says what the deal is', async () => {
    const s = setup(by({ f_1: 'High', f_2: 'low' })); await deal(s.repo);
    expect(val(await s.ai.memo!('d1'))).toEqual({ summary: ['A solar project. The yield is above the advisor’s figure.'], ratings: {}, risks: [] });
    expect(s.rates.length).toBe(0); expect(s.sums.length).toBe(1); expect(s.sums[0].prompt).toContain('that it has no open findings');
    s.sums.length = 0;
    await finding(s.repo, 'f_1', 'Yield above the advisor’s'); await finding(s.repo, 'f_2', 'Notice address differs'); await finding(s.repo, 'f_3', 'Closed one', { status: 'closed' });
    const m = val(await s.ai.memo!('d1'));
    expect(m.ratings).toEqual({ f_1: 'High', f_2: 'Low' });
    expect(s.rates[0].model).toBe('standard');
    expect(s.rates[0].prompt).toContain('High: Affects price, structure or whether the deal can close.');
    expect(s.rates[0].prompt).toContain('f_1 (Technical): Yield above the advisor’s. As written.'); expect(s.rates[0].prompt).not.toContain('Closed one');
    expect(m.summary).toEqual(['A solar project. The yield is above the advisor’s figure.']);
    expect(s.sums[0].prompt).toContain('Project Southridge; Southridge Solar; Solar'); expect(s.sums[0].prompt).toContain('- Yield above the advisor’s: (Technical) Yield above the advisor’s. As written.');
  });

  it('keeps a rating in the shared log until the finding’s words change, so another PC’s memo agrees and asks nothing', async () => {
    const a = setup(by({ f_1: 'High', f_2: 'Medium' })); await deal(a.repo); await finding(a.repo, 'f_1', 'One'); await finding(a.repo, 'f_2', 'Two');
    val(await a.ai.memo!('d1')); expect(a.rates.length).toBe(1);
    const b = setup(by({ f_1: 'Low', f_2: 'Low' }), undefined, a.shared, a.repo, 'pc2');
    expect(val(await b.ai.memo!('d1')).ratings).toEqual({ f_1: 'High', f_2: 'Medium' }); expect(b.rates.length).toBe(0);
    // a review mark changes the record, not its words: the rating holds
    await finding(a.repo, 'f_2', 'Two', { reviewed: { by: 'sroe', at: clock() } }, 1);
    val(await b.ai.memo!('d1')); expect(b.rates.length).toBe(0);
    // new words: rated again, and only that one
    await finding(a.repo, 'f_2', 'Two', { body: ['Rewritten. [1]'] }, 2);
    expect(val(await b.ai.memo!('d1')).ratings).toEqual({ f_1: 'High', f_2: 'Low' });
    expect(b.rates.length).toBe(1); expect(b.rates[0].prompt).toContain('f_2 (Technical)'); expect(b.rates[0].prompt).not.toContain('f_1 (Technical)');
  });

  it('asks again for what a reply left out or got wrong, then the thorough model, and leaves unrated what none could rate', async () => {
    const s = setup((c, n) => (n === 1 ? { ratings: [{ id: 'f_1', rating: 'Severe' }, { id: 'f_404', rating: 'High' }, { id: 'f_2', rating: 'Medium' }] } : n === 2 ? 'no' : { ratings: [] }));
    await deal(s.repo); await finding(s.repo, 'f_1', 'One'); await finding(s.repo, 'f_2', 'Two');
    const m = val(await s.ai.memo!('d1'));
    expect(m.ratings).toEqual({ f_2: 'Medium' });
    expect(s.rates.filter((c) => !c.prompt.includes('It cannot be read as written')).map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
    expect(s.rates[1].prompt).toContain('f_1 (Technical)'); expect(s.rates[1].prompt).not.toContain('f_2 (Technical)');
  });

  it('sends back a summary that advises, and fails the memo if it still does (#1065)', async () => {
    const advice = { paragraphs: ['A solar project. The lenders should insist on a higher contingency.'] };
    const once = setup(by({ f_1: 'High' }), (_c, n) => (n === 1 ? advice : { paragraphs: ['A solar project. Contingency is 4% of EPC.'] }));
    await deal(once.repo); await finding(once.repo, 'f_1', 'One');
    expect(val(await once.ai.memo!('d1')).summary).toEqual(['A solar project. Contingency is 4% of EPC.']);
    expect(once.sums[1].prompt).toContain('That gives advice or a judgment. Write it again with facts only.');
    const never = setup(by({ f_1: 'High' }), () => advice); await deal(never.repo); await finding(never.repo, 'f_1', 'One');
    const m = await never.ai.memo!('d1');
    expect(!m.ok && m.error.kind).toBe('failed');
    expect(never.sums.map((c) => c.model)).toEqual(['standard', 'standard', 'thorough']);
  });

  it('fails the memo, rather than leave its summary blank, when every summary call fails (#1065)', async () => {
    const serverError = () => { throw Object.assign(new Error('Internal server error'), { status: 500 }); };
    const s = setup(by({ f_1: 'High' }), serverError);
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'One');
    const r = await s.ai.memo!('d1');
    expect(!r.ok && r.error).toEqual({ kind: 'failed', message: 'The summary could not be written' });
    expect(s.sums.length).toBeGreaterThan(1);   // retried before it fails
  });

  it('fails the memo with the too-long-reply failure, and saves nothing, when the summary is cut off (#1065)', async () => {
    const cut = () => { throw Object.assign(new Error('cut off'), { code: 'cutoff' }); };
    const s = setup(by({ f_1: 'High' }), cut);
    await deal(s.repo);
    await finding(s.repo, 'f_1', 'One');
    const r = await s.ai.memo!('d1');
    expect(!r.ok && r.error).toEqual({ kind: 'failed', message: TOO_LONG_REPLY });
  });

  it('rates a deal with many findings a part at a time', async () => {
    const s = setup((c) => ({ ratings: [...c.prompt.matchAll(/^(f_\w+) \(/gm)].map((m) => ({ id: m[1], rating: 'Low' })) })); await deal(s.repo);
    for (let k = 0; k < 45; k++) await finding(s.repo, `f_${k}`, `Finding ${k}`);
    const m = val(await s.ai.memo!('d1'));
    expect(Object.keys(m.ratings).length).toBe(45); expect(s.rates.map((c) => c.prompt.match(/^f_\w+ \(/gm)!.length)).toEqual([40, 5]);
  });

  it.each(ratingCases)('reports the state of open-finding ratings at scale with $name', async (testCase) => {
    const { actualRatings, expectedRatings, sums, pageOne } = await scriptedScaleMemo(testCase);
    expect(SCALE_FINDINGS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SCALE_FINDINGS.map((f) => f.workstream)).size).toBeGreaterThan(3);
    expect(actualRatings).toEqual(expectedRatings);
    expect(sums).toHaveLength(1);
    const instructions = [UNRESOLVED, HIGH_RISKS, NO_HIGH, NO_OPEN].filter((text) => sums[0].prompt.includes(text));
    expect(instructions).toEqual(testCase.expected);

    const hasMissing = !('closedOnly' in testCase) && testCase.rated < SCALE_FINDINGS.length;
    if (hasMissing) {
      expect(pageOne).toContain('Open findings have unresolved ratings.');
      expect(pageOne).toContain(`, ${SCALE_FINDINGS.length - testCase.rated} unrated.`);
      expect(pageOne).not.toMatch(/no open (finding|risk) is rated High/i);
    } else {
      expect(pageOne).not.toMatch(/unrated|unresolved ratings/);
    }
    if ('firstRating' in testCase) {
      expect(sums[0].prompt).toContain(SCALE_FINDINGS[0].title);
      expect(pageOne).toContain('The model uses a higher yield than the advisor’s estimate.');
    }
    const count = 'closedOnly' in testCase ? 'No open findings.' : `${SCALE_FINDINGS.length} open findings`;
    expect(pageOne).toContain(count);
  });

  it('keeps a summary that reports what a document requires', async () => {
    const terms = { paragraphs: ['The credit agreement says the borrower should maintain a DSCR of 1.20x. The advisor recommends a P90 case.'] };
    const s = setup(by({ f_1: 'High' }), () => terms); await deal(s.repo); await finding(s.repo, 'f_1', 'One');
    expect(val(await s.ai.memo!('d1')).summary).toEqual(terms.paragraphs); expect(s.sums.length).toBe(1);
  });

  it('never shows an id the model wrote, nor a link or citation marker', async () => {
    const s = setup(by({ f_1: 'High' }), () => ({ paragraphs: ['The {yield gap|f_1} is f_1, as cited. [1]'] })); await deal(s.repo); await finding(s.repo, 'f_1', 'One');
    const [p] = val(await s.ai.memo!('d1')).summary; expect(p).not.toMatch(/f_1|\[1\]|\{/); expect(p).toContain('yield gap');
  });

  it('fails as unreachable when the model service is', async () => {
    const s = setup(() => { const e: any = new Error('down'); e.code = 'unreachable'; throw e; }); await deal(s.repo); await finding(s.repo, 'f_1', 'One');
    const r = await s.ai.memo!('d1'); expect(!r.ok && r.error.kind).toBe('unreachable');
  });
});
