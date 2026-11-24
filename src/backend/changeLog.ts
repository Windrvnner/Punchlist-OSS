/**
 * Shared records as change files: the part with no files in it.
 *
 * Every installed copy of the app (a "PC") appends one line per committed transaction to its own change file and
 * reads everyone's. This module turns a set of such lines into the state of every record. The result depends only on
 * WHICH lines are present, never on the order they were read in, so two PCs that have read the same lines agree.
 *
 * A record is a small graph of versions: each version names the version(s) it was based on. The current version of a
 * record is the one no other version is based on. Two such versions that say different things are a clash, kept as
 * they are for a person to choose between. Nothing here picks a winner.
 *
 * A line that names a version not taken in yet (its line is still syncing, or was lost) is held back, as if it had not
 * arrived, and taken in the moment that version is. So what is shown is always a state some PC really had: never a
 * newer version standing beside an older one it was built on, as a false choice. A withdrawn version counts as taken
 * in. A line that has waited a day for a version that never comes is let go (see `release`): its version then stands
 * beside the current one as a choice, rather than stay out of sight for good.
 *
 * The rules that settle which versions are current live in changeLogHeads.ts, and the folding of a question's draft in
 * changeLogDrafts.ts.
 */
import { sameContent } from '../domain/versions';
import type { AuditEntry, RecordKind } from '../domain/model';
import { DraftFold } from './changeLogDrafts';
import {
  bookkeepingGivesWay,
  restoredTwiceGivesWay,
  mayBeOneImport,
  oneImport,
  oneOfEqual,
  standingParents,
  tombstoneHeads,
  type VersionGraph,
} from './changeLogHeads';
import type { IndexChange, Line, RecChange, RecState, Ver } from './changeLines';

export { isLine, type IndexChange, type Line, type RecChange, type RecState, type Ver } from './changeLines';

export const recKey = (kind: string, id: string) => `${kind}/${id}`;
const stampOf = (l: { at: string; pc: string; seq: number }) => `${l.at}|${l.pc}|${String(l.seq).padStart(12, '0')}`;
/** older stamps first */
const byStamp = (a: { stamp: string }, b: { stamp: string }) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0);

/** the well-formed entries of a line's index change: a damaged one is passed over, as a damaged line is */
const entries = (list: unknown): { kind: RecordKind; id: string }[] => {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => !!e && typeof e.kind === 'string' && typeof e.id === 'string');
};

/** one line number per run of numbers that follow on: [first, last] */
function runsOf(numbers: Iterable<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** add `value` to the set kept under `key`, making the set if there is none yet */
function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key) ?? new Set<V>();
  set.add(value);
  map.set(key, set);
}

type HeldLine = { line: Line; missing: Set<string> };
type AuditKept = { e: AuditEntry; stamp: string; n: number };

export class Combined {
  private seen = new Set<string>();
  private vers = new Map<string, Ver>();
  private byRec = new Map<string, Ver[]>();
  private retracted = new Set<string>();
  private purged = new Set<string>();
  /** what has ever been filed under each deal; `first` orders a listing by when the entry first appeared */
  private idx = new Map<string, Map<string, { kind: RecordKind; id: string; first: string }>>();
  private filed = new Map<string, Set<string>>();
  private audits = new Map<string, AuditKept[]>();
  private cache = new Map<string, RecState>();
  readonly pcs = new Map<string, { label: string; by: string; lastChangeAt: string; stamp: string }>();
  /** lines held back until every version they name has been taken in, with the versions each still waits for */
  private held = new Map<string, HeldLine>();
  /** a version not taken in yet → the held lines waiting for it */
  private waitedOn = new Map<string, Set<string>>();
  /** the lines taken in, by PC, by their numbers */
  private taken = new Map<string, Set<number>>();
  /** the lines that deleted each deal */
  private purges = new Map<string, Line[]>();
  /** the lines that worked on each deal (see noteWork), by PC, by their numbers */
  private work = new Map<string, Map<string, Set<number>>>();
  /** versions named as a base by one taken in before them */
  private awaited = new Set<string>();
  private graph: VersionGraph = {
    version: (ver) => this.vers.get(ver),
    withdrawn: (ver) => this.retracted.has(ver),
  };
  private drafts = new DraftFold(this.graph);

