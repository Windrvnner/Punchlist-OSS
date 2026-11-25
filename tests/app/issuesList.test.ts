// Importing an issues list, at deal scale: a 164-point list into a deal with 126 findings. Each point becomes a
// finding unless it joins one: 23 join a finding already raised and 4 join an earlier point's. Every finding a point is on
// is marked with it. Undo takes the import back exactly: its findings go and only its marks come off.
import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, DeleteFinding, EditFinding, SetFindingStatus, RestoreFinding } from '../../src/app/commands/findings';
import { CreateQuestion } from '../../src/app/commands/questions';
import { ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList, removable } from '../../src/app/commands/issuesList';
import { registry, Undo } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { dealFindings } from '../../src/app/state';
import { deletedIssuesLists, issuesListRemoval } from '../../src/app/deletedView';
import { fail } from '../../src/domain/result';
import { issuesListClock, planIssuesListSeed } from './issuesListKit';

const COMMANDS = [CreateDeal, CreateFinding, DeleteFinding, RestoreFinding, EditFinding, SetFindingStatus, CreateQuestion, ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList];
for (const c of COMMANDS) registry.set(c.name, c);
const clock = issuesListClock();
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const LIST = 'Credit Agreement Issues List – Sponsor counsel (Nov 14).pdf'; const DOC = 'doc_sponsorlist14';
const findingInput = (dealId: string, index: number) => ({
  dealId, title: `Finding ${index}`, workstream: 'Legal', body: [`What finding ${index} says.`],
});

const addMark = (findingId: string, text: string, n: string) => ({
  n, text, title: text, workstream: 'Legal', join: findingId,
});

function approvedRemoval(store: Store, dealId: string) {
  const list = deletedIssuesLists(store.get(), dealId).find(({ doc }) => doc === DOC)!;
  return issuesListRemoval(list, dealId).input;
}

describe('confirmed issues list removal', () => {
  it('refuses a queued removal when another mark has joined the same finding', async () => {
    const { store, dealId, had } = await dealWith(1);
    const first = addMark(had[0], 'Distributions are permitted before the debt service test.', '1');
    const second = addMark(had[0], 'The debt service test does not define adjusted cash flow.', '2');
    const list = { dealId, doc: DOC, list: LIST };
    expect((await store.dispatch(ImportIssuesList, { ...list, points: [first] })).ok).toBe(true);
    const approval = approvedRemoval(store, dealId);
    const adding = store.dispatch(ImportIssuesList, { ...list, points: [second] });
    const removing = store.dispatch(RemoveIssuesList, approval);
    expect((await adding).ok).toBe(true);
    expect(await removing).toMatchObject({ ok: false, error: { kind: 'rejected' } });
    expect(store.get().findings[had[0]].onLists?.map(({ text }) => text)).toEqual([first.text, second.text]);
    expect((await store.dispatch(RemoveIssuesList, approvedRemoval(store, dealId))).ok).toBe(true);
    expect(store.get().findings[had[0]].onLists).toBeUndefined();
  });

  it.each([true, false])('checks a failed removal from the journal again (has original approval: %s)', async (confirmed) => {
    const { store, dealId, had } = await dealWith(2);
    const first = addMark(had[0], 'The reserve replenishment period is not defined.', '1');
    const second = addMark(had[1], 'The hedge covenant lacks a minimum term.', '2');
    const list = { dealId, doc: DOC, list: LIST };
    expect((await store.dispatch(ImportIssuesList, { ...list, points: [first] })).ok).toBe(true);
    const approval = confirmed ? approvedRemoval(store, dealId) : { dealId, doc: DOC };
    const repo = store.services.repo;
    const transact = repo.transaction.bind(repo);
    const hold = vi.spyOn(repo, 'transaction').mockImplementation((tx) => tx.writes.some((w) => w.kind === 'finding')
      ? Promise.resolve(fail({ kind: 'failed', message: 'Write refused' })) : transact(tx));
    expect(await store.dispatch(RemoveIssuesList, approval)).toMatchObject({ ok: false });
    hold.mockRestore();
    const failed = Object.values(store.get().ops)
      .find((op) => op.command === 'RemoveIssuesList' && op.state === 'failed')!;
    expect(failed.input).toEqual(approval);
    expect((await store.dispatch(ImportIssuesList, { ...list, points: [second] })).ok).toBe(true);
    expect(await store.retryOp(failed.id)).toMatchObject({ ok: false, error: { kind: 'rejected' } });
    expect(had.map((id) => store.get().findings[id].onLists?.[0].text)).toEqual([first.text, second.text]);
  });
});
const findingIds = (store: Store, dealId: string) =>
  dealFindings(store.get(), dealId).map((finding) => finding.id).sort();

