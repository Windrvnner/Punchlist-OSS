/**
 * A PC's own append-only file in the shared folder (its notes on a deal's documents, its check log), kept whole.
 *
 * Every line goes to a copy on this PC first and to the shared folder second, so a line in the shared file is always in
 * the local copy too. When the sync client loses lines from the shared copy (it puts back an older copy, say), they are put
 * back from the local one; this is checked whenever the file is about to be read or written, and costs a size check while
 * the two agree. The change files (`logRepository.ts`) and conversations (`conversationLog.ts`) are kept the same way.
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
export function appendOwn(shared: Pick<Folder, 'append'> & Partial<Pick<Folder, 'read' | 'write'>>, local: Folder | undefined, name: string, text: string, keep = false): unknown {
  if (!local) { shared.append(name, text); return; }
  appendLocal(local, name, text);
  if (!keep) { shareOwn(shared, local, name, text); return; }
  try { shared.append(name, text); } catch (e) { return e; }
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
function appendLocal(local: Folder, name: string, text: string) {
  mendLocal(local, name);
  const before = sizeBefore(local, name);
  try { local.append(name, text); }
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
  try {
    const text = local.read(name) ?? '';
    if (!text.endsWith('\n') && text) local.write(name, text.slice(0, text.lastIndexOf('\n') + 1));
    checkedEnds.set(local, checked.add(name));
  } catch { /* a file held for a moment: the append goes ahead, and the end is checked at the next one */ }
}

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
export function shareOwn(shared: Pick<Folder, 'append'> & Partial<Pick<Folder, 'read'>>, local: Folder, name: string, text: string, landed = false) {
  try { shared.append(name, text); }
  catch (e) {
    if (landed) { let there: string | null = null; try { there = shared.read?.(name) ?? null; } catch { /* not known: treated as not written */ } if (there?.endsWith(text)) return; }
    // not shared: taken back out of the local copy, or it would be put back later as something the person was told had failed
    try { const mine = local.read(name) ?? ''; if (mine.endsWith(text)) local.write(name, mine.slice(0, mine.length - text.length)); } catch { /* the next heal compares the two */ }
    throw e;
  }
}

/**
 * Put back into the shared copy any line of this PC's own file that the local copy has and the shared copy has lost.
 * Only a size that differs is looked into, unless `whole` asks for the two to be compared anyway. With `endTorn`, a last
 * line in the shared copy with no line end is ended: only this PC writes the file, so it is part of a write that failed,
 * and the next line must not be glued onto it.
 */
export function healOwn(
  shared: Pick<Folder, 'append' | 'read' | 'size'>, local: Folder | undefined,
  name: string, how: { whole?: boolean; endTorn?: boolean } = {},
) {
  if (!local) return;
  try {
    takeBackFailed(local, name);                                     // a failed append is never shared
    if (!how.whole) { const here = local.size(name); if (here < 0 || shared.size(name) === here) return; }
    const text = shared.read(name) ?? '';
    const lead = how.endTorn && text && !text.endsWith('\n') ? '\n' : '';
    const mine = wholeLines(local.read(name) ?? '');           // a last line with no end is what a failed write left
    const there = new Set(text.split('\n').filter(Boolean));
    const lost = mine.filter((l) => !there.has(l)); if (lost.length || lead) shared.append(name, lead + (lost.length ? lost.join('\n') + '\n' : ''));
  } catch { /* tried again at the next read or write */ }
}
