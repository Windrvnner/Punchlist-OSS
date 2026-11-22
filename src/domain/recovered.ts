/**
 * A deal deleted on another PC while this PC had changes to it that the deleting PC had not seen is kept here as a new
 * deal, "<name> (recovered)", holding everything this PC had of it. This is the copy itself, worked
 * out from what this PC holds: the storage writes it (backend/logRepository.ts, `recover`).
 *
 * Every record gets a new id, made from the copy's id and the old one, so the same copy made twice is the same records.
 * Every reference to an old id inside a record (a question's finding, a finding's checklist item, a deleted record's
 * snapshot) is changed to the new one.
 */
import { derivedId } from './derivedId';
import { itemId } from './checklist';
import { firstMember, Folder, type RecordKind } from './model';

/** the copy's id: one per deal and PC, so a PC never makes two copies of one deal and two PCs never make the same one */
export const recoveredId = (dealId: string, pc: string) => derivedId('d', ['recovered', dealId, pc]);

/** One record as this PC had it: each current version's data, or null for a version that is the record deleted. */
export interface Had { kind: RecordKind; id: string; versions: (unknown | null)[] }
/**
 * One record of the copy: its data, and any other versions that stand beside it as a choice, as they did on the deleted deal:
 * `alongside` other data, `deletedAlongside` a delete made without knowledge of an edit, so the choice stays a person's.
 */
export interface Copied { kind: RecordKind; id: string; data: unknown; alongside: unknown[]; deletedAlongside: boolean }

/** the kinds of record a deal's copy holds: its members are not copied (the copy is in the list of the person who keeps it) */
const COPIED: ReadonlySet<RecordKind> = new Set<RecordKind>(['question', 'finding', 'item', 'tombstone']);

/** every string in `value` that is an old id, changed to its new one: values, and keys (a Q&A log's cells sent, by question) */
export function remap<T>(value: T, ids: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return ids.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [ids.get(k) ?? k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * The copy of a deal: the deal record, the person's place on it, and its records, each under its new id. `deal` is the deal
 * as this PC last had it; `had` is everything filed under it. A record this PC had deleted is not copied (its Recently
 * deleted entry is, so it can still be restored); a record with versions nobody had chosen between keeps them all, a delete
 * beside an edit included. The deal
 * starts again as a new one with the same folders does (CreateDeal): its documents are indexed again under the copy.
 */
export function recoveredDeal(o: { dealId: string; copyId: string; deal: Record<string, unknown>; dealAlongside?: Record<string, unknown>[]; had: Had[]; name: string; person: string; at: string }): { deal: unknown; dealAlongside: unknown[]; member: unknown; records: Copied[]; ids: Map<string, string> } {
  const ids = recoveredIds(o.dealId, o.copyId, o.had);
  const kept = o.had.filter((h) => COPIED.has(h.kind));
  const records: Copied[] = [];
  for (const h of kept) {
    const id = ids.get(h.id); const [first, ...rest] = live(h).map((v) => remap(v, ids));
    if (!id || !first) continue;
    records.push({ kind: h.kind, id, data: first, alongside: rest, deletedAlongside: h.versions.some((v) => v === null) });
  }
  // the deal itself; versions of it nobody had chosen between stand beside it as a choice in the copy too
  const asCopy = (d: Record<string, unknown>) => {
    const folders = Array.isArray(d.folders) ? d.folders.flatMap((f) => { const p = Folder.safeParse(f); return p.success ? [{ ...p.data, indexed: 0, reviewed: 0 }] : []; }) : [];
    return remap({ ...d, id: o.copyId, rev: 0, createdAt: o.at, updatedAt: o.at, name: o.name, stage: folders.length ? 'indexing' : 'ready', folders,
      log: folders.length ? [`Indexing ${folders.length} folder${folders.length > 1 ? 's' : ''}`] : [] }, ids);
  };
  return { deal: asCopy(o.deal), dealAlongside: (o.dealAlongside ?? []).map((d) => asCopy({ ...d, name: o.deal.name })), member: firstMember(o.copyId, o.person, o.at), records, ids };
}

const live = (h: Had) => h.versions.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
/** Each record's id in the copy, by its id in the deleted deal (the deal's own included). The same whenever it is worked out. */
export function recoveredIds(dealId: string, copyId: string, had: Had[]): Map<string, string> {
  const ids = new Map<string, string>([[dealId, copyId]]);
  for (const h of had) {
    if (!COPIED.has(h.kind) || ids.has(h.id)) continue;
    const text = live(h).map((v) => v.text).find((t): t is string => typeof t === 'string' && !!t.trim());
    // an item's id is made from its deal and wording (itemId), as on any deal; anything else from the copy and its old id
    const next = h.kind === 'item' && text ? itemId(copyId, text) : /^[a-z]+_/.test(h.id) ? derivedId(h.id.slice(0, h.id.indexOf('_')), ['recovered', copyId, h.id]) : null;
    if (next) ids.set(h.id, next);
  }
  return ids;
}

/**
 * A change made on this PC to a record of the deleted deal after its copy holds that record (a field saved again as the copy
 * was made): only the fields it changed from the record as this PC had it, laid over the copy's record as it is now.
 */
export function changedOnto(had: unknown, wrote: unknown, now: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (!now || typeof now !== 'object' || !wrote || typeof wrote !== 'object') return remap(wrote, ids);
  return { ...(now as Record<string, unknown>), ...remap(changedValues(had, wrote), ids) };
}

/** The fields changed by a save on the original record, before its ids are remapped to the recovered copy. */
export function changedValues(had: unknown, wrote: unknown): Record<string, unknown> {
  const was = (had && typeof had === 'object' ? had : {}) as Record<string, unknown>;
  if (!wrote || typeof wrote !== 'object') return {};
  const changed = Object.entries(wrote).filter(([key, value]) =>
    !['id', 'rev', 'dealId', 'createdAt'].includes(key) && JSON.stringify(value) !== JSON.stringify(was[key]));
  return Object.fromEntries(changed);
}
