// @vitest-environment node
// No choice between versions throws a version away: whichever is kept, every other version is listed under
// Deleted as an entry of its own, with the PC it came from, and restores. Two PCs that deleted different words keep both.
import { describe, it, expect } from 'vitest';
import { pc, carry, settle, syncAll, twoPcs, okd, type PC } from './pcs';
import '../ui/keptTextSession';
import { deletedOf } from '../../src/ui/deleted';
import { DeleteDeal } from '../../src/app/commands/deals';
import { EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { EditFinding, DeleteFinding, RestoreFinding } from '../../src/app/commands/findings';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { RestoreVersion } from '../../src/app/commands/keptVersions';
import { Undo } from '../../src/app/commands/undo';

const entries = (X: PC, of: string) => Object.values(X.store.get().tombstones).filter((t: any) => t.of === of) as any[];
const versions = (X: PC, id: string) => X.store.get().conflicts[id]?.versions ?? [];
const pick = (X: PC, id: string, f: (v: any) => boolean) => versions(X, id).find(f)!.id;
const undo = (X: PC, r: any) => X.store.dispatch(Undo, { opId: r.value.opId });

describe('a restore beside an edit then delete on another PC', () => {
  async function setUp() {
    const t = await twoPcs(); const { A, B, dealId, qid } = t;
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await A.store.dispatch(RestoreQuestion, { dealId, questionId: qid }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond issued March 3.' })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B);
    return t;
  }
  it('the deleted version shows the words B deleted, on both PCs', async () => {
    const { A, B, qid } = await setUp();
    for (const X of [A, B]) expect(versions(X, qid).map((v: any) => [!!v.deleted, v.from, v.data?.response])).toEqual([[false, 'PC A', ''], [true, 'PC B', 'Bond issued March 3.']]);
  });
  it('keeping A’s version lists B’s response under Deleted, from B, and it restores beside A’s as two versions', async () => {
    const { A, B, dealId, qid } = await setUp();
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !v.deleted) })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid].response).toBe(''); expect(entries(X, qid).map((e) => [e.snapshot.response, e.from, !!e.edited])).toEqual([['Bond issued March 3.', 'PC B', false]]); }
    // restored while the question is there: it comes back beside it, for a person to choose
    okd(await B.store.dispatch(RestoreVersion, { dealId, entryId: entries(B, qid)[0].id }));
    expect(versions(B, qid).map((v: any) => v.data.response).sort()).toEqual(['', 'Bond issued March 3.']); expect(entries(B, qid)).toEqual([]);
    await syncAll(A, B); expect(versions(A, qid).length).toBe(2);
    // keeping B's words now: A's version (no response) is the entry
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !!v.data.response) })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid].response).toBe('Bond issued March 3.'); expect(entries(X, qid).map((e) => [e.snapshot.response, !!e.edited])).toEqual([['', true]]); }
  });
  it('keeping it deleted: the note holds B’s response, and A’s version is an entry; either restores', async () => {
    const { A, B, dealId, qid } = await setUp();
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !!v.deleted) })); await syncAll(A, B);
    for (const X of [A, B]) { expect((X.store.get().tombstones[qid] as any).snapshot.response).toBe('Bond issued March 3.'); expect(entries(X, qid).map((e) => [e.snapshot.response, e.from, !!e.edited])).toEqual([['', 'PC A', true]]); }
    // restoring the entry with the question deleted: A's version comes back, and B's response becomes the entry
    okd(await B.store.dispatch(RestoreVersion, { dealId, entryId: entries(B, qid)[0].id })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid].response).toBe(''); expect(X.store.get().tombstones[qid]).toBeUndefined(); expect(entries(X, qid).map((e) => e.snapshot.response)).toEqual(['Bond issued March 3.']); }
  });
  it('Undo of the choice takes away the entry it made, and the two versions stand again', async () => {
    const { A, dealId, qid } = await setUp();
    const r = okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !v.deleted) }));
    expect(entries(A, qid).length).toBe(1);
    okd(await undo(A, r));
    expect(entries(A, qid)).toEqual([]); expect(versions(A, qid).map((v: any) => [!!v.deleted, v.data?.response])).toEqual([[false, ''], [true, 'Bond issued March 3.']]);
  });
});

