/**
 * The folder a deal's Q&A log lives in: the log is the team's own file there, edited with or without the
 * app. Before the app saves over it, the version it replaces goes, dated, to the folder's archive: the folder's own when it
 * has one ("Archive", "Old", "Superseded", "Prior versions", with or without a number in front); otherwise "01. Archive" is
 * made. Nothing in the folder is ever deleted except the app's own working files: a copy the log or its archive already
 * holds, or a new version the app can make again. An archive file is created only under a free name.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip, partText } from './zipParts';

/**
 * a folder name that reads as an archive: "Archive", "02 - Old", "Superseded docs", "Prior versions", "Version history" (a bare "History" may hold anything). Only "Archive" and
 * "Superseded" may go on with more words ("Archive - Q&A"); "History and Background" or "Old drafts" is not an archive.
 */
const ARCHIVE = /^(?:\d+[\s._-]*)?(?:(?:archived?|superseded)(?:\s.*)?|old(?: versions?)?|prior versions?|previous versions?|version history)$/i;
/** the longest file name most file systems and shares take, in bytes */
const MAX_NAME = 255;

export const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

/** the folder's own archive, or undefined when it has none */
function archiveIn(folder: string): string | undefined {
  const found = fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && ARCHIVE.test(e.name.trim())).map((e) => e.name).sort();
  return found.find((n) => /^(?:\d+[\s._-]*)?archive$/i.test(n.trim())) ?? found[0];   // a plain "Archive" first, if there are several
}
/** the folder's archive, made as "01. Archive" when it has none */
export function archiveOf(folder: string): string {
  let name = archiveIn(folder);
  // none: "01. Archive" is made, or "01. Archive (2)" when a file already has that name
  for (let k = 1; !name; k++) { const n = `01. Archive${k > 1 ? ` (${k})` : ''}`; const at = path.join(folder, n); if (!fs.existsSync(at)) fs.mkdirSync(at); if (fs.statSync(at).isDirectory()) name = n; else if (k > 99) throw new Error('No archive folder could be made'); }
  return path.join(folder, name);
}

