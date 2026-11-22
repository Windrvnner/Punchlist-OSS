// @vitest-environment node
// The whole pipeline, as one person and then two would use it: the app's store on the real backend (composeBackend),
// real files in a data room, a sync folder per PC, and the stand-in model. Nothing in between is a mock.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, carry, pcApp, newDeal, until, StandInService } from './kit';
import { isPickAsk, isPickForAsk, isDescribeAsk, isAffectsAsk, isVerifyAsk, isHearAsk, itemsIn } from '../backend/reviewKit';
import { CreateQuestion, SetResponse, EditQuestionField } from '../../src/app/commands/questions';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { Undo } from '../../src/app/commands/undo';
import { dealQuestions } from '../../src/app/state';
import { CreateDeal } from '../../src/app/commands/deals';
import { pickUpIndexing } from '../../src/app/indexing';

const LIST = () => ({
  broad: [{ id: 'b1', text: 'The lock-up ratio is the same in the credit agreement and the term sheet' }],
  product: [{ id: 'p1', text: 'The term sheet is signed' }],
  sector: [{ id: 's1', text: 'The financial model has been audited' }],
});

/** the stand-in model: answers each kind of question the backend asks, the way a real model is told to */
function model() {
  return new StandInService((c) => {
    const ref = (name: string) => new RegExp(`^(D\\d+): (?:.*/)?${name.replace(/[()]/g, '\\$&')}`, 'm').exec(c.prompt)?.[1];
    if (isDescribeAsk(c as any)) { const name = /Describe the document (.*)\.\n/.exec(c.prompt)?.[1] ?? 'it'; return JSON.stringify({ summary: `This is ${name}.`, keywords: ['lock-up'] }); }
    if (isPickAsk(c as any) || isPickForAsk(c as any)) return JSON.stringify({ read: [1, 2, 3] });
    const items = itemsIn(c as any);
    if (items.length) return JSON.stringify({ items: items.map((it) =>
      /lock-up/.test(it.text) ? { id: it.tag, result: 'finding', title: 'Lock-up differs between the credit agreement and the term sheet', workstream: 'Legal', body: ['The agreement says 1.25x. [1] The term sheet says 1.30x. [2]'], next: 'Ask counsel which is right.', sources: [{ doc: ref('Credit Agreement.pdf'), page: 1 }, { doc: ref('Term sheet (signed).pdf'), page: 1 }] }
      : /signed/.test(it.text) ? (c.prompt.includes('Add "where"') ? { id: it.tag, result: 'ok', where: [{ doc: ref('Term sheet (signed).pdf'), page: 1, quote: 'term sheet' }] } : { id: it.tag, result: 'ok' })
      : { id: it.tag, result: 'more', need: 'The model audit report' }) });
    if (isAffectsAsk(c as any)) return JSON.stringify({ items: [], findings: [] });
    if (isHearAsk(c as any)) return JSON.stringify({ affected: [...c.prompt.matchAll(/^(F\d+):/gm)].map((m) => `${m[1]} Q1`) });
    if (isVerifyAsk(c as any)) return JSON.stringify({ stands: false, why: 'The sponsor confirmed 1.30x, so the agreement draft will change.' });
    return JSON.stringify({ text: 'The lock-up is 1.25x in the agreement. [1]', sources: [{ doc: ref('Credit Agreement.pdf') ?? 'D1', page: 1 }] });
  });
}

const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function dataRoom() {
  const root = tmp(); roots.push(root); const vdr = path.join(root, 'vdr');
  put(vdr, '01 Finance/Credit Agreement.pdf', pdf('credit agreement lock-up 1.25x', 3));
  put(vdr, '01 Finance/Term sheet (signed).pdf', pdf('term sheet lock-up 1.30x signed', 2));
  put(vdr, '09 Misc/Lunch menu.pdf', pdf('lunch menu'));
  return { root, vdr };
}

