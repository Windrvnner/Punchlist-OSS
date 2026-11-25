import { fmtDateTime, formatDateTime } from '../domain/dateTime';
import { issuesListTitle } from './issuesList';
import { removable } from './commands/issuesList';
import type { DeletedCopy, ShownNote } from './commands/keptVersions';
import type { State } from './state';

type DeletedState = Pick<State, 'tombstones'> & Partial<Pick<State, 'conflicts' | 'questions' | 'findings'>>;
type DeletedKind = 'finding' | 'question';

/** A restored record or a record in conflict stays out of Deleted, including entries for its competing versions. */
export function visibleDeletedNotes(state: DeletedState, dealId: string, kind?: DeletedKind): ShownNote[] {
  return Object.values(state.tombstones).filter((note) => {
    if (note.dealId !== dealId || (note.kind !== 'finding' && note.kind !== 'question')) return false;
    if (kind && note.kind !== kind) return false;
    if (state.conflicts?.[(note as ShownNote).of ?? note.id]) return false;
    return !(note.kind === 'question' ? state.questions?.[note.id] : state.findings?.[note.id]);
  }).sort((a, b) => b.at.localeCompare(a.at));
}

type ListsState = Pick<State, 'findings' | 'questions'> & Partial<Pick<State, 'threads'>>;

function removableLists(state: ListsState, dealId: string) {
  // A list is its file. A revised list saved under the same name is a separate import.
  const names = new Map<string, string>();
  for (const finding of Object.values(state.findings)) {
    if (finding.dealId !== dealId) continue;
    for (const mark of finding.onLists ?? []) {
      if (!names.has(mark.doc)) names.set(mark.doc, mark.list);
    }
  }
  return [...names].map(([doc, list]) => ({ doc, list, ...removable(state, dealId, doc) }))
    .filter(({ made, joined }) => made.length > 0 || joined.length > 0)
    .sort((a, b) => a.list.localeCompare(b.list) || a.at.localeCompare(b.at) || a.doc.localeCompare(b.doc));
}

let listsMemo: (ListsState & { dealId: string; lists: ReturnType<typeof removableLists> }) | undefined;
export function removableIssuesLists(state: ListsState, dealId: string) {
  const { findings, questions, threads } = state;
  const memo = listsMemo;
  if (memo?.dealId === dealId && memo.findings === findings && memo.questions === questions
    && memo.threads === threads) return memo.lists;
  const lists = removableLists(state, dealId);
  listsMemo = { findings, questions, threads, dealId, lists };
  return lists;
}


export interface DeletedRow {
  key: string;
  t: ShownNote;
  copy?: DeletedCopy;
  snapshot: unknown;
  at: string;
  actor: string;
  from?: string;
}

export function deletedRows(notes: ShownNote[]): DeletedRow[] {
  return notes.flatMap((note) => [
    { key: note.id, t: note, snapshot: note.snapshot, at: note.at, actor: note.actor, from: note.from },
    ...(note.copies ?? []).map((copy) => ({
      key: `${note.id}@${copy.ver}`, t: note, copy, snapshot: copy.snapshot,
      at: copy.at, actor: copy.actor, from: copy.from,
    })),
  ]).sort((a, b) => b.at.localeCompare(a.at));
}

export function deletedGroups(state: DeletedState, dealId: string) {
  const rows = deletedRows(visibleDeletedNotes(state, dealId));
  return (['finding', 'question'] as const).map((kind) => ({
    kind, rows: rows.filter((row) => row.t.kind === kind),
  })).filter(({ rows }) => rows.length);
}

/** Separate revisions of one issues list by import time, to the second when they share a minute. */
export function deletedIssuesLists(state: ListsState, dealId: string) {
  const lists = removableIssuesLists(state, dealId);
  return lists.map((list) => {
    const title = issuesListTitle(list.list);
    const twins = lists.filter((other) => other !== list && issuesListTitle(other.list) === title);
    const minute = fmtDateTime(list.at);
    const seconds = twins.some((other) => other.at && fmtDateTime(other.at) === minute);
    return { ...list, title, twin: twins.length > 0, when: list.at ? formatDateTime(list.at, seconds) : '' };
  });
}
