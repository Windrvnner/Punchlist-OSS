import { z } from 'zod';
import { commandLabel } from '../commandLabels';
import { define, type Command, type Plan } from '../command';
import { OpId, type Operation } from '../../domain/model';
import { fingerprint } from '../../domain/versions';
import { ok, fail, notFound, rejected, type Result } from '../../domain/result';
import { bucketOf } from '../state';

/**
 * Undo is an ordinary operation that runs the inverse recorded by the
 * original one. It refuses when any target has moved on since (someone else
 * changed it), so an undo never clobbers newer work. The registry of
 * commands is injected at wiring time to avoid an import cycle.
 */
export const registry = new Map<string, Command<any>>();

/**
 * The records an action wrote that are no longer as it left them, by `kind/id`: changed, gone, or back (a tombstone shares
 * its record's id, so each is read in its own kind). Null when one is of a kind this build does not keep, so it cannot tell.
 */
export function changedSince(state: Parameters<typeof bucketOf>[0], results: NonNullable<Operation['results']>): string[] | null {
  const moved: string[] = [];
  for (const [key, was] of Object.entries(results)) {
    const cut = key.indexOf('/'); const kind = key.slice(0, cut); const id = key.slice(cut + 1);
    const bucket = bucketOf(state, kind);
    if (!bucket) return null;
    const cur = bucket[id];
    const same = was === null ? !cur : !!cur && (was.rev === undefined || cur.rev === undefined || cur.rev === was.rev) && (was.at === undefined || (kind === 'tombstone' ? cur.at : cur.updatedAt) === was.at) && (was.sig === undefined || fingerprint(cur) === was.sig);
    if (!same) moved.push(key);
  }
  return moved;
}

export const Undo = define({
  name: 'Undo',
  input: z.object({ opId: OpId }),
  targets: (s, i) => s.ops[i.opId]?.targets ?? [],
  plan(state, input, ctx): Result<Plan> {
    const op = state.ops[input.opId];
    if (!op) return fail(notFound('That action is no longer available to undo'));
    if (op.state !== 'succeeded') return fail(rejected('Only a completed action can be undone'));
    if (op.undoneBy) return fail(rejected('Already undone'));
    if (!op.inverse) return fail(rejected('This action cannot be undone'));
    if (op.results) {
      const moved = changedSince(state, op.results);
      if (moved === null) return fail(rejected('This action cannot be undone on this version of Punchlist'));   // a kind this build does not keep: it cannot tell whether it has changed since
      if (moved.length) return fail(rejected('Changed since — undo refused'));
    } else if (!op.resultRevs) return fail(rejected('This action cannot be undone any more: Punchlist can no longer tell whether it has changed since'));
    else for (const [id, rev] of Object.entries(op.resultRevs)) {                               // an operation recorded before `results`
      const cur: any = state.questions[id] ?? state.findings[id] ?? state.deals[id];
      if (cur && (cur.rev !== rev || (op.resultAt?.[id] !== undefined && cur.updatedAt !== op.resultAt[id]))) return fail(rejected('Changed since — undo refused'));
    }
    const inv = registry.get(op.inverse.command);
    if (!inv) return fail(rejected(`Unknown inverse ${op.inverse.command}`));
    const parsed = inv.input.safeParse(op.inverse.input);
    if (!parsed.success) return fail(rejected('Inverse input invalid'));
    const r = inv.plan(state, parsed.data, ctx);
    if (!r.ok) return r;
    const p = r.value;
    return ok({
      ...p,
      // the original is marked undone in the same transaction
      upserts: [...p.upserts, { kind: 'op', record: { ...op, undoneBy: ctx.opId }, expectedRev: 'any' }],
      audit: p.audit.map((a) => ({ ...a, kind: 'undone' as const, text: a.text ?? `Undid ${commandLabel(op.command, op.input)}`, undoes: op.id })),
      inverse: undefined,
      message: p.message ? `Undone · ${p.message}` : 'Undone',
    });
  },
});
