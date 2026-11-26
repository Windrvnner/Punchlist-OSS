// @vitest-environment node
// The firm's checklist and each deal's items (linking design, sections 4, 5 and 13), on the real record store, two PCs.
import { describe, it, expect } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal, EditDeal } from '../../src/app/commands/deals';
import { AddDealItems, SetItemsOff, RegroupDealItems, BringInList, RestoreList, offeredItems, unlistedItems } from '../../src/app/commands/checklist';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { CreateQuestion, DeleteQuestion, SetQuestionsStatus } from '../../src/app/commands/questions';
import { settledQuestions, unresolvedPoints } from '../../src/app/state';
import { AddUnresolved } from '../../src/app/commands/addUnresolved';
import { linkApproval } from '../../src/app/unresolvedLinks';
import { RevertImport } from '../../src/app/commands/importQuestions';
import { CreateFinding } from '../../src/app/commands/findings';
import { registry, Undo } from '../../src/app/commands/undo';
import { bringIn, undoBringIn } from '../../src/app/checklistImport';
import { conflictLabel } from '../../src/app/state';
import { itemId, firmOf, listId, type Layer } from '../../src/domain/checklist';
import { searchGroups, allHits, loadAllForSearch, GROUP_SHOWN, GROUP_PAGE, type HitKind } from '../../src/app/search';
import { ITEMS } from '../fixtures/pastedList';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, EditDeal, CreateQuestion, DeleteQuestion, SetQuestionsStatus, AddUnresolved, RevertImport, CreateFinding, AddDealItems, SetItemsOff, RegroupDealItems, BringInList, RestoreList, ResolveConflict, ReopenConflict, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
function pc(label: string, user: string) {
  const shared = new Mem(), local = new Mem(); let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0, 0) + (tick++) * 1000).toISOString();
  const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => label.replace(/\W/g, '').toLowerCase() });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: user, initials: 'XX' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: new MemoryLocal(),
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXT${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  return { repo, shared, local, store, label };
}
type PC = ReturnType<typeof pc>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
async function syncAll(...ps: PC[]) { carry(...ps.map((p) => p.shared)); for (const p of ps) await p.repo.sync(); await settle(); }
const list = (layer: Layer, name: string, items: string[]) => ({ layer, name, items: items.map((text) => ({ text })), file: 'list.xlsx', fileDate: '' });
const itemsOf = (p: PC, dealId: string) => Object.values(p.store.get().items).filter((i) => i.dealId === dealId).sort((a, b) => a.text.localeCompare(b.text));
async function deal(p: PC, name: string, kinds: { product?: string; technology?: string } = {}) {
  const r = await p.store.dispatch(CreateDeal, { name, folders: [], ...kinds }); expect(r.ok).toBe(true);
  await p.store.settled((r as any).value.opId);
  const id = Object.values(p.store.get().deals).find((d) => d.name === `Project ${name}`)!.id; await p.store.loadDeal(id, { gaps: false }); return id;
}

