import { followCopies, keepAttachments } from './attachments';
import { initializeComposerDrafts } from './conversations';
import { initializeResponseMergeDrafts, keepResolvedMerges } from './drafting';
import { handFieldText, staleKept } from './fieldDrafts';
import { renameKept } from './keptText';
import type { Store } from './store';

/** Start after reading local storage. A recovered copy keeps its unsent attachments and text (#117). */
export function startKeepingDrafts(store: Store): () => void {
  initializeComposerDrafts();
  initializeResponseMergeDrafts();
  const stopAttachments = keepAttachments(store);
  const stopCopies = followCopies(store);
  const stopRenames = store.onRenamed((ids) => renameKept(ids, staleKept));
  const stopMerges = keepResolvedMerges(store, handFieldText);
  return () => {
    stopMerges();
    stopRenames();
    stopCopies();
    stopAttachments();
  };
}
