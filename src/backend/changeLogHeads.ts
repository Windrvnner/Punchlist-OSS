/**
 * The rules that settle a record's current versions (see `Combined.state` in changeLog.ts), one helper per rule. Each
 * takes the versions still standing and returns those that stand after it: versions that say the same thing are one,
 * an import made on two PCs is one import, and a Recently deleted entry gives way where it should. Nothing here picks a
 * winner between two versions that say different things: those stay a choice for a person.
 */
import { sameContent } from '../domain/versions';
import { key } from '../domain/checklist';
import type { RecordKind } from '../domain/model';
import type { Ver } from './changeLines';

/** The versions taken in so far, as the rules read them. */
export interface VersionGraph {
  version(ver: string): Ver | undefined;
  /** whether the version has been withdrawn, as if never written (the undo of a choice) */
  withdrawn(ver: string): boolean;
}

/** the versions a version was based on that have been taken in and not withdrawn, delete markers included */
export function standingParents(graph: VersionGraph, version: Ver): Ver[] {
  const out: Ver[] = [];
  for (const ver of version.base) {
    const parent = graph.version(ver);
    if (parent && !graph.withdrawn(ver)) out.push(parent);
  }
  return out;
}

/**
 * Two imported questions that are the same question: the same but for their numbers, and for case and a final period in
 * the wording and party, as the id reads them. The same list saved a little differently is still the same
 * questions.
 */
function sameImported(a: unknown, b: unknown): boolean {
  return sameContent(asImportReadsIt(a), asImportReadsIt(b));
}

/** what an import's id is made from, so two PCs' imports of the same row read the same */
function asImportReadsIt(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const question = data as { text?: unknown; askedBy?: unknown; body?: unknown; onLists?: unknown };
  return {
    ...data,
    n: undefined,
    text: words(question.text),
    askedBy: words(question.askedBy),
    ...(Array.isArray(question.body) ? { body: question.body.map(words) } : {}),
    ...(question.onLists ? { onLists: marksAsImportReadsThem(question.onLists) } : {}),
  };
}

const words = (value: unknown) => (typeof value === 'string' ? key(value) : value);

/**
 * A finding an issues list made is read the same way: counsel's words in its detail and on its marks, as its id
 * reads them. A mark's list is its file's id: the name each PC saved the same file under is only what is shown.
 */
function marksAsImportReadsThem(marks: unknown): unknown {
  if (!Array.isArray(marks)) return marks;
  return marks.map((mark) => {
    if (!mark || typeof mark !== 'object') return mark;
    const ofFile = (mark as { doc?: unknown }).doc ? { list: undefined } : {};
    return { ...mark, text: words((mark as { text?: unknown }).text), ...ofFile };
  });
}

/** how many versions lie behind a version, itself included, deletes counted */
function depth(graph: VersionGraph, version: Ver, seen = new Set<string>()): number {
  if (seen.has(version.ver)) return 1;
  seen.add(version.ver);
  // a delete counts as a version too, so a record deleted and then restored carries on from where it was rather than
  // starting again at 1, and a save based on a copy read before the delete is turned away
  let deepest = 0;
  for (const parent of standingParents(graph, version)) deepest = Math.max(deepest, depth(graph, parent, seen));
  return deepest + 1;
}

/**
 * Versions that say the same thing are one version, and the oldest stands for them (the rev, counted in state(), never
 * goes back when an equal version written with less history arrives). For a question or a finding the furthest
 * along stands for them instead, so a PC's own edit stays what it shows (and can undo) when another PC's equal import
 * arrives.
 */
export function oneOfEqual(heads: Ver[], kind: RecordKind, graph: VersionGraph): Ver[] {
  const distinct: Ver[] = [];
  for (const head of heads) {
    const i = distinct.findIndex((d) => !!d.del === !!head.del && (head.del || sameContent(d.data, head.data)));
    if (i < 0) {
      distinct.push(head);
      continue;
    }
    const furthestStands = kind === 'question' || kind === 'finding';
    if (furthestStands && depth(graph, head) > depth(graph, distinct[i])) distinct[i] = head;
  }
  return distinct;
}