describe('the firm’s checklist and each deal’s items', () => {
  it('questions whose item is settled are offered to be closed, closed together, and opened again with one Undo', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const a = await deal(A, 'Proseware');
    const texts = ['Executed direct agreement', 'Insurance is in place', 'Model is audited'];
    expect((await A.store.dispatch(AddDealItems, { dealId: a, items: texts.map((text) => ({ text, from: [{ layer: 'deal' as const, value: '' }] })) })).ok).toBe(true);
    const [direct, insurance, model] = texts.map((t) => itemId(a, t));
    for (const [i, text] of [[direct, 'Provide the executed direct agreement.'], [insurance, 'Confirm the insurance.'], [model, 'Who audited the model?'], [direct, 'Has the direct agreement been amended?']] as const)
      expect((await A.store.dispatch(CreateQuestion, { dealId: a, text, linkedItem: i })).ok).toBe(true);
    await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Tied to nothing' });
    // how the items stand: the direct agreement settled on a page, the insurance a gap, the model not yet checked
    const row = (id: string, text: string, result: any, extra = {}) => ({ id, text, result, docs: [], ...extra });
    const st = { ...A.store.get(), checklists: { [a]: [row(direct, texts[0], 'satisfied', { sources: [{ doc: 'Direct agreement.pdf', docId: 'd1', loc: 'p. 12' }] }), row(insurance, texts[1], 'gap'), row(model, texts[2], 'unchecked')] } };
    const qs = Object.values(st.questions).filter((q) => q.dealId === a).sort((x, y) => x.n - y.n);
    const got = settledQuestions(st, a);
    expect(got.close.map((x) => [x.q.n, x.item, x.where])).toEqual([[1, texts[0], 'Direct agreement.pdf, p. 12'], [4, texts[0], 'Direct agreement.pdf, p. 12']]);
    expect(got.left).toEqual([]);
    // a turned-off item settles nothing: its last result stays in the rows, but it is no longer checked for the deal
    expect(settledQuestions({ ...st, items: { ...st.items, [direct]: { ...st.items[direct], off: true } } }, a).close).toEqual([]);
    // a question in two versions is left out and named, and a closed one is not offered again
    const two = settledQuestions({ ...st, conflicts: { [qs[0].id]: { versions: [{}, {}] } as any } }, a);
    expect(two.close.map((x) => x.q.n)).toEqual([4]); expect(two.left.map((x) => [x.q.n, x.why])).toEqual([[1, 'Two versions: choose one first']]);
    // a satisfied item whose place no longer opens settles nothing (decisions: "satisfied" always rests on a place that opens)
    const nowhere = settledQuestions({ ...st, checklists: { [a]: [row(direct, texts[0], 'satisfied'), row(insurance, texts[1], 'gap'), row(model, texts[2], 'unchecked')] } }, a);
    expect(nowhere.close).toEqual([]); expect(nowhere.left.map((x) => [x.q.n, x.why])).toEqual([[1, 'Its document is no longer here'], [4, 'Its document is no longer here']]);
    // only open questions are offered (mock-up link-qa-settled): an answered one is not
    expect(settledQuestions({ ...st, questions: { ...st.questions, [qs[3].id]: { ...qs[3], status: 'answered' } } }, a).close.map((x) => x.q.n)).toEqual([1]);
    // closing both is one change; Undo opens both again
    const r = await A.store.dispatch(SetQuestionsStatus, { dealId: a, set: got.close.map((x) => ({ questionId: x.q.id, status: 'closed' as const })) }); expect(r.ok).toBe(true);
    expect([qs[0], qs[3]].map((q) => A.store.get().questions[q.id].status)).toEqual(['closed', 'closed']);
    expect(settledQuestions({ ...A.store.get(), checklists: st.checklists }, a).close).toEqual([]);
    expect((await A.store.dispatch(Undo, { opId: (r as any).value.opId })).ok).toBe(true);
    expect([qs[0], qs[3]].map((q) => A.store.get().questions[q.id].status)).toEqual(['open', 'open']);
    // a question that is gone stops the whole change: nothing is closed
    expect((await A.store.dispatch(SetQuestionsStatus, { dealId: a, set: [{ questionId: qs[0].id, status: 'closed' }, { questionId: 'q_01HPRBFXXXXXXXXXXXT9999999', status: 'closed' }] })).ok).toBe(false);
    expect(A.store.get().questions[qs[0].id].status).toBe('open');
  });

  it('a question about a finding is offered to close only once a person has closed the finding, even when a later check settles its item', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const a = await deal(A, 'Proseware');
    expect((await A.store.dispatch(AddDealItems, { dealId: a, items: [{ text: 'Lock-up ratio as agreed', from: [{ layer: 'deal' as const, value: '' }] }] })).ok).toBe(true);
    const item = itemId(a, 'Lock-up ratio as agreed');
    expect((await A.store.dispatch(CreateFinding, { dealId: a, title: 'Lock-up ratio differs',
      workstream: 'Legal' })).ok).toBe(true);
    const f = Object.values(A.store.get().findings).find((x) => x.dealId === a)!;
    await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Which ratio was agreed?', linkedFinding: f.id });
    const rows = { [a]: [{ id: item, text: 'Lock-up ratio as agreed', result: 'satisfied' as const, docs: [], sources: [{ doc: 'x.pdf', docId: 'd1', loc: 'p. 1' }] }] };
    const withItem = (status: 'open' | 'closed') => ({ ...A.store.get(), checklists: rows, findings: { ...A.store.get().findings, [f.id]: { ...f, itemId: item, status } } });
    const open = settledQuestions(withItem('open'), a);
    expect(open.close).toEqual([]); expect(open.left.map((x) => x.why)).toEqual(['Its finding is still open']);
    expect(settledQuestions(withItem('closed'), a).close.map((x) => x.where)).toEqual(['finding closed']);
    // asked from the flagged item, the question carries the item too: the same rule holds
    await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Has the ratio been agreed?', linkedFinding: f.id, linkedItem: item });
    const both = settledQuestions(withItem('open'), a);
    expect(both.close).toEqual([]); expect(both.left.map((x) => x.why)).toEqual(['Its finding is still open', 'Its finding is still open']);
    expect(settledQuestions(withItem('closed'), a).close.map((x) => x.where)).toEqual(['finding closed', 'finding closed']);
    // a checklist that could not be read offers nothing to close
    expect(settledQuestions({ ...withItem('closed'), checklists: { [a]: 'failed' as const } }, a)).toEqual({ close: [], left: [] });
  });

  it('Add all unresolved offers each gap and open finding not asked about, with a likely open question to link, and writes them as one change with one Undo', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const a = await deal(A, 'Proseware');
    const texts = ['Executed direct agreement', 'Insurance advisor final report', 'Model is audited'];
    expect((await A.store.dispatch(AddDealItems, { dealId: a, items: texts.map((text) => ({ text, from: [{ layer: 'deal' as const, value: '' }] })) })).ok).toBe(true);
    const [direct, insurance, model] = texts.map((t) => itemId(a, t));
    expect((await A.store.dispatch(CreateFinding, { dealId: a, title: 'Lock-up ratio differs from the term sheet',
      workstream: 'Legal' })).ok).toBe(true);
    const f = Object.values(A.store.get().findings).find((x) => x.dealId === a)!;
    await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Has the insurance advisor issued its final report yet?' });   // open, unlinked: may already ask the insurance gap
    await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Who audited the model?', linkedItem: model });
    const row = (id: string, text: string, result: any, extra = {}) => ({ id, text, result, docs: [], ...extra });
    const rows = [row(direct, texts[0], 'gap', { need: 'A signed copy of the direct agreement' }), row(insurance, texts[1], 'gap', { need: 'The final report from the insurance advisor' }), row(model, texts[2], 'gap')];
    const st = () => ({ ...A.store.get(), checklists: { [a]: rows } });
    const got = unresolvedPoints(st(), a);
    // the model gap has a question already; the finding and two gaps do not
    expect(got.points.map((p) => [p.kind, p.what])).toEqual([['finding', f.title], ['gap', texts[0]], ['gap', texts[1]]]);
    // no question is offered for a point by similar words: only a link a person approved is kept
    expect(got.links).toEqual([]);
    // a turned-off item keeps its last result in the rows, but is not offered (as the Checklist page drops it), nor is a finding raised on it
    const off = (x: ReturnType<typeof st>, id: string) => ({ ...x, items: { ...x.items, [id]: { ...x.items[id], off: true } } });
    expect(unresolvedPoints(off(st(), direct), a).points.map((p) => p.what)).toEqual([f.title, texts[1]]);
    expect(unresolvedPoints({ ...off(st(), direct), findings: { ...st().findings, [f.id]: { ...f, itemId: direct } } }, a).points.map((p) => p.what)).toEqual([texts[1]]);
    // the person keeps two new questions and the link; the store must see the checklist to check the items
    (A.store as any).set(st());
    const q = Object.values(A.store.get().questions).find((x) => x.dealId === a && x.n === 1)!;
    const approval = linkApproval({ q, point: got.points.find((point) => point.key === 'i:' + insurance)! });
    const r = await A.store.dispatch(AddUnresolved, {
      dealId: a,
      add: [
        { text: 'Which lock-up ratio was agreed?', workstream: 'Legal', linkedFinding: f.id },
        { text: 'Please provide the executed direct agreement.', linkedItem: direct },
      ],
      link: [{ questionId: q.id, linkedItem: insurance, approval: approval.fingerprint }],
    });
    expect(r.ok).toBe(true);
    const qs = () => Object.values(A.store.get().questions).filter((q) => q.dealId === a).sort((x, y) => x.n - y.n);
    expect(qs().map((q) => [q.n, q.linkedItem?.id ?? null, q.linkedFinding ?? null])).toEqual([[1, insurance, null], [2, model, null], [3, null, f.id], [4, direct, null]]);
    expect(unresolvedPoints(st(), a).points).toEqual([]);
    // the same again is refused, naming the question asked since, and writes nothing
    const again = await A.store.dispatch(AddUnresolved, { dealId: a, add: [{ text: 'Again', linkedItem: direct }], link: [] });
    expect(!again.ok && again.error.message).toBe(`Q4 was asked about “${texts[0]}” since`); expect(qs().length).toBe(4);
    // one point asked twice in a change, or an item a document has settled since, is refused whole
    (A.store as any).set({ ...A.store.get(), checklists: { [a]: [...rows, row('i_x', 'Hedging in place', 'gap'), row('i_y', 'Model is audited (base case)', 'satisfied', { sources: [{ doc: 'm.pdf', docId: 'd2', loc: 'p. 3' }] })] } });
    const twice = await A.store.dispatch(AddUnresolved, { dealId: a, add: [{ text: 'One', linkedItem: 'i_x' }, { text: 'Two', linkedItem: 'i_x' }], link: [] });
    expect(!twice.ok && twice.error.message).toBe('“Hedging in place” is asked about twice in this change');
    const settled = await A.store.dispatch(AddUnresolved, { dealId: a, add: [{ text: 'Audited?', linkedItem: 'i_y' }], link: [] });
    expect(!settled.ok && settled.error.message).toBe('“Model is audited (base case)” is no longer a gap'); expect(qs().length).toBe(4);
    // one Undo takes the new questions back and the link off
    expect((await A.store.dispatch(Undo, { opId: (r as any).value.opId })).ok).toBe(true);
    expect(qs().map((q) => [q.n, q.linkedItem?.id ?? null])).toEqual([[1, null], [2, model]]);
  });

  it('a question asked for an item names it, and only an item of its own deal (linking design, section 6)', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const a = await deal(A, 'Proseware'); const b = await deal(A, 'Wingtip');
    const add = (id: string, text: string) => A.store.dispatch(AddDealItems, { dealId: id, items: [{ text, from: [{ layer: 'deal', value: '' }] }] });
    expect((await add(a, 'Executed direct agreement')).ok && (await add(b, 'Insurance is in place')).ok).toBe(true);
    const mine = itemId(a, 'Executed direct agreement'); const theirs = itemId(b, 'Insurance is in place');
    const r = await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Please provide the executed direct agreement.', linkedItem: mine }); expect(r.ok).toBe(true);
    const q = Object.values(A.store.get().questions).find((x) => x.dealId === a)!;
    expect(q.linkedItem).toEqual({ id: mine });
    // an item of another deal, or none at all, is refused, and nothing is written
    for (const id of [theirs, 'i_000000000000000000000000']) expect((await A.store.dispatch(CreateQuestion, { dealId: a, text: 'Wrong item', linkedItem: id })).ok).toBe(false);
    expect(Object.values(A.store.get().questions).filter((x) => x.dealId === a).length).toBe(1);
    // the link is kept as the record is written and read back on another PC
    const B = pc('Laptop', 'adoe');
    B.shared.files = A.shared.files;
    await B.store.boot();
    await B.store.loadDeal(a, { gaps: false });
    expect(B.store.get().questions[q.id]?.linkedItem).toEqual({ id: mine });
  });

  it('bringing in the general list adds its items to every deal not Closed, and Undo all takes it back', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const live = await deal(A, 'Proseware'); const closed = await deal(A, 'Wingtip');
    await A.store.dispatch(EditDeal, { dealId: closed, group: 'closed' });
    const r = await bringIn(A.store, list('broad', '', ['Insurance is in place', 'The model is audited.', 'insurance is in place']));
    expect(r.ok && { items: r.value.items, deals: r.value.deals }).toEqual({ items: 2, deals: 1 });
    expect(itemsOf(A, live).map((i) => i.text)).toEqual(['Insurance is in place', 'The model is audited.']);
    expect(itemsOf(A, closed)).toEqual([]);
    expect(firmOf(A.store.get().firmList).lists.map((l) => [l.layer, l.items.length, l.by])).toEqual([
      ['broad', 3, 'adoe'],
    ]);
    expect((await undoBringIn(A.store, (r as any).value.opIds)).ok).toBe(true);
    expect(itemsOf(A, live).map((i) => i.off)).toEqual([true, true]);                      // items are never removed: Undo turns them off
    expect(firmOf(A.store.get().firmList).lists).toEqual([]);
  });

  it('bringing a list in again groups the items a deal already holds as the list now is, turned off or not, and Undo all puts the old grouping back', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const id = await deal(A, 'Proseware');
    await bringIn(A.store, list('broad', '', ['Insurance is in place', 'The model is audited.']));            // a list from before sections
    await A.store.dispatch(SetItemsOff, { dealId: id, off: [itemId(id, 'The model is audited.')] });
    const grouped = { layer: 'broad' as const, name: '', file: 'list.xlsx', fileDate: '', items: [{ text: 'Insurance is in place', section: 'Insurance' }, { text: 'The model is audited.', section: 'Model', subsection: 'Audit' }, { text: 'Taxes are paid', section: 'Tax' }] };
    const r = await bringIn(A.store, grouped); expect(r.ok && { items: r.value.items, deals: r.value.deals }).toEqual({ items: 1, deals: 1 });
    const shown = () => itemsOf(A, id).map((i) => [i.text, i.section ?? null, i.subsection ?? null, i.off]);
    expect(shown()).toEqual([['Insurance is in place', 'Insurance', null, false], ['Taxes are paid', 'Tax', null, false], ['The model is audited.', 'Model', 'Audit', true]]);
    expect((await undoBringIn(A.store, (r as any).value.opIds)).ok).toBe(true);
    expect(shown()).toEqual([['Insurance is in place', null, null, false], ['Taxes are paid', 'Tax', null, true], ['The model is audited.', null, null, true]]);
  });

  it('a new deal starts with the general list, and a new structure adds its list; Undo turns those off and puts the structure back', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await bringIn(A.store, list('product', 'Warehouse facility', ['Borrowing base is defined', 'Insurance is in place']));
    const id = await deal(A, 'Proseware');
    expect(itemsOf(A, id).map((i) => i.text)).toEqual(['Insurance is in place']);
    const e = await A.store.dispatch(EditDeal, { dealId: id, product: 'warehouse  facility' }); expect(e.ok).toBe(true);
    expect(itemsOf(A, id).map((i) => [i.text, i.off])).toEqual([['Borrowing base is defined', false], ['Insurance is in place', false]]);
    expect((await A.store.dispatch(Undo, { opId: (e as any).value.opId })).ok).toBe(true);
    expect(A.store.get().deals[id].product).toBe('');
    expect(itemsOf(A, id).map((i) => [i.text, i.off])).toEqual([['Borrowing base is defined', true], ['Insurance is in place', false]]);
  });

  it('a new deal with a structure and technology picked on the New deal form starts with their lists too', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await bringIn(A.store, list('product', 'Tax equity', ['Flip date modeled']));
    await bringIn(A.store, list('technology', 'Solar', ['Module warranty in place', 'Insurance is in place']));
    await bringIn(A.store, list('technology', 'Wind', ['Turbine supply agreement executed']));
    const id = await deal(A, 'Coho', { product: 'Tax equity', technology: 'Solar' }); await settle();
    expect([A.store.get().deals[id].product, A.store.get().deals[id].technology]).toEqual(['Tax equity', 'Solar']);
    expect(itemsOf(A, id).map((i) => i.text)).toEqual(['Flip date modeled', 'Insurance is in place', 'Module warranty in place']);
  });

  it('picking another technology swaps lists: the old one’s own items go off, picking it again brings them back, Undo takes it all back', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('broad', '', ['Permits cover the whole site']));
    await bringIn(A.store, list('technology', 'LNG', ['LNG supply agreement executed', 'Permits cover the whole site']));
    await bringIn(A.store, list('technology', 'CCGT', ['Air permit issued']));
    const id = await deal(A, 'Coho', { technology: 'LNG' }); await settle();
    const on = () => itemsOf(A, id).filter((i) => !i.off).map((i) => i.text);
    const e = await A.store.dispatch(EditDeal, { dealId: id, technology: 'CCGT', swap: true }); expect(e.ok).toBe(true);
    expect(on()).toEqual(['Air permit issued', 'Permits cover the whole site']);
    expect(A.store.get().ui.toasts.map((t) => t.text).join(' | ')).toMatch(/Technology set to CCGT · 1 item off · 1 added/);
    const back = await A.store.dispatch(EditDeal, { dealId: id, technology: 'LNG', swap: true }); expect(back.ok).toBe(true);
    expect(on()).toEqual(['LNG supply agreement executed', 'Permits cover the whole site']);
    expect((await A.store.dispatch(Undo, { opId: (back as any).value.opId })).ok).toBe(true);
    expect([A.store.get().deals[id].technology, on()]).toEqual(['CCGT', ['Air permit issued', 'Permits cover the whole site']]);
  });

  it('a swap has a showing Checklist listed and counted again at once, with no check run', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('technology', 'LNG', ['LNG supply agreement executed']));
    await bringIn(A.store, list('technology', 'CCGT', ['Air permit issued']));
    const id = await deal(A, 'Coho', { technology: 'LNG' }); await settle();
    // the backend lists the deal's items that are on (tests/backend/checklist.test.ts); here, that the window asks it again
    const ai = (A.store as any).services.ai; const asked: string[] = [];
    for (const k of ['checklist', 'progress', 'checkAll', 'firstPass'] as const) { const was = ai[k]; if (was) ai[k] = (d: string, ...rest: unknown[]) => { asked.push(`${k} ${d}`); return was(d, ...rest); }; }
    await A.store.refreshChecklist(id); asked.length = 0;                                   // the Checklist page has asked for it
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'CCGT', swap: true })).ok).toBe(true); await settle();
    expect(asked.sort()).toEqual([`checklist ${id}`, `progress ${id}`]);
  });

  it('a swap leaves off an item a person turned off that the deal’s lists already held', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await bringIn(A.store, list('technology', 'LNG', ['LNG supply agreement executed']));
    await bringIn(A.store, list('technology', 'CCGT', ['Air permit issued', 'Insurance is in place']));
    const id = await deal(A, 'Coho', { technology: 'LNG' }); await settle();
    expect((await A.store.dispatch(SetItemsOff, { dealId: id, off: [itemId(id, 'Insurance is in place')] })).ok).toBe(true);
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'CCGT', swap: true })).ok).toBe(true);
    expect(itemsOf(A, id).map((i) => [i.text, i.off])).toEqual([['Air permit issued', false], ['Insurance is in place', true], ['LNG supply agreement executed', true]]);
  });

  it('an item a person turned off stays off through a swap there and back; Undo keeps a swap’s items coming back', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('technology', 'LNG', ['LNG supply agreement executed', 'Regas terminal access agreed']));
    await bringIn(A.store, list('technology', 'CCGT', ['Air permit issued']));
    const id = await deal(A, 'Coho', { technology: 'LNG' }); await settle();
    const on = () => itemsOf(A, id).filter((i) => !i.off).map((i) => i.text);
    expect((await A.store.dispatch(SetItemsOff, { dealId: id, off: [itemId(id, 'Regas terminal access agreed')] })).ok).toBe(true);
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'CCGT', swap: true })).ok).toBe(true);
    const back = await A.store.dispatch(EditDeal, { dealId: id, technology: 'LNG', swap: true }); expect(back.ok).toBe(true);
    expect(on()).toEqual(['LNG supply agreement executed']);                                // the person's off stands
    // Undo of the swap back turns CCGT's item on again and LNG's off as a swap's; picking LNG again brings it back
    expect((await A.store.dispatch(Undo, { opId: (back as any).value.opId })).ok).toBe(true);
    expect(on()).toEqual(['Air permit issued']);
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'LNG', swap: true })).ok).toBe(true);
    expect(on()).toEqual(['LNG supply agreement executed']);
  });

  it('Undo of turning on an item a swap turned off leaves it a swap’s, so swapping back turns it on', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('technology', 'LNG', ['LNG supply agreement executed']));
    await bringIn(A.store, list('technology', 'CCGT', ['Air permit issued']));
    const id = await deal(A, 'Coho', { technology: 'LNG' }); await settle();
    const lng = itemId(id, 'LNG supply agreement executed'); const on = () => itemsOf(A, id).filter((i) => !i.off).map((i) => i.text);
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'CCGT', swap: true })).ok).toBe(true);
    const turned = await A.store.dispatch(SetItemsOff, { dealId: id, on: [lng] }); expect(turned.ok).toBe(true);
    expect((await A.store.dispatch(Undo, { opId: (turned as any).value.opId })).ok).toBe(true);
    expect(A.store.get().items[lng]).toMatchObject({ off: true, offBySwap: true });
    expect((await A.store.dispatch(EditDeal, { dealId: id, technology: 'LNG', swap: true })).ok).toBe(true);
    expect(on()).toEqual(['LNG supply agreement executed']);
  });

  it('a turned-off item stays off when the list is brought in again, and the lists keep their order', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const id = await deal(A, 'Proseware');
    await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await bringIn(A.store, list('sector', 'Solar', ['Module warranties']));
    const iid = itemId(id, 'Insurance is in place');
    expect((await A.store.dispatch(SetItemsOff, { dealId: id, off: [iid] })).ok).toBe(true);
    const r = await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Hedging is in place']));
    expect(r.ok && r.value.items).toBe(1);
    expect(A.store.get().items[iid].off).toBe(true);
    expect(firmOf(A.store.get().firmList).lists.map((l) => l.layer)).toEqual(['broad', 'sector']);
  });

  it('the same wording added on two PCs is one item, with no clash', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); const id = await deal(A, 'Proseware');
    await syncAll(A, B); await B.store.boot(); await B.store.loadDeal(id, { gaps: false });
    expect((await A.store.dispatch(AddDealItems, { dealId: id, items: [{ text: 'Insurance is in place', from: [{ layer: 'deal', value: '' }] }] })).ok).toBe(true);
    expect((await B.store.dispatch(AddDealItems, { dealId: id, items: [{ text: 'INSURANCE is in place.', from: [{ layer: 'broad', value: '' }] }] })).ok).toBe(true);
    await syncAll(A, B);
    const iid = itemId(id, 'insurance is in place');
    expect(A.store.get().conflicts[iid]).toBeUndefined(); expect(B.store.get().conflicts[iid]).toBeUndefined();
    expect(itemsOf(A, id).length).toBe(1); expect(itemsOf(B, id).length).toBe(1);
  });

  it('a change of bookkeeping alone never stands beside a person turning the item off', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); const id = await deal(A, 'Proseware');
    expect((await A.store.dispatch(AddDealItems, { dealId: id, items: [{ text: 'Insurance is in place', from: [{ layer: 'deal', value: '' }] }] })).ok).toBe(true);
    await syncAll(A, B); await B.store.boot(); await B.store.loadDeal(id, { gaps: false });
    const iid = itemId(id, 'Insurance is in place');
    expect((await A.store.dispatch(SetItemsOff, { dealId: id, off: [iid] })).ok).toBe(true);
    const b = B.store.get().items[iid];
    expect((await B.repo.transaction({ writes: [{ kind: 'item', id: iid, data: { ...b, from: [{ layer: 'broad', value: '' }], section: 'Insurance' }, expectedRev: b.rev }] })).ok).toBe(true);
    await syncAll(A, B);
    for (const p of [A, B]) { await p.store.retryDeal(id); expect(p.store.get().conflicts[iid]).toBeUndefined(); expect(p.store.get().items[iid].off).toBe(true); }
  });

  it('turned off on one PC and off then on again on another is two versions: named, blocked, and settled by a choice', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); const id = await deal(A, 'Proseware');
    expect((await A.store.dispatch(AddDealItems, { dealId: id, items: [{ text: 'Insurance is in place', from: [{ layer: 'deal', value: '' }] }] })).ok).toBe(true);
    await syncAll(A, B); await B.store.boot(); await B.store.loadDeal(id, { gaps: false });
    const iid = itemId(id, 'Insurance is in place');
    expect((await A.store.dispatch(SetItemsOff, { dealId: id, off: [iid] })).ok).toBe(true);
    expect((await B.store.dispatch(SetItemsOff, { dealId: id, off: [iid] })).ok).toBe(true);
    expect((await B.store.dispatch(SetItemsOff, { dealId: id, on: [iid] })).ok).toBe(true);
    await syncAll(A, B); await A.store.retryDeal(id);
    const c = A.store.get().conflicts[iid]; expect(c?.versions.length).toBe(2);
    expect(conflictLabel(A.store.get(), c)).toBe('The checklist item “Insurance is in place”');
    const blocked = await A.store.dispatch(SetItemsOff, { dealId: id, ...(A.store.get().items[iid].off ? { on: [iid] } : { off: [iid] }) });
    expect(!blocked.ok && blocked.error.message).toMatch(/Two versions\. Choose one first|two versions/i);
    const on = c.versions.find((v) => (v.data as any)?.off === false)!;
    expect((await A.store.dispatch(ResolveConflict, { dealId: id, recordId: iid, keep: on.id })).ok).toBe(true);
    expect(A.store.get().conflicts[iid]).toBeUndefined(); expect(A.store.get().items[iid].off).toBe(false);
  });
});

