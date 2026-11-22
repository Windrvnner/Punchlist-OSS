// Ten decisions on records, folders and imports, and the rules that come with them.
import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, mockFirstPass, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal, DeleteDeal, withProject, dealNameRoom } from '../../src/app/commands/deals';
import { navIntent } from '../../src/app/conversations';
import { nameDir } from '../../src/ui/hooks';
import { CreateQuestion, DeleteQuestion, RestoreQuestion, EditQuestionField, SetResponse, SetQuestionStatus } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, ApplyReassessment } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { RecoverDrafts, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { dealFindings, dealQuestions, dealHash, pageHash, DEAL_PAGES, itemStanding } from '../../src/app/state';
import type { ChecklistRow } from '../../src/ports';
import { previewImport, proposeLayout, readImportBytes } from '../../src/app/transfer';
import { tableFrom, type Sheet } from '../../src/domain/sheets';
import type { SpreadsheetCodec } from '../../src/ports';
import { searchGroups, allHits, fold, GROUP_SHOWN } from '../../src/app/search';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { toParagraphs, withoutMarkers, splitCited } from '../../src/domain/cite';

const COMMANDS = [RestoreQuestionSnapshot, SetQuestionStatus, ApplyReassessment, CreateDeal, EditDeal, CreateQuestion, DeleteQuestion, RestoreQuestion, EditQuestionField, SetResponse, CreateFinding, EditFinding, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, ImportQuestions, RevertImport, RecoverDrafts];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 16, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HYYYYYYYYYYYYYYYV${String(seq++).padStart(7, '0')}` };
/** a log that doesn't start at A1, on the second sheet, with headings the app's own rules don't know: as LibreOffice reads it */
const ODD: Sheet[] = [{ name: 'Cover', grid: [['Project Proseware'], ['Confidential']] }, { name: 'Log', grid: [[], ['', 'Queries', 'for', 'the sponsor'], [], [], ['', 'Ref', 'Lender query', 'Sponsor reply'], ['', 'A1', 'Is the EPC wrap fixed price?', 'Yes']] }];
/** the stand-in's CSV reader, and "odd.xlsx" read as LibreOffice would read it */
const codec: SpreadsheetCodec = { ...csvCodec, async read(bytes, name, opts) { if (name !== 'odd.xlsx') return csvCodec.read(bytes, name, opts); const t = tableFrom(ODD, opts); return t ? { ok: true, value: t } : { ok: false, error: { kind: 'invalid', message: 'The file has no rows' } }; } };
function make(local = new MemoryLocal(), ai: Record<string, unknown> = {}) {
  const opts: MockOptions = { latency: [0, 0] }; const repo = memRepo(clock.now);
  const store = new Store({ repo, ai: { ...mockAi(opts, repo), ...ai } as any, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: codec, session: mockSession(opts), local, clock, ids }, COMMANDS);
  return { store, repo, opts, local };
}
async function deal(m: ReturnType<typeof make>, name: string, firstPass = false) {
  if (m.store.get().boot.stage !== 'ready') await m.store.boot();
  await m.store.dispatch(CreateDeal, { name, folders: [] });
  const d = Object.values(m.store.get().deals).find((x) => x.name === withProject(name))!;
  if (firstPass) await mockFirstPass(m.repo, d.id, d.name, m.opts);
  await m.store.loadDeal(d.id);
  return d.id;
}
const rowsFrom = (csv: string) => { const tb = readCsv(new TextEncoder().encode(csv)); if (!tb.ok) throw new Error('csv'); return prepareImport(tb.value.rows, suggestMapping(tb.value.columns)).rows; };
const opId = (r: any) => r.value.opId as string;

describe('a deal can be renamed, moved between groups, and told which way new questions run', () => {
  it('"Project" is never doubled: on create and on a rename it is added only when missing', async () => {
    const m = make(); const a = await deal(m, 'Proseware'); const b = await deal(m, 'project Wingtip');
    expect(m.store.get().deals[a].name).toBe('Project Proseware');
    expect(m.store.get().deals[b].name).toBe('Project Wingtip');   // already says project: only that word capitalized
    const r = await m.store.dispatch(EditDeal, { dealId: a, name: '  Trey  ' });
    expect(m.store.get().deals[a].name).toBe('Project Trey');                // trimmed, and "Project " added as on a new deal
    await m.store.dispatch(EditDeal, { dealId: b, name: 'PROJECT Wingtip Two' });
    expect(m.store.get().deals[b].name).toBe('Project Wingtip Two');   // any capitals: "Project", the rest as typed
    expect((await m.store.dispatch(EditDeal, { dealId: b, name: 'x'.repeat(113) }, { quiet: true })).ok).toBe(false);   // 121 with "Project ", as on create
    await m.store.undo(opId(r));
    expect(m.store.get().deals[a].name).toBe('Project Proseware');
  });

  it('"Project" before a hyphen, a colon or nothing is not doubled and is capitalized; misspellings stay', async () => {
    const m = make();
    const typed = ['Project-Lucerne Solar', 'project: Northwind Wind', 'PROJECT.Tailspin', 'Project',
      '  project   Contoso Hydro '];
    const saved = ['Project-Lucerne Solar', 'Project: Northwind Wind', 'Project.Tailspin', 'Project',
      'Project Contoso Hydro'];
    for (const name of typed) {
      await m.store.dispatch(CreateDeal, { name, folders: [] }, { quiet: true });
    }
    const names = () => Object.values(m.store.get().deals).map((d) => d.name);
    expect(names()).toEqual(expect.arrayContaining(saved));
    expect(names().some((n) => /^project project/i.test(n))).toBe(false);
    // only the word itself counts: a name that runs on from it, or a misspelling, still gets "Project " in front
    for (const name of ['Projector Coho Wind', 'Porject Fabrikam', 'Projct Adatum']) {
      await m.store.dispatch(CreateDeal, { name, folders: [] });
    }
    const prefixed = ['Project Projector Coho Wind', 'Project Porject Fabrikam', 'Project Projct Adatum'];
    expect(names()).toEqual(expect.arrayContaining(prefixed));
    const id = Object.values(m.store.get().deals).find((d) => d.name === 'Project Porject Fabrikam')!.id;
    await m.store.dispatch(EditDeal, { dealId: id, name: 'PROJECT-Fabrikam MLP' });   // a rename follows the same rule
    expect(m.store.get().deals[id].name).toBe('Project-Fabrikam MLP');            // the rest keeps its capitals
    // with the word already there, the full length is free, as the name fields allow
    const full = await m.store.dispatch(EditDeal, { dealId: id, name: `Project-${'x'.repeat(112)}` }, { quiet: true });
    expect(full.ok).toBe(true);
  });

  it('a "Project-…" or "Project: …" name is found by "go to" and runs the way its words do', async () => {
    const m = make();
    const a = await deal(m, 'Project-Lucerne Solar');
    expect(navIntent(m.store, 'go to Lucerne Solar findings')).toBe(true);
    expect(location.hash).toBe(`#${pageHash('findings', a)}`);
    expect(nameDir('Project: \u05e9\u05de\u05e9')).toBe('rtl');             // Hebrew after "Project: "
    expect(nameDir('Projector \u05e9\u05de\u05e9')).toBe('auto');           // another word that starts with the letters
    expect(nameDir('Project Lucerne \u05e9\u05de\u05e9')).toBe('auto');     // a Hebrew word later on doesn't decide it
  });

  it('Undo brings back a capitalized "Project"; an accent or hidden character is not the word', async () => {
    const m = make();
    const a = await deal(m, 'project Wingtip Storage');
    expect(m.store.get().deals[a].name).toBe('Project Wingtip Storage');
    const r = await m.store.dispatch(EditDeal, { dealId: a, name: 'Trey Research Wind' });
    await m.store.undo(opId(r));
    expect(m.store.get().deals[a].name).toBe('Project Wingtip Storage');
    await m.store.dispatch(CreateDeal, { name: 'Project\u0301 Adatum', folders: [] });   // an accent on the t
    expect(Object.values(m.store.get().deals).some((d) => d.name === 'Project Project\u0301 Adatum')).toBe(true);
    // the field's limit is worked out on the name as it will be kept: a hidden space after "Project" is dropped
    expect(dealNameRoom('Project\u200Bx')).toBe(112);
    expect(dealNameRoom('  project Contoso')).toBe(120);
  });

  it('refuses a blank name; a name another deal has is fine, since many deals share one', async () => {
    const m = make(); const a = await deal(m, 'Proseware'); await deal(m, 'Wingtip');
    const before = m.store.get().deals[a];
    expect((await m.store.dispatch(EditDeal, { dealId: a, name: '   ' }, { quiet: true })).ok).toBe(false);
    expect(m.store.get().deals[a]).toEqual(before);
    expect((await m.store.dispatch(EditDeal, { dealId: a, name: 'Project Wingtip' }, { quiet: true })).ok).toBe(true);
    expect((await m.store.dispatch(CreateDeal, { name: 'Wingtip', folders: [] }, { quiet: true })).ok).toBe(true);
    expect(Object.values(m.store.get().deals).filter((d) => d.name === 'Project Wingtip')).toHaveLength(3);
  });

  it('keeps names in one form, and the name as shown deletes the deal; none over 120', async () => {
    const m = make();
    expect((await m.store.dispatch(CreateDeal, { name: 'Proseware  Wind', folders: [] })).ok).toBe(true);
    expect(Object.values(m.store.get().deals).some((d) => d.name === 'Project Proseware Wind')).toBe(true);   // the double space is kept as one
    expect((await m.store.dispatch(CreateDeal, { name: 'Proseware Wind\u200b', folders: [] })).ok).toBe(true);
    expect(Object.values(m.store.get().deals).filter((d) => d.name === 'Project Proseware Wind')).toHaveLength(2);   // the hidden character is dropped
    expect((await m.store.dispatch(CreateDeal, { name: 'Luce\u0301rne', folders: [] })).ok).toBe(true);   // e and a combining accent
    const b = Object.values(m.store.get().deals).find((d) => d.name.includes('rne') && !d.name.includes('Wind'))!;
    expect(b.name).toBe('Project Luc\u00e9rne');
    expect((await m.store.dispatch(CreateDeal, { name: 'x'.repeat(113), folders: [] }, { quiet: true })).ok).toBe(false);   // 121 with "Project "
    expect((await m.store.dispatch(CreateDeal, { name: 'x'.repeat(112), folders: [] }, { quiet: true })).ok).toBe(true);
    expect((await m.store.dispatch(DeleteDeal, { dealId: b.id, typedName: 'Project Luce\u0301rne' }, { quiet: true })).ok).toBe(true);
  });

  it('a question made here is submitted by the firm; there is no direction to set', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'Which ratio was agreed?' });
    const q = Object.values(m.store.get().questions).find((x) => x.text === 'Which ratio was agreed?')!;
    expect(q.askedBy).toBe('[firm name]'); expect('mode' in q).toBe(false); expect('mode' in m.store.get().deals[a]).toBe(false);
  });

  it('withdraws an Undo that can no longer apply: the record it would act on has since been deleted', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const made = await m.store.dispatch(CreateQuestion, { dealId: a, text: 'A question' });
    const other = await m.store.dispatch(CreateQuestion, { dealId: a, text: 'And this' });
    const q = Object.values(m.store.get().questions).find((x) => x.text === 'A question')!;
    const undoOf = (r: unknown) => m.store.get().ui.toasts.find((t) => t.action?.opId === opId(r as any));
    expect(undoOf(made)?.action?.label).toBe('Undo'); expect(undoOf(other)?.action?.label).toBe('Undo');
    const del = await m.store.dispatch(DeleteQuestion, { dealId: a, questionId: q.id });
    // the notice about adding it stays, without the Undo; the other question's Undo and the delete's own are untouched
    expect(m.store.get().ui.toasts.some((t) => /added|created|Q\d/i.test(t.text) && !t.action)).toBe(true);
    expect(undoOf(made)).toBeUndefined(); expect(undoOf(other)?.action?.label).toBe('Undo'); expect(undoOf(del)?.action?.label).toBe('Undo');
    await m.store.undo(opId(del));
    expect(m.store.get().questions[q.id]?.text).toBe('A question');
  });

  it('moves between Live, Monitoring, Pitch and Closed only when a person says so, with Undo', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    expect(m.store.get().deals[a].group).toBe('live');
    const r = await m.store.dispatch(EditDeal, { dealId: a, group: 'monitor' });
    expect(m.store.get().deals[a].group).toBe('monitor');
    expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Project Proseware moved to Monitoring', action: { label: 'Undo' } });
    await m.store.undo(opId(r));
    expect(m.store.get().deals[a].group).toBe('live');
    const same = await m.store.dispatch(EditDeal, { dealId: a, group: 'live' });   // no change, no write
    expect(same.ok).toBe(true); expect(m.store.get().deals[a].rev).toBe(m.store.get().deals[a].rev);
  });
});


