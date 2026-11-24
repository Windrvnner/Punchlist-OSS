import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { NewDealDraftSession } from '../app/newDealDraft';
import type { UiState } from '../app/state';

type NewDeal = NonNullable<UiState['newDeal']>;
type Folder = NewDeal['folders'][number];

interface NewDealDraftOptions {
  nd: NewDeal;
  path: string;
  restore: (fields: Partial<NewDeal>, path: string) => void;
  read: (path: string) => Promise<unknown>;
}

export function useNewDealDraft({ nd, path, restore, read }: NewDealDraftOptions) {
  const [waiting, setWaiting] = useState<string[]>([]);
  const [draft] = useState(() => new NewDealDraftSession(!nd.forDeal, setWaiting));
  useLayoutEffect(() => {
    const left = draft.open(nd);
    if (left) {
      restore(left.fields, left.path);
      void draft.readEach(left.reading, read);
    }
    return () => draft.close();
  }, []);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) firstRun.current = false;
    else draft.keep(nd, path);
  }, [nd.name, nd.counterparty, nd.kinds, nd.folders, path, waiting]);
  return {
    waiting,
    keepNow: () => draft.keep(nd, path),
    readEach: (paths: string[]) => draft.readEach(paths, read),
    busy: () => draft.busy(),
    isReading: (path: string) => draft.isReading(path),
    started: (path: string) => draft.started(path),
    finished: (path: string, folder: Folder | null) => draft.finished(path, folder),
  };
}
