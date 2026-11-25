// The Q&A log in its folder: saved over in place, the version it replaces first dated in the archive, nothing ever lost.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { trackPaths } from './openedPaths';
import { archiveOf, saveLog, createLog, sha256, restoreAside, whoHasOpen } from '../../src/backend/qaLogFolder';

const folder = (...dirs: string[]) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-')); for (const x of dirs) fs.mkdirSync(path.join(d, x)); return d; };
const bytes = (s: string) => new Uint8Array(Buffer.from(s));
const at = new Date(2026, 10, 15, 16, 12);
const list = (d: string) => fs.readdirSync(d).sort();
const FILE = 'Lender A Q&A.xlsx';
/** a folder holding the log, as the team keeps it */
const withLog = (s = 'theirs', ...dirs: string[]) => { const d = folder(...dirs); fs.writeFileSync(path.join(d, FILE), s); return d; };
const read = (d: string, f = FILE) => fs.readFileSync(path.join(d, f), 'utf8');
/** the folder's clock moves on two minutes: every file made from now on reads as made then, so the ones before are old */
const later = () => {
  const wait = Date.now() + 30; while (Date.now() < wait) { /* so the files before are 20 ms older at least */ }
  const t0 = Date.now() - 10; const st = fs.statSync;   // 10 ms: a file system's clock may lag a little behind
  vi.spyOn(fs, 'statSync').mockImplementation(((f: fs.PathLike, o?: never) => { const s = st(f, o) as fs.Stats; return s && s.ctimeMs >= t0 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ctimeMs: s.ctimeMs + 2 * 60_000 }) : s; }) as never);
};

describe('the archive folder', () => {
  it('is the folder\'s own, whatever it is called', () => {
    for (const name of ['Archive', '02. Archive', 'Old', 'Superseded', 'Prior versions', '9 - Previous versions', 'Archived']) expect(path.basename(archiveOf(folder(name, 'Drafts')))).toBe(name);
  });
  it('is "01. Archive", made when there is none; a folder that only starts with the word is not one', () => {
    const d = folder('Drafts', 'Older site visit');
    expect(path.basename(archiveOf(d))).toBe('01. Archive');
    expect(list(d)).toEqual(['01. Archive', 'Drafts', 'Older site visit']);
  });
  it('a folder that only starts with History or Old is not the archive', () => {
    for (const n of ['02 History and Background', 'Old drafts', 'History']) expect(path.basename(archiveOf(folder(n)))).toBe('01. Archive');
    for (const n of ['Archive - Q&A', 'Version history', 'Old versions']) expect(path.basename(archiveOf(folder(n)))).toBe(n);
  });
});