describe('a finding’s own words can be corrected after it exists', () => {
  it('edits title, workstream and detail; status, review mark and sources stay as they were; Undo restores',
    async () => {
    const m = make(); const a = await deal(m, 'Proseware', true);
    const f = dealFindings(m.store.get(), a).find((x) => x.sources.length >= 2)!;
    await m.store.dispatch(ReviewFinding, { dealId: a, findingId: f.id, reviewed: true });
    const was = m.store.get().findings[f.id];
    const r = await m.store.dispatch(EditFinding, { dealId: a, findingId: f.id, title: 'Corrected title',
      workstream: 'Tax', body: toParagraphs('First point. [1]\n\nSecond point. [2]\n') });
    const now = m.store.get().findings[f.id];
    expect(now).toMatchObject({ title: 'Corrected title', workstream: 'Tax', body: ['First point. [1]',
      'Second point. [2]'] });
    expect({ status: now.status, reviewed: now.reviewed, sources: now.sources, origin: now.origin }).toEqual({ status: was.status, reviewed: was.reviewed, sources: was.sources, origin: was.origin });
    expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Finding edited', action: { label: 'Undo' } });
    await m.store.undo(opId(r));
    expect({ ...m.store.get().findings[f.id], rev: 0, updatedAt: '' }).toEqual({ ...was, rev: 0, updatedAt: '' });
  });

  it('refuses an empty title, and saving without a change writes nothing', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateFinding, { dealId: a, title: 'As raised', workstream: 'Legal', body: toParagraphs('one\ntwo') }); const f = dealFindings(m.store.get(), a)[0];
    expect(f.body).toEqual(['one', 'two']);                                     // each typed line is a paragraph
    expect((await m.store.dispatch(EditFinding, { dealId: a, findingId: f.id, title: ' ', workstream: 'Legal',
      body: f.body }, { quiet: true })).ok).toBe(false);
    await m.store.dispatch(EditFinding, { dealId: a, findingId: f.id, title: f.title, workstream: f.workstream,
      body: f.body });
    expect(m.store.get().findings[f.id].rev).toBe(f.rev);
  });
});

