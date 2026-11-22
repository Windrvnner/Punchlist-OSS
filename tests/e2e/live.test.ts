// @vitest-environment node
// The pipeline on a real model. It runs only through npm run e2e:live, which asks for live calls with the key; it is
// skipped otherwise. Light by default: every call goes to Haiku, with a hard cap on calls.
//   npm run e2e:live -- tests/e2e/live.test.ts
//   add PUNCHLIST_LIVE_ROUTING=1 to send the fast, standard and thorough tiers to Haiku, Sonnet and Opus.
// It asserts what must hold whatever the model says: every reply was read, every citation opens a page of a real
// document, and the plain facts of this small data room come out.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, pcApp, newDeal } from './kit';
import { logOf } from './splitKit';
import { claudeService } from '../../src/backend/claude';
import { notation } from '../../src/backend/ai';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { dealQuestions } from '../../src/app/state';

// only on a run that asks for live calls (npm run e2e:live sets PUNCHLIST_LIVE=1), never because a key is set
const KEY = process.env.PUNCHLIST_LIVE === '1' ? process.env.PUNCHLIST_AI_KEY : undefined;
const LIST = () => ({
  broad: [{ id: 'b1', text: 'The distribution lock-up ratio is the same in the credit agreement and the term sheet' }],
  product: [{ id: 'p1', text: 'The term sheet states a distribution lock-up DSCR of 1.30x' }],
  sector: [{ id: 's1', text: 'The financial model has been audited by an independent model auditor' }],
});
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe.skipIf(!KEY)('the pipeline on Claude (live)', () => {
  it('indexes, checks the list, raises the plain discrepancy, answers with citations that open, and hears a response', async () => {
    const root = tmp(); roots.push(root); const vdr = path.join(root, 'vdr');
    put(vdr, '01 Finance/Credit Agreement.pdf', pdf('Clause 21.3 Distribution lock-up. The Borrower may make a Distribution only if the historic DSCR is at least 1.25x', 2));
    put(vdr, '01 Finance/Term sheet.pdf', pdf('Term sheet. Distribution lock-up DSCR 1.30x.', 1));
    put(vdr, '09 Misc/Lunch menu.pdf', pdf('Lunch menu. Soup and sandwiches'));
    const service = claudeService({ key: KEY!, routing: process.env.PUNCHLIST_LIVE_ROUTING === '1', maxCalls: 60 });
    const A = await pcApp(root, 'Office', { service, checklist: LIST, user: 'Live test' });
    try {
      const dealId = await newDeal(A, 'Proseware live', vdr);
      // every checklist item came to a result: the backend could read every reply
      await A.store.refreshChecklist(dealId); const rows = A.store.get().checklists[dealId]; if (!Array.isArray(rows)) throw new Error('the checklist did not load');
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      console.log('live rows: ' + JSON.stringify(rows.map((r) => ({ id: r.id, result: r.result, need: r.need, docs: r.docs.map((d) => d.name), sources: r.sources?.map((x) => `${x.doc} ${x.loc}`) }))));
      expect(rows.filter((r) => r.result === 'unsettled' || r.result === 'unchecked').map((r) => `${r.id}: ${r.why ?? r.result}`)).toEqual([]);
      // the plain facts: the ratios differ, the term sheet states 1.30x, there is no audit report
      expect(by.b1.result).toBe('finding'); expect(by.s1.result).toBe('gap'); expect(by.p1.result).toBe('satisfied');
      // the finding's citations open pages of real documents
      const findings = Object.values(A.store.get().findings).filter((f) => f.dealId === dealId); expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) for (const s of f.sources) { const pg = await A.backend.docs.page(dealId, { doc: s.doc, docId: s.docId }, s.loc); expect(pg.ok, `${s.doc} ${s.loc}`).toBe(true); }
      // an answer in a conversation, with a citation that opens
      const a = await A.backend.ai.answer({ dealId, message: 'What distribution lock-up ratio does the credit agreement set?', history: [], model: 'standard' });
      expect(a.ok).toBe(true); if (!a.ok) return;
      expect(a.value.text).toMatch(/1\.25/); expect(a.value.sources.length).toBeGreaterThan(0);
      expect(notation(a.value.text)).toEqual([]);   // no LaTeX-style notation; plain symbols are fine
      for (const s of a.value.sources) expect((await A.backend.docs.page(dealId, { doc: s.doc, docId: s.docId }, s.loc)).ok).toBe(true);
      // a response on the discrepancy: the backend sets it against the finding and records that it did. Whether the model
      // then calls the finding settled is its judgment, not the flow's; the live test proves the flow
      await A.store.dispatch(CreateQuestion, { dealId, text: 'Which distribution lock-up ratio applies?' });
      const qid = dealQuestions(A.store.get(), dealId)[0].id;
      const response = 'The credit agreement will be amended to 1.30x to match the term sheet.';
      await A.store.dispatch(SetResponse, { dealId, questionId: qid, response });
      const ids = new Set(findings.map((f) => f.id));
      const heard = () => logOf(A.dirs.shared, dealId).some((l) => l.heard?.question === qid && (l.heard.against ?? []).some((id: string) => ids.has(id)));
      const end = Date.now() + 60000; while (Date.now() < end && !heard()) await new Promise((r) => setTimeout(r, 200));
      expect(heard()).toBe(true);
    } finally {
      // what it cost, for the person who pays
      if (process.env.PUNCHLIST_LIVE_LOG === '1') for (const l of service.use.log) console.log(`ASK ${l.ask}\nFILES ${l.files.join(', ')}\nREPLY ${l.reply}\n`);
      console.log(`live test: ${service.use.calls} calls, ${service.use.input} tokens in, ${service.use.output} out, by model ${JSON.stringify(service.use.byModel)}`);
      A.backend.close();
      for (const id of [...service.use.uploaded]) await service.remove(id);      // leave nothing in the account's file store
    }
  }, 300000);
});
