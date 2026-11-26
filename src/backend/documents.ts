/**
 * The document service on real folders.
 *
 * What it does: lists the files in a deal's folders, gives each one an id taken from its contents, keeps a small shared
 * record of each (where it is, how many pages, and later what the model said it is), uploads documents to the model
 * service's store when they are needed, and finds a file again when a citation is opened.
 *
 * PDFs go in as they are. Spreadsheets stay as they are and are shown as cells. Everything else is converted to PDF: that
 * PDF is what the model service is given and what the app shows, so a cited page and the page shown are the same page.
 * A file that will not convert is reported and is not indexed. Nothing converted is kept, beyond the few a person has open.
 *
 * Shared folder   docs-<install id>-<deal id>.jsonl          one line per thing learned about a document; every copy reads all of them
 *                 attachments/<deal id>/<install id>/<id>.<ext> files a person attached in the app, which are in no deal folder;
 *                                                             one attached on Home is under the person's own id (ownFilesId) in place of a deal's
 * Local folder    hashes.json                                 path, size and date → fingerprint, so a file is read once
 *                 folders.json                                where a deal's folders are on this PC, when not where the deal says
 *                 folder-rules.json                           what folders located here taught: this start of a path is that one on this PC
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { control } from '../control';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ok, fail, type Result } from '../domain/result';
import type { DocumentService, DocumentRef, PageView, IndexTiming, FolderPlace } from '../ports';
import { candidates, profileCandidate, ruleFrom, rewrite, topsOf, key, deeper, type Rule, type DealFolder as MissingFolder } from '../domain/relink';
import type { Folder as DealFolder } from '../domain/model';
import type { Folder } from './logRepository';
import { BUSY_WAITS } from './nodeFolder';
import type { StoreKeeper, WantedDoc } from './storeKeeper';
import { pdfLook, pdfPages, shortExt, type Converter, type ConvertInfo, type ChangeList } from './convert';
import { parseCsv, sheetPart, type Sheet } from '../domain/sheets';
import { decodeText } from '../domain/textEncoding';
import { countInto, mostUsed, topWords } from './words';
import { countWords, WordTally, type WordIndex } from './wordIndex';
import { eachCsvCell } from './csvFile';
import { officeText, DIRECT } from './officeText';
import { families, roomPath, ATTACHED } from './families';
import { coverOf } from './blacklines';
import { appendOwn, dealFiles, healOwn, wholeLines } from './ownFile';
import { randomUUID } from 'node:crypto';
import { countedFiles, sameRoomAs, type RoomMatch } from './sameRoom';

/**
 * What is kept about a document. `pages` is set for everything shown as pages, and `via` names the converter that made
 * those pages when the file is not itself a PDF. `tracked` is how many tracked changes a Word file had when it was
 * indexed (absent for none): its pages show it with all of them accepted. `words` are the words it uses most, counted
 * on this PC when it is indexed, with no model: an empty list for a file no words could be read from (a scan), absent
 * for a record made before words were kept. `summary` and `keywords` are written once, by the model, the first time
 * the document is among those a call reads; most documents never have them. All three are what a document is found by.
 * `undescribed` is there only while a document has no summary and the model has failed to give one: how many times,
 * and when last. It is shared, so that every PC counts the same tries and none starts again from nothing.
 *
 * A document whose file is no longer in the deal's folders stops being one of the deal's documents. Each PC says
 * which documents it has seen in its own copy of a folder, and says so again when one of them is no longer there. A
 * PC whose copy holds most of what is seen in the folder (limits.sameFolder) speaks for the PCs that have not read the folder for timings.folderIdle: what it does not find at a place has left
 * that place for them. A PC that has only part of a folder, or lacks a subfolder of it, takes away only what it had seen itself. A
 * document is gone once no PC sees it anywhere; it is back as soon as any PC sees it again.
 */
/** One place a document's file sits: the folder as the deal lists it, the path inside it, and the file's name there. */
export interface DocPlace { folder: string; rel: string; name: string }
/**
 * `folder`, `rel` and `name` are the document's first place still seen; `copies` are the other places the same file (the same
 * bytes, so the same id) sits in the data room. A copy is the same document: indexed, read and sent once.
 */
export interface DocRecord { docId: string; hash: string; name: string; folder: string; rel: string; copies?: DocPlace[]; size: number; pages?: number; via?: string; tracked?: number; words?: string[]; /** for a PDF whose first page is a comparison tool's cover: that page's text, which names the files compared (blacklines.ts) */ cover?: string; summary?: string; keywords?: string[]; undescribed?: { tries: number; at: string }; /** when any PC first saw it, at any place */ seen?: string }
export interface Review { summary: string; keywords: string[] }
interface DocLine { v: 1; pc: string; at: string; docId: string; hash?: string; name?: string; folder?: string; rel?: string; size?: number; pages?: number; via?: string; tracked?: number; words?: string[]; cover?: string; summary?: string; keywords?: string[]; tried?: number; gone?: boolean; /** this PC no longer finds the document at this place (it may still be at another) */ left?: { folder: string; rel: string }; /** this PC read the whole folder and the document is not at this place, so these PCs, which have not read the folder for timings.folderIdle, no longer see it there (see the end of `run`) */ cleared?: { folder: string; rel: string; by: string[] }; /** this PC finished reading this folder (docId is '') */ read?: string; /** with `read`: the folders inside it, by their path within it, that this PC may not open */ shut?: string[]; /** with `read`: of the folders another PC said it may not open, those this PC's reading took in */ opened?: string[]; /** this PC read the whole folder and found no file at this place, where only PCs no longer used see the document: it is cleared if it is still not there on a read a day later */ missed?: { folder: string; rel: string } }
/** How a candidate folder on this PC compares with a folder the deal already has: of `checked` recorded documents, `matched` are there. */
export interface FolderMatch { folder: string; matched: number; checked: number }

export interface DocumentsOptions {
  shared: Folder; local: Folder;
  /** the shared folder's own path, for the attachments kept inside it */
  sharedPath: string;
  installId: string;
  /** the deal's folders, as its record lists them */
  folders: (dealId: string) => Promise<string[]>;
  /** this person's home folder, where a folder under another person's Windows profile is looked for (os.homedir() when left out) */
  home?: string;
  /** the same, read at once; null when the deal cannot be read. A document in none of them is left out of checks and questions */
  foldersNow?: (dealId: string) => string[] | null;
  keeper: StoreKeeper;
  /** called once when a deal's folders have all been indexed */
  /** `forCheck`: a check of everything is about to start and reads what this run found, so the first pass waits for that check */
  onIndexed?: (dealId: string, how?: { forCheck?: boolean }) => void;
  /** this PC's index of every word in each document; without it documents are found by their most-used words only */
  index?: WordIndex;
  /** Turns a page-shaped file into a PDF. Without one, only PDFs and spreadsheets can be indexed. */
  convert?: Converter;
  /** a folder on this PC for PDFs being converted, and for files while they are being indexed; needed with `convert` */
  workPath?: string;
  /** how many files are brought across from the data room at a time while indexing (default 3, or `indexAtOnce` in this PC's settings.json) */
  atOnce?: number;
  /** how long a folder's listing must stay the same before what changed in it is read: a file still being copied in is not read part-way (default 2 s) */
  settleMs?: number;
  /** the URL the window fetches a page's file from, given an opaque token; the shell serves it and asks `fileFor(token)` which file is meant */
  urlFor?: (token: string) => string;
  clock?: () => string;
}

