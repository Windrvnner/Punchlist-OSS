/**
 * Text typed into a form that is not a record yet (the composer and ask box, a new finding, a finding's edit, a closing
 * note, a question asked from the Checklist, the New deal form) lives in a map in memory, per thing it belongs to, so
 * it survives moving to another page or item. Closing the app, a reload or a crash would still throw it away. Each such
 * map is made here and kept in the window's local storage as it changes: shortly after each change, when the window is
 * hidden, and as the page goes. The next start reads the maps back, so each form comes back as it was left. Storage is
 * overwritten with the maps as they stand, never cleared at start, so drafts brought back survive a second crash too.
 * The desktop app runs one window at a time (main.ts), so one window's maps are the whole of it.
 *
 * What is read back is checked entry by entry, and anything not of the map's shape is dropped, so an unreadable or old
 * entry costs that entry only. Edit fields keep the text they could not save in one of these maps too (editField.tsx).
 */
const KEY = 'dil/1/kept-drafts';
const SAVE_AFTER_MS = 400;
const box = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/** what the app left at its last close, by map name, read once at start */
let left: Record<string, unknown> = {};
try {
  const raw = box()?.getItem(KEY);
  if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) left = o; }
} catch { /* unreadable: nothing to bring back */ }

const maps = new Map<string, Map<string, unknown>>();

/**
 * Writes every map as it stands; a map not made yet this session keeps what it left. Nothing to keep clears the key. Called
 * by itself after changes, and by a page-hide handler that has just put more in a map (editField.tsx).
 */
export function saveKeptDrafts() {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    const ls = box(); if (!ls) return;
    const all: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(left)) if (!maps.has(name)) all[name] = v;
    for (const [name, m] of maps) if (m.size) all[name] = [...m.entries()];
    if (Object.keys(all).length) ls.setItem(KEY, JSON.stringify(all)); else ls.removeItem(KEY);
  } catch { /* storage full or unavailable: the drafts stay in memory */ }
}
let timer: ReturnType<typeof setTimeout> | null = null;
const soon = () => { if (!timer) timer = setTimeout(saveKeptDrafts, SAVE_AFTER_MS); };

/** records whose ids changed (a deleted deal kept as a copy): old id → new, for each part of a key between colons */
const renamed = new Map<string, string>();
const moveKey = (k: string) => (renamed.size ? k.split(':').map((part) => renamed.get(part) ?? part).join(':') : k);
let staleOf: (v: unknown) => unknown = (v) => v;

/** a map that asks for a save whenever it changes */
class KeptMap<V> extends Map<string, V> {
  constructor(private readonly movedValue: (value: V, ids: ReadonlyMap<string, string>) => V = (v) => staleOf(v) as V) {
    super();
  }
  override set(k: string, v: V) {
    const to = moveKey(k);
    const value = to === k ? v : this.movedValue(v, renamed);
    super.set(to, value);
    soon();
    return this;
  }
  override get(k: string) { return super.get(moveKey(k)); }
  override has(k: string) { return super.has(moveKey(k)); }
  override delete(k: string) { const had = super.delete(moveKey(k)); if (had) soon(); return had; }
  override clear() { super.clear(); soon(); }
}

/**
 * A map of drafts named `name`, holding what the app left at its last close. `valid` says whether a stored value has the
 * map's shape. The name stays the same from build to build. Record references can follow a recovered deal.
 */
export function keptDrafts<V>(
  name: string, valid: (v: unknown) => v is V, movedValue?: (value: V, ids: ReadonlyMap<string, string>) => V,
): Map<string, V> {
  const m = new KeptMap<V>(movedValue);
  const saved = left[name];
  if (Array.isArray(saved)) for (const e of saved) if (Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && valid(e[1])) Map.prototype.set.call(m, e[0], e[1]);
  maps.set(name, m as Map<string, unknown>);
  return m;
}

/**
 * Drafts kept under ids that a record no longer has move to its new ones: those kept now, and any a form still showing the
 * old record puts later, as it goes. `stale` marks a moved value, so a field asks before its text goes over the new record.
 */
export function renameKept(ids: Record<string, string>, stale: (v: unknown) => unknown = (v) => v) {
  for (const [was, now] of Object.entries(ids)) renamed.set(was, now); staleOf = stale;
  // the map's own lookups would move the old key too: the plain ones reach it
  for (const m of maps.values()) for (const [k, v] of [...m]) { const to = moveKey(k); if (to === k) continue; Map.prototype.delete.call(m, k); if (!Map.prototype.has.call(m, to)) m.set(k, v); }
}

/** shape checks for the values the maps hold */
export const isText = (v: unknown): v is string => typeof v === 'string';
export const hasTexts = <K extends string>(...keys: K[]) => (v: unknown): v is Record<K, string> =>
  !!v && typeof v === 'object' && keys.every((k) => typeof (v as Record<string, unknown>)[k] === 'string');

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', saveKeptDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveKeptDrafts(); });
}
