// The list of past conversations that opens from a composer's Past conversations button.
import { Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, useDismiss, LOCALE } from './hooks';
import { Icon } from './icons';
import { focusOnceInPlace } from './focus';
import { pastConversationList, scopeHash, type PastConversation } from '../app/conversations';
import type { State } from '../app/state';

const DAY_HEADING = { today: 'Today', week: 'Earlier this week', older: 'Older' } as const;

/** When a conversation was last used: the time today, the weekday this week, else the date (and year if not this). */
function when(iso: string, now: Date, group: keyof typeof DAY_HEADING) {
  const then = new Date(iso);
  if (group === 'today') return then.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  if (group === 'week') return then.toLocaleDateString(LOCALE, { weekday: 'short' });
  const year = then.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return then.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year });
}

/**
 * The list fits the room there is (below the ask box, above the composer) and ends on a whole conversation, never on
 * part of one or on a heading.
 */
function fitToRoom(popup: HTMLDivElement, list: HTMLDivElement, below: boolean) {
  const form = popup.closest('form')!.getBoundingClientRect();
  const room = Math.max(200, Math.min(520, below ? innerHeight - form.bottom - 24 : form.top - 24));
  popup.style.maxHeight = room + 'px';
  const listBottom = list.getBoundingClientRect().bottom;
  const rows = [...list.querySelectorAll<HTMLElement>('.prow')];
  const isWhole = (row: HTMLElement) => row.getBoundingClientRect().bottom <= listBottom + 0.5;
  if (rows.every(isWhole)) return;
  const lastWhole = rows.filter(isWhole).pop();
  if (!lastWhole) return;
  const cutOff = listBottom - lastWhole.getBoundingClientRect().bottom;
  popup.style.maxHeight = popup.getBoundingClientRect().height - cutOff + 'px';
}

/** The chosen row stays in view, with its heading when it has one; only the list scrolls, never the page under it. */
function keepChosenInView(list: HTMLDivElement) {
  const row = list.querySelector<HTMLElement>('.prow.on');
  if (!row) return;
  const listBox = list.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.top < listBox.top) {
    const before = row.previousElementSibling as HTMLElement | null;
    const headingHeight = before?.classList.contains('pg') ? before.offsetHeight : 0;
    list.scrollTop -= listBox.top - rowBox.top + headingHeight;
  } else if (rowBox.bottom > listBox.bottom) {
    list.scrollTop += rowBox.bottom - listBox.bottom;
  }
}

/** What the list says when nothing is in it. `searched`: the words searched for, trimmed. */
function emptyMessage(anyAtAll: boolean, searched: string) {
  if (!anyAtAll) return 'No conversations yet.';
  return searched ? `No conversations match “${searched}”.` : 'No conversations about this deal yet.';
}

/** The deal a conversation is about, when every deal's are listed, and the finding or question. */
function aboutTag(state: State, conversation: PastConversation, allDeals: boolean) {
  const dealName = allDeals && conversation.dealId ? state.deals[conversation.dealId]?.name : '';
  return [dealName, conversation.about].filter(Boolean).join(' · ');
}

/**
 * Past conversations: a button in every composer that opens the list over the page. It fades out
 * once something is typed, and comes back when the composer is empty. The list is searchable; on a deal's pages it
 * shows that deal's conversations, or every deal's. Choosing one opens it; Escape or a click outside closes the list.
 * `within` and `opener`: selectors for the composer and its button, which a click on does not close the list;
 * `current`: the open conversation's key; `below`: the list opens down from the ask box, not up from the composer.
 */
