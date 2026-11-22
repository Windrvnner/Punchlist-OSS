// @vitest-environment node
// What a run of indexing may and may not record, and what the app writes to the deal when runs stop, resume and overlap.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeDocuments } from '../../src/backend/documents';
import type { Converter } from '../../src/backend/convert';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal, DeleteDeal, RecordIndexingProgress, AddFolders, RemoveFolder } from '../../src/app/commands/deals';
import { registry } from '../../src/app/commands/undo';
import { watchIndexing, startIndexing, liveFolders, RETRY, followDeals } from '../../src/app/indexing';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string | Uint8Array) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, t++)).toISOString();
function pdf(text: string, pages = 1): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) { const stream = `BT /F1 12 Tf 72 720 Td (${text}, page ${i + 1}) Tj ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let out = '%PDF-1.4\n'; const at: number[] = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
function standInConverter(id = 'stand-in') { const calls: string[] = []; const convert: Converter = Object.assign(async (file: string, outDir: string, outName: string) => { calls.push(file); if (/Locked/.test(file)) throw new Error('password'); const out = path.join(outDir, outName); fs.writeFileSync(out, pdf(`converted`, 3)); return out; }, { id }); return { calls, convert }; }
function pc(root: string, name: string, o: any = {}) {
  const sharedPath = path.join(root, 'shared'); const shared = o.shared ?? nodeFolder(sharedPath), local = nodeFolder(path.join(root, `local-${name}`)); const workPath = path.join(root, `work-${name}`);
  const keeper = new StoreKeeper(new StandInService(), local, { limit: 500, clock, recheckMs: 0 }); const done: string[] = []; const conv = standInConverter();
  const docs = nodeDocuments({ shared, local, sharedPath, installId: name, keeper, clock, ...(o.noWork ? {} : { workPath }), convert: conv.convert, folders: async () => o.folders ?? [path.join(root, 'vdr')], onIndexed: (d) => done.push(d), ...(o.atOnce ? { atOnce: o.atOnce } : {}) });
  return { docs, done, shared, local, conv, workPath };
}
const folder = (p: string, files = 0) => ({ path: p, label: path.basename(p), files, size: '', indexed: 0, reviewed: 0 });
const COMMANDS = [CreateDeal, EditDeal, DeleteDeal, RecordIndexingProgress, AddFolders, RemoveFolder]; for (const c of COMMANDS) registry.set(c.name, c);
let ct = 0; const sclock = { now: () => new Date(Date.UTC(2026, 10, 10, 16, 0, 0, ct++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HXXXXXXXXXXXXXXXV${String(seq++).padStart(7, '0')}` };
function make(docs: any) { const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(sclock.now);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs, fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: sclock, ids }, COMMANDS); return { store, repo }; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


import { PassThrough } from 'node:stream';
import { resumeIndexing } from '../../src/app/indexing';
const val = (r: any) => { expect(r.ok).toBe(true); return r.value; };
const watch = (m: any, d: string) => { const seen: string[] = []; const off = m.store.subscribe((s: any) => { const dd = s.deals[d]; if (!dd) return; const line = liveFolders(s, dd).map((f: any) => `${f.label}:${f.indexed}/${f.files}`).join(' ') + (s.ui.indexStalled.includes(d) ? ' STALLED' : '') + (s.ui.indexWaiting[d] ? ' wait=' + s.ui.indexWaiting[d] : '') + ' stage=' + dd.stage + (s.indexing[d] ? ' [live]' : ''); if (seen[seen.length - 1] !== line) seen.push(line); }); return { seen, off }; };
const until = async (ok: () => boolean, ms = 6000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await sleep(20); return ok(); };

