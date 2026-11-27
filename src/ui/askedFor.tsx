/**
 * What a question was asked for (decisions, Checklist: "a question says what it was asked for"; linking design,
 * section 6).
 */
import { namedItem, pageHash } from '../app/state';
import type { Question } from '../domain/model';
import { findingHref } from './findings';
import { useAppState, useStore } from './hooks';
import { openChecklistItem } from './nav';

/**
 * The finding the question was asked about or, failing that, the checklist item, linked to its page. A question asked
 * from a flagged item names both, and the finding is what its card said it was linked to. Nothing shows when neither
 * is here.
 */
export function AskedFor({ q }: { q: Question }) {
  const store = useStore();
  const s = useAppState();
  const f = q.linkedFinding ? s.findings[q.linkedFinding] : undefined;
  const item = !f && q.linkedItem ? namedItem(s, q.dealId, q.linkedItem.id) : null;
  if (!f && !item) return null;
  const name = f ? f.title : item!.text;
  const openItem = (e: MouseEvent) => {
    e.preventDefault();
    openChecklistItem(store, q.dealId, item!.id);
  };
  const link = f
    ? <a href={findingHref(f)} title={`The finding “${name}”`}>“{name}”</a>
    : <a href={'#' + pageHash('checklist', q.dealId)} title={`The checklist item “${name}”`}
      onClick={openItem}>“{name}”</a>;
  return <span class="sub qfor" id="q-for">Asked for {link}</span>;
}
