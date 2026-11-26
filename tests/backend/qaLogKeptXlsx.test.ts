// An edit kept aside beside an .xlsx, .xls or .ods Q&A log, read and written through LibreOffice as the app does: their cells come
// back into the workbook, a formula is never written over, and their version goes to the archive. 2,000 questions.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter } from '../../src/backend/convert';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { keptEdits } from '../../src/backend/qaLogFolder';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { exportDocument } from '../../src/domain/sheets';
import { readZip, partText, setPart, writeZip } from '../../src/backend/zipParts';
import { hasOffice as has, soffice } from './officePrerequisites';
import { cachedWorkbook } from './workbookCache';
import { asideFixtureName } from './qaLogWorkingFiles';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-test-lo-')) });
const N = 2000; const FILE = 'Proseware Q&A log.xlsx'; const SHEET = 'Q&A log';
const q = (i: number) => `Question ${i}: please confirm item ${i}.`;
/** the folder's clock moves on two minutes: every file made from now on reads as made then, so the ones before are old */
const later = () => {
  const wait = Date.now() + 30; while (Date.now() < wait) { /* so the files before are 20 ms older at least */ }
  const t0 = Date.now() - 10; const st = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs >= t0 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
};
/** the workbook with a formula in the Notes cell of `row` (counted from 0), as a team might total or look something up */
const withFormula = (bytes: Uint8Array, row: number) => {
  const z = readZip(bytes); const part = 'xl/worksheets/sheet1.xml'; const xml = partText(z, part)!;
  const ref = `D${row + 1}`; const out = xml.replace(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), `<c r="${ref}"><f>LEN(B${row + 1})</f><v>${q(row).length}</v></c>`);
  expect(out).not.toBe(xml); setPart(z, part, out); return writeZip(z);
};

