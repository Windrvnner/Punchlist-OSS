// @vitest-environment node
// Looking at an indexed deal's folders again: a listing compared with the last run's, at deal scale, and what a
// folder that cannot be reached does (nothing).
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeDocuments, walk, walkQuietly } from '../../src/backend/documents';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';

const made: string[] = []; afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'look-')); made.push(d); return d; };
const put = (root: string, rel: string, data: string | Uint8Array) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
let t = 0; let skew = 0; const clock = () => new Date(Date.UTC(2026, 10, 17, 9, 0, 0, t++) + skew).toISOString();   // skew moves every PC's clock on
// spreadsheets as .csv: indexed with no converter, so thousands of files index quickly
const csv = (n: number | string) => `Item,Value\nline ${n},${n}\n`;
function pc(root: string, o: { folders?: () => string[]; settleMs?: number; id?: string } = {}) {
  const sharedPath = path.join(root, 'shared'); const shared = nodeFolder(sharedPath), local = nodeFolder(path.join(root, o.id ? `local-${o.id}` : 'local'));
  const keeper = new StoreKeeper(new StandInService(), local, { limit: 500, clock, recheckMs: 0 }); const indexed: string[] = [];
  const docs = nodeDocuments({ shared, local, sharedPath, installId: o.id ?? 'A', keeper, clock, workPath: path.join(root, o.id ? `work-${o.id}` : 'work'), folders: async () => o.folders?.() ?? [path.join(root, 'vdr')], onIndexed: (d) => indexed.push(d), settleMs: o.settleMs ?? 50 });
  return { docs, indexed, shared };
}
const folder = (p: string) => ({ path: p, label: path.basename(p), files: 0, size: '', indexed: 0, reviewed: 0 });
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const names = (docs: any) => (docs.records('d1') as { rel: string }[]).map((r) => r.rel).sort();

/** Twenty facilities, five report types, and five years of quarterly reports. */
function putQuarterlyReports(room: string) {
  const reports = [
    'Capital Expenditure', 'Liquidity Forecast', 'Maintenance Reserve', 'Insurance Claims', 'Debt Service',
  ];
  for (let year = 2022; year <= 2026; year++) {
    for (let quarter = 1; quarter <= 4; quarter++) {
      for (let facility = 1; facility <= 20; facility++) {
        const period = `Q${quarter} ${year}`;
        for (const report of reports) {
          const rel = `Finance/Facility ${facility}/${report} - ${period}.csv`;
          const row = `${report},Facility ${facility},${period},${facility * 12000}\n`;
          put(room, rel, `Report,Facility,Period,Amount\n${row}`);
        }
      }
    }
  }
}
/** the folders `set` names may not be listed (EACCES), as for a person the data room's permissions keep out; returns the undo */
function bar(set: () => string[]) {
  const realSync = fs.readdirSync, realAsync = fs.promises.readdir; const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
  (fs as any).readdirSync = (p: any, ...a: any[]) => { if (set().includes(p)) throw err(); return (realSync as any)(p, ...a); };
  (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (set().includes(p)) throw err(); return (realAsync as any)(p, ...a); };
  return () => { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; };
}
/** how many files were opened in the data room: listing a folder opens none */
function opened(vdr: string) {
  const realStream = fs.createReadStream, realOpen = fs.openSync; const n = { count: 0 };
  (fs as any).createReadStream = (f: any, ...a: any[]) => { if (typeof f === 'string' && f.startsWith(vdr)) n.count++; return (realStream as any)(f, ...a); };
  (fs as any).openSync = (f: any, ...a: any[]) => { if (typeof f === 'string' && f.startsWith(vdr)) n.count++; return (realOpen as any)(f, ...a); };
  return { n, restore: () => { (fs as any).createReadStream = realStream; (fs as any).openSync = realOpen; } };
}

