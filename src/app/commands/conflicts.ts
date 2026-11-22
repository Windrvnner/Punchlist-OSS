/**
 * A record changed on two PCs before either saw the other's change has two versions. The app never chooses between
 * them: a person does, here. The choice is one write of that one record. The version set aside is kept in the record's
 * history, and Undo puts the choice back as it was, with both versions standing.
 */
import { z } from 'zod';
import { define } from '../command';
import { DealId, Tombstone, CLASH_KINDS } from '../../domain/model';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { bucketOf, type State } from '../state';
import { sameContent } from '../../domain/versions';
import { keepAside, otherCopies, sameAsKept, stored, type Aside, type ShownNote } from './keptVersions';

const titleOf = (snap: unknown) => { const x = (snap ?? {}) as { text?: unknown; title?: unknown }; return typeof snap === 'string' ? snap : String(x.text ?? x.title ?? '').slice(0, 120); };

const current = (s: State, kind: string, id: string) => bucketOf(s, kind)?.[id];
/** the deal a choice is filed under: '' for the firm's list, which belongs to no deal and so keeps no history entry of its own */
const DealOrNone = z.union([DealId, z.literal('')]);

export const ResolveConflict = define({
  name: 'ResolveConflict',
  input: z.object({ dealId: DealOrNone, recordId: z.string().min(1), keep: z.string().min(1) }),
  targets: (_s, i) => [i.recordId],
  plan(state, input, ctx) {
    const c = state.conflicts[input.recordId];
    if (!c || c.dealId !== input.dealId) return fail(notFound('There is nothing to choose here any more', input.recordId));
    const kept = c.versions.find((v) => v.id === input.keep);
    if (!kept) return fail(notFound('That version is no longer one of the choices', input.recordId));
    if (!kept.data && !kept.deleted) return fail(rejected('That version can’t be read, so it can’t be kept'));
    const cur = current(state, c.kind, c.id);
    if (!cur) return fail(notFound('That record is no longer here', input.recordId));
    const aside = c.versions.filter((v) => v.id !== kept.id);
    const resolves = c.versions.map((v) => v.id);
    const audit = !c.dealId ? [] : [{ kind: 'resolved' as const, recordId: c.id, dealId: c.dealId, text: kept.deleted ? `Kept it deleted, as ${kept.by} did on ${kept.from}` : `Kept the version by ${kept.by} from ${kept.from}`, from: aside.map((v) => ({ by: v.by, from: v.from, at: v.at, data: v.raw })) }];
    const tomb = state.tombstones[c.id] as ShownNote | undefined;
    const reopen = (made: string[], cleared: ShownNote[]) => ({ command: 'ReopenConflict', input: { dealId: c.dealId, recordId: c.id, kind: c.kind, versions: c.versions.map((v) => ({ id: v.id, by: v.by, from: v.from, at: v.at, data: v.raw, ...(v.here ? { here: true } : {}), ...(v.deleted ? { deleted: true, ...(v.data ? { held: v.data } : {}) } : {}) })), ...(made.length ? { made } : {}), ...(cleared.length ? { cleared: cleared.map(stored) } : {}) } });
    if (c.kind === 'question' || c.kind === 'finding') {
      // Nothing is thrown away: every version not kept is listed under Deleted as an entry of its own, with
      // the PC it came from, unless it says what the kept one says. An entry already there that says what is kept goes.
      // An edited version is "Superseded by" the person who chose, with the PC and time the version was written;
      // a deleted version stays "Deleted by" the person who deleted it.
      const asideOf = (v: (typeof aside)[number]): Aside => ({ snapshot: v.data, by: v.deleted ? v.by : ctx.actor, from: v.from, at: v.at, ...(v.deleted ? {} : { edited: true }) });
      const notes = tomb ? otherCopies(tomb, undefined).filter((a) => !aside.some((v) => v.deleted && v.data && sameContent(v.data, a.snapshot))) : [];
      if (kept.deleted) {
        // Kept deleted: the record goes, and its deletion note holds the words the deleting PC had, as it said
        const snap = kept.data ?? tomb?.snapshot ?? cur;
        const note = Tombstone.parse({ ...(tomb ? stored(tomb) : {}), undoesImport: undefined, /* a person chose this deletion: it is no import's Undo now */ kind: c.kind, dealId: c.dealId, id: c.id, title: titleOf(snap ?? tomb?.title), at: tomb?.at ?? ctx.at, actor: tomb?.actor ?? ctx.actor, from: kept.from, snapshot: snap });
        const made = keepAside(c.kind, c.dealId, c.id, [...aside.map(asideOf), ...notes], [snap], state.tombstones);
        const cleared = sameAsKept(state, c.id, snap).filter((e) => !made.ids.includes(e.id));
        return ok({
          dealId: c.dealId,
          upserts: [{ kind: 'tombstone', record: note, expectedRev: tomb ? 'any' : null }, ...made.upserts],
          removes: [{ kind: c.kind, id: c.id, rev: cur.rev, resolves }, ...cleared.map((e) => ({ kind: 'tombstone' as const, id: e.id, rev: null }))],
          index: { dealId: c.dealId, remove: [{ kind: c.kind, id: c.id }, ...cleared.map((e) => ({ kind: 'tombstone' as const, id: e.id }))], add: [{ kind: 'tombstone', id: c.id }, ...made.ids.map((id) => ({ kind: 'tombstone' as const, id }))] },
          audit, inverse: reopen(made.ids, cleared), message: 'Kept it deleted',
        });
      }
      // Kept a version that is not deleted: it stands, and the note that it was deleted goes, its words kept as an entry
      const made = keepAside(c.kind, c.dealId, c.id, [...aside.map(asideOf), ...notes], [kept.data], state.tombstones);
      const cleared = sameAsKept(state, c.id, kept.data).filter((e) => !made.ids.includes(e.id));
      return ok({
        dealId: c.dealId,
        upserts: [{ kind: c.kind, record: { ...kept.data!, rev: cur.rev, updatedAt: ctx.at }, expectedRev: cur.rev, resolves }, ...made.upserts],
        removes: [...(tomb ? [{ kind: 'tombstone' as const, id: c.id, rev: null }] : []), ...cleared.map((e) => ({ kind: 'tombstone' as const, id: e.id, rev: null }))],
        index: { dealId: c.dealId, add: [...(tomb ? [{ kind: c.kind, id: c.id }] : []), ...made.ids.map((id) => ({ kind: 'tombstone' as const, id }))], remove: [...(tomb ? [{ kind: 'tombstone' as const, id: c.id }] : []), ...cleared.map((e) => ({ kind: 'tombstone' as const, id: e.id }))] },
        audit, inverse: reopen(made.ids, cleared),
        message: `Kept the version from ${kept.from}`,
      });
    }
    if (kept.deleted) return fail(rejected(c.kind === 'deal' ? 'A deal is not deleted this way' : 'This is not deleted this way'));
    return ok({
      ...(c.dealId ? { dealId: c.dealId } : {}),
      upserts: [{ kind: c.kind, record: { ...kept.data!, rev: cur.rev, updatedAt: ctx.at }, expectedRev: cur.rev, resolves }],
      audit, inverse: reopen([], []),
      message: `Kept the version from ${kept.from}`,
    });
  },
});

