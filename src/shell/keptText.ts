import { initializeKeptText, saveKeptDrafts } from '../app/keptText';
import type { LocalStore } from '../ports';
import type { BridgeApi } from './bridge';

/** Flush each saved desktop snapshot so an abrupt exit does not leave it in Chromium's write buffer (#825). */
function flushOnDesktop(local: LocalStore): LocalStore {
  const desktop = (window as Window & { punchlist?: BridgeApi }).punchlist;
  if (!desktop) return local;
  return {
    read: (key) => local.read(key),
    write: (key, value) => {
      const saved = local.write(key, value);
      if (saved.ok) desktop.flushKeptText();
      return saved;
    },
  };
}

/** Restore kept typing before importing the screens, then flush it as the window goes away. */
export function startKeptText(local: LocalStore) {
  initializeKeptText(flushOnDesktop(local));
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