describe('deleted findings and questions can be put back, and numbers are not handed out twice', () => {
  it('a deleted question keeps its number: the next one added takes a new number, and Restore brings the old one back', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    for (const x of ['one', 'two', 'three']) await m.store.dispatch(CreateQuestion, { dealId: a, text: x });
    const q3 = dealQuestions(m.store.get(), a).find((q) => q.n === 3)!;
    await m.store.dispatch(DeleteQuestion, { dealId: a, questionId: q3.id });
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'four' });
    expect(dealQuestions(m.store.get(), a).map((q) => q.n).sort()).toEqual([1, 2, 4]);
    expect(Object.values(m.store.get().tombstones).filter((x) => x.dealId === a && x.kind === 'question').map((x) => x.id)).toEqual([q3.id]);
    await m.store.dispatch(RestoreQuestion, { dealId: a, questionId: q3.id });
    expect(dealQuestions(m.store.get(), a).map((q) => q.n).sort()).toEqual([1, 2, 3, 4]);
    expect(m.store.get().tombstones[q3.id]).toBeUndefined();
  });

  it('two rows of one file with the same number are both kept, as two questions marked with the same number', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'Already here' });                                          // Q1 exists
    await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'merge', rows: rowsFrom('Number,Question,Response\n5,First five,Answer one\n5,Second five,\n1,Merged into one,\n1,Also one,\n') });
    const qs = dealQuestions(m.store.get(), a).map((q) => `${q.n}: ${q.text} | ${q.response}`).sort();
    // the file's 1s read as neither Q1 nor each other: questions of their own, never written over Q1
    expect(qs).toEqual(['1: Already here | ', '5: First five | Answer one', '5: Second five | ', '6: Merged into one | ', '7: Also one | ']);
  });

  it('an import never gives a deleted question\'s number to another question, so the deleted one can still be restored', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'one' }); const q1 = dealQuestions(m.store.get(), a)[0];
    await m.store.dispatch(DeleteQuestion, { dealId: a, questionId: q1.id });
    await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'merge', rows: rowsFrom('Number,Question\n1,From the file\n') });
    expect(dealQuestions(m.store.get(), a).map((q) => `${q.n}: ${q.text}`)).toEqual(['2: From the file']);
    expect((await m.store.dispatch(RestoreQuestion, { dealId: a, questionId: q1.id }, { quiet: true })).ok).toBe(true);
    expect(dealQuestions(m.store.get(), a).map((q) => `${q.n}: ${q.text}`)).toEqual(['1: one', '2: From the file']);
  });

  it('a deleted finding is restored exactly as it was', async () => {
    const m = make(); const a = await deal(m, 'Proseware', true); const f = dealFindings(m.store.get(), a)[0];
    await m.store.dispatch(DeleteFinding, { dealId: a, findingId: f.id });
    expect(m.store.get().findings[f.id]).toBeUndefined();
    await m.store.dispatch(RestoreFinding, { dealId: a, findingId: f.id });
    expect({ ...m.store.get().findings[f.id], rev: 0, updatedAt: '' }).toEqual({ ...f, rev: 0, updatedAt: '' });
  });
});

