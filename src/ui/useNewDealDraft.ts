/**
 * The New deal form's draft as the dialog keeps it: written to this PC as it changes, so a dismiss, a reload or a
 * restart loses nothing, and put back when the form opens (#55). Folders chosen and not yet read are part of it, from
 * the moment they are chosen, so a pick of several folders is kept whole while the first one is read (#113).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pathKey } from '../app/commands/deals';
import { keptNewDeal, keepNewDeal, hasNewDealDraft, type KeptNewDeal } from './newDealKept';

type Form = Omit<KeptNewDeal, 'reading'>;

export interface NewDealDraftOptions {
  /** false for the Folders dialog of a deal already made, which keeps no draft */
  keeps: boolean;
  /** the form as it stands */
  form: () => Form;
  /** what the form shows, so the draft is written again when any of it changes */
  changes: unknown[];
  /** whether the form opened empty, so a kept draft is put in it */
  openedEmpty: boolean;
  /** puts a kept draft's fields back in the form */
  restore: (kept: KeptNewDeal) => void;
  /** reads one folder and adds it to the form */
  read: (path: string) => Promise<unknown>;
}

export function useNewDealDraft(o: NewDealDraftOptions) {
  const reading = useRef(new Map<string, string>());   // folders being read, by normalized path, as chosen
  const queued = useRef<string[]>([]);                  // chosen together, waiting for the ones before to be read
  const live = useRef(true);                            // false once the dialog has closed
  const [waiting, setWaiting] = useState<string[]>([]);
  const show = () => setWaiting([...reading.current.values(), ...queued.current]);
  const keepNow = () => {
    const draft = { ...o.form(), reading: [...reading.current.values(), ...queued.current] };
    keepNewDeal(hasNewDealDraft(draft) ? draft : null);
  };
  /** reads the folders one after another, stopping once the dialog has closed: the rest stay in its kept draft */
  const readEach = async (paths: string[]) => {
    queued.current = [...queued.current, ...paths];
    show();
    for (const path of paths) {
      if (!live.current) return;
      queued.current = queued.current.filter((p) => p !== path);
      await o.read(path);
    }
    show();
  };
  useLayoutEffect(() => {
    const kept = o.keeps && o.openedEmpty ? keptNewDeal() : null;
    if (!kept) return;
    o.restore(kept);
    const listed = (p: string) => kept.folders.some((f) => pathKey(f.path) === pathKey(p));
    void readEach((kept.reading ?? []).filter((p) => !listed(p)));
  }, []);
  const firstRun = useRef(true);       // the first render is the form as it opened, before a kept draft is put back
  useEffect(() => {
    if (firstRun.current) firstRun.current = false;
    else if (o.keeps && live.current) keepNow();
  }, [...o.changes, waiting]);
  useEffect(() => () => { live.current = false; }, []);
  return {
    live,
    keepNow,
    readEach,
    /** folders being read or waiting to be */
    waiting,
    /** whether a folder is being read or waits to be, as Create asks before it goes on */
    busy: () => reading.current.size > 0 || queued.current.length > 0,
    isReading: (path: string) => reading.current.has(pathKey(path)),
    started: (path: string) => {
      reading.current.set(pathKey(path), path);
      show();
    },
    finished: (path: string) => {
      reading.current.delete(pathKey(path));
      show();
    },
  };
}
