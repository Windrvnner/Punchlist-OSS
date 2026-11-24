/**
 * The browser demo's shell: the only module that names the demo's adapters (the desktop app's is desktop.tsx).
 */
import { FOLDER_TIMING } from '../app/relink';
import { Store } from '../app/store';
import { BrowserRepository } from '../adapters/browserRepository';
import { OtherPC, type Who } from '../adapters/otherPC';
import { mockAi, mockDocuments, mockSession, mockFirstPass, systemClock, ulidIds, browserFiles, type MockOptions } from '../adapters/mocks';
import { BrowserLocal } from '../adapters/local';
import { csvCodec } from '../adapters/spreadsheet';
import { tableFrom, type Sheet } from '../domain/sheets';
import type { AiSignIn, SpreadsheetCodec, SyncState } from '../ports';
import { ok, fail } from '../domain/result';
import { COMMANDS, run } from './common';
import { assertControl, SERVICE } from '../control';

// A value out of range in the control file stops the app here, before anything starts, with the reason on screen.
try { assertControl(); } catch (e) { document.body.style.cssText = 'white-space:pre-wrap;padding:24px;overflow:auto'; document.body.textContent = (e as Error).message; throw e; }

// Test hooks for the mocks: window.__down = true makes every service call unreachable; window.__fail = {draft:true} fails one call type.
const mockOpts: MockOptions = { unreachable: () => !!(window as any).__down, failures: new Set(), latency: [120, 400], persistCache: true };
// window.__cacheLimit = 2 shrinks the mock store so documents rotate out (a service's file store has a limit).
Object.defineProperty(window, '__cacheLimit', { set(n: number) { mockOpts.cacheLimit = n; }, get() { return mockOpts.cacheLimit ?? 500; } });
// window.__pdf = { '*': { url, pages } } or { 'Name.pdf': { url, pages } } shows a real PDF for a document (the demo holds no page images of its own).
mockOpts.pdf = (doc) => { const m = (window as any).__pdf as Record<string, { url: string; pages?: number }> | undefined; return m ? m[doc] ?? m['*'] ?? null : null; };
const presetFail = (window as any).__fail as Record<string, boolean> | undefined;     // a test may set it before the app starts, to fail a call made as the app opens
Object.defineProperty(window, '__fail', { set(v: Record<string, boolean>) { mockOpts.failures = new Set(Object.keys(v || {}).filter((k) => v[k])); }, get() { return [...(mockOpts.failures ?? [])]; } });
if (presetFail) (window as any).__fail = presetFail;
// window.__folderWait = ms shortens how long the app looks for deal folders as it opens before it says what is missing;
// set it before the app starts. window.__away (in adapters/mocks.ts) says which folders are not on this PC.
if (typeof (window as any).__folderWait === 'number') { FOLDER_TIMING.wait = (window as any).__folderWait; FOLDER_TIMING.every = Math.min(FOLDER_TIMING.every, 200); }

// The stand-in reads and writes CSV only. window.__sheets = { 'log.xlsx': [{ name, grid }] } stands in for LibreOffice reading that file.
const sheets: SpreadsheetCodec = { ...csvCodec, async read(bytes, name, opts) {
  const given = (window as any).__sheets?.[name] as Sheet[] | undefined; if (!given) return csvCodec.read(bytes, name, opts);
  const t = tableFrom(given, opts); return t ? { ok: true, value: t } : { ok: false, error: { kind: 'invalid', message: 'The file has no rows' } };
},
// stand-in for LibreOffice and PDF.js reading a document's text: the demo takes the file's bytes as its text
async text(bytes) { return { ok: true, value: new TextDecoder().decode(bytes) }; } };
// the person's name goes on each change, as on a PC: known once the session has loaded (records carried over as the store opens give their own)
let person = '';
// window.__oneDrive = false stands for OneDrive not running on this PC, as the desktop shell finds it, until it is set back to true
const repo = await BrowserRepository.open(() => person, () => (window as any).__oneDrive !== false);
// Stand-in for the backend's review agents: when a deal finishes indexing they write findings through the repository.
mockOpts.onIndexed = (dealId) => { const d = store.get().deals[dealId]; if (d) void mockFirstPass(repo, dealId, d.name, mockOpts); };
// window.__signin = { signedIn, sso, apiKey } set before the app starts gives the demo a sign-in as the desktop app has one; setting
// window.__signin.signedIn = false later signs it out (the app goes read-only), and Single sign-on or the key 'good-key' signs in again
const si = (window as any).__signin as { signedIn?: boolean; sso?: boolean; apiKey?: boolean } | undefined;
const signin: AiSignIn | undefined = si ? {
  async status() { return ok({ signedIn: si.signedIn !== false, sso: si.sso ?? true, apiKey: si.apiKey ?? true }); },
  async signIn() { si.signedIn = true; return ok(undefined); },
  async paste(key) { if (key.trim() !== 'good-key') return fail({ kind: 'invalid', message: `${SERVICE} didn’t accept that key.` }); si.signedIn = true; return ok(undefined); },
} : undefined;
const store: Store = new Store({
  repo, ...(signin ? { signin } : {}),
  ai: mockAi(mockOpts, repo), docs: mockDocuments(mockOpts), fs: browserFiles, sheets, session: mockSession(mockOpts), local: new BrowserLocal(), clock: systemClock, ids: ulidIds,
}, COMMANDS);
(window as any).store = store; // for browser tests and the console
store.subscribe((s) => { person = s.user?.name ?? ''; });

