/**
 * The real backend, put together in one place. The Windows shell uses this, and so do the end-to-end tests
 * (tests/e2e), so what the tests run is what ships: the change files on the shared folder, the documents on real folders,
 * the checks, and the model service given here (the provider the control file picks in the product, a stand-in or
 * Claude in tests).
 *
 * One install id is used throughout: the repository's, kept in the PC's local folder (install.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LogRepository } from './logRepository';
import { nodeDocuments } from './documents';
import { wordIndex } from './wordIndex';
import { nodeAi, type AiOptions, type Checklist } from './ai';
import { nodeSession } from './session';
import { nodeFolder } from './nodeFolder';
import { StoreKeeper } from './storeKeeper';
import { conversationLog } from './conversationLog';
import type { ModelService } from './service';
import { assertControl } from '../control';
import type { Converter } from './convert';
import { libreOfficeSheets } from './spreadsheets';
import type { Repository, AiService, DocumentService, Session, ConversationStore, SpreadsheetCodec, QaLogFiles } from '../ports';
import { nodeQaLogs } from './qaLogs';

export interface BackendOptions {
  /** whether a call to the model service is waiting on a sign-in window in front of the person; start-up waits for that rather than giving up */
  signingIn?: () => boolean;
  /** whether a call is waiting for a sign-in with no window to sign in from (an API key not yet entered): start-up then says so */
  signedOut?: () => boolean;
  /** opens the single sign-on window again where there is one, so start-up's Retry after it was closed signs in rather than asking for a key */
  signInAgain?: () => void;
  /** whether someone is signed in to the model service right now: start-up does not wait for a sign-in (the app opens read-only) */
  signedInNow?: () => boolean;
  /** the shared folder every PC on the team syncs (OneDrive), holding the app's own record files and nothing of the data room */
  sharedPath: string;
  /** this PC's own folder for the app (AppData): install id, journal, local copies, store bookkeeping */
  localPath: string;
  /** a folder on this PC for conversions and files being indexed */
  workPath: string;
  /** this PC's name as the others will see it beside its changes */
  label: string;
  /** who the model service last said is signed in, from a backend this one replaces on the same PC: conversations go on under that person until the session has loaded again */
  person?: string | null;
  /** the person at this PC, when the model service cannot say */
  user: () => string;
  /** the machine and Windows user this install belongs to (the shell gives MachineGuid and the user's SID): a copied folder is then a new install */
  machine?: () => string;
  /** the model service: the provider the control file picks (models.service) */
  service: ModelService;
  /** turns a page-shaped file into a PDF; without one only PDFs and spreadsheets are indexed */
  convert?: Converter;
  /** the deal's checklist in its layers, as the firm keeps it */
  checklist?: AiOptions['checklist'];
  clock?: () => string;
  /** passed through to the checks, for tests that want small batches */
  tuning?: Pick<AiOptions, 'width' | 'batch' | 'shortlist'>;
  /** the times PCs share a deal's checks by (short ones in tests) */
  timing?: AiOptions['timing'];
  /** whether this PC's own files are in sync with the shared folder: the shell asks Windows; tests stand in */
  inTouch?: AiOptions['inTouch'];
  /** this PC's clock in milliseconds, for judging who is live (tests move it to stand in for a PC that slept) */
  now?: () => number;
  /** how failed AI calls are asked again (src/backend/retry.ts): the control file's values unless set; tests give no waits */
  retry?: AiOptions['retry'];
}

export interface Backend {
  repo: Repository;
  ai: AiService;
  docs: DocumentService;
  /** spreadsheets in and out, through LibreOffice (the converter) */
  sheets?: SpreadsheetCodec;
  /** the counterparties' Q&A logs as files */
  qaLogs: QaLogFiles;
  session: Session;
  /** each person's conversations, in the synced folder */
  conversations: ConversationStore;
  installId: string;
  /** who the model service said is signed in, once the session has loaded (null before): a backend that replaces this one is given it */
  person(): string | null;
  /** the file a page URL's token stands for (the shell serves `punchlist-doc://<token>` from it); null for a token this run did not give out */
  fileFor(token: string): string | null;
  /** look at the model service's file store and take out what is over its limit; the shell runs it on a timer. Returns how many were taken out. */
  trim(): Promise<number>;
  /** Wait until every first pass started by indexing has ended (for tests and an orderly close). */
  idle(): Promise<void>;
  /** stop, and resolve once the writes already started (changes, and this PC leaving its checks) have landed, so another backend can open the same files */
  close(): Promise<void>;
}

