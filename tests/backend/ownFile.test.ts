// @vitest-environment node
// A PC's own notes and check files are kept whole: lines lost from the synced copy are put back from the copy kept on the
// PC, before the file is read or written again; a line that cannot be kept here is not shared; one that cannot be shared is
// not kept.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { appendOwn, healOwn, wholeLines } from '../../src/backend/ownFile';
import { nodeAi, type AiDocs } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import { Mem, Tearing } from './reviewKit';

class Refusing extends Mem { refuse = false; append(n: string, t: string) { if (this.refuse) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); super.append(n, t); } }

describe('own files', () => {
  it('appends to the local copy first; a failed shared write takes the line back out; lost lines are put back once', () => {
    const shared = new Refusing(), local = new Refusing();
    appendOwn(shared, local, 'f', 'one\n'); appendOwn(shared, local, 'f', 'two\n');
    local.refuse = true; expect(() => appendOwn(shared, local, 'f', 'three\n')).toThrow(); expect(shared.files.get('f')).toBe('one\ntwo\n'); local.refuse = false;
    shared.refuse = true; expect(() => appendOwn(shared, local, 'f', 'four\n')).toThrow(); expect(local.files.get('f')).toBe('one\ntwo\n'); shared.refuse = false;
    shared.files.set('f', 'one\n');                                                     // the sync client put back an older copy
    healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n'); healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n');
  });

  it('with keep, a line the shared folder refuses stays in the local copy and is shared by the next heal', () => {
    const shared = new Refusing(), local = new Refusing();
    expect(appendOwn(shared, local, 'f', 'one\n', true)).toBeUndefined();
    shared.refuse = true; expect((appendOwn(shared, local, 'f', 'two\n', true) as { code?: string }).code).toBe('ENOSPC');
    expect(local.files.get('f')).toBe('one\ntwo\n'); expect(shared.files.get('f')).toBe('one\n');
    healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\n');            // still refused: tried again at the next look
    shared.refuse = false; healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n');
    local.refuse = true; expect(() => appendOwn(shared, local, 'f', 'three\n', true)).toThrow(); expect(shared.files.get('f')).toBe('one\ntwo\n');
  });

  it('puts back a complete local line after two torn appends leave the shared file the same size (#784)', () => {
    const dirs = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'own-file-')));
    const [shared, local] = dirs.map((dir) => nodeFolder(dir, []));
    const name = 'notes.jsonl';
    const intact = JSON.stringify({ note: 'Confirm the scope of the guarantee.' });
    const lost = JSON.stringify({ note: 'The repayment schedule includes a bullet payment.' });
    const tornFirst = '{"note":"The minimum cash covenant resets after each quarterly measurement.';
    const tornSecond = '{"note":"The operating account remains pledged until maturity.';
    const broken = tornFirst.slice(0, 23) + tornSecond.slice(0, lost.length + 1 - 23);
    try {
      appendOwn(shared, local, name, `${intact}\n${lost}\n`);
      const earlierDate = new Date('2025-01-01T00:00:00Z');
      const sharedPath = path.join(dirs[0], name);
      fs.utimesSync(sharedPath, earlierDate, earlierDate);
      healOwn(shared, local, name);
      const read = vi.spyOn(shared, 'read');
      healOwn(shared, local, name);
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
      fs.writeFileSync(sharedPath, `${intact}\n${broken}`);
      fs.utimesSync(sharedPath, earlierDate, earlierDate);
      expect(shared.size(name)).toBe(local.size(name));

      healOwn(shared, local, name);

      const repaired = shared.read(name) ?? '';
      expect(repaired).toContain(broken);
      expect(wholeLines(repaired).filter((line) => !line.includes(broken))).toEqual([intact, lost]);
      expect(local.read(name)).toBe(`${intact}\n${lost}\n`);
      healOwn(shared, local, name);
      expect(shared.read(name)).toBe(repaired);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the check log: results lost from the synced copy are back when it is read again, and every PC reads them', async () => {
    const shared = new Mem(), local = new Mem(); const repo = memRepo();
    await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Proseware' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
    const svc = new StandInService((c) => JSON.stringify(c.prompt.includes('Check each of these') ? { items: [{ id: 'I1', result: 'more', need: 'the audit report' }] } : { core: [] }));
    const docs: AiDocs = { records: () => [{ docId: 'doc_1', hash: 'h', name: 'A.pdf', folder: 'vdr', rel: 'A.pdf', size: 1, pages: 1 }], wanted: async () => [{ docId: 'doc_1', name: 'A.pdf', read: async () => new TextEncoder().encode('A') }] } as any;
    const make = (installId: string, loc?: Mem) => nodeAi({ service: svc, docs, keeper: new StoreKeeper(svc, new Mem(), { recheckMs: 0 }), repo, shared, local: loc, installId, checklist: () => ({ broad: [{ id: 'b1', text: 'The model is audited' }], product: [], sector: [] }) });
    const office = make('office', local);
    expect((await office.firstPass('d1')).ok).toBe(true); expect((await office.gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);
    shared.files.set('checks-office-d1.jsonl', '');                                     // the sync client lost every line
    expect((await make('home').gaps('d1') as any).value).toEqual([]);                  // a PC reading now sees nothing yet
    expect((await office.gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);   // the office reads its file again: put back
    expect((await make('home').gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);
  });

  it('a local append that fails part way is cut off, so a later line is kept whole and put back whole (#126)', () => {
    const shared = new Tearing();
    const local = new Tearing();
    appendOwn(shared, local, 'f', 'one\n');
    local.tear = 2;
    expect(() => appendOwn(shared, local, 'f', 'two\n')).toThrow('ENOSPC');
    expect(local.files.get('f')).toBe('one\n');
    expect(shared.files.get('f')).toBe('one\n');
    appendOwn(shared, local, 'f', 'three\n');
    shared.files.set('f', 'one\n');                                     // the sync client put back an older copy
    healOwn(shared, local, 'f');
    expect(shared.files.get('f')).toBe('one\nthree\n');
    expect(local.files.get('f')).toBe('one\nthree\n');
  });

  it('on a real disk, a short write is never glued to the next line, through a sync rollback (#126)', () => {
    const dirs = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'own-file-')));
    const [shared, local] = dirs.map((dir) => nodeFolder(dir, []));
    try {
      appendOwn(shared, local, 'f', 'one\n');
      const real = fs.writeSync.bind(fs) as (...a: any[]) => number;
      const twoBytes = (fd: number, bytes: Buffer, at: number) => real(fd, bytes.subarray(at, at + 2));
      vi.spyOn(fs, 'writeSync').mockImplementationOnce(twoBytes as any).mockImplementationOnce((() => 0) as any);
      expect(() => appendOwn(shared, local, 'f', 'two\n')).toThrow('ENOSPC');
      vi.restoreAllMocks();
      appendOwn(shared, local, 'f', 'three\n');
      shared.write('f', 'one\n');                                       // the sync client put back an older copy
      healOwn(shared, local, 'f');
      expect([shared.read('f'), local.read('f')]).toEqual(['one\nthree\n', 'one\nthree\n']);
    } finally {
      vi.restoreAllMocks();
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('when the failed part cannot be cut off yet, nothing is added after it and it is never shared', () => {
    const shared = new Tearing();
    const local = new Tearing();
    const note = (n: number) => `Revenue recognition on contract ${n} – see §4.2`;
    const line = (n: number) => `${JSON.stringify({ v: 1, n, note: note(n) })}\n`;
    appendOwn(shared, local, 'f', line(1));
    local.refuseWrites = true;
    local.tear = 30;
    expect(() => appendOwn(shared, local, 'f', line(2) + line(3), true)).toThrow('ENOSPC');
    expect(() => appendOwn(shared, local, 'f', line(4))).toThrow('ENOSPC');    // still full: refused, not glued on
    shared.files.set('f', '');                                                  // the sync client lost every line
    healOwn(shared, local, 'f');
    expect(shared.files.get('f')).toBe('');                                     // the torn part is not put back
    local.refuseWrites = false;
    appendOwn(shared, local, 'f', line(5));
    expect(local.files.get('f')).toBe(line(1) + line(5));
    healOwn(shared, local, 'f');
    expect(wholeLines(shared.files.get('f')!).map((l) => JSON.parse(l).n)).toEqual([5, 1]);
  });

  it('a failed write of several lines is taken back whole, including lines it finished', () => {
    const shared = new Tearing();
    const local = new Tearing();
    appendOwn(shared, local, 'f', 'café\n');
    local.tear = 7;
    expect(() => appendOwn(shared, local, 'f', 'naïve\nrésumé\n', true)).toThrow('ENOSPC');
    expect(local.files.get('f')).toBe('café\n');
    healOwn(shared, local, 'f', { whole: true });
    expect(shared.files.get('f')).toBe('café\n');
  });

  it('a file that cannot be measured is read to measure it; failing that, it loses only a part line', () => {
    const shared = new Tearing();
    const local = new Tearing();
    appendOwn(shared, local, 'f', 'one\ntwo\n');
    local.size = () => -1;                                              // the disk would not say how big the file is
    local.tear = 6;
    expect(() => appendOwn(shared, local, 'f', 'three\nfour\n')).toThrow('ENOSPC');
    expect(local.files.get('f')).toBe('one\ntwo\n');
    vi.spyOn(local, 'read').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    local.tear = 6;
    expect(() => appendOwn(shared, local, 'f', 'three\nfour\n')).toThrow('ENOSPC');
    expect(local.files.get('f')).toBe('one\ntwo\nthree\n');            // never a line from before the append
  });

  it('a file held for a moment when its end is checked is still appended to, and checked at the next append', () => {
    const shared = new Tearing();
    const local = new Tearing();
    local.files.set('f', 'one\n');
    const read = vi.spyOn(local, 'read').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    appendOwn(shared, local, 'f', 'two\n');
    local.files.set('f', `${local.files.get('f')}{"v":1,"cut`);       // a run that stopped part way
    appendOwn(shared, local, 'f', 'three\n');
    expect(read).toHaveBeenCalledTimes(2);
    expect(local.files.get('f')).toBe('one\ntwo\nthree\n');
  });

  it('a part line left by a stopped run that cannot be cut off yet refuses the next append (#126)', () => {
    const shared = new Tearing();
    const local = new Tearing();                                        // a new run: nothing is known about the file
    shared.files.set('f', 'one\n');
    local.files.set('f', 'one\ntw');
    local.refuseWrites = true;                                          // too full to rewrite the file, not to append
    expect(() => appendOwn(shared, local, 'f', 'three\n')).toThrow('ENOSPC');
    expect([local.files.get('f'), shared.files.get('f')]).toEqual(['one\ntw', 'one\n']);
    local.refuseWrites = false;
    appendOwn(shared, local, 'f', 'three\n');
    shared.files.set('f', 'one\n');                                     // the sync client put back an older copy
    healOwn(shared, local, 'f');
    expect([local.files.get('f'), shared.files.get('f')]).toEqual(['one\nthree\n', 'one\nthree\n']);
  });

  it('the start of a line left by a run that stopped part way is cut off before the next append', () => {
    const shared = new Tearing();
    const local = new Tearing();
    local.files.set('f', 'one\n{"v":1,"n":2,"no');
    shared.files.set('f', 'one\n');
    healOwn(shared, local, 'f');
    expect(shared.files.get('f')).toBe('one\n');
    appendOwn(shared, local, 'f', 'three\n');
    expect(local.files.get('f')).toBe('one\nthree\n');
    expect(shared.files.get('f')).toBe('one\nthree\n');
  });

  it('counts a line once across a file, a conflict copy of it and a read again, and keeps only the key it is given for each', () => {
    const once = new Set<string>(); const long = (n: number) => `{"v":1,"n":${n},"text":"${'x'.repeat(500)}"}`; const key = (l: string) => `k${l.length}:${l.slice(0, 12)}`;
    const read = (text: string) => wholeLines(text, 0, once, key);
    expect(read(`${long(1)}\n${long(2)}\n`)).toEqual([long(1), long(2)]);
    expect(read(`${long(1)}\n${long(2)}\n${long(3)}\n`)).toEqual([long(3)]);   // the whole file read again: only the new line
    expect(read(`${long(2)}\n${long(4)}\n${long(5)}`)).toEqual([long(4)]);      // a conflict copy; a last line with no end is not there yet
    expect([...once]).toEqual([1, 2, 3, 4].map((n) => key(long(n))));         // the keys, not the lines, which could hold the whole text
  });
});
