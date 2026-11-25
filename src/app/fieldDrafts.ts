import { hasTexts, keptDrafts } from './keptText';
import type { Question } from '../domain/model';
import type { State } from './state';

export type FieldValue = { value: string; rev: number };
export type FieldDraft = { text: string; base: string; rev: number };
export type ReadField = (state: State) => FieldValue | undefined;
type Watchable = { get(): State; subscribe(fn: () => void): () => void };

const isKept = (value: unknown): value is FieldDraft =>
  hasTexts('text', 'base')(value) && Number.isInteger((value as Partial<FieldDraft>).rev);
export const unsavedFields = keptDrafts('edit-field', isKept);

/** A field's draft moved to a recovered copy must ask before saving there. */
export const staleKept = (value: unknown) => (isKept(value) ? { ...value, rev: -1 } : value);
export const keepsUnsaved = (keep: string) => unsavedFields.has(keep);
export const unsavedText = (keep: string) => unsavedFields.get(keep)?.text;
export const unsavedBase = (keep: string) => unsavedFields.get(keep)?.base;

/** Text typed into a question's response box that still differs from the saved response. */
export function typedResponse(question: Question): boolean {
  const text = unsavedText(`${question.id}:response`);
  return text !== undefined && text !== question.response && !!text.trim();
}

/** A save may have landed after the field went away. Restore just the text the record still does not hold. */
export function restoreFieldDraft(keep: string | undefined, value: string): FieldDraft | undefined {
  if (keep === undefined) return undefined;
  const draft = unsavedFields.get(keep);
  if (draft?.text !== value) return draft;
  unsavedFields.delete(keep);
  return undefined;
}

const watching = new Map<string, () => void>();
const onScreen = new Map<string, number>();

/**
 * Follow consecutive revisions while an off-screen field still holds the draft's base. A missing record or a
 * revision jump leaves the last known revision behind, so the draft asks if the field may have moved and moved back.
 */
function watchKept(keep: string, store: Watchable, read: ReadField) {
  watching.get(keep)?.();
  const off = store.subscribe(() => check());
  const stop = () => {
    off();
    if (watching.get(keep) === stop) watching.delete(keep);
  };
  let vouched = -1;
  const check = () => {
    const draft = unsavedFields.get(keep);
    if (!draft || onScreen.has(keep)) {
      stop();
      return;
    }
    const now = read(store.get());
    if (!now || now.value !== draft.base) {
      vouched = -1;
      if (now && draft.rev >= 0) unsavedFields.set(keep, { ...draft, rev: -1 });
      return;
    }
    if (now.rev === draft.rev) {
      vouched = now.rev;
      return;
    }
    if (draft.rev >= 0 && draft.rev === vouched && now.rev === vouched + 1) {
      vouched = now.rev;
      unsavedFields.set(keep, { ...draft, rev: now.rev });
    }
  };
  watching.set(keep, stop);
  check();
}

export function showFieldDraft(keep: string) {
  watching.get(keep)?.();
  onScreen.set(keep, (onScreen.get(keep) ?? 0) + 1);
  return (store: Watchable | null, read: ReadField | undefined) => {
    const count = (onScreen.get(keep) ?? 1) - 1;
    if (count) onScreen.set(keep, count);
    else onScreen.delete(keep);
    if (!count && store && read && unsavedFields.has(keep)) watchKept(keep, store, read);
  };
}

function fieldOf(record: { rev: number } | undefined, value: unknown): FieldValue | undefined {
  return record && typeof value === 'string' ? { value, rev: record.rev } : undefined;
}

export const readQuestion = (id: string, field: string): ReadField => (state) => {
  const record = state.questions[id];
  return fieldOf(record, (record as Record<string, unknown> | undefined)?.[field]);
};

export const readDeal = (id: string, field: string): ReadField => (state) => {
  const record = state.deals[id];
  return fieldOf(record, (record as Record<string, unknown> | undefined)?.[field]);
};

export const readFolderLabel = (id: string, path: string): ReadField => (state) => {
  const record = state.deals[id];
  return fieldOf(record, record?.folders.find((folder) => folder.path === path)?.label);
};
