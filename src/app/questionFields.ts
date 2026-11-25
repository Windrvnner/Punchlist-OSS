import type { Question } from '../domain/model';
import { isChangedElsewhere } from './changedElsewhere';
import { EditQuestionField } from './commands/questions';
import type { Store } from './store';

export type EditableQuestionField =
  'text' | 'askedBy' | 'received' | 'workstream' | 'priority' | 'respondedBy' | 'responded';

export function questionFieldCommit(store: Store, question: Question, field: EditableQuestionField) {
  const { dealId, id: questionId } = question;
  const pick = field === 'workstream' || field === 'priority';
  return async (value: string, over?: string) => {
    // Picks carry the value the person saw, and need a notice because they have no inline editor (#202).
    const result = await store.dispatch(EditQuestionField, { dealId, questionId, field, value }, {
      quiet: true,
      over: pick ? question[field] : over,
    });
    if (!result.ok && result.error.kind !== 'storageFull' && (pick || !isChangedElsewhere(result.error))) {
      store.toast(result.error.message, undefined, pick ? { glyph: 'warn' } : undefined);
    }
    return result;
  };
}
