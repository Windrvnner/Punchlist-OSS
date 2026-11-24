/**
 * An import in progress (the Q&A import, an issues list, the firm's checklist) is kept on this PC when its dialog closes,
 * the window reloads or the app restarts, so opening the import again picks it up where it was left: the file as read,
 * the columns chosen, the model's reading and review, and the check marks. It is kept until the import is done or
 * the person starts over on purpose.
 *
 * An import holds the file it read (up to 20 MB) and model replies, more than local storage holds beside the kept drafts
 * (keptText.ts), so it lives in the window's IndexedDB, which the desktop app keeps in its own folder on the PC. Each
 * import is kept as named parts, and a change writes only the parts that changed (the file once, a check as a check), all
 * in one transaction, so what is stored is always one whole state of the dialog. Writes go out as soon as the change is
 * made rather than after a pause, so a reload straight after a check mark keeps it.
 *
 * Without IndexedDB (the unit tests, a blocked store) an import is still kept in memory while the window is open.
 */
import { useEffect, useErrorBoundary, useRef, useState } from 'preact/hooks';

type Parts = Record<string, unknown>;

const DB = 'dil-kept-imports'; const STORE = 'parts';
/** the shape of what is kept: a store from another shape is not read */
const SHAPE = 1;

const mem = new Map<string, Parts>();
type Op = { key: string; drop: true } | { key: string; part: string; value: unknown };
let queue: Op[] = [];
let db: IDBDatabase | null = null; let loaded = false;
/** imports kept or dropped in this window before the stored ones were read: what is stored for them is older */
const touched = new Set<string>();

const idb = (): IDBFactory | null => { try { return typeof indexedDB === 'undefined' ? null : indexedDB; } catch { return null; } };
const range = (key: string) => IDBKeyRange.bound([key], [key, []]);   // every part of one import: an array sorts after any string

/** Resolves once what the app left at its last close has been read (at once without IndexedDB). Never rejects. */
export const keptImportsReady: Promise<void> = new Promise<void>((ended) => {
  const done = () => { loaded = true; touched.clear(); ended(); };
  const f = idb(); if (!f) { done(); return; }
  let req: IDBOpenDBRequest;
  try { req = f.open(DB, SHAPE); } catch { done(); return; }
  req.onupgradeneeded = () => { const d = req.result; for (const n of [...d.objectStoreNames]) d.deleteObjectStore(n); d.createObjectStore(STORE); };
  req.onerror = () => done(); req.onblocked = () => done();
  req.onsuccess = () => {
    // a store that opens only after the app went on without it (blocked by another window) is written to, not read:
    // what it holds is older than what this window has kept since
    if (loaded) {
      db = req.result;
      try {   // what is in memory is the whole of it: the store is cleared and written from it
        const tx = db.transaction(STORE, 'readwrite'); const os = tx.objectStore(STORE); os.clear();
        for (const [key, parts] of mem) for (const [part, value] of Object.entries(parts)) os.put(value, [key, part]);
        tx.onabort = () => { for (const key of mem.keys()) whole.add(key); }; tx.commit?.();
      } catch { /* kept in memory for this window */ }
      queue = []; return;
    }
    db = req.result;
    try {
      const all = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      all.onsuccess = () => {
        const c = all.result; if (!c) { done(); flush(); return; }
        const k = c.key as unknown;
        if (Array.isArray(k) && typeof k[0] === 'string' && typeof k[1] === 'string' && !touched.has(k[0])) {
          const parts = mem.get(k[0]) ?? {}; parts[k[1]] = c.value; mem.set(k[0], parts);
        }
        c.continue();
      };
      all.onerror = () => done();
    } catch { done(); }
  };
});

/**
 * Writes what is waiting in one transaction, and asks for it to be committed at once. Transactions on one store run in the
 * order they were made, so a later write never lands under an earlier one. A failed write leaves the import kept in memory.
 */