// Test hooks for shared work. The demo has one PC, so these stand in for another one, which appends lines to the shared
// folder under an id of its own (adapters/otherPC.ts); each resolves once this PC has read them:
//   __peer.edit(recordId, patch, who?)  a change to a question, finding, deal or firm list that arrives from another PC, made without knowledge of this one
//   __peer.sync({ peers, holding })     the other PCs in `peers` have written (each says when, as in SyncState), and a change to each deal
//                                       in `holding` (ids) waits on a line of theirs that has not arrived, until a later call leaves it out
//   __peer.add(likeRecordId, patch)     a new question or finding that was created on another PC, shaped like an existing one (so it can share its number or code)
//   __peer.change(recordId, patch, who?)  a change to a question, finding or deal made on another PC after this PC's latest version of it had arrived
//   __peer.remove(recordId, who?)       a delete of a question or finding made on another PC without knowledge of this PC's version
//   __peer.deleteDeal(dealId, who?, unseen?)  a deal deleted on another PC; with `unseen`, before any of this PC's changes had reached it
const peer = new OtherPC(repo.shared);
const who = (w: Partial<Who> = {}): Who => ({ by: w.by ?? 'sroe', from: w.from ?? 'PC B', at: w.at ?? new Date().toISOString() });
const read = async <T,>(r: T) => { await repo.sync(); return r; };
(window as any).__peer = {
  edit(recordId: string, patch: Record<string, unknown>, by: Partial<Who> = {}) {
    const s = store.get(); const kind = recordId.startsWith('q_') ? 'question' : recordId.startsWith('f_') ? 'finding' : recordId.startsWith('l_') ? 'firmList' : 'deal';
    const cur = kind === 'question' ? s.questions[recordId] : kind === 'finding' ? s.findings[recordId] : kind === 'firmList' ? s.firmList[recordId] : s.deals[recordId];
    if (!cur) return 'missing';
    return read(peer.edit(kind, recordId, { ...cur, ...patch }, who(by)));
  },
  change(recordId: string, patch: Record<string, unknown>, by: Partial<Who> = {}) {
    const s = store.get(); const kind = recordId.startsWith('q_') ? 'question' : recordId.startsWith('f_') ? 'finding' : 'deal';
    const cur = kind === 'question' ? s.questions[recordId] : kind === 'finding' ? s.findings[recordId] : s.deals[recordId];
    if (!cur) return 'missing';
    return read(peer.change(kind, recordId, { ...cur, ...patch }, who(by)));
  },
  remove(recordId: string, by: Partial<Who> = {}) { return read(peer.remove(recordId.startsWith('q_') ? 'question' : 'finding', recordId, who(by))); },
  deleteDeal(dealId: string, by: Partial<Who> = {}, unseen = false) { peer.deleteDeal(dealId, who(by), unseen ? {} : undefined); return read(undefined); },
  sync(state: { peers: SyncState['peers']; holding?: string[] }) {
    for (const p of state.peers) if (p.lastChangeAt) peer.seen({ by: p.by, from: p.label, at: p.lastChangeAt });   // a PC that has written nothing is not known here yet
    const from = state.peers[0] ? who({ by: state.peers[0].by, from: state.peers[0].label }) : who();
    const holding = state.holding ?? [];
    for (const d of holding) peer.hold(d, from);
    for (const d of peer.holding()) if (!holding.includes(d)) peer.release(d);
    return read(undefined);
  },
  add(likeRecordId: string, patch: Record<string, unknown> = {}) {
    const s = store.get(); const kind = likeRecordId.startsWith('q_') ? 'question' : 'finding';
    const like = kind === 'question' ? s.questions[likeRecordId] : s.findings[likeRecordId]; if (!like) return null;
    const id = ulidIds.next(kind === 'question' ? 'q' : 'f'); const at = new Date().toISOString();
    peer.create(kind, id, { ...like, ...patch, id, rev: 0, createdAt: at, updatedAt: at }, like.dealId, who());
    return read(id);
  },
};

await run(store);
