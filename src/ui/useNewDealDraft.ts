/**
 * The New deal form's draft as the dialog keeps it: written to this PC as it changes, so a dismiss, a reload or a
 * restart loses nothing, and put back when the form opens (#55). Folders chosen and not yet read are part of it, from
 * the moment they are chosen, so a pick of several folders is kept whole while the first one is read (#113).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pathKey } from '../app/commands/deals';
import type { UiState } from '../app/state';
import { keptNewDeal, keepNewDeal, keepLateRead, hasNewDealDraft, type KeptNewDeal } from './newDealKept';

type NewDeal = NonNullable<UiState['newDeal']>;
type Folder = NewDeal['folders'][number];

export interface NewDealDraftOptions {
  /** the dialog's form; one for a deal already made (`forDeal`, the Folders dialog) keeps no draft */
  nd: NewDeal;
  /** the path typed in the field */
  path: string;
  /** puts a kept draft back in the form: its fields, and the path typed */
  restore: (fields: Partial<NewDeal>, path: string) => void;
  /** reads one folder and adds it to the form */
  read: (path: string) => Promise<unknown>;
}

/** whether a New deal form is open now: a read that ends late leaves the kept draft to it, as it reads again itself */
let formsOpen = 0;

export function useNewDealDraft({ nd, path, restore, read }: NewDealDraftOptions) {
  const keeps = !nd.forDeal;
  const reading = useRef(new Map<string, string>());   // folders being read, by normalized path, as chosen
  const queued = useRef<string[]>([]);                  // chosen together, waiting for the ones before to be read
  const live = useRef(true);                            // false once the dialog has closed
  const [waiting, setWaiting] = useState<string[]>([]);
  const show = () => setWaiting([...reading.current.values(), ...queued.current]);
  const keepNow = () => {
    const form = { name: nd.name, counterparty: nd.counterparty, kinds: nd.kinds, folders: nd.folders, path };
    const draft = { ...form, reading: [...reading.current.values(), ...queued.current] };
    keepNewDeal(hasNewDealDraft(draft) ? draft : null);
  };
  /** reads the folders one after another, stopping once the dialog has closed: the rest stay in its kept draft */
  const readEach = async (paths: string[]) => {
    queued.current = [...queued.current, ...paths];
    show();
    for (const path of paths) {
      if (!live.current) return;
      queued.current = queued.current.filter((p) => p !== path);
      await read(path);
    }
    show();
  };
  useLayoutEffect(() => {
    if (!keeps) return;
    formsOpen++;
    const kept = !nd.name && !nd.folders.length ? keptNewDeal() : null;
    if (kept) putBack(kept);
    return () => { formsOpen--; };
  }, []);
  /** the kept draft's fields go back in the form, and the folders it was still reading are read again */
  const putBack = (kept: KeptNewDeal) => {
    const listed = (p: string) => kept.folders.some((f) => pathKey(f.path) === pathKey(p));
    const waits = (kept.reading ?? []).filter((p) => !listed(p));
    // a typed path that Create was reading when the page went is read again as a folder, not also left in the field
    const typed = waits.some((p) => pathKey(p) === pathKey(kept.path)) ? '' : kept.path;
    restore({ name: kept.name, folders: kept.folders, kinds: kept.kinds, counterparty: kept.counterparty }, typed);
    void readEach(waits);
  };
  const firstRun = useRef(true);       // the first render is the form as it opened, before a kept draft is put back
  useEffect(() => {
    if (firstRun.current) firstRun.current = false;
    else if (keeps && live.current) keepNow();
  }, [nd.name, nd.counterparty, nd.kinds, nd.folders, path, waiting]);
  useEffect(() => () => { live.current = false; }, []);
  return {
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
    /**
     * A read has ended. False when the dialog has closed meanwhile: the folder then joins the kept draft, never another
     * dialog, unless a New deal form is open again, which reads it itself (#113).
     */
    finished: (path: string, folder: Folder | null) => {
      reading.current.delete(pathKey(path));
      show();
      if (live.current) return true;
      if (keeps && !formsOpen) keepLateRead(path, folder);
      return false;
    },
  };
}
