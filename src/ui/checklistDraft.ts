import { useRef, useState } from 'preact/hooks';
import { useLogQuestion } from './askCounterparty';
import { keptDrafts, isText } from './keptDrafts';

/**
 * Questions half typed in the Checklist pane, by deal and item: moving to another item, closing the pane or pressing
 * Escape keeps the text, and the box comes back with it when the item is opened again. Cancel or logging the question
 * clears it.
 */
const askDrafts = keptDrafts('checklist-ask', isText);   // kept across a restart too
const askOn = keptDrafts('checklist-ask-on', isText, (id, moved) => moved.get(id) ?? id);

/** Keep the card's original target between keystrokes, including before the first one or after clearing the box. */
export function useChecklistDraft(key: string, currentFindingId?: string) {
  const kept = askDrafts.has(key);
  const [asking, setAsking] = useState(kept);
  const [text, setTextState] = useState(() => askDrafts.get(key) ?? '');
  const original = useRef(askOn.get(key));
  const forget = () => {
    askDrafts.delete(key);
    askOn.delete(key);
  };
  const setText = (value: string) => {
    setTextState(value);
    if (!value) return forget();
    askDrafts.set(key, value);
    if (original.current) askOn.set(key, original.current);
  };
  const begin = (suggested?: string) => {
    if (!kept) {
      original.current = currentFindingId;
      if (suggested) setText(suggested);
    }
    setAsking(true);
  };
  const stopAsking = () => {
    setAsking(false);
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const back = document.getElementById('ck-ask') ?? document.getElementById('ck-on')
        ?? document.getElementById('ck-more') ?? document.getElementById('ck-close');
      back?.focus();
    });
  };
  const settle = () => {
    if (askDrafts.has(key)) return;
    setTextState('');
    stopAsking();
  };
  const { busy, log } = useLogQuestion(askDrafts, key, forget, settle);
  const findingId = asking || kept ? original.current : currentFindingId;
  return { asking, text, setText, kept, findingId, begin, stopAsking, busy, log };
}