  /**
   * Take in one line. A line already taken in changes nothing. Returns the keys of the records whose state may have
   * changed. `own`: a line this install wrote itself. It was sound when written, so it is never held back here, even
   * when a line it was built on has gone from the folder (a file put back to an older copy, say): the person's own work
   * stays in front of them.
   */
  add(line: Line, own = false): string[] {
    const identity = `${line.pc}:${line.seq}:${JSON.stringify(line)}`;
    if (this.seen.has(identity)) return [];
    this.seen.add(identity);
    const missing = own ? [] : this.missingOf(line);
    if (!missing.length) return this.takeIn([line]);
    this.held.set(identity, { line, missing: new Set(missing) });
    for (const ver of missing) addTo(this.waitedOn, ver, identity);
    return [];
  }

  /**
   * Take in, as they are, the held lines `pick` chooses: a line that has waited long enough for a version that is lost,
   * not slow. Built on a version this PC never saw, its version stands beside the current one as a
   * choice for a person, so nothing is lost; and should the missing version arrive after all, the graph settles as if
   * it had come first. Lines that waited only on these are taken in with them. Returns the keys of the records whose
   * state may have changed.
   */
  release(pick: (line: Line) => boolean): string[] {
    const go: Line[] = [];
    for (const [identity, held] of this.held) {
      if (!pick(held.line)) continue;
      this.held.delete(identity);
      go.push(held.line);
      for (const ver of held.missing) {
        const waiting = this.waitedOn.get(ver);
        waiting?.delete(identity);
        if (waiting && !waiting.size) this.waitedOn.delete(ver);
      }
    }
    return go.length ? this.takeIn(go) : [];
  }

  private takeIn(lines: Line[]): string[] {
    const touched = new Set<string>();
    const next = [...lines];
    // each line taken in may be the one others were waiting on, and those may be the ones still others wait on. Only
    // the lines waiting on what was just taken in are looked at, so each held line costs one look per version it waits
    // for.
    while (next.length) {
      const line = next.pop()!;
      const before = this.vers.size + this.retracted.size;
      for (const key of this.apply(line)) touched.add(key);
      if (this.vers.size + this.retracted.size === before) continue;
      for (const ver of [...line.recs.map((r) => r.ver), ...(line.retract ?? [])]) next.push(...this.arrived(ver));
    }
    return [...touched];
  }

  /** a version has been taken in: the held lines that waited only on it, now free to be taken in */
  private arrived(ver: string): Line[] {
    const identities = this.waitedOn.get(ver);
    if (!identities) return [];
    this.waitedOn.delete(ver);
    const free: Line[] = [];
    for (const identity of identities) {
      const held = this.held.get(identity);
      if (!held) continue;
      held.missing.delete(ver);
      if (held.missing.size) continue;
      this.held.delete(identity);
      free.push(held.line);
    }
    return free;
  }

