// @vitest-environment node
// A deletion note (tombstone) written on two PCs has two versions that nobody is ever asked to choose between. It must
// never stop the record from being restored, or a choice between a delete and an edit from going through.
import { describe, it, expect } from 'vitest';
import { carry, pc, syncAll, twoPcs, row, okd, settle, type PC } from './pcs';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { SetDealMember } from '../../src/app/commands/members';
import { CreateQuestion, EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, DeleteFinding, RestoreFinding } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { RestoreVersion } from '../../src/app/commands/keptVersions';
import { Undo } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';

describe('a record deleted on two PCs', () => {
  for (const skewB of [5000, -5000]) for (const who of ['A', 'B'] as const) {
    it(`a question restores on ${who} (the other PC's clock ${skewB > 0 ? 'ahead' : 'behind'})`, async () => {
      const { A, B, dealId, qid } = await twoPcs(skewB);
      okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
      await syncAll(A, B);
      const P = who === 'A' ? A : B, O = who === 'A' ? B : A;
      expect(P.store.get().tombstones[qid]).toBeDefined(); expect(P.store.get().tombstones[qid]).toEqual(O.store.get().tombstones[qid]);   // both PCs list the same deletion
      okd(await P.store.dispatch(RestoreQuestion, { dealId, questionId: qid }));
      await syncAll(A, B);
      for (const X of [A, B]) {
        expect(X.store.get().questions[qid]?.text).toBe('Is there a decommissioning bond?'); expect(X.store.get().tombstones[qid]).toBeUndefined(); expect(X.store.get().conflicts[qid]).toBeUndefined();
        expect((await X.repo.sync()).ok && ((await X.repo.sync()) as any).value.clashes).toEqual([]);
      }
      // and it is an ordinary question again: edited, deleted and restored once more
      okd(await O.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is there a decommissioning bond in place?' }));
      okd(await O.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); await syncAll(A, B);
      okd(await P.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); await syncAll(A, B);
      expect(O.store.get().questions[qid]?.text).toBe('Is there a decommissioning bond in place?');
    });
  }
  it('a finding restores on either PC', async () => {
    const { A, B, dealId, fid } = await twoPcs();
    okd(await A.store.dispatch(DeleteFinding, { dealId, findingId: fid })); okd(await B.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    await syncAll(A, B);
    okd(await B.store.dispatch(RestoreFinding, { dealId, findingId: fid })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().findings[fid]?.title).toBe('Lock-up ratio below covenant'); expect(X.store.get().tombstones[fid]).toBeUndefined(); }
    okd(await A.store.dispatch(DeleteFinding, { dealId, findingId: fid })); okd(await A.store.dispatch(RestoreFinding, { dealId, findingId: fid }));
  });
  it('Undo of the delete brings it back on the PC whose deletion is the one listed, and is refused as changed on the other', async () => {
    const { A, B, dealId, qid } = await twoPcs(5000);
    const a = okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); const b = okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B);
    const ub = await B.store.dispatch(Undo, { opId: b.value.opId });
    expect(!ub.ok && ub.error.message).toBe('Changed since — undo refused');         // the listed deletion is adoe's, not the one sroe's Undo would take back
    okd(await A.store.dispatch(Undo, { opId: a.value.opId })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid]).toBeDefined(); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
  });
  it('restored on both PCs at once, it is one question with nothing to choose', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    okd(await A.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid]).toBeDefined(); expect(X.store.get().conflicts[qid]).toBeUndefined(); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
  });
  for (const skewB of [5000, -5000]) it(`Restore brings back the last thing typed, whichever PC's clock deleted first (the other PC's clock ${skewB > 0 ? 'ahead' : 'behind'})`, async () => {
    // adoe types a response and then deletes; sroe, who never saw the response, deletes the question as it was before
    const { A, B, dealId, qid } = await twoPcs(skewB);
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond issued March 3.' }));
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B);
    for (const X of [A, B]) expect((X.store.get().tombstones[qid].snapshot as { response: string }).response).toBe('Bond issued March 3.');
    okd(await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    for (const X of [A, B]) expect(X.store.get().questions[qid]?.response).toBe('Bond issued March 3.');
  });
  it('deleted on three PCs, it restores on the third', async () => {
    const { A, B, dealId, qid } = await twoPcs(); const C = pc('Laptop', 'kroe', -3000);
    carry(A.shared, C.shared); await C.store.boot(); await C.store.loadDeal(dealId, { gaps: false }); await settle();
    for (const X of [A, B, C]) okd(await X.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B, C);
    okd(await C.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); await syncAll(A, B, C);
    for (const X of [A, B, C]) { expect(X.store.get().questions[qid]).toBeDefined(); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
  });
  it('a merge import that matches it brings it back', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    const imp = okd(await B.store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: [row(1, 'Is there a decommissioning bond?', 'Yes, issued March 3.')] })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid]?.response).toBe('Yes, issued March 3.'); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
    okd(await B.store.dispatch(Undo, { opId: imp.value.opId })); await syncAll(A, B);                                   // and Undo of the import deletes it again
    for (const X of [A, B]) { expect(X.store.get().questions[qid]).toBeUndefined(); expect(X.store.get().tombstones[qid]).toBeDefined(); }
    okd(await A.store.dispatch(RestoreQuestion, { dealId, questionId: qid }));
  });
  it('a third PC that reads everything afterwards shows the same', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    okd(await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid })); await syncAll(A, B);
    const C = pc('Laptop', 'kroe');
    carry(A.shared, C.shared);
    await C.store.boot();
    await C.store.loadDeal(dealId, { gaps: false });
    await settle();
    expect(C.store.get().questions[qid]).toBeDefined(); expect(C.store.get().tombstones[qid]).toBeUndefined();
  });
});

