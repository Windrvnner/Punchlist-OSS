// Regressions for data-integrity defects.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, decodeText, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, mockFirstPass, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RecoverDrafts } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { ask } from '../../src/app/conversations';
import { dealFindings, dealQuestions } from '../../src/app/state';
import { findingsSheet } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, DeleteDeal, CreateQuestion, EditQuestionField, DeleteQuestion, RestoreQuestion, RecoverDrafts];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 16, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZV${String(seq++).padStart(7, '0')}` };
function make(kv = disk()) {
  const opts: MockOptions = { latency: [0, 0] }; const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, kv, opts };
}
async function deal(m: ReturnType<typeof make>, name: string) {
  if (m.store.get().boot.stage !== 'ready') await m.store.boot();
  await m.store.dispatch(CreateDeal, { name, folders: [] });
  const d = Object.values(m.store.get().deals).find((x) => x.name === `Project ${name}`)!;
  await mockFirstPass(m.repo, d.id, d.name, m.opts); await m.store.loadDeal(d.id);
  return d.id;
}
/** a change file another PC is writing to, under a deal */
const theirs = (kv: Disk, dealId: string) => `changes-pc-elsewhere-${dealId}-0001.jsonl`;
const WHO = { by: 'sroe', from: 'PC B', at: '2026-11-09T17:00:00.000Z' };

describe('deleting a deal', () => {
  it('takes away the Undo still on screen for anything done on the deal, which could no longer apply', async () => {
    const m = make(); const nod = await deal(m, 'Nod');
    await m.store.dispatch(CreateQuestion, { dealId: nod, text: 'A question on Nod' });
    await m.store.dispatch(DeleteQuestion, { dealId: nod, questionId: dealQuestions(m.store.get(), nod)[0].id });
    expect(m.store.get().ui.toasts.some((t) => /deleted/.test(t.text) && t.action)).toBe(true);
    await m.store.dispatch(DeleteDeal, { dealId: nod, typedName: 'Project Nod' });
    expect(m.store.get().ui.toasts.filter((t) => t.action)).toEqual([]);
  });
  it('removes its findings, questions, their history and its index, from what is stored and from memory, at once and for good: the notice offers no Undo and there is none', async () => {
    const m = make(); const nod = await deal(m, 'Nod'); const keep = await deal(m, 'Keep');
    await m.store.dispatch(CreateQuestion, { dealId: nod, text: 'A question on Nod' }); await m.store.dispatch(CreateQuestion, { dealId: nod, text: 'To be deleted first' });
    await m.store.dispatch(DeleteQuestion, { dealId: nod, questionId: dealQuestions(m.store.get(), nod)[1].id });       // leaves a tombstone under the deal
    const nodIds = [...dealFindings(m.store.get(), nod).map((f) => f.id), ...dealQuestions(m.store.get(), nod).map((q) => q.id)];
    expect(nodIds.length).toBe(4);
    const r = await m.store.dispatch(DeleteDeal, { dealId: nod, typedName: 'Project Nod' }); expect(r.ok).toBe(true);
    // read afresh from what is stored (the change files keep their lines: a deal's are passed over once it is deleted)
    const read = memRepo(clock.now, m.kv); const value = <T,>(r: { ok: boolean; value?: T }) => (r.ok ? r.value : undefined);
    for (const id of nodIds) { expect(value(await read.get(id.startsWith('q_') ? 'question' : 'finding', id))).toBeNull(); expect(value(await read.audit(id))).toEqual([]); }     // no record and no history of any of them
    for (const kind of ['question', 'finding', 'tombstone'] as const) expect(value(await read.list(kind, nod))).toEqual([]);
    expect(value(await read.get('tombstone', nod))).toBeTruthy();                           // only the note that the deal was deleted
    const s = m.store.get();
    expect([...Object.values(s.findings), ...Object.values(s.questions)].some((x) => x.dealId === nod)).toBe(false);
    expect(dealFindings(s, keep).length).toBe(3);
    // a person confirmed twice: the notice says it is deleted and offers nothing; asking for an undo anyway is refused and brings nothing back
    const n = s.ui.toasts.find((x) => x.text === 'Project Nod deleted')!; expect(n).toBeTruthy(); expect(n.action).toBeUndefined();
    const u = await m.store.undo((r as any).value.opId); expect(!u.ok && u.error.message).toBe('This action cannot be undone'); expect(m.store.get().deals[nod]).toBeUndefined();
    // and it is not counted when asking across deals, now or after a restart
    await ask(m.store, { kind: 'all' }, 'What is open?');
    expect(m.store.get().threads['all'].at(-1)!.text).toMatch(/^3 open findings across 1 deal: Project Keep has 3\./);
    const again = make(m.kv); await again.store.boot();
    expect(Object.values(again.store.get().deals).map((d) => d.name)).toEqual(['Project Keep']);
  });
});

describe('the operation journal', () => {
  it('keeps recent operations for Undo and prunes the rest, so it cannot fill storage', async () => {
    const m = make(); const dealId = await deal(m, 'Datum');
    await m.store.dispatch(CreateQuestion, { dealId, text: 'start' }); const q = dealQuestions(m.store.get(), dealId)[0];
    let last: any; for (let i = 0; i < 620; i++) last = await m.store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'edit ' + i }, { quiet: true });
    await new Promise((r) => setTimeout(r, 20));
    const kept = await m.repo.list('op'); const stored = kept.ok ? kept.value.length : -1; const inMemory = Object.keys(m.store.get().ops).length;
    expect(stored).toBeLessThanOrEqual(251); expect(stored).toBeGreaterThanOrEqual(200); expect(inMemory).toBe(stored);
    expect((await m.store.undo(last.value.opId)).ok).toBe(true);                           // the newest is still undoable
    expect(m.store.get().questions[q.id].text).toBe('edit 618');
    const history = await m.repo.audit(q.id); expect(history.ok && history.value.length).toBeLessThanOrEqual(200);
    const again = make(m.kv); await again.store.boot(); await again.store.loadDeal(dealId);
    expect(again.store.get().questions[q.id].text).toBe('edit 618');
  });
});

describe('damaged storage', () => {
  it('a change to a deal\'s index that is not a list, or holds junk entries, is ignored instead of thrown on', async () => {
    const m = make(); const dealId = await deal(m, 'Datum');
    const line = (n: number, index: unknown) => JSON.stringify({ v: 1, pc: 'pc-elsewhere', seq: n, at: WHO.at, by: WHO.by, from: WHO.from, recs: [], index }) + '\n';
    m.kv.shared.append(theirs(m.kv, dealId), line(1, { dealId, add: { not: 'a list' } }));
    const fresh = make(m.kv); await fresh.store.boot(); await fresh.store.loadDeal(dealId);
    expect(fresh.store.get().dealLoad[dealId]).toBe('loaded');
    m.kv.shared.append(theirs(m.kv, dealId), line(2, { dealId, add: [null, 7, { kind: 'finding' }, { kind: 'finding', id: 'f_missing' }] }));
    const fresh2 = make(m.kv); await fresh2.store.boot(); await fresh2.store.loadDeal(dealId);
    expect(fresh2.store.get().dealLoad[dealId]).toBe('loaded');
  });
});

describe('exports and imports', () => {
  it('the findings export carries each finding’s text, without citation markers', async () => {
    const m = make(); const dealId = await deal(m, 'Datum');
    const sheet = findingsSheet(dealFindings(m.store.get(), dealId));
    expect(sheet[0].slice(0, 3)).toEqual(['Title', 'Detail', 'Workstream']);
    const detail = String(sheet.find((r) => /Lock-up/.test(String(r[0])))![1]);
    expect(detail).toBe('The draft sets the distribution lock-up at 1.25x. The signed term sheet has 1.30x.');
  });
  it('a CSV is read in the encoding it was written in', () => {
    const text = 'Question\nCafé façade – naïve £50 €100\n';
    const utf8 = new TextEncoder().encode(text);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    const cp1252 = new Uint8Array([...'Question\nCaf'].map((c) => c.charCodeAt(0)).concat([0xe9, 0x20, 0x66, 0x61, 0xe7, 0x61, 0x64, 0x65, 0x20, 0x96, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x20, 0xa3, 0x35, 0x30, 0x20, 0x80, 0x31, 0x30, 0x30, 0x0a]));
    const u16 = (le: boolean, mark: boolean) => { const out: number[] = mark ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : []; for (const ch of text) { const c = ch.charCodeAt(0); out.push(...(le ? [c & 255, c >> 8] : [c >> 8, c & 255])); } return new Uint8Array(out); };
    for (const bytes of [utf8, bom, cp1252, u16(true, true), u16(false, true), u16(true, false), u16(false, false)]) {
      expect(decodeText(bytes)).toBe(text);
      const r = readCsv(bytes); expect(r.ok && r.value.rows[0][0]).toBe('Café façade – naïve £50 €100');
    }
  });
});

describe('the demo draft never invents an answer', () => {
  it('picks the finding the question is about, and finds nothing when no finding bears on it', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const draft = (questionText: string) => (m.store.services.ai as any).draft({ dealId: a, questionId: 'q', questionText });
    const lock = dealFindings(m.store.get(), a).find((f) => /lock-up/i.test(f.title))!;
    const hit = await draft('Please confirm the distribution lock-up test.');
    expect(hit).toMatchObject({ ok: true, value: { status: 'found' } });
    expect(hit.value.sources.map((s: any) => s.doc)).toEqual(lock.sources.slice(0, 2).map((s) => s.doc));
    for (const q of ['What is the debt service coverage ratio?', 'Provide the weather forecast for Tuesday', 'Please confirm the insurance advisor has signed off the executed agreement.'])
      expect(await draft(q)).toMatchObject({ ok: true, value: { status: 'none', text: '', sources: [] } });
  });
});

describe('data integrity follow-ups', () => {
  it('a response of only spaces is no response: nothing is stored and the earlier response keeps its origin', async () => {
    const { SetResponse } = await import('../../src/app/commands/questions');
    registry.set(SetResponse.name, SetResponse);
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'x' }); const q = dealQuestions(m.store.get(), a)[0];
    await m.store.dispatch(SetResponse, { dealId: a, questionId: q.id, response: 'A real answer' });
    const was = m.store.get().questions[q.id];
    await m.store.dispatch(SetResponse, { dealId: a, questionId: q.id, response: '   ' });
    expect(m.store.get().questions[q.id].response).toBe('');
    await m.store.dispatch(SetResponse, { dealId: a, questionId: q.id, response: '  \n ' });      // already empty: no write
    expect(m.store.get().questions[q.id].rev).toBe(was.rev + 1);
  });

  it('an import error names the line in the person’s file, blank rows counted', async () => {
    const { prepareImport, suggestMapping } = await import('../../src/domain/importExport');
    const { ImportQuestions } = await import('../../src/app/commands/importQuestions');
    const m = make(); const a = await deal(m, 'Proseware');
    const tb = readCsv(new TextEncoder().encode('Number,Question,Status\n20,Fine,Open\n,,\n,,\n21,Answered without a response,Answered\n')); if (!tb.ok) throw new Error('csv');
    const rows = prepareImport(tb.value.rows, suggestMapping(tb.value.columns), tb.value.lines).rows;
    const r = await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'merge', rows }, { quiet: true });
    expect(r.ok).toBe(false); expect((r as any).error.message).toMatch(/^Row 5:/);
  });

  it('an import keeps the other side’s own workstream, uses our spelling where it is one of ours, and drops control characters', async () => {
    const { prepareImport, suggestMapping } = await import('../../src/domain/importExport');
    const tb = readCsv(new TextEncoder().encode('Question,Workstream\nOne,LEGAL\nTwo,Offtake & marketing\n"Thr\u0000ee\u0007",tax\n')); if (!tb.ok) throw new Error('csv');
    const p = prepareImport(tb.value.rows, suggestMapping(tb.value.columns));
    expect(p.rows.map((r) => [r.text, r.workstream])).toEqual([['One', 'Legal'], ['Two', 'Offtake & marketing'], ['Three', 'Tax']]);
  });

  it('an export fits Excel: a cell over 32,767 characters is cut with a visible note, and file names keep letters of any language', async () => {
    const { fitCells, safeFileName, EXCEL_CELL_MAX } = await import('../../src/domain/importExport');
    const fit = fitCells([['#', 'Response'], [1, 'x'.repeat(40000)], [2, 'short']]);
    expect(fit.cut).toBe(1);
    expect(String(fit.table[1][1]).length).toBe(EXCEL_CELL_MAX);
    expect(String(fit.table[1][1])).toMatch(/\[cut: longer than Excel allows in one cell\]$/);
    expect(fit.table[2]).toEqual([2, 'short']);
    // nothing the app saves needs this any more (one cell is the limit for every exported text); it stays as a safety net
    expect((await csvCodec.write('Q&A log', fit.table)).ok).toBe(true);
    expect(safeFileName('Projekt Übergröße: Q&A / log?')).toBe('Projekt Übergröße Q&A log');
    expect(safeFileName('プロジェクト')).toBe('プロジェクト');
    expect(safeFileName('con')).toBe('export'); expect(safeFileName(' .. ')).toBe('export');
  });

  it('a stored record with no data is skipped and reported, and the rest of the deal still loads', async () => {
    const kv = disk(); const m = make(kv); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'kept' }); await m.store.dispatch(CreateQuestion, { dealId: a, text: 'to be damaged' });
    const bad = dealQuestions(m.store.get(), a)[1];
    m.repo.peer.change('question', bad.id, null, WHO);                                      // a change with no data arrives from another PC
    const again = make(kv); await again.store.boot(); await again.store.loadDeal(a);
    expect(dealQuestions(again.store.get(), a).map((q) => q.text)).toEqual(['kept']);
    expect(again.store.get().ui.toasts.some((t) => /1 stored record could not be read/.test(t.text))).toBe(true);
  });
});
