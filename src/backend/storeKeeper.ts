/**
 * Keeps the model service's file store within its limit.
 *
 * The store holds a limited number of files (500 unless set otherwise). A document is uploaded when it is first needed,
 * and when room is needed the documents that were used longest ago are taken out. A document taken out is uploaded
 * again the next time it is needed; nothing is lost, because the files themselves stay in the deal's folders.
 *
 * Every file this app uploads carries the document's id at the front of its name, so a copy of the app on another PC
 * recognizes it. A file in the store that does not carry one was put there by something else (the person's own
 * files): it is never removed, and it does not count toward the limit, which is on the app's own files only (decisions:
 * "The app counts only its own files there").
 */
import type { ModelService } from './service';
import type { Folder } from './logRepository';
import { control } from '../control';

export const DEFAULT_LIMIT = control.limits.storedFiles;
const OURS = /^(doc_[0-9a-f]{24})__/;
export const storeName = (docId: string, name: string) => `${docId}__${name}`;
/** the document a file in the store belongs to, and the name the file had in the folder; null for a file this app did not upload */
export const fromStoreName = (name: string): { docId: string; name: string } | null => { const m = OURS.exec(name); return m ? { docId: m[1], name: name.slice(m[0].length) } : null; };

interface Kept { fileId: string; usedAt: string }
export interface WantedDoc { docId: string; name: string; read: () => Uint8Array | Promise<Uint8Array> }

export class StoreKeeper {
  private kept = new Map<string, Kept>();                   // docId → where it is in the store and when it was last used
  private lookedAt = -Infinity;                              // when the store itself was last looked at
  private recheckMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private limit: number;
  private clock: () => string;
  /** `recheckMs`: how long what this PC remembers of the store is trusted before the store is asked again (another PC may have changed it) */
  constructor(private svc: Pick<ModelService, 'upload' | 'remove' | 'list'>, private local: Folder, opts: { limit?: number; clock?: () => string; recheckMs?: number } = {}) {
    this.limit = opts.limit ?? DEFAULT_LIMIT; this.clock = opts.clock ?? (() => new Date().toISOString()); this.recheckMs = opts.recheckMs ?? 60_000;
    try { for (const [docId, k] of Object.entries(JSON.parse(local.read('store.json') ?? '{}') as Record<string, Kept>)) if (k?.fileId) this.kept.set(docId, k); } catch { /* rebuilt from the store itself on the first check */ }
  }
  private save() { try { this.local.write('store.json', JSON.stringify(Object.fromEntries(this.kept))); } catch { /* the store itself is the record; this is only when each was last used */ } }
  /** one thing at a time: two answers running together must not both count the same free place */
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => undefined); return next; }

  /** Look at what is really in the store: forget what has gone, take note of what another PC uploaded, count the rest. */
  private async look() {
    const listed = await this.svc.list(); const there = new Map(listed.map((f) => [f.id, f.name]));
    for (const [docId, k] of this.kept) if (!there.has(k.fileId)) this.kept.delete(docId);
    const known = new Set([...this.kept.values()].map((k) => k.fileId));
    for (const f of listed) {
      if (known.has(f.id)) continue;
      const ours = fromStoreName(f.name);
      if (!ours) continue;                                                  // someone else's: left alone, and not counted
      const have = this.kept.get(ours.docId);
      if (!have) { this.kept.set(ours.docId, { fileId: f.id, usedAt: '' }); known.add(f.id); continue; }   // uploaded from another PC: when it was last used is not known here, so it goes first
      // two copies of one document (two PCs uploaded it at once): every PC keeps the same one, so they do not undo each other
      const [stay, go] = have.fileId < f.id ? [have.fileId, f.id] : [f.id, have.fileId];
      have.fileId = stay; known.add(stay); await this.svc.remove(go).catch(() => undefined);
    }
    this.lookedAt = Date.now(); this.save();
  }
  /** Take out the documents used longest ago until `room` more will fit. Returns how many were taken out. */
  private async free(room: number, keep: Set<string>): Promise<number> {
    let out = 0;
    const oldest = () => [...this.kept.entries()].filter(([docId]) => !keep.has(docId)).sort((a, b) => (a[1].usedAt < b[1].usedAt ? -1 : a[1].usedAt > b[1].usedAt ? 1 : a[0] < b[0] ? -1 : 1));
    for (const [docId, k] of oldest()) {
      if (this.kept.size + room <= this.limit) break;
      await this.svc.remove(k.fileId); this.kept.delete(docId); out++;
    }
    if (out) this.save();
    return out;
  }

  /**
   * Make sure these documents are in the store, uploading the ones that are not, and mark them all as used now.
   * Returns the store's id for each. Fails, uploading and removing nothing, if they cannot all be in the store at once.
   */
  ensure(docs: WantedDoc[]): Promise<Record<string, string>> {
    return this.serial(async () => {
      if (Date.now() - this.lookedAt >= this.recheckMs) await this.look();
      const want = new Map(docs.map((d) => [d.docId, d])); const keep = new Set(want.keys());
      const short = () => [...want.values()].filter((d) => !this.kept.has(d.docId));
      if (short().length && this.kept.size + short().length > this.limit) {
        await this.look();                                                    // before anything is taken out, be sure of what is there
        if (want.size > this.limit) throw new Error(`These ${want.size} documents cannot all be loaded at once: the store holds ${this.limit}.`);
        await this.free(short().length, keep);
      }
      for (const d of short()) {
        const fileId = await this.svc.upload({ name: storeName(d.docId, d.name), bytes: await d.read() });
        this.kept.set(d.docId, { fileId, usedAt: this.clock() }); this.save();
      }
      const now = this.clock(); const ids: Record<string, string> = {};
      for (const id of want.keys()) { const k = this.kept.get(id)!; k.usedAt = now; ids[id] = k.fileId; }
      this.save();
      return ids;
    });
  }
  /** The check to run every once in a while: look at the store and take out whatever is over the limit. */
  trim(): Promise<number> { return this.serial(async () => { await this.look(); return this.free(0, new Set()); }); }
  /** the documents in the store right now, as far as this PC knows without asking */
  loaded(): string[] { return [...this.kept.keys()]; }
}
