/**
 * What the connection card above the person's name says: the network, OneDrive, the model service
 * ("Intelligence") and whether changes from other PCs are waiting. The card shows only when something is wrong, and a dot
 * on the avatar only once it has lasted:
 *   - changes held back for 5 minutes, or OneDrive out of touch for 2 minutes;
 *   - never while the network is down (nothing can sync then, and the PC says it is offline);
 *   - a wait older than a day no longer marks the avatar: a PC that is never switched on would keep it lit for good.
 *     Its line stays in the card. OneDrive out on this PC always marks it. A wait is timed from when the held change was made, so a restart does not reset it;
 *   - OneDrive out for 15 minutes is also told once, in an ordinary notice.
 */
import type { State } from './state';
import { control, SERVICE } from '../control';
import type { AiSignIn, SharedFolderChoice, SharedFolderStatus, SharedPlace, SignInStatus } from '../ports';

/** the event a window hears when the app is connected again: a field whose save could not be written sends its text again */
export const CONNECTED = 'punchlist-connected';

export const DOT_WAITING_MS = 5 * 60_000;
export const DOT_ONEDRIVE_MS = 2 * 60_000;
export const DOT_QUIET_MS = 24 * 60 * 60_000;
export const NOTICE_ONEDRIVE_MS = 15 * 60_000;

export type Tone = 'good' | 'med' | 'high';
export interface ConnRow { /** Network, OneDrive, the service's name from the control file ("Intelligence"), Sync */ name: string; tone: Tone; lines: string[] }
export interface Connection { rows: ConnRow[]; wrong: boolean; dot: boolean; /** a notice to give once for this outage, or null */ notice: string | null }

/** a time today as "2:41 PM", another day as "Nov 14, 2:41 PM" */
export function clockTime(at: string, now: number): string {
  const d = new Date(at); const today = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString('en-US', today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
const names = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** `online`: whether the PC has a network (the window says); `now` in milliseconds. */
export function connection(s: Pick<State, 'sync' | 'net' | 'signin'>, online: boolean, now: number): Connection {
  const out = s.sync?.outOfTouchSince ?? null; const waiting = s.sync?.waiting ?? [];
  // what waits, and for which PC, is said whatever holds sync up as a whole
  const held = waiting.flatMap((w) => [`Waiting for ${w.label ?? 'another PC'}`, `${changes(w.changes)} from ${names(w.from)}`]);
  const sync: ConnRow = !online ? { name: 'Sync', tone: 'med', lines: ['Waiting for the network', ...held] }
    : out ? { name: 'Sync', tone: 'med', lines: ['Waiting for OneDrive', ...held] }
    : held.length ? { name: 'Sync', tone: 'med', lines: held }
    : { name: 'Sync', tone: 'good', lines: ['Up to date'] };
  const rows: ConnRow[] = [
    online ? { name: 'Network', tone: 'good', lines: ['Connected'] } : { name: 'Network', tone: 'high', lines: ['Offline'] },
    out ? { name: 'OneDrive', tone: 'high', lines: ['Not syncing', `Since ${clockTime(out, now)}`] }
      : !online ? { name: 'OneDrive', tone: 'med', lines: ['Waiting for the network'] }
      : { name: 'OneDrive', tone: 'good', lines: ['In sync'] },
    s.signin?.out ? { name: SERVICE, tone: 'high', lines: ['Not signed in'] }
      : s.net.model ? { name: SERVICE, tone: 'high', lines: ['Can’t be reached'] } : { name: SERVICE, tone: 'good', lines: ['Connected'] },
    sync,
  ];
  // lasted long enough to mark, and not so long that it has gone quiet
  const lasted = (since: string, after: number) => { const age = now - Date.parse(since); return age >= after && age < DOT_QUIET_MS; };
  // this PC's own OneDrive never goes quiet: the PC is plainly on, and its changes reach nobody until it is fixed
  const dot = online && ((!!out && now - Date.parse(out) >= DOT_ONEDRIVE_MS) || waiting.some((w) => lasted(w.since, DOT_WAITING_MS)));
  // OneDrive out for 15 minutes is also said once in a notice, as any other notice
  const notice = online && !!out && now - Date.parse(out) >= NOTICE_ONEDRIVE_MS ? `OneDrive hasn’t synced since ${clockTime(out, now)}` : null;
  return { rows, wrong: rows.some((r) => r.tone !== 'good'), dot, notice };
}

/** Each open form owns its state, including any API key being typed. */
function formState<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(change: Partial<T>) {
      state = { ...state, ...change };
      for (const listener of listeners) listener();
    },
  };
}

interface SignInForm {
  status: SignInStatus | null;
  mode: 'idle' | 'ways' | 'key';
  key: string;
  busy: boolean;
  error: { message: string; away: boolean } | null;
}

export function canUseSignInKey({ key, busy }: Pick<SignInForm, 'key' | 'busy'>) {
  return !busy && !!key.trim();
}

/** Sign-in at first setup and in Settings. The read-only watcher in Store also looks for later sign-outs. */
export class SignInConnection {
  private form = formState<SignInForm>({ status: null, mode: 'idle', key: '', busy: false, error: null });
  private lastStatusRequest = 0;
  private ignoreStatusThrough = 0;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;

  constructor(private signin: AiSignIn, private onSignedIn?: () => void) {}

  get = () => this.form.get();
  subscribe = (listener: () => void) => this.form.subscribe(listener);

  start = () => {
    this.active = true;
    // Polls from the start, so a first read that fails or stalls is read again rather than leaving the form blank
    // (#948). The first signed-in reply stops the polling.
    this.timer = setInterval(() => void this.readStatus(), 2000);
    void this.readStatus();
    return () => {
      this.active = false;
      this.ignoreStatusThrough = this.lastStatusRequest;
      clearInterval(this.timer);
    };
  };