/** a day in milliseconds: a PC says it read a folder at most once a day when nothing is new */
const DAY = 24 * 60 * 60 * 1000;
/** files and folders the system keeps for itself, also those Windows keeps at a drive's root, which a person may not open */
const SKIP = /^(\.|~\$)|^(thumbs\.db|desktop\.ini|\$recycle\.bin|system volume information)$/i;
const SHEET = /\.(xlsx|xlsm|xlsb|xls|ods|csv)$/i;
const size = (bytes: number) => (!bytes ? '0 KB' : bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB');
const tick = () => new Promise<void>((r) => setImmediate(r));
const PDF = /\.pdf$/i;
/** shown and sent as pages: everything that is not a spreadsheet */
const paged = (name: string) => !SHEET.test(name);
const pdfName = (name: string) => (PDF.test(name) ? name : `${name}.pdf`);
/** errors that say a folder may not be opened by this person: that folder's trouble, not the data room's */
const NO_ENTRY = ['EACCES', 'EPERM'];
/** each folder's names, kept for one pass over many places: a file where a folder was, a folder this person may not open, or one that could not be listed */
type Lists = Map<string, string[] | 'file' | 'shut' | null>;
/** errors that are one file's own trouble (it is locked, or may not be opened), not the data room's: as indexing takes them */
const ONE_FILE = ['EACCES', 'EPERM', 'EBUSY'];
// a locked file is waited for with BUSY_WAITS, a second or so in all, as a save waits for a busy file
/** a file that stayed locked for the whole wait is read once each for this long, then waited for again, so it costs one wait every 10 seconds */
const REST_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const KEPT_OPEN = 20;                                          // converted PDFs kept for the documents a person has open

/** every file under a folder, in a fixed order; files the system keeps for itself are left out */
/** `failed`, when given, is filled with the folders that could not be listed, and the code of the error each gave: the listing is then not the whole of what is there. */
export function walk(dir: string, failed?: { dir: string; code: string }[]): { abs: string; rel: string; size: number; mtimeMs: number }[] {
  const out: { abs: string; rel: string; size: number; mtimeMs: number }[] = [];
  const into = (d: string, rel: string) => {
    let entries: fs.Dirent[] = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { failed?.push({ dir: d, code: (e as { code?: string })?.code ?? '' }); return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (SKIP.test(e.name)) continue;
      const abs = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) into(abs, r);
      else if (e.isFile()) { try { const st = fs.statSync(abs); if (st.size > 0) out.push({ abs, rel: r, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* gone since it was listed */ } }
    }
  };
  into(dir, '');
  return out;
}
/**
 * The same listing as `walk`, in the same order, read without holding up everything else this process does: for the look
 * at an indexed deal's folders that runs on a timer, on a data room of thousands of files over a network drive.
 * With `shut`, a folder inside `dir` that this person may not open goes there instead of in `failed`, as a run takes it.
 */
export async function walkQuietly(dir: string, failed?: string[], shut?: string[]): Promise<{ abs: string; rel: string; size: number; mtimeMs: number }[]> {
  const out: { abs: string; rel: string; size: number; mtimeMs: number }[] = [];
  const into = async (d: string, rel: string) => {
    let entries: fs.Dirent[] = []; try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { (shut && d !== dir && NO_ENTRY.includes((e as { code?: string })?.code ?? '') ? shut : failed)?.push(d); return; }
    const kept = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).filter((e) => !SKIP.test(e.name));
    // the files of one folder are looked at a few dozen at a time; their order in the listing stays the folder's order
    const stats = new Map<string, fs.Stats>(); const files = kept.filter((e) => e.isFile());
    for (let i = 0; i < files.length; i += 32) await Promise.all(files.slice(i, i + 32).map(async (e) => { try { stats.set(e.name, await fs.promises.stat(path.join(d, e.name))); } catch { /* gone since it was listed */ } }));
    for (const e of kept) {
      const abs = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await into(abs, r);
      else { const st = stats.get(e.name); if (st && st.size > 0) out.push({ abs, rel: r, size: st.size, mtimeMs: st.mtimeMs }); }
    }
  };
  await into(dir, '');
  return out;
}
/** One short fingerprint of a folder's listing: every file's place, size and date. The same fingerprint means the same files, unchanged. */
export const listingPrint = (files: { rel: string; size: number; mtimeMs: number }[]) => createHash('sha256').update(files.map((f) => `${f.rel}\u0000${f.size}\u0000${f.mtimeMs}`).join('\n')).digest('hex').slice(0, 32);
export const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const docIdFor = (hash: string) => `doc_${hash.slice(0, 24)}`;

export function nodeDocuments(o: DocumentsOptions) {
  const clock = o.clock ?? (() => new Date().toISOString());
  const urlFor = o.urlFor ?? ((token: string) => `punchlist-doc://${token}`);
  const attachments = path.join(o.sharedPath, 'attachments');

  // ---- the window is given a token, never a path
  const tokens = new Map<string, string>();
  const tokenFor = (abs: string) => { for (const [t, p] of tokens) if (p === abs) return t; const t = randomUUID(); tokens.set(t, abs); if (tokens.size > 500) tokens.delete(tokens.keys().next().value as string); return t; };

  // ---- where a deal's folders are on this PC
  let places: Record<string, Record<string, string>> = {};
  try { places = JSON.parse(o.local.read('folders.json') ?? '{}'); } catch { /* none set */ }
  const localOf = (dealId: string, folder: string) => places[dealId]?.[folder] ?? folder;
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  /**
   * A folder that opens and holds nothing but files the system keeps for itself: emptied, or a network drive not connected,
   * which cannot be told apart. As `spot` takes a deal folder, only its own names count. Read only up to the first
   * name that counts, so a folder of thousands of files on a slow drive costs one read of its start.
   */
  const readsEmpty = (p: string) => {
    let dir: fs.Dir | undefined;
    try { dir = fs.opendirSync(p); for (let e = dir.readSync(); e; e = dir.readSync()) if (!SKIP.test(e.name)) return false; return true; }
    catch { return false; }
    finally { try { dir?.closeSync(); } catch { /* already closed */ } }
  };
  /** whether a deal has documents recorded in one of its folders: only then can that folder reading as empty hold any back */
  const holds = (dealId: string, folder: string) => { for (const d of records(dealId).values()) if (d.folder === folder) return true; return false; };
  /** a deal folder that is here to read: it opens, and holds something or had nothing recorded in it to hold */
  const here = (dealId: string, folder: string, p: string) => isDir(p) && (!holds(dealId, folder) || !readsEmpty(p));
  // what folders located on this PC taught, kept so a deal added later is found without asking
  let rules: Rule[] = [];
  try { const r = JSON.parse(o.local.read('folder-rules.json') ?? '[]'); if (Array.isArray(r)) rules = r.filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string'); } catch { /* none kept */ }
  const savePlaces = () => o.local.write('folders.json', JSON.stringify(places));

  const changeLists = new Map<string, ChangeList>();             // a document's id is its contents, so its changes never change

  // ---- conversion: made when needed, removed when done with
  const open: string[] = [];                                    // converted PDFs a person has opened, oldest first
  // the converter works on one file at a time: a second conversion asked for meanwhile (a document opened while indexing runs) waits its turn
  let converting: Promise<unknown> = Promise.resolve();
  const oneConversion = <T>(fn: () => Promise<T>): Promise<T> => { const p = converting.then(fn, fn); converting = p.catch(() => undefined); return p; };
  // files brought across for indexing are never left behind: whatever an earlier session left is cleared before anything runs
  const inbox = o.workPath ? path.join(o.workPath, 'in') : null;
  if (inbox) fs.rmSync(inbox, { recursive: true, force: true });
  let asked = o.atOnce; if (asked === undefined) { try { const n = JSON.parse(o.local.read('settings.json') ?? '{}').indexAtOnce; if (typeof n === 'number') asked = n; } catch { /* not set */ } }
  const atOnce = Math.max(1, Math.min(16, Math.floor(asked ?? 3)));
  async function asPdf(d: { docId: string; name: string; via?: string }, at: string, info?: ConvertInfo): Promise<string> {
    if (PDF.test(d.name)) return at;
    if (!o.convert || !o.workPath) throw new Error('no converter');
    // pages made by one converter are not shown or sent from another: they may break in different places
    if (d.via !== undefined && d.via !== o.convert.id) throw new Error(`${d.name} was indexed with a different converter (${d.via}) than this PC has (${o.convert.id})`);
    fs.mkdirSync(o.workPath, { recursive: true });
    const out = path.join(o.workPath, `${d.docId}.pdf`); if (fs.existsSync(out) && !info) return out;
    const convert = o.convert, work = o.workPath;
    return oneConversion(() => convert(at, work, `${d.docId}.pdf`, info, d.name));
  }
  /**
   * The PDF a document is shown and sent as. A Word or PowerPoint file indexed from its text has no pages yet: the first
   * time it is converted, its page count (and the converter, and its count of tracked changes) is recorded for every PC.
   */
  async function pdfOf(dealId: string, d: DocRecord, at: string): Promise<string> {
    if (d.pages !== undefined || PDF.test(d.name)) return asPdf(d, at);
    const info: ConvertInfo = {}; const pdf = await asPdf(d, at, info);
    try { const pages = await pdfPages(fs.readFileSync(pdf)); say(dealId, { docId: d.docId, pages, ...(o.convert ? { via: o.convert.id } : {}), ...(info.tracked ? { tracked: info.tracked } : {}) }); }
    catch (e) { if (pdf !== at) discard(d.docId); throw e; }
    return pdf;
  }
  const discard = (docId: string) => { if (o.workPath && !open.includes(docId)) fs.rmSync(path.join(o.workPath, `${docId}.pdf`), { force: true }); };

  // ---- fingerprints: a file is read once, and again only if its size or date changes
  let hashes: Record<string, { size: number; mtimeMs: number; hash: string }> = {};
  try { hashes = JSON.parse(o.local.read('hashes.json') ?? '{}'); } catch { /* worked out again */ }
  // The whole list is written now and then (it can be long). In between, each fingerprint is added as one line to a short
  // file beside it as soon as it is worked out, so that closing the app part-way loses none: the lines are read back at the
  // next start, and the file is emptied whenever the whole list is written.
  try { for (const line of (o.local.read('hashes-new.jsonl') ?? '').split('\n')) { if (!line) continue; const [abs, size, mtimeMs, hash] = JSON.parse(line) as [string, number, number, string]; if (typeof abs === 'string' && typeof hash === 'string') hashes[abs] = { size, mtimeMs, hash }; } } catch { /* a line cut short by a close: the rest stand */ }
  const learned = (abs: string, size: number, mtimeMs: number, hash: string) => { hashes[abs] = { size, mtimeMs, hash }; unsaved++; try { o.local.append('hashes-new.jsonl', JSON.stringify([abs, size, mtimeMs, hash]) + '\n'); } catch { /* worked out again next time */ } };
  let unsaved = 0; const saveHashes = (force = false) => { if (!unsaved || (!force && unsaved < 200)) return; unsaved = 0; try { o.local.write('hashes.json', JSON.stringify(hashes)); o.local.write('hashes-new.jsonl', ''); } catch { /* worked out again next time */ } };
  // ---- where indexing stopped: how far each folder of a deal had got, kept on this PC while a run is unfinished, so that a
  // session that ended part-way (or a run that failed) can still say where it left off. An entry goes when its folder finishes.
  let stoppedAt: Record<string, Record<string, DealFolder & { finished?: boolean }>> = {};   // `finished`: the run that covered this folder got to its end
  /** why a deal's last run broke, in words for a person, while this session knows it */
  const brokeWhy = new Map<string, string>();
  try { stoppedAt = JSON.parse(o.local.read('indexing.json') ?? '{}'); } catch { /* nothing remembered */ }
  const saveStopped = () => { try { o.local.write('indexing.json', JSON.stringify(stoppedAt)); } catch { /* only the count shown after a restart is lost */ } };
  // ---- what each folder held when a run last read all of it (`listingPrint`), so that a later look can tell at once whether
  // anything was added, changed or removed since. Kept on this PC: each PC reads its own copy of the data room.
  let printed: Record<string, Record<string, string>> = {};
  try { printed = JSON.parse(o.local.read('listings.json') ?? '{}'); } catch { /* read again in full at the next look */ }
  const savePrinted = () => { try { o.local.write('listings.json', JSON.stringify(printed)); } catch { /* the next look reads the folder again in full */ } };
  /** `failed`, when given, is told the code of the error that stopped the reading */
  function hashOf(abs: string, st?: { size: number; mtimeMs: number }, failed?: { code?: string }): string | null {
    try {
      const s = st ?? fs.statSync(abs); const had = hashes[abs];
      if (had && had.size === s.size && had.mtimeMs === s.mtimeMs) return had.hash;
      const h = createHash('sha256'); const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(1 << 20);
      try { for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
      const hash = h.digest('hex'); learned(abs, s.size, s.mtimeMs, hash); return hash;
    } catch (e) { if (failed) failed.code = (e as { code?: string })?.code ?? ''; return null; }
  }

  // ---- the shared records
  const mine = (dealId: string) => `docs-${o.installId}-${dealId}.jsonl`;
  const cache = new Map<string, { sizes: string; docs: Map<string, DocRecord>; sight: Sight; reads: Reads; shuts: Shuts }>();
  // a sync client's copy of a file set aside in a conflict is read too
  const filesOf = (dealId: string) => dealFiles(o.shared.list(), 'docs', dealId);
  const sizesOf = (names: string[]) => names.map((n) => `${n}:${o.shared.size(n)}`).join('|');
  /**
   * For each document, every place its file has been seen, and which PCs see it there now; and whether any PC has said it left a
   * place. A document is there while any PC sees it at any place; it is gone once no PC does.
   */
  type Places = Map<string, DocPlace & { by: Set<string>; first: string; /** when a PC first found no file here, since it was last seen here */ missed?: string }>;
  type Sight = Map<string, { places: Places; left: boolean }>;
  /** for each folder, when each PC last said anything about it: that it read it, or what it found there, part-way through a run included */
  type Reads = Map<string, Map<string, string>>;
  const noteRead = (reads: Reads, l: DocLine) => {
    const folder = l.read ?? l.folder ?? l.left?.folder ?? l.missed?.folder ?? l.cleared?.folder; if (folder === undefined) return;
    const by = reads.get(folder) ?? new Map<string, string>(); reads.set(folder, by); if ((by.get(l.pc) ?? '') < l.at) by.set(l.pc, l.at);
  };
  /** for each folder, the folders inside it that each PC could not open when it last finished reading it */
  type Shuts = Map<string, Map<string, { at: string; shut: string[]; opened: string[] }>>;
  const noteShut = (shuts: Shuts, l: DocLine) => { if (l.read === undefined) return; const by = shuts.get(l.read) ?? new Map<string, { at: string; shut: string[]; opened: string[] }>(); shuts.set(l.read, by); by.set(l.pc, { at: l.at, shut: l.shut ?? [], opened: l.opened ?? [] }); };
  /** whether a folder is one of these or inside one of them */
  const within = (shut: string[], rel: string) => shut.some((s) => s === rel || rel.startsWith(`${s}/`));
  /**
   * Of the folders other PCs said, in their latest reading, they may not open, those this PC can (it lists them, and they are
   * not behind one it may not open): what its reading takes in and speaks for. `top` is the deal folder on this PC.
   */
  const openedHere = (dealId: string, folder: string, top: string, mine: string[]) => {
    const others = new Set([...(both(dealId).shuts.get(folder) ?? new Map()).entries()].filter(([pc]) => pc !== o.installId).flatMap(([, x]) => x.shut));
    return [...others].filter((r) => !within(mine, r) && isDir(path.join(top, ...r.split('/')))).sort();
  };
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const placeKey = (folder: string, rel: string) => `${folder}\u0000${rel}`;
  const seers = (sg: { places: Places } | undefined) => { const by = new Set<string>(); for (const p of sg?.places.values() ?? []) for (const pc of p.by) by.add(pc); return by; };
  function apply(docs: Map<string, DocRecord>, sight: Sight, l: DocLine) {
    const d = docs.get(l.docId) ?? ({ docId: l.docId, hash: '', name: '', folder: '', rel: '', size: 0 } as DocRecord);
    const sg = sight.get(l.docId) ?? { places: new Map(), left: false }; sight.set(l.docId, sg);
    if (l.rel !== undefined && l.folder !== undefined) {
      const k = placeKey(l.folder, l.rel); const p = sg.places.get(k) ?? { folder: l.folder, rel: l.rel, name: l.name ?? path.basename(l.rel), by: new Set<string>(), first: l.at };
      if (l.name) p.name = l.name; p.by.add(l.pc); delete p.missed; sg.places.set(k, p);
    }
    if (l.left) { sg.places.get(placeKey(l.left.folder, l.left.rel))?.by.delete(l.pc); sg.left = true; }
    if (l.cleared) { const p = sg.places.get(placeKey(l.cleared.folder, l.cleared.rel)); for (const pc of l.cleared.by ?? []) p?.by.delete(pc); if (p) delete p.missed; sg.left = true; }      // until one of them sees it there again
    if (l.missed) { const p = sg.places.get(placeKey(l.missed.folder, l.missed.rel)); if (p && !p.missed) p.missed = l.at; }
    if (l.gone) { for (const p of sg.places.values()) p.by.delete(l.pc); sg.left = true; }      // an older line: it left every place this PC had seen it at
    if (l.rel !== undefined && l.folder !== undefined) Object.assign(d, { hash: l.hash ?? d.hash, size: l.size ?? d.size, ...(l.pages !== undefined ? { pages: l.pages } : {}), ...(l.via !== undefined ? { via: l.via } : {}), ...(l.tracked !== undefined ? { tracked: l.tracked } : {}), ...(l.words !== undefined ? { words: l.words } : {}), ...(l.cover !== undefined ? { cover: l.cover } : {}) });
    // its pages, made when it was first converted after indexing (a Word or PowerPoint file is indexed from its text): said with no place, since it is not about where it is
    else if (l.pages !== undefined) Object.assign(d, { pages: l.pages, ...(l.via !== undefined ? { via: l.via } : {}), ...(l.tracked !== undefined ? { tracked: l.tracked } : {}) });
    // where it is: its first place still seen, and the others as copies; with none seen, the last place it was seen at
    const seen = [...sg.places.values()].filter((p) => p.by.size).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : placeKey(a.folder, a.rel) < placeKey(b.folder, b.rel) ? -1 : 1));
    const main = seen[0] ?? (l.rel !== undefined && l.folder !== undefined ? sg.places.get(placeKey(l.folder, l.rel)) : undefined);
    if (main) Object.assign(d, { folder: main.folder, rel: main.rel, name: main.name });
    const copies = seen.slice(1).map((p) => ({ folder: p.folder, rel: p.rel, name: p.name })); if (copies.length) d.copies = copies; else delete d.copies;
    const firstSeen = [...sg.places.values()].map((p) => p.first).sort()[0]; if (firstSeen) d.seen = firstSeen;          // when the app first saw it anywhere, for ordering drafts
    if (l.summary !== undefined && d.summary === undefined) { Object.assign(d, { summary: l.summary, keywords: l.keywords ?? [] }); delete d.undescribed; } // what it is: the first word
    if (l.tried !== undefined && d.summary === undefined && l.tried >= (d.undescribed?.tries ?? 0)) d.undescribed = { tries: l.tried, at: l.at };     // a failed try to say what it is: the highest count, and when
    docs.set(l.docId, d);
  }
  /** every line about a deal's documents, from every copy of the app, put in one order and combined */
  function all(dealId: string): Map<string, DocRecord> { return both(dealId).docs; }
  function both(dealId: string): { docs: Map<string, DocRecord>; sight: Sight; reads: Reads; shuts: Shuts } {
    healOwn(o.shared, o.local, mine(dealId));
    const names = filesOf(dealId); const sizes = sizesOf(names); const had = cache.get(dealId); if (had && had.sizes === sizes) return had;
    const lines: DocLine[] = []; const seen = new Set<string>();             // a line in a file and in a conflict copy of it counts once
    for (const n of names) { for (const raw of wholeLines(o.shared.read(n) ?? '', 0, seen)) { try { const x = JSON.parse(raw) as DocLine; if (x?.v === 1 && typeof x.docId === 'string' && typeof x.at === 'string') lines.push(x); } catch { /* a damaged line is left out */ } } }
    lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0));
    const docs = new Map<string, DocRecord>(); const sight: Sight = new Map(); const reads: Reads = new Map(); const shuts: Shuts = new Map(); for (const l of lines) { noteRead(reads, l); noteShut(shuts, l); if (l.read === undefined) apply(docs, sight, l); }
    const made = { sizes, docs, sight, reads, shuts }; cache.set(dealId, made); return made;
  }
  /** no PC sees its file any more */
  const isGone = (sight: Sight, docId: string) => {
    const seen = sight.get(docId);
    return !!seen && seen.left && seers(seen).size === 0;
  };
  const seenHere = (dealId: string, docId: string) => seers(both(dealId).sight.get(docId)).has(o.installId);
  /** whether this PC has said it sees the document at this place, and still does */
  const seenHereAt = (dealId: string, docId: string, folder: string, rel: string) => !!both(dealId).sight.get(docId)?.places.get(placeKey(folder, rel))?.by.has(o.installId);
  /** the documents of a deal: those whose file is known (a review can arrive before the line that says where its document is) and has not gone */
  function records(dealId: string): Map<string, DocRecord> {
    // All visibility checks in one collection use the same journal snapshot.
    const { docs, sight } = both(dealId);
    const out = new Map<string, DocRecord>();
    for (const [id, document] of docs) {
      if (document.name && !isGone(sight, id)) out.set(id, document);
    }
    return out;
  }
  /**
   * Whether a document is in a folder the deal still has, at any of its places, or was attached. A folder a person took off
   * the deal stops feeding checks and questions; its documents stay known, so findings already made still open them.
   */
  const onDeal = (dealId: string) => {
    const now = o.foldersNow?.(dealId); if (!now) return () => true;
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase(); const have = new Set(now.map(norm));
    return (d: DocRecord) => [d, ...(d.copies ?? [])].some((p) => p.folder === ATTACHED || have.has(norm(p.folder)));
  };
  const known = (dealId: string, docId: string): DocRecord | undefined => { const d = all(dealId).get(docId); return d?.name ? d : undefined; };
  function say(dealId: string, line: Omit<DocLine, 'v' | 'pc' | 'at'>) {
    const before = both(dealId); const full: DocLine = { v: 1, pc: o.installId, at: clock(), ...line };
    appendOwn(o.shared, o.local, mine(dealId), JSON.stringify(full) + '\n');                 // the local copy first, so the shared one can be put back if the sync client loses lines
    noteRead(before.reads, full); noteShut(before.shuts, full); if (full.read === undefined) apply(before.docs, before.sight, full); cache.set(dealId, { sizes: sizesOf(filesOf(dealId)), docs: before.docs, sight: before.sight, reads: before.reads, shuts: before.shuts });       // its own line is the newest: no need to read everything again
  }

  // ---- where a document is on this PC
  const placeOf = (dealId: string, d: DocRecord) => (d.folder === ATTACHED ? path.join(attachments, d.rel) : path.join(localOf(dealId, d.folder), d.rel));
  /**
   * What this PC can say, right now, of a file's place in one of the deal's folders:
   *   'there'   the file is at the place, with these contents;
   *   'left'    it is seen not to be: a folder on the way to it lists and does not name it (names are matched exactly, so a
   *             rename that changes only capitals counts), something else is at the place (another file, a folder, a broken
   *             link), or a name on the way is a file where a folder was;
   *   'unread'  the folder lists it, and the file is locked or may not be opened: it has not left, and a check waits for
   *             it (see `away`);
   *   'away'    it cannot tell: the deal's folder cannot be listed or reads as empty (a drive that dropped, a laptop away
   *             from it), as indexing takes it, a folder on the way cannot be listed, or the file fails to read in any other way;
   *   'shut'    a folder on the way, inside the deal's folder, may not be opened by this person (EACCES, EPERM), as indexing
   *             takes it: a check waits for the file as for 'away', and `shut` is told that folder, from the deal's folder.
   * Only 'left' is ever written down, so a folder that cannot be reached for a while takes no document out of the deal.
   * `lists` keeps each folder's names for one pass over many places.
   */
  function spot(dealId: string, p: { folder: string; rel: string }, hash: string, lists: Lists = new Map(), shut?: { rel?: string }): 'there' | 'left' | 'unread' | 'away' | 'shut' {
    const root = localOf(dealId, p.folder); const at = path.join(root, p.rel);
    const names = (dir: string) => {
      if (!lists.has(dir)) { try { lists.set(dir, fs.readdirSync(dir)); } catch (e) { const code = (e as { code?: string })?.code ?? ''; lists.set(dir, code === 'ENOTDIR' ? 'file' : dir !== root && NO_ENTRY.includes(code) ? 'shut' : null); } }
      return lists.get(dir) ?? null;
    };
    const top = names(root); if (!Array.isArray(top) || !top.some((n) => !SKIP.test(n))) return 'away';
    let dir = root; const on: string[] = [];
    for (const part of p.rel.split('/')) {
      const ns = names(dir); if (ns === 'file') return 'left'; if (ns === 'shut') { if (shut) shut.rel = on.join('/'); return 'shut'; } if (!ns) return 'away';
      if (!ns.includes(part)) return 'left'; dir = path.join(dir, part); on.push(part);
    }
    // Its folder names it: what is there now? As indexing tells them apart, a file that is locked or may not be opened is
    // that one file's trouble ('unread'); any other failure is the data room not answering ('away').
    const why = (e: unknown) => { const code = (e as { code?: string })?.code ?? ''; return code === 'ENOENT' ? 'left' as const : ONE_FILE.includes(code) ? 'unread' as const : 'away' as const; };   // ENOENT: a broken link, or deleted just now
    let st: fs.Stats; try { st = fs.statSync(at); } catch (e) { return why(e); }
    if (!st.isFile()) return 'left';
    const failed: { code?: string } = {}; const h = hashOf(at, st, failed);
    return h === null ? why(failed) : h === hash ? 'there' : 'left';
  }
  /** files that stayed locked for a whole wait, and until when they are not waited for again */
  const resting = new Map<string, number>();
  /** a file's fingerprint; a file that is locked or may not be opened (a save, a sync or a virus scan holding it) is waited for a moment first */
  async function hashWaiting(abs: string): Promise<string | null> {
    const failed: { code?: string } = {}; let h = hashOf(abs, undefined, failed);
    if (h !== null || !ONE_FILE.includes(failed.code ?? '') || Date.now() < (resting.get(abs) ?? 0)) return h;
    for (const ms of BUSY_WAITS) {
      await sleep(ms); failed.code = undefined; h = hashOf(abs, undefined, failed);
      if (h !== null) { resting.delete(abs); return h; }
      if (!ONE_FILE.includes(failed.code ?? '')) return null;
    }
    resting.set(abs, Date.now() + REST_MS); return null;
  }
  async function locate(dealId: string, d: DocRecord): Promise<string | null> {
    const at = placeOf(dealId, d); if (fs.existsSync(at) && (await hashWaiting(at)) === d.hash) return at;
    // It is not where it was. It is said to have left that place (it may be at a copy's place, or moved) only when this PC
    // sees that it has: while the folder cannot be reached nothing is said, and the document is still the deal's.
    let shut = false;                                                           // in a folder this person may not open
    if (d.folder !== ATTACHED) {
      const now = spot(dealId, d, d.hash); if (now === 'there') return at;      // the folder came back between the two looks
      if (now === 'left' && seenHereAt(dealId, d.docId, d.folder, d.rel)) { try { say(dealId, { docId: d.docId, left: { folder: d.folder, rel: d.rel } }); } catch { /* said at the next indexing */ } }
      shut = now === 'shut';
    }
    for (const c of d.copies ?? []) { const there = c.folder === ATTACHED ? path.join(attachments, c.rel) : path.join(localOf(dealId, c.folder), c.rel); if (fs.existsSync(there) && hashOf(there) === d.hash) return there; }
    // A file in a folder this person may not open has not moved, as far as anyone can tell: the data room is not searched for
    // it, which would list every folder and look at every file on each ask for one of its documents.
    if (shut) return null;
    // moved or renamed: look through the deal's folders for the same contents
    let folders: string[] = []; try { folders = await o.folders(dealId); } catch { /* none to look in */ }
    for (const folder of folders) for (const f of walk(localOf(dealId, folder))) {
      if (f.size !== d.size || hashOf(f.abs, f) !== d.hash) continue;
      try { say(dealId, { docId: d.docId, hash: d.hash, name: path.basename(f.abs), folder, rel: f.rel, size: f.size, ...(d.pages !== undefined ? { pages: d.pages } : {}), ...(d.via !== undefined ? { via: d.via } : {}), ...(d.tracked !== undefined ? { tracked: d.tracked } : {}) }); } catch { /* found all the same */ }
      saveHashes(true); return f.abs;
    }
    saveHashes(true); return null;
  }
  /** what the store keeper needs to upload these documents, each as the PDF it is shown as; a document whose file cannot be found is left out */
  async function wanted(dealId: string, docIds: string[]): Promise<WantedDoc[]> {
    const docs = records(dealId); const out: WantedDoc[] = [];
    for (const id of docIds) {
      const d = docs.get(id); const at = d ? await locate(dealId, d) : null; if (!d || !at) continue;
      out.push({ docId: id, name: paged(d.name) ? pdfName(d.name) : d.name, read: async () => { if (!paged(d.name)) return fs.readFileSync(at); const pdf = await pdfOf(dealId, d, at); try { return fs.readFileSync(pdf); } finally { if (pdf !== at) discard(d.docId); } } });
    }
    return out;
  }

  /**
   * Is this folder on this PC the folder the deal has under that name? Up to 25 of the documents recorded there are looked
   * for at the same place inside it, with the same contents. Nothing recorded yet means nothing to check against (0 of 0).
   */
  function compare(dealId: string, folder: string, candidate: string): FolderMatch {
    const recs = [...records(dealId).values()].filter((d) => d.folder === folder).sort((a, b) => (a.rel < b.rel ? -1 : 1));
    const step = Math.max(1, Math.floor(recs.length / 25)); const sample = recs.filter((_, i) => i % step === 0).slice(0, 25); let matched = 0;
    for (const d of sample) { const at = path.join(candidate, d.rel); try { if (fs.statSync(at).size === d.size && hashOf(at) === d.hash) matched++; } catch { /* not there */ } }
    saveHashes(true); return { folder, matched, checked: sample.length };
  }

  /** a spreadsheet's sheets: a .csv is text already; any other is read through LibreOffice */
  async function sheetsOf(at: string, asShown = false): Promise<Sheet[]> {
    if (/\.csv$/i.test(at)) return [{ name: 'Sheet1', grid: parseCsv(decodeText(fs.readFileSync(at))) }];
    if (!o.convert?.sheets) throw new Error('no converter');
    return o.convert.sheets(at, asShown);
  }
  /**
   * Whether a read gives a document words its record lacks: it had none yet, or only the empty list an earlier build
   * kept for a file it could not read (#1023). A successful read replaces that record for every PC.
   */
  const gainsWords = (had: string[] | undefined, read: string[] | undefined) =>
    read !== undefined && (had === undefined || (!had.length && read.length > 0));
  /** one sheet of a spreadsheet: its name, and each of its cells handed over as it is read */
  interface SheetSource { name: string; each(onCell: (cell: string) => void): Promise<void> }
  const gridCells = (sheet: Sheet): SheetSource => ({
    name: sheet.name,
    each: async (onCell) => {
      for (const row of sheet.grid) row.forEach(onCell);
    },
  });
  /**
   * The sheets of a spreadsheet. A .csv is read a piece at a time from its file, never whole (#427): held in memory
   * whole, a 200 MB one fails and a 600 MB one is beyond what a string can hold. Any other kind comes from the
   * converter as grids, as before.
   */
  async function readSheets(at: string): Promise<SheetSource[]> {
    if (!/\.csv$/i.test(at)) return (await sheetsOf(at)).map(gridCells);
    return [{ name: 'Sheet1', each: (onCell) => eachCsvCell(at, onCell) }];
  }
  /**
   * The words a document read as a PDF uses most, added to this PC's word index; undefined when its text could not be
   * read, which is not the same as having none (#1056).
   */
  function lookWords(dealId: string, docId: string, look: { text: string | undefined; first: string }) {
    if (look.text === undefined) return undefined;
    o.index?.add(dealId, docId, countWords(look.text, look.first));
    return topWords(look.text);
  }
  /**
   * A paged document read as a PDF: its pages, its words (`lookWords`), its first page's text, and what converting it
   * said when it was converted. Throws when it cannot be turned into a PDF or opened.
   */
  async function readAsPdf(dealId: string, doc: { docId: string; name: string; via?: string }, file: string) {
    const info: ConvertInfo = {};
    const pdf = await asPdf(doc, file, info);
    try {
      const look = await pdfLook(fs.readFileSync(pdf), Infinity);
      const converted = pdf !== file ? info : undefined;
      return { pages: look.pages, words: lookWords(dealId, doc.docId, look), first: look.first, converted };
    } finally { if (pdf !== file) discard(doc.docId); }
  }
  /** a converted document's converter, and its tracked changes when the conversion counted any */
  const convertedBy = (info: ConvertInfo, tracked: number | undefined) =>
    ({ via: o.convert?.id, tracked: info.tracked || tracked });
  /**
   * The words a spreadsheet uses most; undefined when it could not be read, which is not the same as having none (it is
   * read again). A .csv is read a piece at a time, so the file is never held whole. Its words are counted twice, as
   * every other document's are: for this PC's index and for its `words` list.
   */
  async function sheetWords(at: string, dealId?: string, docId?: string): Promise<string[] | undefined> {
    try {
      const tally = new WordTally();
      const used = new Map<string, number>();
      const take = (text: string) => {
        tally.add(text);
        countInto(used, text);
      };
      const sheets = await readSheets(at);
      // a name nobody gave a sheet says nothing
      for (const sheet of sheets) if (!/^Sheet\d+$/.test(sheet.name)) take(sheet.name);
      for (const sheet of sheets) await sheet.each(take);        // numbers and dates are content too (#1023)
      // sheet names come first, so they make its title
      if (dealId && docId) o.index?.add(dealId, docId, tally.words());
      return mostUsed(used);
    } catch { return undefined; }
  }

  /** Spreadsheets are read after every other file, so a very large one cannot hold up the rest (#427). */
  function spreadsheetsLast<T extends { f: { abs: string } }>(list: T[]): T[] {
    const isSheet = (x: T) => !paged(path.basename(x.f.abs));
    return [...list.filter((x) => !isSheet(x)), ...list.filter(isSheet)];
  }
  /**
   * A file that is there but could not be read in this run (#427): it is named, and its folder's listing is not saved,
   * so the next look reads the folder again. The run's count of files not read is the number of names.
   */
  function noteUnread(names: string[], unreadAt: Set<string>, folderPath: string, rel: string) {
    names.push(rel);
    unreadAt.add(placeKey(folderPath, rel));
  }
  /**
   * What the next look compares with is the listing the run read: a file added while it ran is not in it, so that look
   * finds it. A folder with a file that could not be read today (open elsewhere, locked, a spreadsheet that would not
   * convert) keeps no listing, so the next look reads it again (#427).
   */
  function savePrints(
    dealId: string,
    found: { folder: DealFolder; files: ReturnType<typeof walk> }[],
    unreadAt: Set<string>,
  ) {
    for (const { folder, files } of found) {
      const unreadHere = [...unreadAt].some((k) => k.startsWith(`${folder.path}\u0000`));
      if (unreadHere) delete printed[dealId]?.[folder.path];
      else (printed[dealId] ??= {})[folder.path] = listingPrint(files);
    }
    savePrinted();
  }
  /** What the run took, for the result and the line kept here. Attached sheets not read are not listed files (#427). */
  function timingOf(
    listed: number,
    brought: number,
    unreadListed: number,
    t: Pick<IndexTiming, 'bytes' | 'readMs' | 'workMs' | 'atOnce'> & { started: number },
  ): IndexTiming {
    const { started, ...rest } = t;
    return { files: listed, brought, known: listed - brought - unreadListed, totalMs: Date.now() - started, ...rest };
  }
  function noteTiming(dealId: string, timing: IndexTiming) {
    const { files, brought, bytes, readMs, workMs, atOnce } = timing;
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const perSecond = (readMs ? bytes / 1e6 / (readMs / 1000) : 0).toFixed(1);
    const count = (n: number) => n.toLocaleString('en-US');
    const line = `${clock()} ${dealId}: ${count(files)} file${files === 1 ? '' : 's'} in ${secs(timing.totalMs)}; `
      + `${count(brought)} read from the data room (${size(bytes)}) in ${secs(readMs)}, ${perSecond} MB/s, `
      + `${atOnce} at a time; ${secs(workMs)} converting and reading pages, waits included, in parallel with `
      + `the reading; ${count(timing.known)} already known\n`;
    try { o.local.write('indexing-last.txt', line); } catch { /* the times are a convenience */ }
  }

  /**
   * The spreadsheets attached in the app whose words could not be read (#427): each run reads them again, adds the
   * names still unread to `names`, and returns how many there are. They are in no folder's listing, so while any is
   * unread no folder of the run keeps its listing, and the next look reads them again.
   */
  async function readAttachedSheets(
    dealId: string,
    names: string[],
    unreadAt: Set<string>,
    folders: DealFolder[],
  ): Promise<number> {
    let unreadCount = 0;
    for (const d of records(dealId).values()) {
      const place = [d, ...(d.copies ?? [])].find((p) => p.folder === ATTACHED);
      if (!place || paged(d.name) || d.words !== undefined) continue;
      const at = path.join(attachments, place.rel);
      const words = await sheetWords(at, dealId, d.docId);
      if (words === undefined) {
        names.push(place.name);
        unreadCount++;
        continue;
      }
      const line = { docId: d.docId, hash: d.hash, name: place.name, folder: ATTACHED, rel: place.rel, size: d.size };
      say(dealId, { ...line, words });
    }
    if (unreadCount) for (const f of folders) unreadAt.add(placeKey(f.path, ''));
    return unreadCount;
  }

  // ---- indexing
  interface Job { folders: DealFolder[]; log: string[]; done: boolean; run: Promise<void>; timing?: IndexTiming; /** started by a look at folders already indexed, not by a person */ again?: boolean; /** with `again`: a check of everything starts by then and reads what this run finds, so a run that ends before it says so to onIndexed */ quietUntil?: number }
  /** The data room, a folder of it, or this PC's disk stopped answering: the run cannot go on, and must not be taken for one that finished. */
  class Broken extends Error {}
  const AWAY = 'The data room stopped answering.';
  const jobs = new Map<string, Job>();
  /**
   * Files that would not turn into pages since the app started, by path, with the size and date they had. Such a file has
   * no complete record, so without this every run (and the app starts runs by itself) would read it from the data room
   * again only to fail again. Kept in memory only: after a restart it is tried once more, in case what stopped it has passed.
   */
  const unpagedHere = new Map<string, { size: number; mtimeMs: number }>();
  /** starts that wait for the run under way: together they make one run, of every folder any of them asked for */
  const next = new Map<string, { folders: Map<string, DealFolder>; started: Promise<void> }>();
  async function run(dealId: string, job: Job) {
    const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
    const found: { folder: DealFolder; files: ReturnType<typeof walk>; shut: string[] }[] = [];
    // A folder, or a folder inside it, that cannot be listed means the listing is not the whole of what is there: the run stops,
    // rather than index a part and take the rest for gone. One exception: a folder inside the deal's folder that this
    // person may not open (EACCES, EPERM) while the deal's folder itself lists. That is that folder's trouble, not the data
    // room's: the rest is indexed, the folder is named in the log, and nothing seen in it is taken as having left (see below).
    for (const folder of job.folders) {
      const top = localOf(dealId, folder.path); const failed: { dir: string; code: string }[] = []; const files = walk(top, failed);
      const shut = failed.filter((x) => x.dir !== top && NO_ENTRY.includes(x.code)); if (shut.length < failed.length) throw new Broken(AWAY);
      // Folders closed to this person while the deal's folder still lists. If it no longer does (a sign-in to the share that
      // lapsed part-way gives the same errors), or nothing at all could be listed, it is the data room not answering.
      if (shut.length) { let still = !!files.length; try { fs.readdirSync(top); } catch { still = false; } if (!still) throw new Broken(AWAY); }
      found.push({ folder, files, shut: shut.map((x) => path.relative(top, x.dir).split(path.sep).join('/')) });
      folder.files = files.length; folder.size = size(files.reduce((a, f) => a + f.size, 0)); folder.indexed = 0; folder.reviewed = 0; await tick();
    }
    for (const f of job.folders) (stoppedAt[dealId] ??= {})[f.path] = { ...f };                       // from here on, a run that ends early is remembered: nothing indexed yet
    // how far it has got goes to disk after each file that had to be read, a few times a second while files are only
    // being recognized, and when the run ends or breaks
    saveStopped();
    let savedAt = Date.now();
    let unread = 0, unpaged = 0, indexed = 0; const skipped = { unread: [] as string[], unpaged: [] as string[], wordless: [] as string[] }; const named = (list: string[]) => `: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`; const here = new Set<string>();                    // the documents this run found in the folders
    const foundAt = new Map<string, Set<string>>();                         // and which document is at each place it read
    const told = new Set<string>();                                         // the folders this run said anything new about
    // Each file that has to be read is brought across from the data room once: its fingerprint is worked out from the bytes as
    // they arrive, and its pages and words are read from the copy on this PC, which is then removed. A few are brought at a
    // time, because a share is slow at opening files more than at sending them. They are still worked on, and recorded, one
    // at a time and in order. A file already known by its size and date, with nothing missing from its record, is not read.
    const list = spreadsheetsLast(found.flatMap(({ folder, files }) => files.map((f) => ({ folder, f }))));
    const started = Date.now(); let reading = 0, readFrom = 0, readMs = 0, workMs = 0, bytes = 0, brought = 0;
    const need = (name: string, had: DocRecord | undefined) => (paged(name) && !DIRECT.test(name) ? had?.pages === undefined || had?.words === undefined : had?.words === undefined);
    const dir = inbox ? path.join(inbox, dealId) : null; if (dir) fs.rmSync(dir, { recursive: true, force: true });
    // `size` is the size of the bytes the fingerprint was worked out from, so that the two always describe the same file; `failed` says the file is known, from this session, not to turn into pages
    const bring = async (i: number): Promise<{ hash: string | null; local: string | null; size: number; broke?: string; failed?: boolean; read?: boolean }> => {
      const { f, folder } = list[i]; const name = path.basename(f.abs); const had = hashes[f.abs];
      const hash = had && had.size === f.size && had.mtimeMs === f.mtimeMs ? had.hash : null;
      if (hash && !need(name, known(dealId, docIdFor(hash)))) return { hash, local: null, size: f.size };
      const no = unpagedHere.get(f.abs); if (hash && no && no.size === f.size && no.mtimeMs === f.mtimeMs) return { hash, local: null, size: f.size, failed: true };
      if (!dir) {                                                            // no working folder on this PC: the file is read where it is
        let st: fs.Stats; try { st = fs.statSync(f.abs); } catch { return { hash: null, local: null, size: f.size }; }
        const got = hashOf(f.abs, st); if (got) { brought++; bytes += st.size; }
        return { hash: got, local: null, size: st.size, read: true };
      }
      const local = path.join(dir, String(i), name);
      if (!reading++) readFrom = Date.now();
      let side: 'room' | 'pc' | null = null;                                  // which end failed first: the data room being read, or this PC being written to
      try {
        try { await fs.promises.mkdir(path.dirname(local), { recursive: true }); } catch (e) { side = 'pc'; throw e; }
        const h = createHash('sha256'); let n = 0;
        const from = fs.createReadStream(f.abs, { highWaterMark: 1 << 20 }); const to = fs.createWriteStream(local);
        from.once('error', () => { side ??= 'room'; }); to.once('error', () => { side ??= 'pc'; });
        await pipeline(from, new Transform({ transform(chunk, _enc, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); } }), to);
        const got = h.digest('hex'); bytes += n; brought++;
        // remembered under the size and date of the listing only if that is what came across: a file replaced since the listing is read again next time
        if (n === f.size) learned(f.abs, f.size, f.mtimeMs, got);
        return { hash: got, local, size: n, read: true };
      } catch (e) {
        fs.rmSync(path.dirname(local), { recursive: true, force: true });
        const code = (e as { code?: string })?.code ?? '';
        if (side === 'pc') return { hash: null, local: null, size: f.size, broke: code === 'ENOSPC' ? 'This PC is out of disk space.' : 'The working folder on this PC could not be written to.' };
        // This one file cannot be read (it has gone since the listing, is locked, or may not be opened) and the folder is still there: it is left out and named.
        // Anything else is the data room not answering: the run stops there, and is not taken for a finished one.
        if (['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EISDIR'].includes(code) && isDir(localOf(dealId, folder.path))) return { hash: null, local: null, size: f.size };
        return { hash: null, local: null, size: f.size, broke: AWAY };
      }
      finally { if (!--reading) readMs += Date.now() - readFrom; }
    };
    const coming: ReturnType<typeof bring>[] = []; const unreadAt = new Set<string>();   // files that are there but could not be read in this run
    try {
      for (let i = 0; i < list.length; i++) {
        while (coming.length < list.length && coming.length < i + atOnce) coming.push(bring(coming.length));
        const { folder, f } = list[i]; const { hash, local, broke, failed, read, size: bytesRead } = await coming[i]; const name = path.basename(f.abs); const src = local ?? f.abs;
        if (broke) throw new Broken(broke);
        try {
          if (!hash) noteUnread(skipped.unread, unreadAt, folder.path, f.rel);
          else {
            const docId = docIdFor(hash); const had = known(dealId, docId); here.add(docId); foundAt.set(placeKey(folder.path, f.rel), new Set([docId]));                  // the file is there, whether or not it can be turned into pages today
            // a file shown as pages is never indexed without them: it must convert, and the PDF must open
            // nothing is uploaded and no model is asked here: the file is counted, and its words are, on this PC
            let pages = had?.pages; let via = had?.via; let tracked = had?.tracked; let words = had?.words; let cover = had?.cover; let asPages = true; const t0 = Date.now();
            const unindexed = !!o.index && !o.index.has(dealId, docId);   // this PC keeps its own index, so it reads the words of every file in its copy once
            // Word and PowerPoint: the text is read from the file, and it is converted only when first sent or opened.
            // One that cannot be read so (damaged, or locked with a password) goes to the converter, as before, which says whether it can make pages.
            const direct = DIRECT.test(name); const unread = words === undefined || unindexed; let readDirect = false;
            if (direct && unread) try { const r = officeText(fs.readFileSync(src), name); words = topWords(r.text); if (r.tracked && pages === undefined) tracked = r.tracked; o.index?.add(dealId, docId, countWords(r.text, r.first)); readDirect = true; } catch { /* to the converter */ }
            if (paged(name) && (direct ? unread && !readDirect : pages === undefined || unread)) {
              let stuck = !!failed;                                         // known not to turn into pages: it was not brought across, and is counted and named as before
              let textUnread = false;
              if (!stuck) {
                try {
                  const known = { docId, name, ...(had?.via !== undefined ? { via: had.via } : {}) };
                  const read = await readAsPdf(dealId, known, src);
                  if (read.converted) ({ via, tracked } = convertedBy(read.converted, tracked));
                  pages = read.pages;
                  words = read.words;
                  textUnread = words === undefined;
                  if (!textUnread && PDF.test(name)) cover = coverOf(read.first) ?? undefined;
                } catch { stuck = true; unpagedHere.set(f.abs, { size: f.size, mtimeMs: f.mtimeMs }); }
              }
              if (stuck && pages === undefined) { asPages = false; unpaged++; skipped.unpaged.push(f.rel); }      // pages it already had stay; only its words are missing
              // listed with its pages and without words; its folder keeps no listing, so the next look reads it again (#1056)
              if (textUnread) noteUnread(skipped.unread, unreadAt, folder.path, f.rel);
            } else if (!paged(name) && (words === undefined || unindexed)) {
              words = await sheetWords(src, dealId, docId) ?? words;
              if (words === undefined) noteUnread(skipped.unread, unreadAt, folder.path, f.rel);
            }
            workMs += Date.now() - t0;
            if (asPages) {
              // said once per place: a copy of a file already known is a second place for the same document, not a new one, and is not said again each run
              const changed = !had || had.pages !== pages || had.size !== bytesRead || gainsWords(had.words, words)
                || (had.cover === undefined && cover !== undefined) || !seenHereAt(dealId, docId, folder.path, f.rel);
              if (changed) {
                told.add(folder.path);
                const line = { docId, hash, name, folder: folder.path, rel: f.rel, size: bytesRead };
                say(dealId, {
                  ...line,
                  ...(pages !== undefined ? { pages } : {}),
                  ...(via !== undefined ? { via } : {}),
                  ...(tracked !== undefined ? { tracked } : {}),
                  ...(words !== undefined ? { words } : {}),
                  ...(cover !== undefined ? { cover } : {}),
                });
              }
              indexed++; if (words !== undefined && !words.length) skipped.wordless.push(f.rel);
            }
          }
        } finally { if (local) fs.rmSync(path.dirname(local), { recursive: true, force: true }); }
        folder.indexed++; saveHashes(); (stoppedAt[dealId] ??= {})[folder.path] = { ...folder }; if (read || Date.now() - savedAt >= 250) { saveStopped(); savedAt = Date.now(); } await tick();
      }
    } finally {
      saveStopped();                                                         // however the run ends, where it got to is on disk
      await Promise.allSettled(coming);                                      // anything still on its way arrives before it is cleared
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      if (inbox) { try { fs.rmdirSync(inbox); } catch { /* another deal is being indexed, or it was never made */ } }
    }
    saveHashes(true);
    // what is no longer where it was seen in these folders has left that place; it may still be at another. A folder that reads as empty is taken as unreadable, not as emptied.
    for (const { folder, files, shut } of found) {
      if (!files.length) continue;
      // every place in the folder where any PC sees a document now, except where a file is there but could not be read today,
      // and anywhere in a folder this person may not open: what is in it is not known, so nothing in it has left
      const closed = (rel: string) => shut.some((s) => rel.startsWith(`${s}/`));
      const places: { docId: string; rel: string; by: Set<string>; missed?: string }[] = [];
      for (const [docId, sg] of both(dealId).sight) for (const p of sg.places.values()) if (p.folder === folder.path && p.by.size && !unreadAt.has(placeKey(folder.path, p.rel)) && !closed(p.rel)) places.push({ docId, rel: p.rel, by: new Set(p.by), ...(p.missed ? { missed: p.missed } : {}) });
      const still = (x: (typeof places)[number]) => !!foundAt.get(placeKey(folder.path, x.rel))?.has(x.docId);
      // Is this PC's copy the folder the other PCs saw, changed since in places, or only a part of it? Most of what is seen in it
      // (limits.sameFolder percent), here unchanged, says it is the folder. Then what is not here (deleted, or a new version saved over it) has left that place
      // for the PCs no longer reading it, so that a document the PC that read it last is no longer used to read again does not stay in the deal for
      // good. A PC that still sees it there says so when it next reads the folder, and it is back. A part of the folder, as
      // before, takes away only what this PC itself had seen.
      const whole = places.length > 0 && places.filter(still).length * 100 >= places.length * control.limits.sameFolder;
      // A subfolder that is not here at all, or holds no file here (selective sync, a subfolder not shared with this person, a
      // placeholder), is taken as not on this PC rather than emptied: what was seen in it goes only through the PCs that saw it.
      const dirOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));
      const listed = new Set(files.map((f) => dirOf(f.rel)));
      // Only a PC that has not read the folder for timings.folderIdle (30 days) is spoken for: one no longer used. A PC still in
      // use says for itself what has left its copy, so two PCs whose copies differ for good, each way, never take each other's
      // documents away. A PC says it read the folder at most once a day when nothing is new (see below), so a clock a few
      // minutes out makes no difference.
      const now = Date.parse(clock()); const ago = (ms: number) => new Date(now - ms).toISOString();
      const readBy = both(dealId).reads.get(folder.path); const cutoff = ago(control.timings.folderIdle);
      const idle = (pc: string) => pc !== o.installId && (readBy?.get(pc) ?? '') < cutoff;
      const lists: Lists = new Map();
      for (const x of places) {
        if (still(x)) continue;
        // The listing did not have it. Before anything is said, the place is looked at again: a file the listing lost because
        // the folder stopped answering part-way (its details could not be read) has not left.
        if (!foundAt.has(placeKey(folder.path, x.rel)) && spot(dealId, { folder: folder.path, rel: x.rel }, all(dealId).get(x.docId)?.hash ?? '', lists) !== 'left') continue;
        const gone = [...x.by].filter(idle);
        if (whole && listed.has(dirOf(x.rel)) && gone.length) {
          // Another file at the place (a new version saved over it) proves this one left it, and it is cleared now. No file at
          // all may be one this PC's copy has yet to receive (a sync still running), so the document is cleared only if it is
          // still not there when a PC reads the folder again a day or more later; seen there meanwhile, it starts over.
          const replaced = foundAt.has(placeKey(folder.path, x.rel));
          if (replaced || (x.missed && x.missed < ago(DAY))) { told.add(folder.path); say(dealId, { docId: x.docId, cleared: { folder: folder.path, rel: x.rel, by: gone } }); }
          else if (!x.missed) { told.add(folder.path); say(dealId, { docId: x.docId, missed: { folder: folder.path, rel: x.rel } }); }
        }
        if (x.by.has(o.installId)) { told.add(folder.path); say(dealId, { docId: x.docId, left: { folder: folder.path, rel: x.rel } }); }
      }
      // this PC has read the folder, so is in use and not spoken for. Said on its first read, when the run said anything else
      // about the folder, and otherwise at most once a day: a run that finds nothing new adds no line the same day.
      // The folders inside it that it could not open are said with it, and it is said again when they change.
      // So are those another PC may not open that this one could, so that it speaks for them.
      const had = both(dealId).shuts.get(folder.path)?.get(o.installId); const opened = openedHere(dealId, folder.path, localOf(dealId, folder.path), shut);
      if (told.has(folder.path) || !sameList(had?.shut ?? [], shut) || !sameList(had?.opened ?? [], opened) || (readBy?.get(o.installId) ?? '') < ago(DAY)) say(dealId, { docId: '', read: folder.path, ...(shut.length ? { shut } : {}), ...(opened.length ? { opened } : {}) });
    }
    const attachedUnread = await readAttachedSheets(dealId, skipped.unread, unreadAt, job.folders);
    unread = skipped.unread.length;                       // every file not read is named
    // a file that was left out is named, so that a person can see which
    const shut = found.flatMap((x) => x.shut);
    job.log = [`Indexed ${plural(indexed, 'file')}`, ...(shut.length ? [`${plural(shut.length, 'folder')} could not be opened${named(shut)}`] : []), ...(unread ? [`${plural(unread, 'file')} could not be read${named(skipped.unread)}`] : []), ...(unpaged ? [`${plural(unpaged, 'file')} could not be turned into pages and ${unpaged === 1 ? 'was' : 'were'} not indexed${named(skipped.unpaged)}`] : []),
      // a file with no text to read (a scan, most often) is indexed, but only its name and folder can find it
      ...(skipped.wordless.length ? [`${plural(skipped.wordless.length, 'file')} ${skipped.wordless.length === 1 ? 'has' : 'have'} no readable text and can be found by name only${named(skipped.wordless)}`] : [])];
    for (const f of job.folders) (stoppedAt[dealId] ??= {})[f.path] = { ...f, finished: true };       // kept, so that the deal can be told about every folder whichever run indexed it, also after a restart
    saveStopped();
    savePrints(dealId, found, unreadAt);
    // how the time went, for this PC: on the result, and as one line in a file here that holds the latest run only (it is written over, so it never grows)
    job.timing = timingOf(list.length, brought, unread - attachedUnread, { bytes, started, readMs, workMs, atOnce });
    noteTiming(dealId, job.timing);
    // A run started by a look that found nothing new and nothing gone (only a file's date changed, say) starts no first pass: it would cost model calls for nothing
    job.done = true; if (!job.again || told.size) o.onIndexed?.(dealId, job.quietUntil !== undefined && Date.now() < job.quietUntil ? { forCheck: true } : undefined);
  }

  /** No method throws: whatever goes wrong underneath comes back as a failure the app has a reaction to. */
  const safe = <A extends unknown[], T>(run: (...a: A) => Promise<Result<T>>) => async (...a: A): Promise<Result<T>> => {
    try { return await run(...a); } catch (e) { return fail((e as { code?: string }).code === 'ENOSPC' ? { kind: 'storageFull', message: 'The Punchlist folder is full.' } : { kind: 'unreachable', message: 'The Punchlist folder could not be reached.' }); }
  };

  /**
   * The tracked changes and comments in a document, passage by passage: as it was, as it reads now, and who changed what
   * and when. Worked out from the file when asked, and remembered while the app runs. A document that cannot have any
   * (a PDF, a spreadsheet) has an empty list.
   */
  const service_changes = safe(async (dealId: string, docId: string): Promise<Result<ChangeList>> => {
    const d = known(dealId, docId); if (!d) return fail({ kind: 'notFound', message: 'No such document in this deal' });
    const had = changeLists.get(docId); if (had) return ok(had);
    if (!paged(d.name) || PDF.test(d.name) || !o.convert?.changes) return ok({ passages: [], tracked: 0, complete: true });
    const at = await locate(dealId, d); if (!at) return fail({ kind: 'notFound', message: `${d.name} could not be found in the deal’s folders` });
    let list: ChangeList; try { const changes = o.convert.changes; list = await oneConversion(() => changes(at)); } catch { return fail({ kind: 'failed', message: `The changes in ${d.name} could not be read` }); }
    changeLists.set(docId, list); if (changeLists.size > 50) changeLists.delete(changeLists.keys().next().value as string);
    return ok(list);
  });

  // A folder's listing as the New deal form last counted it, kept for a few minutes so the duplicate check on Create (sameRoom)
  // does not walk a data room of tens of thousands of files a second time. Only the newest few folders are kept.
  const listed = new Map<string, { at: number; files: ReturnType<typeof walk> }>();
  const LISTED_MS = 5 * 60_000, LISTED_MAX = 8;
  const listing = (p: string) => {
    const l = listed.get(p); if (l && Date.now() - l.at < LISTED_MS) return l.files;
    const files = walk(p); listed.delete(p); listed.set(p, { at: Date.now(), files });
    if (listed.size > LISTED_MAX) listed.delete(listed.keys().next().value as string);
    return files;
  };

  /** a run under way for the deal, or one waiting to start */
  const busy = (dealId: string) => { const j = jobs.get(dealId); return (!!j && !j.done) || next.has(dealId); };
  /** looks at a deal's folders under way, so that a timer, a deal opened and a check asked for at once make one look */
  const looking = new Map<string, Promise<Result<'same' | 'running' | 'unknown'>>>();
  /** Confirm an unchanged listing once a day without asserting cleared document sightings again (#33). */
  function noteUnchangedRead(dealId: string, folder: string, shut: string[], opened: string[]) {
    const last = both(dealId).reads.get(folder)?.get(o.installId) ?? '';
    const yesterday = new Date(Date.parse(clock()) - DAY).toISOString();
    if (last > yesterday) return;
    try {
      say(dealId, {
        docId: '',
        read: folder,
        ...(shut.length ? { shut } : {}),
        ...(opened.length ? { opened } : {}),
      });
    } catch { /* A refused note can wait for the next look; other folders may need indexing now. */ }
  }
  /**
   * Whether this PC's word index has been started for the deal under the current version. Without it (an index file of
   * an older version, or none) an unchanged folder is read again, which writes it (#1023).
   */
  const indexBuilt = (dealId: string) => !o.index || o.index.built(dealId);
  /**
   * Has anything changed in the folders this PC has indexed for a deal since a run last read them? Each folder is
   * listed (names, sizes and dates; nothing is opened) and the listing compared with the last run's. A folder that changed,
   * or whose last run did not finish, is indexed again, and the run decides what is new, changed or gone, as it always does.
   * A folder that cannot be listed whole, or reads as empty, is not reachable now: nothing is started or said for it.
   * 'unknown' for a deal this PC was never asked to index (indexing it is a person's to start); 'running' when a run is under way.
   */
  async function lookAgain(dealId: string, quietUntil?: number): Promise<Result<'same' | 'running' | 'unknown'>> {
    const kept = stoppedAt[dealId]; if (!kept || !Object.keys(kept).length) return ok('unknown');
    if (busy(dealId)) return ok('running');
    const on = new Set(await o.folders(dealId)); const again: DealFolder[] = [];
    for (const [p, f] of Object.entries(kept)) {
      if (!on.has(p)) continue;                                            // taken off the deal: never read again
      const at = localOf(dealId, p); if (!isDir(at)) continue;
      // a folder inside it that this person may not open is left out, as the run left it out, so the listing compares
      const failed: string[] = []; const closed: string[] = []; const files = await walkQuietly(at, failed, closed); if (failed.length || !files.length) continue;
      // read again too when the folders another PC said it may not open that this PC can are not the ones it last said (one
      // to take in, or one its copy no longer holds), and
      // when the folders this PC may not open are not the ones it last said (it lost access to one, or one was renamed)
      const mine = closed.map((d) => path.relative(at, d).split(path.sep).join('/')); const had = both(dealId).shuts.get(p)?.get(o.installId);
      const opened = openedHere(dealId, p, at, mine); const vouched = had?.opened ?? [];
      const unchanged = printed[dealId]?.[p] === listingPrint(files)
        && sameList([...mine].sort(), [...(had?.shut ?? [])].sort()) && sameList(opened, [...vouched].sort());
      if (f.finished && indexBuilt(dealId) && unchanged) {
        noteUnchangedRead(dealId, p, mine, opened);
        continue;
      }
      // something changed: it is read only once the folder has stopped changing, so a file still being copied in is left for the next look
      await new Promise((r) => setTimeout(r, o.settleMs ?? 2000));
      const fail2: string[] = []; const twice = await walkQuietly(at, fail2, []); if (fail2.length || listingPrint(twice) !== listingPrint(files)) continue;
      const { finished: _f, ...folder } = f; again.push(folder);
    }
    if (!again.length) return ok(busy(dealId) ? 'running' : 'same');
    if (busy(dealId)) return ok('running');                                // a person started a run during the wait: it reads these folders too
    const r = await service.index(dealId, again); if (!r.ok) return r;
    const j = jobs.get(dealId); if (j && !j.done) { j.again = true; if (quietUntil !== undefined) j.quietUntil = quietUntil; }   // the run just started (nothing awaits between the check above and its start)
    return ok('running');
  }
  /**
   * The files attached on a deal that has since been deleted on another PC become its recovered copy's too, so what was
   * attached there still opens and sends from the copy (#117). The file stays where it was saved in the shared folder;
   * only its line is written again, under the copy. A document the copy already has is left as it is when its file
   * can be sent from here. What was written and what still cannot be sent are told (#744): a deal whose lines have not
   * synced here yet counts as one unresolved file, so the caller tries again.
   */
  async function carryAttached(fromDealId: string, toDealId: string): Promise<{ written: number; unresolved: number }> {
    const source = records(fromDealId);
    if (!source.size) return { written: 0, unresolved: 1 };
    const attached = [...source.values()].filter((d) => [d, ...(d.copies ?? [])].some((p) => p.folder === ATTACHED));
    const sendable = new Set(await sendableAmong(toDealId, attached.map((d) => d.docId)));
    const have = all(toDealId);
    let written = 0;
    for (const d of attached) {
      // a known document is left alone unless its file is not sendable and the copy lacks the attached place
      const known = have.get(d.docId);
      const placed = [known, ...(known?.copies ?? [])].some((p) => p?.folder === ATTACHED);
      if (sendable.has(d.docId) || (known?.name && placed)) continue;
      const place = [d, ...(d.copies ?? [])].find((p) => p.folder === ATTACHED)!;
      const line = { docId: d.docId, hash: d.hash, name: place.name, folder: ATTACHED, rel: place.rel, size: d.size };
      // what is known of the file goes with it, so the copy need not read it again
      for (const key of ['pages', 'via', 'tracked', 'words'] as const) {
        if (d[key] !== undefined) Object.assign(line, { [key]: d[key] });
      }
      say(toDealId, line);
      written++;
    }
    // nothing written: the first check still stands, so the files are not checked again
    const ids = attached.map((d) => d.docId);
    const unresolved = written ? (await unsendable(toDealId, ids)).length : ids.length - sendable.size;
    return { written, unresolved };
  }
  /** Of these documents of a deal, those whose file this PC can send now. */
  async function sendableAmong(dealId: string, docIds: string[]): Promise<string[]> {
    const left = new Set(await unsendable(dealId, docIds));
    return docIds.filter((id) => !left.has(id));
  }
  /** Of these documents of a deal, those whose file this PC cannot send now: gone, or not synced here yet (#671). */
  async function unsendable(dealId: string, docIds: string[]): Promise<string[]> {
    const found = new Set((await wanted(dealId, docIds)).map((w) => w.docId));
    return docIds.filter((id) => !found.has(id));
  }
  const service: DocumentService = {
    scanFolder: safe(async (p) => {
      if (!isDir(p)) return fail({ kind: 'notFound', message: `${p} could not be opened` });
      listed.delete(p); const files = listing(p); return ok({ files: files.length, size: size(files.reduce((a, f) => a + f.size, 0)) });
    }),
    index: safe(async (dealId, folders) => {
      // That this PC was asked to index these folders is remembered before anything is checked: if the start is refused now
      // (the data room cannot be reached), the deal is still one this PC has to index, and it says so after a restart.
      // A folder asked for again is no longer finished, whatever an earlier run made of it; one left part-way keeps where it had got to.
      for (const f of folders) { const was = stoppedAt[dealId]?.[f.path]; if (!was || was.finished) (stoppedAt[dealId] ??= {})[f.path] = { ...f, indexed: 0, reviewed: 0 }; }
      saveStopped();
      for (const f of folders) if (!isDir(localOf(dealId, f.path))) return fail({ kind: 'notFound', message: `${f.path} could not be opened on this PC` });
      all(dealId);                                                          // if the shared folder cannot be read, say so now rather than part-way
      // One run per deal at a time. A start for folders the run under way already covers adds nothing. Any other start
      // waits for that run, and the starts that wait make one run between them, of every folder any of them asked for.
      const start = (list: DealFolder[]) => {
        const job: Job = { folders: list.map((f) => ({ ...f, indexed: 0, reviewed: 0 })), log: [`Indexing ${list.length} folder${list.length === 1 ? '' : 's'}`], done: false, run: Promise.resolve() };
        brokeWhy.delete(dealId);
        jobs.set(dealId, job); job.run = run(dealId, job).catch((e) => { if (jobs.get(dealId) === job) jobs.delete(dealId); if (e instanceof Broken) brokeWhy.set(dealId, e.message); });      // stopped part-way: nothing is running, and what is kept says where it stopped
      };
      const cur = jobs.get(dealId);
      if (!cur || cur.done) { start(folders); return ok(undefined); }
      if (folders.every((f) => cur.folders.some((c) => c.path === f.path))) return ok(undefined);
      let q = next.get(dealId);
      if (!q) { const mine = { folders: new Map<string, DealFolder>(), started: Promise.resolve() }; q = mine; next.set(dealId, mine); mine.started = cur.run.then(() => { next.delete(dealId); start([...mine.folders.values()]); }); }
      for (const f of folders) q.folders.set(f.path, f);
      await q.started; return ok(undefined);
    }),
    poll: safe(async (dealId): Promise<Result<{ folders: DealFolder[]; log: string[]; done: boolean; stopped?: boolean; why?: string; timing?: IndexTiming }>> => {
      // Every folder this PC has been asked to index for the deal, whichever run covered it: a run under way gives its own
      // live counts for its folders, and the rest are as they were left. The deal is done only when none is unfinished.
      const j = jobs.get(dealId); const kept = stoppedAt[dealId] ?? {}; const live = new Map((j && !j.done ? j.folders : []).map((f) => [f.path, f]));
      const folders = [...new Set([...Object.keys(kept), ...live.keys()])].map((p) => { const { finished: _f, ...f } = { ...kept[p], ...(live.get(p) ?? {}) } as DealFolder & { finished?: boolean }; return f; });
      if (j && !j.done) return ok({ folders, log: [...j.log], done: false });
      if (!folders.length) return ok({ folders: [], log: [], done: true });
      // a folder taken off the deal no longer holds it back: its part-way run is kept, for when it is put back
      let on: Set<string> | null = null; try { on = new Set(await o.folders(dealId)); } catch { /* not known: every folder counts */ }
      if (Object.entries(kept).some(([p, f]) => !f.finished && (!on || on.has(p)))) return ok({ folders, log: [], done: false, stopped: true, ...(brokeWhy.has(dealId) ? { why: brokeWhy.get(dealId) } : {}) });
      return ok({ folders, log: j ? [...j.log] : [], done: true, ...(j?.timing ? { timing: { ...j.timing } } : {}) });
    }),
    freshen: safe(async (dealId: string, opts?: { quietUntil?: number }) => {
      const quiet = typeof opts?.quietUntil === 'number' ? opts.quietUntil : undefined;
      const was = looking.get(dealId); if (was) return was;
      const p = lookAgain(dealId, quiet).finally(() => looking.delete(dealId)); looking.set(dealId, p); return p;
    }),
    page: safe(async (dealId, ref: DocumentRef, loc): Promise<Result<PageView>> => {
      const d = records(dealId).get(ref.docId);
      const at = d ? await locate(dealId, d) : null;
      if (!d || !at) return fail({ kind: 'notFound', message: `${ref.doc} could not be found in the deal’s folders` });
      // a spreadsheet is read from the data room as it is now, values as the file shows them
      if (!paged(d.name)) { try { return ok({ kind: 'sheet', name: ref.doc, ...sheetPart(await sheetsOf(at, true), loc) }); } catch { return fail({ kind: 'failed', message: `${ref.doc} could not be opened` }); } }
      let file: string; try { file = await pdfOf(dealId, d, at); } catch { return fail({ kind: 'notFound', message: d.via !== undefined && o.convert && o.convert.id !== d.via ? `${ref.doc} was indexed with a different converter than this PC has, so it can’t be shown here` : `${ref.doc} could not be converted to PDF on this PC, so it can’t be shown here` }); }
      if (file !== at) {                                                    // a converted copy stays only while it is among the last few opened
        const i = open.indexOf(d.docId); if (i >= 0) open.splice(i, 1); open.push(d.docId);
        while (open.length > KEPT_OPEN) { const old = open.shift() as string; discard(old); }
      }
      const m = /p\.\s*(\d+)/.exec(loc); return ok({ kind: 'pdf', url: urlFor(tokenFor(file)), page: m ? +m[1] : 1, ...(d.pages !== undefined ? { pages: d.pages } : {}) });
    }),
    attach: safe(async (dealId, file) => {
      const hash = hashBytes(file.bytes); const docId = docIdFor(hash);
      // a copy this PC can still find is reused; one it only remembers (deleted or moved since) is saved again (#34)
      let sent = await wanted(dealId, [docId]);
      if (!sent.length) {
        // each copy of the app writes under its own name, so two PCs never write the same file; the file is named by its
        // document's id, since a name of any length would not fit beside it (the name it was attached under is in its record)
        const rel = `${dealId}/${o.installId}/${docId}${shortExt(file.name)}`; const at = path.join(attachments, rel);
        fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, file.bytes);
        let pages: number | undefined; let via: string | undefined; let tracked: number | undefined; let words: string[] | undefined;
        if (paged(file.name)) {
          try {
            const read = await readAsPdf(dealId, { docId, name: file.name }, at);
            if (read.converted) ({ via, tracked } = convertedBy(read.converted, tracked));
            pages = read.pages;
            words = read.words;
          }
          catch { fs.rmSync(at, { force: true }); return fail({ kind: 'rejected', message: `${file.name} could not be ${PDF.test(file.name) ? 'opened' : 'converted to PDF'}, so it was not attached` }); }
        }
        else words = await sheetWords(at, dealId, docId);
        say(dealId, { docId, hash, name: file.name, folder: ATTACHED, rel, size: file.bytes.length, ...(pages !== undefined ? { pages } : {}), ...(via !== undefined ? { via } : {}), ...(tracked !== undefined ? { tracked } : {}), ...(words !== undefined ? { words } : {}) });
      }
      const unloaded = `${file.name} could not be loaded`;
      try {
        if (!sent.length) sent = await wanted(dealId, [docId]);
        if (!sent.length) return fail({ kind: 'failed', message: unloaded });             // nothing to send (#34)
        await o.keeper.ensure(sent);
      } catch (e) { return fail({ kind: 'failed', message: (e as Error).message || unloaded }); }
      return ok({ doc: known(dealId, docId)?.name ?? file.name, docId });
    }),
    carryAttached: safe(async (fromDealId, toDealId) => ok(await carryAttached(fromDealId, toDealId))),
    unsendable: safe(async (dealId, docIds) => ok(await unsendable(dealId, docIds))),
    cached: safe(async () => ok(o.keeper.loaded())),
    drafts: safe(async (dealId, docId) => {
      const all = [...records(dealId).values()]; const fam = families(all.map((r) => ({ docId: r.docId, path: roomPath(r), ...(r.seen ? { seen: r.seen } : {}) }))).find((f) => f.drafts.some((d) => d.docId === docId));
      if (!fam) return ok([]);
      const at = new Map(all.map((r) => [r.docId, r]));
      return ok(fam.drafts.map((d) => { const r = at.get(d.docId)!; return { doc: r.name, docId: d.docId, date: d.date, folder: path.posix.dirname(roomPath(r).replace(/\\/g, '/')) }; }));
    }),
    /**
     * Is the data room in these folders one a deal already has? Each of `dealIds` whose every data-room document
     * matches one of the folders' files by name and size, with the smallest match identical by content (sameRoom.ts).
     * Files in a precedents folder, on either side, and documents only attached in the app are not counted. Only those
     * deals come back, best first. Nothing is recorded and no model is asked.
     */
    sameRoom: safe(async (paths: string[], dealIds: string[]): Promise<Result<RoomMatch[]>> => {
      // the folders' files as the New deal form listed them, each with its path from the folder's own name
      const withRoom = (p: string) => listing(p).map((f) => ({ ...f, room: roomPath({ folder: p, rel: f.rel }) }));
      const listed = paths.filter(isDir).flatMap(withRoom);
      const files = countedFiles(listed);
      if (!files.length) return ok([]);
      const out: RoomMatch[] = [];
      for (const dealId of dealIds) {
        const recs = [...records(dealId).values()].filter(onDeal(dealId));
        const match = sameRoomAs(dealId, files, recs, (f) => hashOf(f.abs, f));
        if (match) out.push(match);
      }
      saveHashes(true);
      return ok(out.sort((a, b) => b.matched - a.matched));
    }),
    places: safe(async (dealId, docId) => {
      const r = records(dealId).get(docId); if (!r) return ok([]);
      return ok([r, ...(r.copies ?? [])].map((p) => ({ folder: path.posix.dirname(roomPath(p).replace(/\\/g, '/')), name: p.name })));
    }),
    findFolders: safe(async (dealIds) => {
      const known = rulesHere(); const home = o.home ?? os.homedir(); const missing: MissingFolder[] = []; const empty: MissingFolder[] = []; let placed = 0;
      for (const dealId of dealIds) for (const folder of await o.folders(dealId)) {
        // a folder that reads as empty is looked for elsewhere as a missing one is, and else said apart: it is there, with nothing in it
        const local = localOf(dealId, folder); if (here(dealId, folder, local)) continue;
        const tries = [...candidates(folder, known), profileCandidate(folder, home)].filter((c): c is string => !!c);
        const at = tries.find((c) => same(dealId, folder, c, false));
        if (at) { places = { ...places, [dealId]: { ...places[dealId], [folder]: at } }; placed++; } else (isDir(local) ? empty : missing).push({ dealId, folder });
      }
      if (placed) savePlaces();
      return ok({ placed, missing: missing.length, tops: topsOf([...missing, ...empty]), ...(empty.length ? { empty } : {}) });
    }),
    locateTop: safe(async (dealIds, top, picked) => {
      if (!isDir(picked)) return fail({ kind: 'notFound', message: `${picked} could not be opened` });
      const find = async (at: string) => {
        const taught = ruleFrom(top, at); const out: FolderPlace[] = [];
        for (const dealId of dealIds) for (const folder of await o.folders(dealId)) {
          if (here(dealId, folder, localOf(dealId, folder))) continue;
          const tries = [rewrite(folder, top, at), taught && rewrite(folder, taught.from, taught.to)].filter((c): c is string => !!c);
          const hit = tries.find((c) => same(dealId, folder, c, true));
          if (hit) out.push({ dealId, folder, local: hit });
        }
        return out;
      };
      // nothing in the folder picked: it may be one above the top folder, so look there too before saying nothing is in it
      for (const at of [picked, ...deeper(top, picked).filter(isDir)]) { const out = await find(at); if (out.length) return ok(out); }
      return ok([]);
    }),
    placeFolders: safe(async (list) => {
      let saved = 0;
      for (const p of list) {
        if (!(await o.folders(p.dealId)).includes(p.folder) || !same(p.dealId, p.folder, p.local, true)) continue;   // gone from the deal, or no longer there, since it was found
        places = { ...places, [p.dealId]: { ...places[p.dealId], [p.folder]: p.local } }; saved++;
        const r = ruleFrom(p.folder, p.local); if (r) rules = [...rules.filter((x) => key(x.from) !== key(r.from)), r];
      }
      if (saved) { savePlaces(); o.local.write('folder-rules.json', JSON.stringify(rules)); }
      return ok(saved);
    }),
  };
  /** the rules kept here, and those the places already set on this PC teach */
  function rulesHere(): Rule[] {
    const all = [...rules]; for (const [, byFolder] of Object.entries(places)) for (const [folder, local] of Object.entries(byFolder)) { const r = ruleFrom(folder, local); if (r && !all.some((x) => key(x.from) === key(r.from) && key(x.to) === key(r.to))) all.push(r); }
    return all;
  }
  /**
   * Whether `candidate` on this PC is the deal's `folder`: it opens, and the documents checked by content are the same. Taken
   * without a person (`shown` false), every document recorded there must be there too at the same place and size (a stat
   * each, so an older copy missing a few is not taken); a folder a person points at may have changed since it was read, and
   * is read again here once used. A folder with nothing recorded yet has nothing to check against: it counts only where a person will look at it.
   */
  function same(dealId: string, folder: string, candidate: string, shown: boolean): boolean {
    if (!here(dealId, folder, candidate)) return false;                     // an empty folder is never a data room documents were read from, even one a person points at
    if (!shown) for (const d of records(dealId).values()) {
      if (d.folder !== folder) continue;
      try { if (fs.statSync(path.join(candidate, d.rel)).size !== d.size) return false; } catch { return false; }
    }
    const m = compare(dealId, folder, candidate);
    return m.checked > 0 ? m.matched === m.checked : shown;
  }
  return Object.assign(service, {
    /** every document known in a deal */
    records: (dealId: string) => [...records(dealId).values()].filter(onDeal(dealId)),
    wanted,
    /** Keep what the model said a document is. Written once: a document that already has a summary keeps it. */
    describe: (dealId: string, docId: string, r: Review) => { const d = known(dealId, docId); if (d && d.summary === undefined) say(dealId, { docId, summary: r.summary, keywords: r.keywords }); },
    /** Note that the model was asked what a document is and gave nothing usable: one more try, counted on every PC. Nothing for a document that has a summary. */
    undescribed: (dealId: string, docId: string) => { const d = known(dealId, docId); if (d && d.summary === undefined) say(dealId, { docId, tried: (d.undescribed?.tries ?? 0) + 1 }); },
    /**
     * Of these documents, which could not be sent, those that have not left the deal: at one of their places this PC
     * cannot tell (see `spot`), its folder or the file is locked or may not be opened, or it is back since. A check waits for them as it
     * waits for a dropped drive. Attachments are not looked at.
     */
    away: (dealId: string, docIds: string[]): string[] => {
      const docs = records(dealId); const lists: Lists = new Map();
      return docIds.filter((id) => {
        const d = docs.get(id); if (!d) return false;
        const now = [d, ...(d.copies ?? [])].filter((p) => p.folder !== ATTACHED).map((p) => spot(dealId, p, d.hash, lists));
        return now.some((x) => x !== 'left');                                // 'there' too: it came back since it could not be sent, and was not read
      });
    },
    /**
     * Of these documents, those that cannot be read on this PC because a folder they are in may not be opened by this person
     * by id, with that folder as a path from the deal's folder: those whose every place in the deal's folders is behind one.
     */
    shut: (dealId: string, docIds: string[]): Map<string, string> => {
      // only the folders on the way are listed (each once): no file is looked at or read, so the whole deal can be asked about
      const docs = records(dealId); const lists: Lists = new Map(); const out = new Map<string, string>();
      const names = (root: string, dir: string) => { if (!lists.has(dir)) { try { lists.set(dir, fs.readdirSync(dir)); } catch (e) { const code = (e as { code?: string })?.code ?? ''; lists.set(dir, code === 'ENOTDIR' ? 'file' : dir !== root && NO_ENTRY.includes(code) ? 'shut' : null); } } return lists.get(dir) ?? null; };
      /** the closed folder on the way to a place, from the deal's folder, or null if there is none */
      const closedOn = (p: { folder: string; rel: string }) => {
        const root = localOf(dealId, p.folder); let dir = root; const on: string[] = [];
        for (const part of p.rel.split('/').slice(0, -1)) { const ns = names(root, dir); if (ns === 'shut') return on.join('/'); if (!Array.isArray(ns) || !ns.includes(part)) return null; dir = path.join(dir, part); on.push(part); }
        return names(root, dir) === 'shut' ? on.join('/') : null;
      };
      for (const id of docIds) {
        const d = docs.get(id); if (!d) continue;
        const at = [d, ...(d.copies ?? [])].filter((p) => p.folder !== ATTACHED).map(closedOn);
        if (at.length && at.every((x) => x !== null)) out.set(id, at[0] as string);         // every place it has is behind a closed folder
      }
      return out;
    },
    /**
     * The folders inside the deal's folders that a PC could not open when it last read the deal folder, that no PC in
     * use took in at its latest reading (`opened`), and in which no document of the deal has been found: what is in them has
     * never been read, so no check of the deal is complete. A PC not heard from about the folder for
     * timings.folderIdle neither speaks for it nor counts it as closed. A PC whose reading is older than the folder, or whose copy does not hold
     * it, did not take it in.
     * Each is a path from its deal folder, with the deal folder's name first when the deal has more than one.
     * Read from what the PCs said alone: nothing is listed.
     */
    unread: (dealId: string): string[] => {
      const now = o.foldersNow?.(dealId); const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase(); const on = now ? new Set(now.map(norm)) : null;
      const places = [...records(dealId).values()].flatMap((d) => [d, ...(d.copies ?? [])]); const out = new Set<string>();
      const { shuts, reads } = both(dealId); const deals = [...shuts.keys()].filter((f) => !on || on.has(norm(f)));   // taken off the deal: left out
      const cutoff = new Date(Date.parse(clock()) - control.timings.folderIdle).toISOString();
      for (const folder of deals) {
        // only PCs in use count: one no longer used never looks again, so it could never take back a folder that was since renamed or removed
        const inUse = [...shuts.get(folder)!.entries()].filter(([pc]) => (reads.get(folder)?.get(pc) ?? '') >= cutoff).map(([, x]) => x);
        for (const rel of new Set(inUse.flatMap((x) => x.shut))) {
          if (inUse.some((x) => x.opened.includes(rel))) continue;               // a PC took it in, and recorded what is in it
          if (places.some((p) => p.folder === folder && p.rel.startsWith(`${rel}/`))) continue;
          out.add(deals.length > 1 ? `${path.basename(folder.replace(/[\\/]+$/, ''))}/${rel}` : rel);
        }
      }
      return [...out].sort();
    },
    /** resolves when the deal's indexing job, if there is one, has finished */
    settled: (dealId: string) => jobs.get(dealId)?.run ?? Promise.resolve(),
    /** whether the deal's folders are being indexed now, or a run is waiting to start */
    indexing: (dealId: string) => { const j = jobs.get(dealId); return (!!j && !j.done) || next.has(dealId); },
    changes: service_changes,
    /** the file a page URL's token stands for; null for a token this run did not give out */
    fileFor: (token: string): string | null => tokens.get(token) ?? null,
    /** each of the deal's folders: where it is on this PC, and whether it can be opened there */
    folders: async (dealId: string) => (await o.folders(dealId)).map((folder) => ({ folder, local: localOf(dealId, folder), found: isDir(localOf(dealId, folder)) })),
    /** how a folder on this PC compares with each folder the deal has, best match first */
    matchFolder: async (dealId: string, candidate: string): Promise<FolderMatch[]> =>
      (await o.folders(dealId)).map((folder) => compare(dealId, folder, candidate)).sort((a, b) => b.matched / (b.checked || 1) - a.matched / (a.checked || 1)),
    /**
     * Say where one of the deal's folders is on this PC. It is saved when every document checked is there; refused when
     * none is; and when only some are, or there is nothing to check against yet, saved only if `accept` is given, which
     * means a person looked at the numbers and said yes.
     */
    mapFolder: async (dealId: string, folder: string, local: string, accept = false): Promise<Result<FolderMatch & { saved: boolean }>> => {
      if (!isDir(local)) return fail({ kind: 'notFound', message: `${local} could not be opened` });
      if (!(await o.folders(dealId)).includes(folder)) return fail({ kind: 'notFound', message: `The deal has no folder ${folder}` });
      const m = compare(dealId, folder, local);
      if (m.checked > 0 && m.matched === 0) return fail({ kind: 'rejected', message: `None of the ${m.checked} documents checked are in ${local}. It is not the same folder.` });
      const sure = m.checked > 0 && m.matched === m.checked;
      if (!sure && !accept) return ok({ ...m, saved: false });
      places = { ...places, [dealId]: { ...places[dealId], [folder]: local } }; if (local === folder) delete places[dealId][folder];
      o.local.write('folders.json', JSON.stringify(places)); return ok({ ...m, saved: true });
    },
  });
}

