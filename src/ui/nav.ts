/**
 * Navigation with intent: go to a route and, once it is the current route, apply a
 * UI patch (which question is selected, which document is open). The Shell collects
 * the patch when it applies the route, so the two land in one state change.
 */
import type { Store } from '../app/store';
import { pageHash, type UiState } from '../app/state';
import { lastInput } from './hooks';

let pending: { hash: string; patch: Partial<UiState> } | null = null;

export function navigate(store: Store, hash: string, patch: Partial<UiState> = {}) {
  if (location.hash === '#' + hash) { pending = null; store.ui(patch); return; }
  pending = { hash, patch };
  location.hash = hash;
}
// #498: a rendered Search destination can take keyboard focus if the user has stayed at the page.
export function focusSearchResult(store: Store, id: string, focus: () => void) {
  if (store.get().ui.searchFocus !== id) return;
  store.ui({ searchFocus: null });
  const active = document.activeElement;
  if (lastInput.kind === 'key' && (active === document.body || active?.id === 'view')) focus();
}

/** opens a deal's Checklist with one item open beside the list */
export const openChecklistItem = (store: Store, dealId: string, itemId: string) =>
  navigate(store, pageHash('checklist', dealId), { selectedChecklist: itemId });

export function takeNavPatch(): Partial<UiState> {
  const p = pending && location.hash === '#' + pending.hash ? pending.patch : {};
  pending = null;
  return p;
}

/**
 * Closing a document that was opened from another page (the Checklist) goes back to that page, and the focus goes back
 * to what opened the document there: the first of `backFocus` that is on the page once it is shown.
 */
let focusAfter: { hash: string; sel: string[] } | null = null;
export function closeDocument(store: Store) {
  const aside = store.get().ui.docAside;
  store.ui({ doc: null, docAside: null });
  if (!aside?.back) return;
  focusAfter = aside.backFocus?.length ? { hash: aside.back, sel: aside.backFocus } : null;
  location.hash = aside.back;
}
/** What to focus on the route being applied, if closing a document asked for something; taken once, as the route is applied. */
export function takeFocusAfter(): string[] {
  const f = focusAfter && location.hash === '#' + focusAfter.hash ? focusAfter.sel : [];
  focusAfter = null;
  return f;
}

/**
 * The last page left for a finding page, so deleting a finding goes back where the person came from: the Checklist
 * when it was opened there, else the Findings page. Stepping from one finding to the next does not change it.
 */
let beforeFinding = '';
if (typeof window !== 'undefined') window.addEventListener('hashchange', (e) => { const old = new URL(e.oldURL).hash.slice(1); if (!old.startsWith('finding-')) beforeFinding = old; });
export const afterDeletingFinding = (dealId: string) =>
  beforeFinding === pageHash('checklist', dealId) ? beforeFinding : pageHash('findings', dealId);
