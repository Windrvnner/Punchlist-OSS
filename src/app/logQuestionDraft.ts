/** The question draft shared by cards opened for the same item or finding. */
interface QuestionDraft {
  read(): string | undefined;
  forget(): void;
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