  /**
   * The versions a line is built on that have not been taken in. A withdrawn version counts as taken in, and so does
   * one in the same line.
   */
  private missingOf(line: Line): string[] {
    const own = new Set(line.recs.map((r) => r.ver));
    const known = (ver: string) => this.vers.has(ver) || this.retracted.has(ver) || own.has(ver);
    return [...new Set(line.recs.flatMap((r) => r.base.filter((ver) => !known(ver))))];
  }
  /**
   * The deals a line is about: those its records belong to, its index entries are filed under, and a deal it removes.
   */
  dealsOfLine(line: Line): string[] {
    const out = new Set<string>();
    for (const r of line.recs) {
      const dealId = (r.data as { dealId?: unknown } | undefined)?.dealId;
      if (typeof dealId === 'string') out.add(dealId);
      for (const filedUnder of this.dealsOf(r.kind, r.id)) out.add(filedUnder);
    }
    if (line.index && line.index.dealId !== '_') out.add(line.index.dealId);
    if (line.purge) out.add(line.purge);
    return [...out];
  }
  /**
   * The lines held back. `missing`: the versions each waits for that no line here holds at all, followed through lines
   * that are themselves held (C's change waits on B's, which waits on D's: C waits for D). `pc` is the install that
   * wrote each.
   */
  waiting(): { line: Line; missing: string[] }[] {
    const holder = new Map<string, string>();
    for (const [identity, { line }] of this.held) for (const r of line.recs) holder.set(r.ver, identity);
    const roots = (identity: string, seen: Set<string>): string[] => {
      seen.add(identity);
      return [...(this.held.get(identity)?.missing ?? [])].flatMap((ver) => {
        const heldBy = holder.get(ver);
        if (heldBy === undefined) return [ver];
        return seen.has(heldBy) ? [] : roots(heldBy, seen);
      });
    };
    return [...this.held].map(([identity, { line, missing }]) => {
      const rootVersions = [...new Set(roots(identity, new Set()))];
      // a loop of held lines (two copies writing the same ids) still names what it waits for
      return { line, missing: rootVersions.length ? rootVersions : [...missing] };
    });
  }

  private apply(line: Line): string[] {
    const stamp = stampOf(line);
    const touched = new Set<string>();
    const pc = this.pcs.get(line.pc);
    if (!pc || stamp > pc.stamp) {
      this.pcs.set(line.pc, { label: line.from, by: line.by, lastChangeAt: line.at, stamp });
    }
    for (const r of line.recs) this.takeVersion(line, r, stamp, touched);
    if (line.retract?.length) this.drafts.forgetAll();
    for (const ver of line.retract ?? []) {
      this.retracted.add(ver);
      const version = this.vers.get(ver);
      if (version) touched.add(recKey(version.kind, version.id));
    }
    if (line.index) this.takeIndex(line.index, stamp, touched);
    if (line.purge) {
      this.purged.add(line.purge);
      for (const key of this.byRec.keys()) touched.add(key);
      const purges = this.purges.get(line.purge) ?? [];
      purges.push(line);
      this.purges.set(line.purge, purges);
    }
    addTo(this.taken, line.pc, line.seq);
    this.noteWork(line);
    (line.audit ?? []).forEach((e, n) => {
      const kept = this.audits.get(e.recordId) ?? [];
      kept.push({ e, stamp, n });
      this.audits.set(e.recordId, kept);
    });
    // a question that changes can change its Recently deleted entry too (an import's Undo gives way to a question that
    // stands)
    for (const key of [...touched]) {
      if (!key.startsWith('question/')) continue;
      const tombstone = `tombstone/${key.slice('question/'.length)}`;
      if (this.byRec.has(tombstone)) touched.add(tombstone);
    }
    // a version that arrives after one based on it (or after its retraction) changes that record too
    for (const key of touched) this.cache.delete(key);
    return [...touched];
  }

  private takeVersion(line: Line, r: RecChange, stamp: string, touched: Set<string>) {
    // the same version carried by two copies of a file
    if (this.vers.has(r.ver)) return;
    const schema = typeof r.schema === 'number' ? r.schema : typeof line.schema === 'number' ? line.schema : 1;
    const version: Ver = { ...r, at: line.at, by: line.by, from: line.from, pc: line.pc, stamp, schema };
    const key = recKey(r.kind, r.id);
    // a version taken in after one built on it (that line was released, or was this PC's own) changes what those were
    // judged against, so the remembered views are worked out again. Bases stay within a record.
    if (this.awaited.delete(r.ver)) this.drafts.forget(this.byRec.get(key) ?? []);
    for (const base of r.base) if (!this.vers.has(base)) this.awaited.add(base);
    this.vers.set(r.ver, version);
    const versions = this.byRec.get(key) ?? [];
    versions.push(version);
    this.byRec.set(key, versions);
    touched.add(key);
  }

