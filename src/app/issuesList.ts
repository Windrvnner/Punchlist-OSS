import { WORKSTREAMS, type ListPoint } from '../domain/model';
import { fail, ok, rejected, type Result } from '../domain/result';
import type { DocumentRef, IssuePoint } from '../ports';
import { ImportIssuesList } from './commands/issuesList';
import { issuesListReviewPlan } from './issuesListJoins';
import { dropImport, keepImport, keptImport } from './keptImports';
import { dealFindings, type State } from './state';
import type { Store } from './store';

export const issuesListTitle = (name: string) => name.replace(/\.[A-Za-z0-9]{2,5}$/, '');

export interface ReadIssuesList {
  doc: DocumentRef;
  points: IssuePoint[];
}

type IssuesListFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> };

/** Attach the list and read its points against all the deal's findings, including closed ones. */
export async function readIssuesList(
  store: Store, dealId: string, file: IssuesListFile, stillCurrent = () => true,
): Promise<Result<ReadIssuesList> | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const attached = await store.services.docs.attach(dealId, { name: file.name, bytes });
  if (!stillCurrent()) return;
  if (!attached.ok) return attached;
  const ai = store.services.ai;
  if (!ai.issuesList) return fail(rejected('Issues list reading is unavailable'));
  const findings = dealFindings(store.get(), dealId).map(({ id, title, body }) => ({
    id, title, text: body.join('\n\n'),
  }));
  const doc = attached.value;
  const read = await ai.issuesList({ dealId, doc, findings, workstreams: WORKSTREAMS });
  return read.ok ? ok({ doc, points: read.value.points }) : read;
}

/** A list pasted as text, read as a text file of its own (the way a file chosen is): the file's words are the paste. */
export function readPastedIssuesList(store: Store, dealId: string, text: string, stillCurrent = () => true) {
  const bytes = new TextEncoder().encode(text);
  const file = { name: 'Pasted issues list.txt', arrayBuffer: async () => bytes.buffer as ArrayBuffer };
  return readIssuesList(store, dealId, file, stillCurrent);
}

/** The preview uses ImportIssuesList's join rules, with the model's matches treated as proposals. */
export function reviewIssuesList(state: State, dealId: string, list: ReadIssuesList, kept: ReadonlySet<number>) {
  const { doc, points } = list;
  const { references, destinations } = issuesListReviewPlan(dealFindings(state, dealId), doc, points, kept);
  const shown = destinations.map((point) => point.shown);
  const goes = destinations.map((point) => point.goes);
  const raised = shown.flatMap((target, index) => target === undefined ? [] : [index]);
  const fresh = goes.flatMap((target, index) => target === undefined ? [index] : []);
  const input = points.map(({ n, text, title, workstream }, index) => ({
    n, text, title, workstream,
    ...(kept.has(index) ? { own: true } : references[index]),
  }));
  return { shown, goes, raised, fresh, input };
}

/** The issues list as it was left: the list as the model read it, and the points checked to keep separate */
export type IssuesListKept = {
  list: ReadIssuesList;
  kept: Set<number>;
};

function isKeptPoint(point: IssuePoint | undefined) {
  return !!point && typeof point.n === 'string' && typeof point.text === 'string' && typeof point.title === 'string'
    && typeof point.workstream === 'string';
}

/** What was kept, if it is still a whole issues list import; a damaged entry opens the import fresh. */
export function keptIssuesList(key: string): IssuesListKept | null {
  const kept = keptImport(key) as IssuesListKept | undefined;
  const doc = kept?.list?.doc;
  const readable = !!doc && typeof doc.docId === 'string' && typeof doc.doc === 'string'
    && Array.isArray(kept.list.points) && kept.kept instanceof Set && kept.list.points.every(isKeptPoint);
  return readable ? kept : null;
}

/** The paste typed into the box and not yet read, as it was kept; nothing if what was kept is not text (#1021). */
export function keptIssuesPaste(key: string): string {
  const paste = keptImport(key)?.paste;
  return typeof paste === 'string' ? paste : '';
}

/**
 * Keeps the paste box as typed, so closing or a reload loses none of it (#1021). Nothing is written for an empty box
 * unless one was kept; opened past a kept import it could not show (`fresh`), that one is left until something is
 * typed.
 */
export function keepIssuesPaste(key: string, paste: string, fresh: boolean) {
  if (paste.trim() || (!fresh && keptIssuesPaste(key))) keepImport(key, { paste });
}

/** What Import sends for the list: the points as reviewed (reviewIssuesList's input). */
export interface IssuesListSubmission {
  dealId: string;
  list: ReadIssuesList;
  points: ReturnType<typeof reviewIssuesList>['input'];
}

/**
 * Imports the list. The kept list is let go first, so a reload while it runs never offers it again; a failure keeps
 * it again as it is then (`now`), not as Import found it.
 */
export async function submitIssuesList(
  store: Store, key: string, { dealId, list, points }: IssuesListSubmission, now: () => IssuesListKept | null,
) {
  dropImport(key);
  const input = { dealId, doc: list.doc.docId, list: list.doc.doc, points };
  const idempotencyKey = `issues-${dealId}-${list.doc.docId}`;
  const result = await store.dispatch(ImportIssuesList, input, { idempotencyKey });
  const keptNow = result.ok ? null : now();
  if (keptNow) keepImport(key, keptNow);
  return result;
}

/** A finding's points by list, as each list's file is its own list: two saved under one name get a heading each. */
export function pointsByList(marks: ListPoint[]): { title: string; points: ListPoint[] }[] {
  const docs = [...new Set(marks.map((mark) => mark.doc))];
  return docs.map((doc) => {
    const points = marks.filter((mark) => mark.doc === doc);
    return { title: issuesListTitle(points[0].list), points };
  });
}
