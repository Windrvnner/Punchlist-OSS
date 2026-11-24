import { KEPT_TEXT_KEY, type LocalStore } from '../ports';
import { checklistDrafts } from './checklistDrafts';

/**
 * Text typed into a form that is not a record yet (the composer and ask box, a new finding, a finding's edit, a closing
 * note, a question asked from the Checklist, the New deal form) lives in a map in memory, per thing it belongs to, so
 * it survives moving to another page or item. Closing the app, a reload or a crash would still throw it away. Each such
 * map is made here and kept through the local store as it changes: shortly after each change, when the window is
 * hidden, and as the page goes. The next start reads the maps back, so each form comes back as it was left. Storage is
 * overwritten with the maps as they stand, never cleared at start, so drafts brought back survive a second crash too.
 * The desktop app runs one window at a time (main.ts), so one window's maps are the whole of it.
 *
 * What is read back is checked entry by entry, and anything not of the map's shape is dropped, so an unreadable or old
 * entry costs that entry only. Edit fields keep the text they could not save in one of these maps too (editField.tsx).
 */
const SAVE_AFTER_MS = 400;
let local: LocalStore | undefined;
let left: Record<string, unknown> = {};
const maps = new Map<string, Map<string, unknown>>();
export let keptChecklistQuestions: ReturnType<typeof checklistDrafts>;

/** Read what the app left once, before the shell loads any screen that makes a draft map. */
export function initializeKeptText(storage: LocalStore) {
  if (local) throw new Error('Kept text is already initialized.');
  try {
    const saved = storage.read(KEPT_TEXT_KEY);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) left = saved as Record<string, unknown>;
  } catch { /* unreadable: nothing to bring back */ }
  local = storage;
  keptChecklistQuestions = checklistDrafts({
    texts: keptDrafts('checklist-ask', isText),
    targets: keptDrafts('checklist-ask-on', isText),
    movedId: moveKey,
  });
}

/**
 * Write the current maps and retain those a screen has yet to make. An empty snapshot clears the saved drafts.
 * The shell flushes on page hide, and an edit field can flush again after capturing the latest text.
 */
export function saveKeptDrafts() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    const all: Record<string, unknown> = Object.create(null);
    for (const [name, saved] of Object.entries(left)) {
      if (!maps.has(name)) all[name] = saved;
    }
    for (const [name, map] of maps) {
      if (map.size) all[name] = [...map];
    }
    // An unsuccessful write leaves the live maps available for the next save.
    local?.write(KEPT_TEXT_KEY, Object.keys(all).length ? all : null);
  } catch { /* an unavailable storage implementation leaves the live maps intact too */ }
}
let timer: ReturnType<typeof setTimeout> | null = null;
const soon = () => { if (!timer) timer = setTimeout(saveKeptDrafts, SAVE_AFTER_MS); };

/** records whose ids changed (a deleted deal kept as a copy): old id → new, for each part of a key between colons */
const renamed = new Map<string, string>();
export const moveKey = (key: string) =>
  renamed.size ? key.split(':').map((part) => renamed.get(part) ?? part).join(':') : key;
let staleOf: (v: unknown) => unknown = (v) => v;

/** a map that asks for a save whenever it changes */
class KeptMap<V> extends Map<string, V> {
  override set(key: string, value: V) {
    const to = moveKey(key);
    super.set(to, to === key ? value : staleOf(value) as V);
    soon();
    return this;
  }
  override get(key: string) { return super.get(moveKey(key)); }
  override has(key: string) { return super.has(moveKey(key)); }
  override delete(key: string) {
    const had = super.delete(moveKey(key));
    if (had) soon();
    return had;
  }
  override clear() {
    super.clear();
    soon();
  }
}

/**
 * A named map holding what the app left at its last close. `valid` checks the shape of stored values.
 * The name must be unique and stay the same from build to build.
 */
export function keptDrafts<V>(name: string, valid: (value: unknown) => value is V): Map<string, V> {
  if (!local) throw new Error('Initialize kept text before making a draft map.');
  const map = new KeptMap<V>();
  const saved = left[name];
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && valid(entry[1])) {
        Map.prototype.set.call(map, entry[0], entry[1]);
      }
    }
  }
  maps.set(name, map);
  return map;
}

/**
 * Drafts follow a record's new IDs, including drafts that a form still showing the old record writes later.
 * `stale` marks each moved value so a field asks before writing the text over the new record.
 */
export function renameKept(ids: Record<string, string>, stale: (v: unknown) => unknown = (v) => v) {
  for (const [was, now] of Object.entries(ids)) renamed.set(was, now);
  staleOf = stale;
  // the map's own lookups would move the old key too: the plain ones reach it
  for (const map of maps.values()) {
    for (const [key, value] of [...map]) {
      const to = moveKey(key);
      if (to === key) continue;
      Map.prototype.delete.call(map, key);
      if (!Map.prototype.has.call(map, to)) map.set(key, value);
    }
  }
  keptChecklistQuestions.followCopy();
}

/** shape checks for the values the maps hold */
export const isText = (v: unknown): v is string => typeof v === 'string';
export const hasTexts = <K extends string>(...keys: K[]) => (v: unknown): v is Record<K, string> =>
  !!v && typeof v === 'object' && keys.every((k) => typeof (v as Record<string, unknown>)[k] === 'string');
