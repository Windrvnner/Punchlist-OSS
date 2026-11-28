import { Operation } from '../domain/model';
import { fail, ok, type Result } from '../domain/result';
import type { Store } from './store';

export const dialogReportsFailure = { quietRefusal: () => true };

export async function findQaImportStep(store: Store, key: string, command: string) {
  const read = await store.services.repo.list('op');
  if (!read.ok) return read;
  const matching = read.value.flatMap((loaded) => {
    const parsed = Operation.safeParse(loaded.envelope.data);
    if (!parsed.success || parsed.data.command !== command || parsed.data.idempotencyKey !== key) return [];
    return [parsed.data];
  }).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return ok(matching.find((operation) => operation.state !== 'discarded') ?? matching[0]);
}

/** All writes in a retained import resume their own journal entry and original revisions (#270). */
export async function resumeQaImportStep(
  store: Store, key: string | undefined, command: string, fresh: () => Promise<Result<unknown>>,
): Promise<Result<void>> {
  const found = key ? await findQaImportStep(store, key, command) : ok(undefined);
  if (!found.ok) return found;
  const operation = found.value;
  if (operation?.state === 'succeeded') return store.refreshCommittedImportStep(operation);
  if (operation?.state === 'discarded') {
    return fail({ kind: 'rejected', message: 'This import was discarded. Start over or choose another file.' });
  }
  const result = operation ? await store.retryOp(operation.id, dialogReportsFailure) : await fresh();
  if (!result) return stillRunningImport();
  if (!result.ok) return result;
  const settled = operation && store.get().ops[operation.id];
  return settled?.state === 'succeeded' ? store.refreshCommittedImportStep(settled) : ok(undefined);
}

export function stillRunningImport() {
  return fail({ kind: 'rejected', message: 'This import is still running. Retry after it finishes.' });
}
