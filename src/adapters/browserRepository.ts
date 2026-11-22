/**
 * The browser demo's record store: the backend's LogRepository, on folders kept in the window's storage (folders.ts).
 *
 *   localStorage     dil/2/shared/…     the change files of every tab: the demo's shared folder
 *                    dil/2/journal/…    the undo journal, which every tab reads and writes, as the windows of one PC do
 *   sessionStorage   dil/2/local/…      this tab's install id and its copy of its own change files
 *
 * Each tab is a PC of its own, so two tabs never append to one file: another tab's changes are read as another PC's are,
 * as soon as its storage event arrives. The tabs of this browser are not listed among the other PCs.
 */
import { LogRepository, type LogRepositoryOptions } from '../backend/logRepository';
import type { Transaction, SyncState } from '../ports';
import { ok, type Result } from '../domain/result';
import { StorageFolder } from './folders';

const SHARED = 'dil/2/shared/', JOURNAL = 'dil/2/journal/', LOCAL = 'dil/2/local/', TABS = 'dil/2/tabs';
const locks = () => (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;

/**
 * Hold this install for as long as the tab is open. False when another tab holds it: a duplicated tab starts with a copy of
 * the first one's session storage, install id included, and must not write under it. A reload waits a moment for the page
 * it replaces to let go; a tab still open after a few seconds is another tab.
 */
const claim = (id: string) => new Promise<boolean>((done) => {
  const l = locks(); if (!l) { done(true); return; }
  l.request(`dil/2/install/${id}`, { signal: AbortSignal.timeout(3000) }, () => { done(true); return new Promise<void>(() => {}); }).catch(() => done(false));
});
const tabs = (): string[] => { try { const v = JSON.parse(localStorage.getItem(TABS) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

export class BrowserRepository extends LogRepository {
  private constructor(o: LogRepositoryOptions, readonly shared: StorageFolder) { super(o); }

  static async open(user: () => string, inTouch?: () => boolean): Promise<BrowserRepository> {
    const local = new StorageFolder(sessionStorage, LOCAL);
    let was: string | undefined; try { was = JSON.parse(local.read('install.json') ?? '{}').id; } catch { /* a new install */ }
    if (was && !(await claim(was))) local.clear();
    const shared = new StorageFolder(localStorage, SHARED);
    const repo = new BrowserRepository({ shared, local, journal: new StorageFolder(localStorage, JOURNAL), label: 'This PC', user, inTouch }, shared);
    if (repo.id !== was) await claim(repo.id);
    if (!tabs().includes(repo.id)) { try { localStorage.setItem(TABS, JSON.stringify([...tabs(), repo.id])); } catch { /* listed among the other PCs, then */ } }
    window.addEventListener('storage', (e) => { if (e.key?.startsWith(SHARED)) void repo.sync(); });
    return repo;
  }

  /** One write at a time across the tabs: the journal they share is read and written whole. */
  override transaction(tx: Transaction): Promise<Result<Record<string, number>>> {
    const l = locks(); return l ? l.request('dil/2/write', () => super.transaction(tx)) : super.transaction(tx);
  }
  override async sync(): Promise<Result<SyncState>> {
    const r = await super.sync(); if (!r.ok) return r;
    const mine = tabs(); return ok({ ...r.value, peers: r.value.peers.filter((p) => !mine.includes(p.id)) });
  }
}