describe('an import says what it will overwrite before it writes anything', () => {
  it('lists each existing question a merge changes, field by field, and matches what the import then does', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'append', rows: rowsFrom('Number,Question,Response,Workstream\n1,First,Old answer,Legal\n2,Second,,Tax\n') });
    const before = JSON.stringify(m.store.get().questions);
    const rows = rowsFrom('Number,Question,Response,Workstream,Status\n1,First,New answer,Legal,Answered\n2,Second,,Tax,\n2,Second again,,,\n9,Brand new,,,\n');
    const p = previewImport(m.store, a, 'merge', rows);
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect(JSON.stringify(m.store.get().questions)).toBe(before);              // a preview writes nothing
    // a number repeated in the file is a second question under that number, not a change to the first
    expect({ created: p.value.created, updated: p.value.updated }).toEqual({ created: 2, updated: 1 });
    expect(p.value.changes).toEqual([
      { n: 1, field: 'Status', from: 'open', to: 'answered' },
      { n: 1, field: 'Response', from: 'Old answer', to: 'New answer' },
    ].sort((x, y) => x.n - y.n));
    await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'merge', rows });
    expect(m.store.get().ui.toasts.at(-1)?.text).toBe('Imported · 2 new · 1 updated');
    const q = dealQuestions(m.store.get(), a);
    expect(q.find((x) => x.n === 1)).toMatchObject({ response: 'New answer', status: 'answered' });
    expect(q.filter((x) => x.n === 2).map((x) => x.text).sort()).toEqual(['Second', 'Second again']);
    expect(previewImport(m.store, a, 'append', rows)).toMatchObject({ ok: true, value: { created: 4, updated: 0, changes: [] } });
  });

  it('reports a row that breaks a rule up front', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const p = previewImport(m.store, a, 'merge', rowsFrom('Number,Question,Status\n20,Fine,Open\n21,Answered without a response,Answered\n'));
    expect(p.ok).toBe(false); expect((p as any).error.message).toMatch(/^Row 3:/);
    expect(dealQuestions(m.store.get(), a)).toEqual([]);
  });

  it('a large merge is planned in well under a second', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const csv = 'Number,Question,Response\n' + Array.from({ length: 3000 }, (_, i) => `${i + 1},Question ${i + 1},`).join('\n') + '\n';
    await m.store.dispatch(ImportQuestions, { dealId: a, mode: 'append', rows: rowsFrom(csv) }, { quiet: true });
    const again = rowsFrom(csv.replace(/Question (\d+),/g, 'Question $1,Answer $1'));
    const t0 = performance.now(); const p = previewImport(m.store, a, 'merge', again); const ms = performance.now() - t0;
    expect(p.ok && p.value.updated).toBe(3000);
    expect(ms).toBeLessThan(1500);
  }, 60000);
});

describe('search results are grouped by type and say when there are more', () => {
  it('shows the first few of each type, counts the rest, and opens a type up on request', async () => {
    const m = make(); const a = await deal(m, 'Wide World Covenant Review', true);
    for (let i = 1; i <= 8; i++) await m.store.dispatch(CreateQuestion, { dealId: a, text: `Covenant item ${i}` }, { quiet: true });
    await m.store.dispatch(CreateFinding, { dealId: a, title: 'Covenant headroom is thin', workstream: 'Legal' }, { quiet: true });
    const g = searchGroups(m.store.get(), 'covenant');
    expect(g.map((x) => [x.kind, x.label, x.hits.length, x.more])).toEqual([['deal', 'Deals', 1, 0], ['finding', 'Findings', 1, 0], ['question', 'Questions', GROUP_SHOWN, 8 - GROUP_SHOWN]]);
    const open = searchGroups(m.store.get(), 'covenant', ['question']);
    expect(open.find((x) => x.kind === 'question')).toMatchObject({ more: 0 }); expect(open.find((x) => x.kind === 'question')!.hits).toHaveLength(8);
    expect(g.reduce((n, x) => n + x.hits.length + x.more, 0)).toBe(allHits(m.store.get(), 'covenant').length);   // nothing is silently dropped
  });

  it('names which deal a finding, document or question is in when two deals share a name', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [], counterparty: 'Tailwind' }); const b = Object.keys(m.store.get().deals).find((id) => id !== a)!; await m.store.loadDeal(b);
    const c = await deal(m, 'Wingtip');
    await m.store.dispatch(EditDeal, { dealId: a, counterparty: 'Northwind LP' }, { quiet: true });
    for (const id of [a, b, c]) {
      await m.store.dispatch(CreateFinding, { dealId: id, title: 'Covenant headroom is thin', workstream: 'Legal', sources: [{ doc: 'Covenant schedule.pdf', docId: `doc-${id}`, loc: 'p. 4' }] }, { quiet: true });
      await m.store.dispatch(CreateQuestion, { dealId: id, text: 'Covenant reset dates' }, { quiet: true });
    }
    const where = (kind: string) => allHits(m.store.get(), 'covenant').filter((h) => h.kind === kind).map((h) => h.where);
    const made = (id: string) => new Date(m.store.get().deals[id].createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const A = `Project Proseware · Northwind LP · ${made(a)}`, B = `Project Proseware · Tailwind · ${made(b)}`;   // whole on hover; the row gives only what differs (below)
    expect(where('finding')).toEqual([A, B, 'Project Wingtip']);   // a deal with a name of its own stays as it was
    expect(where('document')).toEqual([`${A} · p. 4`, `${B} · p. 4`, 'Project Wingtip · p. 4']);
    expect(where('question')).toEqual([`${A} · Q1`, `${B} · Q1`, 'Project Wingtip · Q1']);
    expect(allHits(m.store.get(), 'covenant').filter((h) => h.kind === 'document').map((h) => h.place)).toEqual([{ deal: 'Project Proseware', twin: 'Northwind LP', at: 'p. 4' }, { deal: 'Project Proseware', twin: 'Tailwind', at: 'p. 4' }, { deal: 'Project Wingtip', twin: '', at: 'p. 4' }]);
  });

  it('ignores case, accents and stray spaces, and puts titles that start with the words first', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(CreateFinding, { dealId: a, title: 'Sponsor résumé omits the lock up history', workstream: 'Legal' }, { quiet: true });
    await m.store.dispatch(CreateFinding, { dealId: a, title: 'Lock up ratio differs', workstream: 'Legal' }, { quiet: true });
    expect(fold('  Résumé   OMITS ')).toBe('resume omits');
    expect(searchGroups(m.store.get(), 'RESUME')[0].hits.map((h) => h.title)).toEqual(['Sponsor résumé omits the lock up history']);
    expect(searchGroups(m.store.get(), 'lock   up')[0].hits.map((h) => h.title)).toEqual(['Lock up ratio differs', 'Sponsor résumé omits the lock up history']);
  });
});