/** The inverse of a choice: the versions stand again, unchosen, and the record shows as it did before the choice. */
export const ReopenConflict = define({
  name: 'ReopenConflict',
  // `made`: the entries the choice listed under Deleted, which go again; `cleared`: entries it took away, which come back
  input: z.object({ dealId: DealOrNone, recordId: z.string().min(1), kind: z.enum(CLASH_KINDS), versions: z.array(z.object({ id: z.string(), by: z.string(), from: z.string(), at: z.string(), data: z.unknown(), here: z.boolean().optional(), deleted: z.boolean().optional(), held: z.unknown().optional() })).min(2), made: z.array(z.string()).optional(), cleared: z.array(Tombstone).optional() }),
  targets: (_s, i) => [i.recordId],
  plan(state, input, ctx) {
    const cur = current(state, input.kind, input.recordId);
    const wasDeleted = !cur && input.versions.some((v) => v.deleted);                    // the choice was to keep it deleted: it comes back to be chosen
    if (!cur && !wasDeleted) return fail(notFound('That record is no longer here', input.recordId));
    const shown = input.versions.find((v) => v.data && typeof v.data === 'object');
    if (!shown) return fail(rejected('Those versions can’t be read'));
    const made = (input.made ?? []).filter((id) => state.tombstones[id]); const back = input.cleared ?? [];
    return ok({
      ...(input.dealId ? { dealId: input.dealId } : {}),
      upserts: [{ kind: input.kind, record: { ...(shown.data as { id: string }), rev: cur?.rev ?? 0, updatedAt: ctx.at }, expectedRev: cur ? cur.rev : 'any' }, ...back.map((t) => ({ kind: 'tombstone' as const, record: t, expectedRev: 'any' as const }))],
      ...(made.length ? { removes: made.map((id) => ({ kind: 'tombstone' as const, id, rev: null })) } : {}),
      ...(input.dealId && (made.length || back.length) ? { index: { dealId: input.dealId, ...(made.length ? { remove: made.map((id) => ({ kind: 'tombstone' as const, id })) } : {}), ...(back.length ? { add: back.map((t) => ({ kind: 'tombstone' as const, id: t.id })) } : {}) } } : {}),
      reopen: [{ kind: input.kind, id: input.recordId, versions: input.versions }],
      audit: input.dealId ? [{ kind: 'edited', recordId: input.recordId, dealId: input.dealId, text: 'Choice between versions withdrawn' }] : [],
    });
  },
});
