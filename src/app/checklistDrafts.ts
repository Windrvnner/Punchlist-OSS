import type { ChecklistDraftMaps } from '../ports';
import { latestKey } from './logQuestionDraft';

/** The draft text and finding IDs use their existing maps so questions typed before an update also reopen. */
export function checklistDrafts({ texts, targets, movedId }: ChecklistDraftMaps) {
  const latest = (key: string) => latestKey(key, movedId);
  const open = (key: string) => {
    const currentKey = () => latest(key);
    let original = targets.get(currentKey());
    const clear = (savedKey = currentKey()) => {
      texts.delete(savedKey);
      targets.delete(savedKey);
    };
    const write = (value: string, currentId?: string) => {
      if (!value) clear();
      else {
        original ??= currentId;
        const current = currentKey();
        texts.set(current, value);
        if (original) targets.set(current, latest(original));
      }
      return value;
    };
    return {
      get text() { return texts.get(currentKey()) ?? ''; },
      get findingId() { return original ? latest(original) : undefined; },
      begin(currentId?: string, suggested?: string) {
        const kept = texts.get(currentKey());
        if (kept) return kept;
        original = currentId;
        return write(suggested ?? '', currentId);
      },
      write, clear,
    };
  };

  // Kept map keys already follow a recovered deal. Each saved finding reference follows its own copy too.
  const followCopy = () => {
    for (const [key, id] of targets) {
      const now = latest(id);
      if (id !== now) targets.set(key, now);
    }
  };
  return { open, texts, followCopy };
}