describe('the whole pipeline on the real backend', () => {
  it('one PC: a deal is indexed, checked and raised; a question, a response and the backend\'s mark; Undo; and all of it is there after a restart', async () => {
    const { root, vdr } = dataRoom(); const service = model();
    const A = await pcApp(root, 'Office', { service, checklist: LIST, user: 'adoe' });
    const dealId = await newDeal(A, 'Proseware', vdr);

    // indexed: every file, with pages
    const docs = A.backend.docs as any; expect(docs.records(dealId).map((r: any) => [r.name, r.pages]).sort()).toEqual([['Credit Agreement.pdf', 3], ['Lunch menu.pdf', 1], ['Term sheet (signed).pdf', 2]]);
    // the first pass raised the finding, and the window has it with its sources
    await until('the finding to reach the window', () => Object.values(A.store.get().findings).some((f) => f.dealId === dealId));
    const f = Object.values(A.store.get().findings).find((x) => x.dealId === dealId)!;
    expect(f.title).toBe('Lock-up differs between the credit agreement and the term sheet');
    expect(f.sources.map((s) => s.doc).sort()).toEqual(['Credit Agreement.pdf', 'Term sheet (signed).pdf']);
    // a citation opens a page of the right document
    const pg = await A.backend.docs.page(dealId, { doc: f.sources[0].doc, docId: f.sources[0].docId }, f.sources[0].loc); expect(pg.ok && pg.value.kind).toBe('pdf');
    // the checklist: one flagged, one satisfied with its place, one gap with its need
    await A.store.refreshChecklist(dealId);
    const rows = A.store.get().checklists[dealId]; if (!Array.isArray(rows)) throw new Error('the checklist did not load');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.b1.result).toBe('finding'); expect(byId.b1.findingId).toBe(f.id);
    expect(byId.p1.result).toBe('satisfied'); expect(byId.p1.sources![0].doc).toBe('Term sheet (signed).pdf');
    expect(byId.s1.result).toBe('gap'); expect(byId.s1.need).toBe('The model audit report');

    // a question to the sponsor, not linked to the finding; the response comes back; the backend marks the finding for a person to reassess
    const q = await A.store.dispatch(CreateQuestion, { dealId, text: 'Which lock-up ratio applies?' }); expect(q.ok).toBe(true);
    const qid = dealQuestions(A.store.get(), dealId)[0].id;
    expect((await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'The term sheet is right: 1.30x.' })).ok).toBe(true);
    await until('the backend to mark the finding', () => !!A.store.get().findings[f.id]?.updated);
    expect(A.store.get().findings[f.id].updatedWhy).toMatch(/^Response received on Q1/);

    // an edit, and its Undo
    const e = await A.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Which lock-up ratio applies, 1.25x or 1.30x?' }); expect(e.ok).toBe(true);
    expect((await A.store.dispatch(Undo, { opId: (e as any).value.opId })).ok).toBe(true);
    expect(A.store.get().questions[qid].text).toBe('Which lock-up ratio applies?');

    // closed and opened again: the same deal, finding, mark, question and response, read from the files on disk
    A.backend.close();
    const again = await pcApp(root, 'Office', { service, checklist: LIST, user: 'adoe' });
    await again.store.loadDeal(dealId, { gaps: false });
    expect(again.store.get().deals[dealId].name).toBe('Project Proseware');
    expect(again.store.get().findings[f.id]).toMatchObject({ title: f.title, updated: true });
    expect(again.store.get().questions[qid]).toMatchObject({ text: 'Which lock-up ratio applies?', response: 'The term sheet is right: 1.30x.' });
    expect(again.backend.installId).toBe(A.backend.installId);
    again.backend.close();
  }, 60000);

  it('the app closed after indexing ended but before the deal was saved as indexed: on opening again the deal is indexed, not "not started"', async () => {
    const { root, vdr } = dataRoom(); const service = model();
    const A = await pcApp(root, 'Office', { service, checklist: LIST, user: 'adoe' });
    const made = await A.store.dispatch(CreateDeal, { name: 'Proseware', folders: [{ path: vdr, label: 'Data room', files: 0, size: '' }] }); expect(made.ok).toBe(true);
    const dealId = Object.keys(A.store.get().deals)[0];
    // indexing runs to its end in the backend; the window never gets to record it, because the app closes first
    expect((await A.backend.docs.index(dealId, A.store.get().deals[dealId].folders)).ok).toBe(true);
    await until('indexing to finish', async () => { const p = await A.backend.docs.poll(dealId); return p.ok && p.value.done; });
    await A.backend.idle(); expect(A.store.get().deals[dealId].stage).toBe('indexing'); await A.backend.close();
    const again = await pcApp(root, 'Office', { service, checklist: LIST, user: 'adoe' });
    const stop = pickUpIndexing(again.store);
    try {
      await until('the deal to read as indexed', () => again.store.get().deals[dealId]?.stage === 'ready');
      expect(again.store.get().ui.indexStalled).not.toContain(dealId);
      expect(again.store.get().deals[dealId].folders[0]).toMatchObject({ files: 3, indexed: 3 });
    } finally { stop(); await again.backend.idle(); await again.backend.close(); }
  }, 60000);

  it('two PCs: what one does reaches the other through the sync folder; the same question changed on both is two versions, and one person\'s choice settles it on both', async () => {
    const { root, vdr } = dataRoom(); const service = model();
    const A = await pcApp(root, 'Office', { service, checklist: LIST, user: 'adoe' });
    const dealId = await newDeal(A, 'Proseware', vdr);
    await A.store.dispatch(CreateQuestion, { dealId, text: 'Is the model audited?' });
    const qid = dealQuestions(A.store.get(), dealId)[0].id;

    // OneDrive carries the office's files to the laptop, which opens the app
    const B = await pcApp(root, 'Laptop', { service, checklist: LIST, user: 'sroe' });
    carry(A.dirs.shared, B.dirs.shared); await B.backend.repo.sync!(); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false });
    expect(B.store.get().deals[dealId].name).toBe('Project Proseware');
    expect(Object.values(B.store.get().findings).map((x) => x.title)).toEqual(['Lock-up differs between the credit agreement and the term sheet']);
    expect(B.store.get().questions[qid].text).toBe('Is the model audited?');
    // the laptop shows the same checklist without checking anything again
    const calls = (service as StandInService).calls.length;
    await B.store.refreshChecklist(dealId); const rows = B.store.get().checklists[dealId]; if (!Array.isArray(rows)) throw new Error('the checklist did not load');
    expect(rows.map((r) => `${r.id}:${r.result}`).sort()).toEqual(['b1:finding', 'p1:satisfied', 's1:gap']); expect((service as StandInService).calls.length).toBe(calls);

    // both change the same question before either has the other's change
    expect((await A.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is the model audited? (office)' })).ok).toBe(true);
    expect((await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is the model audited? (laptop)' })).ok).toBe(true);
    carry(A.dirs.shared, B.dirs.shared); await A.backend.repo.sync!(); await B.backend.repo.sync!();
    await until('both PCs to show two versions', () => !!A.store.get().conflicts[qid] && !!B.store.get().conflicts[qid]);
    // sroe keeps the office's version on the laptop
    const c = B.store.get().conflicts[qid]; const office = c.versions.find((v: any) => v.data?.text?.endsWith('(office)'))!;
    expect((await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: office.id })).ok).toBe(true);
    carry(A.dirs.shared, B.dirs.shared); await A.backend.repo.sync!(); await B.backend.repo.sync!();
    await until('the choice to reach the office', () => !A.store.get().conflicts[qid]);
    for (const P of [A, B]) expect(P.store.get().questions[qid].text).toBe('Is the model audited? (office)');
    A.backend.close(); B.backend.close();
  }, 60000);
});
