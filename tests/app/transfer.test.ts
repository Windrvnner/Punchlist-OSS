import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetResponse, SetQuestionStatus } from '../../src/app/commands/questions';
import { CreateFinding, ReviewFinding } from '../../src/app/commands/findings';
import { RecoverDrafts, RequestDraft, ApplyDraft, AcceptDraft } from '../../src/app/commands/drafts';
import { ok } from '../../src/domain/result';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { exportQuestions, exportFindings, readImportFile, previewImport } from '../../src/app/transfer';
import { search, loadAllForSearch } from '../../src/app/search';
import { prepareImport, suggestMapping, TEXT_MAX } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, EditQuestionField, SetResponse, SetQuestionStatus, CreateFinding, ReviewFinding, ImportQuestions, RevertImport, RecoverDrafts, RequestDraft, ApplyDraft, AcceptDraft];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
function make(kv = disk()) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, kv);
  const saved: { name: string; bytes: Uint8Array }[] = []; const calls = { brief: 0 }; let saveResult: any = { ok: true, value: 'saved' };
  // a draft is always found, with two sources, so a test can take an AI draft as a response
  const ai = { ...mockAi(opts, repo), draft: async () => ok({ status: 'found' as const, text: 'The lock-up is 1.10x.', sources: [{ doc: 'Credit agreement.pdf', loc: 'p. 41', docId: 'doc_fa' }, { doc: 'Model.xlsx', loc: 'CFADS!C3', docId: 'doc_model' }] }) };
  const store = new Store({ repo, ai: { ...ai, dealBrief: (id) => { calls.brief++; return ai.dealBrief(id); } }, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async (name, bytes) => { if (saveResult.ok && saveResult.value === 'saved') saved.push({ name, bytes }); return saveResult; } }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv, repo, saved, calls, setSave: (r: any) => { saveResult = r; } };
}
const fileOf = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

