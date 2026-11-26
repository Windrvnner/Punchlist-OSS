import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { findingsView } from '../app/findingsView';
import { NO_WORKSTREAM } from '../app/state';
import { MenuChoice, workstreamOptions, type MenuOption } from './filterMenu';
import { useDismiss, useStore } from './hooks';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';

type FindingsView = ReturnType<typeof findingsView>;

function findingsStatusLabels(view: FindingsView) {
  const { counts } = view;
  const labels = {
    open: `Open ${counts.open}`,
    reassess: `To update ${counts.reassess}`,
    closed: `Closed ${counts.closed}`,
    all: 'All',
  };
  return view.statusOptions.map((status) => [status, labels[status]] as const);
}

// 0 words and status in the row · 1 icon buttons · 2 status menu · 3 status menu and icon buttons
function useFindingsHeadMode(choice: boolean, statuses: ReturnType<typeof findingsStatusLabels>, more: boolean) {
  const row = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState(0);
  const [, resized] = useState(0);
  const seen = useRef({ w: -1, sig: '' });
  const sig = `${choice}|${statuses.map((entry) => entry[1]).join()}|${more}`;
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    if (seen.current.sig !== sig || seen.current.w !== el.clientWidth) {
      seen.current = { w: el.clientWidth, sig };
      if (mode !== 0) {
        setMode(0);
        return;
      }
    }
    if (el.scrollWidth > el.clientWidth + 1 && mode < 3) setMode(mode + 1);
  });
  useEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== seen.current.w) resized((count) => count + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { row, mode };
}

/**
 * The Findings heading and everything that acts on the list, in one row. As the row narrows it gives up only what it
 * must, in this order: everything in words; the buttons as icons; the status filter folded into the filter symbol with
 * the buttons back in words; both as icons. Which of these fits is measured, not guessed from the window's width.
 */
export function FindingsHead({ view, adding, onNew, children }: {
  view: FindingsView; adding: boolean; onNew: () => void; children: ComponentChildren;
}) {
  const store = useStore();
  const { filter: FF, many, showStatus: choice, workstreams: wsl } = view;
  const set = (patch: Partial<typeof FF>) => store.ui({ findingFilter: { ...FF, ...patch } });
  const statuses = findingsStatusLabels(view);
  const hasExtraFilters = [FF.workstream, FF.reviewed].some(Boolean);
  const more = many || hasExtraFilters;
  const { row, mode } = useFindingsHeadMode(choice, statuses, more);
  const icons = mode % 2 === 1;
  const folded = mode >= 2 && choice;
  const [menu, setMenu] = useState(false);
  useDismiss(menu, () => setMenu(false), '.fhead .fwrap');
  const hidden = (folded && FF.status !== 'open') || hasExtraFilters;
  const filterLabel = hidden ? 'Filter (on)' : 'Filter';
  return (
    <div class="lbl flagsl fhead" ref={row} data-fhead={mode}>
      <span class="h" role="heading" aria-level={2}>Findings</span>
      {choice && !folded && <div class="seg">{statuses.map(([k, label]) => (
        <button type="button" key={k} class={FF.status === k ? 'on' : ''} aria-pressed={FF.status === k}
          data-fstatusf={k} onClick={() => set({ status: k })}>{label}</button>
      ))}</div>}
      {(folded || more) && <span class="fwrap">
        <button type="button" class={`btn sm ico ${hidden ? 'on' : ''}`} id="f-filter"
          aria-haspopup="menu" aria-expanded={menu} title={filterLabel} aria-label={filterLabel}
          onClick={() => setMenu(!menu)}><Icon name="filter" size={14} /></button>
        {/* statuses alone are a menu of choices; with Workstream and Reviewed it is a group of controls */}
        {menu && <div class="colmenu fmenu"
          {...(more ? { role: 'group', 'aria-label': 'Filter', 'data-menu': true } : { role: 'menu' })}>
          {folded && statuses.map(([k, l]) => <StatusChoice key={k} status={k} label={l} on={FF.status === k}
            inMenu={!more} pick={() => {
              set({ status: k });
              if (!more) setMenu(false);
            }} />)}
          {folded && more && <div class="msep" />}
          {more && <>
            <MenuChoice title="Workstream" name="f-ws" options={workstreamOptions(wsl)} value={FF.workstream}
              onPick={(workstream) => set({ workstream })} long pinLast={wsl.at(-1) === NO_WORKSTREAM} />
            <div class="msep" />
            <MenuChoice title="Reviewed" name="f-rev" options={REVIEWED} value={FF.reviewed}
              onPick={(reviewed) => set({ reviewed })} />
          </>}
        </div>}
      </span>}
      <span class="sp" />
      <NewFindingButton icons={icons} adding={adding} onNew={onNew} />
      {children}
    </div>
  );
}

function NewFindingButton({ icons, adding, onNew }: { icons: boolean; adding: boolean; onNew: () => void }) {
  const label = 'New Finding';
  const iconLabel = icons ? { title: label, 'aria-label': label } : {};
  return <button type="button" class={`btn sm act ${icons ? 'ico' : ''}`} id="f-new"
    {...iconLabel} aria-expanded={adding} onClick={onNew}>
    <Icon name="plus" size={14} />{icons ? null : <span>{label}</span>}
  </button>;
}

/** The Reviewed section of the Findings filter menu, in the dropdown's old order. */
const REVIEWED: MenuOption<'' | 'yes' | 'no'>[] =
  [['', 'Reviewed or Not'], ['yes', 'Reviewed'], ['no', 'Not Reviewed']];

/**
 * One status in the Findings filter: a choice in its menu, or, beside the filter's other controls, a pressed button.
 * The one on is checked (design.md, Menus).
 */
function StatusChoice({ status, label, on, inMenu, pick }: {
  status: string; label: string; on: boolean; inMenu: boolean; pick: () => void;
}) {
  const role = inMenu ? { role: 'menuitemradio' as const, 'aria-checked': on } : { 'aria-pressed': on };
  return <button type="button" {...role} class={`mi ${on ? 'on' : ''}`} data-fstatusf={status} onClick={pick}>
    {label}<ChoiceCheck on={on} />
  </button>;
}