describe('a run that loses the data room or the disk is a broken run, not a finished one', () => {
  it('the data room stops answering part-way: the run ends as stopped where it was, nothing is announced as finished, and what was recorded stays', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 8; i++) put(vdr, `f${i}.pdf`, pdf('doc ' + i));
    const x = pc(root, 'A', { atOnce: 1 }); let opened = 0; const realStream = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f !== 'string' || !f.startsWith(vdr)) return (realStream as any)(f, ...rest); if (++opened > 3) { const pass = new PassThrough(); setTimeout(() => pass.destroy(Object.assign(new Error('EIO: the network name is no longer available'), { code: 'EIO' })), 5); return pass; } return (realStream as any)(f, ...rest); };
    let p: any; try { val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); p = val(await x.docs.poll('d1')); } finally { (fs as any).createReadStream = realStream; }
    expect(p.done).toBe(false); expect(p.stopped).toBe(true); expect(p.why).toBe('The data room stopped answering.');
    expect(p.folders).toMatchObject([{ path: vdr, files: 8, indexed: 3 }]);                              // where it had got to, not "8 of 8"
    expect(x.done).toEqual([]);                                                                          // the first pass is not set off by a run that did not finish
    expect(x.docs.records('d1').length).toBe(3);
    // the data room is back: run again; it finishes, and only then is it finished
    val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); const q = val(await x.docs.poll('d1'));
    expect(q.done).toBe(true); expect(q.stopped).toBeUndefined(); expect(q.why).toBeUndefined(); expect(q.folders).toMatchObject([{ path: vdr, files: 8, indexed: 8 }]); expect(q.log[0]).toBe('Indexed 8 files');
    expect(x.done).toEqual(['d1']); expect(x.docs.records('d1').length).toBe(8);
  }, 30000);

  it('the folder cannot be listed once the run is under way: the run stops; it does not finish with nothing in it', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 4; i++) put(vdr, `f${i}.pdf`, pdf('doc ' + i));
    const x = pc(root, 'A'); const real = fs.readdirSync; (fs as any).readdirSync = (d: any, ...r: any[]) => { if (typeof d === 'string' && d.startsWith(vdr)) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return (real as any)(d, ...r); };
    let p: any; try { val(await x.docs.index('d1', [folder(vdr, 4)])); await x.docs.settled('d1'); p = val(await x.docs.poll('d1')); } finally { (fs as any).readdirSync = real; }
    expect(p.done).toBe(false); expect(p.stopped).toBe(true); expect(p.why).toBe('The data room stopped answering.'); expect(x.done).toEqual([]);
    expect(p.folders).toMatchObject([{ path: vdr, files: 4, indexed: 0 }]);                              // the count the deal had for it stands; nothing is said to be indexed
  });

  it('this PC runs out of room while a file is brought across: the run stops and says so; nothing is left half-written', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 4; i++) put(vdr, `f${i}.pdf`, pdf('doc ' + i));
    const x = pc(root, 'A'); const realW = fs.createWriteStream;
    (fs as any).createWriteStream = (f: any, ...rest: any[]) => { const w = (realW as any)(f, ...rest); if (typeof f === 'string' && f.includes(path.join('work-A', 'in'))) setImmediate(() => w.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))); return w; };
    let p: any; try { val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); p = val(await x.docs.poll('d1')); } finally { (fs as any).createWriteStream = realW; }
    expect(p.done).toBe(false); expect(p.stopped).toBe(true); expect(p.why).toBe('This PC is out of disk space.'); expect(x.done).toEqual([]);
    expect(fs.existsSync(path.join(x.workPath, 'in')) ? fs.readdirSync(path.join(x.workPath, 'in')) : []).toEqual([]);
  });

  it('one file that cannot be read, with the data room still there, is left out and named; the run finishes; and a document recorded earlier is not taken away because its file could not be read today', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const files: string[] = []; for (let i = 0; i < 5; i++) files.push(put(vdr, `f${i}.pdf`, pdf('doc ' + i)));
    const x = pc(root, 'A'); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); expect(x.docs.records('d1').length).toBe(5);
    // the files' dates change (a sync tool resets them), so each has to be read again; one of them is locked by someone
    for (const f of files) fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const realStream = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f === 'string' && f.endsWith('f2.pdf')) { const pass = new PassThrough(); setTimeout(() => pass.destroy(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })), 5); return pass; } return (realStream as any)(f, ...rest); };
    let p: any; try { val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); p = val(await x.docs.poll('d1')); } finally { (fs as any).createReadStream = realStream; }
    expect(p.done).toBe(true); expect(p.log.slice(0, 2)).toEqual(['Indexed 4 files', '1 file could not be read: f2.pdf']);
    expect(x.docs.records('d1').map((r: any) => r.name).sort()).toEqual(['f0.pdf', 'f1.pdf', 'f2.pdf', 'f3.pdf', 'f4.pdf']);   // f2 is still one of the deal's documents
  });
});

