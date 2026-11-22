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
  // A deletion affects every business field, including edits later put back as they were.
  const fields = guard.deleting ? null : new Set(businessKeys(changedValues(guard.had, guard.wrote)));
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
