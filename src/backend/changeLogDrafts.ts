/**
 * A question's draft is written by the app, not typed by a person: pressing Draft from documents writes a pending
 * marker, and the reply replaces it. When a coworker's change crosses one of those writes (they close the question
 * before the marker has reached their PC, say), the two are not a choice for a person: the coworker's version stands,
 * carrying the draft, so the draft still arrives and nothing anyone typed or chose is set aside.
 *
 * The draft is taken as a field of its own. One version carries the draft that wins when, back to where it parted from
 * each other version, every step on its side either changed the draft and nothing else or left the draft alone, and the
 * other version has left the draft as it was there. Every version then carries that draft. Two coworkers who closed the
 * question, one before the marker reached them and one after, so say the same and are one version. A version
 * that changed only the draft since it parted from another says nothing more, and is let go. Anything else stays: two
 * drafts that crossed each other (two PCs drafting at once, a discard beside a new request), a delete beside a draft, a
 * draft changed in the same step as anything else (Use as response, say). The software never picks between two drafts.
 */
import { sameContent } from '../domain/versions';
import type { Ver } from './changeLines';
import { standingParents, type VersionGraph } from './changeLogHeads';

/** what a version says, its draft left out */
const bare = (version: Ver) => ({ ...(version.data as object), draft: undefined });
const draftOf = (version: Ver) => (version.data as { draft?: unknown }).draft;
const sameDraft = (a: Ver, b: Ver) => sameContent({ draft: draftOf(a) }, { draft: draftOf(b) });
/** each step back along a path: [the version, the one it was based on] */
const steps = (path: Ver[]) => path.slice(1).map((parent, i) => [path[i], parent] as const);
/** every step along the path changed the draft alone, or nothing */
const draftOnly = (path: Ver[] | null) =>
  !!path && steps(path).every(([v, parent]) => sameContent(bare(parent), bare(v)));
/** every step along the path changed the draft alone or left it alone */
const clean = (path: Ver[] | null): path is Ver[] =>
  !!path && steps(path).every(([v, parent]) => sameContent(bare(parent), bare(v)) || sameDraft(parent, v));

type Group = { rep: Ver; members: Ver[] };
/** where a walk of a version's history stands with a version: on the way through it, or past it */
const VISITING = 1;
const DONE = 2;
type Visit = typeof VISITING | typeof DONE;

/**
 * Folds a question's drafts into its current versions (see the top of this file). What it works out about each version
 * depends only on the versions before it, which never change once taken in, so it is remembered until `forget` says a
 * version's history changed.
 */
export class DraftFold {
  /** what the writer of each version with several bases had in front of them (see shownBefore) */
  private shown = new Map<string, Ver | null>();
  /** whether a version is a person's call on the draft (see isPersonsCall) */
  private isCall = new Map<string, boolean>();

  constructor(private graph: VersionGraph) {}

  /** a version taken in after ones built on it changes what those were judged against */
  forget(versions: Ver[]) {
    for (const version of versions) {
      this.shown.delete(version.ver);
      this.isCall.delete(version.ver);
    }
  }
  /** a withdrawal can change what any version was judged against */
  forgetAll() {
    this.shown.clear();
    this.isCall.clear();
  }