describe('a window that has not yet read the other PC\'s deletion note', () => {
  // B's note, with the response B typed before deleting, has reached A's folder but A's window has not looked yet
  const RESP = 'Bond issued March 3.';
  async function race() {
    const t = await twoPcs(); const { A, B, dealId, qid } = t;
    const a = okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: RESP })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    carry(A.shared, B.shared);
    return { ...t, a };
  }
  for (const how of ['Restore', 'Undo', 'merge import'] as const) it(`${how} is refused as changed elsewhere, then brings back what the other PC typed`, async () => {
    const { A, B, dealId, qid, a } = await race();
    const go = () => how === 'Restore' ? A.store.dispatch(RestoreQuestion, { dealId, questionId: qid }) : how === 'Undo' ? A.store.dispatch(Undo, { opId: a.value.opId })
      : A.store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: [row(1, 'Is there a decommissioning bond?')] });
    const first = await go();
    expect(!first.ok && first.error.kind).toBe('conflict');
    await settle();                                                                  // the window has now read B's note
    for (const X of [A, B]) { await X.repo.sync(); await settle(); expect((X.store.get().tombstones[qid].snapshot as { response: string }).response).toBe(RESP); }
    if (how !== 'Undo') okd(await go()); else okd(await A.store.dispatch(RestoreQuestion, { dealId, questionId: qid }));   // Undo checks the note it wrote, which is no longer the one listed
    await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid]?.response).toBe(RESP); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
  });
  it('a finding is refused the same way, and restores with what the other PC typed', async () => {
    const { A, B, dealId, fid } = await twoPcs();
    okd(await A.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    okd(await B.store.dispatch(EditFinding, { dealId, findingId: fid, title: 'Lock-up ratio below covenant',
      workstream: 'Financial', body: ['DSCR 1.02x, re-tested.'] }));
    okd(await B.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    carry(A.shared, B.shared);
    const first = await A.store.dispatch(RestoreFinding, { dealId, findingId: fid }); expect(!first.ok && first.error.kind).toBe('conflict');
    await settle(); okd(await A.store.dispatch(RestoreFinding, { dealId, findingId: fid })); await syncAll(A, B);
    for (const X of [A, B]) expect(X.store.get().findings[fid]?.body).toEqual(['DSCR 1.02x, re-tested.']);
  });
});

