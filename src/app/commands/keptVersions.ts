/**
 * No choice between versions throws a version away (no design may lose or hide typed work). A version of a
 * question or finding that a choice did not keep, and the copy in a second deletion note when two PCs deleted different
 * words, is listed under Deleted as an entry of its own, with the PC it came from, and can be restored like any other.
 *
 * An entry is a deletion note with an id of its own (`<record id>~<mark of its words>`) that names its record (`of`). The
 * same words make the same id on every PC, so two PCs setting the same version aside make one entry. An entry that says
 * the same as the version kept is never made, and one already there is taken away when its words are kept.
 */
import { z } from 'zod';
import { define, type Upsert, type Remove } from '../command';
import { DealId, Question, Finding, Tombstone } from '../../domain/model';
import { contentMark, sameContent } from '../../domain/versions';
import { ok, fail, notFound, rejected } from '../../domain/result';
import type { State } from '../state';

/** A second deletion note of a record, as this window read it (`Store.take`): which version it is, where it came from, and its copy. */
export interface DeletedCopy { ver: string; from: string; actor: string; at: string; snapshot: unknown }
/** What a window adds to a deletion note it shows: where it came from, and the other notes of the same record, when two PCs deleted different words. */
export type ShownNote = Tombstone & { of?: string; from?: string; edited?: boolean; copies?: DeletedCopy[] };

/** A version to keep aside: its words, who wrote it on which PC and when, and whether it is an edit that was not kept (rather than a delete). */
export interface Aside { snapshot: unknown; by: string; from: string; at: string; edited?: boolean }

export const entryId = (recordId: string, snapshot: unknown) => `${recordId}~${contentMark(snapshot)}`;
export const entriesOf = (s: Pick<State, 'tombstones'>, recordId: string) => Object.values(s.tombstones).filter((t) => (t as ShownNote).of === recordId) as ShownNote[];
/** A note as it is stored: without what a window added to it for showing. */
export const stored = (t: ShownNote): Tombstone => { const { copies: _c, ...rest } = t; return rest as Tombstone; };
const titleOf = (snap: unknown) => { const x = (snap ?? {}) as { text?: unknown; title?: unknown }; return String(x.text ?? x.title ?? '').slice(0, 120); };

/**
 * The entries for versions set aside: one for each that says something none of the kept ones (or an earlier one here)
 * says. Their upserts and the ids to file under the deal.
 */
export function keepAside(kind: 'question' | 'finding', dealId: string, recordId: string, aside: Aside[], kept: unknown[], have: Record<string, Tombstone> = {}): { upserts: Upsert[]; ids: string[] } {
  const upserts: Upsert[] = []; const ids: string[] = []; const said = [...kept];
  for (const a of aside) {
    if (!a.snapshot || typeof a.snapshot !== 'object' || said.some((k) => sameContent(k, a.snapshot))) continue;
    said.push(a.snapshot);
    // two different versions whose marks happen to match must not share an entry: the later one takes a numbered id
    let id = entryId(recordId, a.snapshot);
    for (let n = 2; (have[id] && !sameContent(have[id].snapshot, a.snapshot)) || ids.includes(id); n++) id = `${entryId(recordId, a.snapshot)}.${n}`;
    const t = Tombstone.parse({ kind, dealId, id, title: titleOf(a.snapshot), at: a.at, actor: a.by, snapshot: a.snapshot, of: recordId, from: a.from, ...(a.edited ? { edited: true } : {}) });
    upserts.push({ kind: 'tombstone', record: t, expectedRev: 'any' }); ids.push(id);
  }
  return { upserts, ids };
}

/** The entries of a record that say what is now kept: they would list the same words twice. */
export const sameAsKept = (s: Pick<State, 'tombstones'>, recordId: string, kept: unknown) => entriesOf(s, recordId).filter((e) => sameContent(e.snapshot, kept));

