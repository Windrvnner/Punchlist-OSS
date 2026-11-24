import { useState } from 'preact/hooks';
import { useLogQuestion } from './askCounterparty';
import { keptChecklistQuestions } from './keptDrafts';

/** Keep the card's original target between keystrokes, including before the first one or after clearing the box. */
export function useChecklistDraft(key: string, currentFindingId?: string) {
  const [draft] = useState(() => keptChecklistQuestions.open(key));
  const kept = Boolean(draft.text);
  const [asking, setAsking] = useState(kept);
  const [text, setTextState] = useState(draft.text);
  const setText = (value: string) => setTextState(draft.write(value, currentFindingId));
  const begin = (suggested?: string) => {
    setTextState(draft.begin(currentFindingId, suggested));
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
    if (draft.text) return;
    setTextState('');
    stopAsking();
  };
  const { busy, log } = useLogQuestion(keptChecklistQuestions.texts, key, draft.clear, settle);
  const findingId = asking || kept ? draft.findingId : undefined;
  return { asking, text, setText, kept, findingId, begin, stopAsking, busy, log };
}
