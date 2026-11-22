// @vitest-environment node
// Reading an issues list on a real model. It runs only when PUNCHLIST_AI_KEY is set, and is skipped otherwise.
// Light: every call goes to Haiku, at most 10 calls. A two-page PDF list of seven points: one repeats a finding already
// raised, one repeats an earlier point, the rest are new, and a heading and a closing note raise nothing.
//   PUNCHLIST_AI_KEY=… NODE_USE_ENV_PROXY=1 npx vitest run tests/e2e/live-issues.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { tmp, pdf, pcApp } from './kit';
import { claudeService } from '../../src/backend/claude';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding } from '../../src/app/commands/findings';
import { ImportIssuesList } from '../../src/app/commands/issuesList';
import { dealFindings } from '../../src/app/state';
import { WORKSTREAMS } from '../../src/domain/model';

const KEY = process.env.PUNCHLIST_AI_KEY;
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe.skipIf(!KEY)('an issues list on Claude (live)', () => {
  it('reads every point in its words, finds the repeat of a finding and of an earlier point, and imports them', async () => {
    const root = tmp(); roots.push(root);
    const service = claudeService({ key: KEY!, maxCalls: 10 });
    const A = await pcApp(root, 'Office', { service, user: 'Live test' });
    try {
      await A.store.dispatch(CreateDeal, { name: 'Proseware live', folders: [] }); const dealId = Object.values(A.store.get().deals)[0].id; await A.store.loadDeal(dealId);
      for (const [title, body] of [['Change of control definition omits the sponsor fund vehicles', 'The definition of Change of Control covers the Sponsor only, not its affiliated funds.'], ['Debt service reserve may be funded by a letter of credit from an unrated bank', 'Any bank may issue the DSRA letter of credit.'], ['Insurance broker letter not yet provided', 'The broker letter on the insurance program is missing.']] as const) await A.store.dispatch(CreateFinding, { dealId, title, workstream: 'Legal', body: [body] }, { quiet: true });
      const list = pdf([
        'Credit Agreement - Issues List - Sponsor counsel, November 14, 2026. 1. Definition of Change of Control should include the Sponsor affiliated funds and managed accounts. 2. Commitment fee should step down to 30% of the margin after the term conversion date. 3. The Lenders should not have a veto over replacement of the O&M contractor where the replacement is a Qualified Operator. 4. Hedging debt in the Permitted Indebtedness basket should be capped at the notional of the Hedging Policy.',
        '5. Tax gross-up should exclude FATCA deductions. 6. The Permitted Indebtedness basket for hedging debt needs a cap at the Hedging Policy notional, as raised above. 7. Governing law of the Accounts Agreement should be New York. These comments are subject to further review by our client.',
      ]);
      const doc = await A.store.services.docs.attach(dealId, { name: 'Issues List - Sponsor counsel (Nov 14).pdf', bytes: list }); if (!doc.ok) throw new Error(doc.error.message);
      const open = dealFindings(A.store.get(), dealId);
      const r = await A.store.services.ai.issuesList!({ dealId, doc: doc.value, findings: open.map((f) => ({ id: f.id, title: f.title, text: f.body[0] ?? '' })), workstreams: WORKSTREAMS });
      if (!r.ok) throw new Error(r.error.message);
      const ps = r.value.points;
      console.log(JSON.stringify(ps.map((p) => ({ n: p.n, title: p.title, ws: p.workstream, same: p.same })), null, 1));
      expect(ps.map((p) => p.n)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
      expect(ps[0].text).toContain('Definition of Change of Control should include the Sponsor affiliated funds');
      const coc = open.find((f) => f.title.startsWith('Change of control'))!;
      expect(ps[0].same).toEqual({ finding: coc.id });
      expect(ps[5].same).toEqual({ point: 3 });
      expect(ps.filter((p) => p.same).length).toBe(2);
      expect(ps.every((p) => p.title && WORKSTREAMS.includes(p.workstream))).toBe(true);
      const imported = await A.store.dispatch(ImportIssuesList, { dealId, doc: doc.value.docId, list: doc.value.doc, points: ps.map((p) => ({ n: p.n, text: p.text, title: p.title, workstream: p.workstream, ...(p.same ? ('finding' in p.same ? { join: p.same.finding } : { after: p.same.point }) : {}) })) });
      expect(imported.ok).toBe(true);
      expect(dealFindings(A.store.get(), dealId).length).toBe(3 + 5);
    } finally { A.backend.close(); }
  }, 240_000);
});