describe('a delete and an edit chosen opposite ways on two PCs', () => {
  async function opposite() {
    const t = await twoPcs(); const { A, B, dealId, qid } = t;
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond issued March 3.' }));
    await syncAll(A, B);
    const del = (X: PC) => X.store.get().conflicts[qid].versions.find((v) => v.deleted)!.id, kept = (X: PC) => X.store.get().conflicts[qid].versions.find((v) => !v.deleted)!.id;
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: del(A) })); okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: kept(B) }));
    await syncAll(A, B);
    for (const X of [A, B]) expect(X.store.get().conflicts[qid]?.versions.length).toBe(2);              // the delete beside the edit again, which is right
    return { ...t, del, kept };
  }
  for (const who of ['A', 'B'] as const) {
    it(`the second choice goes through on ${who}: keep the edit`, async () => {
      const { A, B, dealId, qid, kept } = await opposite(); const P = who === 'A' ? A : B;
      okd(await P.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: kept(P) })); await syncAll(A, B);
      for (const X of [A, B]) { expect(X.store.get().questions[qid]?.response).toBe('Bond issued March 3.'); expect(X.store.get().conflicts[qid]).toBeUndefined(); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
      okd(await A.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is the decommissioning bond in place?' }));       // and it takes edits again
    });
    it(`the second choice goes through on ${who}: keep it deleted, and it restores with the response`, async () => {
      const { A, B, dealId, qid, del } = await opposite(); const P = who === 'A' ? A : B;
      okd(await P.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: del(P) })); await syncAll(A, B);
      for (const X of [A, B]) { expect(X.store.get().questions[qid]).toBeUndefined(); expect(X.store.get().conflicts[qid]).toBeUndefined(); expect(X.store.get().tombstones[qid]).toBeDefined(); }
      // the response typed on B is under Deleted as an entry of its own, once, and restores
      const entries = (X: PC) => Object.values(X.store.get().tombstones).filter((t: any) => t.of === qid) as any[];
      for (const X of [A, B]) expect(entries(X).map((t) => t.snapshot.response)).toEqual(['Bond issued March 3.']);
      okd(await B.store.dispatch(RestoreVersion, { dealId, entryId: entries(B)[0].id })); await syncAll(A, B);
      for (const X of [A, B]) { expect(X.store.get().questions[qid]?.response).toBe('Bond issued March 3.'); expect(X.store.get().tombstones[qid]).toBeUndefined(); }
    });
  }
  it('the second choice can be undone and made the other way', async () => {
    const { A, B, dealId, qid, del, kept } = await opposite();
    const c = okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: kept(A) }));
    okd(await A.store.dispatch(Undo, { opId: c.value.opId })); await syncAll(A, B);
    for (const X of [A, B]) expect(X.store.get().conflicts[qid]?.versions.length).toBe(2);
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: del(B) })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid]).toBeUndefined(); expect(X.store.get().tombstones[qid]).toBeDefined(); expect(X.store.get().conflicts[qid]).toBeUndefined(); }
  });
  it('a finding takes the same path', async () => {
    const { A, B, dealId, fid } = await twoPcs();
    okd(await A.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    okd(await B.store.dispatch(EditFinding, { dealId, findingId: fid, title: 'Lock-up ratio below covenant',
      workstream: 'Financial', body: ['DSCR 1.02x against 1.10x.'] }));
    await syncAll(A, B);
    const vs = (X: PC) => X.store.get().conflicts[fid].versions;
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: fid, keep: vs(A).find((v) => v.deleted)!.id })); okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: fid, keep: vs(B).find((v) => !v.deleted)!.id }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: fid, keep: vs(A).find((v) => !v.deleted)!.id })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().findings[fid]?.body).toEqual(['DSCR 1.02x against 1.10x.']); expect(X.store.get().conflicts[fid]).toBeUndefined(); expect(X.store.get().tombstones[fid]).toBeUndefined(); }
  });
});