  /**
   * The current versions once the draft is folded in, or null when they stay a choice for a person. `shownHeads`: the
   * versions state() shows for each set of equal ones (the furthest along), which stand for their group here too.
   * Versions equal only once the draft is folded keep the earliest shown one.
   */
  fold(heads: Ver[], shownHeads?: Set<Ver>): { heads: Ver[] } | null {
    if (heads.some((head) => head.del)) return null;
    const lines = new Map(heads.map((head) => [head.ver, this.ancestry(head)]));
    // When every version carries the same draft (none, say, after a discard), that is the draft, and only the letting
    // go below is left to do: a discard beside a coworker's close is not a choice for a person.
    const oneDraft = heads.every((head) => sameDraft(head, heads[0]));
    if (this.anyCallSinceParting(heads, lines)) return null;
    const winners = oneDraft
      ? heads
      : heads.filter((w) => heads.every((g) => g === w || this.carries(w, g, lines.get(g.ver)!)));
    if (!winners.length || !winners.every((w) => sameDraft(w, winners[0]))) return null;
    const draft = draftOf(winners[0]);
    const schema = Math.max(...winners.map((w) => w.schema));
    const groups = this.groupCarrying(heads, draft, schema, shownHeads);
    // A version that changed only the draft since it parted from another says nothing that one does not, now it has the
    // draft. Equal versions can have different histories, so a group is let go only when every version in it is such a
    // one.
    const letGo = (group: Group) =>
      group.members.every((m) =>
        heads.some((o) => !group.members.includes(o) && draftOnly(this.path(m, lines.get(o.ver)!))),
      );
    const kept = groups.filter((group) => !letGo(group)).map((group) => group.rep);
    return { heads: kept.length ? kept : groups.map((group) => group.rep) };
  }

  /** every version carries the draft; versions that now say the same are one, the earliest standing for them all */
  private groupCarrying(heads: Ver[], draft: unknown, schema: number, shownHeads?: Set<Ver>): Group[] {
    const groups: Group[] = [];
    for (const head of heads) {
      const carrying = { ...head, schema: Math.max(head.schema, schema), data: { ...(head.data as object), draft } };
      const group = groups.find((x) => sameContent(x.rep.data, carrying.data));
      if (!group) {
        groups.push({ rep: carrying, members: [head] });
        continue;
      }
      group.members.push(head);
      const firstShown = shownHeads?.has(head) && !group.members.some((o) => o !== head && shownHeads.has(o));
      if (firstShown) group.rep = carrying;
    }
    return groups;
  }

  /**
   * Whether any version on any side, since it parted from any other, is a person's call on the draft: then the whole
   * stays a choice. A side that changed the draft in the same step as anything else (Use as response beside a discard
   * of the same draft) is such a call.
   */
  private anyCallSinceParting(heads: Ver[], lines: Map<string, Set<string>>): boolean {
    for (const w of heads) {
      for (const g of heads) {
        if (g === w) continue;
        const theirs = lines.get(g.ver)!;
        for (const ver of lines.get(w.ver)!) {
          const version = this.graph.version(ver);
          if (version && !theirs.has(ver) && !version.del && this.isPersonsCall(version)) return true;
        }
      }
    }
    return false;
  }

  /**
   * w's draft is the one to carry past g: every step on w's side changed the draft alone or left it alone, and g left
   * the draft as it was where the two parted (or carries the same draft already)
   */
  private carries(w: Ver, g: Ver, gAncestry: Set<string>): boolean {
    const path = this.path(w, gAncestry);
    return clean(path) && (sameDraft(g, w) || sameDraft(g, path[path.length - 1]));
  }

  /**
   * Whether a version is a person's call on the draft. Each is judged against what its writer had in front of them: its
   * base, or the one version its bases were shown as once the draft was folded (the next write on a folded question).
   * Bases that were a choice for a person count it when it says something none of them said and drops or changes a
   * draft one of them carried.
   */
  private isPersonsCall(version: Ver): boolean {
    const hit = this.isCall.get(version.ver);
    if (hit !== undefined) return hit;
    const parents = this.liveBases(version);
    let call = false;
    if (parents.length) {
      const shown = this.shownBefore(version, parents);
      call = shown
        ? !sameContent(bare(shown), bare(version)) && !sameDraft(shown, version)
        : parents.every((p) => !sameContent(bare(p), bare(version))) && parents.some((p) => !sameDraft(p, version));
    }
    this.isCall.set(version.ver, call);
    return call;
  }