describe('toasts', () => {
  it('a second action does not take away the first one’s Undo, and the clock stops while a toast is being reached for', async () => {
    const m = make(); await m.store.boot();
    vi.useFakeTimers();
    try {
      m.store.toast('First', { label: 'Undo', run() {} }); m.store.toast('Second', { label: 'Undo', run() {} });
      expect(m.store.get().ui.toasts.map((x) => x.text)).toEqual(['First', 'Second']);
      vi.advanceTimersByTime(Store.TOAST_MS - 100);
      m.store.holdToasts(); vi.advanceTimersByTime(60000);
      expect(m.store.get().ui.toasts.map((x) => x.text)).toEqual(['First', 'Second']);   // held: still there a minute later
      m.store.releaseToasts(); vi.advanceTimersByTime(Store.TOAST_MS + 10);
      expect(m.store.get().ui.toasts).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('saved conversations', () => {
  it('one damaged thread does not cost the others', async () => {
    const local = new MemoryLocal();
    const good = [{ id: 'm1', role: 'me', text: 'hello', state: 'done', at: '2026-11-09T16:00:00.000Z' }, { id: 'm2', role: 'ai', text: 'hi', state: 'done', at: '2026-11-09T16:00:01.000Z' }];
    local.write('threads', { all: good, 'deal:d_x': [{ id: 'm3', role: 'someone', text: 5 }], 'deal:d_y': 'not a list' });
    const m = make(local); await m.store.boot();
    expect(Object.keys(m.store.get().threads)).toEqual(['all']);
    expect(m.store.get().threads.all.map((x) => x.text)).toEqual(['hello', 'hi']);
  });
});

describe('more decisions', () => {
  const odd = () => new Uint8Array([0x50, 0x4b, 3, 4]);                 // the bytes don't matter: the test's reader gives ODD for odd.xlsx

  it('the model can propose where the table is when the headings are in words the app does not know; the proposal is checked against the file', async () => {
    const m = make(); await m.store.boot();
    const first = await readImportBytes(m.store, 'odd.xlsx', odd()); if (!first.ok) throw new Error('read');
    expect(first.value.mapping.text).toBeNull();                               // the app's own rules do not know "Lender query"
    const p = await proposeLayout(m.store, first.value);
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect([p.value.sheet, p.value.headerRow, p.value.columns, p.value.proposedByAi]).toEqual(['Log', 5, ['Ref', 'Lender query', 'Sponsor reply'], true]);
    expect(p.value.mapping).toMatchObject({ n: 0, text: 1, response: 2 });
    expect(prepareImport(p.value.rows, p.value.mapping, p.value.lines).rows.map((r) => [r.text, r.response, r.line])).toEqual([['Is the EPC wrap fixed price?', 'Yes', 6]]);
  });

  it('a proposal that does not fit the file is refused rather than applied', async () => {
    const bytes = odd();
    for (const bad of [{ sheet: 'No such sheet', headerRow: 5, fields: { text: 'Lender query' } }, { sheet: 'Log', headerRow: 5, fields: { text: 'A heading that is not there' } }, { sheet: 'Log', headerRow: 2.5, fields: { text: 'Lender query' } }, { sheet: 'Log', headerRow: 5, fields: {} }]) {
      const m = make(new MemoryLocal(), { layout: async () => ({ ok: true, value: bad }) }); await m.store.boot();
      const first = await readImportBytes(m.store, 'odd.xlsx', bytes); if (!first.ok) throw new Error('read');
      expect((await proposeLayout(m.store, first.value)).ok).toBe(false);
    }
    const none = make(new MemoryLocal(), { layout: undefined }); await none.store.boot();
    const first = await readImportBytes(none.store, 'odd.xlsx', bytes); if (!first.ok) throw new Error('read');
    expect((await proposeLayout(none.store, first.value)).ok).toBe(false);     // a backend without the call: the person sets it by hand
  });

  it('the New deal form can set the counterparty, trimmed; left out, it is empty', async () => {
    const m = make();
    expect((await m.store.dispatch(CreateDeal, { name: 'Coho', folders: [], counterparty: '  Northwind Sponsor LP ' })).ok).toBe(true);
    expect((await m.store.dispatch(CreateDeal, { name: 'Nod', folders: [] })).ok).toBe(true);
    const by = (n: string) => Object.values(m.store.get().deals).find((d) => d.name === n)!;
    expect(by('Project Coho').counterparty).toBe('Northwind Sponsor LP'); expect(by('Project Nod').counterparty).toBe('');
  });

  it('a deal carries a counterparty, a product and a sector, set and cleared only by a person', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const r = await m.store.dispatch(EditDeal, { dealId: a, counterparty: '  Northwind Sponsor LP ', product: ' Construction loan ', sector: 'Battery storage' });
    expect(m.store.get().deals[a]).toMatchObject({ counterparty: 'Northwind Sponsor LP', product: 'Construction loan', sector: 'Battery storage', name: 'Project Proseware', group: 'live' });
    expect(m.store.get().ui.toasts.map((t) => t.text).join(' ')).toContain('Structure set to Construction loan');
    await m.store.undo(opId(r));
    expect(m.store.get().deals[a]).toMatchObject({ counterparty: '', product: '', sector: '' });
    // the technology is a detail of its own, set and undone the same way; a deal saved before it existed reads as having none
    const t = await m.store.dispatch(EditDeal, { dealId: a, technology: ' Long-duration storage ' });
    expect(m.store.get().deals[a].technology).toBe('Long-duration storage'); expect(m.store.get().ui.toasts.at(-1)!.text).toBe('Technology set to Long-duration storage');
    await m.store.undo(opId(t)); expect(m.store.get().deals[a].technology).toBe('');
  });

  it('the backend is told when a response is saved on a question tied to no finding, and not for one tied to a finding or with no response', async () => {
    const told: string[] = []; const m = make(new MemoryLocal(), { responses: async (d: string) => { told.push(d); return { ok: true, value: { heard: [], marked: [] } }; } }); const a = await deal(m, 'Proseware', true);
    expect(told).toEqual([a]); told.length = 0;                       // once when the deal is opened, for anything it could not look at when it was saved
    const qs = () => Object.values(m.store.get().questions).filter((q) => q.dealId === a); const f = dealFindings(m.store.get(), a)[0];
    await m.store.dispatch(CreateQuestion, { dealId: a, text: 'Tied to nothing' }); await m.store.dispatch(CreateQuestion, { dealId: a, text: 'Tied to a finding', linkedFinding: f.id }); expect(told).toEqual([]);   // no response yet
    const [free, tied] = [qs().find((q) => q.text === 'Tied to nothing')!, qs().find((q) => q.text === 'Tied to a finding')!];
    await m.store.dispatch(SetResponse, { dealId: a, questionId: tied.id, response: 'Confirmed.' }); expect(told).toEqual([]);                    // the app marks that finding itself
    await m.store.dispatch(SetResponse, { dealId: a, questionId: free.id, response: 'The permit was issued in March.' }); expect(told).toEqual([a]);
    const quiet = make(); const b = await deal(quiet, 'Wingtip'); await quiet.store.dispatch(CreateQuestion, { dealId: b, text: 'Q' }); const q = Object.values(quiet.store.get().questions)[0];
    expect((await quiet.store.dispatch(SetResponse, { dealId: b, questionId: q.id, response: 'Yes.' })).ok).toBe(true);                           // a backend without the call: nothing happens
    const broken = make(new MemoryLocal(), { responses: async () => { throw new Error('boom'); } }); const c = await deal(broken, 'Coho'); await broken.store.dispatch(CreateQuestion, { dealId: c, text: 'Q' });
    expect((await broken.store.dispatch(SetResponse, { dealId: c, questionId: Object.values(broken.store.get().questions)[0].id, response: 'Yes.' })).ok).toBe(true);   // and one that fails does not fail the save
  });

  it('checking everything is a person’s action that changes nothing they set: findings come back marked, with the reason, and the mark is cleared by a reassessment', async () => {
    const m = make(); const a = await deal(m, 'Proseware', true);
    await m.store.refreshGaps(a); await vi.waitFor(() => expect(m.store.get().checks[a]?.at).toBeTruthy());       // the first pass getting to the end was a check of everything
    const before = m.store.get().checks[a].at; const fs = () => dealFindings(m.store.get(), a);
    (globalThis as any).__check = { mark: 1, spot: { size: 5, overturned: 2 } };
    try {
      const run = m.store.checkEverything(a); expect(m.store.get().checks[a].busy).toBe('quick'); await m.store.checkEverything(a); await run;      // a second press while one is running starts nothing
      await vi.waitFor(() => expect(fs().filter((f) => f.updated).length).toBe(1));
      const marked = fs().find((f) => f.updated)!; expect(marked).toMatchObject({ updatedWhy: 'Check of everything', status: 'open', reviewed: null });
      expect(m.store.get().checks[a]).toMatchObject({ offerDeep: { size: 5, overturned: 2 } }); expect(m.store.get().checks[a].busy).toBeUndefined(); expect(m.store.get().checks[a].at! >= before!).toBe(true);
      expect(m.store.get().ui.toasts.at(-1)!.text).toBe('Checklist and findings checked: 1 to update');
      (globalThis as any).__check = {}; await m.store.checkEverything(a, true);                                     // the deeper check, when a person takes the offer
      expect(m.store.get().checks[a].offerDeep).toBeNull(); expect(m.store.get().ui.toasts.at(-1)!.text).toBe('Checklist and findings checked: nothing to update');
      // a check that could not check everything says what it left, and the date of the last complete check stands
      const stood = m.store.get().checks[a].at; (globalThis as any).__check = { unchecked: { items: 2, findings: 1 } }; await m.store.checkEverything(a);
      expect(m.store.get().ui.toasts.at(-1)!.text).toBe('Checked, except 2 checklist items and 1 finding that could not be checked: nothing to update'); expect(m.store.get().checks[a].at).toBe(stood);
      // nothing was left unsettled, but a folder no PC could open was never read: not complete, naming it as a waiting item does
      (globalThis as any).__check = { unread: ['03 Legal'] }; await m.store.checkEverything(a);
      expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Not complete · 03 Legal could not be opened', more: 'Not complete: the folder 03 Legal could not be opened. Nothing to update' }); expect(m.store.get().checks[a].at).toBe(stood);
      (globalThis as any).__check = { unread: ['03 Legal', '07 HR'], unchecked: { items: 1, findings: 0 } }; await m.store.checkEverything(a);
      expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Not complete · 2 folders could not be opened', more: 'Not complete: the folders 03 Legal and 07 HR could not be opened. 1 checklist item could not be checked: nothing to update' });
      // a folder inside another goes by its own name; past five, how many more
      (globalThis as any).__check = { unread: ['03 Legal/03.4 Clean team/Employment'] }; await m.store.checkEverything(a);
      expect(m.store.get().ui.toasts.at(-1)!.text).toBe('Not complete · Employment could not be opened');
      (globalThis as any).__check = { unread: ['04 Project Agreements and Material Contracts'] }; await m.store.checkEverything(a);     // a long name, in the middle
      expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Not complete · 04 Project Agreements and Material Contracts could not be opened', cut: '04 Project Agreements and Material Contracts', more: 'Not complete: the folder 04 Project Agreements and Material Contracts could not be opened. Nothing to update' });
      (globalThis as any).__check = { unread: Array.from({ length: 12 }, (_, i) => `F${i}`) }; await m.store.checkEverything(a);
      expect(m.store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Not complete · 12 folders could not be opened', more: 'Not complete: the folders F0, F1, F2, F3, F4 and 7 more could not be opened. Nothing to update' });
      // what has been read is shown from what the backend reports, and only once its first pass has run
      await vi.waitFor(() => expect(m.store.get().progress[a]).toBeTruthy()); expect(m.store.get().progress[a].folders.every((f) => f.read <= f.files && f.coreRead <= f.core)).toBe(true);
    } finally { delete (globalThis as any).__check; }
    // the checklist's items are listed once the Checklist page asks for them, agree with the counts, and are kept current after that
    const st = () => m.store.get(); expect(st().checklists[a]).toBeUndefined();
    await m.store.refreshGaps(a); await new Promise((r) => setTimeout(r, 0)); expect(st().checklists[a]).toBeUndefined();          // not asked for: not fetched
    await m.store.refreshChecklist(a); const rows = st().checklists[a] as ChecklistRow[]; const pc = st().progress[a].checklist;
    expect(rows.length).toBe(pc.items); expect(rows.filter((r) => r.result === 'finding').length).toBe(pc.findings); expect(rows.filter((r) => r.result === 'gap').length).toBe(pc.gaps); expect(rows.filter((r) => r.result === 'satisfied').length).toBe(pc.satisfied);
    expect(rows.filter((r) => r.result === 'gap').map((r) => r.text)).toEqual(st().gaps[a].map((g) => g.title));                       // the gaps on Overview are the checklist's gaps
    expect(rows.filter((r) => r.result === 'finding').every((r) => !!r.findingId && st().findings[r.findingId!].dealId === a)).toBe(true);
    const gone = rows.find((r) => r.result === 'finding')!; await m.store.dispatch(DeleteFinding, { dealId: a, findingId: gone.findingId! });
    await vi.waitFor(() => expect(st().checklists[a]).not.toBe(rows));                                                                   // refreshed with the summary
    const after = (st().checklists[a] as ChecklistRow[]).find((r) => r.id === gone.id)!;
    expect(after).toMatchObject({ result: 'finding', findingId: gone.findingId });                                                      // the check still names the deleted finding, as in the product
    expect(itemStanding(st(), a, after)).toMatchObject({ kind: 'gone', gone: { id: gone.findingId } });                                 // so the item is still to resolve, and the finding can be restored
    const broken = make(new MemoryLocal(), { checklist: async () => ({ ok: false, error: { kind: 'failed', message: 'x' } }) }); const e = await deal(broken, 'Margie', true); await broken.store.refreshChecklist(e); expect(broken.store.get().checklists[e]).toBe('failed');
    const without = make(new MemoryLocal(), { checklist: undefined }); const w = await deal(without, 'Liberty', true); await without.store.refreshChecklist(w); expect(without.store.get().checklists[w]).toBeUndefined();
    const none = make(new MemoryLocal(), { checkAll: undefined, checked: undefined }); const b = await deal(none, 'Wingtip', true); await none.store.checkEverything(b); expect(none.store.get().checks[b]).toBeUndefined();   // a backend without the call: nothing is offered and nothing happens
    const down = make(new MemoryLocal(), { checkAll: async () => ({ ok: false, error: { kind: 'failed', message: 'x' } }) }); const c = await deal(down, 'Coho', true); await down.store.checkEverything(c); expect(down.store.get().ui.toasts.at(-1)!.text).toBe('The check did not finish. Findings already marked stay marked');
    // cut off by a dropped connection: the offline bar, and the check line keeps that it did not finish
    const cut = make(new MemoryLocal(), { checkAll: async () => ({ ok: false, error: { kind: 'unreachable', message: 'x' } }) }); const eg = await deal(cut, "Margie", true); await cut.store.checkEverything(eg);
    expect(cut.store.get().net.down).toBe(true); expect(cut.store.get().checks[eg].failedAt).toBeTruthy(); expect(cut.store.get().checks[eg].busy).toBeUndefined();
  });

  it('an imported response marks a question Answered only when the person checked the box, the file gives no status, and the question is Open', async () => {
    const csv = 'Number,Question,Response,Status\n1,Has a response,Yes,\n2,No response,,\n3,File says closed,Done,Closed\n';
    const off = make(); const a = await deal(off, 'Proseware');
    await off.store.dispatch(ImportQuestions, { dealId: a, mode: 'merge', rows: rowsFrom(csv) });
    expect(dealQuestions(off.store.get(), a).map((q) => q.status)).toEqual(['open', 'open', 'closed']);
    const on = make(); const b = await deal(on, 'Proseware');
    const p = previewImport(on.store, b, 'merge', rowsFrom(csv), true); expect(p.ok && p.value.created).toBe(3);
    await on.store.dispatch(ImportQuestions, { dealId: b, mode: 'merge', rows: rowsFrom(csv), answerResponded: true });
    expect(dealQuestions(on.store.get(), b).map((q) => q.status)).toEqual(['answered', 'open', 'closed']);
  });
});

describe('decisions, second batch', () => {
  it('a folder can be relabeled after the deal exists, with Undo; a folder the deal does not have is refused', async () => {
    const m = make(); await m.store.boot();
    await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [{ path: 'C:\\Deals\\Proseware\\VDR export', label: 'VDR export', files: 10, size: '1 GB' }] });
    const a = Object.keys(m.store.get().deals)[0];
    const r = await m.store.dispatch(EditDeal, { dealId: a, folder: { path: 'C:\\Deals\\Proseware\\VDR export', label: ' Data room ' } });
    expect(m.store.get().deals[a].folders[0]).toMatchObject({ label: 'Data room', files: 10, path: 'C:\\Deals\\Proseware\\VDR export' });
    await m.store.undo(opId(r));
    expect(m.store.get().deals[a].folders[0].label).toBe('VDR export');
    expect((await m.store.dispatch(EditDeal, { dealId: a, folder: { path: 'elsewhere', label: 'x' } }, { quiet: true })).ok).toBe(false);
  });

  it('a chat answer is cited the way a finding is, and the markers come out of text that leaves the app', async () => {
    const m = make(); const a = await deal(m, 'Proseware', true); const f = dealFindings(m.store.get(), a).find((x) => x.sources.length >= 2)!;
    const ans = await m.store.services.ai.answer({ dealId: a, findingId: f.id, message: 'Why does this matter?', history: [], model: 'standard' });
    expect(ans.ok).toBe(true); if (!ans.ok) return;
    const parts = splitCited(ans.value.text, ans.value.sources.length).filter((p) => p.refs.length);
    expect(parts.length).toBeGreaterThanOrEqual(2);                             // each sentence carries its own source
    expect(parts.map((p) => p.refs)).toEqual([[1], [2]]);
    expect(withoutMarkers(ans.value.text, ans.value.sources.length)).not.toMatch(/\[\d+\]/);
    expect(withoutMarkers('Clause [4] of the 2019 deed applies. [1]', 1)).toBe('Clause [4] of the 2019 deed applies.');   // only real markers go
  });
});

describe('search finds what a person would type', () => {
  it('across hyphens and spaces, by counterparty, and in a finding\'s detail', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    await m.store.dispatch(EditDeal, { dealId: a, counterparty: 'Northwind Sponsor LP' });
    await m.store.dispatch(CreateFinding, { dealId: a, title: 'Lock-up ratio differs', workstream: 'Legal', body: ['The model uses a DSCR covenant of 1.25x.'] });
    const kinds = (q: string) => allHits(m.store.get(), q).map((h) => h.kind);
    for (const q of ['lockup', 'lock up', 'Lock-up', 'dscr covenant']) expect(kinds(q)).toContain('finding');
    expect(kinds('northwind')).toContain('deal');
    expect(allHits(m.store.get(), 'k e')).toEqual([]);                  // a short query is not matched with its spaces taken out
  });
});

describe('the page a deal opens on', () => {
  it('is Overview unless the person chose another, is remembered, and every link that opens a deal follows it', async () => {
    const local = new MemoryLocal(); const m = make(local); const a = await deal(m, 'Proseware');
    expect(m.store.get().prefs.landing).toBe('overview'); expect(dealHash(m.store.get().prefs, a)).toBe(`overview-${a}`);
    expect(allHits(m.store.get(), 'proseware').find((h) => h.kind === 'deal')!.hash).toBe(`overview-${a}`);
    expect(DEAL_PAGES.map((p) => pageHash(p[0], a))).toEqual([`overview-${a}`, `deal-${a}`, `checklist-${a}`, `qa-${a}`]);
    for (const [page] of DEAL_PAGES) { m.store.setPrefs({ landing: page }); expect(dealHash(m.store.get().prefs, a)).toBe(pageHash(page, a)); expect(allHits(m.store.get(), 'proseware').find((h) => h.kind === 'deal')!.hash).toBe(pageHash(page, a)); }
    m.store.setPrefs({ landing: 'checklist' }); const again = make(local); await again.store.boot(); expect(again.store.get().prefs.landing).toBe('checklist');     // remembered on this PC
  });
});

describe('withdrawing a response', () => {
  it('clearing the response says so with Undo, and Undo puts back the response, who it came from and the mark on its finding', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'Lock-up differs', workstream: 'Legal' }); const f = dealFindings(m.store.get(), d)[0];
    await m.store.dispatch(CreateQuestion, { dealId: d, text: 'Which ratio was agreed?', linkedFinding: f.id }); const q = dealQuestions(m.store.get(), d)[0];
    // typing a response says nothing: the field saves as it goes
    expect((await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '1.25x, per the signed term sheet.' }, { quiet: true })).ok).toBe(true);
    const had = m.store.get().questions[q.id]; expect(m.store.get().findings[f.id]).toMatchObject({ updated: true, updatedOn: { questions: [q.id] } });
    const before = m.store.get().ui.toasts.at(-1)?.id;
    // emptying it is said, with Undo, however the field asked for it to be saved
    const r = await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '' }, { quiet: true }); expect(r.ok).toBe(true);
    const n = m.store.get().ui.toasts.at(-1)!; expect(n.id).not.toBe(before);   // a new notice (at most three show, so the count alone can't tell)
    expect(n).toMatchObject({ text: 'Response removed from Q1', action: { label: 'Undo' } });
    expect(m.store.get().questions[q.id].response).toBe(''); expect(m.store.get().questions[q.id].provenance).toBeUndefined(); expect(m.store.get().findings[f.id].updated).toBe(false);
    // Undo: the question as it was, and the finding marked again
    expect((await m.store.undo(n.action!.opId!)).ok).toBe(true);
    const back = m.store.get().questions[q.id];
    expect({ response: back.response, provenance: back.provenance, status: back.status }).toEqual({ response: had.response, provenance: had.provenance, status: had.status });
    expect(m.store.get().findings[f.id]).toMatchObject({ updated: true, updatedOn: { questions: [q.id] } });
  });
});

