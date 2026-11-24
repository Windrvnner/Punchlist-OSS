/**
 * A PC's own append-only file in the shared folder (its notes on a deal's documents, its check log), kept whole.
 *
 * Every line goes to a copy on this PC first and to the shared folder second, so a line in the shared file is always in
 * the local copy too. When the sync client loses lines from the shared copy (it puts back an older copy, say), they are put
 * back from the local one. Changed copies are compared by line, including when their sizes agree.
 * The change files (`logRepository.ts`) and conversations (`conversationLog.ts`) are kept the same way.
 */
import type { Folder } from './logRepository';

/**
 * The lines of `text` from `from` on that have their line end, without empty ones: a last line with none is still being
 * written or synced, or is what a failed write left, and is not there yet. Given `once`, a line whose key is already in it
 * is left out and the keys of the others are added to it: a line in a file and in a conflict copy of it, or read again,
 * counts once. A set kept across reads should be given a `key` that is not the line itself (a hash): a line split from
 * a file's text can be a slice that holds the whole text, so a set of the lines would keep every read of the file whole
 *. This file is in the browser build too, so the hash comes from the caller.
 */
export function wholeLines(text: string, from = 0, once?: Set<string>, key: (line: string) => string = (l) => l): string[] {
  const lines = text.slice(from, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
  return once ? lines.filter((l) => { const k = key(l); if (once.has(k)) return false; once.add(k); return true; }) : lines;
}

/** Of `names`, a deal's files of one kind (`docs`, `checks`) from every PC, and any copy a sync client set aside in a conflict, whatever it was called: "-COMPUTER", " (1)", " - Copy"; sorted, so every PC reads them in one order. */
export const dealFiles = (names: string[], kind: string, dealId: string) => { const of = new RegExp(`^${kind}-.+-${dealId.replace(/[^A-Za-z0-9_]/g, '')}([- ][^/]*)?\\.jsonl$`); return names.filter((n) => of.test(n)).sort(); };

/**
 * Append one or more whole lines. Throws when either copy cannot be written; then neither copy has them.
 * With `keep`, lines the shared folder refuses stay in the local copy for `healOwn` to share later, and the shared
 * folder's error is returned rather than thrown; it still throws, with nothing written, when the local copy cannot be.
 */
export function appendOwn(
  shared: AppendCopy, local: StampedFolder | undefined, name: string, text: string, keep = false,
): unknown {
  if (!local) { shared.append(name, text); return; }
  const compared = comparedCopies.get(local);
  const previous = compared?.get(name);
  const before = previous?.shared === shared ? previous.stamp : undefined;
  const here = appendLocal(local, name, text, before?.here);
  let there: string | void;
  try {
    there = keep ? shared.append(name, text, before?.there) : shareOwn(shared, local, name, text, false, before?.there);
  } catch (error) {
    if (keep) return error;
    throw error;
  }
  if (previous && before && here !== undefined && there !== undefined) {
    compared?.set(name, { shared: previous.shared, stamp: { here, there } });
  }
}

/** Per local folder, the files whose last append failed and is not taken back yet: the size in bytes to cut each to. */
const failedAppends = new WeakMap<Folder, Map<string, number>>();
/** Per local folder, the files whose end has been checked in this run of the app. */
const checkedEnds = new WeakMap<Folder, Set<string>>();
/** `text` cut to its first `size` bytes of UTF-8. */
function firstBytes(text: string, size: number) {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, size));
}

/**
 * Append to the local copy, whole or not at all (#126). A write that fails part way may leave the start of the text;
 * it is cut off again, so the next line is not glued to it. When it cannot be cut off yet (the disk is still full),
 * no other line is added to that file until it has been.
 */
function appendLocal(local: StampedFolder, name: string, text: string, expected?: string) {
  mendLocal(local, name);
  const before = sizeBefore(local, name);
  try { return local.append(name, text, expected); }
  catch (error) {
    const failed = failedAppends.get(local) ?? new Map<string, number>();
    failedAppends.set(local, failed.set(name, before));
    try { takeBackFailed(local, name); } catch { /* cut off before the next append or heal of this file */ }
    throw error;
  }
}

/** The size in bytes to cut a failed append back to: -1 for a file there that can be neither measured nor read. */
function sizeBefore(local: Folder, name: string) {
  const size = local.size(name);
  if (size >= 0) return size;
  try {
    const text = local.read(name);
    return text === null ? 0 : new TextEncoder().encode(text).length;
  } catch { return -1; }
}

/** Make the local copy end where its last whole line ends. Throws when a failed append cannot be taken back. */
function mendLocal(local: Folder, name: string) {
  takeBackFailed(local, name);
  const checked = checkedEnds.get(local) ?? new Set<string>();
  if (checked.has(name)) return;
  // a run that stopped part way through an append (a crash, a power cut) may have left the start of a line
  let text: string;
  try { text = local.read(name) ?? ''; }
  catch { return; }                 // a file held for a moment: the append goes ahead, and its end is checked next time
  // a part line found here is cut off before anything is added, or nothing is (this throws when it cannot be cut)
  if (!text.endsWith('\n') && text) local.write(name, text.slice(0, text.lastIndexOf('\n') + 1));
  checkedEnds.set(local, checked.add(name));
}

