
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { Modal } from './dialogs';
import { Fragment } from 'preact';
import { DEAL_PAGES } from '../app/state';
import { SharedFolderRow } from './connect';
import { firmOf } from '../domain/checklist';
import { SignInRow } from './signin';

declare const __APP_VERSION__: string | undefined;
/** the app's keys: the key, its short name shown beside it in Settings, and what it does (the tooltip) */
const KEYS: [string, string, string][] = [
  ['Ctrl K', 'Search All Deals', 'Search deals, findings, checklist items, questions and documents'],
  ['Enter', 'Send a Message', 'Send a message · Shift Enter for a new line'],
  ['Ctrl Z', 'Undo the Last Action', 'Undo the last action while its message is showing'],
  ['↑ ↓', 'Move Up or Down a List',
    'Move through questions, a menu, or the queue while reading · Home and End for the first and last'],
  ['← →', 'Previous or Next Document', 'Step through the documents while reading'],
  ['PgUp PgDn', 'Previous or Next Page',
    'Step through a document’s pages while reading · on a zoomed page, scroll down it first'],
  ['Ctrl + −', 'Zoom In or Out', 'Zoom the page while reading · Ctrl 0 for actual size'],
  ['Esc', 'Close a Dialog or Panel', 'Close a dialog, menu or the document'],
];
/** The build's version, from package.json; empty where the bundler has not set it (unit tests). */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

/** The firm's checklist in a line: "General and 5 lists · 237 items" */
function checklistLine(lists: { layer: string; items: unknown[] }[]): string {
  if (!lists.length) return 'No lists yet';
  const general = lists.some((l) => l.layer === 'broad'); const others = lists.length - (general ? 1 : 0); const items = lists.reduce((n, l) => n + l.items.length, 0);
  const named = general ? (others ? `General and ${others} ${others === 1 ? 'list' : 'lists'}` : 'General') : `${others} ${others === 1 ? 'list' : 'lists'}`;
  return `${named} · ${items} ${items === 1 ? 'item' : 'items'}`;
}

export function SettingsDialog() {
  const store = useStore(); const s = useAppState();
  const close = () => store.ui({ settings: false });
  const u = s.user;
  return (
    <Modal onClose={close} label="Settings" blur className="sdlg setdlg">
      <div class="shead"><h2 id="s-title">Settings</h2>{VERSION && <span class="sver" id="s-version">Version {VERSION}</span>}<button type="button" class="x" id="s-close" aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <div class="srow"><div class="k">Account</div><div class="who"><span class="avatar" id="s-ini">{u?.initials ?? ''}</span><b id="s-name">{u?.name ?? ''}</b></div></div>
      {store.services.signin && <SignInRow signin={store.services.signin} />}
      {store.services.place && <SharedFolderRow place={store.services.place} />}
      <div class="srow"><div class="k">Appearance</div><div class="seg" id="s-theme" role="group" aria-label="Appearance">{([['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([k, l]) => <button type="button" key={k} data-theme-pick={k} {...(k === 'system' ? { 'data-autofocus': true } : {})} class={s.prefs.theme === k ? 'on' : ''} aria-pressed={s.prefs.theme === k} onClick={() => store.setPrefs({ theme: k })}>{l}</button>)}</div></div>
      <div class="srow"><div class="k">Deals Open On</div><div class="seg" id="s-landing" role="group"
        aria-label="Deals open on">{DEAL_PAGES.map(([k, l]) => <button type="button" key={k} data-landing={k}
        class={s.prefs.landing === k ? 'on' : ''} aria-pressed={s.prefs.landing === k}
        onClick={() => store.setPrefs({ landing: k })}>{l}</button>)}</div></div>
      <div class="srow"><div class="k">Checklist</div><div class="imfile" id="s-checklist">{checklistLine(firmOf(s.firmList).lists)} <button type="button" class="linkb" id="s-checklist-open" onClick={() => store.ui({ settings: false, firmChecklist: { step: 'lists' } })}>Open</button></div></div>
      {s.models.length > 1 && <div class="srow" id="s-modelrow"><div class="k">Default Model</div><div class="seg"
        id="s-model" role="group" aria-label="Default model">{s.models.map((m) => <button type="button" key={m.id}
        class={s.model === m.id ? 'on' : ''} aria-pressed={s.model === m.id}
        onClick={() => store.setPrefs({ model: m.id })}>{m.name}</button>)}</div></div>}
      {/* each key cap with its short name, in two columns; the full description is the tooltip and is read out */}
      <div class="srow keys"><div class="k">Keyboard</div><dl class="keylist">{KEYS.map(([k, short, what]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd title={what} aria-label={what}>{short}</dd>
        </Fragment>))}</dl></div>
    </Modal>
  );
}