async function startDeal() {
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, disk());
  const store = new Store({
    repo, ai: mockAi(opts, repo), docs: mockDocuments(opts),
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
    sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, [...COMMANDS, Undo]);
  await store.boot();
  await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id;
  return { store, dealId };
}

async function dealWith(findings: number) {
  const { store, dealId } = await startDeal();
  await store.loadDeal(dealId);
  for (let index = 0; index < findings; index++) {
    await store.dispatch(CreateFinding, findingInput(dealId, index), { quiet: true });
  }
  return { store, dealId, had: findingIds(store, dealId) };
}

/** Put the 126 existing findings in one real transaction before testing import and Undo (#130). */
async function seedEarlierFindings(store: Store, dealId: string, count: number) {
  const inputs = Array.from({ length: count }, (_, index) => findingInput(dealId, index));
  const { actor, plans, writes, index } = planIssuesListSeed(store, dealId, clock, inputs);
  const seeded = await store.services.repo.transaction({
    writes,
    index,
    audit: plans.flatMap(({ plan, at, opId }) => plan.audit.map((entry) => ({ ...entry, at, actor, opId }))),
  });
  if (!seeded.ok) throw new Error(seeded.error.message);
}
/** the 164 points, as the dialog sends them: 23 join a finding (`had[k * 5]`), 4 join an earlier point */
const points = (had: string[]) => Array.from({ length: 164 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel wrote it.`, title: `Point ${k + 1}`, workstream: k % 2 ? 'Legal' : 'Financial',
  ...(k % 7 === 0 && k < 161 ? { join: had[(k / 7) * 5] } : ({ 60: { after: 25 }, 79: { after: 29 }, 103: { after: 61 }, 141: { after: 112 } } as Record<number, { after: number }>)[k] ?? {}) }));

describe('importing an issues list', () => {
  it('makes 137 findings in the list’s order, joins 27 points, marks every finding a point is on, and Undo takes it all back', async () => {
    const { store, dealId } = await startDeal();
    await seedEarlierFindings(store, dealId, 126);
    await store.loadDeal(dealId);
    const had = findingIds(store, dealId);
    const before = Object.fromEntries(had.map((id) => [id, store.get().findings[id]]));
    const r = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points(had) });
    expect(r.ok).toBe(true);
    const all = dealFindings(store.get(), dealId); const made = all.filter((f) => !had.includes(f.id));
    expect(made.length).toBe(137); expect(all.length).toBe(263);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Imported 137 findings · 27 already raised');
    // newest first, the imported findings come first and in the list's order
    expect(all.slice(0, 3).map((f) => f.title)).toEqual(['Point 2', 'Point 3', 'Point 4']);
    const p2 = made.find((f) => f.title === 'Point 2')!;
    expect(p2).toMatchObject({ body: ['Point 2 as counsel wrote it.'], workstream: 'Legal', origin: 'human', status: 'open', onLists: [{ doc: DOC, list: LIST, n: '2', text: 'Point 2 as counsel wrote it.' }] });
    // a point joining a finding marks it and changes nothing else; a point joining an earlier point marks that point's finding
    const joined = store.get().findings[had[0]];
    expect(joined.onLists).toEqual([{ doc: DOC, list: LIST, n: '1', text: 'Point 1 as counsel wrote it.', at: expect.any(String) }]);
    expect({ ...joined, onLists: undefined, rev: 0, updatedAt: '' }).toEqual({ ...before[had[0]], onLists: undefined, rev: 0, updatedAt: '' });
    expect(made.find((f) => f.title === 'Point 26')!.onLists!.map((m) => m.n)).toEqual(['26', '61']);
    expect(all.filter((f) => f.onLists?.length).length).toBe(160);
    // Undo: back to the 126 findings exactly as they were
    const opId = (r as { value: { opId: string } }).value.opId;
    expect((await store.dispatch(Undo, { opId })).ok).toBe(true);
    const back = dealFindings(store.get(), dealId);
    expect(back.map((f) => f.id).sort()).toEqual(had);
    expect(back.every((f) => !f.onLists?.length)).toBe(true);
  });
  it('the same list imported again adds no second mark, and its Undo leaves the first import’s marks', async () => {
    const { store, dealId, had } = await dealWith(3);
    const one = [{ n: '1', text: 'As written.', title: 'One', workstream: 'Legal', join: had[0] }];
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: one });
    const again = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [...one, { n: '2', text: 'New.', title: 'Two', workstream: 'Legal' }] });
    expect(store.get().findings[had[0]].onLists!.length).toBe(1);
    await store.dispatch(Undo, { opId: (again as { value: { opId: string } }).value.opId });
    expect(store.get().findings[had[0]].onLists!.length).toBe(1);
    expect(dealFindings(store.get(), dealId).length).toBe(3);
  });
  it('two points a list numbers alike keep their own words on the finding they both join, and a blank workstream is kept blank', async () => {
    const { store, dealId, had } = await dealWith(1);
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '1', text: 'First section, point one.', title: 'A', workstream: 'Legal', join: had[0] }, { n: '1', text: 'Second section, point one.', title: 'B', workstream: 'Legal', join: had[0] }, { n: '2', text: 'Unsorted.', title: 'C', workstream: '' }] });
    expect(store.get().findings[had[0]].onLists!.map((m) => m.text)).toEqual(['First section, point one.', 'Second section, point one.']);
    expect(dealFindings(store.get(), dealId).find((f) => f.title === 'C')!.workstream).toBe('');
  });
  it('the same list brought in again on this PC raises nothing twice, even when no point is said to repeat anything', async () => {
    const { store, dealId } = await dealWith(5);
    const pts = Array.from({ length: 150 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel wrote it.`, title: `Point ${k + 1}`, workstream: 'Legal' }));
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: pts });
    expect(dealFindings(store.get(), dealId).length).toBe(155);
    // again, and with one new point and one the person checks to keep as its own
    const again = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [...pts.slice(0, 149), { ...pts[149], own: true }, { n: '151', text: 'A new point.', title: 'New', workstream: 'Legal' }] });
    expect(again.ok).toBe(true);
    expect(dealFindings(store.get(), dealId).length).toBe(157);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Imported 2 findings · 149 already raised');
    // another list with the same numbers is another list
    await store.dispatch(ImportIssuesList, { dealId, doc: 'doc_lenderlist', list: 'Lender counsel list.pdf', points: pts.slice(0, 3) });
    expect(dealFindings(store.get(), dealId).length).toBe(160);
  });
  it('a point repeating a closed finding joins it, and the finding stays closed', async () => {
    const { store, dealId, had } = await dealWith(1);
    await store.dispatch(SetFindingStatus, { dealId, findingId: had[0], status: 'closed' });
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '1', text: 'Raised again.', title: 'Again', workstream: 'Legal', join: had[0] }] });
    expect(store.get().findings[had[0]]).toMatchObject({ status: 'closed', onLists: [{ doc: DOC, list: LIST, n: '1', text: 'Raised again.' }] });
    expect(dealFindings(store.get(), dealId).map((f) => f.title)).not.toContain('Again');
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Imported 0 findings · 1 already raised');
  });
  it('the title the model wrote is marked as AI until a person rewrites it; the words stay counsel\'s', async () => {
    const { store, dealId } = await dealWith(0);
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '1', text: 'Counsel words.', title: 'Short title', workstream: 'Legal' }] });
    const f = dealFindings(store.get(), dealId)[0];
    expect(f).toMatchObject({ title: 'Short title', body: ['Counsel words.'], aiTitle: true });
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'Short title', workstream: 'Tax',
      body: f.body });
    expect(store.get().findings[f.id].aiTitle).toBe(true);
    expect(f.aiWorkstream).toBe(true); expect(store.get().findings[f.id].aiWorkstream).toBeUndefined();   // the workstream was changed
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'Our own title', workstream: 'Tax',
      body: f.body });
    expect(store.get().findings[f.id].aiTitle).toBeUndefined();
  });
  it('Undo is refused once a question is raised on an imported finding, so the question is not left linked to nothing', async () => {
    const { store, dealId } = await dealWith(0);
    const r = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '1', text: 'A point.', title: 'One', workstream: 'Legal' }] });
    const f = dealFindings(store.get(), dealId)[0];
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm the position.', linkedFinding: f.id })).ok).toBe(true);
    const u = await store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId });
    expect(u.ok).toBe(false); if (!u.ok) expect(u.error.message).toContain('is linked to an imported finding');
    expect(store.get().findings[f.id]).toBeDefined();
  });
  it('a point whose finding was deleted while the list was read becomes a finding of its own: nothing is lost', async () => {
    const { store, dealId, had } = await dealWith(2);
    await store.dispatch(DeleteFinding, { dealId, findingId: had[0] });
    expect((await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '4', text: 'Still raised.', title: 'Four', workstream: 'Legal', join: had[0] }] })).ok).toBe(true);
    expect(dealFindings(store.get(), dealId).map((f) => f.title)).toContain('Four');
  });
  it('Undo is refused once an imported finding has been edited, so the edit is not lost', async () => {
    const { store, dealId } = await dealWith(0);
    const r = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: [{ n: '1', text: 'A point.', title: 'One', workstream: 'Legal' }] });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'One, as I put it', workstream: 'Legal',
      body: ['A point.'] });
    expect((await store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(false);
    expect(store.get().findings[f.id].title).toBe('One, as I put it');
  });
  it('a list can be removed long after its notice: untouched findings go to Deleted, its marks come off, and what a person changed stays', async () => {
    const { store, dealId, had } = await dealWith(126);
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points(had) });
    const made = dealFindings(store.get(), dealId).filter((f) => !had.includes(f.id));
    // since the import: one finding retitled, one closed, one with a question linked, and one deleted by hand
    const [a, b, c, gone] = made;
    await store.dispatch(EditFinding, { dealId, findingId: a.id, title: 'Retitled by a person',
      workstream: a.workstream, body: a.body });
    await store.dispatch(SetFindingStatus, { dealId, findingId: b.id, status: 'closed' });
    await store.dispatch(CreateQuestion, { dealId, text: 'Is this agreed?', linkedFinding: c.id });
    await store.dispatch(DeleteFinding, { dealId, findingId: gone.id });
    expect(removable(store.get(), dealId, DOC)).toMatchObject({ kept: 3 });
    const r = await store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect(r.ok).toBe(true);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Removed 133 findings · 3 findings kept, changed since');
    const left = dealFindings(store.get(), dealId);
    expect(left.map((f) => f.id).sort()).toEqual([...had, a.id, b.id, c.id].sort());
    // the findings its points joined lose only its marks; the kept ones keep theirs, and nothing else changed
    expect(had.every((id) => !store.get().findings[id].onLists?.length)).toBe(true);
    expect(store.get().findings[a.id]).toMatchObject({ title: 'Retitled by a person', onLists: a.onLists });
    expect(store.get().findings[b.id].status).toBe('closed');
    // each removed finding is in Deleted, and can be put back one at a time, with its mark
    const p9 = made.find((f) => f.title === 'Point 9')!;
    expect(store.get().tombstones[p9.id]).toMatchObject({ kind: 'finding', title: 'Point 9' });
    expect((await store.dispatch(RestoreFinding, { dealId, findingId: p9.id })).ok).toBe(true);
    expect(store.get().findings[p9.id].onLists).toEqual(p9.onLists);
    // a finding a person put back is theirs now, like the ones they changed: the list is not offered again
    expect(removable(store.get(), dealId, DOC)).toMatchObject({ made: [], joined: [], kept: 4 });
  });
  it('a removal is undone whole: the findings come back from Deleted and the marks go back on', async () => {
    const { store, dealId, had } = await dealWith(126);
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points(had) });
    const was = JSON.stringify(dealFindings(store.get(), dealId).map((f) => [f.id, f.title, f.onLists]).sort());
    const r = await store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect(dealFindings(store.get(), dealId).length).toBe(126);
    expect((await store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(true);
    expect(JSON.stringify(dealFindings(store.get(), dealId).map((f) => [f.id, f.title, f.onLists]).sort())).toBe(was);
    expect(Object.values(store.get().tombstones).filter((t) => t.dealId === dealId).length).toBe(0);
    // a list with nothing left to remove is refused, and changes nothing
    await store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect((await store.dispatch(RemoveIssuesList, { dealId, doc: DOC })).ok).toBe(false);
  });
  it('a finding closed and reopened, or talked about, is kept; a removal is undone even after another change', async () => {
    const { store, dealId, had } = await dealWith(10);
    const pts = Array.from({ length: 6 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel wrote it.`, title: `Point ${k + 1}`, workstream: 'Legal', ...(k === 5 ? { join: had[0] } : {}) }));
    await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: pts });
    const made = dealFindings(store.get(), dealId).filter((f) => !had.includes(f.id));
    await store.dispatch(SetFindingStatus, { dealId, findingId: made[0].id, status: 'closed' });
    await store.dispatch(SetFindingStatus, { dealId, findingId: made[0].id, status: 'open' });
    // a conversation held on one (the store keeps conversations itself; set here as a chat would leave it)
    (store as unknown as { set: (s: unknown) => void }).set({ ...store.get(), threads: { [`f:${dealId}:${made[1].id}`]: [{ role: 'user', text: 'Is this agreed?' }] } });
    expect(removable(store.get(), dealId, DOC)).toMatchObject({ kept: 2 });
    const r = await store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Removed 3 findings · 2 findings kept, changed since');
    // since the removal: someone edits the finding a point joined, and puts one finding back, and deletes it again
    const f0 = store.get().findings[had[0]];
    await store.dispatch(EditFinding, { dealId, findingId: f0.id, title: 'Edited since', workstream: f0.workstream,
      body: f0.body });
    const back = made.find((f) => store.get().tombstones[f.id])!;
    await store.dispatch(RestoreFinding, { dealId, findingId: back.id }); await store.dispatch(DeleteFinding, { dealId, findingId: back.id });
    // the Undo still goes through: the mark goes back on the edited finding, the others come back, and the delete stands
    expect((await store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(true);
    expect(store.get().findings[had[0]]).toMatchObject({ title: 'Edited since', onLists: [expect.objectContaining({ n: '6' })] });
    expect(dealFindings(store.get(), dealId).length).toBe(10 + 4);
    expect(store.get().tombstones[back.id]).toBeTruthy();
    // what the Undo put back is as the list made it, so the list can be removed again
    expect(removable(store.get(), dealId, DOC).made.length).toBe(2);
  });
});
