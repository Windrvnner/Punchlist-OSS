import { removable } from './commands/issuesList';
import type { ShownNote } from './commands/keptVersions';
import type { State } from './state';

type DeletedState = Pick<State, 'tombstones'> & Partial<Pick<State, 'conflicts' | 'questions' | 'findings'>>;
type DeletedKind = 'finding' | 'question';

/** A restored record or a record in conflict stays out of Deleted, including entries for its competing versions. */
export function visibleDeletedNotes(state: DeletedState, dealId: string, kind?: DeletedKind) {
  return Object.values(state.tombstones).filter((note) => {
    if (note.dealId !== dealId || (note.kind !== 'finding' && note.kind !== 'question')) return false;
    if (kind && note.kind !== kind) return false;
    if (state.conflicts?.[(note as ShownNote).of ?? note.id]) return false;
    return !(note.kind === 'question' ? state.questions?.[note.id] : state.findings?.[note.id]);
  });
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
    .filter(({ made, joined }) => made.length > 0 || joined.length > 0);
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