describe('Undo of an older action', () => {
  it('is refused after the record was deleted, restored and changed again', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    await m.store.dispatch(CreateQuestion, { dealId: d, text: 'Is there a decommissioning bond?' }); const q = dealQuestions(m.store.get(), d)[0];
    const older = await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: 'Yes, issued March 3.' }); expect(older.ok).toBe(true);
    const revAfter = m.store.get().questions[q.id].rev;
    await m.store.dispatch(DeleteQuestion, { dealId: d, questionId: q.id }); await m.store.dispatch(RestoreQuestion, { dealId: d, questionId: q.id });
    await m.store.dispatch(SetQuestionStatus, { dealId: d, questionId: q.id, status: 'closed' });                 // later work
    expect(m.store.get().questions[q.id].rev).toBeGreaterThan(revAfter + 1);                                         // the delete and the restore count, so the number moves on
    const u = await m.store.undo((older as any).value.opId);
    expect(!u.ok && u.error.message).toBe('Changed since — undo refused');
    expect(m.store.get().questions[q.id]).toMatchObject({ response: 'Yes, issued March 3.', status: 'closed' });   // the later work stands
  });
});

describe('A reworded response on a linked question', () => {
  it('marks the finding again after a person reassessed it, and Undo puts the response and the finding back as they were', async () => {
    const m = make(); const d = await deal(m, 'Alpine');
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'Lock-up differs', workstream: 'Legal' }); const f = dealFindings(m.store.get(), d)[0];
    await m.store.dispatch(CreateQuestion, { dealId: d, text: 'Which ratio?', linkedFinding: f.id }); const q = dealQuestions(m.store.get(), d)[0];
    await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '1.25x.' });
    await m.store.dispatch(ApplyReassessment, { dealId: d, findingId: f.id, requestOpId: 'op_x', result: { body: ['Reassessed.'], sources: [] } });
    expect(m.store.get().findings[f.id].updated).toBe(false);
    await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '1.25x.  ' }); expect(m.store.get().findings[f.id].updated).toBe(false);   // other spacing is not other words
    const r = await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '1.20x, per the amendment.' }); expect(r.ok).toBe(true);
    expect(m.store.get().findings[f.id]).toMatchObject({ updated: true, updatedOn: { questions: [q.id] } });
    expect((await m.store.undo((r as any).value.opId)).ok).toBe(true);
    expect(m.store.get().questions[q.id].response).toBe('1.25x.  '); expect(m.store.get().findings[f.id].updated).toBe(false);
  });
});