describe('saving the log', () => {
  const save = (d: string, s: string, was = sha256(bytes(read(d)))) => saveLog({ folder: d, file: FILE, bytes: bytes(s), was, at });
  afterEach(() => vi.restoreAllMocks());
  it('puts the version it replaces in the archive, dated, then saves over the log in place', () => {
    const d = withLog('theirs', 'Archive'); const r = save(d, 'theirs + ours');
    expect(r).toEqual({ status: 'written', archive: 'Lender A Q&A 2026-11-15 1612.xlsx' });
    expect(read(d)).toBe('theirs + ours'); expect(fs.readFileSync(path.join(d, 'Archive', 'Lender A Q&A 2026-11-15 1612.xlsx'), 'utf8')).toBe('theirs'); expect(list(d)).toEqual(['Archive', FILE]);
  });
  it('never writes over an archive file: a second save in the same minute gets " (2)"', () => {
    const d = withLog('one'); save(d, 'two'); expect(save(d, 'three')).toMatchObject({ status: 'written', archive: 'Lender A Q&A 2026-11-15 1612 (2).xlsx' });
    const arc = (f: string) => fs.readFileSync(path.join(d, '01. Archive', f), 'utf8'); expect([arc('Lender A Q&A 2026-11-15 1612.xlsx'), arc('Lender A Q&A 2026-11-15 1612 (2).xlsx')]).toEqual(['one', 'two']);
  });
  it('writes nothing while the log is open in Excel or LibreOffice', () => {
    for (const lock of [`~$${FILE}`, `.~lock.${FILE}#`]) { const d = withLog(); fs.writeFileSync(path.join(d, lock), ''); expect(save(d, 'ours')).toEqual({ status: 'later' }); expect(read(d)).toBe('theirs'); }
  });
  it('says who has the log open, from the lock file Excel or LibreOffice leaves beside it', () => {
    // Excel's owner file: a length byte and the name, padded to byte 54, then the name's length and the name in UTF-16
    const excel = Buffer.alloc(165, 0x20); const name = 'adöe'; excel[0] = name.length; excel.write(name, 1, 'latin1');
    excel.writeUInt16LE(name.length, 54); excel.write(name, 56, 'utf16le');
    let d = withLog(); fs.writeFileSync(path.join(d, `~$${FILE}`), excel);
    expect(whoHasOpen(d, FILE)).toBe('adöe'); expect(save(d, 'ours')).toEqual({ status: 'later', by: 'adöe' });   // as Office has it, not made into a full name
    d = withLog(); fs.writeFileSync(path.join(d, `.~lock.${FILE}#`), 'sroe,broe,PC-12,16.11.2026 09:12,file:///X:/Deals/Log.xlsx;');
    expect(whoHasOpen(d, FILE)).toBe('sroe');
    d = withLog(); fs.writeFileSync(path.join(d, `.~lock.${FILE}#`), ',broe,PC-12,16.11.2026 09:12,file:///X:/Deals/Log.xlsx;');
    expect(whoHasOpen(d, FILE)).toBe('broe');                                           // no name set in LibreOffice: the user name
    d = withLog(); fs.writeFileSync(path.join(d, `.~lock.${FILE}#`), 'Doe\\, Jay,broe,PC-12,16.11.2026 09:12,file:///X:/Deals/Log.xlsx;');
    // a "Last, First" name, its comma escaped
    expect(whoHasOpen(d, FILE)).toBe('Doe, Jay');
    d = withLog(); const junk = Buffer.alloc(165, 0x41); junk[0] = 7; junk.writeUInt16LE(9, 54); fs.writeFileSync(path.join(d, `~$${FILE}`), junk);
    expect(whoHasOpen(d, FILE)).toBe('');                                               // a damaged owner file: in use, no name
    d = withLog();
    const bidi = Buffer.alloc(165, 0x20);
    const odd = 'jdoe\u202Egnp.exe';
    bidi[0] = odd.length;
    bidi.writeUInt16LE(odd.length, 54);
    bidi.write(odd, 56, 'utf16le');
    fs.writeFileSync(path.join(d, `~$${FILE}`), bidi); expect(whoHasOpen(d, FILE)).toBe('');   // a name that would turn the text around is not shown
    d = withLog(); expect(whoHasOpen(d, FILE)).toBeNull();
  });
  it('writes nothing over a version someone saved since it was read: the next update starts from theirs', () => {
    const d = withLog(); const was = sha256(bytes('theirs')); fs.writeFileSync(path.join(d, FILE), 'theirs, edited a moment ago');
    expect(save(d, 'ours', was)).toEqual({ status: 'later' }); expect(read(d)).toBe('theirs, edited a moment ago');
  });
  // Found by the a save by someone else at the moment the app saves
  it('archives nothing when someone saves just before the app does: their version stays, and no copy claims the app replaced it', () => {
    const d = withLog(); const was = sha256(bytes('theirs')); const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => { if (String(from) === path.join(d, FILE)) fs.writeFileSync(from, 'theirs, saved just now'); return real(from, to); }) as typeof fs.renameSync);
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was, at })).toEqual({ status: 'later' }); vi.restoreAllMocks();
    expect(read(d)).toBe('theirs, saved just now'); expect(list(path.join(d, '01. Archive'))).toEqual([]); expect(list(d)).toEqual(['01. Archive', FILE]);
  });
  it('never replaces a log someone saved in the moment after the app\'s last check: theirs stands, and the version they replaced is kept, dated', () => {
    const d = withLog(); const was = sha256(bytes('theirs')); const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => { real(from, to); if (String(from) === path.join(d, FILE)) fs.writeFileSync(from, 'theirs, saved in that moment'); }) as typeof fs.renameSync);
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was, at })).toEqual({ status: 'later' }); vi.restoreAllMocks();
    expect(read(d)).toBe('theirs, saved in that moment'); expect(list(d)).toEqual(['01. Archive', FILE]);
    expect(list(path.join(d, '01. Archive')).map((f) => fs.readFileSync(path.join(d, '01. Archive', f), 'utf8'))).toEqual(['theirs']);   // nothing anyone wrote is lost
  });
  // an edit saved just before the move, a new file at the log's name meanwhile, and the archive refusing their copy
  describe('keeps the version moved aside whenever the archive does not hold it', () => {
    const asides = (d: string) => list(d).filter((f) => f.endsWith('.old')).map((f) => read(d, f));
    /** the log's move, where sroe saved over it just before and someone made a new file at its name just after */
    const raced = (d: string) => { const real = fs.renameSync; let n = 0; vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      real(a, b); if (++n === 1) { fs.writeFileSync(b, 'theirs + sroe\'s edit'); fs.writeFileSync(path.join(d, FILE), 'someone made a new file'); }
    }) as typeof fs.renameSync); };
    /** the archive refusing the "saved meanwhile" copy with `code` */
    const refuse = (code: string) => { const real = fs.writeFileSync; const where = trackPaths(); vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => {
      if (where(p).includes('saved meanwhile')) throw Object.assign(new Error(code), { code }); return real(p, data, o);
    }) as typeof fs.writeFileSync); };
    for (const code of ['EACCES', 'EBUSY', 'EPERM']) it(`when the archive refuses their copy (${code}): their edit stays in the folder`, () => {
      const d = withLog(); raced(d); refuse(code);
      expect(save(d, 'ours')).toEqual({ status: 'later' }); vi.restoreAllMocks();
      expect(read(d)).toBe('someone made a new file'); expect(asides(d)).toEqual(['theirs + sroe\'s edit']);
      expect(list(path.join(d, '01. Archive')).map((f) => fs.readFileSync(path.join(d, '01. Archive', f), 'utf8'))).toEqual(['theirs']);   // the version the new file replaced
    });
    it('when the share fails as their copy is written (EIO): their edit stays in the folder', () => {
      const d = withLog(); raced(d); refuse('EIO');
      expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
      expect(asides(d)).toEqual(['theirs + sroe\'s edit']);
    });
    it('when their copy reaches the archive, the version moved aside goes as before', () => {
      const d = withLog(); raced(d);
      expect(save(d, 'ours')).toEqual({ status: 'later' }); vi.restoreAllMocks();
      expect(list(d)).toEqual(['01. Archive', FILE]);
      expect(list(path.join(d, '01. Archive')).map((f) => fs.readFileSync(path.join(d, '01. Archive', f), 'utf8'))).toEqual(['theirs + sroe\'s edit']);
    });
    it('when the save gives up after a new file took the log\'s name: the version they replaced stays in the archive', () => {
      const d = withLog(); const real = fs.renameSync;
      vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }); });   // a share with no links
      vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
        if (String(b) !== path.join(d, FILE)) return real(a, b);
        fs.writeFileSync(b, 'someone made a new file'); throw Object.assign(new Error('EPERM'), { code: 'EPERM' });   // it took the name first, and is open
      }) as typeof fs.renameSync);
      expect(save(d, 'ours')).toEqual({ status: 'later' }); vi.restoreAllMocks();
      expect(read(d)).toBe('someone made a new file'); expect(list(d)).toEqual(['01. Archive', FILE]);
      expect(list(path.join(d, '01. Archive')).map((f) => fs.readFileSync(path.join(d, '01. Archive', f), 'utf8'))).toEqual(['theirs']);
    });
  });
  // a save cut off after the log was moved aside, and another PC saving at the same moment
  it('puts back a log a cut-off save left under its aside name, then saves', () => {
    const d = folder(); const aside = path.join(d, '~Lender A Q&A 0a1b2c3d.old'); fs.writeFileSync(aside, 'theirs');
    const old = new Date(Date.now() - 5 * 60_000); fs.utimesSync(aside, old, old);
    expect(fs.statSync(aside).ctimeMs > Date.now() - 60_000).toBe(true);    // ctime is the move, which utimes cannot age: this is what a fresh one looks like
    expect(restoreAside(d, FILE)).toBe(false); expect(list(d)).toEqual(['~Lender A Q&A 0a1b2c3d.old']);   // moved aside in the last minute: another PC may be saving it
    later();
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was: sha256(bytes('theirs')), at }).status).toBe('written');
    expect(read(d)).toBe('ours'); expect(list(d)).toEqual(['01. Archive', FILE]);
  });
  it('says "in use" when the log is not there because another PC has it moved aside this moment', () => {
    const d = folder(); fs.writeFileSync(path.join(d, '~Lender A Q&A 0a1b2c3d.old'), 'theirs');
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was: sha256(bytes('theirs')), at })).toEqual({ status: 'later' });
    expect(list(d)).toEqual(['~Lender A Q&A 0a1b2c3d.old']);
  });
  it('says "in use", not a raw error, when another PC removes its aside file while this one looks at it', () => {
    const d = folder(); fs.writeFileSync(path.join(d, '~Lender A Q&A 0a1b2c3d.old'), 'theirs');
    const stat = fs.statSync; vi.spyOn(fs, 'statSync').mockImplementation(((f: string, o?: never) => { if (String(f).endsWith('.old')) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }); return stat(f, o); }) as never);
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was: sha256(bytes('theirs')), at })).toEqual({ status: 'later' });
  });
  it('on a share with no links, still saves', () => {
    const d = withLog(); vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }); });
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was: sha256(bytes('theirs')), at }).status).toBe('written'); vi.restoreAllMocks();
    expect(read(d)).toBe('ours'); expect(list(d)).toEqual(['01. Archive', FILE]);
  });
  it.each(['link', 'rename'])('leaves a newly published log with the next save during %s cleanup (#280)', (method) => {
    const original = 'The reserve covers three months of operating expenses.';
    const revised = 'The reserve now covers six months of operating expenses.';
    const d = withLog(original);
    const active = path.join(d, FILE);
    const peerAside = 'competing-save.old';
    const link = fs.linkSync;
    const rename = fs.renameSync;

    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (method === 'rename') throw Object.assign(new Error('No hard links'), { code: 'ENOTSUP' });
      link(from, to);
      if (to === active) rename(active, path.join(d, peerAside));
    });
    if (method === 'rename') {
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        rename(from, to);
        if (to === active && String(from).endsWith('.tmp')) rename(active, path.join(d, peerAside));
      });
    }

    expect(save(d, revised)).toEqual({ status: 'written', archive: 'Lender A Q&A 2026-11-15 1612.xlsx' });
    expect(read(d, peerAside)).toBe(revised);
    expect(fs.existsSync(active)).toBe(false);
    const archive = path.join(d, '01. Archive');
    expect(list(archive).map((file) => read(archive, file))).toEqual([original]);
    expect(list(d)).toEqual(['01. Archive', peerAside]);
  });
  // a working file another program holds as the save tidies up (a sync client uploading the new version)
  it('is saved when its working files can\'t be removed yet, and they go at a save a minute later or more', () => {
    const d = withLog(); const rm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((f: fs.PathLike, o?: fs.RmOptions) => { if (String(f).startsWith(path.join(d, '~'))) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return rm(f, o); }) as typeof fs.rmSync);
    expect(save(d, 'ours')).toMatchObject({ status: 'written' }); expect(read(d)).toBe('ours'); vi.restoreAllMocks();
    expect(list(d).filter((f) => f.startsWith('~')).map((f) => path.extname(f)).sort()).toEqual(['.old', '.tmp']);
    expect(save(d, 'ours again')).toMatchObject({ status: 'written' }); expect(list(d).filter((f) => f.startsWith('~'))).toHaveLength(2);   // under a minute: another PC's, for all this one knows
    later();
    expect(save(d, 'ours, later')).toMatchObject({ status: 'written' }); expect(list(d)).toEqual(['01. Archive', FILE]);
  });
  it('never takes away an aside file while the log is not in place: it is the log', () => {
    const d = folder(); const aside = path.join(d, '~Lender A Q&A 0a1b2c3d.old'); fs.writeFileSync(aside, 'theirs');
    later();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); });   // it can't be put back just now
    expect(saveLog({ folder: d, file: FILE, bytes: bytes('ours'), was: sha256(bytes('theirs')), at })).toEqual({ status: 'later' });
    expect(fs.readFileSync(aside, 'utf8')).toBe('theirs');
  });
  it('never takes away an aside file of another log of the same name: another extension, or a long name cut short alike', () => {
    const d = folder(); fs.writeFileSync(path.join(d, 'X Q&A log.xlsx'), 'xlsx v1'); fs.mkdirSync(path.join(d, '01. Archive'));
    fs.writeFileSync(path.join(d, '01. Archive', 'X Q&A log 2026-11-15 1600.csv'), 'csv: the only copy here');   // archived, under its own extension
    fs.writeFileSync(path.join(d, '~X Q&A log 0a1b2c3d.old'), 'csv: the only copy here');                       // the CSV log, moved aside by a save cut off
    const pre = 'P'.repeat(200); const A = `${pre} Lender A.xlsx`; fs.writeFileSync(path.join(d, A), 'A v1');
    fs.writeFileSync(path.join(d, `~${pre} 0a1b2c3d.old`), 'B: the only copy here'); fs.writeFileSync(path.join(d, '01. Archive', 'B.xlsx'), 'B: the only copy here');
    later();
    expect(saveLog({ folder: d, file: 'X Q&A log.xlsx', bytes: bytes('xlsx v2'), was: sha256(bytes('xlsx v1')), at }).status).toBe('written');
    expect(saveLog({ folder: d, file: A, bytes: bytes('A v2'), was: sha256(bytes('A v1')), at }).status).toBe('written');
    expect(list(d).filter((f) => f.endsWith('.old'))).toEqual([`~${pre} 0a1b2c3d.old`, '~X Q&A log 0a1b2c3d.old']);
  });
  it('never takes away an aside file holding an edit the archive lacks (saved in the moment before the move)', () => {
    const d = withLog('theirs'); const real = fs.renameSync; let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      if (++n === 1) { real(a, b); fs.writeFileSync(b, 'theirs + sroe\'s edit'); return; }   // sroe saved just before the move
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });                         // and it can't be put back just now
    }) as typeof fs.renameSync);
    expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
    fs.writeFileSync(path.join(d, FILE), 'theirs');                                       // someone puts the archived version back under the log's name
    later();
    expect(save(d, 'ours')).toMatchObject({ status: 'written' });
    expect(list(d).filter((f) => f.endsWith('.old')).map((f) => read(d, f))).toEqual(['theirs + sroe\'s edit']);
  });
  // this PC's clock minutes ahead of the folder's, as Windows sign-in allows
  it('tells a file\'s age by the folder\'s clock: another PC\'s log moved aside a moment ago is neither put back nor taken away', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
    const d = folder(); const aside = path.join(d, '~Lender A Q&A 0a1b2c3d.old'); fs.writeFileSync(aside, 'theirs');
    expect(restoreAside(d, FILE)).toBe(false); expect(list(d)).toEqual(['~Lender A Q&A 0a1b2c3d.old']);
    // another PC archives the log and moves it aside while this one lists the folder to tidy up
    const e = withLog('v0', 'Archive'); const theirs = path.join(e, '~Lender A Q&A 0a1b2c3d.old'); const rd = fs.readdirSync; let done = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: never) => {
      if (!done && !o && String(p) === e) { done = true; fs.writeFileSync(path.join(e, 'Archive', 'Lender A Q&A 2026-11-17 1000.xlsx'), 'v0'); fs.renameSync(path.join(e, FILE), theirs); }
      return rd(p, o);
    }) as typeof fs.readdirSync);
    try { saveLog({ folder: e, file: FILE, bytes: bytes('ours'), was: sha256(bytes('v0')), at }); } catch { /* the log went from under it: not saved */ }
    expect(fs.readFileSync(theirs, 'utf8')).toBe('v0');
  });
  it('writes nothing when Windows refuses the file (open in Excel), and leaves no temporary file', () => {
    const d = withLog(); vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); });
    expect(save(d, 'ours')).toEqual({ status: 'later' }); expect(read(d)).toBe('theirs'); expect(list(d).filter((f) => f.startsWith('~'))).toEqual([]);
  });
  it('a share that drops while the archive copy is written leaves the log as it was and no half-written copy', () => {
    const d = withLog(); const real = fs.writeFileSync; const where = trackPaths();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => { if (where(p).includes('Archive')) { real(p, data.slice(0, 2), o); throw Object.assign(new Error('EIO'), { code: 'EIO' }); } return real(p, data, o); }) as typeof fs.writeFileSync);
    expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
    expect(list(path.join(d, '01. Archive'))).toEqual([]); expect(read(d)).toBe('theirs');
  });
  describe('an archive copy that fails never takes away another PC\'s file (#21)', () => {
    const eio = () => Object.assign(new Error('EIO'), { code: 'EIO' });
    const theirs = 'other PC archived this, the only copy';
    const archived = (d: string) => list(path.join(d, '01. Archive')).map((f) => read(path.join(d, '01. Archive'), f));
    it('when the name is refused after another PC made it (EIO on the claim)', () => {
      const d = withLog(); const real = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(p).includes('Archive') && flags === 'wx') { fs.writeFileSync(p, theirs); throw eio(); }
        return real(p, flags, mode);
      }) as typeof fs.openSync);
      expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
      expect(archived(d)).toEqual([theirs]); expect(read(d)).toBe('theirs');
    });
    const swapped = (fails: boolean) =>
      `when another PC put its copy over the claimed name before the write ${fails ? 'failed' : 'ran'}`;
    for (const fails of [true, false]) it(swapped(fails), () => {
      const d = withLog(); const real = fs.writeFileSync; const where = trackPaths();
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array, o?: fs.WriteFileOptions) => {
        if (!where(p).includes('Archive')) return real(p, data, o);
        fs.rmSync(where(p)); real(where(p), theirs);   // their copy takes the name this moment
        if (fails) throw eio();
        return real(p, data, o);
      }) as typeof fs.writeFileSync);
      try { save(d, 'ours'); } catch { /* the failing write */ } vi.restoreAllMocks();
      expect(archived(d)).toEqual([theirs]); expect(read(d)).toBe('theirs');   // the save failed: the log is as it was
    });
    it('a copy whose handle cannot be emptied or closed after a part-way write is still taken away', () => {
      const d = withLog(); const real = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: Uint8Array) => {
        if (typeof p === 'number') { fs.writeSync(p, data.slice(0, 2)); throw eio(); }
        return real(p, data);
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, 'ftruncateSync').mockImplementation(() => { throw eio(); });
      expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
      expect(archived(d)).toEqual([]);
    });
    it('a copy whose handle fails to close is not reported written, and is taken away', () => {
      const d = withLog(); const real = fs.closeSync; const where = trackPaths();
      vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
        const archive = where(fd).includes('Archive'); real(fd); if (archive) throw eio();
      }) as typeof fs.closeSync);
      expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
      expect(archived(d)).toEqual([]); expect(read(d)).toBe('theirs');
    });
    it('on a share that gives no file numbers, a copy is still written and reported', () => {
      const d = withLog(); const real = fs.fstatSync;
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, o?: never) => {
        const st = real(fd, o) as unknown as fs.BigIntStats;
        const noFileNumber = Object.create(Object.getPrototypeOf(st));
        return typeof st.ino === 'bigint' ? Object.assign(noFileNumber, st, { ino: 0n }) : st;
      }) as typeof fs.fstatSync);
      expect(save(d, 'ours')).toMatchObject({ status: 'written' }); vi.restoreAllMocks();
      expect(archived(d)).toEqual(['theirs']); expect(read(d)).toBe('ours');
    });
    it('a copy whose write fails after its name was claimed leaves no empty file', () => {
      const d = withLog();
      vi.spyOn(fs, 'writeFileSync').mockImplementation((() => { throw eio(); }) as typeof fs.writeFileSync);
      expect(() => save(d, 'ours')).toThrow(); vi.restoreAllMocks();
      expect(archived(d)).toEqual([]);
    });
  });
  it('a file called "01. Archive" does not stop the save: the archive is "01. Archive (2)"', () => {
    const d = withLog(); fs.writeFileSync(path.join(d, '01. Archive'), 'x');
    expect(save(d, 'ours').status).toBe('written'); expect(read(d, '01. Archive')).toBe('x'); expect(list(path.join(d, '01. Archive (2)'))).toHaveLength(1);
  });
  it('a long log name is archived under a name cut short to fit', () => {
    const d = folder(); const long = `${'L'.repeat(240)}.xlsx`; fs.writeFileSync(path.join(d, long), 'theirs');
    expect(saveLog({ folder: d, file: long, bytes: bytes('ours'), was: sha256(bytes('theirs')), at }).status).toBe('written');
    for (const f of list(path.join(d, '01. Archive'))) expect(Buffer.byteLength(f)).toBeLessThanOrEqual(255);
  });
});

describe('a new log', () => {
  it('takes the name asked for, or the first free one: it never replaces a file', () => {
    const d = withLog(); expect(createLog(d, 'Project Proseware Q&A log.xlsx', bytes('new'))).toBe('Project Proseware Q&A log.xlsx');
    expect(createLog(d, FILE, bytes('new'))).toBe('Lender A Q&A (2).xlsx'); expect(read(d)).toBe('theirs');
  });
});
