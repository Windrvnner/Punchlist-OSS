import type { Question } from '../domain/model';
import { control } from '../control';
import { askedMatcher } from '../domain/suggest';
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

/** What a point says to the model: its wording, and what it needs when it says so. */
export const pointText = (point: Unresolved) => (point.need ? `${point.what} — needed: ${point.need}` : point.what);

/**
 * Where each unresolved point's offer comes from (#1218). The exact links a person approved are kept first. Every other
 * point gets its best-matching open question as a candidate only when the match's confidence reaches `cutoff`
 * (`limits.askedCutoff`); a question is a candidate for one point only, the one it names most of the words of.
 * The model is asked about the candidates (`confirmedLinks`), never about a match below the cutoff.
 */
export function askedCandidates(
  points: Unresolved[], pool: Question[], approved?: ApprovedLinks, cutoff = control.limits.askedCutoff,
) {
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
  const match = askedMatcher(pool.filter((q) => !taken.has(q.id)));
  const best = new Map<string, AskedCandidate>();
  for (const point of points) {
    const found = kept.has(point.key) ? undefined : match(`${point.what} ${point.need}`);
    const rival = found && best.get(found.q.id);
    if (!found || found.confidence < cutoff || (rival && rival.confidence >= found.confidence)) continue;
    best.set(found.q.id, { point, q: found.q, confidence: found.confidence });
  }
  const order = new Map(points.map((point, index) => [point.key, index]));
  const candidates = [...best.values()].sort((a, b) => order.get(a.point.key)! - order.get(b.point.key)!);
  return { kept: points.flatMap((point) => (kept.has(point.key) ? [{ point: point.key, q: kept.get(point.key)! }] : [])), candidates };
}

/**
 * The candidates the model says already cover their point. A model that is missing, fails, or gives no answer for a
 * pair makes no offer for it: the point is then asked as a new question. Nothing is linked here; a person ticks each one.
 */
export async function confirmedLinks(ai: AiService, dealId: string, candidates: AskedCandidate[]) {
  if (!candidates.length || !ai.covers) return [];
  const checks = candidates.map(({ point, q }) => ({ point: pointText(point), question: q.text }));
  const verdicts = await ai.covers({ dealId, checks });
  if (!verdicts.ok) return [];
  return candidates.filter((_, index) => verdicts.value[index] === true).map(({ point, q }) => ({ point: point.key, q }));
}
