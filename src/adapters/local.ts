import type { LocalStore } from '../ports';
import { ok, fail } from '../domain/result';

const NS = 'dil/1/local/';
/** Versioned JSON in localStorage. A value that fails to parse reads as null rather than throwing. */
export class BrowserLocal implements LocalStore {
  constructor(private ls: Storage = window.localStorage) {}
  read(key: string) { try { const raw = this.ls.getItem(NS + key); if (!raw) return null; const env = JSON.parse(raw); return env && env.schema === 1 ? env.data : null; } catch { return null; } }
  write(key: string, value: unknown) { try { this.ls.setItem(NS + key, JSON.stringify({ schema: 1, data: value })); return ok(undefined); } catch { return fail({ kind: 'storageFull', message: 'Browser storage is full' }); } }
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