describe('two different edits, each deleted on its own PC', () => {
  async function setUp() {
    const t = await twoPcs(); const { A, B, dealId, qid } = t;
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed on A.' })); okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed on B.' })); okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B);
    return t;
  }
  const listed = (X: PC, qid: string) => { const t = X.store.get().tombstones[qid] as any; return [[t.snapshot.response, t.from], ...(t.copies ?? []).map((c: any) => [c.snapshot.response, c.from])].sort(); };
  it('both copies are listed, the same on both PCs, each with its PC', async () => {
    const { A, B, qid } = await setUp();
    for (const X of [A, B]) expect(listed(X, qid)).toEqual([['Typed on A.', 'PC A'], ['Typed on B.', 'PC B']]);
  });
  for (const which of ['first', 'copy'] as const) it(`restoring the ${which} keeps the other as an entry`, async () => {
    const { A, B, dealId, qid } = await setUp();
    const t = B.store.get().tombstones[qid] as any; const copy = which === 'copy' ? { copy: t.copies[0].ver } : {};
    const want = which === 'copy' ? t.copies[0].snapshot.response : t.snapshot.response;
    okd(await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid, ...copy })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid].response).toBe(want); expect(entries(X, qid).map((e) => e.snapshot.response)).toEqual([['Typed on A.', 'Typed on B.'].find((x) => x !== want)]); }
  });
  it('a finding as well', async () => {
    const { A, B, dealId, fid } = await twoPcs();
    okd(await A.store.dispatch(EditFinding, { dealId, findingId: fid, title: 'Lock-up ratio below covenant',
      workstream: 'Financial', body: ['Seen on A.'] }));
    okd(await A.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    okd(await B.store.dispatch(EditFinding, { dealId, findingId: fid, title: 'Lock-up ratio below covenant',
      workstream: 'Financial', body: ['Seen on B.'] }));
    okd(await B.store.dispatch(DeleteFinding, { dealId, findingId: fid }));
    await syncAll(A, B);
    okd(await A.store.dispatch(RestoreFinding, { dealId, findingId: fid })); await syncAll(A, B);
    for (const X of [A, B]) { const kept = X.store.get().findings[fid].body[0]; expect(entries(X, fid).map((e) => e.snapshot.body[0])).toEqual([kept === 'Seen on A.' ? 'Seen on B.' : 'Seen on A.']); }
  });
});

describe('an ordinary choice between two edits', () => {
  it('the version not kept is listed under Deleted; one that says the same as the kept one is not', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is the bond in place?' }));
    okd(await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Is the decommissioning bond issued?' }));
    await syncAll(A, B);
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(B, qid, (v) => v.here) })); await syncAll(A, B);
    for (const X of [A, B]) expect(entries(X, qid).map((e) => [e.snapshot.text, e.from, !!e.edited])).toEqual([['Is the bond in place?', 'PC A', true]]);
  });
  it('picked opposite ways at once on two PCs: the choice comes back once, and the next pick leaves one entry, not two', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Wording A' }));
    okd(await B.store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Wording B' }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => v.here) }));
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(B, qid, (v) => v.here) }));
    await syncAll(A, B);
    for (const X of [A, B]) expect(versions(X, qid).map((v: any) => v.data.text).sort()).toEqual(['Wording A', 'Wording B']);
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(B, qid, (v) => v.data.text === 'Wording A') })); await syncAll(A, B);
    for (const X of [A, B]) { expect(X.store.get().questions[qid].text).toBe('Wording A'); expect(X.store.get().conflicts[qid]).toBeUndefined(); expect(entries(X, qid).map((e) => e.snapshot.text)).toEqual(['Wording B']); }
  });
});

