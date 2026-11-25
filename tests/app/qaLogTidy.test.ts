// A Q&A log update whose working files are held by another program as it tidies up (a sync client uploading the new
// version, say) is still a save: it says so, records what it wrote, and the files left behind go at a later update.
// The app's Store on the real log files code, a CSV log of 2,000 questions in a temporary folder; the lock is a stand-in.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import {
  KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, TakeFromQaLog, RestoreQuestionSnapshots,
} from '../../src/app/commands/qaLogs';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, FIRM } from '../../src/app/state';
import { keepImportedLog, exportQaLog, logOf } from '../../src/app/qaLog';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { temporaryFixtureName } from '../backend/qaLogWorkingFiles';
import { ok } from '../../src/domain/result';
import { libreOfficeConverter } from '../../src/backend/convert';
import { gridOf, xlsxOf } from '../backend/miniXlsx';
import { hasOffice, soffice } from '../backend/officePrerequisites';

const COMMANDS = [
  CreateDeal, ImportQuestions, SetResponse, KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs, TakeFromQaLog,
  RestoreQuestionSnapshots,
];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-tidy-test-lo-')) });
const N = 2000; const FILE = 'Proseware Q&A log.xlsx'; const columns = ['No.', 'Question', 'Response'];
const text = (i: number) => `Question ${i}: please confirm item ${i}.`;
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

async function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-tidy-'));
  const rows = Array.from({ length: N }, (_, k) => [String(k + 1), text(k + 1), '']);
  fs.writeFileSync(path.join(folder, FILE), xlsxOf([columns, ...rows]));
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: async () => ok([]), pathFor: null, save: async () => ok('saved' as const) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), qaLogs: nodeQaLogs({ convert: lo }), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
  // Only the complete log is setup; every save and race below still uses the real files.
  const imported = prepareImport(rows, suggestMapping(columns)).rows.map((row) => ({ ...row, askedBy: FIRM }));
  const seeded = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: imported }, { quiet: true });
  expect(seeded.ok).toBe(true);
  expect((await keepImportedLog(store, dealId, { path: path.join(folder, FILE), sheet: 'Sheet1', headerRow: 1, mapping: suggestMapping(columns), make: true, rows })).ok).toBe(true);
  const q5 = dealQuestions(store.get(), dealId).find((q) => q.text === text(5))!;
  return { folder, store, dealId, q5 };
}
/** the log's row for question `i`, as it is in the file */
const row = (folder: string, i: number) => (gridOf(fs.readFileSync(path.join(folder, FILE)))[i] ?? []).join(',');
/** the folder's clock moves on two minutes: every file made from now on reads as made then, so the ones before are old */
const later = () => {
  const wait = Date.now() + 30; while (Date.now() < wait) { /* so the files before are 20 ms older at least */ }
  const t0 = Date.now() - 10; const st = fs.statSync;   // 10 ms: a file system's clock may lag a little behind
  vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs >= t0 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
};
const isWorkingFile = (name: string) => /^~qa-log-.*\.(tmp|old)$/.test(name);
const leftovers = (folder: string) => fs.readdirSync(folder).filter(isWorkingFile);