// related cases share each workbook's conversion
const workbook = cachedWorkbook(lo);
describe.skipIf(!has)('an edit kept aside beside a workbook log', () => {
  afterEach(() => vi.restoreAllMocks());
  it('comes back into the workbook, a formula stays as it is, and their version goes to the archive', async () => {
    const rows: (string | number)[][] = [['No.', 'Question', 'Response', 'Notes'], ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), '', ''])];
    const made = await workbook(exportDocument(SHEET, rows));
    const base = withFormula(made, 12);
    const sroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 7, col: 2, value: 'sroe on 7' }, { kind: 'cell', row: 1500, col: 3, value: 'sroe: chase' }]);
    const lroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 9, col: 2, value: 'ldoe on 9' }]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    // as the save that kept it left them: the version it read, dated in the archive, then sroe's moved aside, and ldoe's new file
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), lroe);
    later();
    const logs = nodeQaLogs({ convert: lo });
    const r = await logs.read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 1 } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept).toMatchObject({ files: [{ name: asideFixtureName(FILE, { base }) }], clashes: [] });
    expect(r.value.kept!.files[0].left).toBeUndefined();                              // the formula that was there is not theirs
    expect(r.value.kept!.steps).toEqual([{ kind: 'cell', row: 7, col: 2, value: 'sroe on 7' }, { kind: 'cell', row: 1500, col: 3, value: 'sroe: chase' }]);
    const s = await logs.save({ folder, file: FILE, sheet: SHEET, steps: r.value.kept!.steps, stamp: r.value.stamp });
    expect(s.ok && s.value.status).toBe('written');
    await logs.settle!({ folder, file: FILE, kept: r.value.kept!.files });
    const now = await logs.read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1 }); if (!now.ok) throw new Error(now.error.message);
    expect([now.value.rows[6][2], now.value.rows[8][2], now.value.rows[1499][3]]).toEqual(['sroe on 7', 'ldoe on 9', 'sroe: chase']);
    expect(partText(readZip(new Uint8Array(fs.readFileSync(path.join(folder, FILE)))), 'xl/worksheets/sheet1.xml')).toContain('<f>LEN(B13)</f>');
    expect(fs.readdirSync(folder).filter((n) => n.endsWith('.old'))).toEqual([]);
    expect(fs.readdirSync(path.join(folder, '01. Archive')).filter((n) => n.includes('saved meanwhile'))).toHaveLength(1);
  }, 240_000);

  it('a change of theirs to a formula cell is reported, not written, and the formula stays', async () => {
    const rows: (string | number)[][] = [['No.', 'Question', 'Response', 'Notes'], ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), '', ''])];
    const base = withFormula(await workbook(exportDocument(SHEET, rows)), 12);
    // sroe typed over the formula
    const z = readZip(base); const part = 'xl/worksheets/sheet1.xml'; setPart(z, part, partText(z, part)!.replace(/<c r="D13"><f>[^<]*<\/f><v>[^<]*<\/v><\/c>/, '<c r="D13" t="inlineStr"><is><t>sroe typed over it</t></is></c>')); const sroe = writeZip(z);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), base);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 1, n: 0 } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept).toMatchObject({ steps: [], clashes: [11] });
  }, 240_000);
  it('a formula they typed is not written, and the edit counts as not fully merged', async () => {
    const rows: (string | number)[][] = [['No.', 'Question', 'Response', 'Notes'], ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), '', ''])];
    const base = withFormula(await workbook(exportDocument(SHEET, rows)), 12);
    // sroe put =LEN(B21) in D21
    const sroe = withFormula(base, 20);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), base);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 1 } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept).toMatchObject({
      steps: [],
      clashes: [],
      files: [{ name: asideFixtureName(FILE, { base }), left: true }],
    });
  }, 240_000);
  it('with no number column, an answer for one party never goes into another party\'s row that reads alike', async () => {
    const H = ['Workstream', 'Priority', 'Submitted by', 'Question', 'Status', 'Response'];
    const rows: (string | number)[][] = [H, ...Array.from({ length: N }, (_, k) => ['Finance', 'High', 'Lender A', q(k + 1), 'Open', ''])];
    rows[1201] = ['Finance', 'High', 'Lender B', q(1200), 'Open', ''];                 // Lender B asks what Lender A asks in row 1200
    const base = await workbook(exportDocument(SHEET, rows));
    const sroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 1200, col: 5, value: 'sroe: for Lender A only' }]);
    const lroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 1200, col: 3, value: 'ldoe put another question here' }]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), lroe);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 3, by: 2 } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept).toMatchObject({ steps: [], clashes: [] }); expect(r.value.kept!.ask).toHaveLength(1);   // never written unasked: the person says where it goes
  }, 240_000);
  // a row naming no sender matches any sender, the same sender first (docs/decisions.md)
  for (const [name, change] of [
    ['the log took out the row they answered, and another with no submitter asks it', (rows: string[][]) => { rows[1500] = ['Finance', 'High', '', q(700), 'Open', '']; return { base: rows, lroe: rows.filter((_, i) => i !== 700) }; }],
    ['the app reworded the row they answered, and a row with no submitter asks the old words', (rows: string[][]) => ({ base: rows, lroe: [...rows.map((r, i) => (i === 700 ? [...r.slice(0, 3), 'Question 700, as the app now words it', ...r.slice(4)] : r)), ['Finance', 'High', '', q(700), 'Open', '']] })],
  ] as const) it(`with no number column, a row with no submitter takes Lender A's answer only in its place: ${name}`,
    async () => {
    const H = ['Workstream', 'Priority', 'Submitted by', 'Question', 'Status', 'Response'];
    const { base: b, lroe: l } = change([H, ...Array.from({ length: N }, (_, k) => ['Finance', 'High', 'Lender A', q(k + 1), 'Open', ''])]);
    const base = await workbook(exportDocument(SHEET, b)); const lroe = await workbook(exportDocument(SHEET, l));
    const sroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 700, col: 5, value: 'sroe: for Lender A only' }]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), lroe);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 3, by: 2 } });
    if (!r.ok) throw new Error(r.error.message);
    const kept = r.value.kept!;
    expect(kept.clashes).toEqual([]);
    // the row taken out among two that ask it is asked about: the one with no submitter is another row of the version
    // they edited; where the app reworded the row they answered, the row with no submitter asking its words is it
    if (name.includes('took out')) {
      expect(kept.steps).toEqual([]);
      expect(kept.ask).toHaveLength(1);
    } else {
      expect(kept.steps).toEqual([{ kind: 'cell', row: N + 1, col: 5, value: 'sroe: for Lender A only' }]);
      expect(kept.files[0].left).toBeUndefined();
    }
  }, 240_000);
  it('a change to one of two rows that read alike, with no number and no submitter, ' +
    'goes in the row the person picks', async () => {
    const H = ['Question', 'Submitted by', 'Workstream', 'Status', 'Response']; const CAP = 'Provide the cap table.';
    const rows: string[][] = [H, ...Array.from({ length: N }, (_, k) => [q(k + 1), k % 2 ? 'Lender A' : 'Lender B', 'Legal', 'Open', ''])];
    rows[100] = [CAP, '', 'Legal', 'Open', '']; rows[900] = [CAP, '', 'Legal', 'Open', 'Draft from the data room'];
    const base = await workbook(exportDocument(SHEET, rows));
    const sroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 900, col: 4, value: 'Final answer, sroe' }]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), base);
    later();
    const logs = nodeQaLogs({ convert: lo });
    const r = await logs.read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 0, by: 1 } });
    if (!r.ok) throw new Error(r.error.message);
    const k = r.value.kept!; expect(k.steps).toEqual([]); expect(k.files[0].left).toBeUndefined();   // nothing written unasked
    expect(k.ask?.map((a) => a.rows.map((x) => x.line))).toEqual([[101, 901]]);
    const at = k.ask![0].rows.find((x) => x.line === 901)!;
    const s = await logs.save({ folder, file: FILE, sheet: SHEET, steps: at.steps, stamp: r.value.stamp }); expect(s.ok && s.value.status).toBe('written');
    const now = await logs.read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1 }); if (!now.ok) throw new Error(now.error.message);
    expect([now.value.rows[99][4], now.value.rows[899][4]]).toEqual(['', 'Final answer, sroe']);
  }, 240_000);
  it('a party asks it twice and the log took out the row they answered: ' +
    'never written into the other unasked', async () => {
    const H = ['No.', 'Question', 'Submitted by', 'Workstream', 'Status', 'Response'];
    const rows: (string | number)[][] = [H, ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), 'Lender A', 'Legal', 'Open', ''])];
    rows[700] = ['', 'List material contracts.', 'Lender B', 'Legal', 'Open', '']; rows[1500] = [1500, 'List material contracts.', 'Lender B', 'Finance', 'Open', ''];
    const base = await workbook(exportDocument(SHEET, rows));
    const lroe = await workbook(exportDocument(SHEET, rows.filter((_, i) => i !== 700)));
    const sroe = editXlsx(base, SHEET, [{ kind: 'cell', row: 700, col: 5, value: 'sroe: Legal contracts list in 4.2' }]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), lroe);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 1, n: 0, by: 2 } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept!.steps).toEqual([]); expect(r.value.kept!.ask?.map((a) => [a.question, a.rows.map((x) => x.line)])).toEqual([['List material contracts.', [1500]]]);
  }, 240_000);
  for (const ext of ['.ods', '.xls']) it(`comes back into a ${ext} log, written through LibreOffice`, async () => {
    const rows: (string | number)[][] = [['No.', 'Question', 'Response', 'Notes'], ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), '', ''])];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-conv-'));
    fs.writeFileSync(path.join(work, 'log.xlsx'), await workbook(exportDocument(SHEET, rows)));
    execFileSync(soffice, [`-env:UserInstallation=file://${work}/profile`, '--headless', '--convert-to', ext.slice(1), '--outdir', work, path.join(work, 'log.xlsx')], { stdio: 'ignore' });
    const baseFile = path.join(work, `log${ext}`); const base = fs.readFileSync(baseFile);
    const sroe = await lo.edit!(baseFile, SHEET, [{ kind: 'cell', row: 7, col: 2, value: 'sroe on 7' }, { kind: 'cell', row: 9, col: 2, value: 'sroe on 9' }]);
    const lroe = await lo.edit!(baseFile, SHEET, [{ kind: 'cell', row: 9, col: 2, value: 'ldoe on 9' }]);
    const file = `Proseware Q&A log${ext}`;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-conv-')); fs.mkdirSync(path.join(folder, 'Archive'));
    fs.writeFileSync(path.join(folder, 'Archive', `Proseware Q&A log 2026-11-17 1000${ext}`), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(file, { base })), sroe);
    fs.writeFileSync(path.join(folder, file), lroe);
    later();
    const logs = nodeQaLogs({ convert: lo });
    const r = await logs.read({ folder, file }, { sheet: SHEET, headerRow: 1, kept: { text: 1 } }); if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept).toMatchObject({ steps: [{ kind: 'cell', row: 7, col: 2, value: 'sroe on 7' }], clashes: [8] });
    const s = await logs.save({ folder, file, sheet: SHEET, steps: r.value.kept!.steps, stamp: r.value.stamp }); expect(s.ok && s.value.status).toBe('written');
    await logs.settle!({ folder, file, kept: r.value.kept!.files });
    const now = await logs.read({ folder, file }, { sheet: SHEET, headerRow: 1 }); if (!now.ok) throw new Error(now.error.message);
    expect([now.value.rows[6][2], now.value.rows[8][2]]).toEqual(['sroe on 7', 'ldoe on 9']);
    expect(fs.readdirSync(folder).filter((n) => n.endsWith('.old'))).toEqual([]);
  }, 240_000);
  // a formula the team keeps (here the length of each question) gives another value where they reworded one
  for (const ext of ['.ods', '.xls']) it(`never writes over a formula in a ${ext} log, nor takes a formula's new value for their change`, async () => {
    const rows: (string | number)[][] = [['No.', 'Question', 'Response', 'Notes'], ...Array.from({ length: N }, (_, k) => [k + 1, q(k + 1), '', ''])];
    let x = await workbook(exportDocument(SHEET, rows)); for (const r of [7, 8, 9]) x = withFormula(x, r);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-conv-')); fs.writeFileSync(path.join(work, 'log.xlsx'), x);
    execFileSync(soffice, [`-env:UserInstallation=file://${work}/profile`, '--headless', '--convert-to', ext.slice(1), '--outdir', work, path.join(work, 'log.xlsx')], { stdio: 'ignore' });
    const baseFile = path.join(work, `log${ext}`); const base = fs.readFileSync(baseFile);
    const sroe = await lo.edit!(baseFile, SHEET, [{ kind: 'cell', row: 7, col: 1, value: 'Question 7, reworded by sroe' }, { kind: 'cell', row: 7, col: 2, value: 'sroe on 7' }]);
    const file = `Proseware Q&A log${ext}`; const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-conv-')); fs.mkdirSync(path.join(folder, 'Archive'));
    fs.writeFileSync(path.join(folder, 'Archive', `Proseware Q&A log 2026-11-17 1000${ext}`), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(file, { base })), sroe);
    fs.writeFileSync(path.join(folder, file), base);
    later();
    const logs = nodeQaLogs({ convert: lo });
    const r = await logs.read({ folder, file }, { sheet: SHEET, headerRow: 1, kept: { text: 1, n: 0 } }); if (!r.ok) throw new Error(r.error.message);
    // a reworded row is not lined up by its place: the person places it, and its steps never take D8
    const kept = r.value.kept!;
    expect(kept.steps).toEqual([]);
    const offered = kept.ask?.[0].rows.map((x) => x.steps.map((s) => s.kind === 'cell' && [s.row, s.col]));
    expect(offered).toEqual([[[7, 1], [7, 2]]]);
    expect(kept.clashes).toEqual([]);                                     // D8's new value is the formula's, not theirs
  }, 240_000);
  // a question they put in mid-way moves every formula below it down a row
  it('a question they put in above formula rows makes no formula row below it a clash', async () => {
    const qs = Array.from({ length: N }, (_, k) => (k % 3 ? q(k + 1) : `${q(k + 1)} Longer.`));
    const book = async (list: [number, string][]) => {
      const logRows = [['No.', 'Question', 'Response', 'Notes'], ...list.map(([n, t]) => [n, t, '', ''])];
      const x = await workbook(exportDocument(SHEET, logRows));
      const z = readZip(x); const part = 'xl/worksheets/sheet1.xml';   // every Notes cell the length of its question, as a team might keep
      setPart(z, part, partText(z, part)!.replace(/<c r="D(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (m, n) => (+n > 1 ? `<c r="D${n}"><f>LEN(B${n})</f><v>${list[+n - 2][1].length}</v></c>` : m)));
      return writeZip(z);
    };
    const numbered = qs.map((t, k): [number, string] => [k + 1, t]); const base = await book(numbered); const sroe = await book([...numbered.slice(0, 3), [2001, 'sroe put this in: any liens?'], ...numbered.slice(3)]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-xlsx-')); fs.mkdirSync(path.join(folder, '01. Archive'));
    fs.writeFileSync(path.join(folder, '01. Archive', 'Proseware Q&A log 2026-11-17 1000.xlsx'), base);
    fs.writeFileSync(path.join(folder, asideFixtureName(FILE, { base })), sroe);
    fs.writeFileSync(path.join(folder, FILE), base);
    later();
    const r = await nodeQaLogs({ convert: lo }).read({ folder, file: FILE }, { sheet: SHEET, headerRow: 1, kept: { text: 1 } }); if (!r.ok) throw new Error(r.error.message);
    expect(r.value.kept!.clashes).toEqual([]);
    expect(r.value.kept!.steps.filter((s) => s.kind === 'cell').map((s) => s.kind === 'cell' && [s.col, s.value])).toEqual([[0, 2001], [1, 'sroe put this in: any liens?']]);   // the row, not its formula's value
  }, 240_000);
});

it('an .xlsx log’s kept edit beside an .ods log of the same name is the .xlsx log’s alone', () => {
  const workbook = fs.readFileSync(path.resolve('tests/fixtures/excel-1900.xlsx'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-kept-kind-'));
  const xlsx = 'Proseware Q&A log.xlsx';
  const ods = 'Proseware Q&A log.ods';
  const kept = asideFixtureName(xlsx);
  const damaged = asideFixtureName(xlsx, { attempt: '0a1b2c3e' });
  const recent = asideFixtureName(xlsx, { attempt: '0a1b2c3f' });
  const oldFiles = new Set([kept, damaged].map((name) => path.join(folder, name)));
  const statSync = fs.statSync;
  const spy = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: never) => {
    const stats = statSync(file, options) as fs.Stats;
    if (typeof file === 'string' && oldFiles.has(file)) stats.ctimeMs -= 120_000;
    return stats;
  }) as never);
  try {
    for (const log of [xlsx, ods]) fs.writeFileSync(path.join(folder, log), 'a log');
    fs.writeFileSync(path.join(folder, kept), workbook);
    fs.writeFileSync(path.join(folder, damaged), workbook.subarray(0, workbook.length - 30));
    fs.writeFileSync(path.join(folder, recent), workbook);
    expect(keptEdits(folder, ods)).toEqual([]);
    expect(keptEdits(folder, xlsx).map((edit) => edit.name).sort()).toEqual([kept, damaged]);
  } finally {
    spy.mockRestore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
