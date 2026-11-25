import { DealId } from '../domain/model';
import { recoveredId } from '../domain/recovered';
import type { Store } from './store';

const CARRY_KEY = 'attachment-carries';
const RETRY_MS = 30_000;

type Carry = { original: string; copy: string };
const carryKey = ({ original, copy }: Carry) => `${original}:${copy}`;

function savedCarries(store: Store): Map<string, Carry> {
  const carries = new Map<string, Carry>();
  let saved: unknown;
  try {
    saved = store.services.local.read(CARRY_KEY);
  } catch {
    return carries;
  }
  if (!Array.isArray(saved)) return carries;
  for (const entry of saved as Partial<Carry>[]) {
    const copy = DealId.safeParse(entry?.copy);
    const original = DealId.safeParse(entry?.original);
    if (copy.success && original.success && copy.data !== original.data) {
      const carry = { copy: copy.data, original: original.data };
      carries.set(carryKey(carry), carry);
    }
  }
  return carries;
}

/** What looking for the deal a recovered copy came from found: it, no such deal, or no answer (#744). */
export type RecoveredSource = { state: 'found'; id: string } | { state: 'none' } | { state: 'unknown' };

/** Find the source of an older recovered copy using the same IDs as repository recovery (#744). */
export async function recoveredAttachmentSource(store: Store, copy: string): Promise<RecoveredSource> {
  const repo = store.services.repo;
  const current = store.get().sync;
  const read = current ? undefined : await repo.sync?.();
  if (read && !read.ok) return { state: 'unknown' };
  const sync = current ?? (read?.ok ? read.value : undefined);
  if (!sync) return { state: 'none' };
  const deleted = await repo.list('tombstone', '_');
  if (!deleted.ok) return { state: 'unknown' };
  const installs = [sync.self.id, ...sync.peers.map(({ id }) => id)];
  const source = deleted.value.find(({ id }) => id.startsWith('d_') && installs.some((pc) => recoveredId(id, pc) === copy));
  const id = source?.id;
  return id ? { state: 'found', id } : { state: 'none' };
}

/** Carry document references that were published on the original deal to its recovered copy (#744). */
export class AttachmentRecovery {
  private readonly pending: Map<string, Carry>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopWatching: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private stopped = false;

  constructor(private readonly store: Store) {
    this.pending = savedCarries(store);
    this.stopWatching = store.subscribe(() => this.updateReady());
    this.updateReady();
  }

  private updateReady() {
    const wasReady = this.ready;
    this.ready = this.store.get().boot.stage === 'ready' && !this.store.readOnly();
    if (this.ready && !wasReady) this.resume();
  }

  private save(key: string, carry?: Carry) {
    const saved = savedCarries(this.store);
    if (carry) saved.set(key, carry);
    else saved.delete(key);
    try {
      this.store.services.local.write(CARRY_KEY, [...saved.values()]);
    } catch { /* unavailable local storage leaves the carry queued in memory */ }
  }

  waiting(copy: string) {
    return [...this.pending.values()].some((carry) => carry.copy === copy);
  }

  queue(original: string, copy: string) {
    const carry = { original, copy };
    const key = carryKey(carry);
    this.pending.set(key, carry);
    this.save(key, carry);
    return this.runCarry(key);
  }

  async run(copy: string) {
    const pending = [...this.pending].filter(([, carry]) => carry.copy === copy);
    await Promise.all(pending.map(([key]) => this.runCarry(key)));
  }

  private runCarry(key: string): Promise<void> | undefined {
    const active = this.running.get(key);
    if (active) return active;
    const carry = this.pending.get(key);
    if (!carry || !this.store.services.docs.carryAttached || !this.ready || this.stopped) return;
    const run = this.carry(key, carry);
    this.running.set(key, run);
    return run;
  }

  private async carry(key: string, carry: Carry) {
    const { original, copy } = carry;
    const docs = this.store.services.docs;
    // #744: yield before calling the port so the claim is in place even when the port throws immediately.
    await Promise.resolve();
    let succeeded = false;
    try {
      const result = await docs.carryAttached?.(original, copy);
      succeeded = !!result?.ok && result.value.unresolved === 0;    // #744: files left unresolved keep the carry queued
    } catch { /* a refused or failed carry stays pending */ }
    this.running.delete(key);
    if (this.stopped) return;
    if (this.pending.get(key) !== carry) return this.runCarry(key);
    if (succeeded && !this.mayReceiveMore(carry)) {
      this.pending.delete(key);
      this.save(key);
    } else {
      this.save(key, carry);
      this.schedule();
    }
  }

  /** Another carry or an unfinished upload can still add source files after the current carry. */
  private mayReceiveMore({ original, copy }: Carry) {
    return this.waiting(original)
      || this.store.get().ui.attachments.some((chip) => chip.dealId === copy && chip.state === 'pending');
  }

  private resume() {
    for (const key of this.pending.keys()) void this.runCarry(key);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.resume();
    }, RETRY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    this.stopped = true;
    this.stopWatching();
    clearTimeout(this.timer);
  }
}