describe.skipIf(!hasOffice)('a Q&A log update whose working files are busy as it tidies up', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says it saved, records what it wrote, and the next update brings a corrected answer in; what was left goes then', async () => {
    const { folder, store, dealId, q5 } = await setup();
    await store.dispatch(SetResponse, { dealId, questionId: q5.id, response: 'Answer v1' });
    // the working file and the version moved aside are each held once, as the save tries to remove them
    const rm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (isWorkingFile(path.basename(String(file)))) throw busy();
      return rm(file, options);
    });
    const first = await exportQaLog(store, dealId);
    expect(first.ok && first.value.status).toBe('written');
    expect(row(folder, 5)).toBe('5,Question 5: please confirm item 5.,Answer v1');
    expect(logOf(store, dealId)!.last!.sent![q5.id]).toMatchObject({ response: 'Answer v1' });   // what was written is recorded
    expect(leftovers(folder).map((n) => n.slice(-4)).sort()).toEqual(['.old', '.tmp']);
    vi.restoreAllMocks();

    // corrected in the app; at the next update, a minute later or more, the correction reaches the log and what was left goes
    await store.dispatch(SetResponse, { dealId, questionId: q5.id, response: 'Answer v2 (corrected)' });
    later();
    const second = await exportQaLog(store, dealId);
    expect(second.ok && second.value).toMatchObject({ status: 'written', updated: 1, kept: [] });
    expect(row(folder, 5)).toBe('5,Question 5: please confirm item 5.,Answer v2 (corrected)');
    expect(leftovers(folder)).toEqual([]);
    expect(fs.readdirSync(path.join(folder, '01. Archive'))).toHaveLength(2);   // both versions replaced are kept, dated
  }, 60_000);

  it('says it saved, and records what it wrote, when this PC\'s own scratch folder for the update can\'t be removed', async () => {
    const { folder, store, dealId, q5 } = await setup();
    await store.dispatch(SetResponse, { dealId, questionId: q5.id, response: 'Answer v1' });
    const rm = fs.rmSync; vi.spyOn(fs, 'rmSync').mockImplementation(((f: fs.PathLike, o?: fs.RmOptions) => { if (path.basename(String(f)).startsWith('punchlist-qalog-') && !String(f).startsWith(folder)) throw busy(); return rm(f, o); }) as typeof fs.rmSync);
    const r = await exportQaLog(store, dealId);
    expect(r.ok && r.value.status).toBe('written');
    expect(row(folder, 5)).toBe('5,Question 5: please confirm item 5.,Answer v1');
    expect(logOf(store, dealId)!.last!.sent![q5.id]).toMatchObject({ response: 'Answer v1' });
  }, 60_000);

  it('never takes away another PC\'s new version not yet in place, another log\'s file, or a team file named alike', async () => {
    const { folder, store, dealId, q5 } = await setup();
    const fresh = path.join(folder, temporaryFixtureName(FILE, '0a1b2c3d'));
    fs.writeFileSync(fresh, 'another PC, saving this moment');
    await store.dispatch(SetResponse, { dealId, questionId: q5.id, response: 'Answer v1' });
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value.status).toBe('written');
    expect(fs.existsSync(fresh)).toBe(true);
    // however old: another PC's new version is in no version of the log; nor is another log's file or a team file named alike
    const other = path.join(folder, temporaryFixtureName('Other log.xlsx', '0a1b2c3d'));
    const theirs = path.join(folder, '~Proseware Q&A log notes.old');
    const dated = path.join(folder, '~Proseware Q&A log 20261117.tmp');
    const workbook = path.join(folder, temporaryFixtureName(FILE.replace(/\.xlsx$/, '.csv'), '0a1b2c3e'));
    for (const f of [other, theirs, dated, workbook]) fs.writeFileSync(f, 'not ours');
    await store.dispatch(SetResponse, { dealId, questionId: q5.id, response: 'Answer v2' });
    later();
    const again = await exportQaLog(store, dealId); expect(again.ok && again.value.status).toBe('written');
    expect([fresh, other, theirs, dated, workbook].map((f) => fs.existsSync(f)))
      .toEqual([true, true, true, true, true]);
  }, 60_000);
});

describe('a Q&A log update while responses are typed in the app (#40)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('100 lender edits and 10 app edits made during the update: 10 in two versions, 90 taken in', async () => {
    const { folder, store, dealId } = await setup();
    const byN = new Map(dealQuestions(store.get(), dealId).map((q) => [q.n, q]));
    const answer = (n: number, response: string) =>
      store.dispatch(SetResponse, { dealId, questionId: byN.get(n)!.id, response });
    for (let i = 1; i <= 100; i++) await answer(i, `Answer ${i}`);
    expect((await exportQaLog(store, dealId)).ok).toBe(true);
    // the lender revises rows 1-100 in the file
    const grid = gridOf(fs.readFileSync(path.join(folder, FILE)));
    for (let i = 1; i <= 100; i++) grid[i] = [String(i), text(i), `Answer ${i} revised by the lender`];
    fs.writeFileSync(path.join(folder, FILE), xlsxOf(grid));
    later();
    await answer(500, 'Answer 500');                                                     // so it saves
    const save = store.services.qaLogs!.save;
    store.services.qaLogs!.save = async (req) => {
      const saved = await save(req);
      for (let i = 1; i <= 10; i++) {
        const typed = await answer(i, `App answer ${i}`);
        expect(typed.ok).toBe(true);
      }
      return saved;
    };
    const r = await exportQaLog(store, dealId);
    const ten = Array.from({ length: 10 }, (_, k) => k + 1);
    expect(r.ok && r.value).toMatchObject({ status: 'written', changed: 90, kept: ten });
    const response = (i: number) => store.get().questions[byN.get(i)!.id].response;
    expect([response(1), response(10), response(11), response(100)]).toEqual([
      'App answer 1', 'App answer 10', 'Answer 11 revised by the lender', 'Answer 100 revised by the lender',
    ]);
    expect([row(folder, 1), row(folder, 10)])
      .toEqual([`1,${text(1)},Answer 1 revised by the lender`, `10,${text(10)},Answer 10 revised by the lender`]);
  }, 120_000);
});
