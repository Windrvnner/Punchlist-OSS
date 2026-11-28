import type { DealProgress } from '../ports';
import type { DocRecord } from './documents';

/** Count a document at its first place and its other indexed copies where they sit. */
export function documentProgress(
  records: DocRecord[], read: ReadonlySet<string>, core: string[],
): DealProgress['folders'] {
  const folders = new Map<string, DealProgress['folders'][number]>();
  const coreIds = new Set(core);
  const entry = (folder: string): DealProgress['folders'][number] => {
    const found = folders.get(folder);
    if (found) return found;
    const added = { folder, files: 0, read: 0, core: 0, coreRead: 0 };
    folders.set(folder, added);
    return added;
  };
  for (const record of records) {
    const folder = entry(record.folder);
    const opened = read.has(record.docId);
    folder.files++;
    if (opened) folder.read++;
    if (coreIds.has(record.docId)) {
      folder.core++;
      if (opened) folder.coreRead++;
    }
    for (const copy of record.copies ?? []) {
      const place = entry(copy.folder);
      place.copies = (place.copies ?? 0) + 1;
    }
  }
  return [...folders.values()];
}