export function PastList({ close, within, opener, dealId, current, below }: {
  close: () => void; within: string; opener: string; dealId?: string; current?: string; below: boolean;
}) {
  const store = useStore();
  useAppState();
  useDismiss(true, close, within, opener);
  const [search, setSearch] = useState('');
  const [allDeals, setAllDeals] = useState(!dealId);
  const [chosen, setChosen] = useState(0);
  const { rows, words, now, hasConversations } = pastConversationList(store, { dealId, allDeals, search });
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (popup.current && list.current) fitToRoom(popup.current, list.current, below);
  }, [rows.length, words, allDeals]);
  useLayoutEffect(() => {
    if (list.current) keepChosenInView(list.current);
  }, [chosen]);
  const go = (index: number) => {
    const conversation = rows[index]?.conversation;
    if (!conversation) return;
    close();
    if (conversation.key !== current) location.hash = scopeHash(conversation.scope);
  };
  // the arrows move through the list, wrapping around; Enter opens the row they are on
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const by = e.key === 'ArrowDown' ? 1 : -1;
      if (rows.length) setChosen((at) => (Math.min(at, rows.length - 1) + by + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      go(Math.min(chosen, rows.length - 1));
    }
  };
  const typed = (text: string) => {
    setSearch(text);
    setChosen(0);
  };
  const showDeals = (all: boolean) => {
    setAllDeals(all);
    setChosen(0);
  };
  return (
    <div class={`pastpop ${below ? 'down' : 'up'}`} role="dialog" aria-label="Past conversations" ref={popup}>
      <div class="ptop">
        <label class="psearch"><Icon name="search" size={14} />
          <input id="past-search" placeholder="Search past conversations" aria-label="Search past conversations"
            value={search} ref={focusOnceInPlace} onKeyDown={keys}
            onInput={(e) => typed((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {dealId && <DealToggle allDeals={allDeals} showDeals={showDeals} />}
      </div>
      <div class="plist" ref={list} role="listbox" aria-label="Conversations">
        {!rows.length && <p class="pnone">{emptyMessage(hasConversations, search.trim())}</p>}
        <PastRows rows={rows} now={now} allDeals={allDeals} chosen={chosen} current={current}
          choose={setChosen} go={go} />
      </div>
    </div>
  );
}

/** The conversations, under a heading for each day group: today, earlier this week, older. */
function PastRows({ rows, now, allDeals, chosen, current, choose, go }: {
  rows: ReturnType<typeof pastConversationList>['rows']; now: Date; allDeals: boolean; chosen: number;
  current?: string; choose: (index: number) => void; go: (index: number) => void;
}) {
  const state = useAppState();
  return (
    <>
      {rows.map(({ conversation, group, startsGroup }, i) => (
        <Fragment key={conversation.key}>
          {startsGroup && <div class="pg">{DAY_HEADING[group]}</div>}
          <PastRow conversation={conversation} about={aboutTag(state, conversation, allDeals)}
            when={when(conversation.at, now, group)} chosen={i === chosen} current={conversation.key === current}
            onHover={() => choose(i)} onGo={() => go(i)} />
        </Fragment>
      ))}
    </>
  );
}

/** Which conversations the list shows, on a deal's pages: that deal's or every deal's. */
function DealToggle({ allDeals, showDeals }: { allDeals: boolean; showDeals: (all: boolean) => void }) {
  return (
    <div class="pseg" role="radiogroup" aria-label="Show">
      <button type="button" role="radio" aria-checked={!allDeals} class={!allDeals ? 'on' : ''}
        onClick={() => showDeals(false)}>This Deal</button>
      <button type="button" role="radio" aria-checked={allDeals} class={allDeals ? 'on' : ''}
        onClick={() => showDeals(true)}>All Deals</button>
    </div>
  );
}

/**
 * One conversation in the list: its title, what it is about and when it was last used, and the start of its latest
 * answer. `chosen`: the row the arrow keys are on; `current`: the conversation open now.
 */
function PastRow({ conversation, about, when, chosen, current, onHover, onGo }: {
  conversation: PastConversation; about: string; when: string; chosen: boolean; current: boolean;
  onHover: () => void; onGo: () => void;
}) {
  const click = (e: MouseEvent) => {
    e.preventDefault();
    onGo();
  };
  return (
    <a href={`#${scopeHash(conversation.scope)}`} role="option" aria-selected={chosen}
      aria-current={current ? 'true' : undefined} class={`prow ${chosen ? 'on' : ''}`} onMouseEnter={onHover}
      onClick={click}>
      <span class="pt">{conversation.title}</span>
      <span class="pm">{about && <span class="pa" title={about}>{about}</span>}{when}</span>
      {conversation.preview && <span class="pp">{conversation.preview}</span>}
    </a>
  );
}
