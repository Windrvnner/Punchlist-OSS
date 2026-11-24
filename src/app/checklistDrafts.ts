import type { ChecklistDraftMaps } from '../ports';

/** The draft text and finding IDs use their existing maps so questions typed before an update also reopen. */
export function checklistDrafts({ texts, targets, movedId }: ChecklistDraftMaps) {
  const open = (key: string) => {
    let original = targets.get(key);
    const clear = () => {
      texts.delete(key);
      targets.delete(key);
    };
    const write = (value: string, currentId?: string) => {
      if (!value) clear();
      else {
        original ??= currentId;
        texts.set(key, value);
        if (original) targets.set(key, movedId(original));
      }
      return value;
    };
    return {
      get text() { return texts.get(key) ?? ''; },
      get findingId() { return original ? movedId(original) : undefined; },
      begin(currentId?: string, suggested?: string) {
        const kept = texts.get(key);
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
      const now = movedId(id);
      if (id !== now) targets.set(key, now);
    }
  };
  return { open, texts, followCopy };
}
