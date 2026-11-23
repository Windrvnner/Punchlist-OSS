// @vitest-environment node
// A deleted question comes back under its own number even when another question holds that number (#13, #116).
// The deal has the 2,400-question list, and an import adds two more questions that share one number.
import { describe, it, expect } from 'vitest';
import { carry, pc, syncAll, row, okd, settle, type PC } from './pcs';
import { dealList } from '../backend/dealList';
import { CreateDeal } from '../../src/app/commands/deals';
import { SetResponse, DeleteQuestion, RestoreQuestion, RenumberQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { RestoreVersion } from '../../src/app/commands/keptVersions';
import { dealQuestions, sharedNumbers } from '../../src/app/state';
import { deletedOf } from '../../src/ui/deleted';

const ANSWERED = 'Please confirm whether the offtaker must consent to a change of control of the project company.';
const OTHER = 'Please confirm whether the EPC contractor\'s performance bond stays in force until COD.';
const TYPED = 'Yes. Clause 14.2 of the PPA requires the offtaker\'s prior written consent; a waiver request is out.';
const FROM_B = 'Consent is required under clause 14.2; the offtaker\'s counsel has the draft waiver for review.';

/** PC A with the 2,400-question list, then a file whose two rows are both numbered 2500, opened on PC B as well */
async function sharedNumberDeal() {
  const A = pc('PC A', 'adoe');
  const B = pc('PC B', 'sroe', -3000);
  await A.store.boot();
  okd(await A.store.dispatch(CreateDeal, { name: 'Proseware Solar', folders: [] }));
  const dealId = Object.keys(A.store.get().deals)[0];
  await A.store.loadDeal(dealId, { gaps: false });
  const rows = dealList().items.map((text, i) => row(i + 1, text));
  okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }));
  const twice = [row(2500, ANSWERED), row(2500, OTHER)];
  okd(await A.store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: twice }));
  const byText = (text: string) => dealQuestions(A.store.get(), dealId).find((q) => q.text === text)!.id;
  carry(A.shared, B.shared);
  await B.store.boot();
  await B.store.loadDeal(dealId, { gaps: false });
  await settle();
  return { A, B, dealId, answered: byText(ANSWERED), other: byText(OTHER) };
}

/** the question is live under 2500 with these words, the other one is untouched, and both are marked */
function expectBothOn2500(X: PC, dealId: string, id: string, response: string, otherId: string) {
  const s = X.store.get();
  expect(s.questions[id]).toMatchObject({ n: 2500, text: ANSWERED, response });
  expect(s.questions[otherId]).toMatchObject({ n: 2500, text: OTHER, response: '' });
  expect(s.tombstones[id]).toBeUndefined();
  expect(dealQuestions(s, dealId).length).toBe(2402);
  expect([...sharedNumbers(s, dealId)]).toEqual([2500]);
}

describe('restoring a question whose number another question holds', () => {
  it('Undo and Restore bring it back marked "Same number" on both PCs, and it can be renumbered (#13)', async () => {
    const { A, B, dealId, answered, other } = await sharedNumberDeal();
    expect(dealQuestions(A.store.get(), dealId).length).toBe(2402);
    expect([...sharedNumbers(A.store.get(), dealId)]).toEqual([2500]);
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: answered, response: TYPED }));
    const deleted = okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: answered }));
    expect(sharedNumbers(A.store.get(), dealId).size).toBe(0);
    okd(await A.store.undo(deleted.value.opId));
    expectBothOn2500(A, dealId, answered, TYPED, other);
    // deleted again and synced; the other PC restores it from Deleted
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: answered }));
    await syncAll(A, B);
    expect(deletedOf(B.store.get(), dealId, 'question').map((t) => t.id)).toEqual([answered]);
    okd(await B.store.dispatch(RestoreQuestion, { dealId, questionId: answered }));
    await syncAll(A, B);
    for (const X of [A, B]) expectBothOn2500(X, dealId, answered, TYPED, other);
    okd(await A.store.dispatch(RenumberQuestion, { dealId, questionId: answered }));
    expect(A.store.get().questions[answered]).toMatchObject({ n: 2501, response: TYPED });
    expect(sharedNumbers(A.store.get(), dealId).size).toBe(0);
  }, 120_000);

  it('a kept version of it comes back under its own number, marked "Same number" (#116)', async () => {
    const { A, B, dealId, answered, other } = await sharedNumberDeal();
    // deleted on A while B answers it; A keeps it deleted, so B's words are kept under Deleted
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: answered }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: answered, response: FROM_B }));
    await syncAll(A, B);
    const gone = A.store.get().conflicts[answered].versions.find((v) => !!v.deleted)!.id;
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: answered, keep: gone }));
    await syncAll(A, B);
    const entry = deletedOf(A.store.get(), dealId, 'question').find((t) => t.of === answered)!;
    expect(entry.snapshot).toMatchObject({ n: 2500, response: FROM_B });
    okd(await A.store.dispatch(RestoreVersion, { dealId, entryId: entry.id }));
    await syncAll(A, B);
    for (const X of [A, B]) {
      expectBothOn2500(X, dealId, answered, FROM_B, other);
      expect(Object.keys(X.store.get().conflicts)).toEqual([]);
      // the words A deleted, which differ, stay listed under Deleted in the restored version's place
      const listed = deletedOf(X.store.get(), dealId, 'question');
      expect(listed.map((t) => [t.of, (t.snapshot as { response: string }).response])).toEqual([[answered, '']]);
    }
  }, 120_000);
});
