import { useEffect, useErrorBoundary, useRef, useState } from 'preact/hooks';
import { areKeptImportsReady, keptImportsReady } from '../app/keptImports';

/** An import dialog waits for its kept state to be read before it shows. */
export function useKeptImportsReady() {
  const [ready, setReady] = useState(areKeptImportsReady);
  useEffect(() => { if (!ready) void keptImportsReady.then(() => setReady(true)); }, []);
  return ready;
}

/**
 * An import dialog that fails to show what was kept (a stored value this build cannot use) shows once more without it,
 * as a new import, rather than not at all: what was kept is left as it is, not thrown away, and goes only when a new file
 * is read in its place. `true` means show it fresh; 'gone' that it failed fresh too, and the dialog stays closed.
 */
export function useFreshOnCrash(): boolean | 'gone' {
  const tries = useRef(0);
  useErrorBoundary(() => { tries.current++; });
  return tries.current === 0 ? false : tries.current === 1 ? true : 'gone';
}
