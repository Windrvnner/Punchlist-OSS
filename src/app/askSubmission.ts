import { z } from 'zod';
import { FindingId } from '../domain/model';
import { fail, notFound, ok, rejected } from '../domain/result';
import { findingAskTarget } from './asking';
import { checklistQuestionTarget } from './checklistQuestion';
import { findingItem, namedItem, type State } from './state';

export const AskOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finding'), findingId: FindingId }),
  z.object({ kind: z.literal('checklist'), itemId: z.string().min(1), findingId: FindingId.optional() }),
]);

function fromFinding(state: State, dealId: string, findingId: string) {
  const finding = state.findings[findingId];
  if (finding?.dealId !== dealId) return fail(notFound('That finding is not on this deal', findingId));
  const target = findingAskTarget(finding, findingItem(state, finding));
  return target.why ? fail(rejected(target.why)) : ok(target.links);
}

function fromChecklist(state: State, dealId: string, itemId: string, findingId?: string) {
  const item = namedItem(state, dealId, itemId);
  if (!item) return fail(notFound('That item is not on this deal’s checklist', itemId));
  const rows = state.checklists[dealId];
  const checked = Array.isArray(rows) ? rows.find(({ id }) => id === itemId) : undefined;
  // A gap draft cannot silently switch to a newly raised finding while its save waits.
  const unchecked = { id: item.id, text: item.text, result: 'unchecked' as const, docs: [] };
  const row = !findingId && checked?.result !== 'gap' ? unchecked : checked ?? unchecked;
  const target = checklistQuestionTarget(state, row, item.off, findingId);
  return target.why ? fail(rejected(target.why)) : ok(target.links);
}

/** Resolve the links from current state when the numbered write reaches its turn. */
export function linksForAsk(state: State, dealId: string, origin: z.infer<typeof AskOrigin>) {
  if (origin.kind === 'finding') return fromFinding(state, dealId, origin.findingId);
  return fromChecklist(state, dealId, origin.itemId, origin.findingId);
}
