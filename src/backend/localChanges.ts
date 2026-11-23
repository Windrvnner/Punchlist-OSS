/** Record-file recovery: an uncertain append proves ownership, never permission to replay. */
import { sha256Hex } from '../domain/checklist';
import type { Folder } from './logRepository';
import { wholeLines } from './ownFile';

interface Attempt { file: string; sidecar: string; pc: string; seq: number; sha256: string; operation: string | null }
const UNREADABLE = 'Pending change ownership could not be read';
class OwnershipError extends Error {}

/** Compact ownership keeps the exact line's identity without a second transaction-sized payload (#503). */
function readAttempt(value: unknown, sidecar: string): Attempt {
  const entry = value as { file?: unknown; text?: unknown } | null;
  if (!entry || typeof entry.file !== 'string' || !/^changes-[A-Za-z0-9_-]+\.jsonl$/.test(entry.file)
    || typeof entry.text !== 'string') throw new OwnershipError(UNREADABLE);
  const line = JSON.parse(entry.text);
  if (typeof line?.pc !== 'string' || !/^[A-Za-z0-9_-]+$/.test(line.pc)
    || !Number.isSafeInteger(line.seq) || line.seq < 1
    || !entry.file.startsWith(`changes-${line.pc}-`) || sidecar !== `pending-changes-${line.pc}.json`) {
    throw new OwnershipError(UNREADABLE);
  }
  const legacy = entry.text.endsWith('\n');
  if (legacy ? entry.text.slice(0, -1).includes('\n') || 'proof' in line
    : entry.text.includes('\n') || line.proof !== 1 || typeof line.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(line.sha256)) {
    throw new OwnershipError(UNREADABLE);
  }
  if (line.op !== undefined && line.op !== null && typeof line.op !== 'string') {
    throw new OwnershipError(UNREADABLE);
  }
  return {
    file: entry.file, sidecar, pc: line.pc, seq: line.seq,
    sha256: legacy ? sha256Hex(entry.text.slice(0, -1)) : line.sha256,
    operation: typeof line.op === 'string' ? line.op : null,
  };
}

export class LocalChanges {
  private attempts = new Map<string, Attempt>();
  private sidecar: string;
  seq = 0;

  constructor(private local: Folder, id: string) {
    this.sidecar = `pending-changes-${id}.json`;
    for (const name of local.list().filter((name) => /^pending-changes-.*\.json$/.test(name))) {
      const values: unknown = JSON.parse(local.read(name) ?? '[]');
      if (!Array.isArray(values)) throw new OwnershipError(UNREADABLE);
      for (const value of values) {
        const attempt = readAttempt(value, name);
        const key = `${attempt.pc}:${attempt.seq}`;
        const earlier = this.attempts.get(key);
        if (earlier && (earlier.file !== attempt.file || earlier.sha256 !== attempt.sha256)) {
          throw new OwnershipError(UNREADABLE);
        }
        this.attempts.set(key, attempt);
        if (attempt.pc === id) this.seq = Math.max(this.seq, attempt.seq);
      }
    }
  }

  private find(line: string): Attempt | undefined {
    if (!this.attempts.size) return;
    let parsed: { pc?: string; seq?: number } | null;
    try { parsed = JSON.parse(line); }
    catch { return; }
    if (typeof parsed?.pc !== 'string' || typeof parsed.seq !== 'number'
      || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) return;
    const attempt = this.attempts.get(`${parsed.pc}:${parsed.seq}`);
    if (attempt && attempt.sha256 !== sha256Hex(line)) throw new OwnershipError(UNREADABLE);
    return attempt;
  }

  has(line: string): boolean { return !!this.find(line); }

  /**
   * A shared line proves only its own exact bytes. The same PC and sequence with other bytes was written by a copied
   * install under this id, so it is not this PC's pending change; local journal reads stay strict (#112).
   */
  sharedIsPending(line: string): boolean {
    try {
      return this.has(line);
    } catch (error) {
      if (error instanceof OwnershipError) return false;
      throw error;
    }
  }

  get hasPending(): boolean { return this.attempts.size > 0; }

  pendingFiles(id: string): Set<string> {
    const files = new Set<string>();
    for (const attempt of this.attempts.values()) {
      if (attempt.operation === id) files.add(attempt.file);
    }
    return files;
  }

  /** A JSON object without its newline was not acknowledged; keep its bytes before the next append. */
  private repair(name: string): string {
    const text = this.local.read(name) ?? '';
    if (!text || text.endsWith('\n')) return text;
    const end = text.lastIndexOf('\n') + 1;
    const aside = `torn-${name}`;
    this.local.write(aside, (this.local.read(aside) ?? '') + JSON.stringify(text.slice(end)) + '\n');
    this.local.write(name, text.slice(0, end));
    return text.slice(0, end);
  }

  /** The current and previous install's journal may settle only complete, confirmed local lines. */
  ownLines(owner: string): string[] {
    const lines: string[] = [];
    try {
      for (const name of this.local.list()) {
        if (!name.startsWith(`changes-${owner}-`) || !/^changes-.+\.jsonl$/.test(name)) continue;
        lines.push(...wholeLines(this.local.read(name) ?? '').filter((line) => !this.has(line)));
      }
    } catch (error) {
      if (error instanceof OwnershipError) throw error;
      // Unreadable lines cannot settle an operation.
    }
    return lines;
  }

  /** Record files exclude pending lines; an incomplete shared tail is invalidated only for the active owner. */
  heal(shared: Folder, name: string, whole = false): void {
    try {
      if (!whole && shared.size(name) === this.local.size(name)) return;
      const mine = wholeLines(this.repair(name)).filter((line) => !this.has(line));
      const there = shared.read(name) ?? '';
      const seen = new Set(wholeLines(there));
      const lost = mine.filter((line) => !seen.has(line));
      const lead = !whole && there && !there.endsWith('\n') ? ' (incomplete append)\n' : '';
      if (lead || lost.length) shared.append(name, lead + (lost.length ? lost.join('\n') + '\n' : ''));
    } catch (error) {
      if (error instanceof OwnershipError) throw error;
      // Tried again at the next read or write.
    }
  }

  private save(next: typeof this.attempts, sidecar: string): void {
    const values = [...next.values()].filter((attempt) => attempt.sidecar === sidecar)
      .map(({ file, pc, seq, sha256, operation }) => ({
        file, text: JSON.stringify({ proof: 1, pc, seq, sha256, op: operation }),
      }));
    this.local.write(sidecar, JSON.stringify(values));
    this.attempts = next;
  }

  append(file: string, text: string): void {
    const attempt = readAttempt({ file, text }, this.sidecar);
    const next = new Map(this.attempts);
    next.set(`${attempt.pc}:${attempt.seq}`, attempt);
    this.save(next, this.sidecar);
    this.repair(file);
    this.local.append(file, text);
  }

  finish(text: string): void {
    const attempt = this.find(text.slice(0, -1));
    if (!attempt) return;
    const next = new Map(this.attempts);
    next.delete(`${attempt.pc}:${attempt.seq}`);
    this.save(next, attempt.sidecar);
  }

  /** Promote exact shared evidence only after its canonical local line is durable. */
  confirm(line: string): boolean {
    const attempt = this.find(line);
    if (!attempt) return false;
    try {
      if (!wholeLines(this.repair(attempt.file)).includes(line)) this.local.append(attempt.file, line + '\n');
      this.finish(line + '\n');
      return true;
    } catch { return false; }
  }
}
