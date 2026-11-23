/**
 * A save sent from a form whose text is kept by key (a kept-drafts map), followed to where it lands (#771).
 *
 * A form can be closed (Escape, leaving the page) and drawn again while its save is out. The save then settles the
 * kept text, which both forms share, once, whether or not a form is on screen; the form on screen when it lands, the
 * one that sent it or one drawn since, is then told. So what was typed ends up in one place: kept, or let go with the
 * save, never both.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Saves still out, by their form's key, each to what it settled when it landed. */
const saving = new Map<string, Promise<unknown>>();
/** Keys whose save still out was let go with Cancel: a form opened again since is left alone when it lands. */
const letGo = new Set<string>();

/**
 * The save for the form kept under `key`. `busy` is on while a save is out, also on a form drawn again for the key
 * meanwhile. `send` runs `save`, which dispatches and then settles the kept text, saying whether Cancel let it go
 * meanwhile, and returns what the form on screen needs to know; `settle` is then told that.
 */
export function useSaveOut<Outcome>(key: string, settle: (outcome: Outcome) => void) {
  const [busy, setBusy] = useState(() => saving.has(key));
  const shown = useRef(true);
  const settleShown = useRef(settle);
  settleShown.current = settle;
  const landed = (outcome: Outcome) => {
    if (!shown.current) return;
    setBusy(false);
    settleShown.current(outcome);
  };
  // a form drawn while the save is out hears when it lands. A layout effect runs in the same task as the draw that
  // found the save out, so the save cannot land in between and leave the form busy
  useLayoutEffect(() => {
    void saving.get(key)?.then((outcome) => landed(outcome as Outcome));
    return () => {
      shown.current = false;
    };
  }, []);
  const send = async (save: (cancelled: () => boolean) => Promise<Outcome>) => {
    if (saving.has(key)) return;
    setBusy(true);
    const pending = save(() => letGo.has(key)).finally(() => {
      saving.delete(key);
      letGo.delete(key);
    });
    saving.set(key, pending);
    landed(await pending);
  };
  /** Cancel while the save is out: it still lands, and `save` is told so, to leave a form opened since as it is */
  const cancel = () => {
    if (saving.has(key)) letGo.add(key);
  };
  return { busy, send, cancel };
}