describe('what the deal is told when runs stop, resume and overlap (the app’s loop on the real document service)', () => {
  it('a run that broke in the second folder is resumed on that folder only: the first folder keeps what it had, and nothing finished is remembered as stopped', async () => {
    const root = tmp(); const A = path.join(root, 'A'), B = path.join(root, 'B');
    for (let i = 0; i < 3; i++) put(A, `a${i}.pdf`, pdf('alpha ' + i)); for (let i = 0; i < 4; i++) put(B, `b${i}.pdf`, pdf('beta ' + i));
    const base = nodeFolder(path.join(root, 'shared')); let appended = 0; let breakAt = Infinity;
    const shared = { ...base, append: (n: string, t: string) => { if (++appended > breakAt) throw new Error('share gone'); return base.append(n, t); } };
    const x = pc(root, 'A', { shared, folders: [A, B] }); const m = make(x.docs);
    await m.store.boot(); await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [{ path: A, label: 'A', files: 3, size: '' }, { path: B, label: 'B', files: 4, size: '' }] });
    const d = Object.values(m.store.get().deals)[0].id; const w = watch(m, d);
    const was = { ...RETRY }; RETRY.first = 300; RETRY.max = 300;
    try {
      breakAt = 5;                                              // the fifth record cannot be written: the run breaks in B
      await startIndexing(m.store, d, m.store.get().deals[d].folders);
      expect(await until(() => !!m.store.get().ui.indexWaiting[d])).toBe(true);
      const at = liveFolders(m.store.get(), m.store.get().deals[d]).map((f: any) => `${f.label}:${f.indexed}/${f.files}`).join(' ');
      expect(at).toBe('A:3/3 B:2/4');                                                                       // where it stopped
      breakAt = Infinity;
      expect(await until(() => m.store.get().deals[d].stage === 'ready')).toBe(true); await sleep(100);
    } finally { Object.assign(RETRY, was); w.off(); }
    expect(w.seen.some((l) => /A:0\/3/.test(l) && !/B:0\/4/.test(l))).toBe(false);                       // A is never shown as not indexed once it has been
    expect(m.store.get().deals[d].folders.map((f: any) => [f.label, f.indexed, f.files])).toEqual([['A', 3, 3], ['B', 4, 4]]);
    expect(x.docs.records(d).length).toBe(7);
    const y = pc(root, 'A', { shared: base, folders: [A, B] }); const after = val(await y.docs.poll(d)); expect(after.stopped).toBeUndefined(); expect(after.done).toBe(true);   // after a restart nothing says "stopped"
  }, 30000);

  it('folders added to a deal already indexed, with the start refused: the deal is not written ready with the new folder unindexed; it waits, and is indexed when the folder can be reached', async () => {
    const root = tmp(); const A = path.join(root, 'A'), B = path.join(root, 'B-not-there-yet');
    for (let i = 0; i < 3; i++) put(A, `a${i}.pdf`, pdf('alpha ' + i));
    const x = pc(root, 'A', { folders: [A, B] }); const m = make(x.docs); await m.store.boot();
    await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [{ path: A, label: 'A', files: 3, size: '' }] }); const d = Object.values(m.store.get().deals)[0].id;
    await startIndexing(m.store, d, m.store.get().deals[d].folders);
    expect(await until(() => m.store.get().deals[d].stage === 'ready')).toBe(true);
    const was = { ...RETRY }; RETRY.first = 200; RETRY.max = 200;
    try {
      val(await m.store.dispatch(AddFolders, { dealId: d, folders: [{ path: B, label: 'B', files: 4, size: '' }] }));
      await startIndexing(m.store, d, m.store.get().deals[d].folders.slice(-1));
      await sleep(900);
      const s = m.store.get();
      expect(s.deals[d].stage).toBe('indexing'); expect(s.ui.indexWaiting[d]).toBe('away'); expect(s.ui.indexStalled).toContain(d);
      expect(liveFolders(s, s.deals[d]).map((f: any) => [f.label, f.indexed, f.files])).toEqual([['A', 3, 3], ['B', 0, 4]]);
      // the folder arrives: it is indexed without anyone pressing anything, and only then is the deal ready
      for (let i = 0; i < 4; i++) put(B, `b${i}.pdf`, pdf('beta ' + i));
      expect(await until(() => m.store.get().deals[d].stage === 'ready')).toBe(true);
    } finally { Object.assign(RETRY, was); }
    expect(m.store.get().deals[d].folders.map((f: any) => [f.label, f.indexed, f.files])).toEqual([['A', 3, 3], ['B', 4, 4]]);
    expect(x.docs.records(d).length).toBe(7);
  }, 30000);

  it('folders added while the first folders are still being indexed: both end as indexed on the deal', async () => {
    const root = tmp(); const A = path.join(root, 'A'), B = path.join(root, 'B');
    for (let i = 0; i < 6; i++) put(A, `a${i}.pdf`, pdf('alpha ' + i)); for (let i = 0; i < 2; i++) put(B, `b${i}.pdf`, pdf('beta ' + i));
    const realStream = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f !== 'string' || !f.startsWith(A)) return (realStream as any)(f, ...rest); const pass = new PassThrough(); setTimeout(() => { const st = (realStream as any)(f, ...rest); st.on('error', (e: Error) => pass.destroy(e)); st.pipe(pass); }, 150); return pass; };
    const x = pc(root, 'A', { folders: [A, B], atOnce: 1 }); const m = make(x.docs); await m.store.boot();
    await m.store.dispatch(CreateDeal, { name: 'Wingtip', folders: [{ path: A, label: 'A', files: 6, size: '' }] }); const d = Object.values(m.store.get().deals)[0].id;
    try {
      await startIndexing(m.store, d, m.store.get().deals[d].folders);
      await sleep(400);
      val(await m.store.dispatch(AddFolders, { dealId: d, folders: [{ path: B, label: 'B', files: 2, size: '' }] }));
      void startIndexing(m.store, d, m.store.get().deals[d].folders.slice(-1));
      expect(await until(() => m.store.get().deals[d].stage === 'ready', 12000)).toBe(true); await sleep(200);
    } finally { (fs as any).createReadStream = realStream; }
    expect(m.store.get().deals[d].folders.map((f: any) => [f.label, f.indexed, f.files])).toEqual([['A', 6, 6], ['B', 2, 2]]);
    expect(x.docs.records(d).length).toBe(8);
  }, 30000);
});

