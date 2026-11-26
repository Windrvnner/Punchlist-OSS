import type { Question } from '../domain/model';
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

/** The exact approved links a person chose (#88), by point: each question kept for one point only. */
export function keptLinks(points: Unresolved[], pool: Question[], approved?: ApprovedLinks) {
  const kept = new Map<string, Question>();
  if (!approved?.size) return kept;
  const available = new Map(pool.map((q) => [q.id, q]));
  const taken = new Set<string>();
  for (const point of points) {
    const choice = approved.get(point.key);
    const q = choice && available.get(choice.questionId);
    if (!q || taken.has(q.id) || !isApprovedLink({ point, q }, choice)) continue;
    kept.set(point.key, q);
    taken.add(q.id);
  }
  return kept;
}

/**
 * The kept links, then for each other point the first question the model proposed for it (#1120), each question
 * offered once. `proposed` lists question ids by point key.
 */
export function suggestUnresolvedLinks(
  points: Unresolved[], pool: Question[], kept: ReadonlyMap<string, Question>,
  proposed: ReadonlyMap<string, readonly string[]>,
) {
  const byId = new Map(pool.map((q) => [q.id, q]));
  const taken = new Set([...kept.values()].map((q) => q.id));
  const links: { point: string; q: Question }[] = [];
  for (const point of points) {
    const proposals = (proposed.get(point.key) ?? []).map((id) => byId.get(id));
    const q = kept.get(point.key) ?? proposals.find((proposal) => proposal && !taken.has(proposal.id));
    if (!q) continue;
    taken.add(q.id);
    links.push({ point: point.key, q });
  }
  return links;
}
