// After a file stayed refused for the whole wait, only that file is tried once per write for a while.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { nodeFolder } from '../../src/backend/nodeFolder';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-r2-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('a folder after one file stayed refused', () => {
  it('a journal held past the full wait (a scanner) does not stop a change file busy for 30 ms from being waited for', () => {
    const dir = tmp(); const f = nodeFolder(dir, [20, 20, 20]);
    const real = fs.renameSync.bind(fs); let jUntil = Date.now() + 200;
    const realOpen = fs.openSync.bind(fs); let cUntil = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: any, b: any) => { if (String(b).endsWith('ops.json') && Date.now() < jUntil) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(a, b); }) as any);
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...r: any[]) => { if (String(p).endsWith('changes.jsonl') && Date.now() < cUntil) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return (realOpen as any)(p, ...r); }) as any);
    expect(() => f.write('ops.json', '{}')).toThrow(/EBUSY/);          // held for 200 ms, longer than the 60 ms of waits here
    cUntil = Date.now() + 30;                                           // a sync client holds the change file for 30 ms
    let err: unknown = null; try { f.append('changes.jsonl', 'line\n'); } catch (e) { err = e; }
    expect(err).toBeNull();
  });
  it('two folders keep their own waits', () => {
    const a = nodeFolder(tmp(), [5]); const b = nodeFolder(tmp(), [5]);
    const realOpen = fs.openSync.bind(fs); let n = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...r: any[]) => { if (String(p).includes('x.jsonl')) { n++; if (n <= 2 || n === 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return (realOpen as any)(p, ...r); }) as any);
    expect(() => a.append('x.jsonl', '1')).toThrow();                  // 2 tries, a rests
    expect(() => b.append('x.jsonl', '1')).not.toThrow();              // b: third try refused, waits, fourth ok
  });
});
