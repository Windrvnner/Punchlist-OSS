/** Saves remain available by form key while a form is closed or reopened during the write (#771). */
const saving = new Map<string, Promise<unknown>>();
const letGo = new Set<string>();
const onScreenCount = new Map<string, number>();

export const pendingSaveKeys = () => saving.keys();
export const pendingSave = (key: string) => saving.get(key);

export function showSaveForm(key: string): () => void {
  onScreenCount.set(key, (onScreenCount.get(key) ?? 0) + 1);
  return () => {
    const count = (onScreenCount.get(key) ?? 1) - 1;
    if (count) onScreenCount.set(key, count);
    else onScreenCount.delete(key);
  };
}

/** The workflow settles kept text once and gives the form currently on screen the result to display. */
export function sendSave<Outcome>(
  key: string, save: (cancelled: () => boolean, inSight: () => boolean) => Promise<Outcome>,
): Promise<Outcome> | undefined {
  if (saving.has(key)) return undefined;
  const pending = save(() => letGo.has(key), () => (onScreenCount.get(key) ?? 0) > 0).finally(() => {
    saving.delete(key);
    letGo.delete(key);
  });
  saving.set(key, pending);
  return pending;
}

export function cancelSave(key: string) {
  if (saving.has(key)) letGo.add(key);
}