describe('looking at an indexed deal’s folders again', () => {
  it('keeps both copies in use when only one changes after 31 days of unchanged looks (#33)', async () => {
    const root = tmp();
    const room = path.join(root, 'vdr');
    const copy = path.join(root, 'copy');
    const dayMs = 86_400_000;
    const clockDifference = 20 * 60_000;
    const rel = 'Finance/Facility 1/Liquidity Forecast - Q1 2022.csv';
    putQuarterlyReports(room);
    fs.cpSync(room, copy, { recursive: true });
    const office = pc(root, { id: 'office' });
    const laptop = pc(root, { id: 'laptop' });
    const versions = (computer: ReturnType<typeof pc>) =>
      computer.docs.records('d1').filter((record) => record.rel === rel).map((record) => record.docId);
    const officeLines = () => (office.shared.read('docs-office-d1.jsonl') ?? '').trimEnd().split('\n').length;
    try {
      val(await office.docs.index('d1', [folder(room)]));
      await office.docs.settled('d1');
      expect(office.docs.records('d1')).toHaveLength(2000);
      const [original] = versions(office);
      skew = clockDifference;
      val(await laptop.docs.mapFolder('d1', room, copy, true));
      val(await laptop.docs.index('d1', [folder(room)]));
      await laptop.docs.settled('d1');
      const indexed = officeLines();
      for (let day = 1; day <= 31; day++) {
        skew = day * dayMs;
        expect(await office.docs.freshen!('d1')).toEqual({ ok: true, value: 'same' });
      }
      expect(val(await office.docs.freshen!('d1'))).toBe('same');
      const afterLooks = officeLines();

      skew += clockDifference;
      put(copy, rel, 'Report,Period,Amount\nRevised liquidity forecast,Q1 2022,125000\n');
      expect(val(await laptop.docs.freshen!('d1'))).toBe('running');
      await laptop.docs.settled('d1');
      expect(versions(office)).toContain(original);
      expect(versions(laptop)).toEqual(versions(office));
      expect(versions(office)).toHaveLength(2);
      expect(afterLooks).toBe(indexed + 31);
      skew -= clockDifference;
      expect(val(await office.docs.freshen!('d1'))).toBe('same');
      expect(versions(office)).toContain(original);
      expect(officeLines()).toBe(afterLooks);

      // The office PC stops looking. A later replacement can clear its old sighting under the idle rule.
      skew = 62 * dayMs + clockDifference;
      put(copy, rel, 'Report,Period,Amount\nFinal liquidity forecast with reserve,Q1 2022,140000\n');
      expect(val(await laptop.docs.freshen!('d1'))).toBe('running');
      await laptop.docs.settled('d1');
      expect(versions(laptop)).toHaveLength(1);
      expect(versions(laptop)).not.toContain(original);

      // Restarting the idle PC with the stale, unchanged copy does not put the retired version back in the deal.
      skew -= clockDifference;
      const reopened = pc(root, { id: 'office' });
      expect(val(await reopened.docs.freshen!('d1'))).toBe('same');
      expect(versions(reopened)).toEqual(versions(laptop));
    } finally {
      skew = 0;
    }
  }, 120000);

  it('at deal scale: an unchanged data room of 3,000 files opens nothing; one added, one changed and one removed are all picked up, and only those are read', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr');
    for (let i = 0; i < 3000; i++) put(vdr, `${String(i % 30).padStart(2, '0')} Section/Doc ${i}.csv`, csv(i));
    const x = pc(root);
    expect(val(await x.docs.freshen!('d1'))).toBe('unknown');                       // never indexed here: a person starts that
    val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
    expect(names(x.docs)).toHaveLength(3000); expect(x.indexed).toEqual(['d1']);

    const lines = () => x.shared.read('docs-A-d1.jsonl')?.length ?? 0; const before = lines();
    let spy = opened(vdr); const t0 = Date.now();
    try { expect(val(await x.docs.freshen!('d1'))).toBe('same'); } finally { spy.restore(); }
    const ms = Date.now() - t0;
    expect(spy.n.count).toBe(0); expect(lines()).toBe(before); expect(x.indexed).toEqual(['d1']);
    expect(ms).toBeLessThan(5000);                                                  // a listing of names, sizes and dates only

    put(vdr, '05 Section/Model audit report.csv', csv('audit'));                     // added
    put(vdr, '07 Section/Doc 7.csv', csv('seven, revised'));                         // a new version saved over it
    fs.rmSync(path.join(vdr, '09 Section/Doc 9.csv'));                               // removed
    spy = opened(vdr);
    try { expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1'); } finally { spy.restore(); }
    expect(spy.n.count).toBeLessThanOrEqual(4);                                     // the two new files (each read once, maybe fingerprinted once), not the 3,000
    const now = names(x.docs);
    expect(now).toContain('05 Section/Model audit report.csv'); expect(now).not.toContain('09 Section/Doc 9.csv'); expect(now).toHaveLength(3000);
    expect((x.docs.records('d1') as any[]).filter((r) => r.rel === '07 Section/Doc 7.csv')).toHaveLength(1);   // the old version left the place
    expect(x.indexed).toEqual(['d1', 'd1']);                                         // the run's end starts the first pass, which looks at what arrived
    expect(val(await x.docs.poll('d1'))).toMatchObject({ done: true, folders: [{ files: 3000, indexed: 3000 }] });
    expect(val(await x.docs.freshen!('d1'))).toBe('same');                          // and the next look finds nothing new
  }, 120000);

  it('a data room that cannot be reached, or only in part, starts nothing and takes nothing away; once it is back, what changed meanwhile is read', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 200; i++) put(vdr, `${i % 4}/f${i}.csv`, csv(i));
    const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
    const lines = () => x.shared.read('docs-A-d1.jsonl') ?? ''; const before = lines();
    // the drive drops: the folder is not there
    fs.renameSync(vdr, `${vdr}-away`);
    expect(val(await x.docs.freshen!('d1'))).toBe('same'); expect(lines()).toBe(before); expect(names(x.docs)).toHaveLength(200);
    fs.renameSync(`${vdr}-away`, vdr);
    // a subfolder cannot be listed: the listing is not the whole folder, so nothing starts
    put(vdr, '2/new.csv', csv('new'));
    const real = fs.promises.readdir; (fs.promises as any).readdir = (d: any, ...a: any[]) => (String(d) === path.join(vdr, '1') ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : (real as any)(d, ...a));
    try { expect(val(await x.docs.freshen!('d1'))).toBe('same'); } finally { (fs.promises as any).readdir = real; }
    expect(lines()).toBe(before); expect(x.indexed).toEqual(['d1']);
    // an empty folder (a drive that answers with nothing) is not taken as emptied
    const away = `${vdr}-full`; fs.renameSync(vdr, away); fs.mkdirSync(vdr);
    expect(val(await x.docs.freshen!('d1'))).toBe('same'); expect(lines()).toBe(before);
    fs.rmdirSync(vdr); fs.renameSync(away, vdr);
    // back whole: the file added meanwhile is read, and nothing else changes
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
    expect(names(x.docs)).toHaveLength(201); expect(names(x.docs)).toContain('2/new.csv');
  }, 60000);

  it('a run that broke part-way is finished by the next look; a folder taken off the deal is not read again; looks asked for at once are one look', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'), other = path.join(root, 'other');
    for (let i = 0; i < 50; i++) { put(vdr, `a${i}.csv`, csv(i)); put(other, `b${i}.csv`, csv(`b${i}`)); }
    let on = [vdr, other]; const x = pc(root, { folders: () => on });
    val(await x.docs.index('d1', [folder(vdr), folder(other)])); await x.docs.settled('d1');
    // taken off the deal: a file added there is not read
    on = [vdr]; put(other, 'b-new.csv', csv('b-new'));
    expect(val(await x.docs.freshen!('d1'))).toBe('same'); expect(names(x.docs)).not.toContain('b-new.csv');
    // three looks at once make one run
    put(vdr, 'a-new.csv', csv('a-new'));
    const r = await Promise.all([x.docs.freshen!('d1'), x.docs.freshen!('d1'), x.docs.freshen!('d1')]);
    expect(r.map((y) => val(y))).toEqual(['running', 'running', 'running']); await x.docs.settled('d1');
    expect(x.indexed).toHaveLength(2); expect(names(x.docs)).toContain('a-new.csv');
    // a run that the data room broke part-way: the next look reads the folder again even though nothing changed since
    put(vdr, 'a-late.csv', csv('late')); let n = 0; const real = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...a: any[]) => { if (typeof f === 'string' && f.startsWith(vdr) && ++n === 1) { const { PassThrough } = require('node:stream'); const s = new PassThrough(); setTimeout(() => s.destroy(Object.assign(new Error('EIO'), { code: 'EIO' })), 5); return s; } return (real as any)(f, ...a); };
    try { expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1'); } finally { (fs as any).createReadStream = real; }
    expect(val(await x.docs.poll('d1')).stopped).toBe(true); expect(names(x.docs)).not.toContain('a-late.csv');
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
    expect(names(x.docs)).toContain('a-late.csv'); expect(val(await x.docs.poll('d1')).done).toBe(true);
  }, 60000);

  it('a run that finds nothing new and nothing gone (only dates changed) starts no first pass; one that finds a file gone does', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 100; i++) put(vdr, `f${i}.csv`, csv(i));
    const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1'); expect(x.indexed).toEqual(['d1']);
    const later = new Date(Date.UTC(2026, 10, 18)); for (let i = 0; i < 20; i++) fs.utimesSync(path.join(vdr, `f${i}.csv`), later, later);   // a sync client wrote them again, same bytes
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
    expect(x.indexed).toEqual(['d1']); expect(val(await x.docs.poll('d1')).done).toBe(true); expect(val(await x.docs.freshen!('d1'))).toBe('same');
    fs.rmSync(path.join(vdr, 'f50.csv'));
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
    expect(x.indexed).toEqual(['d1', 'd1']); expect(names(x.docs)).toHaveLength(99);
  }, 60000);

  it('a file still being copied in is not read part-way: the look waits until the folder stops changing', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `f${i}.csv`, csv(i));
    const x = pc(root, { settleMs: 300 }); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
    const big = put(vdr, 'big.csv', csv('part one'));
    const growing = setTimeout(() => fs.appendFileSync(big, 'more,rows\n'.repeat(50)), 100);                    // the copy goes on while the look waits
    expect(val(await x.docs.freshen!('d1'))).toBe('same'); clearTimeout(growing); expect(names(x.docs)).not.toContain('big.csv');
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');                      // finished copying: read whole
    const rec = (x.docs.records('d1') as any[]).find((r) => r.rel === 'big.csv'); expect(rec.size).toBe(fs.statSync(big).size);
  }, 60000);

  it('a new file that is locked when the look reads it is read at a later look, though nothing else changed', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 10; i++) put(vdr, `f${i}.csv`, csv(i));
    const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
    const locked = put(vdr, 'locked.csv', csv('open in Excel')); const real = fs.createReadStream;
    (fs as any).createReadStream = (f: any, ...a: any[]) => { if (f === locked) { const { PassThrough } = require('node:stream'); const s = new PassThrough(); setTimeout(() => s.destroy(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })), 5); return s; } return (real as any)(f, ...a); };
    try { expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1'); } finally { (fs as any).createReadStream = real; }
    expect(names(x.docs)).not.toContain('locked.csv');
    expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');                      // closed again: read
    expect(names(x.docs)).toContain('locked.csv'); expect(val(await x.docs.freshen!('d1'))).toBe('same');
  }, 60000);

  it('the quiet listing is the same listing as the one a run reads, in the same order', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr');
    for (const rel of ['b/2.csv', 'b/10.csv', 'a.csv', 'B/x.csv', 'c/d/e.csv', '.hidden', '~$lock.docx', 'Thumbs.db', 'z/empty.csv']) put(vdr, rel, rel.endsWith('empty.csv') ? '' : csv(rel));
    expect(await walkQuietly(vdr)).toEqual(walk(vdr));
  });

  it('a folder inside the data room that this person may not open: changes elsewhere are still read, and once it opens it is read', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 300; i++) put(vdr, `${String(i % 6).padStart(2, '0')} Section/Doc ${i}.csv`, csv(i));
    // "03 Section" may not be listed, as for a person the data room's permissions keep out
    const realSync = fs.readdirSync, realAsync = fs.promises.readdir; let closed = true;
    const no = (p: unknown) => closed && typeof p === 'string' && p.endsWith(`${path.sep}03 Section`);
    const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realSync as any)(p, ...a); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realAsync as any)(p, ...a); };
    try {
      const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
      expect(names(x.docs)).toHaveLength(250);
      expect(val(await x.docs.freshen!('d1'))).toBe('same');                                                   // nothing changed: nothing read, the closed folder is not a change
      put(vdr, '05 Section/Model audit report.csv', csv('audit'));
      expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
      expect(names(x.docs)).toContain('05 Section/Model audit report.csv'); expect(names(x.docs)).toHaveLength(251);
      closed = false;                                                                                         // it opens: its files are read
      expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
      expect(names(x.docs)).toHaveLength(301); expect(val(await x.docs.freshen!('d1'))).toBe('same');
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; }
  }, 60000);

  it('a folder inside a closed folder stays unread when a PC that cannot open the outer one reads later', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); put(vdr, 'a/x.csv', csv('x')); put(vdr, 'a/b/y.csv', csv('y')); put(vdr, 'c.csv', csv('c'));
    // on the first PC "a/b" may not be opened; on the laptop, "a" itself
    let closed = 'b'; const realSync = fs.readdirSync, realAsync = fs.promises.readdir;
    const no = (p: unknown) => !!closed && typeof p === 'string' && p === path.join(vdr, ...(closed === 'b' ? ['a', 'b'] : ['a']));
    const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realSync as any)(p, ...a); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realAsync as any)(p, ...a); };
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      expect(office.docs.unread!('d1')).toEqual(['a/b']);
      closed = 'a'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual(['a/b']); expect(office.docs.unread!('d1')).toEqual(['a/b']);   // no PC has read it yet
      closed = ''; val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');            // it opens on the laptop: read
      expect(laptop.docs.unread!('d1')).toEqual([]); expect(office.docs.unread!('d1')).toEqual([]);
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; }
  }, 60000);

  it('a PC that can open a folder another PC could not takes it in at its next look and speaks for it; until then it counts as unread', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    fs.mkdirSync(path.join(vdr, '07 Placeholder'));                                  // an empty folder: nothing in it is ever recorded
    let barred = false; const realSync = fs.readdirSync, realAsync = fs.promises.readdir;
    const no = (p: unknown) => barred && p === path.join(vdr, '07 Placeholder'); const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realSync as any)(p, ...a); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realAsync as any)(p, ...a); };
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      barred = true; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      barred = false; expect(office.docs.unread!('d1')).toEqual(['07 Placeholder']);     // the office read before the laptop said: it has not said it took it in
      expect(val(await office.docs.freshen!('d1'))).toBe('running'); await office.docs.settled('d1');   // its next look does
      expect(office.docs.unread!('d1')).toEqual([]); expect(laptop.docs.unread!('d1')).toEqual([]);
      expect(val(await office.docs.freshen!('d1'))).toBe('same');                       // and does not read it again for that
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; }
  }, 60000);

  it('two PCs each barred from a different folder: each speaks for the other\'s, so neither counts as unread, and a look writes nothing', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    fs.mkdirSync(path.join(vdr, '30 Clean team')); fs.mkdirSync(path.join(vdr, '31 Board only')); put(vdr, '32 Both barred/x.csv', csv('x'));
    let who = 'office'; const realSync = fs.readdirSync, realAsync = fs.promises.readdir;
    const no = (p: unknown) => p === path.join(vdr, '32 Both barred') || p === path.join(vdr, who === 'office' ? '30 Clean team' : '31 Board only');
    const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realSync as any)(p, ...a); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realAsync as any)(p, ...a); };
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      who = 'laptop'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      const lines = () => fs.readdirSync(path.join(root, 'shared')).filter((n) => n.startsWith('docs-')).reduce((a, n) => a + fs.readFileSync(path.join(root, 'shared', n), 'utf8').split('\n').length, 0);
      // the laptop read after the office said, so took the office's in; the office takes the laptop's in at its next look, once
      who = 'office'; expect(val(await office.docs.freshen!('d1'))).toBe('running'); await office.docs.settled('d1');
      const before = lines();
      for (let round = 0; round < 4; round++) for (const [name, x] of [['office', office], ['laptop', laptop]] as const) {
        who = name; expect(val(await x.docs.freshen!('d1'))).toBe('same');
        expect(x.docs.unread!('d1')).toEqual(['32 Both barred']);                    // only the folder neither could open
      }
      expect(lines()).toBe(before);
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; }
  }, 60000);

  it('same-named closed folders in two deal folders are told apart', async () => {
    const root = tmp(); const seller = path.join(root, 'Seller VDR'), buyer = path.join(root, 'Buyer VDR');
    for (const v of [seller, buyer]) { put(v, 'a.csv', csv(v)); fs.mkdirSync(path.join(v, '03 Legal')); }
    const realSync = fs.readdirSync, realAsync = fs.promises.readdir; const no = (p: unknown) => typeof p === 'string' && p.endsWith(`${path.sep}03 Legal`);
    const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realSync as any)(p, ...a); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return (realAsync as any)(p, ...a); };
    try {
      const x = pc(root, { folders: () => [seller, buyer] }); val(await x.docs.index('d1', [folder(seller), folder(buyer)])); await x.docs.settled('d1');
      expect(x.docs.unread!('d1')).toEqual(['Buyer VDR/03 Legal', 'Seller VDR/03 Legal']);
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; }
  }, 60000);

  it('a PC whose reading is older than a folder, or whose copy does not hold it, does not speak for it', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    let barred = false; let hidden = false; const realSync = fs.readdirSync, realAsync = fs.promises.readdir; const clean = path.join(vdr, '09 Clean team');
    const no = (p: unknown) => barred && p === clean; const err = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    // the office's copy may not hold the folder at all: it is not listed there
    const hide = (p: unknown, r: any) => (hidden && p === vdr && Array.isArray(r) ? r.filter((e: any) => (typeof e === 'string' ? e : e.name) !== '09 Clean team') : r);
    (fs as any).readdirSync = (p: any, ...a: any[]) => { if (no(p)) throw err(); return hide(p, (realSync as any)(p, ...a)); };
    (fs.promises as any).readdir = async (p: any, ...a: any[]) => { if (no(p)) throw err(); return hide(p, await (realAsync as any)(p, ...a)); };
    const realStat = fs.statSync; (fs as any).statSync = (p: any, ...a: any[]) => { if (hidden && typeof p === 'string' && p.startsWith(clean)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return (realStat as any)(p, ...a); };
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      for (let i = 0; i < 5; i++) put(vdr, `09 Clean team/Doc ${i}.csv`, csv(`clean ${i}`));        // added after the office read
      barred = true; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1'); barred = false;
      expect(laptop.docs.unread!('d1')).toEqual(['09 Clean team']); expect(office.docs.unread!('d1')).toEqual(['09 Clean team']);
      hidden = true; await office.docs.freshen!('d1'); await office.docs.settled('d1');          // the office's copy without it: still unread
      expect(laptop.docs.unread!('d1')).toEqual(['09 Clean team']);
      hidden = false; expect(val(await office.docs.freshen!('d1'))).toBe('running'); await office.docs.settled('d1');   // it arrives there: read
      expect(laptop.docs.unread!('d1')).toEqual([]); expect(names(office.docs).filter((n) => n.startsWith('09 '))).toHaveLength(5);
    } finally { (fs as any).readdirSync = realSync; (fs.promises as any).readdir = realAsync; (fs as any).statSync = realStat; }
  }, 60000);
  it('a PC that took a folder in and then may no longer open it says so at its next look, so what arrives there counts as unread', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    const clean = path.join(vdr, '30 Clean team'); fs.mkdirSync(clean);
    let who = 'office'; let officeToo = false; const undo = bar(() => (who === 'laptop' || officeToo ? [clean] : []));
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      who = 'laptop'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      who = 'office'; val(await office.docs.freshen!('d1')); await office.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual([]);                                  // the office took it in (empty)
      officeToo = true; for (let i = 0; i < 5; i++) put(vdr, `30 Clean team/Doc ${i}.csv`, csv(`c${i}`));
      expect(val(await office.docs.freshen!('d1'))).toBe('running'); await office.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual(['30 Clean team']); expect(office.docs.unread!('d1')).toEqual(['30 Clean team']);
      expect(val(await office.docs.freshen!('d1'))).toBe('same');                     // said once
    } finally { undo(); }
  }, 60000);

  it('a closed folder that is renamed is named by its new name only', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    const a = path.join(vdr, '30 Clean team'), b = path.join(vdr, '30 Clean team (restricted)'); fs.mkdirSync(a);
    const undo = bar(() => [a, b]);
    try {
      const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
      expect(x.docs.unread!('d1')).toEqual(['30 Clean team']);
      fs.renameSync(a, b);
      expect(val(await x.docs.freshen!('d1'))).toBe('running'); await x.docs.settled('d1');
      expect(x.docs.unread!('d1')).toEqual(['30 Clean team (restricted)']);
      expect(val(await x.docs.freshen!('d1'))).toBe('same');
    } finally { undo(); }
  }, 60000);

  it('a PC that speaks for a folder another may not open keeps speaking for it while nothing changes for over 30 days', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 20; i++) put(vdr, `0${i % 4} Section/Doc ${i}.csv`, csv(i));
    const clean = path.join(vdr, '30 Clean team'); fs.mkdirSync(clean);
    let who = 'office'; const undo = bar(() => (who === 'laptop' ? [clean] : []));
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      who = 'laptop'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      who = 'office'; val(await office.docs.freshen!('d1')); await office.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual([]);
      for (let day = 1; day <= 31; day++) {                                          // both PCs in use, and nothing changes
        skew = day * 86_400_000;
        for (const [name, x] of [['office', office], ['laptop', laptop]] as const) { who = name; expect(val(await x.docs.freshen!('d1'))).toBe('same'); }
      }
      who = 'office'; expect(laptop.docs.unread!('d1')).toEqual([]); expect(office.docs.unread!('d1')).toEqual([]);
    } finally { undo(); skew = 0; }
  }, 120000);
  for (const how of ['renamed', 'removed'] as const) it(`a closed folder named only by a PC no longer used does not hold checks back once it is ${how}`, async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 2000; i++) put(vdr, `${String(i % 20).padStart(2, '0')} Section/Doc ${i}.csv`, csv(i));
    const clean = path.join(vdr, '30 Clean team'); fs.mkdirSync(clean);
    let who = 'office'; const undo = bar(() => (who === 'laptop' ? [clean] : []));
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      who = 'laptop'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      who = 'office'; await office.docs.freshen!('d1'); await office.docs.settled('d1');
      expect(office.docs.unread!('d1')).toEqual([]);
      // the laptop is no longer used; the data room renames or removes the folder
      if (how === 'renamed') fs.renameSync(clean, path.join(vdr, '30 Clean team (old)')); else fs.rmSync(clean, { recursive: true });
      // for 30 days the laptop still counts as in use, and the folder as closed to it; after that, not
      for (const day of [0, 1, 2, 31, 32, 60]) { skew = day * 86_400_000; val(await office.docs.freshen!('d1')); await office.docs.settled('d1'); expect(office.docs.unread!('d1')).toEqual(day < 30 ? ['30 Clean team'] : []); }
    } finally { undo(); skew = 0; }
  }, 120000);

  it('a PC whose copy no longer holds an empty folder another PC may not open stops speaking for it at its next look', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 2000; i++) put(vdr, `${String(i % 20).padStart(2, '0')} Section/Doc ${i}.csv`, csv(i));
    const clean = path.join(vdr, '30 Clean team'); fs.mkdirSync(clean);
    let who = 'office'; const undo = bar(() => (who === 'laptop' ? [clean] : []));
    try {
      const office = pc(root, { id: 'office' }); val(await office.docs.index('d1', [folder(vdr)])); await office.docs.settled('d1');
      who = 'laptop'; const laptop = pc(root, { id: 'laptop' }); val(await laptop.docs.index('d1', [folder(vdr)])); await laptop.docs.settled('d1');
      who = 'office'; await office.docs.freshen!('d1'); await office.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual([]);
      fs.rmdirSync(clean);                                                            // only the office's copy loses it (here, the one copy: the laptop is barred from it anyway)
      expect(val(await office.docs.freshen!('d1'))).toBe('running'); await office.docs.settled('d1');
      expect(laptop.docs.unread!('d1')).toEqual(['30 Clean team']);                 // the laptop, still in use, still may not open it
      expect(val(await office.docs.freshen!('d1'))).toBe('same');
    } finally { undo(); }
  }, 120000);
  it('a PC in use that may not open a folder keeps counting it as closed while nothing changes for over 30 days', async () => {
    const root = tmp(); const vdr = path.join(root, 'vdr'); for (let i = 0; i < 2000; i++) put(vdr, `${String(i % 20).padStart(2, '0')} Section/Doc ${i}.csv`, csv(i));
    const clean = path.join(vdr, '30 Clean team'); for (let i = 0; i < 50; i++) put(vdr, `30 Clean team/C${i}.csv`, csv(`c${i}`));
    const undo = bar(() => [clean]);
    try {
      const x = pc(root); val(await x.docs.index('d1', [folder(vdr)])); await x.docs.settled('d1');
      for (const day of [1, 10, 29, 30, 31, 40, 60]) { skew = day * 86_400_000; expect(val(await x.docs.freshen!('d1'))).toBe('same'); expect(x.docs.unread!('d1')).toEqual(['30 Clean team']); }
    } finally { undo(); skew = 0; }
  }, 120000);
});
