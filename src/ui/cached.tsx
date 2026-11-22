import { useAppState } from './hooks';
import { showTip, hideTip } from './tip';

/**
 * A small dot beside a document's name when it is loaded in the user's store right now.
 * It is a status dot, not a control: nothing happens on click, and hovering it says "Cached".
 * It only reports what the backend says; a document without the mark still opens and can
 * still be asked about, it just takes longer. Records without a document id never show it.
 */
export function CachedMark({ doc }: { doc: { docId?: string } }) {
  const s = useAppState();
  if (!doc.docId || !s.cached[doc.docId]) return null;
  return <span class="cmark" role="img" aria-label="Cached"
    onMouseEnter={(e) => { e.stopPropagation(); showTip(e.currentTarget as HTMLElement, 'Cached', 200); }}
    onMouseLeave={(e) => hideTip(e.currentTarget as HTMLElement)} />;
}
