// An edit saved over the Q&A log just before an update moved it aside, kept in the log's folder because a new file took the
// log's name and the archive refused a copy of it, comes back at the next update: cell by cell, against the
// archive copy it was made from. The app's Store on the real log files code, a CSV log of 2,000 questions in a temporary
// folder; the other people's saves and the archive's refusal are stand-ins.
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
import { KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs } from '../../src/app/commands/qaLogs';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, FIRM } from '../../src/app/state';
import { keepImportedLog, exportQaLog } from '../../src/app/qaLog';
import type { KeptAsk } from '../../src/domain/keptMerge';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { asideFixtureName } from '../backend/qaLogWorkingFiles';
import { ok } from '../../src/domain/result';

const COMMANDS = [
  CreateDeal, ImportQuestions, SetResponse, KeepQaLog, SetQaLogFolder, RecordQaLogExport, RestoreQaLogs,
];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

const N = 2000; const FILE = 'Proseware Q&A log.csv'; const columns = ['No.', 'Question', 'Response', 'Team notes'];
const text = (i: number) => `Question ${i}: please confirm item ${i}.`;
const ARC = '01. Archive';
let answers = 0;

async function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-kept-'));
  const rows = Array.from({ length: N }, (_, k) => [String(k + 1), text(k + 1), '', '']);
  fs.writeFileSync(path.join(folder, FILE), [columns, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n');
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: async () => ok([]), pathFor: null, save: async () => ok('saved' as const) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), qaLogs: nodeQaLogs({}), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId);
  // Only the complete log is setup; every save and race below still uses the real files.
  const imported = prepareImport(rows, suggestMapping(columns)).rows.map((row) => ({ ...row, askedBy: FIRM }));
  const seeded = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: imported }, { quiet: true });
  expect(seeded.ok).toBe(true);
  expect((await keepImportedLog(store, dealId, { path: path.join(folder, FILE), sheet: 'Sheet1', headerRow: 1, mapping: suggestMapping(columns), make: true, rows })).ok).toBe(true);
  const q = (i: number) => dealQuestions(store.get(), dealId).find((x) => x.text === text(i))!;
  return { folder, store, dealId, q };
}
/** the log's lines, as they are in the file (line 0 is the headings) */
const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\r\n');
/** a version of the log with some lines set: by line number, the line's cells */
const edited = (s: string, set: Record<number, string[]>, add: string[][] = []) => {
  const l = s.split('\r\n'); for (const [i, cells] of Object.entries(set)) l[+i] = cells.join(',');
  if (add.length) l.splice(l.length - 1, 0, ...add.map((r) => r.join(',')));
  return l.join('\r\n');
};
const kept = (folder: string) => fs.readdirSync(folder).filter((n) => /\.[0-9a-f]{8}\.(old|kept|left)$/.test(n));
const archive = (folder: string) => fs.readdirSync(path.join(folder, ARC)).sort().map((n) => ({ n, s: fs.readFileSync(path.join(folder, ARC, n), 'utf8') }));
/** the folder's clock moves on two minutes: every file made from now on reads as made then, so the ones before are old */
const later = () => {
  const wait = Date.now() + 30; while (Date.now() < wait) { /* so the files before are 20 ms older at least */ }
  const t0 = Date.now() - 10; const st = fs.statSync;   // 10 ms: a file system's clock may lag a little behind
  vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs >= t0 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
};

/**
 * An update whose save is raced: as it moves the log aside, sroe's save lands on the file moved (`sroe`, from the
 * log as it was) and someone makes a new file at the log's name (`lroe`, from the same version); the archive refuses sroe's
 * "saved meanwhile" copy (EACCES). Their edit is then only in the folder, under the save's working name.
 */
