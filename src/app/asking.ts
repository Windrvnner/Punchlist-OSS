import type { Finding, Question } from '../domain/model';
import type { ItemStanding, NamedItem, State } from './state';

export type AskBlock = 'closed-finding' | 'off-item';

/** A new linked question is for an open finding or a gap on an active item. */
export function askBlock(status: Finding['status'] | undefined, itemOff: boolean): AskBlock | null {
  if (status === 'closed') return 'closed-finding';
  return itemOff ? 'off-item' : null;
}

export function findingAskTarget(finding: Finding, item: NamedItem | null) {
  return {
    block: askBlock(finding.status, !!item?.off),
    links: {
      workstream: finding.workstream,
      linkedFinding: finding.id,
      linkedItem: item?.off ? undefined : item?.id,
    },
  };
}

/** Keep offering a draft set aside on an active item. A new gap question is offered only once. */
export function checklistAsk(standing: ItemStanding, itemOff: boolean, asked: number, kept: boolean) {
  const active = !askBlock(undefined, itemOff);
  const gap = standing.kind === 'gap';
  const canAsk = active && (gap || (standing.kind === 'finding' && !!standing.finding));
  return { canAsk, offerAsk: active && (kept || (canAsk && (!gap || !asked))) };
}

/** Questions about the item or its finding, in question number order. */
export function askedAbout(
  state: Pick<State, 'questions'>, dealId: string, itemId: string | null, finding?: Pick<Finding, 'id'>,
): Question[] {
  const aboutItem = (question: Question) => itemId !== null && question.linkedItem?.id === itemId;
  const aboutFinding = (question: Question) => !!finding && question.linkedFinding === finding.id;
  return Object.values(state.questions)
    .filter((question) => question.dealId === dealId && (aboutItem(question) || aboutFinding(question)))
    .sort((first, second) => first.n - second.n);
}

/** A turned-off item's own questions are listed separately from those about its findings. */
export const askedAtGap = (state: Pick<State, 'questions'>, dealId: string, itemId: string) =>
  askedAbout(state, dealId, itemId).filter((question) => !question.linkedFinding);