/**
 * A record made the same way on two PCs: a question (two PCs make the same question only by importing the same list,
 * its id made from the row), or a finding made from an issues list's point, known by `aiTitle`, which only such
 * an import sets on a creation.
 */
const madeTwice = (kind: RecordKind, version: Ver) => {
  if (kind === 'question') return true;
  return kind === 'finding' && !version.del && (version.data as { aiTitle?: unknown } | undefined)?.aiTitle === true;
};
/** a version that made the record, by an import another PC may have made too */
const isCreation = (kind: RecordKind, version: Ver) =>
  !version.del && version.base.length === 0 && madeTwice(kind, version);
const sameQuestion = (a: Ver, b: Ver) => sameImported(a.data, b.data);

/** whether the rule of `oneImport` has anything to do: a creation or an import's Undo stands beside another version */
export function mayBeOneImport(heads: Ver[], kind: RecordKind): boolean {
  if (kind !== 'question' && kind !== 'finding') return false;
  return heads.length > 1 && heads.some((head) => isCreation(kind, head) || head.undoesImport);
}

/**
 * A question made on two PCs that says the same thing is one question, even after one PC changed or deleted its
 * copy: the other PC's creation is set aside as the same creation, and the change stands. Only questions: other kinds
 * whose ids are made from what they are (members, checklist items, the firm's list) are made again by a person's
 * choice, which stays a choice. The two imports may have numbered it differently (one PC already held the file's
 * number, or the row had none): the number is display data, not what the question says, so that is still one question,
 * never a choice for a person. The higher number stands, in every PC alike: a PC gives a row a number other than the
 * file's only past numbers it holds. Findings an issues list made are set aside the same way: the creation the
 * model titled on the other PC is the same creation, so a person's close or edit before the sync stands and nobody is
 * asked to choose again.
 */
export function oneImport(heads: Ver[], kind: RecordKind, graph: VersionGraph): Ver[] {
  let standing = withoutTwinCreations(heads, kind);
  standing = withoutUndoneTwins(standing, kind, graph);
  const made = creationsBelow(
    standing.flatMap((head) => head.base),
    kind,
    graph,
  );
  if (!made.length) return standing;
  return standing.filter((head) => !isCreation(kind, head) || !made.some((m) => sameQuestion(m, head)));
}

/** of two creations that are the same question, the one with the higher number stands, else the one listed first */
function withoutTwinCreations(heads: Ver[], kind: RecordKind): Ver[] {
  const number = (version: Ver) => Number((version.data as { n?: unknown } | undefined)?.n) || 0;
  const creations = heads.filter((head) => isCreation(kind, head));
  const outranks = (other: Ver, head: Ver) => {
    if (number(other) !== number(head)) return number(other) > number(head);
    return heads.indexOf(other) < heads.indexOf(head);
  };
  return heads.filter((head) => {
    if (!isCreation(kind, head)) return true;
    return !creations.some((other) => other !== head && sameQuestion(other, head) && outranks(other, head));
  });
}

/**
 * An import's Undo takes back only its own PC's copy: where another PC imported the same question, that one still
 * stands, as it would have had the two never met. Only an Undo: a person's delete of the question stands over the other
 * copy.
 */
function withoutUndoneTwins(heads: Ver[], kind: RecordKind, graph: VersionGraph): Ver[] {
  // what another PC made and still holds: its creation standing as it is, or the creation under a later edit of it
  const held = heads
    .filter((head) => !head.del)
    .flatMap((head) => {
      if (head.base.length > 0) return creationsBelow(head.base, kind, graph);
      return isCreation(kind, head) ? [head] : [];
    });
  return heads.filter((head) => {
    if (!head.del || !head.undoesImport) return true;
    const undone = creationsBelow(head.base, kind, graph);
    return !undone.some((creation) => held.some((other) => sameQuestion(creation, other)));
  });
}

