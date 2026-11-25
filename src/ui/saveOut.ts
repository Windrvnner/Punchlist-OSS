import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cancelSave, pendingSave, sendSave, showSaveForm } from '../app/saveOut';

/** Show the app's pending save and its result, also on a form reopened while the save is out (#771). */
export function useSaveOut<Outcome>(key: string, settle: (outcome: Outcome) => void) {
  const [busy, setBusy] = useState(() => !!pendingSave(key));
  const shown = useRef(true);
  const settleShown = useRef(settle);
  settleShown.current = settle;
  const landed = (outcome: Outcome) => {
    if (!shown.current) return;
    setBusy(false);
    settleShown.current(outcome);
  };
  // Subscribe in the same task as the draw that found the save, before that pending save can land.
  useLayoutEffect(() => {
    void pendingSave(key)?.then((outcome) => landed(outcome as Outcome));
    const hide = showSaveForm(key);
    return () => {
      shown.current = false;
      hide();
    };
  }, []);
  const send = async (save: (cancelled: () => boolean, inSight: () => boolean) => Promise<Outcome>) => {
    const pending = sendSave(key, save);
    if (!pending) return;
    setBusy(true);
    landed(await pending);
  };
  return { busy, send, cancel: () => cancelSave(key) };
}
