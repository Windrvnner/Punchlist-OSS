/**
 * The composer's slash commands (#1054): a one-line box that starts with "/" offers them in a menu, and what
 * follows the "/" narrows it. A command runs only when picked; typed words are never taken as one.
 */
import type { Store } from './store';
import { composerText, convKey, setComposerText, type Scope } from './conversations';
import { setLogQuestion, showsLogQuestion } from './refusedCommands';
import { openNewDeal } from './dealFolders';
import { openAddUnresolved } from './addUnresolved';

export type SlashCommandId = 'unresolved' | 'logQuestion' | 'newDeal';
/** `command`: what the menu shows and typing after "/" matches; `about`: what it does, under it in the menu. */
export interface SlashCommand { id: SlashCommandId; command: string; about: string }

/** A to Z; `deal`: only in a conversation about a deal, as the commands they replace were. */
const COMMANDS: (SlashCommand & { deal: boolean })[] = [
  {
    id: 'unresolved', command: '/add-unresolved', deal: true,
    about: 'Add a question to the Q&A log for each gap and open finding that has none.',
  },
  { id: 'logQuestion', command: '/log-question', deal: true, about: 'Log what you type next as a question.' },
  { id: 'newDeal', command: '/new-deal', deal: false, about: 'Start a new deal from its data-room folders.' },
];

/**
 * The commands the menu shows for what is in the box: null when the box is not a slash command being typed (it must
 * start with "/" and be one line), else those whose command holds what follows the "/", ignoring case.
 */
export function slashCommands(scope: Scope, text: string): SlashCommand[] | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  const typed = text.slice(1).toLowerCase();
  return COMMANDS.filter((command) => (!command.deal || scope.kind === 'deal') && command.command.includes(typed))
    .map(({ id, command, about }) => ({ id, command, about }));
}

/** Run a picked command; the "/…" typed to find it is cleared. Read-only, nothing runs and the text stays. */
export function runSlashCommand(store: Store, scope: Scope, id: SlashCommandId) {
  const readOnly = store.readOnly();
  if (readOnly) {
    store.toast(readOnly, 'warn');
    return;
  }
  if (id !== 'newDeal' && scope.kind !== 'deal') return;
  const key = convKey(scope);
  if (composerText(key).startsWith('/')) setComposerText(key, '');
  if (id === 'newDeal') openNewDeal(store);
  else if (id === 'logQuestion') setLogQuestion(key, true);
  else if (scope.kind === 'deal') openAddUnresolved(store, scope.dealId);
}

/** The **Log Question** chip, which only a deal's box takes, as only a deal has a Q&A log. */
export const showsLogQuestionChip = (scope: Scope, text: string) =>
  scope.kind === 'deal' && showsLogQuestion(convKey(scope), text);