  /** a version taken in, not a delete and not withdrawn */
  private live(ver: string): Ver | undefined {
    const version = this.graph.version(ver);
    return version && !version.del && !this.graph.withdrawn(ver) ? version : undefined;
  }
  private liveBases(version: Ver): Ver[] {
    return version.base.map((ver) => this.live(ver)).filter((p): p is Ver => !!p);
  }

  /** the version and every version behind it, through deletes, withdrawn ones passed over */
  private ancestry(version: Ver): Set<string> {
    const out = new Set<string>();
    const todo = [version.ver];
    while (todo.length) {
      const ver = todo.pop()!;
      if (out.has(ver) || this.graph.withdrawn(ver)) continue;
      out.add(ver);
      todo.push(...(this.graph.version(ver)?.base ?? []));
    }
    return out;
  }

  /**
   * h's versions back to where it meets the other version's history (`theirAncestry`), stepping back one base at a
   * time: [h, ..., the version where they parted]. Null when a step had more than one base (a person chose there) or
   * none, or the versions loop (damaged files).
   */
  private path(h: Ver, theirAncestry: Set<string>): Ver[] | null {
    const out: Ver[] = [];
    const walked = new Set<string>();
    for (let cur: Ver | undefined = h; cur; cur = cur.base.length === 1 ? this.live(cur.base[0]) : undefined) {
      out.push(cur);
      if (theirAncestry.has(cur.ver)) return out;
      if (walked.has(cur.ver)) return null;
      walked.add(cur.ver);
    }
    return null;
  }

  /**
   * What the writer of a version with these bases had in front of them, the draft folded in; null when the bases stood
   * as a choice. It depends only on the versions before it, which never change once taken in, unless one is withdrawn.
   */
  private shownBefore(version: Ver, bases: Ver[]): Ver | null {
    if (bases.length === 1) return bases[0];
    const hit = this.shown.get(version.ver);
    if (hit !== undefined) return hit;
    const order = this.choicesBehind(version, bases);
    this.shown.set(version.ver, null);
    if (!order) return null;
    // never leave a half-worked view behind to be read later
    this.forgetIfThrows(version, () => {
      for (const older of order) this.shownBefore(older, this.liveBases(older));
    });
    const distinct: Ver[] = [];
    for (const base of bases) if (!distinct.some((d) => sameContent(d.data, base.data))) distinct.push(base);
    const folded = this.forgetIfThrows(version, () => (distinct.length === 1 ? { heads: distinct } : this.fold(bases)));
    const out = folded && folded.heads.length === 1 ? folded.heads[0] : null;
    this.shown.set(version.ver, out);
    return out;
  }

  private forgetIfThrows<T>(version: Ver, work: () => T): T {
    try {
      return work();
    } catch (e) {
      this.shown.delete(version.ver);
      throw e;
    }
  }

  /**
   * The versions with several bases further back, oldest first, not worked out yet: worked out first, so that this
   * one's fold finds them ready and never recurses through a long history. Null when the history has a loop of versions
   * in it (damaged or copied files): that reads as a choice, whichever version is read first.
   */
  private choicesBehind(version: Ver, bases: Ver[]): Ver[] | null {
    const order: Ver[] = [];
    const state = new Map<string, Visit>([[version.ver, VISITING]]);
    const todo: [Ver, boolean][] = bases.map((base) => [base, false]);
    while (todo.length) {
      const [x, finished] = todo.pop()!;
      if (finished) {
        state.set(x.ver, DONE);
        if (x.base.length > 1 && !x.del && !this.shown.has(x.ver)) order.push(x);
        continue;
      }
      const seen = state.get(x.ver);
      if (seen === VISITING) return null;
      if (seen === DONE) continue;
      state.set(x.ver, VISITING);
      todo.push([x, true]);
      // through deletes too, as ancestry() goes
      for (const parent of standingParents(this.graph, x)) todo.push([parent, false]);
    }
    return order;
  }
}
