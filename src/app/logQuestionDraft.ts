/** The question draft shared by cards opened for the same item or finding. */
interface QuestionDraft {
  read(): string | undefined;
  forget(): void;
}

/** A recovered copy can itself be recovered. Each move replaces record IDs with fresh ones. */
function latestKey(key: string, move: (key: string) => string): string {
  const next = move(key);
  return next === key ? key : latestKey(next, move);
}

/** A recovered Ask card shares the original save's busy state and Cancel, just as it shares the kept text (#843). */
export function questionLogKey(draftKey: string, pending: Iterable<string>, move: (key: string) => string) {
  const current = latestKey('ask:' + draftKey, move);
  for (const key of pending) {
    if (key.startsWith('ask:') && latestKey(key, move) === current) return key;
  }
  return current;
}

/** Whether to settle the card on screen. A save sent before Cancel lands but leaves any new draft alone (#843). */
export async function logQuestionDraft(
  text: string, draft: QuestionDraft, dispatch: () => Promise<{ ok: boolean }>, cancelled: () => boolean,
): Promise<boolean> {
  const result = await dispatch();
  if (cancelled()) return false;
  if (result.ok && draft.read()?.trim() === text) draft.forget();
  return true;
}
