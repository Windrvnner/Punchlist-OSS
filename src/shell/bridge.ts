/**
 * The bridge between the desktop app's window and its backend, which runs in Electron's main process.
 *
 * Both sides share the list below of what may cross: each service the Store uses and the methods it may call on it.
 * The main process serves them (src/desktop/host.ts `serve`); the window builds its services from them here
 * (`bridged`). Nothing else crosses: the window is given no Node, no paths to open and no way to call anything not listed.
 *
 * The rules from docs/architecture.md that this file keeps:
 * - Every bridged method resolves to a `Result`. If the main process cannot be reached (the call rejects), the method
 *   resolves to `unreachable`, because the app has no handler for a rejected promise.
 * - An optional method the backend leaves out is left out here too, so its feature hides rather than fails.
 * - `repo.watch` and `conversations.watch` arrive over a channel from the main process to the window.
 * - `fs.pathFor` answers synchronously (Electron's webUtils, in the preload).
 */
import { fail } from '../domain/result';
import type { Repository, AiService, DocumentService, SpreadsheetCodec, Session, ConversationStore, FileSystem, SharedPlace, AiSignIn, QaLogFiles } from '../ports';

/** every service and method the window may call in the main process */
export const BRIDGED = {
  repo: ['get', 'list', 'transaction', 'audit', 'sync', 'recover', 'seen'],
  ai: ['answer', 'research', 'stop', 'draft', 'reassess', 'dealBrief', 'memo', 'gaps', 'addresses', 'merge', 'layout', 'reword', 'sameMeaning', 'phrase', 'issuesList', 'checkAll', 'checked', 'responses', 'progress', 'checklist', 'readList'],
  docs: ['scanFolder', 'index', 'poll', 'freshen', 'page', 'attach', 'cached', 'drafts', 'places', 'findFolders', 'locateTop', 'placeFolders', 'sameRoom'],
  sheets: ['read', 'write', 'document', 'text'],
  qaLogs: ['read', 'save', 'create', 'settle'],
  session: ['load'],
  conversations: ['load', 'save'],
  fs: ['pickFolders', 'save', 'pickSave', 'writePicked', 'openPicked'],
  place: ['get', 'pick', 'use'],
  signin: ['status', 'signIn', 'paste'],
} as const satisfies Record<string, readonly string[]>;
export type ServiceName = keyof typeof BRIDGED;
/** the services whose changes the main process sends to the window as they happen */
export const WATCHED = ['repo', 'conversations'] as const;
export type Watched = (typeof WATCHED)[number];

/** Which of the listed methods the backend really has, per service. A service it does not have at all is absent. */
export type Available = Partial<Record<ServiceName, string[]>>;

/** What the preload puts on `window.punchlist`: the whole of the window's reach into the main process. */
export interface BridgeApi {
  /** which services and methods the backend has (asked once, before the Store is made) */
  describe(): Promise<Available>;
  call(service: ServiceName, method: string, args: unknown[]): Promise<unknown>;
  /** listen for changes the main process sends; returns a function that stops listening */
  on(service: Watched, listener: (change: unknown) => void): () => void;
  /** the path of a file dropped or picked in the window */
  pathFor(file: File): string;
}

export interface BridgedServices {
  repo: Repository; ai: AiService; docs: DocumentService; session: Session; fs: FileSystem;
  sheets?: SpreadsheetCodec; qaLogs?: QaLogFiles; conversations?: ConversationStore; place?: SharedPlace; signin?: AiSignIn;
}

const unreachable = () => fail({ kind: 'unreachable', message: 'The app’s backend could not be reached.' });

/** One service's methods, as far as the backend has them, each turning a rejected call into `unreachable`. */
function side(api: BridgeApi, service: ServiceName, have: string[]): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of BRIDGED[service] as readonly string[]) {
    if (!have.includes(m)) continue;
    out[m] = async (...args) => {
      try {
        const r = await api.call(service, m, args);
        // a Result has a boolean `ok`; anything else means the other side broke its contract, which the app reads as a failure
        return r && typeof r === 'object' && typeof (r as { ok?: unknown }).ok === 'boolean' ? r : fail({ kind: 'failed', message: 'The app’s backend gave an answer this window cannot read.' });
      } catch { return unreachable(); }
    };
  }
  return out;
}

/** The window's services, built on the bridge. `available` is what `api.describe()` returned. */
export function bridged(api: BridgeApi, available: Available): BridgedServices {
  const of = (s: ServiceName) => side(api, s, available[s] ?? []);
  const watch = (s: Watched) => (onChange: (change: never) => void) => api.on(s, onChange as (change: unknown) => void);
  const fsSide = of('fs');
  return {
    repo: { ...of('repo'), watch: watch('repo') } as unknown as Repository,
    ai: of('ai') as unknown as AiService,
    docs: of('docs') as unknown as DocumentService,
    session: of('session') as unknown as Session,
    fs: {
      pickFolders: (fsSide.pickFolders as FileSystem['pickFolders']) ?? null,
      pathFor: (file: File) => api.pathFor(file),
      save: (fsSide.save as FileSystem['save']) ?? (async () => fail({ kind: 'failed', message: 'Couldn’t save the file' })),
      ...(fsSide.pickSave && fsSide.writePicked ? { pickSave: fsSide.pickSave as FileSystem['pickSave'], writePicked: fsSide.writePicked as FileSystem['writePicked'], ...(fsSide.openPicked ? { openPicked: fsSide.openPicked as FileSystem['openPicked'] } : {}) } : {}),
    },
    ...(available.sheets ? { sheets: of('sheets') as unknown as SpreadsheetCodec } : {}),
    ...(available.qaLogs ? { qaLogs: of('qaLogs') as unknown as QaLogFiles } : {}),
    ...(available.place ? { place: of('place') as unknown as SharedPlace } : {}),
    ...(available.signin ? { signin: of('signin') as unknown as AiSignIn } : {}),
    ...(available.conversations ? { conversations: { ...of('conversations'), watch: watch('conversations') } as unknown as ConversationStore } : {}),
  };
}
