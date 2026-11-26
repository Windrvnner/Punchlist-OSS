// The composer's slash commands (#1054): the menu "/" opens, and the Log Question chip a pick puts in the box.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from './hooks';
import { Icon } from './icons';
import { runSlashCommand, slashCommands, type SlashCommand } from '../app/slashCommands';
import { clearLogQuestion, showsLogQuestion } from '../app/refusedCommands';
import type { Scope } from '../app/conversations';

/**
 * What a composer needs for its slash commands: the menu to show (or none), the chip, and a key handler that returns
 * true when it used the key. `text` is the box's text; `changed` re-reads the box after a command ran.
 */
export function useSlashCommands({ scope, boxKey, text, formId, up, changed }: {
  scope: Scope; boxKey: string; text: string; formId: string; up: boolean; changed: () => void;
}) {
  const store = useStore();
  const commands = slashCommands(scope, text);
  // Escape puts the menu away until the text changes; the highlighted command is screen state only
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [text]);
  const open = !!commands?.length && closedAt !== text;
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest?.(`#${formId}`)) setClosedAt(text);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, formId, text]);
  const pick = (command: SlashCommand) => {
    runSlashCommand(store, scope, command.id);
    changed();
  };
  const chipShown = showsLogQuestion(boxKey) && scope.kind === 'deal';
  const removeChip = () => {
    clearLogQuestion(boxKey);
    changed();
  };
  const onKey = (e: KeyboardEvent): boolean => {
    // Backspace in an empty box takes the chip off, as it would a character before the text
    if (e.key === 'Backspace' && !text && chipShown) {
      removeChip();
      return true;
    }
    if (!open || !commands) return false;
    return menuKey(e, commands.length, at, {
      move: setAt, close: () => setClosedAt(text), pick: (i) => pick(commands[i]),
    });
  };
  const menu = open && commands
    ? <SlashMenu id={`${formId}-slash`} commands={commands} at={at} up={up} pick={pick} />
    : null;
  const chip = chipShown ? <LogQuestionChip remove={removeChip} /> : null;
  const listId = open ? `${formId}-slash` : undefined;
  return { menu, chip, onKey, listId, activeId: listId && `${listId}-${at}` };
}

/** The open menu's keys, as search's list takes them: arrows move, Enter picks, Escape closes. True when used. */
function menuKey(e: KeyboardEvent, count: number, at: number, to: {
  move: (i: number) => void; close: () => void; pick: (i: number) => void;
}): boolean {
  const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (step) to.move((at + step + count) % count);
  else if (e.key === 'Escape') to.close();
  else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) to.pick(Math.min(at, count - 1));
  else return false;
  e.preventDefault();
  return true;
}

/** The commands, in the composer's own menu glass; the focus stays in the box, which picks with Enter. */
function SlashMenu({ id, commands, at, up, pick }: {
  id: string; commands: SlashCommand[]; at: number; up: boolean; pick: (command: SlashCommand) => void;
}) {
  return (
    <div class={`colmenu glass mmenu slashmenu ${up ? '' : 'down'}`} id={id} role="listbox" aria-label="Commands">
      {commands.map((command, i) => (
        <button type="button" role="option" id={`${id}-${i}`} key={command.id} aria-selected={i === at}
          class={`mi ${i === at ? 'on' : ''}`} tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()} onClick={() => pick(command)}>
          {command.name}
        </button>
      ))}
    </div>
  );
}

/** What is typed after it is a question to log; × takes it off and keeps the text. */
function LogQuestionChip({ remove }: { remove: () => void }) {
  return (
    <span class="chip att" id="log-question-chip">
      <span class="t">Log Question</span>
      <button type="button" aria-label="Remove Log Question" title="Remove Log Question" onClick={remove}>
        <Icon name="close" size={11} />
      </button>
    </span>
  );
}