export function composeBackend(o: BackendOptions): Backend {
  assertControl();                                                                 // a value out of range in the control file stops the backend before it starts
  const clock = o.clock ?? (() => new Date().toISOString());
  const shared = nodeFolder(o.sharedPath), local = nodeFolder(o.localPath);
  // the shared folder as one name, however it was reached (a mapped drive, a link; Windows paths ignore case): another one has an install id of its own
  let real = path.resolve(o.sharedPath); try { real = fs.realpathSync.native(o.sharedPath); } catch { /* not there yet: as given */ }
  const place = process.platform === 'win32' ? real.toLowerCase() : real;
  const repo = new LogRepository({ shared, local, label: o.label, user: o.user, clock, machine: o.machine, place, inTouch: o.inTouch });
  const installId = repo.id;
  const keeper = new StoreKeeper(o.service, local, { clock });
  const running = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { running.add(p); void p.finally(() => running.delete(p)); };
  // where a deal's folders are, as its record lists them
  const folders = async (dealId: string): Promise<string[]> => {
    const r = await repo.get('deal', dealId); const d = r.ok ? (r.value?.envelope.data as { folders?: { path: string }[] } | undefined) : undefined;
    return (d?.folders ?? []).map((f) => f.path);
  };
  const foldersNow = (dealId: string): string[] | null => {
    const d = repo.peek('deal', dealId)?.envelope.data as { folders?: { path: string }[] } | undefined;
    return d ? (d.folders ?? []).map((f) => f.path) : null;
  };
  // eslint-disable-next-line prefer-const
  let ai: ReturnType<typeof nodeAi>;
  const index = wordIndex(local);                 // each PC's own, in its local folder
  const docs = nodeDocuments({
    index, shared, local, sharedPath: o.sharedPath, installId, keeper, clock, workPath: path.join(o.workPath, 'work'), convert: o.convert, folders, foldersNow,
    // a deal whose folders have all been indexed has its first pass, as the product does; one a check is about to read waits for it (below)
    onIndexed: (dealId, how) => (how?.forCheck ? owe(dealId) : track(ai.firstPass(dealId))),
  });
  ai = nodeAi({
    service: o.service, docs: { records: docs.records, wanted: docs.wanted, away: docs.away, shut: docs.shut, unread: docs.unread, describe: docs.describe, undescribed: docs.undescribed, wordIndex: index, changes: docs.changes, indexing: docs.indexing }, keeper, repo, shared, local, installId, clock,
    // a record the backend wrote itself (a finding raised or marked) is announced like one from another PC, so the window reads it again
    checklist: o.checklist, label: o.label, person: o.user, announce: (kind, id) => repo.announce(kind, id), ...(o.tuning ?? {}), timing: o.timing, inTouch: o.inTouch, now: o.now, retry: o.retry,
  });
  // Conversations follow the person the model service says is signed in (whoami), so the same person on an office and a
  // home PC with different Windows logins sees the same conversations. Until the session has loaded, the PC's user.
  const signed = nodeSession({ service: o.service, local, signedIn: o.user, clock, signingIn: o.signingIn, signedOut: o.signedOut, signInAgain: o.signInAgain, signedInNow: o.signedInNow }); let person: string | null = o.person ?? null;
  const session: typeof signed = { ...signed, async load(opts) { const r = await signed.load(opts); if (r.ok && r.value.user.name) person = r.value.user.name; return r; } };
  const conversations = conversationLog({ shared, local, installId, user: () => person ?? o.user(), clock });
  // New documents a look found for a check of everything: the check reads them, so their first pass runs only once that
  // check has ended. By then the check has covered them, and the first pass has nothing left to ask about them; if the check
  // did not finish (stopped, signed out, the service failing, or refused), the first pass checks them as it always would. If
  // no check starts within a minute or two (the window closed meanwhile), the first pass runs anyway. Nothing is skipped.
  // What is owed is also kept on this PC (owed.json), so that an app closed before the check ends runs those first passes when it next opens.
  const owed = new Map<string, { checking: boolean; timer: ReturnType<typeof setTimeout> }>();
  const keepOwed = () => { try { local.write('owed.json', JSON.stringify([...owed.keys()])); } catch { /* the first pass then waits for the next check */ } };
  const pay = (dealId: string) => { const w = owed.get(dealId); if (w) clearTimeout(w.timer); owed.delete(dealId); keepOwed(); track(ai.firstPass(dealId)); };
  const owe = (dealId: string) => {
    if (owed.has(dealId)) return;
    const timer = setTimeout(() => { if (owed.get(dealId)?.checking === false) pay(dealId); }, 2 * 60_000);
    (timer as { unref?: () => void }).unref?.(); owed.set(dealId, { checking: false, timer }); keepOwed();
  };
  const checkAll = ai.checkAll;
  ai.checkAll = async (input) => {
    const w = owed.get(input.dealId); if (w) w.checking = true;
    try { return await checkAll(input); }
    finally { if (owed.has(input.dealId)) pay(input.dealId); }
  };
  let left: unknown = []; try { left = JSON.parse(local.read('owed.json') ?? '[]'); } catch { /* none */ }
  if (Array.isArray(left) && left.length) { try { local.write('owed.json', '[]'); } catch { /* run again next time */ } for (const id of left) if (typeof id === 'string') track(ai.firstPass(id)); }
  ai.watchDeals();                                                                 // a checklist round a PC left unfinished is picked up by another that has the deal open
  return {
    repo, ai, docs, session, conversations, installId, person: () => person, fileFor: docs.fileFor, trim: () => keeper.trim(), ...(o.convert ? { sheets: libreOfficeSheets(o.convert) } : {}),
    qaLogs: nodeQaLogs({ convert: o.convert }),
    async idle() { while (running.size) await Promise.allSettled([...running]); await ai.settled(); },
    async close() { for (const w of owed.values()) clearTimeout(w.timer); conversations.close(); await Promise.all([ai.close(), repo.close()]); },
  };
}

export type { Checklist };