  private takeIndex(index: IndexChange, stamp: string, touched: Set<string>) {
    const filedHere = this.idx.get(index.dealId) ?? new Map();
    this.idx.set(index.dealId, filedHere);
    // Only filing is kept. Taking a record off is not: the line that does so deletes the record too, and that delete
    // has its place among the record's versions whatever the PCs' clocks say (see `index`).
    for (const entry of entries(index.add)) {
      const key = recKey(entry.kind, entry.id);
      const current = filedHere.get(key);
      if (!current) filedHere.set(key, { ...entry, first: stamp });
      else if (stamp < current.first) current.first = stamp;
      touched.add(key);
      addTo(this.filed, key, index.dealId);
    }
  }

  /**
   * a line about a deal's records is work on it; one that only adds the deal to a person's list, or takes it off, is
   * not
   */
  private noteWork(line: Line) {
    if (line.purge || !line.recs.some((r) => r.kind !== 'member')) return;
    for (const dealId of this.dealsOfLine(line)) {
      const byPc = this.work.get(dealId) ?? new Map<string, Set<number>>();
      this.work.set(dealId, byPc);
      addTo(byPc, line.pc, line.seq);
    }
  }

  /** The lines taken in so far, by PC, as runs of line numbers: what a PC deleting a deal had seen (Line.seen). */
  seenNow(): Record<string, [number, number][]> {
    const out: Record<string, [number, number][]> = {};
    for (const [pc, numbers] of this.taken) out[pc] = runsOf(numbers);
    return out;
  }
  /** the deals that have been deleted */
  purgedDeals(): string[] {
    return [...this.purges.keys()];
  }
  /**
   * A deal another PC deleted while `pc` had work on it that the deleting PC had not taken in: the line that
   * deleted it (the first, where several PCs did), and how many of `pc`'s lines about it no deleting PC saw. Null when
   * every line was seen, or `pc` deleted the deal itself.
   */
  unseenWork(dealId: string, pc: string): { line: Line; lines: number } | null {
    const deletes = this.purges.get(dealId);
    if (!deletes?.length || deletes.some((l) => l.pc === pc)) return null;
    const saw = (l: Line, n: number) => (l.seen?.[pc] ?? []).some(([first, last]) => n >= first && n <= last);
    const unseen = [...(this.work.get(dealId)?.get(pc) ?? [])].filter((n) => !deletes.some((l) => saw(l, n)));
    if (!unseen.length) return null;
    const first = [...deletes].sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : 1))[0];
    return { line: first, lines: unseen.length };
  }
  /**
   * What was filed under a deal, deleted or not, with its records' states: what a PC had of a deal before it was
   * deleted.
   */
  filedUnder(dealId: string): { kind: RecordKind; id: string }[] {
    return [...(this.idx.get(dealId)?.values() ?? [])].map((e) => ({ kind: e.kind, id: e.id }));
  }
  /**
   * A record's history as it was written, whether or not its deal has since been deleted: for a deal's recovered copy.
   */
  history(recordId: string, keep: number): AuditEntry[] {
    const inOrder = [...(this.audits.get(recordId) ?? [])].sort((a, b) => byStamp(a, b) || a.n - b.n);
    return inOrder.map((x) => x.e).slice(-keep);
  }
  /**
   * The record as it last stood before it was deleted: its current versions that are not a delete or, where each is
   * one, the versions those deletes were made over (and so on back). Newest first.
   */
  lastHad(kind: RecordKind, id: string): Ver[] {
    const out: Ver[] = [];
    const seen = new Set<string>();
    let next = this.state(kind, id, true).heads;
    while (next.length && !out.length) {
      const back: Ver[] = [];
      for (const version of next) {
        if (seen.has(version.ver)) continue;
        seen.add(version.ver);
        if (!version.del) out.push(version);
        else back.push(...standingParents(this.graph, version));
      }
      next = back;
    }
    return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  }
  /** whether any version of the record has been taken in */
  known(kind: RecordKind, id: string): boolean {
    return this.byRec.has(recKey(kind, id));
  }

  /** the deleted deals a record, or the deal `dealId` a new record is for, went with */
  goneWith(kind: string, id: string, dealId?: unknown): string[] {
    const out = new Set<string>();
    if (kind === 'deal' && this.purged.has(id)) out.add(id);
    for (const filedUnder of this.filed.get(recKey(kind, id)) ?? []) {
      if (this.purged.has(filedUnder)) out.add(filedUnder);
    }
    if (typeof dealId === 'string' && this.purged.has(dealId)) out.add(dealId);
    return [...out];
  }
  /** the PCs that deleted a deal */
  deletedBy(dealId: string): string[] {
    return (this.purges.get(dealId) ?? []).map((l) => l.pc);
  }
  private gone(kind: string, id: string): boolean {
    if (kind === 'deal' && this.purged.has(id)) return true;
    for (const filedUnder of this.filed.get(recKey(kind, id)) ?? []) if (this.purged.has(filedUnder)) return true;
    return false;
  }

  /** `asHad`: as this PC had it, even when its deal has since been deleted (for the deal's recovered copy) */
  state(kind: RecordKind, id: string, asHad = false): RecState {
    const key = recKey(kind, id);
    const hit = asHad ? undefined : this.cache.get(key);
    if (hit) return hit;
    const mine = this.byRec.get(key) ?? [];
    const standing = mine.filter((v) => !this.retracted.has(v.ver));
    const usedAsBase = new Set(standing.flatMap((v) => v.base));
    const tipVersions = standing
      .filter((v) => !usedAsBase.has(v.ver))
      .sort((a, b) => byStamp(a, b) || (a.ver < b.ver ? -1 : 1));
    const heads = this.currentOf(kind, id, tipVersions);
    const dead = !asHad && this.gone(kind, id);
    const live = !dead && heads.length === 1 && !heads[0].del;
    const clash = !dead && heads.length > 1;
    // The number counts every version of the record taken in, and every withdrawal of one. It only grows as lines
    // arrive, so a write planned against any earlier state is turned away: a draft folded in (DraftFold), a choice,
    // its withdrawal, a delete then a restore. It depends only on which lines are present, so every PC
    // agrees on it.
    const withdrawn = mine.filter((v) => this.retracted.has(v.ver)).length;
    const rev = live || clash ? mine.length + withdrawn : 0;
    const tips = tipVersions.map((v) => v.ver);
    const recState: RecState = { kind, id, heads: dead ? [] : heads, tips: dead ? [] : tips, live, rev };
    if (!asHad) this.cache.set(key, recState);
    return recState;
  }

  /**
   * The current versions of a record, from the versions no other is based on (`tips`), by the rules in changeLogHeads.
   */
  private currentOf(kind: RecordKind, id: string, tips: Ver[]): Ver[] {
    let heads = oneOfEqual(tips, kind, this.graph);
    if (mayBeOneImport(heads, kind)) heads = oneImport(heads, kind, this.graph);
    if (kind === 'tombstone') heads = tombstoneHeads(heads, () => this.state('question', id).live);
    if (kind === 'item' && heads.length > 1) heads = bookkeepingGivesWay(heads, this.graph);
    if (kind === 'finding' && heads.length > 1) heads = restoredTwiceGivesWay(heads, this.graph);
    if (kind === 'question' && heads.length > 1) heads = this.withDraftFolded(heads, tips);
    // A delete made without knowledge of an edit (or an edit made without knowledge of a delete) is a clash like any
    // other: a person chooses between the deleted record and the edited one. The software never picks. The record's
    // readable versions come first, so that what a PC shows while the choice is open is a version that can be read.
    return [...heads.filter((h) => !h.del), ...heads.filter((h) => h.del)];
  }

  /**
   * A question's draft folded into its current versions (see changeLogDrafts). Every current version goes in, equal
   * ones too: two that say the same can have different histories. Only those still standing for what is
   * shown: a creation set aside above as the same as another PC's shares no history to fold.
   */
  private withDraftFolded(heads: Ver[], tips: Ver[]): Ver[] {
    const same = (a: Ver, b: Ver) => !!a.del === !!b.del && (!!a.del || sameContent(a.data, b.data));
    const folding = tips.filter((v) => heads.includes(v) || (v.base.length > 0 && heads.some((h) => same(h, v))));
    return this.drafts.fold(folding, new Set(heads))?.heads ?? heads;
  }

  /**
   * What a new write is based on: every version no other is based on, a delete marker included, and each of two equal
   * versions written on two PCs. Basing on only one of a pair would leave the other standing beside the new version: a
   * clash nobody made.
   */
  bases(kind: RecordKind, id: string, asHad = false): string[] {
    return this.state(kind, id, asHad).tips;
  }
  /**
   * What a version written beside the record's current one is based on: what the current one was based on, so the two
   * stand side by side.
   */
  basesBeside(kind: RecordKind, id: string, asHad = false): string[] {
    const tips = this.state(kind, id, asHad).tips;
    return [...new Set(tips.flatMap((tip) => this.vers.get(tip)?.base ?? []))];
  }
  /**
   * The version of another record written in the same line as this one (the deletion note written with a delete), if
   * there is one.
   */
  lineMate(ver: Ver, kind: RecordKind, id: string): Ver | undefined {
    const versions = this.byRec.get(recKey(kind, id)) ?? [];
    return versions.find((v) => v.pc === ver.pc && v.stamp === ver.stamp && !v.del);
  }
  forwardedVersions(kind: RecordKind, id: string, originalId: string, pc: string): Ver[] {
    return (this.byRec.get(recKey(kind, id)) ?? []).filter((v) => v.recoveredFrom === originalId && v.pc === pc);
  }
  version(ver: string): Ver | undefined {
    return this.vers.get(ver);
  }

  /**
   * What is filed under a deal and not deleted, in the order it was first filed. Whether a filed record is listed is
   * told by its own versions, which name what they were based on, and never by the time on a line: a restore made after
   * a delete brings the record back on every PC, however far apart their clocks are. A record deleted on
   * one PC and edited on another without knowledge of it is still there to be chosen, so it stays listed until a person
   * has.
   */
  index(dealId: string): { kind: RecordKind; id: string }[] {
    if (this.purged.has(dealId)) return [];
    const filedHere = [...(this.idx.get(dealId)?.values() ?? [])];
    const listed = filedHere.filter((e) => this.state(e.kind, e.id).heads.some((v) => !v.del));
    listed.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    return listed.map((e) => ({ kind: e.kind, id: e.id }));
  }
  /** Every record of a kind that has ever been written, oldest first. */
  ids(kind: RecordKind): string[] {
    const ofKind = [...this.byRec.entries()].filter(([key]) => key.startsWith(kind + '/'));
    ofKind.sort((a, b) => (a[1][0].stamp < b[1][0].stamp ? -1 : 1));
    return ofKind.map(([key]) => key.slice(kind.length + 1));
  }
  audit(recordId: string, keep: number): AuditEntry[] {
    if (this.purged.has(recordId)) return [];
    if (['question', 'finding', 'tombstone', 'deal', 'item'].some((kind) => this.gone(kind, recordId))) return [];
    return this.history(recordId, keep);
  }
  /** Records with versions nobody has chosen between. */
  attention(): { clashes: RecState[] } {
    const clashes: RecState[] = [];
    for (const [key, history] of this.byRec) {
      // One saved version cannot have competing heads.
      if (history.length < 2) continue;
      const slash = key.indexOf('/');
      const recState = this.state(key.slice(0, slash) as RecordKind, key.slice(slash + 1));
      if (recState.heads.length > 1) clashes.push(recState);
    }
    return { clashes };
  }
  dealsOf(kind: string, id: string): string[] {
    if (kind === 'deal') return [id];
    return [...(this.filed.get(recKey(kind, id)) ?? [])].filter((dealId) => dealId !== '_');
  }
}
