import { KEPT_TEXT_KEY, type LocalStore } from '../ports';
import { ok, fail } from '../domain/result';

const NS = 'dil/1/local/';
/** Kept drafts retain the raw storage key and JSON used before they went through the port. */
const KEPT_TEXT_STORAGE = 'dil/1/kept-drafts';

/** JSON in localStorage. A value that fails to parse reads as null rather than throwing. */
export class BrowserLocal implements LocalStore {
  constructor(private ls: Storage = window.localStorage) {}
  read(key: string) {
    try {
      const keptText = key === KEPT_TEXT_KEY;
      const raw = this.ls.getItem(keptText ? KEPT_TEXT_STORAGE : NS + key);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (keptText) return saved;
      return saved && saved.schema === 1 ? saved.data : null;
    } catch { return null; }
  }
  write(key: string, value: unknown) {
    try {
      if (key === KEPT_TEXT_KEY) {
        if (value === null) this.ls.removeItem(KEPT_TEXT_STORAGE);
        else this.ls.setItem(KEPT_TEXT_STORAGE, JSON.stringify(value));
      } else {
        this.ls.setItem(NS + key, JSON.stringify({ schema: 1, data: value }));
      }
      return ok(undefined);
    } catch { return fail({ kind: 'storageFull', message: 'Browser storage is full' }); }
  }
  watch(onChange: (key: string) => void) {
    const on = (e: StorageEvent) => { if (e.storageArea === this.ls && e.key?.startsWith(NS)) onChange(e.key.slice(NS.length)); };
    window.addEventListener('storage', on); return () => window.removeEventListener('storage', on);
  }
}
export class MemoryLocal implements LocalStore {
  map = new Map<string, string>();
  read(key: string) { const raw = this.map.get(key); return raw ? JSON.parse(raw) : null; }
  write(key: string, value: unknown) { this.map.set(key, JSON.stringify(value)); return ok(undefined); }
}
