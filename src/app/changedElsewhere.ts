/** The refusal used when a field no longer holds the value its text was typed over. */
export const CHANGED_ELSEWHERE = 'Changed elsewhere';

export function isChangedElsewhere(error: { message: string } | undefined): boolean {
  return error?.message === CHANGED_ELSEWHERE;
}