describe('each list of the firm’s is a record of its own', () => {
  const big = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} item ${i + 1}`);
  const lists = (p: PC) => firmOf(p.store.get().firmList).lists.map((l) => [l.layer, l.name, l.items.length]);

  it('two different lists brought in on two PCs at once both stand, with no choice to make, and reach the deals that use them', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await bringIn(A.store, list('broad', '', big('General', 2000)));
    const solar = await deal(A, 'Proseware', {}); await A.store.dispatch(EditDeal, { dealId: solar, sector: 'Solar' });
    const storage = await deal(A, 'Wingtip', {}); await A.store.dispatch(EditDeal, { dealId: storage, sector: 'Storage' });
    await syncAll(A, B); await B.store.boot(); for (const d of [solar, storage]) await B.store.loadDeal(d, { gaps: false });
    expect((await bringIn(A.store, list('sector', 'Solar', big('Solar', 400)))).ok).toBe(true);
    expect((await bringIn(B.store, list('sector', 'Storage', big('Storage', 400)))).ok).toBe(true);
    await syncAll(A, B);
    for (const p of [A, B]) {
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(lists(p)).toEqual([['broad', '', 2000], ['sector', 'Solar', 400], ['sector', 'Storage', 400]]);
      await p.store.retryDeal(solar); await p.store.retryDeal(storage);
      expect(itemsOf(p, solar).filter((i) => !i.off).length).toBe(2400);
      expect(itemsOf(p, storage).filter((i) => !i.off).length).toBe(2400);
    }
    // a deal made now starts with the general list and its sector's list
    const fresh = await deal(B, 'Trey', {}); await B.store.dispatch(EditDeal, { dealId: fresh, sector: 'Storage' });
    expect(itemsOf(B, fresh).length).toBe(2400);
  }, 30_000); // 2,800 items on two PCs takes a few seconds

  it('the same items brought in from two files on two PCs at once are one version', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await syncAll(A, B); await B.store.boot();
    await bringIn(A.store, { ...list('sector', 'Storage', big('Storage', 50)), file: 'Storage.xlsx' });
    await bringIn(B.store, { ...list('sector', 'storage', big('Storage', 50)), file: 'Storage (1).xlsx' });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(lists(p).length).toBe(1); }
  });

  it('bringing in a list that is in two versions is refused, even with the items of the version shown', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await syncAll(A, B); await B.store.boot();
    await bringIn(A.store, list('sector', 'Storage', ['Fire protection plan'])); await bringIn(B.store, list('sector', 'Storage', ['Augmentation plan']));
    await syncAll(A, B);
    const shown = A.store.get().firmList[listId('sector', 'Storage')];
    const r = await bringIn(A.store, list('sector', 'Storage', shown.items.map((i) => i.text)));
    expect(!r.ok && r.error.message).toMatch(/two versions\. Choose one first/);
  });

  it('bringing in the same list from the same file writes nothing, and there is nothing of it to undo; from another file, the file is kept', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    const rev = A.store.get().firmList[listId('broad', '')].rev;
    const r = await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    expect(r.ok && r.value.opIds).toEqual([]);
    expect(A.store.get().firmList[listId('broad', '')].rev).toBe(rev);
    const o = await bringIn(A.store, { ...list('broad', '', ['Insurance is in place']), file: 'other name.xlsx', fileDate: '2026-11-16' });
    expect(o.ok && o.value.opIds.length).toBe(1);
    expect(A.store.get().firmList[listId('broad', '')]).toMatchObject({ file: 'other name.xlsx', fileDate: '2026-11-16' });
  });

  it('the same list changed on two PCs at once: only it waits for a choice; a deal made meanwhile gets the other lists and the items both versions hold', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await syncAll(A, B); await B.store.boot();
    await bringIn(A.store, list('sector', 'Storage', ['Battery warranty', 'Fire plan', 'Augmentation plan']));
    await bringIn(B.store, list('sector', 'Storage', ['Battery warranty', 'Fire plan', 'Round-trip efficiency']));
    await syncAll(A, B);
    const sid = listId('sector', 'Storage');
    expect(Object.keys(A.store.get().conflicts)).toEqual([sid]);
    expect(conflictLabel(A.store.get(), A.store.get().conflicts[sid])).toBe('The Storage list');
    // other lists carry on: the general list can still be replaced
    expect((await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Hedging is in place']))).ok).toBe(true);
    // bringing in the split list again is refused until a person chooses
    expect((await bringIn(A.store, list('sector', 'Storage', ['Battery warranty']))).ok).toBe(false);
    const fresh = await deal(A, 'Trey', {}); await A.store.dispatch(EditDeal, { dealId: fresh, sector: 'Storage' });
    expect(itemsOf(A, fresh).map((i) => i.text)).toEqual(['Battery warranty', 'Fire plan', 'Hedging is in place', 'Insurance is in place']);
    const keep = A.store.get().conflicts[sid].versions.find((v) => (v.data as any).items.some((i: any) => i.text === 'Round-trip efficiency'))!;
    expect((await A.store.dispatch(ResolveConflict, { dealId: '', recordId: sid, keep: keep.id })).ok).toBe(true);
    expect(A.store.get().conflicts[sid]).toBeUndefined();
  });

  it('a list changed on another PC: its new items are offered as Add them, its dropped ones are marked, and nothing is offered on a Closed or unloaded deal (linking design, section 5)', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Model is audited', 'Hedging is in place']));
    const a = await deal(A, 'Proseware');
    await syncAll(A, B); await B.store.boot();
    // B brings the list in again without Proseware loaded: the list changes, the deal does not
    expect((await B.store.dispatch(BringInList, { list: list('broad', '', ['insurance is in place.', 'Model is audited', 'Lenders’ counsel opinion', 'Security is perfected']) })).ok).toBe(true);
    await syncAll(A, B);
    const offered = () => offeredItems(A.store.get(), a).map((w) => w.text);
    const marked = () => [...unlistedItems(A.store.get(), A.store.get().deals[a])].map((id) => A.store.get().items[id].text);
    expect(offered()).toEqual(['Lenders’ counsel opinion', 'Security is perfected']);
    expect(marked()).toEqual(['Hedging is in place']);                      // case and a trailing period do not make an item new
    expect(offeredItems(B.store.get(), a)).toEqual([]);                      // not loaded on B: what it holds is not known there
    await A.store.dispatch(EditDeal, { dealId: a, group: 'closed' });
    expect(offered()).toEqual([]);
    expect(marked()).toEqual(['Hedging is in place']);
    await A.store.dispatch(EditDeal, { dealId: a, group: 'live' });
    const r = await A.store.dispatch(AddDealItems, { dealId: a, items: offeredItems(A.store.get(), a) }); expect(r.ok).toBe(true);
    expect(offered()).toEqual([]);
    // Undo turns them off: they stay on the deal, so they are not offered again
    expect((await A.store.dispatch(Undo, { opId: (r as any).value.opId })).ok).toBe(true);
    expect(itemsOf(A, a).filter((i) => i.off).map((i) => i.text)).toEqual(['Lenders’ counsel opinion', 'Security is perfected']);
    expect(offered()).toEqual([]);
    // the same list changed on both PCs at once: only the items both versions hold are offered, and neither version's items are marked
    await syncAll(A, B);
    await A.store.dispatch(BringInList, { list: list('broad', '', ['Insurance is in place', 'Model is audited', 'Tax opinion', 'Hedging is in place']) });
    await B.store.dispatch(BringInList, { list: list('broad', '', ['Insurance is in place', 'Model is audited', 'Tax opinion', 'Hedging is in place', 'Fire plan']) });
    await syncAll(A, B);
    expect(Object.keys(A.store.get().conflicts)).toEqual([listId('broad', '')]);
    expect(offered()).toEqual(['Tax opinion']);
    expect(marked()).toEqual(['Lenders’ counsel opinion', 'Security is perfected']);
  });

  it('a PC whose copy of a list is older than the one that added a deal’s items offers no Add them (linking design, section 5)', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await syncAll(A, B); await B.store.boot();
    const lid = listId('broad', ''); const old = B.store.get().firmList[lid];
    // A brings in a new version, which adds its item to the deal under the list's new rev
    const a = await deal(A, 'Proseware');
    expect((await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Tax opinion']))).ok).toBe(true);
    const tax = itemsOf(A, a).find((i) => i.text === 'Tax opinion')!;
    expect(tax.from).toEqual([{ layer: 'broad', value: '', rev: A.store.get().firmList[lid].rev }]);
    // the same deal, read with that older copy of the list and a third item it does not hold: nothing is offered
    const behind = { ...A.store.get(), firmList: { [lid]: { ...old, items: [...old.items, { text: 'An old wording since dropped' }] } } };
    expect(old.rev).toBeLessThan(tax.from[0].rev!);
    expect(offeredItems(behind, a)).toEqual([]);
    // with the list as new as the deal's items, it is offered
    const current = { ...A.store.get(), firmList: { [lid]: { ...A.store.get().firmList[lid], items: [...A.store.get().firmList[lid].items, { text: 'Hedging is in place' }] } } };
    expect(offeredItems(current, a).map((w) => w.text)).toEqual(['Hedging is in place']);
  });

  it('Undo all of a bring-in puts the list back first, and leaves on an item another of the deal’s lists holds', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const id = await deal(A, 'Proseware', {}); await A.store.dispatch(EditDeal, { dealId: id, sector: 'Solar' });
    const g = await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Taxes are paid']));
    await bringIn(A.store, list('sector', 'Solar', ['Insurance is in place', 'Module warranties']));
    expect((await undoBringIn(A.store, (g as any).value.opIds)).ok).toBe(true);
    expect(A.store.get().firmList[listId('broad', '')]).toBeUndefined();
    expect(itemsOf(A, id).map((i) => [i.text, i.off])).toEqual([['Insurance is in place', false], ['Module warranties', false], ['Taxes are paid', true]]);
  });

  it('Undo all does nothing when the list has changed since', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const id = await deal(A, 'Proseware');
    const g = await bringIn(A.store, list('broad', '', ['Insurance is in place']));
    await bringIn(A.store, list('broad', '', ['Insurance is in place', 'Taxes are paid']));
    expect((await undoBringIn(A.store, (g as any).value.opIds)).ok).toBe(false);
    expect(itemsOf(A, id).map((i) => [i.text, i.off])).toEqual([['Insurance is in place', false], ['Taxes are paid', false]]);
  });

  it('a swap away from a list in two versions turns off the items either version brought', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await bringIn(A.store, list('sector', 'Solar', ['Module warranty']));
    const d = await deal(A, 'Proseware'); await A.store.dispatch(EditDeal, { dealId: d, sector: 'Storage' });
    await syncAll(A, B); await B.store.boot(); await B.store.loadDeal(d, { gaps: false });
    await bringIn(A.store, list('sector', 'Storage', ['Battery warranty', 'Augmentation plan']));
    await bringIn(B.store, list('sector', 'Storage', ['Battery warranty', 'Round-trip efficiency']));
    await syncAll(A, B); await A.store.retryDeal(d);
    expect(A.store.get().conflicts[listId('sector', 'Storage')]?.versions.length).toBe(2);
    expect((await A.store.dispatch(EditDeal, { dealId: d, sector: 'Solar', swap: true })).ok).toBe(true);
    expect(itemsOf(A, d).map((i) => [i.text, i.off])).toEqual([['Augmentation plan', true], ['Battery warranty', true], ['Module warranty', false], ['Round-trip efficiency', true]]);
  });

  it('Undo all leaves a list another PC brought in at the same time with the same items, and says who', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    await A.store.boot(); await syncAll(A, B); await B.store.boot();
    const a = await bringIn(A.store, { ...list('sector', 'Storage', ['Fire protection plan']), file: 'Storage.xlsx' });
    await bringIn(B.store, { ...list('sector', 'Storage', ['Fire protection plan']), file: 'Storage (1).xlsx' });
    await syncAll(A, B);
    expect(Object.keys(A.store.get().conflicts)).toEqual([]);
    const u = await undoBringIn(A.store, (a as any).value.opIds);
    expect(!u.ok && u.error.message).toBe('sroe imported this list too, from PC B, so nothing was undone');
    await syncAll(A, B);
    for (const p of [A, B]) expect(lists(p)).toEqual([['sector', 'Storage', 1]]);
  });
});

describe('checklist items appear in search (decisions, Checklist; #2)', () => {
  it('an item is found by its wording under Checklist items, after Findings, and opens on its deal’s Checklist with the item open', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const k = await deal(A, 'Proseware'); const o = await deal(A, 'Wingtip');
    await bringIn(A.store, list('broad', '', ['Lease term runs at least five years past the PPA term', 'Landowner consents to the lender’s collateral assignment', 'Interconnection agreement is executed']));
    await A.store.dispatch(SetItemsOff, { dealId: o, off: [itemId(o, 'Lease term runs at least five years past the PPA term')] });
    await A.store.dispatch(CreateFinding, { dealId: k, title: 'Lease term is short of the PPA term', workstream: 'Legal' }, { quiet: true });
    await A.store.dispatch(CreateQuestion, { dealId: k, text: 'Please confirm the lease term' }, { quiet: true });
    const g = searchGroups(A.store.get(), 'LEASE TERM');
    expect(g.map((x) => [x.kind, x.label, x.hits.length]))
      .toEqual([['finding', 'Findings', 1], ['item', 'Checklist Items', 2], ['question', 'Questions', 1]]);
    const hits = g[1].hits;
    expect(hits.map((h) => [h.title, h.where])).toEqual([['Lease term runs at least five years past the PPA term', 'Project Proseware'], ['Lease term runs at least five years past the PPA term', 'Project Wingtip']]);   // a turned-off item too, as its Checklist lists it
    expect(hits[0]).toMatchObject({ hash: `checklist-${k}`, ui: { selectedChecklist: itemId(k, 'Lease term runs at least five years past the PPA term'), checklistFilter: 'all' } });
    expect(new Set(allHits(A.store.get(), 'lease term').map((h) => h.key)).size).toBe(4);    // the same wording in two deals is two hits, each its own key
    expect(searchGroups(A.store.get(), 'collateral lender')).toEqual([]);                      // the words in their order, as elsewhere in search
    expect(searchGroups(A.store.get(), 'inter-connection')[0].hits.map((h) => h.where)).toEqual(['Project Proseware', 'Project Wingtip']);   // across a hyphen, as elsewhere in search
  });

  it('a deal with no items of its own is searched by what its check holds, read once when search opens', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const k = await deal(A, 'Proseware');
    const rows = [{ id: 'm1', text: 'Debt service reserve covers six months', result: 'gap' as const, docs: [] }];
    let reads = 0; (A.store.services.ai as any).checklist = async () => { reads++; return { ok: true, value: rows }; };
    expect(searchGroups(A.store.get(), 'reserve')).toEqual([]);                                // not read yet
    await loadAllForSearch(A.store); await loadAllForSearch(A.store);
    expect(reads).toBe(1);
    expect(searchGroups(A.store.get(), 'reserve')[0]).toMatchObject({ kind: 'item', hits: [{ title: 'Debt service reserve covers six months', hash: `checklist-${k}`, ui: { selectedChecklist: 'm1' } }] });
  });

  it('a keystroke across 10 deals of 2,000 items each stays quick', async () => {
    const A = pc('PC A', 'adoe'); await A.store.boot();
    const deals: string[] = []; for (const n of ['Proseware', 'Wingtip', 'Trey', 'Alpine', 'Lucerne', 'Adventure Works', 'Coho', 'Munson', 'Yonder', 'Fourth Coffee']) deals.push(await deal(A, n));
    // the realistic list's 120 items, each asked of the parts of a project a lender's counsel splits them over
    const parts = ['the array', 'the substation', 'the gen-tie', 'the battery yard', 'the O&M building', 'the access road', 'the laydown area', 'the collection system', 'the met stations', 'the switchyard', 'the inverter pads', 'the fencing', 'the drainage', 'the cable route', 'the water supply', 'the SCADA system', 'the spare parts store'];
    const texts = parts.flatMap((p) => ITEMS.map((x) => `${x.t.replace(/[.;]$/, '')}, for ${p}`)).slice(0, 2000);
    const s0 = A.store.get(); const items = { ...s0.items };
    for (const d of deals) for (const t of texts) { const id = itemId(d, t); items[id] = { id, dealId: d, text: t, off: false } as any; }
    const s = { ...s0, items };
    expect(Object.keys(items).length).toBe(20000);
    const time = (q: string) => { const t0 = performance.now(); const n = allHits(s, q).length; return [performance.now() - t0, n] as const; };
    const [first] = time('l'); expect(first).toBeLessThan(1500);                               // the first keystroke folds every wording once
    const [ms, n] = time('lease term');
    expect(n).toBe(10 * parts.length * ITEMS.filter((x) => /lease term/i.test(x.t)).length);
    expect(ms).toBeLessThan(150);
    // the broad first letters, which match most of the 20,000 wordings, once they are folded: each keystroke stays quick
    // (the best of three, so a busy machine's pauses are not counted as search's)
    const broad = ['a', 'the', 'le', 'for'].map((q) => Math.min(...[0, 1, 2].map(() => { const t0 = performance.now(); searchGroups(s, q); return performance.now() - t0; })));
    expect(Math.max(...broad)).toBeLessThan(40);
    // "+N more" opens a type a page at a time: thousands of rows at once froze the panel (#2)
    const g = (more: HitKind[]) => searchGroups(s, 'the', more).find((x) => x.kind === 'item')!;
    expect([g([]).hits.length, g(['item']).hits.length, g(['item', 'item']).hits.length]).toEqual([GROUP_SHOWN, GROUP_SHOWN + GROUP_PAGE, GROUP_SHOWN + 2 * GROUP_PAGE]);
    expect(g(['item']).more).toBe(allHits(s, 'the').filter((h) => h.kind === 'item').length - GROUP_SHOWN - GROUP_PAGE);
  }, 60000);
});