describe('a person\'s own list of deals changed on their two PCs', () => {
  // the same rule as a deletion note: nobody is offered a choice between two versions of it, so it must keep taking writes
  async function twoVersions() {
    const { A, dealId } = await twoPcs(); const A2 = pc('PC B', 'adoe', 3000);
    carry(A.shared, A2.shared); await A2.store.boot(); await settle();
    okd(await A.store.dispatch(SetDealMember, { dealId, on: false }));
    okd(await A2.store.dispatch(SetDealMember, { dealId, on: false })); okd(await A2.store.dispatch(SetDealMember, { dealId, on: true }));
    await syncAll(A, A2);
    return { A, A2, dealId };
  }
  it('the deal can still be added to and taken off the list', async () => {
    const { A, A2, dealId } = await twoVersions(); const mine = (X: PC) => Object.values(X.store.get().members).find((m) => m.dealId === dealId)!.on;
    expect(mine(A)).toBe(mine(A2));
    okd(await A.store.dispatch(SetDealMember, { dealId, on: !mine(A) })); await syncAll(A, A2);
    expect(mine(A)).toBe(mine(A2));
    okd(await A2.store.dispatch(SetDealMember, { dealId, on: !mine(A2) })); await syncAll(A, A2);
    expect(mine(A)).toBe(mine(A2));
  });
  it('the deal can still be deleted', async () => {
    const { A, A2, dealId } = await twoVersions();
    okd(await A2.store.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware' })); await syncAll(A, A2);
    for (const X of [A, A2]) expect(X.store.get().deals[dealId]).toBeUndefined();
  });
});

describe('at deal scale', () => {
  it('2,000 questions, 120 deleted on both PCs and 120 deleted on one and answered on the other: every one restores or is chosen', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe', -4000);
    await A.store.boot(); await A.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(A.store.get().deals)[0]; await A.store.loadDeal(dealId, { gaps: false });
    okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: Array.from({ length: 2000 }, (_, i) => row(i + 1, `Question ${i + 1}: provide the executed agreement for facility ${i + 1}.`)) }));
    carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
    const qs = dealQuestions(A.store.get(), dealId); expect(qs.length).toBe(2000);
    const twice = qs.slice(100, 220).map((q) => q.id), split = qs.slice(900, 1020).map((q) => q.id);
    for (const id of twice) { okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: id })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: id })); }
    for (const id of split) { okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: id })); okd(await B.store.dispatch(SetResponse, { dealId, questionId: id, response: `Answered ${id}` })); }
    await syncAll(A, B);
    for (const X of [A, B]) expect(Object.keys(X.store.get().conflicts).length).toBe(120);
    // every delete beside an edit is chosen opposite ways on the two PCs, before either choice has synced
    const v = (X: PC, id: string, deleted: boolean) => X.store.get().conflicts[id].versions.find((x) => !!x.deleted === deleted)!.id;
    for (const id of split) { okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(A, id, true) })); okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(B, id, false) })); }
    await syncAll(A, B);
    for (const X of [A, B]) expect(Object.keys(X.store.get().conflicts).length).toBe(120);
    const started = Date.now();
    // the second choice: half kept as edited on A, half kept deleted on B; the twice-deleted ones restored, half on each PC
    for (const [i, id] of split.entries()) okd(i % 2 ? await A.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(A, id, false) }) : await B.store.dispatch(ResolveConflict, { dealId, recordId: id, keep: v(B, id, true) }));
    for (const [i, id] of twice.entries()) okd(await (i % 2 ? A : B).store.dispatch(RestoreQuestion, { dealId, questionId: id }));
    await syncAll(A, B);
    expect(Date.now() - started).toBeLessThan(20_000);
    for (const X of [A, B]) {
      const s = X.store.get();
      expect(Object.keys(s.conflicts)).toEqual([]); expect(((await X.repo.sync()) as any).value.clashes).toEqual([]);
      expect(dealQuestions(s, dealId).length).toBe(2000 - 60);
      for (const id of twice) expect(s.questions[id]).toBeDefined();
      // nothing typed is lost: kept as edited, the deleted copy is an entry; kept deleted, the answer is an entry. Each once.
      const entry = (id: string) => Object.values(s.tombstones).filter((t: any) => t.of === id) as any[];
      for (const [i, id] of split.entries()) { if (i % 2) { expect(s.questions[id]?.response).toBe(`Answered ${id}`); expect(entry(id).map((t) => t.snapshot.response)).toEqual(['']); } else { expect(s.tombstones[id]).toBeDefined(); expect(entry(id).map((t) => t.snapshot.response)).toEqual([`Answered ${id}`]); } }
      expect(Object.values(s.tombstones).filter((t) => t.kind === 'question').length).toBe(60 + 120);
    }
    // a PC that starts afresh on the same folder reads the same
    const C = pc('Laptop', 'kroe');
    carry(A.shared, C.shared);
    await C.store.boot();
    await C.store.loadDeal(dealId, { gaps: false });
    await settle();
    expect(dealQuestions(C.store.get(), dealId).length).toBe(1940); expect(Object.keys(C.store.get().conflicts)).toEqual([]);
    // the 60 kept deleted restore with the other PC's answer, from its entry
    for (const [i, id] of split.entries()) if (!(i % 2)) { const e = Object.values(C.store.get().tombstones).find((t: any) => t.of === id)!; okd(await C.store.dispatch(RestoreVersion, { dealId, entryId: e.id })); expect(C.store.get().questions[id].response).toBe(`Answered ${id}`); }
    expect(dealQuestions(C.store.get(), dealId).length).toBe(2000);
  }, 120_000);
});
