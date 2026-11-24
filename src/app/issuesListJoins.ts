import { key as wording } from '../domain/checklist';
import { fitText } from '../domain/importExport';
import type { Finding } from '../domain/model';
import type { DocumentRef } from '../ports';

type Reference = { join: string } | { after: number };
type Target = Finding | number;

interface Point {
  n: string;
  text: string;
  join?: string;
  suggestedFinding?: string;
  after?: number;
  own?: boolean;
}

interface Destination {
  text: string;
  reference?: Reference;
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
  // The same file's mark wins. An explicit join takes precedence over a revised list's mark or a model suggestion.
  return byDocument.get(listKey(list.docId, key)) ?? byId.get(point.join ?? '')
    ?? byName.get(listKey(list.doc, key)) ?? byId.get(point.suggestedFinding ?? '');
}

/** A numeric target denotes the earlier point whose new finding will hold the mark. */
export function issuesListDestinations(findings: Iterable<Finding>, list: DocumentRef, points: readonly Point[]) {
  const index = findingIndex(findings);
  const destinations: Destination[] = [];
  for (const point of points) {
    const text = fitText(point.text.trim());
    const finding = matchingFinding(index, list, { ...point, text });
    const { after } = point;
    const earlier = after === undefined ? undefined : destinations[after];
    const reference = finding ? { join: finding.id } : earlier && after !== undefined ? { after } : undefined;
    const shown = finding ?? (earlier ? earlier.goes ?? after : undefined);
    destinations.push({ text, reference, shown, goes: point.own ? undefined : shown });
  }
  return destinations;
}
