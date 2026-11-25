import { updateQaLog, type QaLogUpdateOutcome } from '../app/qaLog';
import type { Store } from '../app/store';
import { placeKept } from './placeKept';
import { openResolve } from './resolve';

const count = (value: number) => value.toLocaleString('en-US');
const filed = (value: number) => value
  ? `${count(value)} ${value === 1 ? 'edit' : 'edits'} not fully merged, filed in the archive`
  : '';
const summary = (...parts: (string | 0)[]) => parts.filter(Boolean).join(' · ');

function showUpdated(store: Store, dealId: string, outcome: Extract<QaLogUpdateOutcome, { kind: 'updated' }>) {
  const { counts, versions, clashed, action } = outcome;
  const did = [
    counts.changed && `${count(counts.changed)} changed in the log`,
    counts.added && `${count(counts.added)} added`,
    counts.answered && `${count(counts.answered)} answered`,
    counts.updated && `${count(counts.updated)} updated`,
  ].filter(Boolean).join(', ');
  const text = summary(filed(counts.unmerged), versions && `${count(versions)} in two versions`,
    clashed && `${count(clashed)} kept as in the file`, did);
  if (action?.kind === 'resolve') store.toast(text, { label: 'Resolve', run: () => openResolve(store, dealId) }, true);
  else if (action?.kind === 'show') {
    store.toast(text, { label: 'Show', run: () => store.ui({ selectedQuestion: action.questionId }) }, true);
  } else if (counts.unmerged) store.toast(text, undefined, true);
  else store.toast(did ? `Q&A log updated · ${did}` : 'Q&A log is up to date');
}

export function showQaLogUpdate(store: Store, dealId: string) {
  return updateQaLog(store, dealId, {
    place: placeKept(store, dealId),
    announce: (outcome) => {
      switch (outcome.kind) {
        case 'busy':
          store.toast('Q&A log is being updated');
          break;
        case 'failed':
          store.toast(summary(filed(outcome.unmerged), `Q&A log not updated: ${outcome.error.message}`), undefined, {
            sticky: !!outcome.unmerged, glyph: 'warn',
          });
          break;
        case 'retrying': {
          const message = outcome.by ? `${outcome.by} has the Q&A log open · retrying`
            : 'The Q&A log is in use elsewhere · retrying';
          const toast = store.toast(message, { label: 'Retry Now', run: () => void outcome.retry() }, true);
          return () => store.dismissToast(toast);
        }
        case 'retryLimit':
          store.toast('Q&A log not updated · in use elsewhere for 20 minutes',
            { label: 'Retry', run: () => void outcome.retry() }, true);
          break;
        case 'created':
          store.toast(summary('Q&A log made', filed(outcome.unmerged)), undefined, !!outcome.unmerged);
          break;
        case 'updated':
          showUpdated(store, dealId, outcome);
          break;
        case 'canceled':
          break;
      }
      return undefined;
    },
  });
}
