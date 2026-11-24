import { fail, ok, type Result } from '../domain/result';
import type { KeptImportChange, KeptImportPart, KeptImports } from '../ports';

type Parts = Record<string, unknown>;
type Connection = 'opening' | 'ready' | 'memory' | 'unavailable';

/** Keep a file and its import choices together between dialog openings and app sessions. */
class ImportKeeper {
  private imports = new Map<string, Parts>();
  private queue: KeptImportChange[] = [];
  private connection: Connection = 'opening';
  /** Imports touched while loading win over their older parts on disk. */
  private touched = new Set<string>();
  /** A failed batch needs a complete snapshot or deletion on its next write. */
  private whole = new Set<string>();
  private owed = new Set<string>();
  readonly ready: Promise<void>;

  constructor(private port?: KeptImports) {
    this.ready = this.restore();
  }

  get loaded() { return this.connection !== 'opening'; }

  private async restore() {
    if (!this.port) {
      this.connection = 'memory';
      return;
    }
    const state = await this.port.read(() => { void this.lateOpen(); }).catch(() => 'unavailable' as const);
    if (typeof state === 'string') {
      this.connection = state;
    } else {
      for (const { key, part, value } of state) {
        if (this.touched.has(key)) continue;
        const parts = this.imports.get(key) ?? {};
        parts[part] = value;
        this.imports.set(key, parts);
      }
      this.connection = 'ready';
      void this.flush();
    }
    this.touched.clear();
  }

  private partsOf(key: string): KeptImportPart[] {
    return Object.entries(this.imports.get(key) ?? {}).map(([part, value]) => ({ key, part, value }));
  }

  private async lateOpen() {
    // A blocked store opens after the app has continued. The live window's state wins over the older snapshot.
    this.connection = 'ready';
    this.queue = [];
    const snapshot = [...this.imports.keys()].flatMap((key) => this.partsOf(key));
    if (!(await this.port!.write(snapshot, true))) {
      for (const key of this.imports.keys()) this.whole.add(key);
    }
  }

  /** Submit the batch immediately so a reload straight after a check mark keeps it. */
  private async flush() {
    if (this.connection !== 'ready' || (!this.queue.length && !this.owed.size)) return true;
    const dropped = [...this.owed].filter((key) => !this.imports.has(key));
    const changes: KeptImportChange[] = [...dropped.map((key) => ({ key, drop: true as const })), ...this.queue];
    this.queue = [];
    this.owed.clear();
    if (await this.port!.write(changes)) return true;
    for (const { key } of changes) {
      if (this.imports.has(key)) this.whole.add(key);
      else this.owed.add(key);
    }
    return false;
  }

  private later(change: KeptImportChange) {
    if (this.connection === 'opening') this.touched.add(change.key);
    else if (this.connection !== 'ready') return;
    if (!this.queue.length) queueMicrotask(() => { void this.flush(); });
    if (this.whole.delete(change.key) && !('drop' in change)) {
      this.queue.push(...this.partsOf(change.key).filter(({ part }) => part !== change.part));
    }
    this.queue.push(change);
  }

  kept(key: string): Readonly<Parts> | undefined { return this.imports.get(key); }

  /** Each changed part is written once. Parts left out keep their earlier value. */
  keep(key: string, parts: Parts) {
    const was = this.imports.get(key) ?? {};
    const now = { ...was };
    this.imports.set(key, now); // A retry of the whole import takes the parts as they now are.
    for (const [part, value] of Object.entries(parts)) {
      if (Object.is(was[part], value) && part in was) continue;
      now[part] = value;
      this.later({ key, part, value });
    }
  }

  /** A checkpoint writes the whole import and waits for its transaction to finish. */
  async save(key: string, parts: Parts): Promise<boolean> {
    await this.ready;
    this.whole.add(key);
    this.keep(key, parts);
    if (this.whole.delete(key)) {
      for (const change of this.partsOf(key)) this.later(change);
    }
    if (this.connection !== 'ready') return this.connection === 'memory';
    return this.flush();
  }

  drop(key: string) {
    if (this.imports.delete(key)) this.later({ key, drop: true });
  }
}

let imports = new ImportKeeper();
export let keptImportsReady = imports.ready;

export function initializeKeptImports(port: KeptImports) {
  imports = new ImportKeeper(port);
  keptImportsReady = imports.ready;
}

export function areKeptImportsReady() { return imports.loaded; }

export function keptImport(key: string) { return imports.kept(key); }

export function keepImport(key: string, parts: Parts) { imports.keep(key, parts); }

export function saveImport(key: string, parts: Parts) { return imports.save(key, parts); }

export function dropImport(key: string) { imports.drop(key); }

/** A deal's imports and each way into the firm's checklist keep their own choices. */
export const importKey = {
  qa: (dealId: string) => `qa:${dealId}`,
  issues: (dealId: string) => `issues:${dealId}`,
  checklist: (layer?: string, name?: string) => (layer ? `checklist:${layer}:${name ?? ''}` : 'checklist'),
} as const;

interface SubmissionActions<Submission> {
  importRows: (submission: Submission) => Promise<Result<unknown>>;
  keepLog: (submission: Submission) => Promise<Result<unknown>>;
  release: (correlation: string) => Promise<boolean>;
}

/** Keep the correlation durable before sending rows and until the file choice and completion have landed. */
export async function finishKeptSubmission<Submission extends { key: string; done?: boolean }>(
  key: string,
  submission: Submission,
  actions: SubmissionActions<Submission>,
): Promise<Result<void>> {
  if (!(await saveImport(key, { submission }))) {
    return fail({ kind: 'storageFull', message: 'Couldn’t keep this import on this PC. Nothing was imported.' });
  }
  const imported = await actions.importRows(submission);
  if (!imported.ok) return fail({ ...imported.error, message: `Couldn’t import: ${imported.error.message}` });
  const log = await actions.keepLog(submission);
  if (!log.ok) {
    return fail({ ...log.error, message: `Imported, but the Q&A log could not be kept: ${log.error.message}` });
  }
  if (!(await saveImport(key, { submission: { ...submission, done: true } }))) {
    const message = 'Imported, but completion could not be kept on this PC. Retry to finish.';
    return fail({ kind: 'storageFull', message });
  }
  if (!(await actions.release(submission.key))) {
    return fail({ kind: 'rejected', message: 'Imported, but completion could not be recorded. Retry to finish.' });
  }
  dropImport(key);
  return ok(undefined);
}