function flush(): Promise<boolean> {
  if (!db || (!queue.length && !owed.size)) return Promise.resolve(true);
  const ops = queue;
  queue = [];
  const dropped = [...owed].filter((key) => !mem.has(key));
  owed.clear();
  return new Promise((resolve) => {
    const failed = () => {
      for (const op of ops) {
        if (mem.has(op.key)) whole.add(op.key);
        else owed.add(op.key);
      }
      for (const key of dropped) if (!mem.has(key)) owed.add(key);
      resolve(false);
    };
    try {
      const tx = db!.transaction(STORE, 'readwrite');
      const entries = tx.objectStore(STORE);
      for (const key of dropped) entries.delete(range(key));
      for (const op of ops) {
        if ('drop' in op) entries.delete(range(op.key));
        else entries.put(op.value, [op.key, op.part]);
      }
      tx.oncomplete = () => resolve(true);
      tx.onabort = failed;
      tx.onerror = failed;
      tx.commit?.();
    } catch { failed(); }
  });
}
/**
 * Imports whose last write failed (a full disk): the next change to one writes all of its parts, so the store never
 * holds a new mapping beside the file it replaced. Until then it is kept in memory for this window.
 */
const whole = new Set<string>(); const owed = new Set<string>();
const later = (op: Op) => {
  if (!loaded) touched.add(op.key); else if (!db) return;          // no store to write to: kept in memory only
  if (!queue.length) queueMicrotask(flush);
  if (!('drop' in op) && whole.delete(op.key)) { for (const [part, value] of Object.entries(mem.get(op.key) ?? {})) if (part !== op.part) queue.push({ key: op.key, part, value }); }
  else if ('drop' in op) whole.delete(op.key);
  queue.push(op);
};

/** The import kept under `key`, as its parts, or undefined. Read it once `keptImportsReady` has resolved. */
export function keptImport(key: string): Readonly<Parts> | undefined { return mem.get(key); }

/**
 * Keeps the import under `key` as these parts. A part is written only when it is not the very value kept before, so a
 * dialog can hand over its whole state on every change. A part left out is kept as it was.
 */
export function keepImport(key: string, parts: Parts) {
  const was = mem.get(key) ?? {}; const now = { ...was };
  mem.set(key, now);   // before the writes, so a write of the whole import takes the parts as they now are
  for (const [part, value] of Object.entries(parts)) {
    if (Object.is(was[part], value) && part in was) continue;
    now[part] = value; later({ key, part, value });
  }
}

/** Submission must reach IndexedDB before its journal may start, not just enter the write queue. */
export async function saveImport(key: string, parts: Parts): Promise<boolean> {
  await keptImportsReady;
  whole.add(key); // One checkpoint writes the complete target snapshot through the existing batch.
  keepImport(key, parts);
  if (whole.delete(key)) {
    for (const [part, value] of Object.entries(mem.get(key)!)) later({ key, part, value });
  }
  if (!db) return !idb(); // No IndexedDB keeps the memory-only fallback; a failed open refuses submission.
  return flush();
}
/** The import under `key` is done, or the person started over: nothing of it is kept. */
export function dropImport(key: string) {
  if (!mem.has(key)) return;
  mem.delete(key); later({ key, drop: true });
}

/**
 * The keys the imports are kept under: one Q&A import and one issues list per deal, and one firm's checklist import for
 * each way in: "Import a list…" (no list named), or "Replace…" on a list, so a kept import never takes the place of the
 * list the person chose to replace.
 */
export const importKey = { qa: (dealId: string) => `qa:${dealId}`, issues: (dealId: string) => `issues:${dealId}`, checklist: (layer?: string, name?: string) => (layer ? `checklist:${layer}:${name ?? ''}` : 'checklist') } as const;

let ready = false; void keptImportsReady.then(() => { ready = true; });
/** false until the kept imports have been read: an import dialog waits for it (a few milliseconds at start) before it shows */
export function useKeptImportsReady() {
  const [is, set] = useState(ready);
  useEffect(() => { if (!is) void keptImportsReady.then(() => set(true)); }, []);
  return is;
}

/**
 * An import dialog that fails to show what was kept (a stored value this build cannot use) shows once more without it,
 * as a new import, rather than not at all: what was kept is left as it is, not thrown away, and goes only when a new file
 * is read in its place. `true` means show it fresh; 'gone' that it failed fresh too, and the dialog stays closed.
 */
export function useFreshOnCrash(): boolean | 'gone' {
  const tries = useRef(0);
  useErrorBoundary(() => { tries.current++; });
  return tries.current === 0 ? false : tries.current === 1 ? true : 'gone';
}