describe('export and import through the ports', () => {
  it('exports the chosen questions, names the file safely, and the file imports back unchanged', async () => {
    const { store, saved } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum / "Q4"', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR covenant?\nAnd the lock-up?' });
    await store.dispatch(CreateQuestion, { dealId, text: 'Second' });
    const [q1, q2] = dealQuestions(store.get(), dealId);
    await store.dispatch(EditQuestionField, { dealId, questionId: q1.id, field: 'askedBy', value: 'Lender A' });
    await store.dispatch(EditQuestionField, { dealId, questionId: q1.id, field: 'received', value: '2026-11-01' });
    await store.dispatch(EditQuestionField, { dealId, questionId: q2.id, field: 'askedBy', value: 'Lender B' });
    await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: '1.20x & 1.10x <lock-up>' });
    await store.dispatch(SetQuestionStatus, { dealId, questionId: q1.id, status: 'answered' });
    const before = JSON.stringify(store.get().questions);

    const r = await exportQuestions(store, dealId, { status: 'all', workstream: '', askedBy: ['Lender A'] });
    expect(r.ok && r.value).toBe(1);
    expect(saved[0].name).toBe('Project Datum Q4 Q&A log - Lender A.csv');                  // the stand-in writes CSV; the app writes .xlsx through LibreOffice (tests/backend/sheets)
    expect(JSON.stringify(store.get().questions)).toBe(before);                 // exporting changes nothing

    const back = await readImportFile(store, fileOf('log.csv', saved[0].bytes));
    expect(back.ok).toBe(true); if (!back.ok) return;
    const p = prepareImport(back.value.rows, back.value.mapping);
    expect(p.rows).toEqual([{ n: 1, text: 'What is the DSCR covenant?\nAnd the lock-up?', askedBy: 'Lender A', received: '2026-11-01', workstream: '', priority: 'High', response: '1.20x & 1.10x <lock-up>', respondedBy: '', responded: '', status: 'answered', line: 2 }]);
    const again = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: p.rows });
    expect(again.ok).toBe(true);
    expect(JSON.stringify(store.get().questions)).toBe(before);                 // a round trip is a no-op
  });

  it('an AI draft taken as a response, with a line break added at its end, comes back from its own export unchanged, origin and sources kept', async () => {
    const { store, saved } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: '  What is the lock-up?' }); const [q1] = dealQuestions(store.get(), dealId);
    await store.dispatch(RequestDraft, { dealId, questionId: q1.id });
    for (let i = 0; i < 100 && store.get().questions[q1.id].draft?.status !== 'found'; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await store.dispatch(AcceptDraft, { dealId, questionId: q1.id })).ok).toBe(true);
    await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: 'The lock-up is 1.10x.\n' });
    const before = store.get().questions[q1.id]; expect(before.provenance).toMatchObject({ origin: 'ai', sources: [{ doc: 'Credit agreement.pdf' }, { doc: 'Model.xlsx' }] });
    await exportQuestions(store, dealId, { status: 'all', workstream: '', askedBy: [before.askedBy] });
    const back = await readImportFile(store, fileOf('log.csv', saved[0].bytes)); if (!back.ok) throw new Error(back.error.message);
    const p = prepareImport(back.value.rows, back.value.mapping);
    expect(previewImport(store, dealId, 'merge', p.rows)).toEqual({ ok: true, value: { created: 0, updated: 0, restored: 0, changes: [] } });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: p.rows })).ok).toBe(true);
    expect(store.get().questions[q1.id]).toEqual(before);
  });

  it('a response changed in the file only in its spaces or line breaks is shown as such, and keeps its origin and sources', async () => {
    const { store } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the lock-up?' }); const [q1] = dealQuestions(store.get(), dealId);
    await store.dispatch(RequestDraft, { dealId, questionId: q1.id });
    for (let i = 0; i < 100 && store.get().questions[q1.id].draft?.status !== 'found'; i++) await new Promise((r) => setTimeout(r, 10));
    await store.dispatch(AcceptDraft, { dealId, questionId: q1.id });
    const was = store.get().questions[q1.id];
    const t = readCsv(new TextEncoder().encode('Number,Question,Response\n1,What is the lock-up?,"The lock-up  is 1.10x.\n"\n2,New,\n')); if (!t.ok) throw new Error('csv');
    const rows = prepareImport(t.value.rows, suggestMapping(t.value.columns)).rows;
    expect(previewImport(store, dealId, 'merge', rows)).toMatchObject({ ok: true, value: { changes: [{ n: 1, field: 'Response', from: 'The lock-up is 1.10x.', to: 'The lock-up  is 1.10x.\n', spacing: true }] } });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
    expect(store.get().questions[q1.id]).toMatchObject({ response: 'The lock-up  is 1.10x.\n', provenance: was.provenance });
    // other words are a new response, written by whoever the file says responded
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: prepareImport([['1', 'What is the lock-up?', 'The lock-up is 1.20x.']], suggestMapping(['Number', 'Question', 'Response'])).rows });
    expect(store.get().questions[q1.id].provenance).toMatchObject({ origin: 'human', sources: [] });
  });

  it('names and workstream are identities: "Lender A " and "Lender A" are one submitter, through an export and merge and within one file', async () => {
    const { store, saved } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'One' }); const [q1] = dealQuestions(store.get(), dealId);
    for (const [field, value] of [['askedBy', 'Lender A '], ['respondedBy', ' Sponsor'], ['workstream', 'Legal ']] as const) await store.dispatch(EditQuestionField, { dealId, questionId: q1.id, field, value });
    await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: '  Yes, as written.\n' });
    const before = JSON.stringify(store.get().questions);
    await exportQuestions(store, dealId, { status: 'all', workstream: '', askedBy: ['Lender A '] });
    const back = await readImportFile(store, fileOf('log.csv', saved[0].bytes)); if (!back.ok) throw new Error(back.error.message);
    const p = prepareImport(back.value.rows, back.value.mapping);
    expect(p.rows[0]).toMatchObject({ askedBy: 'Lender A', respondedBy: 'Sponsor', workstream: 'Legal', response: '  Yes, as written.\n' });
    expect(previewImport(store, dealId, 'merge', p.rows)).toEqual({ ok: true, value: { created: 0, updated: 0, restored: 0, changes: [] } });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: p.rows });
    expect(JSON.stringify(store.get().questions)).toBe(before);                 // the round trip changes nothing
    // a file that has the name with and without a space after it gives one submitter
    const t = readCsv(new TextEncoder().encode('Question,Submitted by,Workstream\nTwo,"Lender A ", Tax\nThree,Lender A,Tax\n')); if (!t.ok) throw new Error('csv');
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: prepareImport(t.value.rows, suggestMapping(t.value.columns)).rows });
    const added = dealQuestions(store.get(), dealId).filter((q) => q.text !== 'One');
    expect(new Set(added.map((q) => q.askedBy))).toEqual(new Set(['Lender A'])); expect(new Set(added.map((q) => q.workstream))).toEqual(new Set(['Tax']));
  });

  it('nothing longer than one Excel cell is ever saved, so the Q&A log exports whole and comes back unchanged', async () => {
    const { store, saved } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'Long one' }); const [q1] = dealQuestions(store.get(), dealId);
    // one character over the cell: refused, with the reason, and nothing changes
    const over = await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: 'x'.repeat(TEXT_MAX + 1) }, { quiet: true });
    expect(over.ok).toBe(false); expect((over as any).error.message).toMatch(/at most 32,767 characters/); expect(store.get().questions[q1.id].response).toBe('');
    expect((await store.dispatch(EditQuestionField, { dealId, questionId: q1.id, field: 'text', value: 'q'.repeat(TEXT_MAX + 1) }, { quiet: true })).ok).toBe(false);
    // exactly a cell: saved, exported whole, and a merge of that file changes nothing
    const full = Array.from({ length: 900 }, (_, i) => `Clause ${i}: the lender may sweep cash.\r\n`).join('').slice(0, TEXT_MAX);
    expect((await store.dispatch(SetResponse, { dealId, questionId: q1.id, response: full })).ok).toBe(true);
    const ex = await exportQuestions(store, dealId, { status: 'all', workstream: '', askedBy: [q1.askedBy] }); expect(ex.ok && ex.value).toBe(1);
    const back = await readImportFile(store, fileOf('log.csv', saved[0].bytes)); if (!back.ok) throw new Error(back.error.message);
    const p = prepareImport(back.value.rows, back.value.mapping);
    expect(p.rows[0].response.endsWith('[cut: longer than Excel allows in one cell]')).toBe(false);
    // its line breaks are stored as CR LF in the app and come back as LF: that is no change to the response
    expect(previewImport(store, dealId, 'merge', p.rows)).toEqual({ ok: true, value: { created: 0, updated: 0, restored: 0, changes: [] } });
  });

  it('reports a canceled save, an empty selection and a failed save without claiming an export', async () => {
    const { store, saved, setSave } = make(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
    await store.dispatch(CreateFinding, { dealId, title: 'Curtailment risk', workstream: 'Technical' });
    expect((await exportFindings(store, dealId, { status: 'closed', workstream: '', reviewedOnly: false })).ok).toBe(false);
    setSave({ ok: true, value: 'canceled' });
    const c = await exportFindings(store, dealId, { status: 'all', workstream: '', reviewedOnly: false });
    expect(c.ok && c.value).toBe('canceled');
    setSave({ ok: false, error: { kind: 'failed', message: 'disk' } });
    expect((await exportFindings(store, dealId, { status: 'all', workstream: '', reviewedOnly: false })).ok).toBe(false);
    setSave({ ok: true, value: 'saved' });
    const okr = await exportFindings(store, dealId, { status: 'all', workstream: '', reviewedOnly: false }); expect(okr.ok && okr.value).toBe(1);
    expect(saved.map((s) => s.name)).toEqual(['Project Datum findings.csv']);                      // the stand-in writes CSV; the app writes .xlsx through LibreOffice
    const t = readCsv(saved[0].bytes); expect(t.ok && t.value.columns.slice(0, 5)).toEqual(['Title', 'Detail', 'Workstream', 'Status', 'Raised']);
    expect(t.ok && [t.value.rows[0][0], t.value.rows[0][2], t.value.rows[0][3]]).toEqual(['Curtailment risk', 'Technical', 'Open']);
  });

  it('refuses files it cannot read, by type, size and content', async () => {
    const { store } = make(); await store.boot();
    expect((await readImportFile(store, fileOf('notes.docx', new Uint8Array([80, 75, 3, 4])))).ok).toBe(false);
    expect((await readImportFile(store, { name: 'big.csv', size: 21 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) })).ok).toBe(false);
    expect((await readImportFile(store, fileOf('bad.xlsx', new Uint8Array([1, 2, 3, 4])))).ok).toBe(false);
    expect((await readImportFile(store, fileOf('headers-only.csv', new TextEncoder().encode('Number,Question\n')))).ok).toBe(false);
  });
});