/** "2026-11-15 1612", in this PC's time */
function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`;
}
/** a log's name cut short, if need be, so that it fits a file name with `rest` (a date, a name, an extension) after it */
function fit(name: string, rest: string): string {
  let n = name; while (n && Buffer.byteLength(n + rest) > MAX_NAME - 6) n = n.slice(0, -1);   // 6: room for " (99)"
  return n.trimEnd();
}
/**
 * writes a new file under the first free name: "<base><ext>", then "<base> (2)<ext>" and so on; never replaces one. The
 * name is claimed first, with an exclusive open: from then on the file there is this call's own (no copy is ever
 * replaced or renamed over), and a failure to claim takes nothing away (#21). A write that fails part-way (a share that
 * drops) takes away only that file, so no version is ever a partial one.
 */
function create(dir: string, base: string, ext: string, bytes: Uint8Array): string {
  for (let k = 1; ; k++) {
    const name = `${base}${k > 1 ? ` (${k})` : ''}${ext}`;
    const at = path.join(dir, name);
    let fd: number;
    try { fd = fs.openSync(at, 'wx'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && k <= 99) continue;
      throw e;   // nothing was claimed, so nothing is taken away
    }
    try {
      fs.writeFileSync(fd, bytes);   // through the claimed handle: never onto a file that took the name since
      return name;
    } catch (e) {
      takeAway(at, fd);
      throw e;
    } finally {
      try { fs.closeSync(fd); } catch { /* the copy is written; a share that fails the close leaves it whole */ }
    }
  }
}
/**
 * Empties the file claimed as `fd`, which only ever touches that file, then removes `at` if it is still that file: the
 * same device, file number and creation time. A file another PC put there since (even one given a freed file number)
 * stays. Where a share cannot tell files apart, an empty file stays: the next save moves on to the next name.
 */
function takeAway(at: string, fd: number): void {
  try {
    const mine = fs.fstatSync(fd, { bigint: true });
    fs.ftruncateSync(fd, 0);
    const now = fs.lstatSync(at, { bigint: true });
    const provable = mine.ino !== 0n && mine.birthtimeNs !== 0n;
    const same = now.ino === mine.ino && now.dev === mine.dev && now.birthtimeNs === mine.birthtimeNs;
    if (provable && same) fs.rmSync(at);
  } catch { /* the share is gone: the next save finds the name taken and moves on */ }
}
export type LogSave = { status: 'written'; archive: string } | { status: 'later'; by?: string };

/**
 * Who has the log open, from the lock file their program leaves beside it: null when it is not open, '' when it is but the
 * name can't be read. Excel's "~$<file>" holds the name as it is set in Office: a length byte and the name, then at byte 54
 * the same length and the name in UTF-16, which is what is shown, and only when the two lengths agree (a damaged file shows
 * no name rather than a wrong one). LibreOffice's ".~lock.<file>#" is a line of commas, a comma in a field escaped with a
 * backslash ("Doe\, Jay"): the person's name first, then their user name. Only the start of either file is read.
 */
export function whoHasOpen(folder: string, file: string): string | null {
  const excel = path.join(folder, `~$${file}`), office = path.join(folder, `.~lock.${file}#`);
  const read = (f: string) => {
    let fd: number | undefined;
    try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1024); return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)); }
    catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : Buffer.alloc(0); }   // a lock file we may not read still says it is open
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const x = read(excel);
  if (x) {
    const n = x.length > 55 ? x.readUInt16LE(54) : 0;
    return n > 0 && n <= 54 && x[0] === n && x.length >= 56 + 2 * n ? clean(x.subarray(56, 56 + 2 * n).toString('utf16le')) : '';
  }
  const o = read(office);
  if (o) {
    const f = (o.toString('utf8').split(/[;\n]/)[0] ?? '').split(/(?<!\\),/).map((v) => v.replace(/\\(.)/g, '$1'));
    return clean(f[0] ?? '') || clean(f[1] ?? '');
  }
  return null;
}
/** a name read from a lock file, or '' when what was read is not one: it has a letter, and no control, direction-changing or broken characters */
const clean = (s: string) => {
  const t = s.replace(/\0/g, '').trim();
  return t && /\p{L}/u.test(t) && !/[\x00-\x1F\x7F-\x9F\uFFFD\u200E\u200F\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(t) ? t.slice(0, 80) : '';
};

/**
 * Save `bytes` over the log `file` in `folder`, which must still hold `was` (the version the new one was made from): that
 * version goes to the folder's archive first, dated, so nothing anyone wrote is lost. "later": the file is open somewhere, or
 * changed since it was read (someone saved a moment ago); nothing was written, and the next update starts from their version.
 */
/** the name a save moves the log aside under, while it puts the new version in place: "~<stem> <8 hex>.old" */
const asideName = (stem: string) => `~${stem.slice(0, 200)} ${crypto.randomBytes(4).toString('hex')}.old`;

/**
 * A save cut off between moving the log aside and putting the new version in place (the app closed, the share dropped)
 * leaves the log under its aside name and nothing at its own. Put it back, the newest if there are several. One moved aside
 * in the last minute is left alone: another PC may be saving it this moment. A minute by the folder's own clock, which
 * stamps the file, not this PC's, which may differ from it by minutes. True when the log is back.
 */
export function restoreAside(folder: string, file: string): boolean {
  try { return putBack(folder, file); } catch { return false; }   // another PC may remove its aside file between the steps: nothing to put back then
}
/**
 * The time by the folder's own clock: the change time of an empty file made there and taken away again, or null when none can
 * be made. A file's age is told against this, never against this PC's clock.
 */
function folderNow(folder: string, stem: string): number | null {
  const probe = path.join(folder, `${asideName(stem).slice(0, -4)}.tmp`);
  try { fs.writeFileSync(probe, new Uint8Array(0), { flag: 'wx' }); return fs.statSync(probe).ctimeMs; } catch { return null; } finally { tidy(probe); }
}
function putBack(folder: string, file: string): boolean {
  const at = path.join(folder, file); if (fs.existsSync(at)) return false;
  const ext = path.extname(file); const stem = file.slice(0, file.length - ext.length).slice(0, 200);
  let names: string[]; try { names = fs.readdirSync(folder); } catch { return false; }
  const left = names.filter((n) => n.startsWith(`~${stem} `) && /^ [0-9a-f]{8}\.old$/.test(n.slice(stem.length + 1)))
    .map((n) => ({ n, t: fs.statSync(path.join(folder, n)).ctimeMs })).sort((a, b) => b.t - a.t);   // ctime: when it was moved aside
  const old = left[0]; if (!old) return false;
  const now = folderNow(folder, stem); if (now === null || now - old.t < 60_000) return false;
  try { fs.renameSync(path.join(folder, old.n), at); return true; } catch { return false; }
}

/**
 * Takes away a save's own working files ("~<stem> <8 hex>.tmp" and ".old") that an earlier save could not remove because
 * another program held them for a moment (a sync client uploading the new version). Only those over a minute old by
 * the folder's clock (`now`: when this save's own working file was made; another PC may be saving this moment), only while
 * this log is in place, and only when the log or its archive holds the same bytes under this log's extension (or it is an
 * empty clock probe): so never this log moved aside, another log of the same name (".csv" beside
 * ".xlsx"), another PC's new version not yet in place, an edit saved in the moment before a move that never reached the
 * archive, or a team file that happens to be named alike. A name cut short to fit may be another log's, so its files stay.
 */
function tidyLeftovers(folder: string, file: string, archive: string, now: number): void {
  const ext = path.extname(file); const full = file.slice(0, file.length - ext.length); const stem = full.slice(0, 200);
  if (full !== stem || !fs.existsSync(path.join(folder, file))) return;
  let names: string[]; try { names = fs.readdirSync(folder); } catch { return; }
  // the leftovers first, by size and hash, so the archive is walked once and only files of a leftover's size are read
  const left: { f: string; size: number; hash: string }[] = [];
  for (const n of names) {
    if (!n.startsWith(`~${stem} `) || !/^ [0-9a-f]{8}\.(tmp|old)$/.test(n.slice(stem.length + 1))) continue;
    try {
      const f = path.join(folder, n); if (now - fs.statSync(f).ctimeMs < 60_000) continue;
      const b = new Uint8Array(fs.readFileSync(f)); left.push({ f, size: b.length, hash: sha256(b) });
    } catch { /* still held, or gone meanwhile: the next save tries again */ }
  }
  if (!left.length) return;
  const sizes = new Set(left.map((l) => l.size)); const held = new Set<string>();
  const look = (f: string) => { try { const st = fs.statSync(f); if (st.isFile() && sizes.has(st.size)) held.add(sha256(new Uint8Array(fs.readFileSync(f)))); } catch { /* unreadable: holds nothing we can vouch for */ } };
  look(path.join(folder, file));
  try { for (const n of fs.readdirSync(archive)) if (path.extname(n).toLowerCase() === ext.toLowerCase()) look(path.join(archive, n)); } catch { /* no archive to vouch for them */ }
  for (const l of left) if (held.has(l.hash) || (l.size === 0 && l.f.endsWith('.tmp'))) tidy(l.f);   // an empty one: a clock probe (folderNow) left held
}
/** removes a working file, leaving it for the next save's tidyLeftovers when another program holds it: the save itself is done */
const tidy = (f: string) => { try { fs.rmSync(f, { force: true }); } catch { /* left for the next save */ } };

/**
 * an edit kept aside: the file in the log's folder, its bytes' hash, and the archive file (full path) it was made
 * from, when one is known and it is still to be brought in
 */
export type KeptEdit = { name: string; hash: string; base: string | null };
/**
 * "~<stem> <8 hex>.old", for this log's stem as save names it; or ".kept", one already brought into the log that the
 * archive refused (settleKept): it is never merged again, only filed in the archive when it takes it; ".left" is the same,
 * with some of its changes not in the log, so that the update that files it says so
 */
const keptName = (stem: string, n: string) => n.startsWith(`~${stem} `) && /^ [0-9a-f]{8}\.(?:old|kept|left)$/.test(n.slice(stem.length + 1));

/**
 * whether `bytes` are a file of the kind `ext` names: an OpenDocument package (.ods, which names itself in "mimetype"), an
 * Office one (.xlsx, .xlsm), an old Office file (.xls), or none of these (.csv)
 */
const sameKind = (ext: string, b: Uint8Array) => {
  const zip = b[0] === 0x50 && b[1] === 0x4b, ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; const e = ext.toLowerCase();
  if (e === '.xls') return ole; if (e === '.csv') return !zip && !ole; if (!zip) return false;
  // only a package that shows it is the other kind is another log's: a damaged one (cut short) is still this log's to file
  try { const z = readZip(b); return e === '.ods' ? partText(z, '[Content_Types].xml') === null : partText(z, 'mimetype') === null; } catch { return true; }
};
/**
 * The edits a save kept aside under its working name because the archive did not take a copy of them: a version of
 * the log moved aside, over a minute old by the folder's clock (another PC may be saving this moment), while the log is in
 * place, whose bytes the archive does not hold (one it holds is a leftover: tidyLeftovers takes it). A name cut short to fit
 * may be another log's, so it is never looked at. The version each was made from is the archive copy the same save made
 * just before it moved the log aside: the newest of the log's kind in the archive made in the minute up to that move, by the
 * folder's clock, and only one named as an update names it (never a "saved meanwhile" copy, nor another log's). One made in the 2 seconds after the move (a file system that keeps
 * times coarsely) only when there is none before it, and only when every copy made then holds the same bytes: another PC's
 * update may archive the log a moment after. None, too, when the newest before it shares its time with a copy that differs:
 * which one it was made from is not known, and it is filed unmerged. A file whose
 * bytes are not of the log's kind (a ".xlsx" log's edit beside a ".csv" log of the same name) is another log's, and left
 * alone. Oldest first, so a later edit is brought in after an earlier one.
 */
export function keptEdits(folder: string, file: string): KeptEdit[] {
  const ext = path.extname(file); const full = file.slice(0, file.length - ext.length); const stem = full.slice(0, 200);
  if (full !== stem || !fs.existsSync(path.join(folder, file))) return [];
  let names: string[]; try { names = fs.readdirSync(folder).filter((n) => keptName(stem, n)); } catch { return []; }
  if (!names.length) return [];
  const now = folderNow(folder, stem); if (now === null) return [];
  const dir = archiveIn(folder); const arc: { f: string; t: number; size: number; mine: boolean; hash?: string }[] = [];
  // this log's dated copies, as save names them, are the ones it may have been made from: another log may share the archive
  const own = fit(stem, ` 0000-00-00 0000${ext}`); const dated = /^ \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?$/;
  if (dir) for (const n of fs.readdirSync(path.join(folder, dir))) {
    const e = path.extname(n); if (e.toLowerCase() !== ext.toLowerCase()) continue; const mine = n.startsWith(own) && dated.test(n.slice(own.length, n.length - e.length));
    try { const f = path.join(folder, dir, n); const st = fs.statSync(f); if (st.isFile()) arc.push({ f, t: st.ctimeMs, size: st.size, mine }); } catch { /* gone meanwhile */ }
  }
  const hashOf = (a: (typeof arc)[number]) => { try { a.hash ??= sha256(new Uint8Array(fs.readFileSync(a.f))); } catch { a.hash = ''; } return a.hash; };
  const out: (KeptEdit & { t: number })[] = [];
  for (const n of names) {
    try {
      const f = path.join(folder, n); const st = fs.statSync(f);
      // brought in already: only to be filed (no save is ever at work on one, so it needs no minute)
      if (!n.endsWith('.old')) { const b = new Uint8Array(fs.readFileSync(f)); if (sameKind(ext, b)) out.push({ name: n, hash: sha256(b), base: null, t: st.ctimeMs }); continue; }
      if (now - st.ctimeMs < 60_000) continue;
      const b = new Uint8Array(fs.readFileSync(f)); if (!sameKind(ext, b)) continue; const hash = sha256(b);
      if (arc.some((a) => a.size === b.length && hashOf(a) === hash)) continue;
      const near = arc.filter((a) => a.mine && a.t >= st.ctimeMs - 60_000).sort((x, y) => y.t - x.t);
      // Two copies of other bytes that can't be told apart by the folder's clock: merged against the wrong one, a cell
      // another person filled in would read as one they cleared, so it is filed unmerged instead (and said so). Before the
      // move, the newest, unless another was made in the same tick; else, in the 2 s after it (a file system that keeps
      // times to the second or two may stamp the copy a moment after), the only one of its bytes there.
      const before = near.find((a) => a.t <= st.ctimeMs); const after = near.filter((a) => a.t > st.ctimeMs && a.t <= st.ctimeMs + 2_000);
      const base = before ? (near.some((a) => a !== before && a.t === before.t && hashOf(a) !== hashOf(before)) ? undefined : before)
        : after.length && after.every((a) => hashOf(a) === hashOf(after[0])) ? after.at(-1) : undefined;
      out.push({ name: n, hash, base: base?.f ?? null, t: st.ctimeMs });
    } catch { /* held, or gone meanwhile: the next update looks again */ }
  }
  return out.sort((x, y) => x.t - y.t).map(({ t: _, ...k }) => k);
}

/**
 * After an update has brought kept edits into the log (or found nothing to bring in), each goes: first to the archive as
 * "<name> <date> saved meanwhile", dated when it was saved, as when the save that kept it had been able to put it there, unless the archive already
 * holds the same bytes, and only then from the folder. One changed since it was read stays as it is. One the archive
 * refuses now is renamed ".kept" (".left" when `left`: some of its changes are not in the log): it is in the log already, as far as it could be, so no later update merges it again (a
 * cell someone changes back afterwards stays as they set it), and a later update files it once the archive takes it. Gives
 * the names that went.
 */
export function settleKept(folder: string, file: string, kept: { name: string; hash: string; left?: boolean }[]): string[] {
  const ext = path.extname(file); const stem = file.slice(0, file.length - ext.length).slice(0, 200); const gone: string[] = [];
  const mine = kept.filter((k) => path.basename(k.name) === k.name && keptName(stem, k.name)); if (!mine.length) return gone;
  const dir = archiveOf(folder);
  for (const k of mine) {
    try {
      const f = path.join(folder, k.name); const b = new Uint8Array(fs.readFileSync(f)); if (sha256(b) !== k.hash) continue;
      const saved = fs.statSync(f).mtime;                                              // dated when they saved it, not when it is filed
      const held = fs.readdirSync(dir).some((n) => { if (path.extname(n).toLowerCase() !== ext.toLowerCase()) return false; try { const x = path.join(dir, n); return fs.statSync(x).size === b.length && sha256(new Uint8Array(fs.readFileSync(x))) === k.hash; } catch { return false; } });
      try {
        if (!held) { const n = create(dir, `${fit(stem, ` ${stamp(saved)} saved meanwhile${ext}`)} ${stamp(saved)} saved meanwhile`, ext, b); if (sha256(new Uint8Array(fs.readFileSync(path.join(dir, n)))) !== k.hash) throw new Error('the copy differs'); }
        fs.rmSync(f); gone.push(k.name);
      } catch { if (k.name.endsWith('.old')) fs.renameSync(f, path.join(folder, `${k.name.slice(0, -4)}.${k.left ? 'left' : 'kept'}`)); }   // not merged again; filed later
    } catch { /* not even renamed: it stays as it is, and the next update merges it again */ }
  }
  return gone;
}

export function saveLog(o: { folder: string; file: string; bytes: Uint8Array; was: string; at: Date }): LogSave {
  const at = path.join(o.folder, o.file); const ext = path.extname(o.file); const stem = o.file.slice(0, o.file.length - ext.length);
  const hash = (f: string) => sha256(new Uint8Array(fs.readFileSync(f)));
  restoreAside(o.folder, o.file);
  const by = whoHasOpen(o.folder, o.file); if (by !== null) return { status: 'later', ...(by ? { by } : {}) };
  // not there at all: another PC has it moved aside this moment, so this is "in use", not an error
  try { if (hash(at) !== o.was) return { status: 'later' }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'later' }; throw e; }
  const id = asideName(stem).slice(0, -4); const tmp = path.join(o.folder, `${id}.tmp`); const aside = path.join(o.folder, `${id}.old`);
  const dir = archiveOf(o.folder); let archive = '';
  // the archive file that holds the version moved aside byte for byte, once one is known to: only then may that version go
  let holds = '';
  let published = false;
  const drop = () => {   // nothing was replaced: no copy may say it was
    if (archive) { fs.rmSync(path.join(dir, archive), { force: true }); if (holds === archive) holds = ''; }
    return { status: 'later' as const };
  };
  try {
    fs.writeFileSync(tmp, o.bytes, { flag: 'wx' });
    try { tidyLeftovers(o.folder, o.file, dir, fs.statSync(tmp).ctimeMs); } catch { /* tidying never fails a save */ }
    const old = new Uint8Array(fs.readFileSync(at));                                   // the version being replaced, as it is
    archive = create(dir, `${fit(stem, ` ${stamp(o.at)}${ext}`)} ${stamp(o.at)}`, ext, old);
    // The log is moved aside in one step, so no save can land on it unseen: one made before the move is in the file moved,
    // and is checked for now; one made after it makes a new file, which the app never replaces (below).
    fs.renameSync(at, aside);
    const moved = hash(aside);
    if (moved !== o.was) {                                                             // someone saved a moment ago: theirs goes back
      if (!fs.existsSync(at)) fs.renameSync(aside, at);
      else holds = create(dir, `${fit(stem, ` ${stamp(o.at)} saved meanwhile${ext}`)} ${stamp(o.at)} saved meanwhile`, ext, new Uint8Array(fs.readFileSync(aside)));
      return drop();
    }
    if (sha256(old) === moved) holds = archive;
    // The new version takes the log's name only if nobody made a file there meanwhile: a link fails on a name in use,
    // where a rename would replace it. A share that has no links (some NAS) gets a rename after one more look.
    // When someone did, theirs stands and the version the app read stays in the archive, dated: it was replaced, by them.
    try { fs.linkSync(tmp, at); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' || fs.existsSync(at)) return { status: 'later' };
      fs.renameSync(tmp, at);
    }
    published = true;
    return { status: 'written', archive };
  } catch (e) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) {   // open in Excel
      // a new file took the log's name meanwhile: it stands, and the dated archive copy stays, as when the link finds the name taken
      if (fs.existsSync(aside) && fs.existsSync(at)) return { status: 'later' };
      if (fs.existsSync(aside)) fs.renameSync(aside, at);
      return drop();
    }
    throw e;
  } finally {
    // Tidying up never changes the outcome: once the new version is in place the save is made, and what it wrote is
    // recorded. A working file another program holds stays until the next save.
    tidy(tmp);
    // After publication, another PC may already have moved the new log aside for its own save (#280).
    if (fs.existsSync(aside)) {
      if (!published && !fs.existsSync(at)) fs.renameSync(aside, at);
      else if (holds) tidy(aside);
    }
  }
}

/** a new log in `folder`: `file`, or the first free "name (2).ext" when that is taken; never replaces a file */
export function createLog(folder: string, file: string, bytes: Uint8Array): string {
  const ext = path.extname(file); return create(folder, file.slice(0, file.length - ext.length), ext, bytes);
}
