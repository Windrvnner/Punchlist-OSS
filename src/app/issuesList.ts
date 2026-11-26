import { WORKSTREAMS } from '../domain/model';
import { fail, ok, rejected, type Result } from '../domain/result';
import type { DocumentRef, IssuePoint } from '../ports';
import { issuesListReviewPlan } from './issuesListJoins';
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