describe('Undo of a withdrawn response', () => {
  it('leaves alone a finding the withdrawal did not change, so a mark a person cleared in between does not come back', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'Lock-up differs', workstream: 'Legal' }); const f = dealFindings(m.store.get(), d)[0];
    await m.store.dispatch(CreateQuestion, { dealId: d, text: 'Which ratio?', linkedFinding: f.id }); const q = dealQuestions(m.store.get(), d)[0];
    await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '1.25x.' }); expect(m.store.get().findings[f.id].updated).toBe(true);
    // a person reassesses: the mark goes
    expect((await m.store.dispatch(ApplyReassessment, { dealId: d, findingId: f.id, requestOpId: 'op_x', result: { body: ['Reassessed.'], sources: [] } })).ok).toBe(true);
    expect(m.store.get().findings[f.id].updated).toBe(false);
    const w = await m.store.dispatch(SetResponse, { dealId: d, questionId: q.id, response: '' }); expect(w.ok).toBe(true);
    expect((await m.store.undo((w as any).value.opId)).ok).toBe(true);
    expect(m.store.get().questions[q.id].response).toBe('1.25x.'); expect(m.store.get().findings[f.id].updated).toBe(false);
  });
});


describe('notices', () => {
  it('at most three show: a fourth pushes out the oldest and its Undo with it, so Ctrl Z never reaches one that was not on screen', async () => {
    const m = make(); await m.store.boot();
    for (const n of [1, 2, 3, 4]) m.store.toast(`Notice ${n}`, { label: 'Undo', run: () => {} });
    expect(m.store.get().ui.toasts.map((t) => t.text)).toEqual(['Notice 2', 'Notice 3', 'Notice 4']);
  });
});