describe('Merge imports the file exactly as it reads (#256)', () => {
  const wrongEncoding = (text: string) => new TextDecoder('windows-1252').decode(new TextEncoder().encode(text));
  it.each([
    ['a "?" for a character', (text: string) => text.replace(/[’—]/g, '?')],
    ['a replacement character', (text: string) => text.replace(/[’—]/g, '\uFFFD')],
    ['wrongly decoded text', wrongEncoding],
  ])('lists %s as an ordinary overwrite, applies it, and can undo it', async (_name, damage) => {
    const { store } = make();
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Deal', folders: [] });
    const [dealId] = Object.keys(store.get().deals);
    await store.loadDeal(dealId);
    const columns = suggestMapping(['Number', 'Question', 'Response']);
    const rowsOf = (cells: string[][]) => prepareImport(cells, columns).rows;
    const saved = ['1', 'What’s the lock-up ratio — tested when?', 'It’s 1.25x — tested semi-annually'];
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsOf([saved]) })).ok).toBe(true);
    const [before] = dealQuestions(store.get(), dealId);
    const file = rowsOf([['1', damage(saved[1]), damage(saved[2])]]);
    const preview = previewImport(store, dealId, 'merge', file);
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.value.changes.map((change) => change.field)).toEqual(['Question', 'Response']);
    const result = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: file });
    if (!result.ok) throw new Error(result.error.message);
    expect(dealQuestions(store.get(), dealId)[0]).toMatchObject({ text: file[0].text, response: file[0].response });
    expect((await store.undo(result.value.opId)).ok).toBe(true);
    expect(store.get().questions[before.id]).toMatchObject({ text: before.text, response: before.response });
  });
});

