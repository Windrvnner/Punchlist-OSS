import { useLayoutEffect, useRef } from 'preact/hooks';
import { wholeRows } from './pickList';
import { ChoiceCheck } from './moreMenu';

/** One option of a menu section: the value it sets and the words it shows. */
export type MenuOption<T extends string> = readonly [value: T, label: string];

/**
 * A choice of one in a menu, under its section label. The chosen row is checked on a light highlight, as every menu
 * marks its choice (design.md, Menus); the radio is kept for the keyboard and screen readers but not drawn.
 * The filter menus of Findings and Q&A use it in place of dropdowns. A click, Space or Enter
 * picks, the option already chosen too, so a menu that closes on a pick closes then as well. A `long` section keeps its
 * first option ("All …") above and, with `pinLast`, its last ("No …") below a rule, with the rest scrolling between
 * them in whole rows (design.md, Menus, Order; as pickList's menus do).
 */
export function MenuChoice<T extends string>({ title, name, options, value, onPick, long, pinLast }: {
  title: string; name: string; options: MenuOption<T>[]; value: T; onPick: (value: T) => void;
  long?: boolean; pinLast?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sc = scroll.current; const menu = sc?.closest<HTMLElement>('.colmenu');
    if (!sc || !menu) return;
    // the menu reaches down to 12px above the window's foot, so a short window shows as many rows as fit
    menu.style.maxHeight = `${Math.max(160, innerHeight - menu.getBoundingClientRect().top - 12)}px`;
    wholeRows(sc);
  }, []);
  const row = ([v, label]: MenuOption<T>) => (
    <label key={v} class={v === value ? 'on' : undefined}>
      <input type="radio" name={name} value={v} class={v === value ? 'on' : undefined} checked={v === value}
        onClick={() => onPick(v)} onKeyDown={(e) => pickOnEnter(e, () => onPick(v))} />
      <span>{label}</span><ChoiceCheck on={v === value} />
    </label>
  );
  const [first, ...rest] = options;
  const middle = pinLast ? rest.slice(0, -1) : rest;
  return (
    <div class={`mchoice ${long ? 'long' : ''}`} role="radiogroup" aria-label={title}>
      <div class="mlbl" aria-hidden="true">{title}</div>
      {long ? <>
        {first && row(first)}
        <div class="scroll" ref={scroll}>{middle.map(row)}</div>
        {pinLast && rest.length > 0 && <><div class="msep" />{row(rest[rest.length - 1])}</>}
      </> : options.map(row)}
    </div>
  );
}

function pickOnEnter(e: KeyboardEvent, pick: () => void) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  pick();
}

/** A workstream filter's options: "All workstreams" first, then the names in the order given (decisions.md, Lists). */
export const workstreamOptions = (names: string[]): MenuOption<string>[] =>
  [['', 'All Workstreams'], ...names.map((w) => [w, w] as const)];