// What a run reads, records and says about itself.
describe('what a run reads and says of itself', () => {
  const opened = (vdr: string) => { const opens: string[] = []; const real = fs.createReadStream; (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f === 'string' && f.startsWith(vdr)) opens.push(path.basename(f)); return (real as any)(f, ...rest); }; return { opens, undo: () => { (fs as any).createReadStream = real; } }; };
  const once = async (x: ReturnType<typeof pc>, vdr: string) => { val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); return val(await x.docs.poll('d1')); };

  it('a file that would not turn into pages is not read from the data room again in the same session, and is still named; it is tried again when it changes, and once after a restart', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'ok.pdf', pdf('fine')); const locked = put(vdr, 'Locked.docx', 'x'.repeat(50000));
    const x = pc(root, 'A'); const w = opened(vdr); const line = '1 file could not be turned into pages and was not indexed: Locked.docx';
    try {
      const p1 = await once(x, vdr); expect([...w.opens].sort()).toEqual(['Locked.docx', 'ok.pdf']); expect(p1.log).toContain(line); expect(p1.timing.brought).toBe(2);
      for (let i = 0; i < 2; i++) { w.opens.length = 0; const p = await once(x, vdr); expect(w.opens).toEqual([]); expect(p.log).toEqual(['Indexed 1 file', line]); expect(p.timing).toMatchObject({ files: 2, brought: 0, known: 2, bytes: 0 }); }
      // it changes: read again
      fs.writeFileSync(locked, 'y'.repeat(60000)); w.opens.length = 0; const p4 = await once(x, vdr); expect(w.opens).toEqual(['Locked.docx']); expect(p4.log).toContain(line);
      // the app is started again: tried once more, in case what stopped it has passed, and then left alone again
      const y = pc(root, 'A'); w.opens.length = 0; await once(y, vdr); expect(w.opens).toEqual(['Locked.docx']);
      w.opens.length = 0; const p6 = await once(y, vdr); expect(w.opens).toEqual([]); expect(p6.log).toContain(line);
    } finally { w.undo(); }
  });

  it('a file replaced between the listing and the copy is recorded with the size of what was read, is not remembered under the old size and date, and can still be opened after it is moved', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const a = put(vdr, 'a.pdf', pdf('first version')); const b = put(vdr, 'b.pdf', pdf('other'));
    const x = pc(root, 'A', { atOnce: 1 }); const real = fs.createReadStream; const v2 = pdf('second version, a good deal longer than the first one was', 2); const old = fs.statSync(a).size;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (f === a) fs.writeFileSync(a, v2); return (real as any)(f, ...rest); };
    let p: any; try { p = await once(x, vdr); } finally { (fs as any).createReadStream = real; }
    const now = fs.statSync(a).size; expect(now).not.toBe(old);
    const rec = x.docs.records('d1').find((r: any) => r.name === 'a.pdf')!; expect(rec).toMatchObject({ size: now, pages: 2 });
    expect(p.timing.bytes).toBe(now + fs.statSync(b).size);                                // the bytes that came across, not the sizes in the listing
    const remembered = `${x.local.read('hashes.json') ?? ''}\n${x.local.read('hashes-new.jsonl') ?? ''}`; expect(remembered).not.toContain(`"size":${old},`);
    fs.mkdirSync(path.join(vdr, 'sub')); fs.renameSync(a, path.join(vdr, 'sub', 'a.pdf'));
    expect((await x.docs.page('d1', { doc: 'a.pdf', docId: rec.docId }, 'p. 1')).ok).toBe(true);
  });

  it('a record left with the wrong size is put right by the next run, without the file being read again', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); const a = put(vdr, 'a.pdf', pdf('only version')); const x = pc(root, 'A'); await once(x, vdr);
    const file = fs.readdirSync(path.join(root, 'shared')).find((n) => /^docs-A-d1/.test(n))!; const at = path.join(root, 'shared', file);
    const mine = fs.readFileSync(at, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.name === 'a.pdf'); const real = fs.statSync(a).size;
    fs.appendFileSync(at, JSON.stringify({ ...mine, at: clock(), size: real - 100 }) + '\n');     // as an earlier version of the app could leave it
    const y = pc(root, 'A'); expect(y.docs.records('d1')[0].size).toBe(real - 100);
    const w = opened(vdr); try { await once(y, vdr); expect(w.opens).toEqual([]); } finally { w.undo(); }
    expect(y.docs.records('d1')[0].size).toBe(real);
  });

  it('starts that arrive together make one run, announced once; a start for a folder the run does not cover waits, and the starts that wait make one more run between them', async () => {
    const root = tmp(); const A = path.join(root, 'vdr'); const B = path.join(root, 'more'); for (let i = 0; i < 6; i++) put(A, `f${i}.docx`, 'word file ' + i); for (let i = 0; i < 3; i++) put(B, `g${i}.docx`, 'another word file ' + i);
    const x = pc(root, 'A', { folders: [A, B] }); const real = fs.createReadStream; let inFlight = 0, most = 0; const dirs = new Set<string>();
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f !== 'string' || !(f.startsWith(A) || f.startsWith(B))) return (real as any)(f, ...rest); const pass = new PassThrough(); setTimeout(() => { const st = (real as any)(f, ...rest); st.on('error', (e: Error) => pass.destroy(e)); st.pipe(pass); }, 30); return pass; };
    try {
      const rs = await Promise.all([x.docs.index('d1', [folder(A)]), x.docs.index('d1', [folder(A)]), x.docs.index('d1', [folder(A)])]); expect(rs.map((r) => r.ok)).toEqual([true, true, true]);
      // while that run is under way: two starts that want the other folder too, and one that wants only what is being indexed
      const later = Promise.all([x.docs.index('d1', [folder(A), folder(B)]), x.docs.index('d1', [folder(B)]), x.docs.index('d1', [folder(A)])]);
      await x.docs.settled('d1'); expect(x.done).toEqual(['d1']); expect(x.conv.calls.length).toBe(6);
      expect((await later).map((r) => r.ok)).toEqual([true, true, true]); await x.docs.settled('d1');
      expect(x.done).toEqual(['d1', 'd1']);                                               // two runs in all, one after the other
      expect(x.conv.calls.length).toBe(9);                                                // the second read only what the first had not
      const p = val(await x.docs.poll('d1')); expect(p.done).toBe(true); expect(p.folders.map((f: any) => [path.basename(f.path), f.indexed, f.files]).sort()).toEqual([['more', 3, 3], ['vdr', 6, 6]]);
      expect(x.docs.records('d1').length).toBe(9);
    } finally { (fs as any).createReadStream = real; }
  }, 30000);

  it('the figures of a run are what their words say', async () => {
    // with no working folder on this PC the files are read where they are: they count as read, not as already known
    const root = tmp(); const vdr = path.join(root, 'vdr'); let total = 0; for (let i = 0; i < 4; i++) total += fs.statSync(put(vdr, `f${i}.pdf`, pdf('doc ' + i))).size;
    const x = pc(root, 'A', { noWork: true }); const p = await once(x, vdr);
    expect(p.timing).toMatchObject({ files: 4, brought: 4, known: 0, bytes: total });
    expect(x.local.read('indexing-last.txt')).toMatch(/: 4 files in [\d.]+ s; 4 read from the data room \(\d+ KB\) in [\d.]+ s, [\d.]+ MB\/s, 3 at a time; [\d.]+ s converting and reading pages, waits included, in parallel with the reading; 0 already known\n$/);
    // a second run reads nothing, and says nothing was read rather than "1 KB"
    const p2 = await once(x, vdr); expect(p2.timing).toMatchObject({ files: 4, brought: 0, known: 4, bytes: 0 });
    expect(x.local.read('indexing-last.txt')).toContain('; 0 read from the data room (0 KB) in 0.0 s, 0.0 MB/s,');
    // and a folder with nothing in it has no size
    const empty = path.join(root, 'empty'); fs.mkdirSync(empty); expect(val(await x.docs.scanFolder(empty))).toEqual({ files: 0, size: '0 KB' });
  });

  it('where a run has got to is written to disk as each file is read, ' +
    'and not once per file when files are only being recognized', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 40; i++) put(vdr, `f${i}.pdf`, pdf('doc ' + i));
    const x = pc(root, 'A'); const real = fs.renameSync; let n = 0; (fs as any).renameSync = (a: any, b: any) => { if (String(b).endsWith('indexing.json')) n++; return (real as any)(a, b); };
    try {
      await once(x, vdr); const first = n; n = 0; await once(x, vdr); const second = n;
      expect(first).toBeLessThanOrEqual(44); expect(second).toBeLessThanOrEqual(6);
    } finally { (fs as any).renameSync = real; }
    // and what is on disk at the end is the whole of it
    expect(JSON.parse(x.local.read('indexing.json')!).d1[vdr]).toMatchObject({ indexed: 40, files: 40, finished: true });
  }, 30000);
});