describe('entries are kept until the deal is deleted', () => {
  it('only deleting the deal takes them away', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid })); okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Kept.' }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !v.deleted) })); await syncAll(A, B);
    expect(entries(A, qid).length).toBe(1);
    // a fresh PC on the same folder lists it too
    const C = pc('Laptop', 'kroe');
    for (const [n, t] of A.shared.files) C.shared.files.set(n, t);
    await C.store.boot();
    await C.store.loadDeal(dealId, { gaps: false });
    expect(entries(C, qid).length).toBe(1);
    okd(await A.store.dispatch(DeleteDeal, { dealId, typedName: A.store.get().deals[dealId].name }));
    expect(entries(A, qid)).toEqual([]);
  });
});

describe('entry ids', () => {
  it('two different versions whose marks match do not share an entry', async () => {
    const { keepAside, entryId } = await import('../../src/app/commands/keptVersions');
    const snap = { id: 'q1', text: 'Mine' }; const other = { id: 'q1', text: 'Theirs' };
    const have = { [entryId('q1', snap)]: { kind: 'question', dealId: 'd_1', id: entryId('q1', snap), title: '', at: '2026-11-17T00:00:00Z', actor: 'X', snapshot: other } } as any;
    const r = keepAside('question', 'd_01HPRBFXXXXXXXXXXXT0000001', 'q1', [{ snapshot: snap, by: 'sroe', from: 'PC B', at: '2026-11-17T00:00:00Z' }], [], have);
    expect(r.ids).toEqual([`${entryId('q1', snap)}.2`]);
    // the same words already there are the same entry
    const same = keepAside('question', 'd_01HPRBFXXXXXXXXXXXT0000001', 'q1', [{ snapshot: other, by: 'sroe', from: 'PC B', at: '2026-11-17T00:00:00Z' }], [], { [entryId('q1', other)]: { ...have[entryId('q1', snap)], id: entryId('q1', other) } });
    expect(same.ids).toEqual([entryId('q1', other)]);
  });
});

describe('a version set aside can be seen and brought back once its notice has gone', () => {
  it('three versions of a response: the two not kept are under Deleted with their PCs, on every PC and after a restart, and either comes back', async () => {
    const { A, B, dealId, qid } = await twoPcs(); const C = pc('Meeting room PC', 'kroe', 3000);
    carry(A.shared, C.shared); await C.store.boot(); await C.store.loadDeal(dealId, { gaps: false }); await settle();
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond to be issued at financial close.' }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond issued March 3, 2025 by Woodgrove, USD 4m; copy in folder 5.4, document 9.' }));
    okd(await C.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Sponsor says the bond is covered by the parent guarantee.' }));
    await syncAll(A, B, C);
    expect(versions(A, qid).length).toBe(3);
    // the wrong one kept, in a run through many: no Undo is pressed, and the notice is long gone
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => v.here) })); await syncAll(A, B, C);
    const want = [['Bond issued March 3, 2025 by Woodgrove, USD 4m; copy in folder 5.4, document 9.', 'PC B'], ['Sponsor says the bond is covered by the parent guarantee.', 'Meeting room PC']];
    const fresh = pc('Spare laptop', 'adoe', 60_000);
    carry(A.shared, fresh.shared);
    await fresh.store.boot();
    await fresh.store.loadDeal(dealId, { gaps: false });
    await settle();
    for (const X of [A, B, C, fresh]) {
      expect(X.store.get().questions[qid].response).toBe('Bond to be issued at financial close.');
      expect(deletedOf(X.store.get(), dealId, 'question').filter((t: any) => t.of === qid).map((t: any) => [t.snapshot.response, t.from]).sort()).toEqual(want);
    }
    // B's words brought back from Deleted on the fresh PC: they stand beside the kept version, and keeping them ends it
    const e = entries(fresh, qid).find((t) => t.from === 'PC B');
    okd(await fresh.store.dispatch(RestoreVersion, { dealId, entryId: e.id }));
    expect(versions(fresh, qid).length).toBe(2);
    okd(await fresh.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(fresh, qid, (v) => v.data?.response?.startsWith('Bond issued')) })); await syncAll(A, B, C, fresh);
    for (const X of [A, B, C, fresh]) {
      expect(X.store.get().questions[qid].response).toBe(want[0][0]);
      expect(entries(X, qid).map((t) => t.snapshot.response).sort()).toEqual(['Bond to be issued at financial close.', want[1][0]]);   // nothing is lost the other way either
    }
  });
  it('a finding as well: the version not kept is under Deleted and comes back', async () => {
    const { A, B, dealId, fid } = await twoPcs();
    okd(await A.store.dispatch(EditFinding, { dealId, findingId: fid,
      title: 'Lock-up ratio below covenant at Q3 test date', workstream: 'Financial',
      body: ['DSCR 1.05x against 1.10x.'] }));
    okd(await B.store.dispatch(EditFinding, { dealId, findingId: fid, title: 'DSCR lock-up breached at Q3',
      workstream: 'Financial', body: ['DSCR 1.05x against 1.10x.'] }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: fid, keep: pick(A, fid, (v) => v.here) })); await syncAll(A, B);
    for (const X of [A, B]) expect(deletedOf(X.store.get(), dealId, 'finding').filter((t: any) => t.of === fid).map((t: any) => [t.snapshot.title, t.from])).toEqual([['DSCR lock-up breached at Q3', 'PC B']]);
    okd(await B.store.dispatch(RestoreVersion, { dealId, entryId: entries(B, fid)[0].id }));
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: fid, keep: pick(B, fid, (v) => v.data?.title === 'DSCR lock-up breached at Q3') })); await syncAll(A, B);
    for (const X of [A, B]) expect(X.store.get().findings[fid].title).toBe('DSCR lock-up breached at Q3');
  });
});

