/**
 * A folder for the browser demo, which has no disk: one entry per file in the window's storage, under a prefix. The demo
 * keeps the backend's change files, this tab's copy of its own and the undo journal in these (see browserRepository.ts).
 */
import type { Folder } from '../backend/logRepository';

/** sizes are in bytes, as on a disk: the repository compares them with what it has read */
const bytes = (text: string) => new TextEncoder().encode(text).length;

export class StorageFolder implements Folder {
  constructor(private storage: Storage, private prefix: string) {}
  list() { const out: string[] = []; for (let i = 0; i < this.storage.length; i++) { const k = this.storage.key(i); if (k?.startsWith(this.prefix)) out.push(k.slice(this.prefix.length)); } return out; }
  size(name: string) { const v = this.storage.getItem(this.prefix + name); return v === null ? -1 : bytes(v); }
  read(name: string) { return this.storage.getItem(this.prefix + name); }
  /** throws QuotaExceededError when the storage is full, and then nothing is written */
  append(name: string, text: string) { this.storage.setItem(this.prefix + name, (this.storage.getItem(this.prefix + name) ?? '') + text); }
  write(name: string, text: string) { this.storage.setItem(this.prefix + name, text); }
  /** remove every file */
  clear() { for (const n of this.list()) this.storage.removeItem(this.prefix + n); }
}
