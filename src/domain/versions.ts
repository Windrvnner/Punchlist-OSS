/**
 * Versions of one record written on different PCs without knowledge of each other.
 *
 * The rules here are what keep a clash small. They are pure, so the backend can run the same code:
 *   - a clash is judged per record, never per file, per transaction or per deal;
 *   - two versions that say the same thing are one version, however they came about;
 *   - nothing here picks a winner. A person does.
 */

/** Bookkeeping that differs between two writes of the same content: two people who make the same record on two PCs write it at different times. */
const BOOKKEEPING = new Set(['rev', 'updatedAt', 'createdAt']);

/** Key order must not matter: two PCs may build the same record with its fields in a different order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) { const x = (v as Record<string, unknown>)[k]; if (x !== undefined) out[k] = canonical(x); }
    return out;
  }
  return v;
}
/**
 * A checklist item's wording, where it came from, its section and subsection are bookkeeping too (linking design, section 5): two
 * people who add "Insurance is in place" and "insurance is in place" make one item, and one that came from two lists is
 * still one item. Turned off is the only thing a person sets on it.
 */
const ITEM_BOOKKEEPING = new Set(['text', 'from', 'section', 'subsection', 'normV', 'onBy']);
/**
 * A finding made from an issues list's point, while its title is still the one the model wrote: who brought
 * the list in, when, and the title the model gave it are bookkeeping. The same list imported on two PCs before either has
 * the other's makes the same finding twice, the same point in the same words; that is one version, not a choice for a
 * person. A person who rewrites the title clears `aiTitle`, so from then on the title counts.
 */
const IMPORTED_BOOKKEEPING = new Set(['raisedAt', 'raisedBy', 'title', 'aiTitle']);
/** and the workstream the model chose, until a person changes it (which clears `aiWorkstream`) */
const AI_WORKSTREAM = new Set(['workstream', 'aiWorkstream']);
/**
 * A list of the firm's says its items, in order (linking design, section 4). The name as typed (its key is in the id), the
 * file it came from and the file's date, and who brought it in and when are bookkeeping: the same items brought in on two
 * PCs, from "Storage.xlsx" and "Storage (1).xlsx", or named "Storage" and "storage", are one version.
 */
const LIST_BOOKKEEPING = new Set(['name', 'file', 'fileDate', 'by', 'at']);
const isList = (data: object) => typeof (data as { id?: unknown }).id === 'string' && /^l_[0-9a-f]{24}$/.test((data as { id: string }).id);
/**
 * When an issues list was brought in, and the name its file was saved under, are bookkeeping on its marks: the
 * list is its file's id. Two PCs that import the same file onto one finding make one version, whenever and under whatever name.
 */
const marksWithoutWhen = (marks: unknown) => (Array.isArray(marks) ? marks.map((m) => (m && typeof m === 'object' ? { ...m, at: undefined, ...((m as { doc?: unknown }).doc ? { list: undefined } : {}) } : m)) : marks);
const isItem = (data: object) => typeof (data as { id?: unknown }).id === 'string' && /^i_[0-9a-f]{24}$/.test((data as { id: string }).id);
const content = (data: unknown): string => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return JSON.stringify(canonical(data));
  const item = isItem(data); const list = isList(data); const imported = (data as { aiTitle?: unknown }).aiTitle === true; const aiWs = (data as { aiWorkstream?: unknown }).aiWorkstream === true;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (!BOOKKEEPING.has(k) && !(item && ITEM_BOOKKEEPING.has(k)) && !(list && LIST_BOOKKEEPING.has(k)) && !(imported && IMPORTED_BOOKKEEPING.has(k)) && !(aiWs && AI_WORKSTREAM.has(k))) rest[k] = k === 'onLists' ? marksWithoutWhen(v) : v;
  return JSON.stringify(canonical(rest));
};

/**
 * A short mark of a tombstone (FNV-1a over what the deletion says: who, when, and the record as it was), to tell later
 * whether it is still the same deletion. Only fields every build writes and reads back unchanged are taken.
 */
export function fingerprint(t0: unknown): string {
  const d = (t0 ?? {}) as Record<string, unknown>;
  let h = 0x811c9dc5; const t = content({ kind: d.kind, id: d.id, at: d.at, actor: d.actor, snapshot: d.snapshot });
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${t.length.toString(36)}.${h.toString(36)}`;
}

/** When a response's origin was stamped is bookkeeping: the same file imported on two PCs stamps it at two times. Who and where from still count. */
const withoutWhen = (p: unknown) => (p && typeof p === 'object' && !Array.isArray(p) ? { ...p, at: undefined } : p);
/** what a version says, as compared: its content, with when its response's origin was stamped left out */
const said = (data: unknown): string => content(data && typeof data === 'object' && !Array.isArray(data) && 'provenance' in data ? { ...data, provenance: withoutWhen((data as { provenance: unknown }).provenance) } : data);
/** A short mark of what a version of a record says (FNV-1a over what it says, as `sameContent` compares it): the same words make the same mark on every PC. */
export function contentMark(data: unknown): string {
  let h = 0x811c9dc5; const t = said(data);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${t.length.toString(36)}${h.toString(36)}`;
}

/** Do two versions of a record say the same thing? Their revision and time stamps are not part of what they say. */
export const sameContent = (a: unknown, b: unknown): boolean => said(a) === said(b);

/** The versions that really differ: each distinct content once, the earliest of each kept, in a fixed order every PC agrees on. */
export function distinctVersions<V extends { id: string; at: string; data: unknown }>(versions: V[]): V[] {
  const sorted = [...versions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const seen = new Set<string>(); const out: V[] = [];
  for (const v of sorted) { const c = said(v.data); if (seen.has(c)) continue; seen.add(c); out.push(v); }
  return out;
}

/** Which of the named fields differ between the versions, in the order given. */
export function differingFields(versions: (Record<string, unknown> | null)[], fields: readonly string[]): string[] {
  const readable = versions.filter((v): v is Record<string, unknown> => !!v);
  if (readable.length < 2) return [];
  return fields.filter((f) => new Set(readable.map((v) => JSON.stringify(canonical(v[f] ?? null)))).size > 1);
}