describe('a folder taken off the deal part-way through its indexing', () => {
  it('no longer holds the deal back: the rest finishes as done, and putting it back carries on where it stopped', async () => {
    const root = tmp(); const a = path.join(root, 'A'), b = path.join(root, 'B');
    for (let i = 0; i < 6; i++) put(a, `a${i}.pdf`, pdf('a ' + i)); for (let i = 0; i < 3; i++) put(b, `b${i}.pdf`, pdf('b ' + i));
    const on = [a, b]; const x = pc(root, 'A', { atOnce: 1, folders: on }); let opened = 0; const realStream = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...rest: any[]) => { if (typeof f !== 'string' || !f.startsWith(a)) return (realStream as any)(f, ...rest); if (++opened > 2) { const pass = new PassThrough(); setTimeout(() => pass.destroy(Object.assign(new Error('EIO: the network name is no longer available'), { code: 'EIO' })), 5); return pass; } return (realStream as any)(f, ...rest); };
    try { val(await x.docs.index('d1', [folder(a), folder(b)])); await x.docs.settled('d1'); } finally { (fs as any).createReadStream = realStream; }
    expect(val(await x.docs.poll('d1'))).toMatchObject({ done: false, stopped: true });
    on.splice(0, 1);                                                                        // A is taken off the deal
    val(await x.docs.index('d1', [folder(b)])); await x.docs.settled('d1');
    const p = val(await x.docs.poll('d1'));
    expect(p.done).toBe(true); expect(p.stopped).toBeUndefined();
    const ran = x.done.length;
    expect(val(await x.docs.poll('d1')).done).toBe(true); expect(x.done.length).toBe(ran);   // polling again starts nothing
    on.unshift(a);                                                                           // put back: it is unfinished again until read the rest of the way
    expect(val(await x.docs.poll('d1'))).toMatchObject({ done: false, stopped: true });
    val(await x.docs.index('d1', [folder(a)])); await x.docs.settled('d1');
    const q = val(await x.docs.poll('d1'));
    expect(q.done).toBe(true); expect(q.folders.find((f: any) => f.path === a)).toMatchObject({ files: 6, indexed: 6 });
  });
  it('the deal waiting to try again is looked at as soon as the folder is taken off, not when the wait ends', async () => {
    const root = tmp(); const A = path.join(root, 'A'), B = path.join(root, 'B');
    for (let i = 0; i < 3; i++) put(A, `a${i}.pdf`, pdf('alpha ' + i)); for (let i = 0; i < 2; i++) put(B, `b${i}.pdf`, pdf('beta ' + i));
    const base = nodeFolder(path.join(root, 'shared')); let appended = 0; let breakAt = Infinity;
    const shared = { ...base, append: (n: string, t: string) => { if (++appended > breakAt) throw new Error('share gone'); return base.append(n, t); } };
    const on = [A, B]; const x = pc(root, 'A', { shared, folders: on }); const m = make(x.docs); await m.store.boot(); const stop = followDeals(m.store);
    await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [{ path: A, label: 'A', files: 3, size: '' }, { path: B, label: 'B', files: 2, size: '' }] });
    const d = Object.values(m.store.get().deals)[0].id;
    const was = { ...RETRY }; RETRY.first = 60000; RETRY.max = 60000;                      // a wait far longer than this test
    try {
      breakAt = 1;                                                                          // the run breaks in A
      await startIndexing(m.store, d, m.store.get().deals[d].folders);
      expect(await until(() => !!m.store.get().ui.indexWaiting[d])).toBe(true);
      breakAt = Infinity;
      on.splice(0, 1); await m.store.dispatch(RemoveFolder, { dealId: d, path: A });
      expect(await until(() => m.store.get().deals[d].stage === 'ready', 5000)).toBe(true);
    } finally { Object.assign(RETRY, was); stop(); }
    expect(m.store.get().deals[d].folders.map((f: any) => [f.label, f.indexed, f.files])).toEqual([['B', 2, 2]]);
  }, 30000);
});
