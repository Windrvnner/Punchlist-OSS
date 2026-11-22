// The app's record store for tests: the backend's LogRepository on folders kept in memory, with another PC beside it that
// writes to the same shared folder (adapters/otherPC.ts). The same store the desktop app and the browser demo use.
import { LogRepository, type Folder, type LogRepositoryOptions } from '../../src/backend/logRepository';
import { OtherPC } from '../../src/adapters/otherPC';

export class Mem implements Folder { files = new Map<string, string>(); list() { return [...this.files.keys()]; } size(n: string) { return this.files.get(n)?.length ?? -1; } read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); } }

/** A PC's store. Give `shared` to put a second PC on the same shared folder, and `shared` and `local` to start the same install again. */
export function memRepo(clock?: () => string, o: Partial<LogRepositoryOptions> = {}) {
  const shared = o.shared ?? new Mem(), local = o.local ?? new Mem();
  const repo = new LogRepository({ label: 'This PC', user: () => 'adoe', clock, ...o, shared, local });
  return Object.assign(repo, { shared, local, peer: new OtherPC(shared) });
}
export type MemRepo = ReturnType<typeof memRepo>;
/** A PC's two folders: `memRepo(clock, disk)` again on the same disk is the same install started again. */
export const disk = () => ({ shared: new Mem(), local: new Mem() });
export type Disk = ReturnType<typeof disk>;
/** Another PC, for changes that arrive from elsewhere. */
export const ELSEWHERE = { by: 'sroe', from: 'PC B', at: '2026-11-09T23:14:00.000Z' };
/** Make `folder` refuse to append text that `when` picks out (the first `times` such appends), with the error `error` makes; returns what puts it back. */
export function refuse(folder: Folder, when: (text: string) => boolean, error: () => Error, times = Number.POSITIVE_INFINITY) {
  const append = folder.append.bind(folder); folder.append = (n, t) => { if (times > 0 && when(t)) { times--; throw error(); } append(n, t); };
  return () => { folder.append = append; };
}
/** storage that is full, as a browser says so */
export const quota = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
/** a change that writes a question */
export const toAQuestion = (text: string) => text.includes('"kind":"question"');
/** Make the next write to `folder`, of any file, fail as a full disk does. */
export function refuseNext(folder: Folder) {
  const { append, write } = folder; const back = () => { folder.append = append; folder.write = write; };
  folder.append = () => { back(); throw quota(); }; folder.write = () => { back(); throw quota(); };
}
