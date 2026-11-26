// @vitest-environment node
import { ownFilesId } from '../../src/domain/model';
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { sheetPart, type Sheet } from '../../src/domain/sheets';
import { nodeDocuments, docIdFor, hashBytes } from '../../src/backend/documents';
import { roomPath } from '../../src/backend/families';
import {
  holdFolder, libreOfficeConverter, shortExt, pdfPages, pdfLook, readChangeList, type Converter,
} from '../../src/backend/convert';
import type { Folder } from '../../src/backend/logRepository';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { pdfText } from '../fixtures/pdfText';
import { countWords, wordIndex } from '../../src/backend/wordIndex';
import { tokens, fold, topWords } from '../../src/backend/words';
import { StoreKeeper, fromStoreName } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import { nodeAi } from '../../src/backend/ai';
import { memRepo } from '../adapters/memRepo';
import { tokenHolder } from '../../src/backend/signInToken';
import { nodeSession, initialsOf } from '../../src/backend/session';
import { control } from '../../src/control';
import { hasImpress, hasOffice, soffice } from './officePrerequisites';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-docs-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string | Uint8Array) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const bytesOf = (x: string | Uint8Array) => (typeof x === 'string' ? new TextEncoder().encode(x) : x);
const idOf = (x: string | Uint8Array) => docIdFor(hashBytes(bytesOf(x)));
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, t++)).toISOString();
/** the clock moves on this many days, as if no PC had run meanwhile */
const later = (days: number) => { t += days * 24 * 60 * 60 * 1000; };

