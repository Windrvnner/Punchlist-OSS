// @vitest-environment node
// Deletes across PCs at deal scale, on a realistic list: 2,400 due diligence questions of a project-finance deal, with
// responses as a counterparty writes them. Three kinds of crossing at once, 390 records in all: a question deleted on both
// PCs as it was, a question each PC answered differently and then deleted, and a question deleted on one PC
// while answered on the other. Every response anyone typed must end up either on a live question or under
// Deleted, on every PC, and a PC that starts afresh must read the same.
import { describe, it, expect } from 'vitest';
import { carry, pc, syncAll, row, okd, settle, type PC } from './pcs';
import { dealList } from '../backend/dealList';
import { CreateDeal } from '../../src/app/commands/deals';
import { SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { RestoreVersion } from '../../src/app/commands/keptVersions';
import { dealQuestions } from '../../src/app/state';
import { deletedOf } from '../../src/ui/deleted';

const FOLDERS = ['1.1 Corporate', '2.3 Offtake', '3.2 Construction', '4.1 Financing', '5.4 Permits', '6.2 Insurance'];
/** a response as a counterparty writes one, different for each question and each PC */
const reply = (i: number, who: 'A' | 'B') => who === 'A'
  ? `Provided in data room folder ${FOLDERS[i % FOLDERS.length]}, document ${i + 11}. Executed March ${(i % 28) + 1}, 2025; Amendment No. ${(i % 3) + 1} is with the counterparty for signature.`
  : `See ${FOLDERS[(i + 3) % FOLDERS.length]}/${i + 7}. The sponsor confirms no notice of default has been given or received, and an estoppel is expected by ${(i % 12) + 1} June.`;

describe('deletes across PCs at deal scale, realistic list', () => {
  it('2,400 questions, 390 crossed deletes: everything typed stays live or under Deleted, on every PC', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe', -4000);
    await A.store.boot(); await A.store.dispatch(CreateDeal, { name: 'Proseware Solar', folders: [] }); const dealId = Object.keys(A.store.get().deals)[0]; await A.store.loadDeal(dealId, { gaps: false });
    const { items } = dealList();
    okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: items.map((t, i) => row(i + 1, t, i % 4 ? '' : reply(i, 'A'))) }));
    carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
    const qs = dealQuestions(A.store.get(), dealId); expect(qs.length).toBe(2400);
    // spread over the list, not one block
    const pick = (from: number, n: number) => Array.from({ length: n }, (_, k) => qs[from + k * 6].id);
    const twice = pick(1, 150), typed = pick(3, 120), split = pick(5, 120);
    const at = new Map(qs.map((q, i) => [q.id, i]));
    const typedBy = new Map<string, string[]>();   // every response a person typed during the test, by question
    for (const id of twice) { okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: id })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: id })); }
    for (const id of typed) {
      const i = at.get(id)!; typedBy.set(id, [reply(i, 'A'), reply(i, 'B')]);
      okd(await A.store.dispatch(SetResponse, { dealId, questionId: id, response: reply(i, 'A') })); okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: id }));
      okd(await B.store.dispatch(SetResponse, { dealId, questionId: id, response: reply(i, 'B') })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: id }));
    }
    for (const id of split) { typedBy.set(id, [reply(at.get(id)!, 'B')]); okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: id })); okd(await B.store.dispatch(SetResponse, { dealId, questionId: id, response: reply(at.get(id)!, 'B') })); }
    await syncAll(A, B);
    for (const X of [A, B]) {
      const s = X.store.get();
      expect(Object.keys(s.conflicts).length).toBe(120);                                   // only delete-beside-edit is a choice
      expect(deletedOf(s, dealId, 'question').length).toBe(150 + 120);                     // the rest are listed under Deleted
      for (const id of typed) expect(((s.tombstones[id] as any).copies ?? []).length).toBe(1);   // both PCs' words, listed twice
    }
    const started = Date.now();
    const v = (X: PC, id: string, deleted: boolean) => X.store.get().conflicts[id].versions.find((x) => !!x.deleted === deleted)!.id;
    // the choices made opposite ways on the two PCs before either has synced, then once more
    for (const id of split) { okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(A, id, true) })); okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(B, id, false) })); }
    await syncAll(A, B);
    for (const [k, id] of split.entries()) okd(k % 2 ? await A.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(A, id, false) }) : await B.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(B, id, true) }));
    // the plain ones restored half on each PC; the typed ones restored as one PC's words or the other's
    for (const [k, id] of twice.entries()) okd(await (k % 2 ? A : B).store.dispatch(RestoreQuestion, { dealId, questionId: id }));
    for (const [k, id] of typed.entries()) { const X = k % 2 ? A : B; const t = X.store.get().tombstones[id] as any; okd(await X.store.dispatch(RestoreQuestion, { dealId, questionId: id, ...(k % 3 ? { copy: t.copies[0].ver } : {}) })); }
    await syncAll(A, B);
    expect(Date.now() - started).toBeLessThan(30_000);
    const C = pc('Meeting room PC', 'kroe', 2500);
    carry(A.shared, C.shared);
    await C.store.boot();
    await C.store.loadDeal(dealId, { gaps: false });
    await settle();
    for (const X of [A, B, C]) {
      const s = X.store.get();
      expect(Object.keys(s.conflicts)).toEqual([]); expect(((await X.repo.sync()) as any).value.clashes).toEqual([]);
      expect(dealQuestions(s, dealId).length).toBe(2400 - 60);
      for (const id of [...twice, ...typed]) expect(s.questions[id]).toBeDefined();
      // nothing typed is lost: each response is on the live question or on an entry, and each entry is listed under Deleted
      const listed = deletedOf(s, dealId, 'question');
      const words = (id: string) => [s.questions[id]?.response, ...listed.flatMap((t: any) => (t.id === id || t.of === id ? [t.snapshot?.response, ...(t.copies ?? []).map((c: any) => c.snapshot?.response)] : []))];
      for (const [id, said] of typedBy) for (const w of said) expect(words(id)).toContain(w);
      // and nothing is listed twice: each typed question that was restored has exactly the other PC's words as one entry
      for (const id of typed) expect(listed.filter((t: any) => t.of === id).length).toBe(1);
    }
    // the kept-deleted ones come back from C with the other PC's answer, from their entry
    for (const [k, id] of split.entries()) if (!(k % 2)) { const e = deletedOf(C.store.get(), dealId, 'question').find((t: any) => t.of === id)!; okd(await C.store.dispatch(RestoreVersion, { dealId, entryId: e.id })); expect(C.store.get().questions[id].response).toBe(reply(at.get(id)!, 'B')); }
    expect(dealQuestions(C.store.get(), dealId).length).toBe(2400);
  }, 240_000);
});
