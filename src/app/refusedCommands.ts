/**
 * Typed "Log a question" commands whose save was refused while something new was typed in the same box (#955).
 * Each goes back at the head of its box, ahead of what was typed since, with a blank line between, so nothing typed is
 * written over. The commands are remembered per box, newest first as they stand in the box, so that sending the box
 * logs the head command alone and leaves the rest in the box. Kept across a restart, and moved with the box's text.
 */
import { CreateQuestion } from './commands/questions';
import { keptDrafts } from './keptText';
import type { Store } from './store';

/** The refused commands at the head of a box, newest first, and the text that followed them when they were put back. */
type Held = { commands: string[]; after: string };
const isHeld = (value: unknown): value is Held => {
  const held = value as Partial<Held> | null;
  return typeof held?.after === 'string' && Array.isArray(held.commands)
    && held.commands.every((command) => typeof command === 'string');
};
let kept: Map<string, Held> | undefined;
const heldCommands = () => kept ??= keptDrafts('refused-commands', isHeld);

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
  const earlier = standing(key, since);
  heldCommands().set(key, earlier
    ? { commands: [command, ...earlier.commands], after: earlier.after }
    : { commands: [command], after: since });
  return `${command}\n\n${since}`;
}

/**
 * What a send takes from the box: the refused command at its head, while the box still starts with what was put back,
 * with the rest left in the box; otherwise the whole box, as usual.
 */
export function takeFromBox(key: string, text: string): { send: string; rest: string } {
  const held = standing(key, text);
  heldCommands().delete(key);
  if (!held) return { send: text, rest: '' };
  const [head, ...others] = held.commands;
  if (others.length) heldCommands().set(key, { commands: others, after: held.after });
  return { send: head, rest: text.slice(head.length).trim() };
}

/** The box's remembered commands, if the box still starts with them and the text that followed them, unchanged. */
function standing(key: string, text: string): Held | undefined {
  const held = heldCommands().get(key);
  if (!held?.commands.length) return undefined;
  return text.startsWith([...held.commands, held.after].join('\n\n')) ? held : undefined;
}

/** The interrupted saves offered with Retry now, so a refusal can tell which one it left. */
export const interruptedNow = (store: Store) =>
  new Set(Object.values(store.get().ops).filter((operation) => operation.state === 'interrupted')
    .map((operation) => operation.id));

/**
 * A refused save the store left as interrupted work is offered with Retry, now and at the next start. Putting the
 * command back in the box as well would give two ways to log it, and using both would log it twice (#955). Only an
 * entry this save left counts, not one already waiting before it (`before`).
 */
export function keptForRetry(store: Store, before: Set<string>, dealId: string, text: string): boolean {
  return Object.values(store.get().ops).some((operation) => !before.has(operation.id)
    && operation.command === CreateQuestion.name && operation.state === 'interrupted'
    && sameQuestion(operation.input, dealId, text));
}

function sameQuestion(input: unknown, dealId: string, text: string) {
  const asked = input as { dealId?: unknown; text?: unknown } | null;
  return asked?.dealId === dealId && asked.text === text;
}