describe('search across deals', () => {
  it('finds deals, findings, cited documents and questions in deals not yet opened, without asking the AI for anything', async () => {
    const kv = disk();
    { const a = make(kv); await a.store.boot();
      await a.store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); await a.store.dispatch(CreateDeal, { name: 'Margie', folders: [] });
      const [k, l] = Object.values(a.store.get().deals).sort((x, y) => x.name.localeCompare(y.name));
      await a.store.loadDeal(k.id); await a.store.loadDeal(l.id);
      await a.store.dispatch(CreateFinding, { dealId: l.id, title: 'Substation deposit unfunded', workstream: 'Legal' });
      await a.store.dispatch(CreateQuestion, { dealId: l.id, text: 'Who holds the substation lease?' });
      await a.store.dispatch(CreateQuestion, { dealId: k.id, text: 'Unrelated' }); }
    const { store, calls } = make(kv); await store.boot();                       // a new session: nothing visited
    expect(search(store.get(), '').map((h) => h.title).sort()).toEqual(['Project Datum', 'Project Margie']);
    expect(search(store.get(), 'substation')).toEqual([]);
    await loadAllForSearch(store);
    const hits = search(store.get(), 'SUBSTATION');
    expect(hits.map((h) => h.where).sort()).toEqual(['Project Margie', 'Project Margie · Q1']);
    const qh = hits.find((h) => h.hash.startsWith('qa-'))!;
    expect(qh.ui).toMatchObject({ qaFilter: { status: 'all', workstream: '', text: '' } }); expect(store.get().questions[qh.ui!.selectedQuestion!].text).toMatch(/substation/);
    expect(search(store.get(), 'q1').length).toBe(2);
    expect(calls.brief).toBe(0);
    const lam = Object.values(store.get().deals).find((d) => d.name === 'Project Margie')!;
    await store.loadDeal(lam.id);   // opening the deal page fetches its gaps, never a summary
    expect(calls.brief).toBe(0);
  });
});
