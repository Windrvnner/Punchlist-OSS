/**
 * Pieces of the screens that settle two versions (Resolve design B): a choice card's heading line, and
 * the stepper that moves through every record still in two versions. The stepper is shared by Resolve (resolve.tsx)
 * and the two-PC versions panel (conflict.tsx).
 */
import type { ComponentChildren, HTMLAttributes } from 'preact';
import { Icon } from './icons';

type HeadProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'name'> & {
  picked: boolean;
  name: ComponentChildren;
  /** who changed it and when, quieter than the name */
  meta?: string;
  metaTitle?: string;
};

/**
 * A choice's heading line: its mark, its name and who changed it when. The mark is an empty dot until the choice is
 * picked, then a gray check mark (a selection is marked in gray, not the accent).
 */
export function ChoiceHead({ picked, name, meta, metaTitle, children, ...rest }: HeadProps) {
  return (
    <div class="rsv-l" {...rest}>
      <i class={`rsv-dot ${picked ? 'on' : ''}`} aria-hidden="true">
        {picked && <Icon name="check" size={14} sw={2.25} />}
      </i>
      <b>{name}</b>
      {children}
      {meta && <span title={metaTitle}>{meta}</span>}
    </div>
  );
}

type StepperProps = {
  /** the ids its parts take: `${prefix}-pos`, `${prefix}-prev` and `${prefix}-next` */
  prefix: string;
  /** where this one is in the list, from 0 */
  at: number;
  total: number;
  onStep: (by: -1 | 1) => void;
  prevLabel: string;
  nextLabel: string;
  /** the position's tooltip */
  posTitle?: string;
};

/** "3 of 112", then Previous and Next */
export function Stepper({ prefix, at, total, onStep, prevLabel, nextLabel, posTitle }: StepperProps) {
  const of = `${(at + 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
  return (
    <>
      <span class="stp-pos" id={`${prefix}-pos`} title={posTitle}>{of}</span>
      <span class="rsv-nav">
        <button type="button" class="btn sm ico" id={`${prefix}-prev`} aria-label={prevLabel} title={prevLabel}
          disabled={at <= 0} onClick={() => onStep(-1)}>
          <Icon name="chevup" size={16} />
        </button>
        <button type="button" class="btn sm ico" id={`${prefix}-next`} aria-label={nextLabel} title={nextLabel}
          disabled={at >= total - 1} onClick={() => onStep(1)}>
          <Icon name="chev" size={16} />
        </button>
      </span>
    </>
  );
}