async function raced(folder: string, store: Store, dealId: string, sroe: (s: string) => string, lroe: (s: string) => string) {
  // the app has something to write, so the update saves: an answer to the last question
  const last = dealQuestions(store.get(), dealId).find((x) => x.text === text(N))!;
  await store.dispatch(SetResponse, { dealId, questionId: last.id, response: `App answer ${++answers}` });
  const log = path.join(folder, FILE); const real = fs.renameSync; const write = fs.writeFileSync; let n = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
    const was = String(a) === log && ++n === 1 ? fs.readFileSync(log, 'utf8') : null; real(a, b);
    if (was !== null) { write(b, sroe(was)); write(log, lroe(was)); }
  }) as typeof fs.renameSync);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => {
    if (String(p).includes('saved meanwhile')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return write(p, data, o);
  }) as typeof fs.writeFileSync);
  const r = await exportQaLog(store, dealId); vi.restoreAllMocks();
  expect(r.ok && r.value).toEqual({ status: 'later' });
  expect(kept(folder)).toHaveLength(1);
}

describe('an edit kept aside in the log\'s folder', () => {
  afterEach(() => vi.restoreAllMocks());

  it('comes back at the next update: their cells and rows go in, a cell both changed keeps the log\'s and is reported, and their version goes to the archive', async () => {
    const { folder, store, dealId, q } = await setup();
    await store.dispatch(SetResponse, { dealId, questionId: q(5).id, response: 'Answer from the app' });
    const sroe = (s: string) => edited(s, { 7: ['7', text(7), 'sroe: answered by phone', ''], 9: ['9', text(9), 'sroe on 9', ''], 1500: ['1500', text(1500), '', 'sroe: chase'] }, [['2001', 'sroe\'s own question: any liens?', '', '']]);
    const lroe = (s: string) => edited(s, { 9: ['9', text(9), 'ldoe on 9', ''], 11: ['11', text(11), 'ldoe on 11', ''] });
    await raced(folder, store, dealId, sroe, lroe);
    const samsBytes = fs.readFileSync(path.join(folder, kept(folder)[0]), 'utf8');

    later();
    const r = await exportQaLog(store, dealId);
    expect(r.ok && r.value).toMatchObject({ status: 'written', answered: 2, kept: [], clashed: [9], unmerged: 0 });   // 5 and the last question   // 9: sroe and ldoe each wrote their own, kept as in the file (not in two versions: the app didn't change it)
    const l = lines(path.join(folder, FILE));
    expect([l[5], l[7], l[9], l[11], l[1500]]).toEqual([
      `5,${text(5)},Answer from the app,`, `7,${text(7)},sroe: answered by phone,`, `9,${text(9)},ldoe on 9,`, `11,${text(11)},ldoe on 11,`, `1500,${text(1500)},,sroe: chase`,
    ]);
    expect(l.filter((x) => x.includes('sroe\'s own question'))).toEqual(['2001,sroe\'s own question: any liens?,,']);   // once, below the last row
    expect(l.indexOf('2001,sroe\'s own question: any liens?,,')).toBe(N + 1);
    expect(kept(folder)).toEqual([]);
    expect(archive(folder).filter((a) => a.n.includes('saved meanwhile')).map((a) => a.s)).toEqual([samsBytes]);   // all of sroe's version, sroe on 9 too
  }, 120_000);

  it('a cell the log already has as they wrote it, or a row it already has, is not written twice', async () => {
    const { folder, store, dealId } = await setup();
    const sroe = (s: string) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }, [['2001', 'sroe\'s own question', '', '']]);
    await raced(folder, store, dealId, sroe, sroe);   // the new file is sroe's again (saved twice)
    later();
    const r = await exportQaLog(store, dealId);
    expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [] });
    const l = lines(path.join(folder, FILE));
    expect(l[3]).toBe(`3,${text(3)},sroe on 3,`); expect(l.filter((x) => x.includes('sroe\'s own question'))).toHaveLength(1);
    expect(kept(folder)).toEqual([]);
  }, 120_000);

  it('is left alone while under a minute old by the folder\'s clock: another PC may be saving it this moment', async () => {
    const { folder, store, dealId, q } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s + 'x,y,,\r\n');
    await store.dispatch(SetResponse, { dealId, questionId: q(4).id, response: 'Answer 4' });
    const r = await exportQaLog(store, dealId);
    expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [] });
    expect(lines(path.join(folder, FILE))[3]).toBe(`3,${text(3)},,`);
    expect(kept(folder)).toHaveLength(1);
  }, 120_000);

  it('with no archive copy it was made from, goes to the archive as it is, and nothing of it is written into the log', async () => {
    const { folder, store, dealId } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    for (const a of archive(folder)) fs.rmSync(path.join(folder, ARC, a.n));   // someone tidied the archive
    const samsBytes = fs.readFileSync(path.join(folder, kept(folder)[0]), 'utf8');
    later();
    const r = await exportQaLog(store, dealId);
    expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [], unmerged: 1 });   // the notice says so
    expect(lines(path.join(folder, FILE))[3]).toBe(`3,${text(3)},,`);
    expect(kept(folder)).toEqual([]); expect(archive(folder).filter((a) => a.n.includes('saved meanwhile')).map((a) => a.s)).toEqual([samsBytes]);
  }, 120_000);

  it('an edit to one of two rows that read alike goes where the person says, ' +
    'and closing the ask leaves the update for later', async () => {
    const { folder, store, dealId } = await setup(); const log = path.join(folder, FILE); const CAP = 'Provide the cap table.';
    fs.writeFileSync(log, edited(fs.readFileSync(log, 'utf8'), { 100: ['', CAP, '', ''], 900: ['', CAP, 'Draft from the data room', ''] }));   // asked twice, by nobody named
    await raced(folder, store, dealId, (s) => edited(s, { 900: ['', CAP, 'Final answer from sroe', ''] }), (s) => s);
    const before = fs.readFileSync(log, 'utf8'); later();
    let asked: KeptAsk[] = [];
    let r = await exportQaLog(store, dealId, async (ask) => { asked = ask; return null; });
    // nothing saved, nothing filed: asked again
    expect(r.ok && r.value).toEqual({ status: 'canceled' });
    expect(fs.readFileSync(log, 'utf8')).toBe(before);
    expect(kept(folder)).toHaveLength(1);
    expect(asked.map((a) => a.rows.map((x) => x.line))).toEqual([[101, 901]]);   // sheet lines, counted from 1
    r = await exportQaLog(store, dealId, async (ask) => ask.map((a) => a.rows.findIndex((x) => x.line === 901)));
    expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [], unmerged: 0 });
    const l = lines(log); expect([l[100], l[900]]).toEqual([`,${CAP},,`, `,${CAP},Final answer from sroe,`]);
    expect(kept(folder)).toEqual([]);
  }, 120_000);

  it('an edit to one of two rows that read alike, left out by the person, is filed and said so', async () => {
    const { folder, store, dealId } = await setup(); const log = path.join(folder, FILE); const CAP = 'Provide the cap table.';
    fs.writeFileSync(log, edited(fs.readFileSync(log, 'utf8'), { 100: ['', CAP, '', ''], 900: ['', CAP, 'Draft from the data room', ''] }));
    await raced(folder, store, dealId, (s) => edited(s, { 900: ['', CAP, 'Final answer from sroe', ''] }), (s) => s);
    later();
    const r = await exportQaLog(store, dealId, async (ask) => ask.map(() => -2));
    expect(r.ok && r.value).toMatchObject({ status: 'written', unmerged: 1 });          // the notice says not fully merged
    const l = lines(log); expect([l[100], l[900]]).toEqual([`,${CAP},,`, `,${CAP},Draft from the data room,`]);
    expect(kept(folder)).toEqual([]); expect(archive(folder).filter((a) => a.n.includes('saved meanwhile'))).toHaveLength(1);
  }, 120_000);

  it('filed unmerged when the update then can\'t be recorded, is still counted for the notice', async () => {
    const { folder, store, dealId } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    for (const a of archive(folder)) fs.rmSync(path.join(folder, ARC, a.n));   // no copy to merge against: filed as it is
    const last = dealQuestions(store.get(), dealId).find((x) => x.text === text(N))!;
    await store.dispatch(SetResponse, { dealId, questionId: last.id, response: 'App answer again' });   // something to write
    later();
    const real = store.dispatch.bind(store);
    vi.spyOn(store, 'dispatch').mockImplementation(((c: unknown, ...a: unknown[]) => (c === RecordQaLogExport ? Promise.resolve({ ok: false, error: { kind: 'failed', message: 'disk full' } }) : (real as (...x: unknown[]) => unknown)(c, ...a))) as never);
    const r = await exportQaLog(store, dealId);
    expect(r).toMatchObject({ ok: false, error: { message: 'disk full' }, unmerged: 1 });
    expect(kept(folder)).toEqual([]);                                                   // filed in the archive all the same
  }, 120_000);

  it('while the archive refuses it, stays in the folder but is never merged again: a cell someone changes back stays as they set it', async () => {
    const { folder, store, dealId, q } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    later();
    const write = fs.writeFileSync; const refuse = () => vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => {
      if (String(p).includes('saved meanwhile')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return write(p, data, o);
    }) as typeof fs.writeFileSync);
    refuse();
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', unmerged: 0 });
    const log = path.join(folder, FILE); expect(lines(log)[3]).toBe(`3,${text(3)},sroe on 3,`); expect(kept(folder)).toEqual([expect.stringMatching(/\.kept$/)]);
    write(log, fs.readFileSync(log, 'utf8').replace(`3,${text(3)},sroe on 3,`, `3,${text(3)},,`));   // ldoe clears sroe's answer in Excel
    await store.dispatch(SetResponse, { dealId, questionId: q(4).id, response: 'Answer 4' });
    const again = await exportQaLog(store, dealId); expect(again.ok && again.value).toMatchObject({ status: 'written', kept: [] });
    expect(lines(log)[3]).toBe(`3,${text(3)},,`); expect(kept(folder)).toHaveLength(1);
    vi.mocked(fs.writeFileSync).mockRestore();                                         // the archive takes it now
    const third = await exportQaLog(store, dealId); expect(third.ok && third.value).toMatchObject({ status: 'written', unmerged: 0 });   // it was merged in full
    expect(lines(log)[3]).toBe(`3,${text(3)},,`); expect(kept(folder)).toEqual([]);
    expect(archive(folder).filter((a) => a.n.includes('saved meanwhile')).map((a) => a.s.split('\r\n')[3])).toEqual([`3,${text(3)},sroe on 3,`]);
  }, 120_000);

  it('a change to a row the log took out is filed in the archive and the notice says so, at the update that files it', async () => {
    const { folder, store, dealId } = await setup();
    const sroe = (s: string) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''], 20: ['20', text(20), 'sroe on 20', ''] });
    const lroe = (s: string) => s.split('\r\n').filter((_, i) => i !== 20).join('\r\n');   // ldoe took row 20 out
    await raced(folder, store, dealId, sroe, lroe);
    later();
    const write = fs.writeFileSync; vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => {
      if (String(p).includes('saved meanwhile')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return write(p, data, o);
    }) as typeof fs.writeFileSync);
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', unmerged: 0 });   // not filed yet: it is still in the folder
    const log = path.join(folder, FILE); expect(lines(log)[3]).toBe(`3,${text(3)},sroe on 3,`); expect(kept(folder)).toEqual([expect.stringMatching(/\.left$/)]);
    vi.mocked(fs.writeFileSync).mockRestore();                                         // the archive takes it now
    const again = await exportQaLog(store, dealId); expect(again.ok && again.value).toMatchObject({ status: 'written', unmerged: 1 });
    expect(kept(folder)).toEqual([]); expect(archive(folder).filter((a) => a.n.includes('saved meanwhile')).map((a) => a.s.split('\r\n')[20])).toEqual([`20,${text(20)},sroe on 20,`]);
    expect(lines(log).some((x) => x.includes('sroe on 20'))).toBe(false);
  }, 120_000);

  it('is merged against the archive copy made before the move, not one another PC made a moment after it', async () => {
    const { folder, store, dealId } = await setup(); let lroe = '';
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => (lroe = edited(s, { 11: ['11', text(11), 'ldoe on 11', ''] })));
    const wait = Date.now() + 30; while (Date.now() < wait) { /* a moment after: a copy made in the same tick of the file system's clock can't be told apart */ }
    fs.writeFileSync(path.join(folder, ARC, 'Proseware Q&A log 2026-11-17 1001.csv'), lroe);   // another PC's update, archiving ldoe's file
    later();
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [] });
    const l = lines(path.join(folder, FILE)); expect([l[3], l[11]]).toEqual([`3,${text(3)},sroe on 3,`, `11,${text(11)},ldoe on 11,`]);
  }, 120_000);

  it('when another PC\'s copy was made in the same tick of the folder\'s clock as theirs, is not merged against either: it is filed, and said so', async () => {
    const { folder, store, dealId } = await setup(); let lroe = '';
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => (lroe = edited(s, { 11: ['11', text(11), 'ldoe on 11', ''] })));
    fs.writeFileSync(path.join(folder, ARC, 'Proseware Q&A log 2026-11-17 1001.csv'), lroe);   // another PC's update, archiving ldoe's file
    const t = fs.statSync(path.join(folder, ARC, 'Proseware Q&A log 2026-11-17 1001.csv')).ctimeMs; const st = fs.statSync;   // a coarse clock: every file made so far, made at once
    vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs <= t ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: t }) : s; }) as never);
    const real = vi.mocked(fs.statSync).getMockImplementation()!; const t0 = Date.now() + 20; while (Date.now() < t0) { /* the next files are later */ }
    vi.mocked(fs.statSync).mockImplementation(((f: fs.PathLike, o?: never) => { const s = real(f, o) as fs.Stats; return s && s.ctimeMs > t ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [], unmerged: 1 });
    // ldoe's answer stays
    const l = lines(path.join(folder, FILE));
    expect([l[3], l[11]]).toEqual([`3,${text(3)},,`, `11,${text(11)},ldoe on 11,`]);
    expect(kept(folder)).toEqual([]);
  }, 120_000);

  it('a copy of another log that shares the archive, made in the same tick, is never taken for the version they edited', async () => {
    const { folder, store, dealId } = await setup(); let lroe = '';
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => (lroe = edited(s, { 11: ['11', text(11), 'ldoe on 11', ''] })));
    fs.writeFileSync(path.join(folder, ARC, 'Proseware Q&A log v2 2026-11-17 1001.csv'), lroe);   // another PC's update, archiving ldoe's file
    const t = fs.statSync(path.join(folder, ARC, 'Proseware Q&A log v2 2026-11-17 1001.csv')).ctimeMs; const st = fs.statSync;   // a coarse clock: every file made so far, made at once
    vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs <= t ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: t }) : s; }) as never);
    const real = vi.mocked(fs.statSync).getMockImplementation()!; const t0 = Date.now() + 20; while (Date.now() < t0) { /* the next files are later */ }
    vi.mocked(fs.statSync).mockImplementation(((f: fs.PathLike, o?: never) => { const s = real(f, o) as fs.Stats; return s && s.ctimeMs > t ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', kept: [], unmerged: 0 });
    const l = lines(path.join(folder, FILE)); expect([l[3], l[11]]).toEqual([`3,${text(3)},sroe on 3,`, `11,${text(11)},ldoe on 11,`]);
    expect(kept(folder)).toEqual([]);
  }, 120_000);

  it('never holds the update up when the log refuses its steps: the update is made without them, and it goes to the archive as it is', async () => {
    const { folder, store, dealId, q } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    later();
    await store.dispatch(SetResponse, { dealId, questionId: q(4).id, response: 'Answer 4' });
    const files = store.services.qaLogs!; const save = files.save.bind(files); let saves = 0;
    vi.spyOn(files, 'save').mockImplementation(async (req) => { saves++; return (req.steps.some((s) => s.kind === 'cell' && s.value === 'sroe on 3') ? { ok: false, error: { kind: 'rejected', message: 'the table ends in a totals row' } } : save(req)) as never; });
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value).toMatchObject({ status: 'written', answered: 2, unmerged: 1 });
    const l = lines(path.join(folder, FILE)); expect([l[3], l[4]]).toEqual([`3,${text(3)},,`, `4,${text(4)},Answer 4,`]);
    expect(kept(folder)).toEqual([]); expect(archive(folder).filter((a) => a.n.includes('saved meanwhile')).map((a) => a.s.split('\r\n')[3])).toEqual([`3,${text(3)},sroe on 3,`]);
    await store.dispatch(SetResponse, { dealId, questionId: q(6).id, response: 'Answer 6' }); saves = 0;
    expect((await exportQaLog(store, dealId)).ok).toBe(true); expect(saves).toBe(1);   // not tried again at every update
  }, 120_000);

  it('when the update can\'t be saved at all, touches nothing: it comes in at the next', async () => {
    const { folder, store, dealId } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    later();
    const files = store.services.qaLogs!; const save = files.save.bind(files); let down = true;
    vi.spyOn(files, 'save').mockImplementation(async (req) => (down ? { ok: false, error: { kind: 'failed', message: 'the share is gone' } } : save(req)) as never);
    expect((await exportQaLog(store, dealId)).ok).toBe(false); expect(kept(folder)).toEqual([expect.stringMatching(/\.old$/)]);
    down = false;
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value.status).toBe('written');
    expect(lines(path.join(folder, FILE))[3]).toBe(`3,${text(3)},sroe on 3,`); expect(kept(folder)).toEqual([]);
  }, 120_000);

  it('a row they added and saved again with a change is not added twice: the log\'s stays', async () => {
    const { folder, store, dealId } = await setup();
    const sroe = (s: string) => edited(s, {}, [['2001', 'sroe new question: any liens?', '', 'Open']]);
    await raced(folder, store, dealId, sroe, (s) => edited(s, {}, [['2001', 'sroe new question: any liens?', '', 'Chased Nov 17']]));
    later();
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value.status).toBe('written');
    expect(lines(path.join(folder, FILE)).filter((x) => x.includes('sroe new question'))).toEqual(['2001,sroe new question: any liens?,,Chased Nov 17']);
  }, 120_000);

  it('an edit of another log of the same name (an .xlsx beside this .csv) is left alone', async () => {
    const { folder, store, dealId, q } = await setup();
    const other = path.join(folder, asideFixtureName(FILE.replace(/\.csv$/, '.xlsx')));
    fs.writeFileSync(other, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    later();
    await store.dispatch(SetResponse, { dealId, questionId: q(4).id, response: 'Answer 4' });
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value.status).toBe('written');
    expect(fs.existsSync(other)).toBe(true); expect(archive(folder).filter((a) => a.n.includes('saved meanwhile'))).toEqual([]);
  }, 120_000);
  it('held for a moment as it is read (a sync client, say), is left for the next update', async () => {
    const { folder, store, dealId, q } = await setup();
    await raced(folder, store, dealId, (s) => edited(s, { 3: ['3', text(3), 'sroe on 3', ''] }), (s) => s);
    later();
    const copy = fs.copyFileSync; let once = true;
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike, m?: number) => { if (once && String(a).endsWith('.old')) { once = false; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return copy(a, b, m); }) as typeof fs.copyFileSync);
    await store.dispatch(SetResponse, { dealId, questionId: q(4).id, response: 'Answer 4' });
    expect((await exportQaLog(store, dealId)).ok).toBe(true); expect(kept(folder)).toHaveLength(1);
    const r = await exportQaLog(store, dealId); expect(r.ok && r.value.status).toBe('written');
    expect(lines(path.join(folder, FILE))[3]).toBe(`3,${text(3)},sroe on 3,`); expect(kept(folder)).toEqual([]);
  }, 120_000);
});