/** a real, small PDF with this many pages */
function pdf(text: string, pages = 1): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) { const stream = `BT /F1 12 Tf 72 720 Td (${text}, page ${i + 1}) Tj ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let out = '%PDF-1.4\n'; const at: number[] = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const FA = pdf('credit agreement', 3), SHA = pdf('shareholders agreement'), EYR = pdf('energy yield', 2);
const NOTES = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'Notes.docx')));           // a real Word file of three pages
/** a financial model: what the converter gives for it (a cover and a debt sheet), and stand-in bytes for the file */
const MODEL_SHEETS: Sheet[] = [{ name: 'Cover', grid: [['Cover']] }, { name: 'Debt', grid: Array.from({ length: 40 }, (_, r) => ['Line ' + (r + 1), String(r + 1), String((r + 1) * 1.5)]) }];
const MODEL = new TextEncoder().encode('PK\u0003\u0004 stands in for Model v12.xlsx');

/** a data room with five documents, two system files that are not documents, and an empty one */
function room() {
  const root = tmp(); const vdr = path.join(root, 'vdr');
  put(vdr, '01 Legal/Credit Agreement.pdf', FA); put(vdr, '01 Legal/Shareholders Agreement.pdf', SHA);
  put(vdr, '02 Technical/Energy Yield Report.pdf', EYR); put(vdr, '03 Financial/Model v12.xlsx', MODEL); put(vdr, '03 Financial/Notes.docx', NOTES);
  put(vdr, '03 Financial/~$Notes.docx', 'lock'); put(vdr, 'Thumbs.db', 'x'); put(vdr, '.sync', 'x'); put(vdr, 'empty.pdf', '');
  return { root, vdr };
}
/** a converter for tests: quick, and refuses a file called Locked, or one that holds only "locked" (an attached file is kept under its id, not its name) */
function standInConverter(id = 'stand-in') { const calls: string[] = []; const convert: Converter = Object.assign(async (file: string, outDir: string, outName: string, info?: { tracked?: number }) => { calls.push(path.basename(file)); if (/Locked/.test(file) || fs.readFileSync(file, 'utf8') === 'locked') throw new Error('password'); if (info && /Redline/.test(file)) info.tracked = 4; const out = path.join(outDir, outName); fs.writeFileSync(out, pdf(`converted from ${path.basename(file).replace(/[()]/g, '')}`, 3)); return out; }, { id,
  // the model's sheets, as LibreOffice would read them; any other spreadsheet can't be read
  sheets: async (file: string) => { if (Buffer.from(fs.readFileSync(file)).equals(Buffer.from(MODEL))) return MODEL_SHEETS; throw new Error('not a spreadsheet'); } }); return { calls, convert }; }
function pc(root: string, name: string, svc = new StandInService(), o: { limit?: number; folders?: string[]; foldersNow?: () => string[] | null; convert?: Converter | null; shared?: Folder; atOnce?: number; index?: boolean } = {}) {
  const sharedPath = path.join(root, 'shared'); const shared = o.shared ?? nodeFolder(sharedPath), local = nodeFolder(path.join(root, `local-${name}`)); const workPath = path.join(root, `work-${name}`);
  const keeper = new StoreKeeper(svc, local, { limit: o.limit ?? 500, clock, recheckMs: 0 }); const done: string[] = []; const conv = standInConverter();
  const docs = nodeDocuments({ shared, local, sharedPath, installId: name, keeper, clock, workPath, ...(o.convert === null ? {} : { convert: o.convert ?? conv.convert }), folders: async () => o.folders ?? [path.join(root, 'vdr')], ...(o.foldersNow ? { foldersNow: o.foldersNow } : {}), onIndexed: (d) => done.push(d), ...(o.atOnce ? { atOnce: o.atOnce } : {}), ...(o.index ? { index: wordIndex(local) } : {}) });
  const work = () => (fs.existsSync(workPath) ? fs.readdirSync(workPath) : []);
  return { docs, svc, keeper, done, shared, local, converted: conv.calls, work };
}
const folder = (p: string) => ({ path: p, label: 'Data room', files: 0, size: '', indexed: 0, reviewed: 0 });
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const indexAll = async (x: ReturnType<typeof pc>, vdr: string, deal = 'd1') => { val(await x.docs.index(deal, [folder(vdr)])); await x.docs.settled(deal); return val(await x.docs.poll(deal)); };

describe('documents on real folders', () => {
  it("keeps every word on each PC's own index, also for documents another PC indexed first, and nothing of it in the shared folder", async () => {
    const { root, vdr } = room(); const a = pc(root, 'office', undefined, { index: true }); await indexAll(a, vdr);
    const b = pc(root, 'home', undefined, { index: true }); await indexAll(b, vdr);
    for (const x of [a, b]) {
      const ix = wordIndex(x.local);
      const fa = x.docs.records('d1').find((r) => r.name === 'Credit Agreement.pdf')!; expect(ix.has('d1', fa.docId)).toBe(true);
      const q = new Set(tokens('credit').map(fold)); const s = ix.score('d1', q, x.docs.records('d1').map((r) => ({ docId: r.docId, named: new Set<string>() })));
      expect(s.get(fa.docId)).toBeGreaterThan(0);
      expect(x.docs.records('d1').filter((r) => r.name === 'Model v12.xlsx' || r.name === 'Notes.docx').every((r) => ix.has('d1', r.docId))).toBe(true);
    }
    expect(fs.readdirSync(path.join(root, 'shared')).filter((f) => /^words\d*-/.test(f))).toEqual([]);
    // a second run on the same PC reads nothing again: the index already has every document
    const before = a.converted.length; await indexAll(a, vdr); expect(a.converted.length).toBe(before);
  });
  it('a folder taken off the deal stops feeding checks and questions, and its documents still open', async () => {
    const { root, vdr } = room(); const extra = path.join(root, 'extra'); put(extra, 'Side Letter.pdf', pdf('side letter'));
    let now: string[] | null = [vdr, extra]; const a = pc(root, 'office', undefined, { folders: [vdr, extra], foldersNow: () => now });
    val(await a.docs.index('d1', [folder(vdr), folder(extra)])); await a.docs.settled('d1');
    expect(a.docs.records('d1').map((r) => r.name)).toContain('Side Letter.pdf');
    now = [vdr + path.sep];                                                    // as the deal names it, with a trailing separator
    const names = a.docs.records('d1').map((r) => r.name); expect(names).not.toContain('Side Letter.pdf'); expect(names).toContain('Credit Agreement.pdf');
    expect((await a.docs.page('d1', { doc: 'Side Letter.pdf', docId: idOf(pdf('side letter')) }, 'p. 1')).ok).toBe(true);   // a citation already made still opens
    now = null; expect(a.docs.records('d1').map((r) => r.name)).toContain('Side Letter.pdf');   // a deal that cannot be read hides nothing
  });
  it('counts what is in a folder, leaving out what the system keeps for itself', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office');
    expect(val(await a.docs.scanFolder(vdr))).toEqual({ files: 5, size: `${Math.round((FA.length + SHA.length + EYR.length + MODEL.length + NOTES.length) / 1e3)} KB` });
    const none = await a.docs.scanFolder(path.join(root, 'nowhere')); expect(!none.ok && none.error.kind).toBe('notFound');
    const file = await a.docs.scanFolder(path.join(vdr, '01 Legal/Credit Agreement.pdf')); expect(!file.ok && file.error.kind).toBe('notFound');
  });

  it('indexing records every file under an id taken from its contents, with its pages and the words it uses most; nothing is uploaded and no model is asked', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office');
    expect(val(await a.docs.poll('d1'))).toEqual({ folders: [], log: [], done: true });                                       // nothing under way
    val(await a.docs.index('d1', [folder(vdr)])); expect(val(await a.docs.poll('d1')).done).toBe(false);
    await a.docs.settled('d1'); const p = val(await a.docs.poll('d1'));
    expect(p.done).toBe(true); expect(p.folders).toMatchObject([{ path: vdr, label: 'Data room', files: 5, indexed: 5, reviewed: 0 }]);                   // indexing reviews nothing
    expect(p.log).toEqual(['Indexed 5 files']); expect(a.done).toEqual(['d1']);
    const recs = a.docs.records('d1'); const by = (n: string) => a.docs.records('d1').find((r) => r.name === n)!;
    expect(recs.map((r) => r.name).sort()).toEqual(['Credit Agreement.pdf', 'Energy Yield Report.pdf', 'Model v12.xlsx', 'Notes.docx', 'Shareholders Agreement.pdf']);
    expect(by('Credit Agreement.pdf')).toEqual({ docId: idOf(FA), hash: hashBytes(FA), name: 'Credit Agreement.pdf', folder: vdr, rel: '01 Legal/Credit Agreement.pdf', size: FA.length, pages: 3, words: ['agreement', 'credit'], seen: expect.any(String) });
    expect([by('Energy Yield Report.pdf').pages, by('Notes.docx').pages, by('Model v12.xlsx').pages]).toEqual([2, undefined, undefined]);   // a spreadsheet has cells, not pages; a Word file has none until it is first converted
    expect(by('Notes.docx').words).toEqual(['notes', 'three', 'two']); expect(a.converted).toEqual([]);                                     // its words were read straight from the file
    // a Word file's words come from the PDF made of it; a spreadsheet's from its sheet names and the text in its cells, not its numbers
    expect([by('Energy Yield Report.pdf').words, by('Notes.docx').words, by('Model v12.xlsx').words]).toEqual([['energy', 'yield'], ['notes', 'three', 'two'], ['line', 'cover', 'debt']]);
    expect(a.svc.uploads).toBe(0); expect(a.svc.calls.length).toBe(0); expect(val(await a.docs.cached())).toEqual([]);
    expect(a.converted).toEqual([]); expect(a.work()).toEqual([]);                                                                  // nothing converted, and nothing kept
    // again: nothing is recorded or converted twice
    const lines = () => fs.readFileSync(path.join(root, 'shared', 'docs-office-d1.jsonl'), 'utf8').trim().split('\n').length; const before = lines();
    await indexAll(a, vdr);
    expect(lines()).toBe(before); expect(a.svc.uploads).toBe(0); expect(a.converted).toEqual([]);
    // opened: the Word file is converted, and its pages recorded for every PC
    val(await a.docs.page('d1', { doc: 'Notes.docx', docId: idOf(NOTES) }, 'p. 1')); expect(by('Notes.docx')).toMatchObject({ pages: 3, via: 'stand-in' }); expect(a.converted).toEqual(['Notes.docx']);
    expect(pc(root, 'home').docs.records('d1').find((r) => r.name === 'Notes.docx')).toMatchObject({ pages: 3, via: 'stand-in' });
    const bad = await a.docs.index('d1', [folder(path.join(root, 'nowhere'))]); expect(!bad.ok && bad.error.kind).toBe('notFound');
    // what the model later says a document is, is kept once
    a.docs.describe('d1', idOf(FA), { summary: 'The senior credit agreement.', keywords: ['loan', 'facility'] }); a.docs.describe('d1', idOf(FA), { summary: 'Something else.', keywords: [] }); a.docs.describe('d1', 'doc_000000000000000000000000', { summary: 'No such document.', keywords: [] });
    expect(by('Credit Agreement.pdf')).toMatchObject({ summary: 'The senior credit agreement.', keywords: ['loan', 'facility'], words: ['agreement', 'credit'] }); expect(lines()).toBe(before + 2);                                    // the Word file's pages, and the summary
    // a failed try to describe a document is counted where every PC sees it, and forgotten once it has a summary
    a.docs.undescribed('d1', idOf(EYR)); a.docs.undescribed('d1', idOf(EYR)); a.docs.undescribed('d1', idOf(FA)); a.docs.undescribed('d1', 'doc_000000000000000000000000');
    expect(by('Energy Yield Report.pdf').undescribed).toMatchObject({ tries: 2 }); expect(by('Credit Agreement.pdf').undescribed).toBeUndefined(); expect(lines()).toBe(before + 4);
    expect(pc(root, 'home').docs.records('d1').find((r) => r.name === 'Energy Yield Report.pdf')!.undescribed!.tries).toBe(2);
    a.docs.describe('d1', idOf(EYR), { summary: 'The energy yield report.', keywords: [] }); expect(by('Energy Yield Report.pdf').undescribed).toBeUndefined(); expect(pc(root, 'home').docs.records('d1').find((r) => r.name === 'Energy Yield Report.pdf')).toMatchObject({ summary: 'The energy yield report.' });
    // when a document is sent, it goes as the PDF it is shown as
    await a.keeper.ensure(await a.docs.wanted('d1', recs.map((r) => r.docId)));
    const sent = [...a.svc.files.values()].map((f) => [fromStoreName(f.name)!.name, new TextDecoder().decode(f.bytes.slice(0, 4))]).sort();
    expect(sent).toEqual([['Credit Agreement.pdf', '%PDF'], ['Energy Yield Report.pdf', '%PDF'], ['Model v12.xlsx', 'PK\u0003\u0004'], ['Notes.docx.pdf', '%PDF'], ['Shareholders Agreement.pdf', '%PDF']]); expect(a.work()).toEqual([`${idOf(NOTES)}.pdf`]);   // only the copy of the one a person opened is kept
  });

  it('where indexing stopped is kept on this PC: after the app is closed part-way, it says how far each folder had got; once indexing has finished it says finished, not stopped', async () => {
    const { root, vdr } = room(); const a = pc(root, 'A');
    val(await a.docs.index('d1', [folder(vdr)]));
    // catch it part-way, and take the PC's own files as they are at that moment: what would be there if the app were closed now
    let mid = val(await a.docs.poll('d1'));
    while (!mid.done && mid.folders[0].indexed === 0) { await new Promise((r) => setImmediate(r)); mid = val(await a.docs.poll('d1')); }
    expect(mid.done).toBe(false); expect(mid.folders[0].indexed).toBeGreaterThan(0); expect(mid.folders[0].indexed).toBeLessThan(5);
    fs.cpSync(path.join(root, 'local-A'), path.join(root, 'local-B'), { recursive: true });
    const b = pc(root, 'B'); const left = val(await b.docs.poll('d1'));
    expect(left.done).toBe(false); expect(left.stopped).toBe(true);
    expect(left.folders).toMatchObject([{ path: vdr, label: 'Data room', files: 5, indexed: mid.folders[0].indexed }]);
    expect(val(await b.docs.poll('d2'))).toEqual({ folders: [], log: [], done: true });                                       // another deal has nothing under way
    // run again there: it finishes, and after that nothing is remembered as stopped, in this session or the next
    val(await b.docs.index('d1', [folder(vdr)])); expect(val(await b.docs.poll('d1')).stopped).toBeUndefined();
    await b.docs.settled('d1'); const done = val(await b.docs.poll('d1'));
    expect(done.done).toBe(true); expect(done.stopped).toBeUndefined(); expect(done.folders).toMatchObject([{ path: vdr, files: 5, indexed: 5 }]);
    // (what a finished run covered stays known on the PC, so that the deal can still be told if the app closes before it has been; it is finished, not stopped)
    const b2 = pc(root, 'B'); const fin = val(await b2.docs.poll('d1')); expect(fin.done).toBe(true); expect(fin.stopped).toBeUndefined(); expect(fin.folders).toMatchObject([{ path: vdr, files: 5, indexed: 5 }]);
    await a.docs.settled('d1');
    const a2 = pc(root, 'A'); const fin2 = val(await a2.docs.poll('d1')); expect(fin2.done).toBe(true); expect(fin2.stopped).toBeUndefined();
  });

  it('each new file is brought across from the data room once, a few at a time; what was brought is not left on the PC; the times of the latest run are kept on the PC in a file that does not grow', async () => {
    const { root, vdr } = room(); const a = pc(root, 'A');
    // count every time a file under the data room is opened for reading, and how many are being read at one moment
    const opens = new Map<string, number>(); let active = 0, most = 0;
    const realStream = fs.createReadStream, realOpen = fs.openSync, realRead = fs.readFileSync;
    const inRoom = (f: unknown) => typeof f === 'string' && f.startsWith(vdr + path.sep);
    const count = (f: string) => opens.set(path.basename(f), (opens.get(path.basename(f)) ?? 0) + 1);
    // (a file from the data room takes a moment to start arriving, as on a share, so that how many are on their way at once does not depend on how fast this machine is)
    const slow = (f: any, rest: any[], counted: boolean) => { if (!inRoom(f)) return (realStream as any)(f, ...rest); if (counted) count(f); active++; most = Math.max(most, active); const pass = new PassThrough(); pass.once('close', () => { active--; }); setTimeout(() => { const st = (realStream as any)(f, ...rest); st.on('error', (e: Error) => pass.destroy(e)); st.pipe(pass); }, 150); return pass; };
    (fs as any).createReadStream = (f: any, ...rest: any[]) => slow(f, rest, true);
    (fs as any).openSync = (f: any, ...rest: any[]) => { if (inRoom(f) && (rest[0] === 'r' || rest[0] === undefined)) count(f); return (realOpen as any)(f, ...rest); };
    (fs as any).readFileSync = (f: any, ...rest: any[]) => { if (inRoom(f)) count(f); return (realRead as any)(f, ...rest); };
    let p: Awaited<ReturnType<typeof indexAll>> | undefined; try { p = await indexAll(a, vdr); } finally { (fs as any).createReadStream = realStream; (fs as any).openSync = realOpen; (fs as any).readFileSync = realRead; }
    expect(p.done).toBe(true); expect(p.log).toEqual(['Indexed 5 files']); expect(a.docs.records('d1').length).toBe(5);
    // five documents, each read from the data room exactly once: the fingerprint, the pages and the words all come from that one reading
    expect([...opens.entries()].sort()).toEqual([['Credit Agreement.pdf', 1], ['Energy Yield Report.pdf', 1], ['Model v12.xlsx', 1], ['Notes.docx', 1], ['Shareholders Agreement.pdf', 1]]);
    expect(most).toBe(3);                                                    // three at a time, unless told otherwise
    expect(a.converted).toEqual([]);                                         // the Word file's text was read from the copy brought across; it is converted only when first sent or opened
    expect(a.work().filter((x) => x !== 'in')).toEqual([]); expect(fs.existsSync(path.join(root, 'work-A', 'in')) ? fs.readdirSync(path.join(root, 'work-A', 'in')) : []).toEqual([]);   // nothing brought across or converted is left behind
    // how long it took, and how much was read how fast, is on the result and in a file on this PC
    expect(p.timing).toMatchObject({ files: 5, brought: 5, known: 0, atOnce: 3 }); expect(p.timing!.bytes).toBe(FA.length + SHA.length + EYR.length + MODEL.length + NOTES.length);
    expect(p.timing!.totalMs).toBeGreaterThanOrEqual(p.timing!.readMs); expect(p.timing!.readMs).toBeGreaterThanOrEqual(140); expect(p.timing!.workMs).toBeGreaterThanOrEqual(0);
    const lines = (a.local.read('indexing-last.txt') ?? '').trim().split('\n'); expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\S+ d1: 5 files in [\d.]+ s; 5 read from the data room \([\d.,]+ (KB|MB|GB)\) in [\d.]+ s, [\d.,]+ MB\/s, 3 at a time; [\d.]+ s converting and reading pages, waits included, in parallel with the reading; 0 already known$/);
    // a second run reads nothing from the data room: every file is known by its size and date
    opens.clear(); (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (inRoom(f)) count(f); return (realStream as any)(f, ...rest); }; (fs as any).openSync = (f: any, ...rest: any[]) => { if (inRoom(f)) count(f); return (realOpen as any)(f, ...rest); }; (fs as any).readFileSync = (f: any, ...rest: any[]) => { if (inRoom(f)) count(f); return (realRead as any)(f, ...rest); };
    let again: Awaited<ReturnType<typeof indexAll>> | undefined; try { again = await indexAll(a, vdr); } finally { (fs as any).createReadStream = realStream; (fs as any).openSync = realOpen; (fs as any).readFileSync = realRead; }
    expect([...opens.entries()]).toEqual([]); expect(again.timing).toMatchObject({ files: 5, brought: 0, known: 5 });
    // the file holds the latest run only: it is written over, never added to
    const after = (a.local.read('indexing-last.txt') ?? '').trim().split('\n'); expect(after.length).toBe(1); expect(after[0]).toMatch(/ d1: 5 files in [\d.]+ s; 0 read from the data room \(0 KB\) .* 5 already known$/); expect(a.local.read('indexing-log.txt')).toBeNull();
    // one at a time when this PC says so
    const b = pc(root, 'B', new StandInService(), { atOnce: 1 }); active = 0; most = 0;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => slow(f, rest, false);
    try { const q = await indexAll(b, vdr); expect(q.timing).toMatchObject({ atOnce: 1 }); } finally { (fs as any).createReadStream = realStream; }
    expect(most).toBe(1);
  });

  it('what has been read survives the app being closed part-way: the next session does not bring the same files across again', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 8; i++) put(vdr, `f${i}.pdf`, pdf(`document ${i}`));
    const a = pc(root, 'A'); val(await a.docs.index('d1', [folder(vdr)]));
    let mid = val(await a.docs.poll('d1'));
    while (!mid.done && mid.folders[0].indexed < 4) { await new Promise((r) => setImmediate(r)); mid = val(await a.docs.poll('d1')); }
    const k = mid.folders[0].indexed; expect(mid.done).toBe(false); expect(k).toBeGreaterThanOrEqual(4); expect(k).toBeLessThan(8);
    fs.cpSync(path.join(root, 'local-A'), path.join(root, 'local-B'), { recursive: true });               // the PC's own files as they were at that moment
    await a.docs.settled('d1');
    // the next session on those files: what was read before the close is known by its size and date, and is not read again
    const b = pc(root, 'B'); const p = await indexAll(b, vdr);
    expect(p.done).toBe(true); expect(p.timing!.files).toBe(8);
    expect(p.timing!.known).toBeGreaterThanOrEqual(k); expect(p.timing!.brought).toBeLessThanOrEqual(8 - k);
  });

  it('a start that is refused because the data room cannot be reached is remembered on this PC: after a restart the deal is still one it has to index, until it has', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr');                  // not there yet: the drive is not connected
    const a = pc(root, 'A'); const r = await a.docs.index('d1', [folder(vdr)]);
    expect(r).toMatchObject({ ok: false, error: { kind: 'notFound' } });
    const want = { folders: [{ path: vdr, label: 'Data room', indexed: 0 }], log: [], done: false, stopped: true };
    expect(val(await a.docs.poll('d1'))).toMatchObject(want);
    expect(val(await pc(root, 'A').docs.poll('d1'))).toMatchObject(want);   // and after a restart
    expect(val(await pc(root, 'B').docs.poll('d1'))).toEqual({ folders: [], log: [], done: true });   // another PC was not asked, and is not told to
    // the drive connects; it is started again and finishes; nothing is remembered after that
    put(vdr, '01 Legal/Credit Agreement.pdf', FA); put(vdr, '01 Legal/Shareholders Agreement.pdf', SHA);
    const a2 = pc(root, 'A'); const p = await indexAll(a2, vdr);
    expect(p.done).toBe(true); expect(p.stopped).toBeUndefined(); expect(p.folders).toMatchObject([{ path: vdr, files: 2, indexed: 2 }]);
    const end = val(await pc(root, 'A').docs.poll('d1')); expect(end.done).toBe(true); expect(end.stopped).toBeUndefined(); expect(end.folders).toMatchObject([{ path: vdr, files: 2, indexed: 2 }]);
  });

  it('spreadsheets are read after every other file, smallest first, so a large one holds up none (#427)', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr');
    put(vdr, 'A large.csv', 'ledger,entry\n'.repeat(1000));
    put(vdr, 'B small.csv', 'ledger,entry\n');
    put(vdr, 'C Agreement.pdf', FA);
    const a = pc(root, 'office'); expect((await indexAll(a, vdr)).log).toEqual(['Indexed 3 files']);
    const order = a.docs.records('d1').map((r) => r.name);
    expect(order.indexOf('C Agreement.pdf')).toBeLessThan(order.indexOf('B small.csv'));
    expect(order.indexOf('B small.csv')).toBeLessThan(order.indexOf('A large.csv'));
  });

  it('a spreadsheet of 250,000 different words is counted as the same text read whole (#427)', async () => {
    const root = tmp();
    const vdr = path.join(root, 'vdr');
    // each row a word of its own (four letters after a "z", so no two rows share one) and a note every row shares
    const letters = (i: number) => [3, 2, 1, 0].map((p) => String.fromCharCode(97 + (Math.floor(i / 26 ** p) % 26)));
    const rows = Array.from({ length: 250_000 }, (_, i) => [`z${letters(i).join('')}`, `ledger entry ${i}`]);
    put(vdr, 'Names.csv', rows.map((row) => row.join(',')).join('\n'));
    const a = pc(root, 'office', undefined, { index: true });
    await indexAll(a, vdr);
    const text = rows.flat().join('\n');
    const expected = countWords(text);
    expect(expected.counts.size).toBeGreaterThan(200_000);
    const record = a.docs.records('d1').find((r) => r.name === 'Names.csv')!;
    expect(record.words).toEqual(topWords(text));
    const lines = fs.readFileSync(path.join(root, 'local-office', 'words2-d1.jsonl'), 'utf8').trim().split('\n');
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.d === record.docId);
    expect(line.n).toBe(expected.length);
    expect(line.t).toBe(expected.title.join(' '));
    expect(line.w).toBe([...expected.counts].map(([w, n]) => `${w}:${n}`).join(' '));
  }, 60000);

  it('a scan has no words and is indexed all the same; a long document is counted from pages spread through it; a record from before words were kept gets them', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const blank = new TextEncoder().encode(new TextDecoder().decode(pdf('', 2)).replace(/\(, page \d\) Tj/g, (m) => ' '.repeat(m.length)));
    put(vdr, 'Scan.pdf', blank); put(vdr, 'Credit Agreement.pdf', FA); put(vdr, 'Rates.csv', 'Tenor,Margin\nSenior term loan,2.25\nSenior term loan,2.50\nJunior loan,6\n');
    const a = pc(root, 'office'); const p = await indexAll(a, vdr); const by = (n: string) => a.docs.records('d1').find((r) => r.name === n)!;
    // and the person is told which
    expect(p.log).toEqual(['Indexed 3 files', '1 file has no readable text and can be found by name only: Scan.pdf']);
    expect(by('Scan.pdf')).toMatchObject({ pages: 2, words: [] });
    expect(by('Rates.csv').words).toEqual(['loan', 'senior', 'term', 'junior', 'margin', 'tenor']);
    // a large spreadsheet is read like any other: its words are counted, however big it is
    put(vdr, 'Huge export.csv', 'ledger,entry\n'.repeat(2_100_000));
    await indexAll(a, vdr);
    expect(by('Huge export.csv')).toMatchObject({ size: 27_300_000, words: ['entry', 'ledger'] });
    // a workbook that cannot be read now is not recorded as having no text: it is left unread, to be read again
    put(vdr, 'Broken.xlsx', 'not a workbook');
    const q = await indexAll(a, vdr);
    expect(by('Broken.xlsx')?.words).toBeUndefined();
    expect(q.log.join(' ')).toContain('could not be read');
    // and it is named again on every run, not only the first
    expect((await indexAll(a, vdr)).log.join(' ')).toContain('could not be read');
    // and read again once the file changes, its words then recorded
    put(vdr, 'Broken.xlsx', MODEL);
    await indexAll(a, vdr);
    expect(by('Broken.xlsx').words).toEqual(['line', 'cover', 'debt']);
    const long = await pdfLook(pdf('long report', 100), 10); expect(long.pages).toBe(100); expect(long.text.split('\n').map((l) => +l.split('page ')[1])).toEqual([1, 11, 21, 31, 41, 51, 61, 71, 81, 91]);
    expect((await pdfLook(pdf('short report', 4), 10)).text.split('\n').length).toBe(4);
    // a document another copy of the app recorded before words were kept: indexing here adds them, once
    const OLD = pdf('interconnection agreement', 2); put(vdr, 'Grid.pdf', OLD); const file = path.join(root, 'shared', 'docs-older-d1.jsonl');
    fs.appendFileSync(file, JSON.stringify({ v: 1, pc: 'older', at: '2026-11-01T00:00:00.000Z', docId: idOf(OLD), hash: hashBytes(OLD), name: 'Grid.pdf', folder: vdr, rel: 'Grid.pdf', size: OLD.length, pages: 2 }) + '\n');
    expect(by('Grid.pdf').words).toBeUndefined(); await indexAll(a, vdr); expect(by('Grid.pdf')).toMatchObject({ pages: 2, words: ['agreement', 'interconnection'] });
    const mine = () => fs.readFileSync(path.join(root, 'shared', 'docs-office-d1.jsonl'), 'utf8').trim().split('\n').length; const n = mine(); await indexAll(a, vdr); expect(mine()).toBe(n);
  }, 60000);   // the large spreadsheet above is read in full

  it('a file that cannot be turned into pages is reported and is not indexed; the rest are', async () => {
    const { root, vdr } = room(); put(vdr, '01 Legal/Locked.docx', 'protected'); put(vdr, '01 Legal/Broken.pdf', 'not a pdf at all');
    const a = pc(root, 'office'); const p = await indexAll(a, vdr);
    expect(p.log).toEqual(['Indexed 5 files', '2 files could not be turned into pages and were not indexed: 01 Legal/Broken.pdf, 01 Legal/Locked.docx']);   // and it says which
    expect(p.folders).toMatchObject([{ files: 7, indexed: 7, reviewed: 0 }]);                                                  // every file was dealt with, so there is nothing to resume
    expect(a.docs.records('d1').map((r) => r.name)).not.toContain('Locked.docx'); expect(a.docs.records('d1').length).toBe(5); expect(a.work()).toEqual([]);
    // with no converter on this PC, a Word file is one of those; PDFs and spreadsheets are not
    const b = pc(tmp(), 'bare', new StandInService(), { convert: null, folders: [vdr] });
    const q = await indexAll(b, vdr);
    const notPaged = '2 files could not be turned into pages and were not indexed: ';
    const lost = '01 Legal/Broken.pdf, 01 Legal/Locked.docx';
    expect(q.log).toContain(notPaged + lost);
    expect(q.log).toContain('1 file could not be read: 03 Financial/Model v12.xlsx');
    // no converter, so the workbook's words cannot be read: it is listed by name and read again later;
    // a Word file is indexed from its text with no converter, and only showing it needs one
    const names = [
      'Credit Agreement.pdf', 'Energy Yield Report.pdf', 'Model v12.xlsx', 'Notes.docx', 'Shareholders Agreement.pdf',
    ];
    expect(b.docs.records('d1').map((r) => r.name).sort()).toEqual(names);
  });

  it.skipIf(!hasOffice)(
    'a real Word file converts with LibreOffice, and its pages are counted from the PDF',
    async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'Notes.docx', NOTES);
    const a = pc(root, 'office', new StandInService(), { convert: libreOfficeConverter({ soffice }) });
    const p = await indexAll(a, vdr);
    expect(p.log).toEqual(['Indexed 1 file']); expect(a.docs.records('d1')[0].pages).toBeUndefined(); expect(a.docs.records('d1')[0].words).toEqual(['notes', 'three', 'two']);
    const page = val(await a.docs.page('d1', { doc: 'Notes.docx', docId: idOf(NOTES) }, 'p. 2')); expect(page.kind === 'pdf' && page.page).toBe(2);
    expect(a.docs.records('d1')[0]).toMatchObject({ name: 'Notes.docx', pages: 3, via: 'libreoffice' });                                    // converted when first opened, and its pages counted then
    const shown = a.docs.fileFor((page as { url: string }).url.replace('punchlist-doc://', ''))!; expect(await pdfPages(fs.readFileSync(shown))).toBe(3);
  }, 60000);

  it.skipIf(!hasOffice)(
    'a damaged workbook read through LibreOffice gets no word list and is named as not read (#427)',
    async () => {
      const root = tmp();
      const vdr = path.join(root, 'vdr');
      put(vdr, 'Broken.xlsx', 'PK\u0003\u0004 a workbook cut short');
      const a = pc(root, 'office', new StandInService(), { convert: libreOfficeConverter({ soffice }) });
      const p = await indexAll(a, vdr);
      expect(p.log).toContain('1 file could not be read: Broken.xlsx');
      expect(a.docs.records('d1').find((r) => r.name === 'Broken.xlsx')?.words).toBeUndefined();
    },
    60000,
  );

  // A Word file with every kind of tracked change: a word replaced, a paragraph break deleted, text moved, a table row deleted and
  // one inserted, a whole paragraph deleted, formatting changed, a change in the footer, and a comment.
  const TRACKED = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'Tracked.docx')));
  const KEPT = ['The lock-up ratio is 1.15x from financial close.', 'First half of a sentence joined to its second half.', 'MOVEDSENTENCE new place.', 'INSERTEDROW', 'Tranche C', 'Commented sentence.', 'Last line, unchanged.', 'FOOTERNEW'];
  const GONE = ['1.10x', 'MOVEDSENTENCE old place', 'DELETEDROW', '999', 'WHOLEPARAGRAPHGONE', 'FOOTEROLD', 'COMMENTTEXT'];
  it.skipIf(!hasOffice)(
    'LibreOffice shows a file\'s tracked changes as markup, deleted words and all, and prints no comments',
    async () => {
    const dir = tmp(); const file = put(dir, 'Tracked.docx', TRACKED); const profile = path.join(tmp(), 'lo');
    const marked = await libreOfficeConverter({ soffice, profile })(file, dir, 'marked.pdf');
    const text = (await pdfText(fs.readFileSync(marked))).join(' ');
    const shown = ['1.10x', '1.15x', 'DELETEDROW', 'INSERTEDROW', 'FOOTEROLD', 'FOOTERNEW'];
    for (const k of shown) expect(text).toContain(k);
    expect(text).not.toContain('COMMENTTEXT');
    // nothing is left behind
    expect(fs.readdirSync(dir).sort()).toEqual(['Tracked.docx', 'marked.pdf']);
  }, 120000);

  // a comparison tool's name, 240 characters: Windows takes up to 255 for one name, but older programs stop at 260 for the whole path
  const LONG = `Project Bellows - Senior Credit Agreement (Execution Version) - DMS#7654321v12 - Comparison of DMS#7654321v11 to DMS#7654321v12 - Changes Marked for review and further`.padEnd(228, '.') + ' REDLINE.docx';
  it('LibreOffice is handed a copy under a short name, never the file where it is, and the copy is gone afterwards', async () => {
    const dir = tmp(); const seen = path.join(dir, 'seen.txt'); const fake = path.join(dir, 'soffice');
    // a stand-in for LibreOffice: sets up its settings folder, and for a run notes the file it was given and reports success
    fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), path = require('path'), { fileURLToPath } = require('url');
const user = path.join(fileURLToPath(process.argv.find((a) => a.startsWith('-env:UserInstallation=')).slice(22)), 'user');
if (process.argv.includes('--terminate_after_init')) { fs.mkdirSync(path.join(user, 'basic', 'Standard'), { recursive: true }); fs.writeFileSync(path.join(user, 'basic', 'Standard', 'script.xlb'), '</library:library>'); process.exit(0); }
const src = fileURLToPath(fs.readFileSync(path.join(user, 'punchlist-job.txt'), 'utf8').split('\\n')[0]);
fs.appendFileSync(${JSON.stringify(seen)}, src + '\\t' + fs.readFileSync(src).length + '\\n'); fs.writeFileSync(path.join(user, 'punchlist-done.txt'), 'ok');
`, { mode: 0o755 });
    const deep = path.join(dir, 'vdr', '04 Redlines', 'Lender comments'); const file = put(deep, LONG, TRACKED); const profile = path.join(dir, 'lo');
    const lo = libreOfficeConverter({ soffice: fake, profile }); expect((await lo.changes!(file)).tracked).toBe(0);
    const [given, size] = fs.readFileSync(seen, 'utf8').trim().split('\t');
    expect(given).toBe(path.join(profile, 'user', 'punchlist-in.docx')); expect(+size).toBe(TRACKED.length);                       // the whole file, under a short name
    expect(fs.existsSync(given)).toBe(false); expect(fs.readFileSync(file)).toEqual(Buffer.from(TRACKED));                            // the copy is gone; the file itself is as it was
    // copies left by runs that were stopped are cleared at the next session's first run, in every settings folder no run holds
    fs.writeFileSync(path.join(profile, 'user', 'punchlist-in.pdf'), 'left'); fs.mkdirSync(path.join(`${profile}-2`, 'user'), { recursive: true }); fs.writeFileSync(path.join(`${profile}-2`, 'user', 'punchlist-in.docx'), 'left');
    const next = libreOfficeConverter({ soffice: fake, profile }); await next.changes!(file);
    expect([profile, `${profile}-2`].flatMap((p) => fs.readdirSync(path.join(p, 'user')).filter((f) => f.startsWith('punchlist-in')))).toEqual([]);
    // one that cannot be removed (held by a LibreOffice still being stopped; here, a removal made to fail) does not stop the next run
    const held = path.join(profile, 'user'); fs.writeFileSync(path.join(held, 'punchlist-in.docx'), 'held'); const real = fs.rmSync;
    fs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => { if (String(p).endsWith('punchlist-in.docx')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); real(p, o); }) as typeof fs.rmSync;
    try { await next.changes!(file); } finally { fs.rmSync = real; }
    expect(fs.readFileSync(seen, 'utf8').trim().split('\n').pop()!.split('\t')[0]).toBe(path.join(held, 'punchlist-in-2.docx')); fs.rmSync(path.join(held, 'punchlist-in.docx'));
    expect([shortExt('a.DOCX '), shortExt('.csv'), shortExt('Notes.v12 final'), shortExt('a.verylongext'), shortExt('Notes.')]).toEqual(['.docx', '.csv', '', '', '']);
  });

  it.skipIf(!hasOffice)(
    'a Word file with a 240-character name deep in the data room converts, and its tracked changes are read',
    async () => {
    const dir = tmp();
    const file = put(path.join(dir, 'a'.repeat(100), 'b'.repeat(100)), LONG, TRACKED);
    const lo = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    const text = (await pdfText(fs.readFileSync(await lo(file, dir, 'marked.pdf')))).join(' ');
    for (const k of ['INSERTEDROW', 'FOOTERNEW']) expect(text).toContain(k);
    expect((await lo.changes!(file)).tracked).toBe(13);
  }, 120000);

  // a Word file with a field that prints its file name, and one that prints its folder and name (FILENAME, FILENAME \\p)
  it.skipIf(!hasOffice)(
    'a field that prints the file name prints the document’s own name on the converted pages, never the copy’s or a folder on this PC (#423)',
    async () => {
    const dir = tmp();
    const field = fs.readFileSync(path.join(__dirname, 'fixtures', 'NameField.docx'));
    const lo = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    const text = (await pdfText(fs.readFileSync(await lo(put(dir, 'Project Bellows SPA v12.docx', field), dir, 'a.pdf')))).join(' ');
    expect(text).toContain('Document name: Project Bellows SPA v12.docx'); expect(text).toContain('Full ref: Project Bellows SPA v12.docx'); expect(text).not.toMatch(/punchlist-in|lo\/user|\/tmp\//);
    // an attached file is kept under its id: the name it was attached under is what is printed
    const kept = (await pdfText(fs.readFileSync(await lo(put(dir, 'doc_0123.docx', field), dir, 'b.pdf', undefined, "Revenue US$'000 v2.docx")))).join(' ');
    expect(kept).toContain("Document name: Revenue US$'000 v2.docx"); expect(kept).not.toContain('doc_0123');
  }, 120000);

  it.skipIf(!hasImpress())('a presentation prints its own file name (requires LibreOffice Impress, #423)', async () => {
    const dir = tmp();
    const lo = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    const field = fs.readFileSync(path.join(__dirname, 'fixtures', 'NameField.odp'));
    const file = put(dir, 'Project Bellows Deck v3.odp', field);
    const deck = (await pdfText(fs.readFileSync(await lo(file, dir, 'c.pdf')))).join(' ');
    expect(deck).toContain('Deck name: Project Bellows Deck v3.odp');
    expect(deck).toContain('Deck ref: Project Bellows Deck v3.odp');
    expect(deck).not.toMatch(/punchlist-in|lo\/user|\/tmp\//);
  }, 120000);

  it('two runs at once never share a LibreOffice settings folder; a folder is reused once free, and a lock left by a stopped app is taken over', () => {
    const profile = path.join(tmp(), 'lo'); const a = holdFolder(profile), b = holdFolder(profile);
    expect([a.folder, b.folder]).toEqual([profile, `${profile}-2`]);
    a.free(); const c = holdFolder(profile); expect(c.folder).toBe(profile); c.free(); b.free();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();    // a process that has ended
    fs.writeFileSync(`${profile}.lock`, gone); const d = holdFolder(profile); expect(d.folder).toBe(profile); expect(fs.readFileSync(`${profile}.lock`, 'utf8')).toBe(String(process.pid)); d.free();
    expect(fs.existsSync(`${profile}.lock`)).toBe(false);
    expect(() => holdFolder(path.join(tmp(), 'x'.repeat(252)))).toThrow(/ENAMETOOLONG/);                // a lock that cannot be written is an error, not a reason to count up for ever
  });

  it.skipIf(!hasOffice)(
    'two LibreOffice conversions at once on one settings folder both finish, each with its own PDF',
    async () => {
    const dir = tmp(); const profile = path.join(tmp(), 'lo'); const one = put(dir, 'One.docx', TRACKED), two = put(dir, 'Two.docx', TRACKED);
    const [first, second] = await Promise.all([
      libreOfficeConverter({ soffice, profile })(one, dir, 'first.pdf'),
      libreOfficeConverter({ soffice, profile })(two, dir, 'second.pdf'),
    ]);
    const words = async (f: string) => (await pdfText(fs.readFileSync(f))).join(' ');
    expect(await words(first)).toContain('1.10x'); expect(await words(second)).toContain('1.10x');
  }, 120000);

  it.skipIf(!hasOffice)(
    'LibreOffice lists the tracked changes and comments: what, who, when, and each passage before and after',
    async () => {
    const dir = tmp();
    const convert = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    const list = await convert.changes!(put(dir, 'Tracked.docx', TRACKED)); const sroe = { by: 'sroe', at: '2026-10-01T10:00:00' };
    expect(list.tracked).toBe(13); expect(list.complete).toBe(true);
    const has = (before: string, after: string, changes: object[]) => expect(list.passages).toContainEqual({ before, after, changes });
    has('The lock-up ratio is 1.10x from financial close.', 'The lock-up ratio is 1.15x from financial close.', [{ kind: 'delete', ...sroe, text: '1.10x' }, { kind: 'insert', ...sroe, text: '1.15x' }]);
    has('First half of a sentence\n joined to its second half.', 'First half of a sentence joined to its second half.', [{ kind: 'delete', ...sroe, text: '' }]);                   // a paragraph break taken out
    has('Formatting only: now bold', 'Formatting only: now bold', [{ kind: 'format', ...sroe, text: 'now bold' }]);
    has('MOVEDSENTENCE old place.', '', [{ kind: 'delete', ...sroe, text: 'MOVEDSENTENCE old place.' }]); has('', 'MOVEDSENTENCE new place.', [{ kind: 'insert', ...sroe, text: 'MOVEDSENTENCE new place.' }]);
    has('DELETEDROW', '', [{ kind: 'delete', ...sroe, text: 'DELETEDROW' }]); has('', 'INSERTEDROW', [{ kind: 'insert', ...sroe, text: 'INSERTEDROW' }]);                              // table rows, cell by cell
    has('WHOLEPARAGRAPHGONE', '', [{ kind: 'delete', ...sroe, text: 'WHOLEPARAGRAPHGONE' }]);
    has('Commented sentence.', 'Commented sentence.', [{ kind: 'comment', ...sroe, text: 'COMMENTTEXT is this agreed?' }]);
    has('Draft FOOTEROLD', 'Draft FOOTERNEW', [{ kind: 'delete', ...sroe, text: 'FOOTEROLD' }, { kind: 'insert', ...sroe, text: 'FOOTERNEW' }]);                                       // the footer is looked in too
    expect(await convert.changes!(put(dir, 'Notes.docx', NOTES))).toEqual({ passages: [], tracked: 0, complete: true });
    expect(fs.readdirSync(dir).sort()).toEqual(['Notes.docx', 'Tracked.docx']);                                                          // listing writes nothing beside the file
  }, 120000);

  it('the list says so when it does not reach every change, and joins a passage whose change runs across a paragraph break', () => {
    const T = '\t'; const text = ['N' + T + '3', 'C' + T + 'Insert' + T + 'A' + T + '2026-01-01T00:00:00' + T + 'new', 'P' + T + 'old' + T + 'old new', 'P' + T + 'one' + T + 'one', 'C' + T + 'Insert' + T + 'A' + T + '2026-01-01T00:00:00' + T, 'P' + T + 'two' + T + 'two', ''].join('\n');
    expect(readChangeList(text)).toEqual({ tracked: 3, complete: false, passages: [{ before: 'old', after: 'old new', changes: [{ kind: 'insert', by: 'A', at: '2026-01-01T00:00:00', text: 'new' }] }, { before: 'onetwo', after: 'one\ntwo', changes: [{ kind: 'insert', by: 'A', at: '2026-01-01T00:00:00', text: '' }] }] });
    expect(readChangeList('')).toEqual({ passages: [], tracked: 0, complete: true });
  });

  it('a Word file with tracked changes is marked as such when indexed, and its changes can be asked for', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'Draft with Redline.docx', 'a draft'); put(vdr, 'Notes.docx', NOTES); put(vdr, 'Credit Agreement.pdf', FA);
    const a = pc(root, 'office'); await indexAll(a, vdr); const by = (n: string) => a.docs.records('d1').find((r) => r.name === n)!;
    expect(by('Draft with Redline.docx').tracked).toBe(4); expect(by('Notes.docx').tracked).toBeUndefined(); expect(by('Credit Agreement.pdf').tracked).toBeUndefined();
    expect(pc(root, 'home').docs.records('d1').find((r) => r.name === 'Draft with Redline.docx')!.tracked).toBe(4);                      // and the other PC knows it too
    for (const n of ['Draft with Redline.docx', 'Credit Agreement.pdf']) expect(val(await a.docs.changes('d1', by(n).docId))).toEqual({ passages: [], tracked: 0, complete: true });   // this converter cannot list them; a PDF has none
    const none = await a.docs.changes('d1', 'doc_000000000000000000000000'); expect(!none.ok && none.error.kind).toBe('notFound');
  });

  it.skipIf(!hasOffice)(
    'with LibreOffice the count and the list come from the file itself, and the list is worked out once',
    async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'SPA draft.docx', TRACKED); put(vdr, 'Notes.docx', NOTES);
    const lo = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    let asked = 0;
    const listing = lo.changes!;
    lo.changes = (f) => { asked++; return listing(f); };
    const a = pc(root, 'office', new StandInService(), { convert: lo }); await indexAll(a, vdr);
    expect(a.docs.records('d1').map((r) => [r.name, r.tracked, r.pages, r.via])).toEqual([['Notes.docx', undefined, undefined, undefined], ['SPA draft.docx', 13, undefined, undefined]]);   // counted from the file at indexing
    await a.keeper.ensure(await a.docs.wanted('d1', [idOf(TRACKED)])); expect(a.docs.records('d1')[1]).toMatchObject({ tracked: 13, pages: 1, via: 'libreoffice' });       // sent: converted, and LibreOffice's count agrees
    const first = val(await a.docs.changes('d1', idOf(TRACKED))); expect(first.tracked).toBe(13); expect(first.passages.length).toBeGreaterThan(8);
    expect(val(await a.docs.changes('d1', idOf(TRACKED)))).toBe(first); expect(asked).toBe(1);
  }, 120000);

  it.skipIf(!hasOffice)(
    'LibreOffice refuses a file that is not what its name says, and a missing one, and carries on with the next',
    async () => {
    const dir = tmp();
    const convert = libreOfficeConverter({ soffice, profile: path.join(tmp(), 'lo') });
    await expect(convert(put(dir, 'Garbage.docx', 'this is not a Word file'), dir, 'a.pdf')).rejects.toThrow('the file is not what its name says');
    await expect(convert(path.join(dir, 'Nowhere.docx'), dir, 'b.pdf')).rejects.toThrow();
    expect(await pdfPages(fs.readFileSync(await convert(put(dir, 'Notes.docx', NOTES), dir, 'c.pdf')))).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual(['Garbage.docx', 'Notes.docx', 'c.pdf']);
  }, 120000);

  it('a data room bigger than the store is indexed all the same, and when its documents are sent the store never goes over its limit', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 1; i <= 12; i++) put(vdr, `Report ${String(i).padStart(2, '0')}.pdf`, pdf(`report ${i}`));
    const svc = new StandInService(); let most = 0; const upload = svc.upload.bind(svc); svc.upload = async (f) => { const id = await upload(f); most = Math.max(most, svc.files.size); return id; };
    const a = pc(root, 'office', svc, { limit: 3 }); const p = await indexAll(a, vdr);
    expect(p.log).toEqual(['Indexed 12 files']); expect(svc.uploads).toBe(0);
    for (const r of a.docs.records('d1').sort((x, y) => (x.name < y.name ? -1 : 1))) await a.keeper.ensure(await a.docs.wanted('d1', [r.docId]));
    expect(most).toBe(3); expect(svc.files.size).toBe(3); expect(val(await a.docs.cached()).length).toBe(3);
    expect([...svc.files.values()].map((f) => fromStoreName(f.name)!.name).sort()).toEqual(['Report 10.pdf', 'Report 11.pdf', 'Report 12.pdf']);  // the last used stay
  });

  it('a file that is deleted or replaced stops being one of the deal’s documents; a PC with only part of a folder takes nothing away; a file that comes back is back', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'); await indexAll(a, vdr); const names = (x: ReturnType<typeof pc>) => x.docs.records('d1').map((r) => r.name).sort();
    // a new draft saved over the credit agreement, and the energy yield report deleted
    const FA2 = pdf('credit agreement amended', 4); fs.writeFileSync(path.join(vdr, '01 Legal/Credit Agreement.pdf'), FA2); fs.rmSync(path.join(vdr, '02 Technical/Energy Yield Report.pdf'));
    await indexAll(a, vdr);
    expect(names(a)).toEqual(['Credit Agreement.pdf', 'Model v12.xlsx', 'Notes.docx', 'Shareholders Agreement.pdf']);                         // one credit agreement, the new one; no energy yield report
    expect(a.docs.records('d1').find((r) => r.name === 'Credit Agreement.pdf')).toMatchObject({ docId: idOf(FA2), pages: 4 }); expect(a.docs.records('d1').some((r) => r.docId === idOf(FA) || r.docId === idOf(EYR))).toBe(false);
    expect((await a.docs.wanted('d1', [idOf(FA), idOf(FA2), idOf(EYR)])).map((w) => w.docId)).toEqual([idOf(FA2)]);
    const gone = await a.docs.page('d1', { doc: 'Energy Yield Report.pdf', docId: idOf(EYR) }, 'p. 1'); expect(!gone.ok && gone.error.kind).toBe('notFound');   // a citation to it says the file cannot be found
    // another PC reads the same: nothing is left of the two that went
    expect(names(pc(root, 'home'))).toEqual(names(a));
    // a PC with only part of the folder: what it lacks it never saw, so it takes nothing away
    const part = path.join(root, 'partial'); put(part, '01 Legal/Shareholders Agreement.pdf', SHA); const b = pc(root, 'laptop', new StandInService(), { folders: [vdr] });
    val(await b.docs.mapFolder('d1', vdr, part, true)); await indexAll(b, vdr); expect(names(a)).toEqual(['Credit Agreement.pdf', 'Model v12.xlsx', 'Notes.docx', 'Shareholders Agreement.pdf']);
    expect(fs.readFileSync(path.join(root, 'shared', 'docs-laptop-d1.jsonl'), 'utf8')).not.toContain('"gone"');                                 // and says nothing about files it never had
    // a folder that reads as empty is taken as unreadable: nothing goes
    const hidden = path.join(root, 'vdr-hidden'); fs.renameSync(vdr, hidden); fs.mkdirSync(vdr); await indexAll(a, vdr); expect(names(a).length).toBe(4); fs.rmdirSync(vdr); fs.renameSync(hidden, vdr);
    // the report is put back: it is a document of the deal again, with what was known of it
    put(vdr, '02 Technical/Energy Yield Report.pdf', EYR); await indexAll(a, vdr); expect(names(a)).toContain('Energy Yield Report.pdf'); expect(a.docs.records('d1').find((r) => r.docId === idOf(EYR))).toMatchObject({ pages: 2, words: ['energy', 'yield'] });
  });

  it('a second PC reads what the first recorded, converts nothing again, and keeps the first summary if both wrote one', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'), b = pc(root, 'home'); await indexAll(a, vdr); a.docs.describe('d1', idOf(FA), { summary: 'office says: Credit Agreement.pdf', keywords: ['facility'] });
    expect(b.docs.records('d1').find((r) => r.name === 'Credit Agreement.pdf')).toMatchObject({ summary: 'office says: Credit Agreement.pdf', words: ['agreement', 'credit'] });
    await indexAll(b, vdr);
    const homeLines = () => fs.readFileSync(path.join(root, 'shared', 'docs-home-d1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.read === undefined);   // and one line saying it read the folder
    expect(b.converted).toEqual([]); expect(homeLines().length).toBe(5); expect(homeLines().every((l) => l.rel && !l.summary)).toBe(true);          // it says only that it sees the same five files; nothing is worked out again
    await indexAll(b, vdr); expect(homeLines().length).toBe(5);                                                                                  // and says it once
    b.docs.describe('d1', idOf(FA), { summary: 'home says otherwise', keywords: [] }); expect(homeLines().length).toBe(5);
    // both described the same document before either had the other's file: every PC settles on the earlier one
    a.docs.describe('d1', idOf(EYR), { summary: 'office says: Energy Yield Report.pdf', keywords: [] });
    const id = idOf(EYR); fs.appendFileSync(path.join(root, 'shared', 'docs-home-d1.jsonl'), JSON.stringify({ v: 1, pc: 'home', at: '2026-11-09T00:00:00.000Z', docId: id, summary: 'home said it first', keywords: [] }) + '\n');
    for (const x of [a, b]) expect(x.docs.records('d1').find((r) => r.docId === id)!.summary).toBe('home said it first');
    expect(a.docs.records('d2')).toEqual([]);                                                                                                // and another deal's documents are its own
  });

  it('the same file twice in the data room, under two names or folders, is one document: indexed, read and sent once, and still there while either copy is', async () => {
    const { root, vdr } = room(); put(vdr, '07 Archive/Credit Agreement (copy).pdf', FA); put(vdr, '01 Legal/CA final.pdf', FA);
    const a = pc(root, 'office'); await indexAll(a, vdr);
    const fas = a.docs.records('d1').filter((r) => r.docId === idOf(FA)); expect(fas.length).toBe(1);
    expect(a.docs.records('d1').length).toBe(5);                                                          // five distinct documents, not seven files
    // every place it sits is kept: the first seen, and the others as copies
    expect([fas[0].rel, ...(fas[0].copies ?? []).map((c) => c.rel)].sort()).toEqual(['01 Legal/CA final.pdf', '01 Legal/Credit Agreement.pdf', '07 Archive/Credit Agreement (copy).pdf']);
    // and the reading list is told every place, the first one first
    const places = await a.docs.places('d1', idOf(FA)); expect(places.ok && places.value.length).toBe(3); expect(places.ok && places.value[0].name).toBe(fas[0].name);
    expect(places.ok && places.value.map((p) => `${p.folder}/${p.name}`).sort()).toEqual(['vdr/01 Legal/CA final.pdf', 'vdr/01 Legal/Credit Agreement.pdf', 'vdr/07 Archive/Credit Agreement (copy).pdf']);
    // indexing again says nothing new: a copy is not said again each run (it was, flipping between its places)
    const lines = () => fs.readFileSync(path.join(root, 'shared', 'docs-office-d1.jsonl'), 'utf8').trim().split('\n').length; const before = lines(); await indexAll(a, vdr); await indexAll(a, vdr); expect(lines()).toBe(before);
    // a second PC sees the same places, and adds none
    const b = pc(root, 'home'); await indexAll(b, vdr); const onB = b.docs.records('d1').find((r) => r.docId === idOf(FA))!;
    expect([onB.rel, ...(onB.copies ?? []).map((c) => c.rel)].sort()).toEqual([fas[0].rel, ...(fas[0].copies ?? []).map((c) => c.rel)].sort());
    await a.docs.wanted('d1', [idOf(FA)]); expect(a.svc.uploads).toBeLessThanOrEqual(1);
    fs.rmSync(path.join(vdr, '01 Legal/Credit Agreement.pdf')); fs.rmSync(path.join(vdr, '01 Legal/CA final.pdf')); await indexAll(a, vdr); await indexAll(b, vdr);   // each PC says what its own copy of the folder holds
    const left = a.docs.records('d1').find((r) => r.docId === idOf(FA))!; expect(left.rel).toBe('07 Archive/Credit Agreement (copy).pdf'); expect(left.copies).toBeUndefined();   // the copy in the archive keeps it present, and is now where it is
    fs.rmSync(path.join(vdr, '07 Archive/Credit Agreement (copy).pdf')); await indexAll(a, vdr);
    expect(a.docs.records('d1').some((r) => r.docId === idOf(FA))).toBe(true);                            // the archive holds no file now, which reads as not on this PC rather than emptied: the other PC has not said its copy has gone
    await indexAll(b, vdr);
    expect(a.docs.records('d1').some((r) => r.docId === idOf(FA))).toBe(false);                            // gone once no copy is left
  });

  it('at deal scale, a document deleted or replaced on the share leaves the deal when another PC reads the folder, though the PC that first read it is no longer used; a part of the folder takes nothing away', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const N = 2000; const rel = (i: number) => `${String(1 + (i % 12)).padStart(2, '0')} Section/Document ${String(i).padStart(4, '0')}.pdf`;
    const body = (i: number) => pdf(`document ${i}`); for (let i = 0; i < N; i++) put(vdr, rel(i), body(i));
    const office = pc(root, 'office'); await indexAll(office, vdr); expect(office.docs.records('d1').length).toBe(N);
    // on the share, a new version is saved over one document and another is deleted; the first PC is not used again
    const NEW = pdf('document 50, amended', 2); fs.writeFileSync(path.join(vdr, rel(50)), NEW); fs.rmSync(path.join(vdr, rel(51)));
    const laptop = pc(root, 'laptop'); later(29); await indexAll(laptop, vdr); expect(laptop.docs.records('d1').length).toBe(N + 1);   // within timings.folderIdle the office is taken as in use, and speaks for itself
    later(2); await indexAll(laptop, vdr);                                                                                       // past it, the office is no longer used
    expect(laptop.docs.records('d1').length).toBe(N);                                       // a new version at the place proves the old one left: it goes now; a missing file waits a day, in case the copy is still coming
    later(1.5); await indexAll(laptop, vdr);                                                // still not there a day later: it goes
    for (const x of [laptop, pc(root, 'home')]) {
      const recs = x.docs.records('d1'); expect(recs.length).toBe(N - 1);                                                     // the changed document counts once, and the deleted one not at all
      expect(recs.filter((r) => r.rel === rel(50)).map((r) => r.docId)).toEqual([idOf(NEW)]); expect(recs.some((r) => r.docId === idOf(body(51)))).toBe(false);
    }
    // a PC whose copy holds only a quarter of the folder takes nothing away from the others
    const part = path.join(root, 'partial'); for (let i = 100; i < 100 + N / 4; i++) put(part, rel(i), body(i));
    const desk = pc(root, 'desk'); val(await desk.docs.mapFolder('d1', vdr, part, true)); await indexAll(desk, vdr);
    expect(laptop.docs.records('d1').length).toBe(N - 1);
    // a copy with every section but one: the missing section is not on that PC, not deleted, so nothing in it goes
    const most = path.join(root, 'most'); for (let i = 0; i < N; i++) if (!rel(i).startsWith('12 ') && i !== 51) put(most, rel(i), i === 50 ? NEW : body(i));
    const tablet = pc(root, 'tablet'); val(await tablet.docs.mapFolder('d1', vdr, most, true)); await indexAll(tablet, vdr);
    expect(laptop.docs.records('d1').length).toBe(N - 1);
    // a document put back is back once a PC reads the folder again
    put(vdr, rel(51), body(51)); await indexAll(laptop, vdr); expect(laptop.docs.records('d1').length).toBe(N);
  }, 240000);

  it('at deal scale, a folder inside the data room that this person may not open is left out and named, and the rest is indexed; nothing in it leaves the deal, and it is read once it opens', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const N = 2000; const rel = (i: number) => `${String(1 + (i % 12)).padStart(2, '0')} Section/Document ${String(i).padStart(4, '0')}.pdf`;
    const body = (i: number) => pdf(`document ${i}`); for (let i = 0; i < N; i++) put(vdr, rel(i), body(i));
    const DEEP = pdf('deep'); put(vdr, '03 Section/Inner/Deep.pdf', DEEP);                               // a folder inside the closed one is not reached either
    const in3 = Array.from({ length: N }, (_, i) => i).filter((i) => rel(i).startsWith('03 ')).length + 1;
    // a folder whose path matches, and everything in it, fails with this error, as for a person the data room's permissions keep out
    let opened = () => {};
    const closing = (dirs: RegExp, code = 'EACCES') => {
      // the folder itself can be looked at, but not listed; nothing in it can be looked at
      const inside = (p: unknown, self: boolean) => typeof p === 'string' && p.split(path.sep).some((_, i, a) => i > 0 && (self || i < a.length - 1) && dirs.test(a.slice(0, i + 1).join(path.sep)));
      const no = () => { throw Object.assign(new Error(code), { code }); }; const held: [string, unknown][] = [];
      for (const name of ['readdirSync', 'statSync', 'openSync', 'readFileSync', 'createReadStream', 'existsSync'] as const) { const real = fs[name] as (...a: unknown[]) => unknown; held.push([name, real]); (fs as unknown as Record<string, unknown>)[name] = (p: unknown, ...r: unknown[]) => (inside(p, name === 'readdirSync') ? (name === 'existsSync' ? false : no()) : real(p, ...r)); }
      opened = () => { for (const [name, real] of held.splice(0)) (fs as unknown as Record<string, unknown>)[name] = real; };
      return { mockRestore: opened };
    };
    const office = pc(root, 'office'); const count = (x: ReturnType<typeof pc>) => x.docs.records('d1').length;
    try {
      // a new deal, with one section closed to this person from the start: the rest is indexed, and the run finishes
      let spy = closing(/03 Section$/);
      let p = await indexAll(office, vdr);
      expect(p.done).toBe(true); expect(p.stopped).toBeUndefined(); expect(count(office)).toBe(N + 1 - in3);
      expect(p.folders).toMatchObject([{ path: vdr, files: N + 1 - in3, indexed: N + 1 - in3 }]);
      expect(p.log).toContain('1 folder could not be opened: 03 Section');
      // it opens: its documents are read in
      spy.mockRestore(); p = await indexAll(office, vdr); expect(count(office)).toBe(N + 1); expect(p.log.join(' ')).not.toContain('could not be opened');
      // closed again (a permission taken away): this PC saw its documents there, and none of them leaves
      spy = closing(/03 Section$/); later(31); p = await indexAll(office, vdr); expect(p.done).toBe(true); expect(count(office)).toBe(N + 1);
      // its documents are out of reach, by that folder, and a document anywhere else is not shut; opening or sending one says nothing of it having left
      const ids3 = office.docs.records('d1').filter((r) => r.rel.startsWith('03 ')).map((r) => r.docId); const other = office.docs.records('d1').find((r) => r.rel.startsWith('04 '))!.docId;
      expect(office.docs.away('d1', ids3).sort()).toEqual([...ids3].sort());          // asked only of what could not be sent
      expect([...new Set(office.docs.shut('d1', [...ids3, other]).values())]).toEqual(['03 Section']); expect(office.docs.shut('d1', [other]).size).toBe(0);
      expect(await office.docs.wanted('d1', ids3.slice(0, 3))).toEqual([]); expect(count(office)).toBe(N + 1);
      // another PC that may not open it either, reading after the office is no longer used, and again a few days later: nothing in it goes
      const laptop = pc(root, 'laptop'); later(31); await indexAll(laptop, vdr); later(2); await indexAll(laptop, vdr);
      for (const x of [office, laptop, pc(root, 'home')]) expect(count(x)).toBe(N + 1);
      // a folder inside a section, closed on its own (EPERM): the section's own files are read, and the document inside stays
      spy.mockRestore(); spy = closing(/03 Section[\\/]Inner$/, 'EPERM'); later(31); p = await indexAll(office, vdr);
      expect(p.done).toBe(true); expect(p.log).toContain('1 folder could not be opened: 03 Section/Inner'); expect(count(office)).toBe(N + 1);
      expect(office.docs.records('d1').some((r) => r.docId === idOf(DEEP))).toBe(true);
      spy.mockRestore();
      // Anything else is still the data room not answering, and the run stops with nothing taken away: a section that fails
      // in another way (an i/o error), or the deal's own folder that may not be opened.
      // Every section closed, so that nothing at all lists (a sign-in to the share that lapsed after the deal's folder listed
      // gives the same errors): that is taken as the data room not answering too.
      for (const [dirs, code] of [[/05 Section$/, 'EIO'], [/[\\/]vdr$/, 'EACCES'], [/[\\/]vdr[\\/]\d\d Section$/, 'EPERM']] as const) {
        spy = closing(dirs, code); later(31); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
        expect(val(await office.docs.poll('d1'))).toMatchObject({ done: false, stopped: true, why: 'The data room stopped answering.' }); expect(count(office)).toBe(N + 1);
        spy.mockRestore();
      }
    } finally { opened(); }
  }, 240000);

  it('a PC whose copy is still arriving takes nothing away from a PC no longer used: a missing file goes only if it is still missing a day later', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const N = 2000; const rel = (i: number) => `${String(1 + (i % 12)).padStart(2, '0')} Section/Document ${String(i).padStart(4, '0')}.pdf`;
    for (let i = 0; i < N; i++) put(vdr, rel(i), pdf(`document ${i}`));
    const office = pc(root, 'office'); await indexAll(office, vdr); later(31);                  // and is not used again
    // the laptop's copy is still syncing: 20 files have not arrived yet
    const copy = path.join(root, 'copy'); fs.cpSync(vdr, copy, { recursive: true }); const late = Array.from({ length: 20 }, (_, k) => rel(k * 97));
    for (const r of late) fs.renameSync(path.join(copy, r), path.join(root, path.basename(r)));
    const laptop = pc(root, 'laptop'); val(await laptop.docs.mapFolder('d1', vdr, copy, true)); await indexAll(laptop, vdr);
    expect(laptop.docs.records('d1').length).toBe(N);                                        // nothing is lost
    // the sync finishes, and the laptop reads again the next day: all of them are there, and nothing is waiting to go
    for (const r of late) fs.renameSync(path.join(root, path.basename(r)), path.join(copy, r));
    later(1.5); await indexAll(laptop, vdr); expect(laptop.docs.records('d1').length).toBe(N);
    later(1.5); await indexAll(laptop, vdr); expect(laptop.docs.records('d1').length).toBe(N);
  }, 240000);

  it('a PC part-way through reading a folder is in use: what it has said so far is not taken away by another PC', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const N = 600; const rel = (i: number) => `${String(1 + (i % 12)).padStart(2, '0')} Section/Document ${String(i).padStart(4, '0')}.pdf`;
    for (let i = 0; i < N; i++) put(vdr, rel(i), pdf(`document ${i}`));
    const office = pc(root, 'office'); await indexAll(office, vdr); later(31);                  // and is not used again
    // a new version of document 50 is saved; PC P has said it sees it there, and its run is still going (or broke), so it has not said it read the folder
    const NEW = pdf('document 50, amended', 2); const h = hashBytes(NEW);
    fs.appendFileSync(path.join(root, 'shared', 'docs-p-d1.jsonl'), JSON.stringify({ v: 1, pc: 'p', at: clock(), docId: docIdFor(h), hash: h, name: path.basename(rel(50)), folder: vdr, rel: rel(50), size: NEW.length }) + '\n');
    // the laptop's copy still has the old version
    const laptop = pc(root, 'laptop'); await indexAll(laptop, vdr);
    expect(laptop.docs.records('d1').some((r) => r.docId === idOf(NEW))).toBe(true);
  }, 240000);

  it('another PC speaks for every PC only when its copy holds at least limits.sameFolder of the folder unchanged', async () => {
    expect(control.limits.sameFolder).toBe(70);
    const root = tmp(); const vdr = path.join(root, 'vdr'); const body = (i: number) => pdf(`paper ${i}`); for (let i = 0; i < 10; i++) put(vdr, `Paper ${i}.pdf`, body(i));
    const office = pc(root, 'office'); await indexAll(office, vdr); later(31);                  // and is not used again
    // a copy with 6 of the 10: a part of the folder, which takes nothing away
    const six = path.join(root, 'six'); for (let i = 0; i < 6; i++) put(six, `Paper ${i}.pdf`, body(i));
    const b = pc(root, 'six'); val(await b.docs.mapFolder('d1', vdr, six, true)); await indexAll(b, vdr); expect(office.docs.records('d1').length).toBe(10);
    // a copy with 7 of the 10: the folder, with three gone
    const seven = path.join(root, 'seven'); for (let i = 0; i < 7; i++) put(seven, `Paper ${i}.pdf`, body(i));
    const c = pc(root, 'seven'); val(await c.docs.mapFolder('d1', vdr, seven, true)); await indexAll(c, vdr); expect(office.docs.records('d1').length).toBe(10);
    later(1.5); await indexAll(c, vdr);                                                         // still not there a day later
    expect(office.docs.records('d1').map((r) => r.name).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `Paper ${i}.pdf`));
  });

  it('two PCs in use whose copies each hold a file the other lacks never take it from each other, and add at most a line a day each; a PC no longer used is spoken for after timings.folderIdle', async () => {
    expect(control.timings.folderIdle).toBe(30 * 24 * 60 * 60 * 1000);
    const root = tmp(); const vdr = path.join(root, 'vdr'); const N = 2000; const rel = (i: number) => `${String(1 + (i % 12)).padStart(2, '0')} Section/Document ${String(i).padStart(4, '0')}.pdf`;
    for (let i = 0; i < N; i++) put(vdr, rel(i), pdf(`document ${i}`));
    // each copy is the share and one file more, which never reaches the share
    const copyA = path.join(root, 'copy-a'), copyB = path.join(root, 'copy-b'); fs.cpSync(vdr, copyA, { recursive: true }); fs.cpSync(vdr, copyB, { recursive: true });
    const X = pdf('stuck on A'), E = pdf('stuck on B'); put(copyA, '01 Section/X.pdf', X); put(copyB, '01 Section/E.pdf', E);
    const a = pc(root, 'a'), b = pc(root, 'b'); val(await a.docs.mapFolder('d1', vdr, copyA, true)); val(await b.docs.mapFolder('d1', vdr, copyB, true));
    const lines = () => fs.readdirSync(path.join(root, 'shared')).filter((n) => n.startsWith('docs-')).reduce((acc, n) => acc + fs.readFileSync(path.join(root, 'shared', n), 'utf8').trim().split('\n').length, 0);
    const has = () => { const ids = new Set(a.docs.records('d1').map((r) => r.docId)); return `${ids.size} X=${ids.has(idOf(X))} E=${ids.has(idOf(E))}`; };
    await indexAll(a, vdr); await indexAll(b, vdr); const both = `${N + 2} X=true E=true`; expect(has()).toBe(both);
    // many runs, one after the other: nothing comes and goes, and no run adds a line
    const settled = lines(); const seen: string[] = [];
    for (let run = 0; run < 5; run++) for (const x of [a, b]) { await indexAll(x, vdr); seen.push(has()); }
    expect(seen).toEqual(Array(10).fill(both)); expect(lines()).toBe(settled);
    // a day on, each PC says once that it still reads the folder, and no more that day
    later(1.5); for (let run = 0; run < 3; run++) for (const x of [a, b]) await indexAll(x, vdr);
    expect(lines()).toBe(settled + 2); expect(has()).toBe(both);
    // A is no longer used: within timings.folderIdle its file stays; past it, B's next read takes it out
    later(28); await indexAll(b, vdr); expect(has()).toBe(both);
    later(2); await indexAll(b, vdr); expect(has()).toBe(both);                                  // X is not in B's copy: it waits a day
    later(1.5); await indexAll(b, vdr); expect(has()).toBe(`${N + 1} X=false E=true`);
  }, 300000);

  it('notes lost from the synced copy of this PC’s documents file are put back from the copy kept on the PC when the map is next read', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'); await indexAll(a, vdr);
    const main = path.join(root, 'shared', 'docs-office-d1.jsonl'); const whole = fs.readFileSync(main, 'utf8'); const n = a.docs.records('d1').length;
    fs.writeFileSync(main, whole.split('\n')[0] + '\n');                                   // the sync client put back an older copy
    expect(pc(root, 'home').docs.records('d1').length).toBeLessThan(n);                  // another PC reading now has only part of the map
    expect(a.docs.records('d1').length).toBe(n);                                          // the office reads the map again: its lines are back
    expect(pc(root, 'home').docs.records('d1').length).toBe(n);
  });

  it('a copy of a documents file that a sync client set aside in a conflict is read like any other, whatever it is called', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'); await indexAll(a, vdr);
    const main = path.join(root, 'shared', 'docs-office-d1.jsonl'); const text = fs.readFileSync(main, 'utf8'); const names = a.docs.records('d1').map((r) => r.name).sort();
    for (const copy of ['docs-office-d1-PC-A.jsonl', 'docs-office-d1 (1).jsonl', 'docs-office-d1 - Copy.jsonl']) {
      fs.writeFileSync(path.join(root, 'shared', copy), text); fs.writeFileSync(main, '');                          // the office's lines survive only in the copy
      const b = pc(root, 'home'); expect(b.docs.records('d1').map((r) => r.name).sort()).toEqual(names);
      fs.writeFileSync(main, text); fs.rmSync(path.join(root, 'shared', copy));
    }
    fs.writeFileSync(path.join(root, 'shared', 'docs-office-d10.jsonl'), text); expect(pc(root, 'home').docs.records('d10').length).toBe(names.length); expect(pc(root, 'home').docs.records('d1').length).toBe(names.length);   // another deal's file is that deal's
  });

  it('opening a citation finds the file again: where it was, or wherever it has been moved, and never a different file in its place', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'); await indexAll(a, vdr); a.docs.describe('d1', idOf(FA), { summary: 'office says: Credit Agreement.pdf', keywords: [] });
    const id = idOf(FA); const ref = { doc: 'Credit Agreement.pdf', docId: id }; const fileOf = (p: unknown) => a.docs.fileFor((p as { url: string }).url.replace('punchlist-doc://', ''));
    const first = val(await a.docs.page('d1', ref, 'p. 14')); expect(first).toMatchObject({ kind: 'pdf', page: 14 }); expect((first as { pages?: number }).pages).toBe(3);   // with the file's page count, for stepping through pages
    expect((first as { url: string }).url).toMatch(/^punchlist-doc:\/\/[0-9a-f-]{36}$/);                                                    // the window is given a token, never a path
    expect(fileOf(first)).toBe(path.join(vdr, '01 Legal/Credit Agreement.pdf')); expect(a.docs.fileFor('made-up')).toBeNull();
    expect(val(await a.docs.page('d1', ref, 'p. 2'))).toMatchObject({ url: (first as { url: string }).url });                               // the same file is the same token
    const noPage = val(await a.docs.page('d1', ref, 'cl. 4')); expect(noPage.kind === 'pdf' && noPage.page).toBe(1);                       // a place with no page opens on page 1
    // moved and renamed
    fs.mkdirSync(path.join(vdr, '09 Superseded')); fs.renameSync(path.join(vdr, '01 Legal/Credit Agreement.pdf'), path.join(vdr, '09 Superseded/CA (signed).pdf'));
    expect(fileOf(val(await a.docs.page('d1', ref, 'p. 2')))).toBe(path.join(vdr, '09 Superseded/CA (signed).pdf'));
    expect(a.docs.records('d1').find((r) => r.docId === id)).toMatchObject({ rel: '09 Superseded/CA (signed).pdf', name: 'CA (signed).pdf', pages: 3, words: ['agreement', 'credit'], summary: 'office says: Credit Agreement.pdf' });
    // a new draft saved over it is a different document: the citation does not quietly show it
    fs.writeFileSync(path.join(vdr, '09 Superseded/CA (signed).pdf'), pdf('credit agreement, amended', 4));
    const gone = await a.docs.page('d1', ref, 'p. 2'); expect(!gone.ok && gone.error).toEqual({ kind: 'notFound', message: 'Credit Agreement.pdf could not be found in the deal’s folders' });
    const never = await a.docs.page('d1', { doc: 'No such file.pdf', docId: 'doc_000000000000000000000000' }, 'p. 1'); expect(!never.ok && never.error.kind).toBe('notFound');
  });

  it('a Word file opens as the PDF made from it; only the last few opened are kept, and a PC with no converter says so', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const names = Array.from({ length: 23 }, (_, i) => `Memo ${String(i + 1).padStart(2, '0')}.docx`); for (const n of names) put(vdr, n, `memo ${n}`);
    const a = pc(root, 'office'); await indexAll(a, vdr); expect(a.work()).toEqual([]);
    for (const n of names) { const p = val(await a.docs.page('d1', { doc: n, docId: idOf(`memo ${n}`) }, 'p. 3')); expect(p).toMatchObject({ kind: 'pdf', page: 3 }); const f = a.docs.fileFor((p as { url: string }).url.slice('punchlist-doc://'.length))!; expect(fs.readFileSync(f, 'utf8').startsWith('%PDF')).toBe(true); }
    expect(a.work().length).toBe(20); expect(a.work()).not.toContain(`${idOf(`memo ${names[0]}`)}.pdf`); expect(a.work()).toContain(`${idOf(`memo ${names[22]}`)}.pdf`);
    const before = a.converted.length; val(await a.docs.page('d1', { doc: names[22], docId: idOf(`memo ${names[22]}`) }, 'p. 1')); expect(a.converted.length).toBe(before);   // still open: not converted again
    const b = pc(root, 'bare', new StandInService(), { convert: null }); const r = await b.docs.page('d1', { doc: names[0], docId: idOf(`memo ${names[0]}`) }, 'p. 1');
    expect(!r.ok && r.error).toEqual({ kind: 'notFound', message: 'Memo 01.docx could not be converted to PDF on this PC, so it can’t be shown here' });
  });

  it('pages made by one converter are not shown or sent from a PC that has another', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'Notes.docx', NOTES); const svc = new StandInService();
    const a = pc(root, 'office', svc); await indexAll(a, vdr); val(await a.docs.page('d1', { doc: 'Notes.docx', docId: idOf(NOTES) }, 'p. 1')); expect(a.docs.records('d1')[0]).toMatchObject({ pages: 3, via: 'stand-in' });
    const other = standInConverter('another'); const b = pc(root, 'home', new StandInService(), { convert: other.convert });
    const r = await b.docs.page('d1', { doc: 'Notes.docx', docId: idOf(NOTES) }, 'p. 2'); expect(!r.ok && r.error).toEqual({ kind: 'notFound', message: 'Notes.docx was indexed with a different converter than this PC has, so it can’t be shown here' });
    const w = await b.docs.wanted('d1', [idOf(NOTES)]); await expect(b.keeper.ensure(w)).rejects.toThrow(/different converter \(stand-in\) than this PC has \(another\)/); expect(other.calls).toEqual([]);
    await indexAll(b, vdr); expect(b.docs.records('d1')[0]).toMatchObject({ pages: 3, via: 'stand-in' }); expect(other.calls).toEqual([]);        // and indexing there does not quietly redo it
    expect(val(await a.docs.page('d1', { doc: 'Notes.docx', docId: idOf(NOTES) }, 'p. 2'))).toMatchObject({ kind: 'pdf', page: 2 });
    expect(libreOfficeConverter().id).toBe('libreoffice');
  });

  it("says a document's drafts, newest first, each with the date and folder it was read from", async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const old = pdf('old draft'), mid = pdf('middle draft'), now = pdf('newest draft');
    put(vdr, 'Drafts/2026-03-01/SPA.pdf', old); put(vdr, 'Drafts/03-20-2026/SPA.pdf', mid); put(vdr, 'Drafts/2026-04-15/SPA.pdf', now); put(vdr, 'Other.pdf', FA);
    const a = pc(root, 'office'); await indexAll(a, vdr);
    expect(val(await a.docs.drafts('d1', idOf(old)))).toEqual([{ doc: 'SPA.pdf', docId: idOf(now), date: '2026-04-15', folder: 'vdr/Drafts/2026-04-15' }, { doc: 'SPA.pdf', docId: idOf(mid), date: '2026-03-20', folder: 'vdr/Drafts/03-20-2026' }, { doc: 'SPA.pdf', docId: idOf(old), date: '2026-03-01', folder: 'vdr/Drafts/2026-03-01' }]);
    expect(val(await a.docs.drafts('d1', idOf(FA)))).toEqual([]);
  });
  it("keeps a comparison cover page with the PDF that starts with one, for every PC, and nothing for any other", async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const bl = pdf('Comparison of SPA v2.docx and SPA v3.docx. Insertions 4 Deletions 2');
    put(vdr, 'SPA v3 v v2.pdf', bl); put(vdr, 'Other.pdf', FA);
    const a = pc(root, 'office'); await indexAll(a, vdr);
    const recs = a.docs.records('d1'); expect(recs.find((r) => r.docId === idOf(bl))?.cover).toMatch(/^Comparison of SPA v2\.docx and SPA v3\.docx/); expect(recs.find((r) => r.docId === idOf(FA))?.cover).toBeUndefined();
    const b = pc(root, 'home'); expect(b.docs.records('d1').find((r) => r.docId === idOf(bl))?.cover).toMatch(/^Comparison of/);
  });
  it('two documents with one name are told apart by id', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const one = pdf('one'), two = pdf('two'); put(vdr, 'a/Report.pdf', one); put(vdr, 'b/Report.pdf', two);
    const a = pc(root, 'office'); await indexAll(a, vdr);
    expect(val(await a.docs.page('d1', { doc: 'Report.pdf', docId: idOf(two) }, 'p. 1')).kind).toBe('pdf');
  });

  it('a spreadsheet is shown as the cells around the one cited', async () => {
    const v = { kind: 'sheet', name: 'Model v12.xlsx', ...sheetPart(MODEL_SHEETS, 'Debt!B20') };
    expect(v.cell).toBe('B20'); expect(v.cols).toEqual(['A', 'B', 'C']); expect(v.rows.map((r) => r.r)).toEqual(Array.from({ length: 17 }, (_, i) => 12 + i));
    expect(v.rows.find((r) => r.r === 20)!.cells).toEqual(['Line 20', '20', '30']);
    expect(sheetPart(MODEL_SHEETS, "'debt'!C2").rows[0]).toEqual({ r: 1, cells: ['Line 1', '1', '1.5'] });
    const top = sheetPart(MODEL_SHEETS, 'Debt'); expect(top.cell).toBeUndefined(); expect(top.rows.length).toBe(40);
    // nothing recognizable: the first sheet, from the top
    expect(sheetPart(MODEL_SHEETS, 'p. 3').rows[0].cells).toEqual(['Cover']);
    const { root, vdr } = room(); const a = pc(root, 'office'); await indexAll(a, vdr);
    expect(val(await a.docs.page('d1', { doc: 'Model v12.xlsx', docId: idOf(MODEL) }, 'Debt!B20'))).toEqual(v);
  });

  it('an attached spreadsheet that cannot be read is named, and read again on the next run (#427)', async () => {
    const root = tmp();
    const vdr = path.join(root, 'vdr');
    put(vdr, 'Credit Agreement.pdf', FA);
    // a converter that cannot read any spreadsheet until `down` is set back
    let down = true;
    const flaky = () => {
      const { convert } = standInConverter();
      const read = convert.sheets!;
      const sheets = (file: string) => (down ? Promise.reject(new Error('down')) : read(file));
      return Object.assign(convert, { sheets });
    };
    const a = pc(root, 'office', undefined, { convert: flaky() });
    const r = val(await a.docs.attach('d1', { name: 'Budget.xlsx', bytes: MODEL }));
    const budget = (x: ReturnType<typeof pc>) => x.docs.records('d1').find((d) => d.docId === r.docId)!;
    expect(budget(a).words).toBeUndefined();
    expect((await indexAll(a, vdr)).log).toContain('1 file could not be read: Budget.xlsx');
    // named while it fails, and read again on the next run, without a restart
    expect((await indexAll(a, vdr)).log).toContain('1 file could not be read: Budget.xlsx');
    down = false;
    expect((await indexAll(a, vdr)).log.join(' ')).not.toContain('could not be read');
    expect(budget(a).words).toEqual(['line', 'cover', 'debt']);
  });

  it('a deal-folder spreadsheet that failed to read is read again on the next run, without a restart (#427)', async () => {
    const root = tmp();
    const vdr = path.join(root, 'vdr');
    // a converter that cannot read any spreadsheet until `down` is set back
    let down = true;
    const { convert } = standInConverter();
    const read = convert.sheets!;
    const flaky = Object.assign(convert, { sheets: (file: string) => (down ? Promise.reject(new Error('down')) : read(file)) });
    put(vdr, 'Budget.xlsx', MODEL);
    const a = pc(root, 'office', undefined, { convert: flaky });
    expect((await indexAll(a, vdr)).log).toContain('1 file could not be read: Budget.xlsx');
    const budget = () => a.docs.records('d1').find((d) => d.name === 'Budget.xlsx')!;
    expect(budget().words).toBeUndefined();
    // still down: named again, the same file, the same app session
    expect((await indexAll(a, vdr)).log.join(' ')).toContain('could not be read');
    down = false;
    expect((await indexAll(a, vdr)).log.join(' ')).not.toContain('Budget.xlsx');
    expect(budget().words).toEqual(['line', 'cover', 'debt']);
  });

  it('a file attached in the app is kept in the shared folder under this copy’s own name, loaded into the store, and opens on another PC', async () => {
    const { root } = room(); const svc = new StandInService(); const a = pc(root, 'office', svc), b = pc(root, 'home', svc);
    const bytes = pdf('term sheet', 2); const r = val(await a.docs.attach('d1', { name: 'Term sheet: v3.pdf', bytes }));
    expect(r).toEqual({ doc: 'Term sheet: v3.pdf', docId: idOf(bytes) }); expect(val(await a.docs.cached())).toEqual([r.docId]);
    expect(a.docs.records('d1')[0]).toMatchObject({ name: 'Term sheet: v3.pdf', pages: 2, rel: `d1/office/${r.docId}.pdf` });
    expect(val(await a.docs.attach('d1', { name: 'Term sheet: v3.pdf', bytes }))).toEqual(r); expect(svc.uploads).toBe(1);                    // the same file again is the same document
    const page = val(await b.docs.page('d1', { doc: r.doc, docId: r.docId }, 'p. 2'));
    expect(fs.readFileSync(b.docs.fileFor((page as { url: string }).url.slice('punchlist-doc://'.length))!)).toEqual(Buffer.from(bytes));
    expect((await b.docs.wanted('d1', [r.docId, 'doc_000000000000000000000000'])).map((w) => w.name)).toEqual(['Term sheet: v3.pdf']);
    // a Word file is attached as pages too; one that will not convert, or a PDF that will not open, is not attached at all
    const memo = val(await a.docs.attach('d1', { name: 'Memo.docx', bytes: new TextEncoder().encode('memo') })); expect(a.docs.records('d1').find((x) => x.docId === memo.docId)).toMatchObject({ pages: 3 });
    expect([...svc.files.values()].map((f) => fromStoreName(f.name)!.name)).toContain('Memo.docx.pdf'); expect(a.work()).toEqual([]);
    const locked = await a.docs.attach('d1', { name: 'Locked.docx', bytes: new TextEncoder().encode('locked') }); expect(!locked.ok && locked.error).toEqual({ kind: 'rejected', message: 'Locked.docx could not be converted to PDF, so it was not attached' });
    const broken = await a.docs.attach('d1', { name: 'Broken.pdf', bytes: new TextEncoder().encode('junk') }); expect(!broken.ok && broken.error.message).toBe('Broken.pdf could not be opened, so it was not attached');
    expect(a.docs.records('d1').length).toBe(2); expect(fs.readdirSync(path.join(root, 'shared', 'attachments', 'd1', 'office')).length).toBe(2);
  });

  it('a file attached again after its copy left the deal folder is saved and sent (#34)', async () => {
    const { root, vdr } = room();
    const svc = new StandInService();
    const office = pc(root, 'office', svc);
    const docId = idOf(FA);
    await indexAll(office, vdr);
    fs.rmSync(path.join(vdr, '01 Legal', 'Credit Agreement.pdf'));
    await indexAll(office, vdr);
    expect(await office.docs.wanted('d1', [docId])).toEqual([]);                  // the deal no longer has it
    const uploads = svc.uploads;
    const ref = val(await office.docs.attach('d1', { name: 'Credit Agreement.pdf', bytes: FA }));
    expect(ref.docId).toBe(docId);
    expect(svc.uploads).toBe(uploads + 1);
    expect(await office.docs.wanted('d1', [docId])).toHaveLength(1);
    const page = val(await office.docs.page('d1', ref, 'p. 1')) as { url: string };
    const opened = office.docs.fileFor(page.url.slice('punchlist-doc://'.length));
    expect(fs.readFileSync(opened!)).toEqual(Buffer.from(FA));
  });

  it('files attached on a deal deleted elsewhere become its copy’s, once, and open on another PC (#117)', async () => {
    const { root, vdr } = room();
    const svc = new StandInService();
    const office = pc(root, 'office', svc), home = pc(root, 'home', svc);
    await indexAll(office, vdr);
    const names = Array.from({ length: 8 }, (_, i) => `Lender consent ${i + 1}.pdf`);
    const attached: { doc: string; docId: string }[] = [];
    for (const name of names) attached.push(val(await office.docs.attach('d1', { name, bytes: pdf(name, 2) })));
    const fromHome = val(await home.docs.attach('d1', { name: 'Side letter.pdf', bytes: pdf('side letter', 1) }));
    const journals = () => office.shared.list().filter((name) => name.endsWith('.jsonl'));
    const journal = () => journals().map((name) => office.shared.read(name)).join('');
    val(await office.docs.carryAttached!('d1', 'd2'));
    const carried = office.docs.records('d2');
    // the attached files, this PC's and the other's, and none of the data room's (the copy indexes those again)
    expect(carried.map((r) => r.name).sort()).toEqual([...names, 'Side letter.pdf'].sort());
    const first = attached[0].docId;
    expect(carried.find((r) => r.docId === first)).toMatchObject({ rel: `d1/office/${first}.pdf` });
    const before = journal();
    val(await office.docs.carryAttached!('d1', 'd2'));
    expect(journal()).toBe(before);                                               // carried once
    expect(val(await office.docs.unsendable!('d2', [...attached.map((a) => a.docId), fromHome.docId]))).toEqual([]);
    const page = val(await home.docs.page('d2', attached[7], 'p. 2')) as { url: string };
    const opened = home.docs.fileFor(page.url.slice('punchlist-doc://'.length))!;
    expect(fs.readFileSync(opened)).toEqual(Buffer.from(pdf(names[7], 2)));
  });

  it('a carry from a deal with nothing synced here writes nothing and is unresolved, not done (#744)', async () => {
    const { root } = room();
    const office = pc(root, 'office');
    expect(val(await office.docs.carryAttached!('d_never_synced', 'd2'))).toEqual({ written: 0, unresolved: 1 });
  });

  it('a carry of 2,000 attached files finishes in one pass and a repeat has nothing left (#744)', async () => {
    const { root } = room();
    const office = pc(root, 'office');
    const attached: string[] = [];
    for (let i = 1; i <= 2000; i++) {
      attached.push(val(await office.docs.attach('d1', { name: `Consent ${i}.pdf`, bytes: pdf(`c${i}`, 1) })).docId);
    }
    expect(val(await office.docs.carryAttached!('d1', 'd2'))).toEqual({ written: 2000, unresolved: 0 });
    expect(val(await office.docs.carryAttached!('d1', 'd2'))).toEqual({ written: 0, unresolved: 0 });
    expect(val(await office.docs.unsendable!('d2', attached))).toEqual([]);
  }, 120_000);

  it('a carry from a deal that has files but none attached is done, with nothing to write (#744)', async () => {
    const { root, vdr } = room();
    const office = pc(root, 'office');
    await indexAll(office, vdr);
    expect(office.docs.records('d1').length).toBeGreaterThan(0);
    expect(val(await office.docs.carryAttached!('d1', 'd2'))).toEqual({ written: 0, unresolved: 0 });
  });

  it('a carry reports attached files whose shared copy is gone, and writes none twice (#744)', async () => {
    const { root } = room();
    const office = pc(root, 'office');
    const attached: { doc: string; docId: string }[] = [];
    for (let i = 1; i <= 30; i++) {
      attached.push(val(await office.docs.attach('d1', { name: `Consent ${i}.pdf`, bytes: pdf(`c${i}`, 1) })));
    }
    expect(val(await office.docs.carryAttached!('d1', 'd2'))).toEqual({ written: 30, unresolved: 0 });
    const folder = path.join(root, 'shared', 'attachments', 'd1', 'office');
    for (const lost of attached.slice(0, 3)) fs.rmSync(path.join(folder, `${lost.docId}.pdf`));
    const journals = () => office.shared.list().filter((n) => n.endsWith('.jsonl'));
    const journal = () => journals().map((n) => office.shared.read(n)).join('');
    const before = journal();
    expect(val(await office.docs.carryAttached!('d1', 'd2'))).toEqual({ written: 0, unresolved: 3 });
    expect(journal()).toBe(before);
  });

  it('a file whose copy in the shared folder is gone is named as one that cannot be sent (#671)', async () => {
    const { root } = room();
    const office = pc(root, 'office');
    const kept = val(await office.docs.attach('d1', { name: 'Term sheet.pdf', bytes: pdf('term sheet', 2) }));
    const gone = val(await office.docs.attach('d1', { name: 'Fee letter.pdf', bytes: pdf('fee letter', 1) }));
    fs.rmSync(path.join(root, 'shared', 'attachments', 'd1', 'office', `${gone.docId}.pdf`));
    const never = 'doc_000000000000000000000000';
    expect(val(await office.docs.unsendable!('d1', [kept.docId, gone.docId, never]))).toEqual([gone.docId, never]);
  });

  it('a file with a name too long to fit beside its id attaches, kept under its id and known by its own name', async () => {
    const { root } = room(); const a = pc(root, 'office'); const name = LONG.replace(/\.docx$/, '.pdf'); const bytes = pdf('redline', 2);
    const r = val(await a.docs.attach('d1', { name, bytes })); expect(r.doc).toBe(name);
    expect(fs.readdirSync(path.join(root, 'shared', 'attachments', 'd1', 'office'))).toEqual([`${r.docId}.pdf`]);
    const rec = a.docs.records('d1')[0]; expect(rec.name).toBe(name); expect(roomPath(rec)).toBe(`@attachments/d1/office/${name}`);      // the model is shown its name, not its id
    const usd = val(await a.docs.attach('d1', { name: "Revenue US$'000.pdf", bytes: pdf('revenue', 1) })); expect(roomPath(a.docs.records('d1').find((x) => x.docId === usd.docId)!)).toBe("@attachments/d1/office/Revenue US$'000.pdf");   // a $ in a name is only a $
    // a name with no extension a file could have is kept under its id alone
    const odd = val(await a.docs.attach('d1', { name: 'Notes.v12 final', bytes: MODEL })); expect(a.docs.records('d1').find((x) => x.docId === odd.docId)!.rel).toBe(`d1/office/${odd.docId}`);
  });

  it('a file attached on Home is kept with the person’s own files, in no deal, and opens on another PC', async () => {
    const { root } = room();
    const svc = new StandInService();
    const a = pc(root, 'office', svc),
      b = pc(root, 'home', svc);
    const own = ownFilesId('adoe');
    const bytes = pdf('board minutes', 2); const r = val(await a.docs.attach(own, { name: 'Board minutes.pdf', bytes }));
    expect(fs.readdirSync(path.join(root, 'shared', 'attachments', own, 'office'))).toEqual([`${r.docId}.pdf`]);
    expect(a.docs.records('d1').some((x) => x.docId === r.docId)).toBe(false);
    const page = val(await b.docs.page(own, { doc: r.doc, docId: r.docId }, 'p. 2'));
    expect(fs.readFileSync(b.docs.fileFor((page as { url: string }).url.slice('punchlist-doc://'.length))!)).toEqual(Buffer.from(bytes));
  });

  it('nothing throws: a shared folder that cannot be reached, or is full, comes back as a failure the app knows', async () => {
    const { root, vdr } = room(); const real = nodeFolder(path.join(root, 'shared')); let state: 'ok' | 'down' | 'full' = 'ok';
    const flaky: Folder = { list: () => { if (state === 'down') throw new Error('EIO'); return real.list(); }, size: (n) => real.size(n), read: (n) => { if (state === 'down') throw new Error('EIO'); return real.read(n); },
      append: (n, x) => { if (state === 'full') { const e: any = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } if (state === 'down') throw new Error('EIO'); real.append(n, x); }, write: (n, x) => real.write(n, x) };
    const a = pc(root, 'office', new StandInService(), { shared: flaky }); await indexAll(a, vdr);
    state = 'down';
    for (const r of [await a.docs.page('d1', { doc: 'Credit Agreement.pdf', docId: idOf(FA) }, 'p. 1'), await a.docs.index('d1', [folder(vdr)]), await a.docs.attach('d1', { name: 'New.pdf', bytes: pdf('new') })]) expect(!r.ok && r.error.kind).toBe('unreachable');
    state = 'full'; const full = await a.docs.attach('d1', { name: 'New.pdf', bytes: pdf('new') }); expect(!full.ok && full.error.kind).toBe('storageFull');
    state = 'ok'; expect(val(await a.docs.attach('d1', { name: 'New.pdf', bytes: pdf('new') })).doc).toBe('New.pdf');
  });
});

describe('a deal folder that is somewhere else on this PC', () => {
  it('is pointed at once, after checking it is the same folder; then nothing is recorded or converted a second time', async () => {
    const { root, vdr } = room(); const office = pc(root, 'office'); await indexAll(office, vdr);
    const here = path.join(root, 'home-drive', 'Proseware data room'); fs.mkdirSync(path.dirname(here)); fs.renameSync(vdr, here);             // on the home PC the same folder has another path
    const home = pc(root, 'home'); const fa = { doc: 'Credit Agreement.pdf', docId: idOf(FA) };
    expect(await home.docs.folders('d1')).toEqual([{ folder: vdr, local: vdr, found: false }]);
    const lost = await home.docs.page('d1', fa, 'p. 1'); expect(!lost.ok && lost.error.kind).toBe('notFound');
    const no = await home.docs.index('d1', [folder(vdr)]); expect(!no.ok && no.error).toEqual({ kind: 'notFound', message: `${vdr} could not be opened on this PC` });
    // a different folder is refused; a partial copy is left to the person; the real one is taken
    const other = path.join(root, 'something else'); put(other, 'Unrelated.pdf', pdf('unrelated'));
    const wrong = await home.docs.mapFolder('d1', vdr, other); expect(!wrong.ok && wrong.error).toEqual({ kind: 'rejected', message: `None of the 5 documents checked are in ${other}. It is not the same folder.` });
    const part = path.join(root, 'partial'); put(part, '01 Legal/Credit Agreement.pdf', FA); put(part, '02 Technical/Energy Yield Report.pdf', EYR);
    expect(val(await home.docs.mapFolder('d1', vdr, part))).toEqual({ folder: vdr, matched: 2, checked: 5, saved: false });
    expect(await home.docs.matchFolder('d1', here)).toEqual([{ folder: vdr, matched: 5, checked: 5 }]);
    expect(val(await home.docs.mapFolder('d1', vdr, here))).toEqual({ folder: vdr, matched: 5, checked: 5, saved: true });
    expect(await home.docs.folders('d1')).toEqual([{ folder: vdr, local: here, found: true }]);
    const page = val(await home.docs.page('d1', fa, 'p. 2')); expect(home.docs.fileFor((page as { url: string }).url.slice('punchlist-doc://'.length))).toBe(path.join(here, '01 Legal/Credit Agreement.pdf'));
    const p = await indexAll(home, vdr); expect(p.folders).toMatchObject([{ path: vdr, files: 5, indexed: 5, reviewed: 0 }]);
    expect(fs.readFileSync(path.join(root, 'shared', 'docs-home-d1.jsonl'), 'utf8').trim().split('\n').length).toBe(6); expect(home.converted).toEqual([]);   // five lines saying it sees the same files, one that it read the folder; nothing converted
    expect(office.docs.records('d1').find((r) => r.docId === fa.docId)).toMatchObject({ folder: vdr, rel: '01 Legal/Credit Agreement.pdf' });   // what the office recorded still stands
    // remembered after a restart; and a partial copy can be accepted by a person who has seen the numbers
    expect(await pc(root, 'home').docs.folders('d1')).toEqual([{ folder: vdr, local: here, found: true }]);
    expect(val(await home.docs.mapFolder('d1', vdr, part, true))).toEqual({ folder: vdr, matched: 2, checked: 5, saved: true });
    const none = await home.docs.mapFolder('d1', 'C:\\not a folder of this deal', here); expect(!none.ok && none.error.kind).toBe('notFound');
  });

  it('with nothing recorded yet there is nothing to check against, so it is saved only when a person accepts it', async () => {
    const { root, vdr } = room(); const a = pc(root, 'office'); const here = path.join(root, 'moved'); fs.renameSync(vdr, here);
    expect(val(await a.docs.mapFolder('d1', vdr, here))).toEqual({ folder: vdr, matched: 0, checked: 0, saved: false });
    expect(val(await a.docs.mapFolder('d1', vdr, here, true)).saved).toBe(true);
    const p = await indexAll(a, vdr); expect(p.log[0]).toBe('Indexed 5 files'); expect(a.docs.records('d1')[0].folder).toBe(vdr);
  });
});

describe('deal folders on a PC where they are somewhere else', () => {
  // 12 deals and 46 folders on the PC that made them: 11 deals under N/Deals/2026, and another team's share with all of Coho and one folder of First Up
  const DEALS = ['Proseware', 'Wingtip', 'Coho', 'Alpine', 'Munson', 'Margie', 'Trey', 'Yonder', 'Fourth Coffee', 'Wide World', 'City Power', 'First Up'];
  const COUNTS = [6, 5, 3, 4, 4, 3, 5, 3, 4, 3, 3, 3];
  const SUBS = ['01 Corporate', '02 Commercial', '03 Finance', '04 Technical', '05 Permits', '06 Insurance'];
  function deals(root: string) {
    const by: Record<string, string[]> = {};
    DEALS.forEach((d, i) => { by[d] = Array.from({ length: COUNTS[i] }, (_, k) => d === 'Coho' || (d === 'First Up' && k === 0) ? path.join(root, 'N', 'Team', 'Shared', `Project ${d}`, SUBS[k]) : path.join(root, 'N', 'Deals', '2026', `Project ${d}`, 'Data Room', SUBS[k])); });
    return by;
  }
  function machine(root: string, name: string, by: Record<string, string[]>) {
    const svc = new StandInService(); const local = nodeFolder(path.join(root, `local-${name}`));
    const keeper = new StoreKeeper(svc, local, { limit: 500, clock, recheckMs: 0 });
    return nodeDocuments({ shared: nodeFolder(path.join(root, 'shared')), local, sharedPath: path.join(root, 'shared'), installId: name, keeper, clock, workPath: path.join(root, `work-${name}`), convert: standInConverter().convert, folders: async (d) => by[d] ?? [], home: path.join(root, 'home') });
  }
  async function made() {
    const root = tmp(); const by = deals(root);
    for (const [d, folders] of Object.entries(by)) folders.forEach((f, k) => { put(f, 'a.pdf', pdf(`${d} ${k} a`)); put(f, 'Sub/b.pdf', pdf(`${d} ${k} b`)); });
    const office = machine(root, 'office', by);
    for (const [d, folders] of Object.entries(by)) { val(await office.index(d, folders.map(folder))); await office.settled(d); }
    // on the home PC the deals' share is \\server\deals (here server/deals),
    // and the other team's share \\nas02\team (nas02/team)
    fs.mkdirSync(path.join(root, 'server')); fs.renameSync(path.join(root, 'N', 'Deals'), path.join(root, 'server', 'deals'));
    fs.mkdirSync(path.join(root, 'nas02'));
    fs.renameSync(path.join(root, 'N', 'Team'), path.join(root, 'nas02', 'team'));
    return { root, by };
  }
  const ids = DEALS;

  it('locating one top folder finds every folder under it, and the other team’s share is located on its own; nothing is saved until confirmed', async () => {
    const { root, by } = await made(); const home = machine(root, 'home', by);
    expect(Object.values(by).flat().length).toBe(46);
    const first = val(await home.findFolders(ids));
    expect(first.placed).toBe(0); expect(first.missing).toBe(46);
    expect(first.tops.map((t) => [t.top, t.folders.length])).toEqual([
      [path.join(root, 'N', 'Deals', '2026'), 42],
      [path.join(root, 'N', 'Team', 'Shared'), 4],
    ]);
    // the person points N/Deals/2026 at server/deals/2026: all 42 are found, each at its own place
    const found = val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')));
    expect(found.length).toBe(42);
    // picking the share itself, one above the folder asked for, finds the same 42
    expect(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals')))).toEqual(found);
    for (const p of found) expect(p.local).toBe(p.folder.replace(path.join(root, 'N', 'Deals'), path.join(root, 'server', 'deals')));
    expect((await home.folders('Proseware')).every((f) => !f.found)).toBe(true);                          // not saved yet
    expect(val(await home.placeFolders(found))).toBe(42);
    expect((await home.folders('Proseware')).every((f) => f.found)).toBe(true);
    const second = val(await home.findFolders(ids));
    expect(second.missing).toBe(4);
    expect(second.tops.map((t) => t.top)).toEqual([path.join(root, 'N', 'Team', 'Shared')]);
    // the other team's share is somewhere else again: the rule from the first does not reach it, so it is located by hand
    const infra = val(
      await home.locateTop(ids, path.join(root, 'N', 'Team', 'Shared'), path.join(root, 'nas02', 'team', 'Shared')),
    );
    expect(infra.map((p) => p.dealId).sort()).toEqual(['Coho', 'Coho', 'Coho', 'First Up']);
    expect(val(await home.placeFolders(infra))).toBe(4);
    expect(val(await home.findFolders(ids))).toEqual({ placed: 0, missing: 0, tops: [] });
    // remembered after a restart, and a document opens from its new place
    const again = machine(root, 'home', by);
    for (const d of ids) expect((await again.folders(d)).every((f) => f.found)).toBe(true);
  });

  it('a deal added later is found by itself from what was located before; a wrong folder or a changed copy is not taken', async () => {
    const { root, by } = await made(); const home = machine(root, 'home', by);
    val(await home.placeFolders(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')))));
    // a 13th deal, made on the first PC afterwards: the rule learned here places it without asking
    const late = path.join(root, 'N', 'Deals', '2026', 'Project Liberty', 'Data Room');
    put(late, 'w.pdf', pdf('liberty')); by.Liberty = [late];
    const office = machine(root, 'office', by); val(await office.index('Liberty', [folder(late)])); await office.settled('Liberty');
    fs.mkdirSync(path.join(root, 'server', 'deals', '2026', 'Project Liberty'), { recursive: true }); fs.renameSync(late, path.join(root, 'server', 'deals', '2026', 'Project Liberty', 'Data Room'));
    const home2 = machine(root, 'home', by);
    expect(val(await home2.findFolders(['Liberty']))).toEqual({ placed: 1, missing: 0, tops: [] });
    expect(await home2.folders('Liberty')).toEqual([{ folder: late, local: path.join(root, 'server', 'deals', '2026', 'Project Liberty', 'Data Room'), found: true }]);
    // pointing at an unrelated folder finds nothing; a copy where a document differs is not the same folder
    const other = path.join(root, 'elsewhere'); put(other, 'x.pdf', pdf('x'));
    expect(val(await home2.locateTop(ids, path.join(root, 'N', 'Team', 'Shared'), other))).toEqual([]);
    const coho = path.join(root, 'nas02', 'team', 'Shared', 'Project Coho', '01 Corporate', 'a.pdf');
    fs.writeFileSync(coho, pdf('changed'));
    const infra = val(
      await home2.locateTop(ids, path.join(root, 'N', 'Team', 'Shared'), path.join(root, 'nas02', 'team', 'Shared')),
    );
    expect(infra.length).toBe(3); expect(infra.some((p) => p.dealId === 'Coho' && p.local.endsWith('01 Corporate'))).toBe(false);
    const gone = await home2.locateTop(ids, path.join(root, 'N'), path.join(root, 'no such folder')); expect(!gone.ok && gone.error.kind).toBe('notFound');
  });

  it('a copy that lacks a document is not taken by itself, even one outside the documents checked by content', async () => {
    const { root, by } = await made(); const home = machine(root, 'home', by);
    val(await home.placeFolders(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')))));
    // 30 documents, more than the 25 checked by content; the copy on this PC lacks the newest
    const late = path.join(root, 'N', 'Deals', '2026', 'Project Datum', 'Data Room'); by.Datum = [late];
    for (let i = 1; i <= 30; i++) put(late, `doc-${String(i).padStart(3, '0')}.pdf`, pdf(`datum ${i}`));
    const office = machine(root, 'office', by); val(await office.index('Datum', [folder(late)])); await office.settled('Datum');
    const here = path.join(root, 'server', 'deals', '2026', 'Project Datum', 'Data Room');
    fs.mkdirSync(path.dirname(here), { recursive: true }); fs.renameSync(late, here); fs.rmSync(path.join(here, 'doc-030.pdf'));
    const home2 = machine(root, 'home', by);
    expect(val(await home2.findFolders(['Datum']))).toMatchObject({ placed: 0, missing: 1 });
    // once the document is there too, it is the same folder
    put(here, 'doc-030.pdf', pdf('datum 30'));
    expect(val(await home2.findFolders(['Datum']))).toEqual({ placed: 1, missing: 0, tops: [] });
  });

  it('a deal folder that reads as empty keeps its documents, is said apart from a missing one, and is located where its files went', async () => {
    const { root, by } = await made(); const home = machine(root, 'home', by);
    val(await home.placeFolders(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')))));
    const before = home.records('Proseware').length; expect(before).toBe(12);
    // Proseware's data room moves to another share; its old folders stay behind, each with nothing but a file the system keeps
    const was = path.join(root, 'server', 'deals', '2026', 'Project Proseware'); const moved = path.join(root, 'nas03', 'deals', '2026', 'Project Proseware');
    fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.cpSync(was, moved, { recursive: true });
    for (const k of SUBS.slice(0, 6)) { const at = path.join(was, 'Data Room', k); fs.rmSync(at, { recursive: true, force: true }); fs.mkdirSync(at); fs.writeFileSync(path.join(at, 'desktop.ini'), '[.ShellClassInfo]'); }
    const now = val(await home.findFolders(ids));
    expect(now.missing).toBe(4);                                                                        // the other team's share, not located yet
    expect(now.empty?.map((f) => f.folder)).toEqual(by.Proseware);
    expect(now.tops.flatMap((t) => t.folders).filter((f) => f.dealId === 'Proseware').length).toBe(6);  // listed to locate, with the missing ones
    // nothing has left the deal, and reading the folders again takes nothing away
    val(await home.index('Proseware', by.Proseware.map(folder))); await home.settled('Proseware');
    expect(home.records('Proseware').length).toBe(before);
    // the empty folders themselves are never taken as the data room, even pointed at
    expect(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')))).toEqual([]);
    const found = val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'nas03', 'deals', '2026')));
    expect(found.length).toBe(6); expect(found.every((p) => p.dealId === 'Proseware' && p.local.startsWith(moved))).toBe(true);
    expect(val(await home.placeFolders(found))).toBe(6);
    const after = val(await home.findFolders(ids)); expect(after.empty).toBeUndefined(); expect(after.missing).toBe(4);
  });

  it('a folder with nothing recorded in it is never said to be empty, and is located as before, even where it is empty', async () => {
    const { root, by } = await made();
    // a deal made just now, its folder still empty, with nothing recorded: nothing to say, at its place or another
    const fresh = path.join(root, 'server', 'deals', '2026', 'Project New', 'Data Room'); fs.mkdirSync(fresh, { recursive: true }); by.New = [fresh];
    const blank = path.join(root, 'N', 'Deals', '2026', 'Project Blank', 'Data Room'); by.Blank = [blank];
    const home = machine(root, 'home', by);
    const now = val(await home.findFolders(['New', 'Blank']));
    expect(now.empty).toBeUndefined(); expect(now.missing).toBe(1); expect(now.tops.flatMap((t) => t.folders).map((f) => f.dealId)).toEqual(['Blank']);
    // Blank is missing here, and its place on this PC is empty too: a person pointing at it still places it
    const there = path.join(root, 'server', 'deals', '2026', 'Project Blank', 'Data Room'); fs.mkdirSync(there, { recursive: true });
    const found = val(await home.locateTop(['Blank'], path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')));
    expect(found).toEqual([{ dealId: 'Blank', folder: blank, local: there }]);
  });

  it('a deal folder whose every file was deleted keeps its documents and reads as empty until a person removes it or points at another', async () => {
    const { root, by } = await made(); const home = machine(root, 'home', by);
    val(await home.placeFolders(val(await home.locateTop(ids, path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')))));
    const f = by.Wingtip[0]; const local = (await home.folders('Wingtip')).find((x) => x.folder === f)!.local;
    for (const n of fs.readdirSync(local)) fs.rmSync(path.join(local, n), { recursive: true, force: true });
    const before = home.records('Wingtip').length;
    expect(val(await home.findFolders(['Wingtip'])).empty).toEqual([{ dealId: 'Wingtip', folder: f }]);
    expect(val(await home.findFolders(['Wingtip'])).missing).toBe(0);
    expect(home.records('Wingtip').length).toBe(before);
  });

  it('a folder a person points at is taken when the documents checked are the same, though the data room changed since it was read; read again here, it is as it is now', async () => {
    const { root, by } = await made();
    const late = path.join(root, 'N', 'Deals', '2026', 'Project Datum', 'Data Room'); by.Datum = [late];
    for (let i = 1; i <= 30; i++) put(late, `doc-${String(i).padStart(3, '0')}.pdf`, pdf(`datum ${i}`));
    const office = machine(root, 'office', by); val(await office.index('Datum', [folder(late)])); await office.settled('Datum');
    const here = path.join(root, 'server', 'deals', '2026', 'Project Datum', 'Data Room');
    fs.mkdirSync(path.dirname(here), { recursive: true }); fs.renameSync(late, here);
    // since it was read, one document was taken out of the data room and one replaced, both past the 25 checked by content
    fs.rmSync(path.join(here, 'doc-030.pdf')); fs.writeFileSync(path.join(here, 'doc-029.pdf'), pdf('datum 29, revised'));
    const home = machine(root, 'home', by);
    expect(val(await home.findFolders(['Datum']))).toMatchObject({ placed: 0, missing: 1 });              // not taken without a person
    const found = val(await home.locateTop(['Datum'], path.join(root, 'N', 'Deals', '2026'), path.join(root, 'server', 'deals', '2026')));
    expect(found).toEqual([{ dealId: 'Datum', folder: late, local: here }]);
    expect(val(await home.placeFolders(found))).toBe(1);
    // read again on this PC: the replaced document is read as it is now (one taken out is gone once every PC that saw it says so)
    const was = office.records('Datum').find((r) => r.name === 'doc-029.pdf')!.hash;
    val(await home.index('Datum', [folder(late)])); await home.settled('Datum');
    expect(home.records('Datum').some((r) => r.name === 'doc-029.pdf' && r.hash !== was)).toBe(true);
  });
});

describe('who is using the app', () => {
  const local = () => nodeFolder(path.join(tmp(), 'local'));
  it('the name and the models come from the model service, and there is no firm or job title', async () => {
    const l = local(); const s = nodeSession({ service: new StandInService(), local: l, clock: () => '2026-11-10T09:00:00.000Z' });
    expect(val(await s.load())).toEqual({
      user: { name: 'adoe', initials: 'A' },
      lastSeen: '2026-11-10T09:00:00.000Z',
      defaultModel: 'standard',
      models: [
        { id: 'fast', name: 'Fast' },
        { id: 'standard', name: 'Standard' },
        { id: 'thorough', name: 'Thorough' },
      ],
    });
    const next = nodeSession({ service: new StandInService(), local: l, clock: () => '2026-11-12T09:00:00.000Z' }); const v = val(await next.load());
    expect(v.user).toEqual({ name: 'adoe', initials: 'A' });
    expect(v.lastSeen).toBe('2026-11-10T09:00:00.000Z');   // when the app was open before this time
    expect(val(await next.load()).lastSeen).toBe('2026-11-10T09:00:00.000Z');
  });
  it("the picker offers only the tiers, by their generic names, never the vendor's or the model's own; each tier can be turned off", async () => {
    const north = new StandInService(() => '', 'adoe', {
      models: [
        { id: 'model-fast', name: 'Model Fast' },
        { id: 'model-thorough', name: 'Model Thorough' },
        { id: 'command-a', name: 'Command A' },
      ],
      default: 'model-thorough',
      fast: 'model-fast',
      standard: 'model-thorough',
      thorough: 'model-thorough',
    });
    const all = val(await nodeSession({ service: north, local: local() }).load());
    // one model behind two tiers is one entry
    expect(all.models).toEqual([
      { id: 'model-fast', name: 'Fast' },
      { id: 'model-thorough', name: 'Standard' },
    ]);
    const some = val(await nodeSession({ service: north, local: local(), picker: { fast: true, standard: false, thorough: true } }).load());
    expect(some.models).toEqual([
      { id: 'model-fast', name: 'Fast' },
      { id: 'model-thorough', name: 'Thorough' },
    ]);
    expect(some.defaultModel).toBe('model-thorough');
    const one = val(await nodeSession({ service: north, local: local(), picker: { fast: true, standard: false, thorough: false } }).load());
    expect(one.models).toEqual([{ id: 'model-fast', name: 'Fast' }]); expect(one.defaultModel).toBe('model-fast');
  });
  it('start-up gives up on a service that does not answer, for the start screen’s Retry', async () => {
    const svc = new StandInService(); const never = new Promise<never>(() => undefined); svc.models = () => never; svc.whoami = () => never;
    const r = await nodeSession({ service: svc, local: local(), waitMs: 30 }).load();
    expect(r).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
  });
  it('start-up waits for a sign-in however long it takes, and carries on after it', async () => {
    const holder = tokenHolder({}); const svc = new StandInService(); const offered = svc.offered;
    svc.models = async () => { await holder.get(); return offered; };                     // as North does: the call waits on the sign-in
    let done = false; const p = nodeSession({ service: svc, local: local(), waitMs: 30, signingIn: holder.waiting }).load().then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 120)); expect(done).toBe(false);                  // four times the wait, still waiting
    holder.set('token'); expect((await p).ok).toBe(true);
  });
  it('with no sign-in window to wait on (an API key not entered yet), start-up stops after the wait and says what is missing', async () => {
    const holder = tokenHolder({}); const svc = new StandInService(); const offered = svc.offered;
    svc.models = async () => { await holder.get(); return offered; };
    const r = await nodeSession({ service: svc, local: local(), waitMs: 30, signingIn: () => false, signedOut: holder.waiting }).load();
    expect(!r.ok && r.error).toEqual({ kind: 'rejected', message: 'Nobody is signed in. Enter an API key in Settings, then Retry.' });   // not 'unreachable': the start screen shows it
    holder.set('key');
  });
  it('with the single sign-on window closed (API keys off), start-up says to sign in, not to enter a key, and Retry opens the window again and waits on it', async () => {
    const holder = tokenHolder({}); const svc = new StandInService(); const offered = svc.offered;
    svc.models = async () => { await holder.get(); return offered; };
    let open = false; let opened = 0;
    const session = nodeSession({ service: svc, local: local(), waitMs: 30, signingIn: () => holder.waiting() && open, signedOut: () => holder.waiting() && !open, signInAgain: () => { opened++; open = true; } });
    const r = await session.load();
    expect(!r.ok && r.error).toEqual({ kind: 'rejected', message: 'Nobody is signed in.' });
    // a load that is not the start screen's Retry (the offline bar's own retry) leaves the window closed
    expect((await session.load()).ok).toBe(false); expect(opened).toBe(0);
    // Retry: the window opens again, and start-up waits on it past the usual wait until the person signs in
    const again = session.load({ retry: true });
    await new Promise((go) => setTimeout(go, 80));
    expect(opened).toBe(1);
    holder.set('token'); open = false;
    expect((await again).ok).toBe(true);
  });
  it('when the service cannot say who it is, the PC’s signed-in user is used; when it offers no models, that is an error', async () => {
    const svc = new StandInService(); svc.whoami = async () => { throw new Error('401'); };
    expect(val(await nodeSession({ service: svc, local: local(), signedIn: () => 'j.doe' }).load()).user).toMatchObject(
      { name: 'j.doe', initials: 'JD' },
    );
    const odd = new StandInService(() => '', 'adoe', {
      models: [{ id: 'only', name: 'Only' }],
      default: 'not offered',
      fast: 'only',
      standard: 'only',
      thorough: 'only',
    });
    expect(val(await nodeSession({ service: odd, local: local() }).load()).defaultModel).toBe('only');
    const down = new StandInService(); down.models = async () => { throw new Error('down'); }; const r = await nodeSession({ service: down, local: local() }).load();
    expect(!r.ok && r.error.kind).toBe('unreachable');
    expect([initialsOf('a.doe'), initialsOf('adoe'), initialsOf('Jane de la Roe'), initialsOf('')]).toEqual(['AD', 'A', 'JR', '']);
  });
});

describe('a data room that cannot be reached for a while', () => {
  const N = 240;
  const files = Array.from({ length: N }, (_, i) => {
    const rel = `${String(i % 12).padStart(2, '0')} Legal/Agreement ${i}.pdf`;
    const bytes = fs.readFileSync(path.join(__dirname, '../fixtures/data-room-away/backend', rel));
    return { rel, bytes };
  });
  /** the one run of the real indexer, shared by every case below */
  let indexed: Promise<string> | null = null;
  /** The data room and its index, made once through the real indexer: the folders each case starts from (#98). */
  async function indexedOnce() {
    const root = tmp();
    const vdr = path.join(root, 'vdr');
    for (const f of files) put(vdr, f.rel, f.bytes);
    const a = pc(root, 'office'); await indexAll(a, vdr); expect(a.docs.records('d1').length).toBe(N);
    return root;
  }
  /** A writable copy of the indexed data room, its records and this PC's fingerprints pointed at the copied files. */
  async function copyOfIndexed() {
    const from = await (indexed ??= indexedOnce());
    const root = tmp();
    fs.cpSync(from, root, { recursive: true });
    for (const dir of ['shared', 'local-office']) {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        const file = path.join(root, dir, name);
        // paths appear as they are and, in JSON on Windows, with their backslashes escaped
        const text = fs.readFileSync(file, 'utf8').replaceAll(from, root);
        fs.writeFileSync(file, text.replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(root).slice(1, -1)));
      }
    }
    const hashesFile = path.join(root, 'local-office', 'hashes.json');
    const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8'));
    const prints = Object.entries<{ size: number; mtimeMs: number; hash: string }>(hashes);
    expect(prints.length).toBe(N);
    for (const [file, print] of prints) {
      const copied = fs.statSync(file);
      expect([copied.size, hashBytes(new Uint8Array(fs.readFileSync(file)))]).toEqual([print.size, print.hash]);
      print.mtimeMs = copied.mtimeMs;
    }
    fs.writeFileSync(hashesFile, JSON.stringify(hashes));
    // no fingerprint waits to be merged in over the refreshed ones
    const pendingPrints = path.join(root, 'local-office', 'hashes-new.jsonl');
    expect(fs.existsSync(pendingPrints) ? fs.readFileSync(pendingPrints, 'utf8').trim() : '').toBe('');
    // listings.json is left as copied: its print holds the old times, so a copy's next look lists the folder in full
    return root;
  }
  /**
   * a data room at deal scale: N agreements in twelve subfolders, indexed on one PC, which is the only one that has
   * read it
   */
  async function big() {
    const root = await copyOfIndexed();
    const vdr = path.join(root, 'vdr');
    const a = pc(root, 'office');
    // the copy starts with every document of the data room, each at its place in the copied folder
    const records = a.docs.records('d1').map((r) => `${r.folder}|${r.rel}`).sort();
    expect(records).toEqual(files.map((f) => `${vdr}|${f.rel}`).sort());
    const ids = files.map((f) => idOf(f.bytes)); const said = () => fs.readFileSync(path.join(root, 'shared', 'docs-office-d1.jsonl'), 'utf8');
    const open = async (i: number) => a.docs.page('d1', { doc: `Agreement ${i}.pdf`, docId: ids[i] }, 'p. 1');
    return { root, vdr, a, files, ids, said, open };
  }
  const TOOK = /"(left|cleared|missed|gone)"/;

  it('while the folder is not there, opening and sending its documents takes none of them out of the deal; they are back with the folder', async () => {
    const { vdr, a, ids, said, open } = await big();
    fs.renameSync(vdr, `${vdr}-away`);
    for (let i = 0; i < N; i += 7) { const r = await open(i); expect(!r.ok && r.error.kind).toBe('notFound'); }
    expect(await a.docs.wanted('d1', ids)).toEqual([]);                                      // none can be sent
    expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK);            // and none is said to have left
    expect(a.docs.away('d1', ids)).toEqual(ids);                                             // each is known to be out of reach, not gone
    // another PC reading the shared folder meanwhile still has them all
    expect(pc(path.dirname(vdr), 'home').docs.records('d1').length).toBe(N);
    fs.renameSync(`${vdr}-away`, vdr);
    for (let i = 0; i < N; i += 7) expect((await open(i)).ok).toBe(true);
    expect((await a.docs.wanted('d1', ids)).length).toBe(N);
  });

  it('a folder that reads as empty (a drive no longer mounted at its place) is out of reach, not emptied', async () => {
    const { vdr, a, ids, said, open } = await big();
    fs.renameSync(vdr, `${vdr}-away`); fs.mkdirSync(vdr); fs.writeFileSync(path.join(vdr, 'desktop.ini'), 'x');       // the mount point, with only a system file
    for (let i = 0; i < N; i += 7) { const r = await open(i); expect(!r.ok && r.error.kind).toBe('notFound'); }
    expect(await a.docs.wanted('d1', ids)).toEqual([]);
    expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK); expect(a.docs.away('d1', ids)).toEqual(ids);
  });

  it('a file that cannot be read while its folder lists it (a share that stopped answering for it) has not left, and is out of reach', async () => {
    const { vdr, a, ids, said, open } = await big();
    const at = path.join(vdr, '03 Legal', 'Agreement 3.pdf');
    const io = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    const exists = fs.existsSync, stat = fs.statSync;
    const s1 = vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === at ? false : exists(p)));
    const s2 = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => { if (p === at) throw io(); return stat(p, o as never); }) as never);
    try {
      const r = await open(3); expect(!r.ok && r.error.kind).toBe('notFound');
      expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK); expect(a.docs.away('d1', [ids[3]])).toEqual([ids[3]]);   // an i/o error is the data room not answering, as indexing takes it: a check waits for it
    } finally { s1.mockRestore(); s2.mockRestore(); }
    expect((await open(3)).ok).toBe(true);
  });

  it('a file deleted, a subfolder deleted whole, and a new version saved over a file, each seen with the folder there, still leave the deal', async () => {
    const { vdr, a, ids, said, open } = await big();
    fs.rmSync(path.join(vdr, '03 Legal', 'Agreement 3.pdf'));                                                           // deleted
    fs.rmSync(path.join(vdr, '04 Legal'), { recursive: true });                                                         // its subfolder deleted whole (20 files)
    fs.writeFileSync(path.join(vdr, '05 Legal', 'Agreement 5.pdf'), pdf('agreement number 5, as amended'));             // a new version saved over it
    for (const i of [3, 4, 16, 5]) { const r = await open(i); expect(!r.ok && r.error.kind).toBe('notFound'); }
    expect(a.docs.records('d1').map((r) => r.docId).sort()).toEqual(ids.filter((_, i) => ![3, 4, 16, 5].includes(i)).sort());   // those opened are gone; the rest of the deleted subfolder is found gone when it is opened or read
    expect(said().match(/"left"/g)?.length).toBe(4); expect(a.docs.away('d1', [3, 4, 16, 5].map((i) => ids[i]))).toEqual([]);
    expect((await a.docs.wanted('d1', ids)).length).toBe(N - 2 - 20);                         // sending the rest finds the other 18 of the subfolder gone too
    expect(a.docs.records('d1').length).toBe(N - 2 - 20);
  });

  it('something else at a file\'s place, or a file where its subfolder was, is seen as the document having left (not as out of reach)', async () => {
    const { vdr, a, ids, said, open } = await big();
    const p0 = path.join(vdr, '00 Legal', 'Agreement 0.pdf'); fs.rmSync(p0); fs.mkdirSync(p0); put(p0, 'inner.pdf', pdf('inner'));   // a folder of the same name
    const p1 = path.join(vdr, '01 Legal', 'Agreement 1.pdf'); fs.rmSync(p1); fs.symlinkSync(path.join(vdr, 'nowhere.pdf'), p1);      // a broken link
    fs.rmSync(path.join(vdr, '02 Legal'), { recursive: true }); fs.writeFileSync(path.join(vdr, '02 Legal'), 'not a folder');       // a file where the subfolder was
    const in2 = ids.filter((_, i) => i % 12 === 2);
    expect(a.docs.away('d1', [ids[0], ids[1], ...in2])).toEqual([]);
    for (const i of [0, 1]) { const r = await open(i); expect(!r.ok && r.error.kind).toBe('notFound'); }
    expect(await a.docs.wanted('d1', in2)).toEqual([]);
    const gone = new Set([ids[0], ids[1], ...in2]); expect(a.docs.records('d1').filter((r) => gone.has(r.docId))).toEqual([]);
    expect(said().match(/"left"/g)?.length).toBe(2 + in2.length);
  });

  it('a file its folder lists and that cannot be opened (no permission) is not sent, has not left, and holds its checks back', async () => {
    const { vdr, a, ids, said } = await big();
    const at = path.join(vdr, '03 Legal', 'Agreement 3.pdf');
    const no = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); const openSync = fs.openSync;
    const s1 = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...r: unknown[]) => { if (p === at) throw no(); return (openSync as (...x: unknown[]) => number)(p, ...r); }) as never);
    // its fingerprint is not kept from the indexing run, so it is read again
    try { fs.utimesSync(at, new Date(), new Date(Date.now() + 5000)); expect(await a.docs.wanted('d1', [ids[3], ids[4]])).toMatchObject([{ docId: ids[4] }]); expect(a.docs.away('d1', [ids[3]])).toEqual([ids[3]]); }
    finally { s1.mockRestore(); }
    expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK);
  });

  it('a file whose reading fails with the share timing out is out of reach, not left out', async () => {
    const { vdr, a, ids, said } = await big();
    const at = path.join(vdr, '03 Legal', 'Agreement 3.pdf');
    const openSync = fs.openSync;
    for (const code of ['ETIMEDOUT', 'EHOSTDOWN', 'EIO', 'UNKNOWN']) {
      const s1 = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...r: unknown[]) => { if (p === at) throw Object.assign(new Error(code), { code }); return (openSync as (...x: unknown[]) => number)(p, ...r); }) as never);
      try { fs.utimesSync(at, new Date(), new Date(Date.now() + 5000 + code.length)); expect(await a.docs.wanted('d1', [ids[3]])).toEqual([]); expect(a.docs.away('d1', [ids[3]])).toEqual([ids[3]]); }
      finally { s1.mockRestore(); }
    }
    expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK);
  });

  it('a file locked part-way through (a range another program holds) has not left, and holds its checks back', async () => {
    const { vdr, a, ids, said } = await big();
    const at = path.join(vdr, '03 Legal', 'Agreement 3.pdf');
    const openSync = fs.openSync;
    const readSync = fs.readSync;
    const mine = new Set<number>();
    const s1 = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...r: unknown[]) => { const fd = (openSync as (...x: unknown[]) => number)(p, ...r); if (p === at) mine.add(fd); return fd; }) as never);
    let n = 0; const s2 = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...r: unknown[]) => { if (mine.has(fd) && r[3] === null && n++ > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return (readSync as (...x: unknown[]) => number)(fd, ...r); }) as never);
    try { fs.utimesSync(at, new Date(), new Date(Date.now() + 9000)); n = 0; expect(a.docs.away('d1', [ids[3]])).toEqual([ids[3]]); expect(said()).not.toMatch(TOOK); } finally { s1.mockRestore(); s2.mockRestore(); }
  });

  it('a file locked for a moment (a save or a virus scan) is waited for and sent; one that stays locked costs one wait every 10 seconds', async () => {
    const { vdr, a, ids } = await big();
    const at = path.join(vdr, '03 Legal', 'Agreement 3.pdf');
    const openSync = fs.openSync;
    let refusals = 0;
    const s1 = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...r: unknown[]) => { if (p === at && refusals-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return (openSync as (...x: unknown[]) => number)(p, ...r); }) as never);
    try {
      fs.utimesSync(at, new Date(), new Date(Date.now() + 7000)); refusals = 3;
      expect((await a.docs.wanted('d1', [ids[3]])).map((w) => w.docId)).toEqual([ids[3]]);          // three refusals, then it opens: sent
      fs.utimesSync(at, new Date(), new Date(Date.now() + 8000)); refusals = Infinity;
      let t = Date.now(); expect(await a.docs.wanted('d1', [ids[3]])).toEqual([]); const first = Date.now() - t;
      t = Date.now(); expect(await a.docs.wanted('d1', [ids[3]])).toEqual([]); const second = Date.now() - t;
      expect(first).toBeGreaterThanOrEqual(1000); expect(second).toBeLessThan(first);               // waited a second or so once; not again straight after
      expect(a.docs.away('d1', [ids[3]])).toEqual([ids[3]]);
    } finally { s1.mockRestore(); }
  });

  it('a document that could not be sent and is back by the time it is asked about has still not been read: it counts as not left', async () => {
    const { vdr, a, ids } = await big();
    fs.renameSync(vdr, `${vdr}-away`); expect(await a.docs.wanted('d1', [ids[0]])).toEqual([]);
    fs.renameSync(`${vdr}-away`, vdr); expect(a.docs.away('d1', [ids[0]])).toEqual([ids[0]]);
  });

  it('a file renamed only in its capitals has left its old name, on a disk that ignores capitals too', async () => {
    const { vdr, a, ids, said, open } = await big();
    const dir = path.join(vdr, '06 Legal');
    fs.renameSync(path.join(dir, 'Agreement 6.pdf'), path.join(dir, 'AGREEMENT 6.pdf'));
    // a disk that ignores capitals still finds the file under its old name
    const stat = fs.statSync, exists = fs.existsSync; const old = path.join(dir, 'Agreement 6.pdf'), now = path.join(dir, 'AGREEMENT 6.pdf');
    const s1 = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => stat(p === old ? now : p, o as never)) as never);
    const s2 = vi.spyOn(fs, 'existsSync').mockImplementation((p) => exists(p === old ? now : p));
    try { await indexAll(a, vdr); } finally { s1.mockRestore(); s2.mockRestore(); }
    const r = a.docs.records('d1').find((x) => x.docId === ids[6])!; expect(r.rel).toBe('06 Legal/AGREEMENT 6.pdf'); expect(r.copies).toBeUndefined();
    expect(said()).toMatch(/"left":\{"folder":"[^"]*","rel":"06 Legal\/Agreement 6.pdf"\}/); expect((await open(6)).ok).toBe(true);
  });

  it('a read of the folder that loses files from its listing because the folder stops answering part-way takes none of them out', async () => {
    const { vdr, a, said } = await big();
    const lost = path.join(vdr, '11 Legal') + path.sep;
    const io = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); const stat = fs.statSync;
    // the last subfolder lists its names, and then nothing about any file in it can be read
    const s = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => { if (typeof p === 'string' && p.startsWith(lost)) throw io(); return stat(p, o as never); }) as never);
    try { const p = await indexAll(a, vdr); expect(p.done).toBe(true); } finally { s.mockRestore(); }
    expect(a.docs.records('d1').length).toBe(N); expect(said()).not.toMatch(TOOK);
    fs.rmSync(path.join(vdr, '11 Legal', 'Agreement 11.pdf')); await indexAll(a, vdr);         // a file that really went is still taken out by the next read
    expect(a.docs.records('d1').length).toBe(N - 1);
  });
});

/** The two real journals: eight departed documents are still visible to the peer. */
function progressJournals() {
  const root = tmp();
  const room = path.join(root, 'vdr');
  const arrival = (i: number, owner: string) => ({
    v: 1, pc: owner, at: '2026-11-18T09:00:00.000Z', docId: `doc_${String(i).padStart(24, '0')}`,
    hash: `hash${i}`, name: `Agreement ${i}.pdf`, folder: room, rel: `Agreement ${i}.pdf`, pages: 1, size: 770,
  });
  const departure = (i: number, owner: string) => ({
    v: 1, pc: owner, at: '2026-11-18T10:00:00.000Z', docId: arrival(i, owner).docId,
    left: { folder: room, rel: `Agreement ${i}.pdf` },
  });
  const office = [
    ...Array.from({ length: 2000 }, (_, i) => arrival(i, 'office')),
    ...Array.from({ length: 16 }, (_, i) => departure(i, 'office')),
  ];
  const home = Array.from({ length: 8 }, (_, i) => arrival(i, 'home'));
  put(root, 'shared/docs-office-d1.jsonl', office.map((row) => JSON.stringify(row)).join('\n') + '\n');
  put(root, 'shared/docs-home-d1.jsonl', home.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { root, office, home, arrival, departure, receiver: pc(root, 'receiver') };
}

describe('warm document collections', () => {
  it('checks freshness once and preserves peer visibility through later arrivals and departures', async () => {
    const { root, office, home, arrival, departure, receiver } = progressJournals();
    const listed = vi.spyOn(receiver.shared, 'list');
    const sized = vi.spyOn(receiver.shared, 'size');
    try {
      const expected = receiver.docs.records('d1');
      const ids = new Set(expected.map((record) => record.docId));
      expect(expected).toHaveLength(1992);
      for (let i = 0; i < 16; i++) expect(ids.has(arrival(i, 'office').docId)).toBe(i < 8);
      listed.mockClear();
      sized.mockClear();
      expect(receiver.docs.records('d1')).toEqual(expected);
      expect(listed).toHaveBeenCalledTimes(1);
      expect(sized).toHaveBeenCalledTimes(2);

      const ai = nodeAi({
        service: receiver.svc, docs: receiver.docs, keeper: receiver.keeper, repo: memRepo(clock),
      });
      const progress = val(await ai.progress!('d1'));
      expect(progress.folders.reduce((n, folder) => n + folder.files, 0)).toBe(1992);
      listed.mockClear();
      sized.mockClear();
      expect(val(await ai.progress!('d1'))).toEqual(progress);
      expect(listed.mock.calls.length).toBeLessThanOrEqual(4);
      expect(sized.mock.calls.length).toBeLessThanOrEqual(8);
      expect(receiver.svc.calls).toEqual([]);

      const homeLeft = [...home, departure(0, 'home')];
      put(root, 'shared/docs-home-d1.jsonl', homeLeft.map((row) => JSON.stringify(row)).join('\n') + '\n');
      expect(val(await ai.progress!('d1')).folders.reduce((n, folder) => n + folder.files, 0)).toBe(1991);
      const conflict = [...office, arrival(2000, 'office')];
      put(root, 'shared/docs-office-d1 (1).jsonl', conflict.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const fresh = receiver.docs.records('d1');
      expect(fresh).toHaveLength(1992);
      expect(fresh.some((record) => record.docId === arrival(0, 'home').docId)).toBe(false);
      expect(fresh.some((record) => record.docId === arrival(2000, 'office').docId)).toBe(true);
      expect(val(await ai.progress!('d1')).folders.reduce((n, folder) => n + folder.files, 0)).toBe(1992);
      expect(receiver.svc.calls).toEqual([]);
    } finally {
      listed.mockRestore();
      sized.mockRestore();
    }
  });
});