/** the creations among the versions behind these, withdrawn ones passed over */
function creationsBelow(bases: string[], kind: RecordKind, graph: VersionGraph): Ver[] {
  const out: Ver[] = [];
  const seen = new Set<string>();
  const walk = [...bases];
  while (walk.length) {
    const ver = walk.pop()!;
    if (seen.has(ver) || graph.withdrawn(ver)) continue;
    seen.add(ver);
    const version = graph.version(ver);
    if (!version) continue;
    if (isCreation(kind, version)) out.push(version);
    walk.push(...version.base);
  }
  return out;
}

type Snapshot = { kind?: unknown; snapshot?: unknown; removedWith?: unknown; undoesImport?: unknown };
const noteOf = (version: Ver) => version.data as Snapshot | undefined;

/**
 * The rules for the notes in Recently deleted, in order. `questionLive`: whether the question of the same id is live.
 */
export function tombstoneHeads(heads: Ver[], questionLive: () => boolean): Ver[] {
  let standing = heads;
  if (standing.length > 1) standing = oneNoteForTwinDeletes(standing);
  if (standing.length) standing = undoNoteGivesWay(standing, questionLive);
  if (standing.length > 1) standing = newestCopyFirst(standing);
  return standing;
}

/**
 * Two PCs that each undid their import of the same question each put it in Recently deleted: one deletion, the oldest.
 * So too two PCs that each removed the same issues list: each made the same finding's deletion, even when an
 * earlier removal's Undo left the deletion a history (removed, undone, then removed again on both PCs).
 */
function oneNoteForTwinDeletes(heads: Ver[]): Ver[] {
  const twinable = heads.filter((head) => {
    if (head.del) return false;
    const note = noteOf(head);
    const undoneImport = head.base.length === 0 && note?.kind === 'question';
    return undoneImport || (note?.kind === 'finding' && typeof note?.removedWith === 'string');
  });
  return heads.filter((head) => {
    if (!twinable.includes(head)) return true;
    const sameNote = (other: Ver) => sameImported(noteOf(other)?.snapshot, noteOf(head)?.snapshot);
    return !twinable.some((other) => heads.indexOf(other) < heads.indexOf(head) && sameNote(other));
  });
}

/**
 * An import's Undo puts what it took back in Recently deleted, marked as an Undo's. Such a deletion gives way:
 * to a person's deletion of the same question (whose copy may hold what they typed), and to the question itself when
 * another PC's import of it still stands, so the question is not both live and deleted.
 */
function undoNoteGivesWay(heads: Ver[], questionLive: () => boolean): Ver[] {
  const byUndo = (head: Ver) => !head.del && noteOf(head)?.undoesImport === true;
  if (heads.some((head) => !head.del && !byUndo(head))) return heads.filter((head) => !byUndo(head));
  if (heads.every(byUndo) && questionLive()) return [];
  return heads;
}

/**
 * A record deleted on two PCs has two deletion notes, and nobody is asked to choose between those. The note
 * whose copy of the record has the higher version number comes first, the same on every PC. Where one PC deleted a
 * version built on the one the other PC deleted (it edited, then deleted), that is the later one, so Restore brings
 * back the last thing typed whichever PC's clock says it deleted first. Two notes of edits that never met follow the same order;
 * notes of the same version number stay oldest first.
 */
function newestCopyFirst(heads: Ver[]): Ver[] {
  const revOfCopy = (head: Ver) => Number((noteOf(head)?.snapshot as { rev?: unknown } | undefined)?.rev) || 0;
  return heads
    .map((head, index) => ({ head, index }))
    .sort((a, b) => revOfCopy(b.head) - revOfCopy(a.head) || a.index - b.index)
    .map((x) => x.head);
}

/**
 * A checklist item's write that changed only bookkeeping (its sources, say) never stands beside one that turned the
 * item off or on: it is read as that one (linking design, section 5). Only items: other kinds have no such writes.
 */
export function bookkeepingGivesWay(heads: Ver[], graph: VersionGraph): Ver[] {
  const sameAsBase = (head: Ver) => {
    if (head.del || head.base.length === 0) return false;
    return head.base.every((ver) => {
      const parent = graph.version(ver);
      return !!parent && !parent.del && sameContent(parent.data, head.data);
    });
  };
  const changed = heads.filter((head) => !sameAsBase(head));
  return changed.length >= 1 ? changed : heads;
}