describe('a version not kept is "Superseded by" whoever chose, not its author', () => {
  const meta = (X: PC, qid: string) => entries(X, qid).map((e) => [e.snapshot.response, e.from, e.actor.split(' · ')[0], !!e.edited]);
  it('adoe keeps their own answer: sroe’s answer is listed as from PC B, superseded by adoe', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed by adoe.' }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed by sroe.' }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => v.here) })); await syncAll(A, B);
    for (const X of [A, B]) expect(meta(X, qid)).toEqual([['Typed by sroe.', 'PC B', 'adoe', true]]);
  });
  it('kept deleted by sroe: adoe’s edit is superseded by sroe, and the deletion stays Deleted by whoever deleted it', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed by adoe.' }));
    okd(await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid }));
    await syncAll(A, B);
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(B, qid, (v) => v.deleted) })); await syncAll(A, B);
    for (const X of [A, B]) { expect(meta(X, qid)).toEqual([['Typed by adoe.', 'PC A', 'sroe', true]]); expect(X.store.get().tombstones[qid].actor.split(' · ')[0]).toBe('sroe'); }
  });
  it('picked opposite ways at once by two people: one entry each way, nothing left to choose, and every answer kept', async () => {
    const { A, B, dealId, qid } = await twoPcs();
    okd(await A.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed by adoe.' }));
    okd(await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed by sroe.' }));
    await syncAll(A, B);
    okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => !v.here) }));
    okd(await B.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(B, qid, (v) => !v.here) }));
    await syncAll(A, B);
    // the two choices cross: the choice comes back once, and the next pick settles it on both PCs
    if (versions(A, qid).length) { okd(await A.store.dispatch(ResolveConflict, { dealId, recordId: qid, keep: pick(A, qid, (v) => v.data?.response === 'Typed by sroe.') })); await syncAll(A, B); }
    for (const X of [A, B]) {
      expect(versions(X, qid)).toEqual([]); expect(((await X.repo.sync()) as any).value.clashes).toEqual([]);
      const said = [X.store.get().questions[qid].response, ...entries(X, qid).map((e) => e.snapshot.response)];
      expect(said).toContain('Typed by adoe.'); expect(said).toContain('Typed by sroe.');
    }
    okd(
      await A.store.dispatch(RestoreVersion, {
        dealId,
        entryId: entries(A, qid).find((e) => e.snapshot.response === 'Typed by adoe.').id,
      }),
    );
  });
});
