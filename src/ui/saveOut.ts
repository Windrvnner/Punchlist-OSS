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
/** How many forms are on screen, by key: a save landing may open what it made only while one is in sight. */
const onScreenCount = new Map<string, number>();
const onScreen = (key: string) => (onScreenCount.get(key) ?? 0) > 0;

/**
 * The save for the form kept under `key`. `busy` is on while a save is out, also on a form drawn again for the key
 * meanwhile. `send` runs `save`, which dispatches and then settles the kept text, asking whether Cancel let it go
 * meanwhile and whether a form for the key is on screen, and returns what that form needs to know; `settle` is then
 * told that.
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
    onScreenCount.set(key, (onScreenCount.get(key) ?? 0) + 1);
    return () => {
      shown.current = false;
      onScreenCount.set(key, (onScreenCount.get(key) ?? 1) - 1);
    };
  }, []);
  const send = async (save: (cancelled: () => boolean, inSight: () => boolean) => Promise<Outcome>) => {
    if (saving.has(key)) return;
    setBusy(true);
    const pending = save(() => letGo.has(key), () => onScreen(key)).finally(() => {
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
