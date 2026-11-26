/**
 * The composer's slash commands (#1054): typing "/" at the start of an empty box offers them in a menu, and what
 * follows the "/" narrows it. A command runs only when picked; typed words are never taken as one.
 */
import type { Store } from './store';
import { composerText, convKey, setComposerText, type Scope } from './conversations';
import { setLogQuestion } from './refusedCommands';
import { openNewDeal } from './dealFolders';
import { openAddUnresolved } from './addUnresolved';

export type SlashCommandId = 'unresolved' | 'logQuestion' | 'newDeal';
export interface SlashCommand { id: SlashCommandId; name: string }

/** A to Z by name; `deal`: only in a conversation about a deal, as the commands they replace were. */
const COMMANDS: (SlashCommand & { deal: boolean })[] = [
  { id: 'unresolved', name: 'Add All Unresolved to Q&A…', deal: true },
  { id: 'logQuestion', name: 'Log Question', deal: true },
  { id: 'newDeal', name: 'New Deal…', deal: false },
];

/**
 * The commands the menu shows for what is in the box: null when the box is not a slash command being typed (it must
 * start with "/" and be one line), else those whose name holds what follows the "/", ignoring case.
 */
export function slashCommands(scope: Scope, text: string): SlashCommand[] | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  const typed = text.slice(1).toLowerCase();
  return COMMANDS.filter((command) => (!command.deal || scope.kind === 'deal')
    && command.name.toLowerCase().includes(typed)).map(({ id, name }) => ({ id, name }));
}

/** Run a picked command; the "/…" typed to find it is cleared. Read-only, nothing runs and the text stays. */
export function runSlashCommand(store: Store, scope: Scope, id: SlashCommandId) {
  const readOnly = store.readOnly();
  if (readOnly) {
    store.toast(readOnly);
    return;
  }
  if (id !== 'newDeal' && scope.kind !== 'deal') return;
  const key = convKey(scope);
  if (composerText(key).startsWith('/')) setComposerText(key, '');
  if (id === 'newDeal') openNewDeal(store);
  else if (id === 'logQuestion') setLogQuestion(key, true);
  else if (scope.kind === 'deal') openAddUnresolved(store, scope.dealId);
}
