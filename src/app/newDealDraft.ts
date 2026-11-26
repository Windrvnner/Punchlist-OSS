/**
 * The New deal form half filled in, kept on this PC across a reload or restart until the deal is created (#55). It is
 * written as it changes, through the app's kept-draft store (keptText.ts), so a dismiss, a reload or a crash loses
 * nothing. Folders still being read when the form went are kept as paths and read again when it opens (#113).
 */
import type { DealKinds } from './state';
import { windowsPath } from '../domain/sheets';
import { keptDrafts } from './keptText';

type KeptFolder = { path: string; label: string; files: number; size: string };

type KeptNewDeal = {
  name: string;
  counterparty?: string;
  kinds?: DealKinds;
  folders: KeptFolder[];
  /** a path typed in the field but not yet added */
  path: string;
  /** folders chosen or dropped whose reading had not finished */
  reading?: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const optionalString = (v: unknown) => v === undefined || isString(v);

const isKeptFolder = (v: unknown): v is KeptFolder =>
  isObject(v) && isString(v.path) && isString(v.label) && typeof v.files === 'number' && isString(v.size);

const isKinds = (v: unknown) => v === undefined || (isObject(v) && Object.values(v).every(optionalString));

const isStringList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isString));

/** a stored draft of any other shape (damaged, or from another build) is dropped, and the form opens empty */
function isKeptNewDeal(v: unknown): v is KeptNewDeal {
  if (!isObject(v) || !isString(v.name) || !isString(v.path) || !optionalString(v.counterparty)) return false;
  return Array.isArray(v.folders) && v.folders.every(isKeptFolder) && isKinds(v.kinds) && isStringList(v.reading);
}

const kept = keptDrafts('new-deal', isKeptNewDeal);
const KEY = 'new';

/** the draft the form was left with, if any */
export const keptNewDeal = (): KeptNewDeal | null => kept.get(KEY) ?? null;

/** keeps the draft as it stands, or forgets it (null) once the deal is made or the form holds nothing */
export function keepNewDeal(draft: KeptNewDeal | null) {
  if (draft) kept.set(KEY, draft);
  else kept.delete(KEY);
}

/** whether a draft holds anything a person typed or chose */
export function hasNewDealDraft(d: KeptNewDeal) {
  const picked = Object.values(d.kinds ?? {}).some((v) => v?.trim()) || !!d.counterparty?.trim();
  return !!(d.name.trim() || d.folders.length || d.path.trim() || d.reading?.length || picked);
}

/**
 * A folder whose read ended after its form closed joins the kept draft, so it is there when the form opens again; one
 * that could not be read stays waiting, and is read again then (#113). Only a folder the draft still waits for joins.
 */
function keepLateRead(path: string, folder: KeptFolder | null) {
  const draft = keptNewDeal();
  const same = (p: string) => windowsPath(p) === windowsPath(path);
  // a folder no longer waiting was read again, or removed, by a form opened since: the read ending late is old news
  if (!draft || !folder || !(draft.reading ?? []).some(same)) return;
  const stillWaiting = (draft.reading ?? []).filter((p) => !same(p));
  const folders = draft.folders.some((f) => same(f.path)) ? draft.folders : [...draft.folders, folder];
  keepNewDeal({ ...draft, folders, reading: stillWaiting });
}

type DraftFields = Pick<KeptNewDeal, 'name' | 'counterparty' | 'kinds' | 'folders'>;

function restoreDraft(form: DraftFields) {
  const draft = !form.name && !form.folders.length ? keptNewDeal() : null;
  if (!draft) return null;
  const listed = (path: string) => draft.folders.some((folder) => windowsPath(folder.path) === windowsPath(path));
  const reading = (draft.reading ?? []).filter((path) => !listed(path));
  // A typed path that Create was reading goes back as a pending folder, without a duplicate in the path field (#113).
  const path = reading.some((pending) => windowsPath(pending) === windowsPath(draft.path)) ? '' : draft.path;
  const { name, folders, kinds, counterparty } = draft;
  return { fields: { name, folders, kinds, counterparty }, path, reading };
}

// A reopened New deal form reads the pending folders itself, so a read from the old form must leave its draft alone.
let formsOpen = 0;

export class NewDealDraftSession {
  private reading = new Map<string, string>();
  private queued: string[] = [];
  private live = true;

  constructor(private keeps: boolean, private show: (waiting: string[]) => void) {}

  open(form: DraftFields) {
    if (!this.keeps) return null;
    formsOpen++;
    return restoreDraft(form);
  }

  close() {
    if (this.keeps) formsOpen--;
    this.live = false;
  }

  keep({ name, counterparty, kinds, folders }: DraftFields, path: string) {
    if (!this.keeps || !this.live) return;
    const draft = { name, counterparty, kinds, folders, path, reading: this.waiting() };
    keepNewDeal(hasNewDealDraft(draft) ? draft : null);
  }

  private waiting() {
    return [...this.reading.values(), ...this.queued];
  }

  /** Read folders in order. Those still waiting when the form closes stay in the draft (#113). */
  async readEach(paths: string[], read: (path: string) => Promise<unknown>) {
    this.queued = [...this.queued, ...paths];
    this.show(this.waiting());
    for (const path of paths) {
      if (!this.live) return;
      this.queued = this.queued.filter((pending) => pending !== path);
      await read(path);
    }
    this.show(this.waiting());
  }

  busy() {
    return this.reading.size > 0 || this.queued.length > 0;
  }

  isReading(path: string) {
    return this.reading.has(windowsPath(path));
  }

  started(path: string) {
    this.reading.set(windowsPath(path), path);
    this.show(this.waiting());
  }

  /** True when the open form should receive the result. A late read can only update its own kept draft (#113). */
  finished(path: string, folder: KeptFolder | null) {
    this.reading.delete(windowsPath(path));
    this.show(this.waiting());
    if (this.live) return true;
    if (this.keeps && !formsOpen) keepLateRead(path, folder);
    return false;
  }
}