/** Whether the local copy still holds part of a failed append that could not be taken back yet. */
export const holdsFailedAppend = (local: Folder, name: string) => failedAppends.get(local)?.has(name) ?? false;

/** The local copy's text without what a failed append not yet taken back left in it: only lines that were written. */
export function readOwn(local: Pick<Folder, 'read'>, name: string): string | null {
  const text = local.read(name);
  const size = failedAppends.get(local as Folder)?.get(name);
  return text === null || size === undefined ? text : beforeFailed(text, size);
}

/** `text` without a failed append that began at `size` bytes; -1 when the size was not known. */
function beforeFailed(text: string, size: number) {
  // not measured: only the start of a line is known to be the failed append's
  return size < 0 ? text.slice(0, text.lastIndexOf('\n') + 1) : firstBytes(text, size);
}

/** Cut a failed append back off the local copy: sizes are in bytes, as on a disk. Throws when it cannot. */
function takeBackFailed(local: Folder, name: string) {
  const size = failedAppends.get(local)?.get(name);
  if (size === undefined) return;
  const text = local.read(name) ?? '';
  const kept = beforeFailed(text, size);
  if (kept !== text) local.write(name, kept);
  failedAppends.get(local)?.delete(name);
}

/**
 * The second half of `appendOwn`, for a caller that tells a failed local write from a failed shared one: lines already in the
 * local copy are appended to the shared one. Throws when they cannot be; then they are taken back out of the local copy. With
 * `landed`, a write that fails after all of the text reached the shared copy (a drive that drops mid-write can) counts as written.
 */
export function shareOwn(
  shared: AppendCopy, local: Folder, name: string, text: string, landed = false, expected?: string,
) {
  try { return shared.append(name, text, expected); }
  catch (e) {
    if (landed) { let there: string | null = null; try { there = shared.read?.(name) ?? null; } catch { /* not known: treated as not written */ } if (there?.endsWith(text)) return; }
    // not shared: taken back out of the local copy, or it would be put back later as something the person was told had failed
    try { const mine = local.read(name) ?? ''; if (mine.endsWith(text)) local.write(name, mine.slice(0, mine.length - text.length)); } catch { /* the next heal compares the two */ }
    throw e;
  }
}

interface FileStamp {
  fileStamp?(name: string): string | undefined;
}

/** An append can advance a verified file stamp using the same open file it writes. */
type StampedAppend = { append(name: string, text: string, expected?: string): string | void };
export type StampedFolder = Omit<Folder, 'append'> & FileStamp & StampedAppend;
type AppendCopy = StampedAppend & Partial<Pick<Folder, 'read' | 'write'>>;
type SharedCopy = StampedAppend & Pick<Folder, 'read'> & FileStamp;
type CopyStamp = { here: string; there: string };
type ComparedCopy = { shared: SharedCopy; stamp: CopyStamp };
const comparedCopies = new WeakMap<Folder, Map<string, ComparedCopy>>();

/** After a comparison, use both file stamps to avoid reopening unchanged copies on each poll (#784). */
function copyStamp(shared: SharedCopy, local: Folder & FileStamp, name: string): CopyStamp | undefined {
  const here = local.fileStamp?.(name);
  const there = shared.fileStamp?.(name);
  if (here !== undefined && there !== undefined) return { here, there };
}

function sameStamp(stamp: CopyStamp, other: CopyStamp | undefined): boolean {
  return stamp.here === other?.here && stamp.there === other?.there;
}

function missingLines(localText: string, sharedText: string): string[] {
  if (sharedText === localText) return [];
  const shared = new Set(wholeLines(sharedText));
  return wholeLines(localText).filter((line) => !shared.has(line));
}

/**
 * Put back into the shared copy any line of this PC's own file that the local copy has and the shared copy has lost.
 * A torn shared line is marked incomplete before restoring missing lines. `endTorn` also marks it without a repair.
 * Return a refused local read so a caller reading the same copy can report it with its existing retry behavior.
 */
export function healOwn(
  shared: SharedCopy, local: (Folder & FileStamp) | undefined,
  name: string, how: { whole?: boolean; endTorn?: boolean } = {},
) {
  if (!local) return;
  try {
    takeBackFailed(local, name);
    const stamp = how.whole || how.endTorn ? undefined : copyStamp(shared, local, name);
    if (!how.whole && stamp === undefined && local.size(name) < 0) return;
    const checked = comparedCopies.get(local);
    const previous = checked?.get(name);
    if (stamp && previous?.shared === shared && sameStamp(stamp, previous.stamp)) return;

    const text = shared.read(name) ?? '';
    let localText: string | null;
    try {
      localText = local.read(name);
    } catch (error) {
      return { error };
    }
    const lost = missingLines(localText ?? '', text);
    const torn = text.length > 0 && !text.endsWith('\n');
    const localEnded = !localText || localText.endsWith('\n');
    if (lost.length || (torn && how.endTorn)) {
      const lead = torn ? ' (incomplete append)\n' : '';
      shared.append(name, lead + lost.map((line) => line + '\n').join(''));
    } else if (!torn && localEnded && stamp && sameStamp(stamp, copyStamp(shared, local, name))) {
      comparedCopies.set(local, (checked ?? new Map<string, ComparedCopy>()).set(name, { shared, stamp }));
    }
  } catch { /* tried again at the next read or write */ }
}
