/** Late saves and deletes cannot replace work a person did in a recovered copy. */
import { changedValues } from '../domain/recovered';
import type { Ver } from './changeLines';

interface RecoveryGuard {
  originalId: string;
  had?: unknown;
  wrote?: unknown;
  deleting?: true;
  forwardedDeletion?: (version: Ver) => boolean;
  heads: Ver[];
  version: (id: string) => Ver | undefined;
}

/** Timestamps change with any edit; the other changed fields retain their normal business meaning. */
const businessKeys = (values: Record<string, unknown>) => Object.keys(values).filter((field) => field !== 'updatedAt');

/** Both directions include optional fields removed by the edit, even after JSON persistence drops their keys. */
const changedFields = (before: unknown, after: unknown) => new Set([
  ...businessKeys(changedValues(before, after)),
  ...businessKeys(changedValues(after, before)),
]);

/** The recorded parents were present before a legacy forwarded write added its own revision (#774). */
export function legacyReceiptCouldBeAsEarlyAs(
  receipt: Ver, revision: number, version: RecoveryGuard['version'],
): boolean {
  if (receipt.base.length >= revision) return false;
  const parent = receipt.base.length === 1 ? version(receipt.base[0]) : undefined;
  // A business change against a single parent had to pass the full history check below. A no-op or a folded
  // set of parents cannot prove deeper ancestry was present when the revision was returned.
  if (!parent || !changedFields(parent.data, receipt.data).size) return true;
  const seen = new Set([receipt.ver]);
  const pending = [parent];
  while (pending.length) {
    const ancestor = pending.pop()!;
    if (seen.has(ancestor.ver)) continue;
    seen.add(ancestor.ver);
    if (seen.size > revision) return false;
    for (const id of ancestor.base) {
      const earlier = version(id);
      if (earlier) pending.push(earlier);
    }
  }
  return true;
}

function directEditTouches(
  current: Ver, parent: Ver, guard: RecoveryGuard, fields: ReadonlySet<string> | null,
): boolean {
  if (current.recoveredFrom === guard.originalId || (current.del && guard.forwardedDeletion?.(current))) return false;
  return [...changedFields(parent.data, current.data)].some((field) => fields === null || fields.has(field));
}

/**
 * A forwarded save may follow another forwarded save of the same field. Only changes made directly in the copy stop it.
 * Inspect each version edge so a direct edit followed by putting the old value back still counts as changed.
 * Older versions have no routing marker: a postcreation change then conservatively counts as a direct edit.
 */
export function recoveredWriteClashes(guard: RecoveryGuard): boolean {
  // A deletion affects every business field, including edits later put back as they were. A save touches the fields it
  // changed and the ones it removed (#664).
  const fields = guard.deleting ? null : changedFields(guard.had, guard.wrote);
  if (fields && !fields.size) return false;
  const pending = [...guard.heads];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current.ver)) continue;
    seen.add(current.ver);
    for (const id of current.base) {
      const parent = guard.version(id);
      if (!parent) return true;
      pending.push(parent);
      if (directEditTouches(current, parent, guard, fields)) return true;
    }
  }
  return false;
}
