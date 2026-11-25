import type { Question } from '../domain/model';
import { addresser } from '../domain/suggest';
import type { Unresolved } from './state';

export type UnresolvedLink = { point: Unresolved; q: Question };
export type LinkApproval = { questionId: string; fingerprint: string };
export type ApprovedLinks = ReadonlyMap<string, LinkApproval>;

export const unresolvedPointFingerprint = (point: Unresolved) => JSON.stringify([
  point.key, point.kind, point.what, point.need, point.workstream, point.itemId, point.findingId,
]);

/** The recommendation's inputs, kept with the exact question and point a person chose (#88). */
export const linkApproval = ({ point, q }: UnresolvedLink): LinkApproval => ({
  questionId: q.id,
  fingerprint: JSON.stringify([unresolvedPointFingerprint(point), q.text]),
});

export function isApprovedLink(link: UnresolvedLink, approved: LinkApproval | undefined): boolean {
  return approved?.questionId === link.q.id && approved.fingerprint === linkApproval(link).fingerprint;
}

export function canLinkUnresolved(q: Question, conflicted: boolean): boolean {
  return q.status === 'open' && !!q.text.trim() && !q.response.trim()
    && !q.linkedItem && !q.linkedFinding && !conflicted;
}

/** Reserve the exact approved links before offering guesses for the remaining points. */
export function suggestUnresolvedLinks(points: Unresolved[], pool: Question[], approved?: ApprovedLinks) {
  const kept = new Map<string, Question>();
  const taken = new Set<string>();
  if (approved?.size) {
    const available = new Map(pool.map((q) => [q.id, q]));
    for (const point of points) {
      const choice = approved.get(point.key);
      const q = choice && available.get(choice.questionId);
      if (!q || taken.has(q.id) || !isApprovedLink({ point, q }, choice)) continue;
      kept.set(point.key, q);
      taken.add(q.id);
    }
  }
  const likely = addresser(pool.filter((q) => !taken.has(q.id)));
  const links: { point: string; q: Question }[] = [];
  for (const point of points) {
    const q = kept.get(point.key) ?? likely(`${point.what} ${point.need}`).find((guess) => !taken.has(guess.id));
    if (!q) continue;
    taken.add(q.id);
    links.push({ point: point.key, q });
  }
  return links;
}