/** Restoring a record whose deletion note has more than one copy: the copies not restored become entries. */
export function otherCopies(t: ShownNote, chosen: unknown): Aside[] {
  const all: Aside[] = [{ snapshot: t.snapshot, by: t.actor, from: t.from ?? '', at: t.at }, ...(t.copies ?? []).map((c) => ({ snapshot: c.snapshot, by: c.actor, from: c.from, at: c.at }))];
  return all.filter((a) => !sameContent(a.snapshot, chosen));
}

/**
 * Restore an entry. With its record deleted, the entry's words come back as the record, and what the record's deletion
 * note held becomes an entry in turn. With its record there, the entry's words come back beside it, as two versions for a
 * person to choose between, so neither is put over the other unseen.
 */
export const RestoreVersion = define({
  name: 'RestoreVersion',
  input: z.object({ dealId: DealId, entryId: z.string().min(1) }),
  targets: (s, i) => { const of = (s.tombstones[i.entryId] as ShownNote | undefined)?.of; return of ? [i.entryId, of] : [i.entryId]; },
  plan(state, input, ctx) {
    const e = state.tombstones[input.entryId] as ShownNote | undefined;
    if (!e?.of || e.dealId !== input.dealId || (e.kind !== 'question' && e.kind !== 'finding')) return fail(notFound('Nothing to restore', input.entryId));
    const kind = e.kind; const id = e.of;
    if (state.conflicts[id]) return fail(rejected('It has two versions already. Choose one first'));
    const bucket = kind === 'question' ? state.questions : state.findings;
    const cur = bucket[id] as (Question | Finding) | undefined;
    const parse = (x: unknown) => (kind === 'question' ? Question.parse(x) : Finding.parse(x));
    const label = (r: Question | Finding) => (kind === 'question' ? `Q${(r as Question).n}` : 'The finding');
    const takeOff: Remove = { kind: 'tombstone', id: e.id, rev: null };
    if (cur) {
      const rec = parse({ ...(e.snapshot as object), id, dealId: cur.dealId, rev: cur.rev, updatedAt: ctx.at });
      if (sameContent(rec, cur)) return ok({ dealId: e.dealId, upserts: [], removes: [takeOff], index: { dealId: e.dealId, remove: [{ kind: 'tombstone', id: e.id }] }, audit: [], message: `${label(cur)} already says this` });
      return ok({
        dealId: e.dealId,
        upserts: [{ kind, record: rec, expectedRev: cur.rev, beside: true }],
        removes: [takeOff],
        index: { dealId: e.dealId, remove: [{ kind: 'tombstone', id: e.id }] },
        audit: [{ kind: 'restored', recordId: id, dealId: e.dealId, text: `Version from ${e.from || 'another PC'} brought back beside this one` }],
        message: `${label(cur)} has two versions. Choose one`,
      });
    }
    const rec = parse({ ...(e.snapshot as object), id, dealId: e.dealId, updatedAt: ctx.at });
    if (kind === 'question' && Object.values(state.questions).some((x) => x.dealId === e.dealId && x.n === (rec as Question).n)) return fail(rejected(`Q${(rec as Question).n} can’t be restored: another question now has that number`));
    // what the record's own deletion note holds is kept as an entry in its place, unless it says the same
    const note = state.tombstones[id] as ShownNote | undefined;
    const others = note ? keepAside(kind, e.dealId, id, otherCopies(note, rec), [rec], state.tombstones) : { upserts: [], ids: [] };
    return ok({
      dealId: e.dealId,
      upserts: [{ kind, record: rec, expectedRev: null }, ...others.upserts],
      removes: [takeOff, ...(note ? [{ kind: 'tombstone' as const, id, rev: null }] : [])],
      index: { dealId: e.dealId, add: [{ kind, id }, ...others.ids.map((x) => ({ kind: 'tombstone' as const, id: x }))], remove: [{ kind: 'tombstone', id: e.id }, ...(note ? [{ kind: 'tombstone' as const, id }] : [])] },
      audit: [{ kind: 'restored', recordId: id, dealId: e.dealId }],
      inverse: kind === 'question' ? { command: 'DeleteQuestion', input: { dealId: e.dealId, questionId: id } } : { command: 'DeleteFinding', input: { dealId: e.dealId, findingId: id } },
      message: `${label(rec)} restored`,
    });
  },
});
