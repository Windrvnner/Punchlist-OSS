import { initializeKeptText, saveKeptDrafts } from '../app/keptText';
import type { LocalStore } from '../ports';

/** Restore kept typing before importing the screens, then flush it as the window goes away. */
export function startKeptText(local: LocalStore) {
  initializeKeptText(local);
  const hidden = () => {
    if (document.visibilityState === 'hidden') saveKeptDrafts();
  };
  window.addEventListener('pagehide', saveKeptDrafts);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('pagehide', saveKeptDrafts);
    document.removeEventListener('visibilitychange', hidden);
  };
}
