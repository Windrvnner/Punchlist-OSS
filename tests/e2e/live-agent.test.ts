// @vitest-environment node
// The chat agent on a real model: one question, with no checklist, so nothing else is asked. It runs only through
// npm run e2e:live, every call on Haiku, capped at 20 calls.
//   npm run e2e:live -- tests/e2e/live-agent.test.ts
// It asserts what must hold whatever the model says: the turns and the search helper's replies were read, the answer
// has the plain fact, every citation opens a page of a real document, and the steps came back with it.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, pcApp, newDeal } from './kit';
import { claudeService } from '../../src/backend/claude';

// only on a run that asks for live calls (npm run e2e:live sets PUNCHLIST_LIVE=1), never because a key is set
const KEY = process.env.PUNCHLIST_LIVE === '1' ? process.env.PUNCHLIST_AI_KEY : undefined;
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe.skipIf(!KEY)('the chat agent on Claude (live)', () => {
  it('searches, reads, and answers with citations that open', async () => {
    const root = tmp(); roots.push(root); const vdr = path.join(root, 'vdr');
    put(vdr, '01 Finance/Credit Agreement.pdf', pdf('Clause 21.3 Distribution lock-up. The Borrower may make a Distribution only if the historic DSCR is at least 1.25x', 2));
    put(vdr, '01 Finance/Term sheet signed.pdf', pdf('Term sheet. Distribution lock-up DSCR 1.30x. Signed by the Lenders and the Borrower on November 4, 2026', 2));
    put(vdr, '09 Misc/Lunch menu.pdf', pdf('Lunch menu. Soup and sandwiches'));
    const service = claudeService({ key: KEY!, maxCalls: 20 });
    const A = await pcApp(root, 'Office', { service, user: 'Live test' });
    try {
      const dealId = await newDeal(A, 'Proseware agent', vdr);
      const a = await A.backend.ai.answer({ dealId, message: 'What distribution lock-up ratio does the credit agreement set, and does the term sheet agree?', history: [], model: 'standard' });
      expect(a.ok, a.ok ? '' : a.error.message).toBe(true); if (!a.ok) return;
      console.log(`answer: ${a.value.text}\nsources: ${JSON.stringify(a.value.sources)}\nsteps: ${JSON.stringify(a.value.research?.steps.map((s) => `${s.text} → ${s.result}`))}`);
      expect(a.value.text).toMatch(/1\.25/); expect(a.value.sources.length).toBeGreaterThan(0);
      for (const s of a.value.sources) expect((await A.backend.docs.page(dealId, { doc: s.doc, docId: s.docId }, s.loc)).ok, `${s.doc} ${s.loc}`).toBe(true);
      expect(a.value.research?.steps.length).toBeGreaterThan(0); expect(a.value.research?.read?.docs).toBeGreaterThan(0);
    } finally {
      console.log(`live agent test: ${service.use.calls} calls, ${service.use.input} tokens in, ${service.use.output} out, by model ${JSON.stringify(service.use.byModel)}`);
      A.backend.close();
    }
  }, 300000);
});
