import { WORKSTREAMS } from '../domain/model';
import { fail, ok, rejected, type Result } from '../domain/result';
import type { DocumentRef, IssuePoint } from '../ports';
import { dealFindings } from './state';
import type { Store } from './store';

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
  const findings = dealFindings(store.get(), dealId).map(({ id, title, body }) => ({ id, title, text: body.join('\n\n') }));
  const doc = attached.value;
  const read = await ai.issuesList({ dealId, doc, findings, workstreams: WORKSTREAMS });
  return read.ok ? ok({ doc, points: read.value.points }) : read;
}
