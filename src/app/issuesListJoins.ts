import { key as wording } from '../domain/checklist';
import { fitText } from '../domain/importExport';
import type { Finding } from '../domain/model';
import type { DocumentRef, IssuePoint } from '../ports';

type Reference = { join: string } | { after: number };
type Target = Finding | number;

interface Point {
  n: string;
  text: string;
  join?: string;
  after?: number;
  own?: boolean;
}

interface Destination {
  text: string;
  shown?: Target;
  goes?: Target;
}

const pointKey = ({ n, text }: Point) => `${n}\u0001${wording(text)}`;
const listKey = (list: string, point: string) => `${list}\u0001${point}`;

function remember(index: Map<string, Finding>, key: string, finding: Finding) {
  const previous = index.get(key);
  // Use the lowest ID so PCs agree when more than one finding holds a mark.
  if (!previous || finding.id < previous.id) index.set(key, finding);
}

function findingIndex(findings: Iterable<Finding>) {
  const byId = new Map<string, Finding>();
  const byDocument = new Map<string, Finding>();
  const byName = new Map<string, Finding>();
  for (const finding of findings) {
    byId.set(finding.id, finding);
    for (const mark of finding.onLists ?? []) {
      const key = pointKey(mark);
      remember(byDocument, listKey(mark.doc, key), finding);
      remember(byName, listKey(mark.list, key), finding);
    }
  }
  return { byId, byDocument, byName };
}

function matchingFinding(index: ReturnType<typeof findingIndex>, list: DocumentRef, point: Point) {
  const { byId, byDocument, byName } = index;
  const key = pointKey(point);
  // The same file's mark wins. An explicit join takes precedence over a revised list's mark.
  return byDocument.get(listKey(list.docId, key)) ?? byId.get(point.join ?? '')
    ?? byName.get(listKey(list.doc, key));
}

/** A numeric target denotes the earlier point whose new finding will hold the mark. */
function destinationsFor(index: ReturnType<typeof findingIndex>, list: DocumentRef, points: readonly Point[]) {
  const destinations: Destination[] = [];
  for (const point of points) {
    const text = fitText(point.text);
    const finding = matchingFinding(index, list, { ...point, text });
    const { after } = point;
    const earlier = after === undefined ? undefined : destinations[after];
    const shown = finding ?? (earlier ? earlier.goes ?? after : undefined);
    destinations.push({ text, shown, goes: point.own ? undefined : shown });
  }
  return destinations;
}

export function issuesListDestinations(findings: Iterable<Finding>, list: DocumentRef, points: readonly Point[]) {
  return destinationsFor(findingIndex(findings), list, points);
}

function proposedReference(
  index: ReturnType<typeof findingIndex>, list: DocumentRef, point: IssuePoint, position: number,
): Reference | undefined {
  const found = matchingFinding(index, list, { n: point.n, text: fitText(point.text) });
  if (found) return { join: found.id };
  const same = point.same;
  if (!same) return;
  if ('finding' in same) return index.byId.has(same.finding) ? { join: same.finding } : undefined;
  if (Number.isInteger(same.point) && same.point >= 0 && same.point < position) return { after: same.point };
}

export function issuesListReviewPlan(
  findings: Iterable<Finding>, list: DocumentRef, points: readonly IssuePoint[], kept: ReadonlySet<number>,
) {
  const index = findingIndex(findings);
  // The attached name, as given, picks the explicit join; the command then sees the same name (#409).
  const references = points.map((point, position) => proposedReference(index, list, point, position));
  const choices = points.map(({ n, text }, position) => ({
    n, text, own: kept.has(position), ...references[position],
  }));
  return { references, destinations: destinationsFor(index, list, choices) };
}
