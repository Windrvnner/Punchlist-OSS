/**
 * Is this data room one a deal already has? Asked when a new deal is created with folders, before anything is
 * indexed, from the folders' listing the New deal form already made, so no file is read but one.
 *
 *   1. A file matches a deal's document when its file name (in any case, as Windows reads names) and its size are the
 *      same. Each document matches one file at most.
 *   2. A deal holds the same data room when every document of its data room matches one of the new folders' files,
 *      and the smallest matched file is identical to its document by SHA-256.
 *
 * A document attached in the app and in no deal folder is not part of the data room and is not counted.
 *
 * Files in a precedents folder (families.ts), on either side, are another project's and are not counted: a precedents
 * folder many deals read says nothing about which deal a data room is.
 *
 * A similar deal name never blocks (decisions: Deal names), and this only asks: the person chooses.
 */
import type { DocRecord } from './documents';
import { inPrecedents, ATTACHED } from './families';
import { otherProject } from './blacklines';
import type { RoomMatch } from '../ports';
export type { RoomMatch };

/** a new folder's file: `room` is its path from the folder's own name, as `roomPath` gives a document's */
export interface RoomFile { room: string; size: number }

/** a file name and size as the match compares them */
const nameAndSize = (name: string, size: number) => `${name.toLowerCase()}|${size}`;
const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? '';

/** the new folders' files that are counted: every one outside a precedents folder */
export const countedFiles = <T extends RoomFile>(files: T[]) => files.filter((file) => !inPrecedents(file.room));

/** whether a document's only places are files attached in the app: it is in no data-room folder */
const onlyAttached = (rec: DocRecord) => [rec, ...(rec.copies ?? [])].every((place) => place.folder === ATTACHED);

/** which files a deal's documents match, by name and size; each document matches one file at most */
export function matchesIn<T extends RoomFile>(files: T[], recs: DocRecord[]): { file: T; rec: DocRecord }[] {
  const byKey = new Map<string, DocRecord[]>();
  for (const rec of recs) {
    const names = new Set([rec.name, ...(rec.copies ?? []).map((copy) => copy.name)]);
    for (const name of names) {
      const key = nameAndSize(name, rec.size);
      byKey.set(key, [...(byKey.get(key) ?? []), rec]);
    }
  }
  const used = new Set<DocRecord>();
  const out: { file: T; rec: DocRecord }[] = [];
  for (const file of files) {
    const rec = byKey.get(nameAndSize(fileName(file.room), file.size))?.find((r) => !used.has(r));
    if (!rec) continue;
    used.add(rec);
    out.push({ file, rec });
  }
  return out;
}

/**
 * The deal's match when it holds the same data room: every document of its data room matches one of `files`, and
 * the smallest matched file is identical. `hashOf` gives a file's SHA-256, or null when it cannot be read.
 */
export function sameRoomAs<T extends RoomFile>(
  dealId: string, files: T[], recs: DocRecord[], hashOf: (file: T) => string | null,
): RoomMatch | null {
  const own = recs.filter((r) => !otherProject(r) && !inPrecedents(r.rel) && !onlyAttached(r));
  const matched = matchesIn(files, own);
  if (!own.length || matched.length !== own.length) return null;
  const smallest = matched.reduce((least, m) => (m.file.size < least.file.size ? m : least));
  return hashOf(smallest.file) === smallest.rec.hash ? { dealId, files: files.length, matched: matched.length } : null;
}