  private readStatus() {
    // A later tick can get through a stalled status call. A slow reply still counts until a newer result is shown.
    const request = ++this.lastStatusRequest;
    return this.signin.status().then((result) => {
      if (!this.active || request <= this.ignoreStatusThrough || !result.ok) return;
      // Once signed in, ignore all outstanding replies from this round of polling.
      this.ignoreStatusThrough = result.value.signedIn ? this.lastStatusRequest : request;
      const wasSignedIn = this.get().status?.signedIn;
      this.form.update({ status: result.value });
      if (result.value.signedIn) {
        clearInterval(this.timer);
        if (!wasSignedIn) this.onSignedIn?.();
      }
    }, () => undefined);
  }

  setKey = (key: string) => this.form.update({ key, error: null });
  openKey = () => this.form.update({ mode: 'key', error: null });
  openWays = () => this.form.update({ mode: 'ways' });
  cancel = () => this.form.update({ mode: 'idle', error: null });

  signIn = async () => {
    this.form.update({ error: null });
    const result = await this.signin.signIn();
    if (!result.ok) {
      this.form.update({ error: { message: result.error.message, away: false } });
    } else if (!this.onSignedIn) {
      this.form.update({ mode: 'idle' });
    }
  };

  useKey = async () => {
    const state = this.get();
    if (!canUseSignInKey(state)) return;
    this.form.update({ busy: true, error: null });
    const result = await this.signin.paste(state.key);
    if (!result.ok) {
      const { message, kind } = result.error;
      this.form.update({ busy: false, error: { message, away: kind === 'unreachable' } });
      return;
    }
    this.form.update({ key: '', busy: false, ...(this.onSignedIn ? {} : { mode: 'idle' }) });
    // Reads started before the key was accepted can still report the old credential status.
    this.ignoreStatusThrough = this.lastStatusRequest;
    if (this.active) void this.readStatus();
  };
}

interface FolderForm {
  status: SharedFolderStatus | null;
  chosen: string | null;
  picked: SharedFolderChoice | null;
  busy: boolean;
  error: string;
}

const onlyFolder = (status: SharedFolderStatus | null) =>
  status && !status.path && status.found.length === 1 ? status.found[0] : null;

function localFolderChoice(found: string[], chosen: string | null) {
  return chosen && found.includes(chosen) ? chosen : found[0];
}

/** Prefer the folder just picked, then a local match, then the OneDrive suggestion when it can be used. */
export function sharedFolderOffer({ status, chosen, picked, error }: FolderForm) {
  const found = status && !status.path ? status.found : [];
  const teamLink = status?.missing ? '' : control.desktop.teamFolderLink;
  const local = localFolderChoice(found, chosen);
  const suggested = status?.missing || teamLink ? null : status?.suggested;
  const path = local ?? suggested;
  const offer = picked ?? (path ? { path, inOneDrive: true } : null);
  return {
    offer, teamLink, choices: picked || found.length < 2 ? [] : found,
    visible: !!status && (!onlyFolder(status) || !!error),
  };
}

/** Pick and confirm a folder. First setup looks for synced folders until the backend restarts on one. */
export class SharedFolderConnection {
  private form = formState<FolderForm>({ status: null, chosen: null, picked: null, busy: false, error: '' });
  private looking = false;
  private active = false;

  constructor(private place: SharedPlace, private firstSetup = false) {}

  get = () => this.form.get();
  subscribe = (listener: () => void) => this.form.subscribe(listener);

  start = () => {
    this.active = true;
    void this.look();
    const timer = this.firstSetup ? setInterval(() => void this.look(), 5000) : undefined;
    return () => {
      this.active = false;
      clearInterval(timer);
    };
  };

  private async look() {
    if (this.looking) return;
    this.looking = true;
    try {
      const result = await this.place.get();
      if (!this.active || !result.ok) return;
      const before = onlyFolder(this.get().status);
      this.form.update({ status: result.value });
      const only = onlyFolder(result.value);
      if (this.firstSetup && only && only !== before) void this.useFolder(only);
    } finally {
      this.looking = false;
    }
  }

  choose = (chosen: string) => this.form.update({ chosen });
  cancel = () => this.form.update({ picked: null });

  pick = async () => {
    this.form.update({ error: '' });
    const result = await this.place.pick();
    if (!result.ok) this.form.update({ error: result.error.message });
    else if (result.value) this.form.update({ picked: result.value });
  };

  async useFolder(path: string) {
    this.form.update({ busy: true, error: '' });
    const result = await this.place.use(path);
    // On success the backend restarts the window on this folder.
    if (!result.ok) this.form.update({ busy: false, error: result.error.message });
  }
}

type StartupConnection =
  | { stage: 'signin'; form: SignInConnection }
  | { stage: 'connect'; form: SharedFolderConnection }
  | { stage: 'ready' };

/** A PC's first sign-in precedes folder setup. Once both are ready, the shell can construct the normal Store. */
export async function startupConnection(
  services: { signin?: AiSignIn; place?: SharedPlace },
  hasRepository: boolean,
  onSignedIn: () => void,
): Promise<StartupConnection> {
  const { signin, place } = services;
  const status = signin ? await signin.status().catch(() => null) : null;
  if (signin && status?.ok && status.value.firstSetup && !status.value.signedIn) {
    return { stage: 'signin', form: new SignInConnection(signin, onSignedIn) };
  }
  if (place && !hasRepository) return { stage: 'connect', form: new SharedFolderConnection(place, true) };
  return { stage: 'ready' };
}
