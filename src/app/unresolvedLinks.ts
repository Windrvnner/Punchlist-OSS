import type { Question } from '../domain/model';
import { control } from '../control';
import { askedMatcher, reaches } from '../domain/askedMatch';
import type { AiService } from '../ports';
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

/** An open question that names enough of a point's words for the model to be asked whether it covers the point. */
export type AskedCandidate = { point: Unresolved; q: Question; confidence: number };

/**
 * What a point says, to the keyword match and to the model alike: its wording and what it needs (a finding needs
 * nothing, so its title alone). The confidence is worked out the same way for a gap and a finding.
 */
export const pointText = (point: Unresolved) => `${point.what} ${point.need}`.trim();

/** The exact links a person approved that still hold, by point key: each question is kept for one point only. */
function keepApproved(points: Unresolved[], pool: Question[], approved?: ApprovedLinks) {
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

/** A question is a candidate for one point only: the one that names most of its words (the earlier on a tie). */
function strongestPerQuestion(points: Unresolved[], pool: Question[], cutoff: number) {
  const match = askedMatcher(pool);
  const best = new Map<string, AskedCandidate>();
  for (const point of points) {
    const found = match(pointText(point));
    if (!found || !reaches(found, cutoff)) continue;
    const rival = best.get(found.q.id);
    if (!rival || found.confidence > rival.confidence) {
      best.set(found.q.id, { point, q: found.q, confidence: found.confidence });
    }
  }
  return [...best.values()];
}

/**
 * Where each unresolved point's offer comes from (#1218). The exact links a person approved are kept first. Every other
 * point gets its best-matching open question as a candidate only when the match's confidence reaches `cutoff`
 * (`limits.askedCutoff`). The model is asked about the candidates (`confirmedLinks`), never about a match below it.
 */
export function askedCandidates(
  points: Unresolved[], pool: Question[], approved?: ApprovedLinks, cutoff = control.limits.askedCutoff,
) {
  const kept = keepApproved(points, pool, approved);
  const taken = new Set([...kept.values()].map((q) => q.id));
  const open = points.filter((point) => !kept.has(point.key));
  const order = new Map(points.map((point, index) => [point.key, index]));
  const candidates = strongestPerQuestion(open, pool.filter((q) => !taken.has(q.id)), cutoff)
    .sort((a, b) => order.get(a.point.key)! - order.get(b.point.key)!);
  const links = points.flatMap((point) => {
    const q = kept.get(point.key);
    return q ? [{ point: point.key, q }] : [];
  });
  return { kept: links, candidates };
}

/**
 * The candidates the model says already cover their point. A model that is missing, fails, rejects the call, or
 * gives no answer for a pair makes no offer for it: the point is then asked as a new question. Nothing is linked
 * here; a person ticks each one.
 */
export async function confirmedLinks(ai: AiService, dealId: string, candidates: AskedCandidate[]) {
  if (!candidates.length || !ai.covers) return [];
  const checks = candidates.map(({ point, q }) => ({ point: pointText(point), question: q.text }));
  const verdicts = await ai.covers({ dealId, checks }).catch(() => undefined);
  if (!verdicts?.ok) return [];
  const confirmed = candidates.filter((_, index) => verdicts.value[index] === true);
  return confirmed.map(({ point, q }) => ({ point: point.key, q }));
}
