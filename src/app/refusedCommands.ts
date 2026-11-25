/**
 * Typed "Log a question" commands whose save was refused while something new was typed in the same box (#955).
 * Each goes back at the head of its box, ahead of what was typed since, with a blank line between, so nothing typed is
 * written over. The commands are remembered per box, newest first as they stand in the box, so that sending the box
 * logs the head command alone and leaves the rest in the box. Kept across a restart, and moved with the box's text.
 */
import { CreateQuestion } from './commands/questions';
import { keptDrafts } from './keptText';
import type { Store } from './store';

const isTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((text) => typeof text === 'string');
let held: Map<string, string[]> | undefined;
const heldCommands = () => held ??= keptDrafts('refused-commands', isTexts);

/** Load the map before recovery can move saved drafts to a copy. */
export function initializeRefusedCommands() {
  heldCommands();
}

/**
 * The box after a refusal: the command first, as it was typed first, then what was typed since. A box holding only
 * the same command, typed again, gets it once.
 */
export function boxWithRefused(key: string, command: string, typedSince: string): string {
  const since = typedSince.trim();
  if (!since || since === command) {
    heldCommands().delete(key);
    return command;
  }
  heldCommands().set(key, [command, ...commandsAtHead(since, heldCommands().get(key) ?? [])]);
  return `${command}\n\n${since}`;
}

/**
 * What a send takes from the box: the refused command at its head, when the box still starts with it unchanged and
 * more follows, with the rest left in the box; otherwise the whole box, as usual.
 */
export function takeFromBox(key: string, text: string): { send: string; rest: string } {
  const [head, ...others] = commandsAtHead(text, heldCommands().get(key) ?? []);
  heldCommands().delete(key);
  if (!head || text === head) return { send: text, rest: '' };
  if (others.length) heldCommands().set(key, others);
  return { send: head, rest: text.slice(head.length).trim() };
}

/** The remembered commands that still stand, unchanged and in order, at the head of the box, each followed by more. */
function commandsAtHead(text: string, commands: string[]): string[] {
  const standing: string[] = [];
  let rest = text;
  for (const command of commands) {
    if (!rest.startsWith(`${command}\n\n`)) break;
    standing.push(command);
    rest = rest.slice(command.length + 2);
  }
  return standing;
}

/**
 * A refused save the store left as interrupted work is offered with Retry, now and at the next start. Putting the
 * command back in the box as well would give two ways to log it, and using both would log it twice (#955).
 */
export function keptForRetry(store: Store, dealId: string, text: string): boolean {
  return Object.values(store.get().ops).some((operation) => operation.command === CreateQuestion.name
    && operation.state === 'interrupted' && sameQuestion(operation.input, dealId, text));
}

function sameQuestion(input: unknown, dealId: string, text: string) {
  const asked = input as { dealId?: unknown; text?: unknown } | null;
  return asked?.dealId === dealId && asked.text === text;
}
