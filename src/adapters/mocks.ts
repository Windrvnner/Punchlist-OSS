/**
 * Demo adapters. Every call takes real time (configurable latency), returns a
 * fresh copy of its data, and never shares references with the caller. The
 * production backend replaces these with adapters for the same ports.
 */
import { candidates, ruleFrom, rewrite, topsOf, under, key as pathKey, type Rule, deeper } from '../domain/relink';
import { ulid } from 'ulid';
import type { AiService, DocumentService, FileSystem, Session, Clock, Ids, Repository, ChecklistRow, Research, ResearchStep, CheckState, IssuePoint } from '../ports';
import { CHECK_REASON, type Deal, type Folder, type RecordKind } from '../domain/model';
import { ok, fail, type Result } from '../domain/result';
import { tellingWords } from '../domain/suggest';
import { key } from '../domain/checklist';
import type { LineRead } from '../domain/listRead';
import { suggestChecklistColumns, type ChecklistMapping } from '../domain/checklistImport';

/** a repository that can tell the app about a record written by something other than a window (the backend's pipeline; here, the mocks) */
export type Announcing = Repository & { announce(kind: RecordKind, id: string): void };

export interface MockOptions { latency?: [number, number]; failures?: Set<string>; unreachable?: () => boolean; /** the backend's pipeline hook: called once when a deal's folders finish indexing */ onIndexed?: (dealId: string) => void;
  /** how many documents the mock store holds before the oldest rotate out (a service's file store has a limit) */
  cacheLimit?: number;
  /** keep the mock store's contents across reloads and tabs, as the real one persists */ persistCache?: boolean;
  /** a real PDF to show for a document, for looking at real pages in the demo; `pages` wraps a cited page number onto the file's own pages */ pdf?: (doc: string) => { url: string; pages?: number } | null }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function mockLatency(opts: MockOptions) {
  const [a, b] = opts.latency ?? [120, 400];
  return () => wait(a + Math.random() * (b - a));
}

/** {phrase|findingId}: the phrase is the title without the three characters the form itself uses. */
/** a title read mid-sentence: its first letter lower-cased, unless the first word is an acronym ("DSRA") */
const midSentence = (t: string) => (/^\p{Lu}{2}/u.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
const findingLink = (f: { id: string; title?: string; }) => { const p = String(f.title ?? '').replace(/[{}|]/g, ' ').replace(/\s+/g, ' ').trim(); return `{${p ? midSentence(p) : 'finding'}|${f.id}}`; };

async function gate<T>(opts: MockOptions, name: string, fn: () => T | Promise<T>): Promise<Result<T>> {
  await mockLatency(opts)();
  if (opts.unreachable?.()) return fail({ kind: 'unreachable', message: 'Backend unreachable' });
  if (opts.failures?.has(name)) return fail({ kind: 'failed', message: `${name} failed` });
  return ok(copy(await fn()));
}

/** what was attached, by document id: the stand-in for the issues list reads it (a text file only) */
const attached = new Map<string, Uint8Array>();

/** the demo credit agreement's earlier drafts: the folder each is in, and the date read from it */
const MOCK_DRAFTS: [string, string][] = [['03-20-2026', '2026-03-20'], ['2026-03-01', '2026-03-01']];
/** A stable id for a document in a deal. The real backend issues these; names are not identities. */
export function mockDocId(dealId: string, name: string): string {
  let h = 2166136261; for (const c of `${dealId}/${name}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `doc_${h.toString(36)}`;
}

/**
 * An attached file's id. The real backend makes it from the file's bytes alone; here the name goes in too, so the stand-in's
 * other documents keep their ids. Either way, a revised file saved under the same name is another document.
 */
export function mockAttachedId(dealId: string, name: string, bytes: Uint8Array): string {
  let h = 2166136261; for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return mockDocId(dealId, `${name}\u0000${h.toString(36)}`);
}

/** Stand-in for the user's store: the ids of the documents loaded right now, oldest first, capped. Documents enter when they are read. */
const CACHE_KEY = 'dil/mock/cached';
const memory = new WeakMap<MockOptions, string[]>();
function cachedIds(opts: MockOptions): string[] {
  if (opts.persistCache) { try { const v = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } }
  return memory.get(opts) ?? [];
}
function loadIntoStore(opts: MockOptions, ids: string[]) {
  let cur = cachedIds(opts);
  for (const id of ids) { cur = cur.filter((x) => x !== id); cur.push(id); }
  cur = cur.slice(-Math.max(1, opts.cacheLimit ?? 500));
  if (opts.persistCache) { try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(cur)); } catch { /* the mark is a convenience; losing it changes nothing */ } }
  else memory.set(opts, cur);
}

export const systemClock: Clock = { now: () => new Date().toISOString() };
export const ulidIds: Ids = { next: (p) => `${p}_${ulid()}` };

export const mockSession = (opts: MockOptions = {}): Session => ({
  load: () => opts.failures?.has('signedOut') ? mockLatency(opts)().then(() => fail({ kind: 'rejected' as const, message: 'Nobody is signed in.' }))   // signedOut: the sign-in window was closed at start-up
    : opts.failures?.has('startFails') ? mockLatency(opts)().then(() => fail({ kind: 'failed' as const, message: 'The settings on this PC could not be read.' })) : gate(opts, 'session', () => ({   // startFails: a start-up that fails for a reason other than the network
    // a sign-in name, as whoami gives it; the firm's name comes from the control file
    user: { name: 'jdoe', initials: 'J' },
    lastSeen: new Date(Date.now() - 3 * 864e5).toISOString(),
    models: [{ id: 'fast', name: 'Fast' }, { id: 'standard', name: 'Standard' }, { id: 'thorough', name: 'Thorough' }],
    defaultModel: 'standard',
  })),
});

export function mockDocuments(opts: MockOptions = {}): DocumentService {
  type Away = { folders?: { dealId: string; folder: string }[]; dirs?: string[]; back?: number; empty?: { dealId: string; folder: string }[] };
  const away = (): Away => (globalThis as { __away?: Away }).__away ?? {};
  const awayDirs = () => away().dirs ?? [];
  const awayNow = () => { const a = away(); return a.back !== undefined && Date.now() >= a.back ? [] : a.folders ?? []; };
  /** folders that open where recorded but hold nothing, located as a missing one is */
  const emptyNow = () => away().empty ?? [];
  const opens = (p: string) => awayDirs().some((d) => pathKey(d) === pathKey(p));
  const placeKey = (f: { dealId: string; folder: string }) => `${f.dealId}\u0000${pathKey(f.folder)}`;
  const placed = new Map<string, string>(); let rules: Rule[] = [];
  const progress = new Map<string, { folders: Folder[]; log: string[]; announced?: boolean }>();
  // Like the real backend, the stand-in remembers how far an unfinished run had got, so a reload part-way can say where it stopped.
  const KEY = 'mock.indexing'; const box = (): Storage | null => { try { return !opts.persistCache || typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };   // only where the stand-in is asked to persist, as in the app; never in unit tests
  const kept = (): Record<string, Folder[]> => { try { return JSON.parse(box()?.getItem(KEY) ?? '{}'); } catch { return {}; } };
  // like the real backend, it remembers that it was asked to index a deal's folders even when the start is refused
  const asked = (dealId: string, folders: Folder[]): false => { const was = kept()[dealId] ?? []; const add = folders.filter((f) => !was.some((x) => x.path === f.path)).map((f) => ({ ...f, indexed: 0, reviewed: 0 })); if (add.length) keep(dealId, [...was, ...add]); return false; };
  const keep = (dealId: string, folders: Folder[] | null) => { const b = box(); if (!b) return; const all = kept(); if (folders) all[dealId] = folders; else delete all[dealId]; try { b.setItem(KEY, JSON.stringify(all)); } catch { /* not kept */ } };
  return {
    scanFolder: (path) => gate(opts, 'scanFolder', () => {
      let h = 0; for (const c of path) h = (h * 31 + c.charCodeAt(0)) % 9973;
      const files = /vdr|data ?room|export/i.test(path) ? 1500 + (h % 1200) : 40 + (h % 400);
      return { files, size: (files * 2.2 / 1000).toFixed(1) + ' GB' };
    }),
    // `roomAway` stands for a data room that cannot be reached yet: the start is refused before anything is done, as the real backend refuses it
    index: (dealId, folders) => asked(dealId, folders) || opts.failures?.has('roomAway') ? mockLatency(opts)().then(() => fail({ kind: 'notFound' as const, message: `${folders[0]?.path ?? 'The folder'} could not be opened on this PC` })) : gate(opts, 'index', () => {
      const cur = progress.get(dealId) ?? { folders: [], log: [] };
      const was = kept()[dealId] ?? [];                              // files already indexed before a stop are not indexed again
      for (const f of folders) if (!cur.folders.some((x) => x.path === f.path)) cur.folders.push({ ...f, indexed: was.find((x) => x.path === f.path)?.indexed ?? 0, reviewed: 0 });
      cur.log = [`Indexing ${cur.folders.length} folder${cur.folders.length > 1 ? 's' : ''}`]; cur.announced = false;
      progress.set(dealId, cur);
    }),
    poll: (dealId) => gate(opts, 'poll', () => {
      const cur = progress.get(dealId);
      if (!cur) { const left = kept()[dealId]; return left?.length ? { folders: left, log: [], done: false, stopped: true } : { folders: [], log: [], done: true }; }
      let done = true;
      for (const f of cur.folders) {
        if (f.indexed < f.files) { f.indexed = Math.min(f.files, f.indexed + Math.ceil(f.files / 8)); done = false; }      // indexing reads no document: nothing is counted as reviewed
      }
      if (done) { cur.log = [`Indexed ${cur.folders.reduce((a, f) => a + f.files, 0).toLocaleString()} files`]; if (!cur.announced) { cur.announced = true; opts.onIndexed?.(dealId); } }
      // like the real backend: folders asked for since (a start that was refused) are not finished because an earlier run is
      const asked = (kept()[dealId] ?? []).filter((k) => !cur.folders.some((x) => x.path === k.path));
      if (done && asked.length) return { folders: [...cur.folders, ...asked], log: [], done: false, stopped: true };
      keep(dealId, done ? null : cur.folders);
      return { folders: cur.folders, log: cur.log, done };
    }),
    page: async (dealId, ref, loc) => {
      const doc = ref.doc; const id = ref.docId;
      // a document that has rotated out of the store is fetched from the data room again: slower, never refused
      if (!cachedIds(opts).includes(id) && (opts.latency?.[1] ?? 400) > 0) await wait(900);
      if (opts.failures?.has('pageMissing')) { await mockLatency(opts)(); return fail({ kind: 'notFound', message: `${doc} could not be found in the deal’s folders` }); }
      return gate(opts, 'page', () => {
        loadIntoStore(opts, [id]);
        if (/\.xlsx?$/i.test(doc)) {
          const m = /!?([A-Z]+)(\d+)\s*$/.exec(loc); const cell = m ? m[1] + m[2] : undefined; const cr = m ? +m[2] : 12;
          const cols = ['A', 'B', 'C', 'D', 'E', 'F']; const rows = [];
          for (let r = Math.max(1, cr - 8); r <= cr + 8; r++) rows.push({ r, cells: cols.map((c, i) => (i === 0 ? (r === cr ? 'Referenced line' : `Line ${r}`) : c + r === cell ? '140.0' : '')) });
          return { kind: 'sheet' as const, name: doc, cols, rows, cell };
        }
        const pm = /p\.\s*(\d+)/.exec(loc);
        const real = opts.pdf?.(doc) ?? null; const n = pm ? +pm[1] : 1;
        // the demo's documents run to a few hundred pages (deal documents do), and always as far as the page cited
        const pages = real?.pages ?? Math.max(n, 180 + (id.charCodeAt(id.length - 1) % 5) * 40);
        return { kind: 'pdf' as const, url: real?.url ?? null, page: real?.pages ? ((n - 1) % real.pages) + 1 : n, pages };
      });
    },
    attach: (dealId, file) => gate(opts, 'attach', () => { const docId = mockAttachedId(dealId, file.name, file.bytes); loadIntoStore(opts, [docId]); attached.set(docId, file.bytes); return { doc: file.name, docId }; }),
    cached: () => gate(opts, 'cached', () => cachedIds(opts)),
    // each document sits in one place, unless window.__places = { [document name]: [{ folder, name }, …] } says otherwise (its first place first)
    places: (dealId, docId) => gate(opts, 'places', () => {
      const given = (globalThis as { __places?: Record<string, { folder: string; name: string }[]> }).__places ?? {};
      const name = Object.keys(given).find((n) => mockDocId(dealId, n) === docId); return name ? given[name] : [];
    }),
    /*
     * Deal folders not at their recorded paths: window.__away = { folders: [{ dealId, folder }], empty?: [{ dealId, folder }] (open, with nothing in them), dirs: [paths that open on
     * this PC], back?: a time (ms) after which every folder opens where it is recorded, as a slow network drive does once it answers }.
     * Without it every folder is where its deal says. Located places and what they teach are kept in memory, as the real backend keeps them in its local folder.
     */
    findFolders: () => gate(opts, 'findFolders', () => {
      const missing = awayNow().filter((f) => !placed.has(placeKey(f))); let n = 0;
      const still = missing.filter((f) => { const at = candidates(f.folder, rules).find(opens); if (at) { placed.set(placeKey(f), at); n++; } return !at; });
      const empty = emptyNow().filter((f) => !placed.has(placeKey(f)));
      return { placed: n, missing: still.length, tops: topsOf([...still, ...empty]), ...(empty.length ? { empty } : {}) };
    }),
    locateTop: (_dealIds, top, picked) => opens(picked) || awayDirs().some((d) => under(d, picked)) ? gate(opts, 'locateTop', () => {
      const find = (from: string) => { const taught = ruleFrom(top, from);
        return [...awayNow(), ...emptyNow()].filter((f) => !placed.has(placeKey(f))).flatMap((f) => { const at = [rewrite(f.folder, top, from), taught && rewrite(f.folder, taught.from, taught.to)].find((c) => !!c && opens(c)); return at ? [{ ...f, local: at }] : []; }); };
      for (const from of [picked, ...deeper(top, picked)]) { const out = find(from); if (out.length) return out; }   // as the backend: the picked folder, else one above the top folder
      return [];
    }) : mockLatency(opts)().then(() => fail({ kind: 'notFound' as const, message: `${picked} could not be opened` })),
    placeFolders: (list) => gate(opts, 'placeFolders', () => {
      let n = 0; for (const p of list) if (opens(p.local)) { placed.set(placeKey(p), p.local); n++; const r = ruleFrom(p.folder, p.local); if (r) rules = [...rules.filter((x) => pathKey(x.from) !== pathKey(r.from)), r]; }
      return n;
    }),
    // a folder holds another deal's data room only when window.__sameRoom = { [folder path]: deal id } says so
    sameRoom: (paths, dealIds) => gate(opts, 'sameRoom', () => {
      const given = (globalThis as { __sameRoom?: Record<string, string> }).__sameRoom ?? {};
      const held = paths.map((p) => given[p]).filter((id): id is string => !!id && dealIds.includes(id));
      return [...new Set(held)].map((dealId) => ({ dealId, files: 2100, matched: 1840 }));
    }),
    // the demo's credit agreement has three drafts in dated folders; every other document is in no family
    drafts: (dealId, docId) => gate(opts, 'drafts', () => {
      const name = 'Credit agreement (draft 1).pdf'; if (docId !== mockDocId(dealId, name) && !MOCK_DRAFTS.some(([d]) => docId === mockDocId(dealId, `${d}/${name}`))) return [];
      return [{ doc: name, docId: mockDocId(dealId, name), date: '2026-04-15', folder: 'VDR/Legal/Drafts/2026-04-15' }, ...MOCK_DRAFTS.map(([d, date]) => ({ doc: name, docId: mockDocId(dealId, `${d}/${name}`), date, folder: `VDR/Legal/Drafts/${d}` }))];
    }),
  };
}

/** Give mock citations their document ids and record that the documents were read (so they are in the store). */
function withIds<T extends { doc: string }>(opts: MockOptions | undefined, dealId: string, sources: T[]): (T & { docId: string })[] {
  const out = sources.map((x) => ({ ...x, docId: mockDocId(dealId, x.doc) }));
  if (opts) loadIntoStore(opts, out.map((x) => x.docId));
  return out;
}

/** What the mock model can see: the deal's findings as stored. */
async function storedFindings(repo: Repository | undefined, dealId: string): Promise<any[]> {
  if (!repo) return [];
  const r = await repo.list('finding', dealId);
  return r.ok ? r.value.map((l) => l.envelope.data as any) : [];
}

async function storedFolders(repo: Repository | undefined, dealId: string): Promise<Folder[] | undefined> {
  const deal = await repo?.get('deal', dealId);
  return deal?.ok && deal.value ? (deal.value.envelope.data as Deal).folders ?? [] : undefined;
}

/** the stand-in chat agent's answers being worked on, by run id */
const researching = new Map<string, { steps: ResearchStep[]; t0: number; stopped?: boolean }>();
/**
 * Stand-in for the model offering an action under its answer (#1054), so the demo and the browser suites can show the
 * button: a few fixed requests, each offering what a model would. The real model decides from the words itself.
 */
function standInOffer(message: string): { text?: string; sources?: []; offer?: unknown } {
  const said = message.trim().toLowerCase();
  const offering = (text: string, offer: unknown) => ({ text, sources: [] as [], offer });
  if (said === 'set up a new deal') {
    return offering('You can start the new deal here.', { action: 'new deal' });
  }
  if (said === 'take me to the q&a') {
    return offering('Here is this deal’s Q&A log.', { action: 'open page', page: 'qa' });
  }
  if (said === 'put every gap in the q&a log') {
    const text = 'Each gap and open finding without a question can go to the Q&A log.';
    return offering(text, { action: 'add unresolved' });
  }
  if (said === 'ask them for the permit list') {
    const question = 'Please provide the list of permits held for the project.';
    return offering(`Here is a question for the counterparty: “${question}”`, { action: 'log question', question });
  }
  return {};
}

export const mockAi = (opts: MockOptions = {}, repo?: Repository): AiService => ({
  dealBrief: (dealId) => gate(opts, 'dealBrief', async () => {
    const fs = (await storedFindings(repo, dealId)).filter((f) => f.status === 'open');
    if (!fs.length) return { paragraphs: [] };
    const top = fs.slice(0, 3).map((f) => findingLink(f));
    return { paragraphs: [`${fs.length} finding${fs.length === 1 ? '' : 's'} in the documents need${fs.length === 1 ? 's' : ''} attention. ${top.length > 1 ? 'The most material: ' + top.slice(0, -1).join('; ') + '; and ' + top[top.length - 1] + '.' : 'The most material: ' + top[0] + '.'}`] };
  }),
  // the stand-in's ratings follow the workstream, so a test knows what to expect; its summary is one line of facts
  memo: (dealId) => gate(opts, 'memo', async () => {
    const fs = (await storedFindings(repo, dealId)).filter((f) => f.status === 'open');
    const rating = (w: string) => (w === 'Technical' || w === 'Commercial' ? 'High' as const : w === 'Legal' ? 'Medium' as const : 'Low' as const);
    // its risks: a workstream's findings grouped as one, written up as their first paragraphs in turn, markers renumbered
    const risks = [...new Set(fs.map((f) => f.workstream))].map((w) => {
      const these = fs.filter((f) => f.workstream === w); const sources: any[] = []; const body: string[] = [];
      for (const f of these) { const at = sources.length; sources.push(...(f.sources ?? [])); body.push(String((f.body ?? []).find((p: string) => p.trim()) ?? f.title).replace(/\[(\d+)\]/g, (_m, n) => `[${+n + at}]`)); }
      return { title: these[0].title, findings: these.map((f) => f.id), body, sources };
    });
    return { summary: fs.length ? [`${fs.length} open finding${fs.length === 1 ? '' : 's'} on the deal.`] : [], ratings: Object.fromEntries(fs.map((f) => [f.id, rating(f.workstream)])), risks };
  }),
  gaps: (dealId) => gate(opts, 'gaps', async () => (await mockChecklist(repo, dealId)).filter((r) => r.result === 'gap').map((r) => ({ title: r.text }))),
  // The mock reads only the named deal's findings: the deal is the retrieval boundary. With no deal it has nothing to cite.
  answer: async (i) => { const t0 = Date.now(); const steps: ResearchStep[] = [{ kind: 'search', text: `Searched documents, findings and Q&A for “${i.message.replace(/\s+/g, ' ').trim().slice(0, 80)}”`, result: '', done: false }];
    const run = { steps, t0, stopped: false }; if (i.runId) researching.set(i.runId, run);
    // Stand-in for reading a whole folder: "review the permits folder" lists it, then reads it a batch at a time, slowly enough to stop
    const asked = /\b(?:read|review)\b.*?\b(?:the\s+)?([\w&-]+(?: [\w&-]+)?)\s+folder\b/i.exec(i.message);
    // A folderless deal with no attachments has no documents to search, including for a folder review (#172).
    const emptyRoom = i.dealId && !i.attachments?.length && (await storedFolders(repo, i.dealId))?.length === 0;
    if (asked && i.dealId && !emptyRoom) {
      const name = asked[1].replace(/^the\s+/i, ''); const label = name[0].toUpperCase() + name.slice(1); const all = 320; const per = 8;
      Object.assign(steps[0], { kind: 'search', text: `Listed the documents in “${name}” by priority`, result: `${all} documents`, done: true });
      let read = 0;
      for (let a = 1; a <= all && !run.stopped; a += per) {
        const st: ResearchStep = { kind: 'read', text: `Reviewed documents ${a}–${a + per - 1} of ${all} in “VDR/${label}”`, result: '', done: false }; steps.push(st);
        await wait(opts.latency ? opts.latency[1] : 600); st.done = true; st.result = a === 1 ? '2 passages' : 'nothing on this'; read += per;
      }
      if (run.stopped) { await wait(opts.latency ? opts.latency[1] : 1500); steps.push({ kind: 'stop', text: 'Stopped', result: 'answered from what was found', done: true }); }   // the answer from what was read takes a moment to write
      if (i.runId) researching.delete(i.runId);
      const text = run.stopped ? `Stopped after ${read} of the ${all} documents in ${label}, the most important first. Those read show nothing that needs attention; the other ${all - read} were not looked at.` : `All ${all} documents in ${label} were read. Nothing in them needs attention.`;
      return ok({ text, sources: [], research: { steps: steps.map((x) => ({ ...x })), ms: Date.now() - t0, read: { docs: read, of: 1240 } } });
    }
    await wait(opts.latency ? 0 : 400 + Math.random() * 700); const r = await gate(opts, 'answer', async () => {
    if (!i.dealId) {
      // across deals: every deal's open findings, and each citation says which deal its document is in
      const all = repo ? await repo.list('finding') : null; const deals = repo ? await repo.list('deal', '_') : null;
      const exists = new Set((deals?.ok ? deals.value : []).map((l) => l.id));
      const open = (all?.ok ? all.value.map((l) => l.envelope.data as any) : []).filter((f) => f && f.status === 'open' && exists.has(f.dealId));
      const name = (id: string) => ((deals?.ok ? deals.value : []).find((l) => l.id === id)?.envelope.data as any)?.name ?? 'a deal';
      if (!open.length) return { text: 'Nothing has been flagged on any of your deals yet.', sources: [] };
      const perDeal = new Map<string, any[]>(); for (const f of open) perDeal.set(f.dealId, [...(perDeal.get(f.dealId) ?? []), f]);
      const top = open[0];
      return { text: `${open.length} open finding${open.length === 1 ? '' : 's'} across ${perDeal.size} deal${perDeal.size === 1 ? '' : 's'}: ${[...perDeal].map(([id, fs]) => `${name(id)} has ${fs.length}`).join('; ')}. The first to look at is on ${name(top.dealId)}: ${midSentence(top.title)}.`, sources: (top.sources || []).slice(0, 2).map((x: any) => ({ ...x, dealId: top.dealId })) };
    }
    const fs = (await storedFindings(repo, i.dealId)).filter((f) => f.status === 'open');
    // cited as a finding is: [n] after a sentence is the nth source
    if (i.findingId) {
      const f = (await storedFindings(repo, i.dealId)).find((x) => x.id === i.findingId);
      const asked = `Please confirm the position on: ${f?.title}.`;
      const said = `${f?.title}. ${String(f?.body[0] || '')}`;
      if (f) return { text: /question|draft/i.test(i.message) ? asked : said, sources: f.sources || [] };
    }
    if (!fs.length) return { text: `Nothing in the documents indexed for this deal answers “${i.message.slice(0, 80)}” yet.`, sources: [] };
    // a question about a precedent cites another project's document beside this deal's own: its chip says "precedent" (docs/other-project-documents-design.md)
    if (/precedent/i.test(i.message)) { const fa = 'Credit agreement (draft 1).pdf', pre = 'Coho Solar credit agreement (executed).pdf'; return { text: 'The clean draft sets the lock-up at 1.25x. [1] The Coho Solar precedent had 1.10x. [2]', sources: [{ doc: fa, loc: 'p. 142', docId: mockDocId(i.dealId, fa) }, { doc: pre, loc: 'p. 88', docId: mockDocId(i.dealId, pre), precedent: true as const }] }; }
    // a question about what changed reads the credit agreement's blackline with its clean draft: the blackline's page is the model's reading
    if (/blackline|redline|what changed/i.test(i.message)) { const fa = 'Credit agreement (draft 1).pdf', bl = 'Credit agreement (blackline).pdf'; return { text: 'The blackline shows the lock-up moved from 1.20x to 1.25x. [1] The clean draft sets it at 1.25x. [2]', sources: [{ doc: bl, loc: 'p. 12', docId: mockDocId(i.dealId, bl), reading: true as const }, { doc: fa, loc: 'p. 142', docId: mockDocId(i.dealId, fa) }] }; }
    if (/biggest|issues|outstanding|contradict/i.test(i.message)) return { text: `The findings that matter most: ${fs.slice(0, 3).map((f) => findingLink(f)).join('; ')}.`, sources: [] };
    const f = fs[0]; return { text: `The closest support in the data room: ${String(f.body[0] || f.title).replace(/\s*\[\d+\]/g, '')}`, sources: (f.sources || []).slice(0, 2) };
  });
    if (!r.ok) { if (i.runId) researching.delete(i.runId); return r; }
    loadIntoStore(opts, [...r.value.sources, ...(i.attachments ?? [])].map((x: any) => x.docId).filter(Boolean));
    const cited: { doc: string; loc: string; quote?: string }[] = r.value.sources;
    // Stand-in for the chat agent's steps (agent.ts): the search that found the cited passages, then each cited document read whole,
    // shown one at a time so the window's "Researching" view has something to follow.
    const noDocuments = emptyRoom && cited.length === 0;
    const read = { docs: noDocuments ? 0 : Math.max(1, cited.length), of: noDocuments ? 0 : 3 + cited.length * 4 };
    Object.assign(steps[0], {
      done: true,
      result: `${read.of} listed · ${read.docs} opened · ${cited.length} passage${cited.length === 1 ? '' : 's'}`,
      found: cited.map((ref) => ({ where: `${ref.doc}, ${ref.loc}`, quote: ref.quote ? `“${ref.quote}”` : '' })),
    });
    for (const doc of [...new Set(cited.map((x) => x.doc))]) {
      const read: ResearchStep = { kind: 'read', text: `Reviewed ${doc}`, result: '', done: false }; steps.push(read);   // in the demo, slow enough to watch
      await wait(opts.latency ? opts.latency[1] : 700); read.done = true; read.result = cited.filter((x) => x.doc === doc).map((x) => x.loc).join(', ');
    }
    if (i.runId) researching.delete(i.runId);
    const research = { steps: steps.map((step) => ({ ...step })), ms: Date.now() - t0, read };
    return ok({ ...r.value, research, ...standInOffer(i.message) });
  },
  research: async (runId) => { const r = researching.get(runId); return ok(r ? { steps: r.steps.map((x) => ({ ...x })), ms: Date.now() - r.t0 } : null); },
  stop: async (runId) => { const r = researching.get(runId); if (r) r.stopped = true; return ok(!!r); },
  // A draft is found when the question matches something the deal's findings rest on; "none" stays a real outcome.
  draft: async (i) => { await wait(opts.latency ? 0 : 500 + Math.random() * 900); return gate(opts, 'draft', async () => {
    // The best match, not the first: a finding must share a telling word with the question (words any diligence
    // question uses do not count) and must beat every other finding. Otherwise nothing is found, and nothing is
    // made up: the mock never claims a source it was not given.
    const GENERIC = new Set(['signed', 'agreement', 'agreements', 'report', 'reports', 'adviser', 'advisor', 'ratio', 'executed', 'please', 'confirm', 'provide', 'sponsor', 'project', 'document', 'documents', 'information', 'memorandum', 'draft', 'final', 'between', 'under', 'which', 'there', 'their', 'about', 'should', 'would', 'could', 'where', 'figure', 'level', 'terms', 'sheet', 'facility', 'technical', 'question', 'response', 'details', 'provided', 'whether']);
    const words = (t: string) => new Set((t.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !GENERIC.has(w)));
    const asked = words(i.questionText);
    const scored = (await storedFindings(repo, i.dealId)).filter((f) => f.status === 'open' && (f.sources || []).length)
      .map((f) => ({ f, n: [...words(`${f.title} ${(f.body || []).join(' ')}`)].filter((w) => asked.has(w)).length })).sort((a, b) => b.n - a.n);
    const hit = scored[0] && scored[0].n >= 1 && scored[0].n > (scored[1]?.n ?? 0) ? scored[0].f : null;
    if (hit) { loadIntoStore(opts, hit.sources.map((x: any) => x.docId).filter(Boolean)); return { status: 'found' as const, text: `The documents bear on this: ${String(hit.body[0] || hit.title).replace(/\s*\[\d+\]/g, '')}`, sources: hit.sources.slice(0, 2) }; }
    return { status: 'none' as const, text: '', sources: [] };
  }); },
  // Stand-in for the model: reads headings the app's own rules do not know ("Lender query", "Sponsor reply", "Ref").
  layout: async (i) => { const g = await gate(opts, 'layout', () => {
    const RULES: [string, RegExp][] = [['text', /question|query|request|rfi|issue raised/i], ['respondedBy', /(respon\w*|answer\w*|repl\w*) (by|from)|respondent|responder|responding (party|firm)/i], ['response', /response|answer|reply/i], ['n', /^(#|no\.?|ref\.?|number|id|q ?no\.?)$/i], ['status', /status|state/i], ['workstream', /workstream|category|area|topic/i], ['priority', /priority|urgency/i], ['responded', /(date (responded|answered)|response date)/i], ['received', /received|date raised|raised on/i], ['askedBy', /submitted by|raised by|asked by|from|party|lender/i]];
    for (const s of i.sheets) for (const [at, row] of s.rows.entries()) {
      const fields: Record<string, string> = {};
      for (const cell of row) { const c = cell.trim(); if (!c) continue; const hit = RULES.find(([k, re]) => !fields[k] && re.test(c)); if (hit) fields[hit[0]] = c; }
      if (fields.text && Object.keys(fields).length >= 2) return { sheet: s.name, headerRow: s.first + at, fields };
    }
    return null;
  }); return !g.ok ? g : g.value ? { ok: true as const, value: g.value } : fail({ kind: 'failed', message: 'No table found' }); },
  // Stand-in for the model's verdict on whether an answer addresses a question: by the share of the question's telling
  // words the answer has, two thirds or more "yes", a third or more "partly". The real one is a model's judgment.
  addresses: (i) => gate(opts, 'addresses', () => {
    const own = [...tellingWords(i.question)]; const said = tellingWords(i.answer); const shared = own.filter((w) => said.has(w));
    const share = own.length ? shared.length / own.length : 0;
    return share >= 2 / 3 ? { verdict: 'yes' as const, why: 'It gives what the question asks for.' }
      : share >= 1 / 3 ? { verdict: 'partly' as const, why: 'It gives some of what the question asks for, not all of it.' }
      : { verdict: 'no' as const, why: 'It does not give what the question asks for.' };
  }),
  // Stand-in for the model's merged response: the first version's sentences, then each of the second's that says something
  // the first does not (fewer than half its telling words already said), so no fact is said twice. The real one rewrites.
  merge: (i) => gate(opts, 'merge', () => {
    const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
    const said = tellingWords(i.app);
    const more = sentences(i.log).filter((x) => { const w = [...tellingWords(x)]; return w.length && w.filter((y) => said.has(y)).length < w.length / 2; });
    return { text: [...sentences(i.app), ...more].join(' ') };
  }),
  // Stand-ins for the fast model as a checklist is brought in. Rewording spells out a few common abbreviations and turns
  // "a / b" or "a; b" into a sentence; the real one is a model's judgment. Same meaning is two items sharing most of
  // their telling words and the same figures.
  // Stand-in for the model reading a list in, by the look of each line: a table row ("a | b") takes its item, section
  // and subsection cells, the columns known by the heading row; "1." or "Section 1" alone is a section, an indented line with no
  // number a subsection, a line numbered "1.2", "a)" or bulleted an item, an indented line after an item its rest, and a
  // line of a "Page 2 of 6" kind, a title or a note is left out. The real one is a model's judgment. window.__readList
  // = { skip: [n] } leaves those lines out of the reply, and { wrong: [n] } answers them with words the line does not hold.
  readList: (i) => gate(opts, 'readList', () => {
    const hook = (globalThis as { __readList?: { skip?: number[]; wrong?: number[] } }).__readList ?? {};
    const only = new Set(i.only ?? i.lines.map((_, k) => k + 1)); const out: LineRead[] = []; let inItem = false; let cols: ChecklistMapping | undefined;
    const table = i.lines.filter((l) => l.includes(' | ')).length > i.lines.filter((l) => l.trim()).length / 2;
    // a list with no numbers or bullets at all is one item a line, under a heading row if it starts with one
    const plain = !table && !i.lines.some((l) => /^\s*(\d+(\.\d+)*\.?|[a-z]\)|[-•])\s+\S/i.test(l));
    i.lines.forEach((raw, k) => {
      const n = k + 1; const line = raw.trim(); let r: LineRead;
      if (!line) { inItem = false; return; }
      if (table) {
        // the columns are told apart by the heading row, as the columns step suggests them
        cols ??= suggestChecklistColumns(i.lines[0].split(' | ').map((c) => c.trim()));
        const cells = raw.split(' | ').map((c) => c.trim()); const cell = (c: number | null | undefined) => (c == null ? '' : cells[c] ?? '');
        const text = cell(cols.item); const section = cell(cols.section); const subsection = cell(cols.subsection);
        r = n === 1 ? { n, k: 'columns' } : text ? { n, k: 'item', text, ...(section ? { section } : {}), ...(subsection ? { subsection } : {}) } : { n, k: 'left' };
      } else if (plain) r = /^page \d+ of \d+$/i.test(line) ? { n, k: 'left' } : n === 1 && /^(checklist )?items?$|^requirements?$|^description$/i.test(line) ? { n, k: 'columns' } : { n, k: 'item', text: line };
      else if (/^(page \d+ of \d+|note:|draft\b|confidential\b)/i.test(line) || /\.$/.test(line) && !/^(\d+(\.\d+)+|[a-z]\)|[-•*])\s/i.test(line)) r = { n, k: 'left' };
      else if (/^\d+\.\s+\S/.test(line) && !/^\d+\.\d/.test(line)) { r = { n, k: 'section', text: line.replace(/^\d+\.\s+/, '') }; inItem = false; }
      else if (/^(\d+(\.\d+)+|[a-z]\)|[-•])\s+/i.test(line)) { r = { n, k: 'item', text: line.replace(/^(\d+(\.\d+)+|[a-z]\)|[-•])\s+/i, '') }; inItem = true; }
      else if (inItem && /^\s{4,}/.test(raw)) r = { n, k: 'more' };
      else if (/^\s+/.test(raw) && line.length <= 40) { r = { n, k: 'subsection', text: line }; inItem = false; }
      else r = { n, k: 'left' };
      if (!only.has(n) || hook.skip?.includes(n)) return;
      out.push(hook.wrong?.includes(n) && r.text ? { ...r, text: `${r.text} as reworded` } : r);
    });
    return out;
  }),
  reword: (i) => gate(opts, 'reword', () => i.items.flatMap((t, at) => {
    const ABBR: [RegExp, string][] = [[/\bLTSA\b/g, 'long-term service agreement'], [/\bIE\b/g, 'independent engineer'], [/\byrs\b/g, 'years'], [/≥/g, 'at least'], [/\bO&M\b/g, 'operation and maintenance']];
    let x = t.trim(); for (const [re, w] of ABBR) x = x.replace(re, w);
    x = x.replace(/\s*\/\s*/g, ' and ').replace(/\s*[–—-]\s+/g, ': ');
    // two conditions joined by ";" are two items; "(if applicable)" only on a permit that may not be needed
    const sentence = (y: string) => { y = y.trim().replace(/^any\s+/i, ''); y = y.charAt(0).toUpperCase() + y.slice(1); return /[.?!]$/.test(y) ? y : `${y}.`; };
    const parts = x.split(/\s*;\s*/).filter(Boolean).map((y) => (/\bpermit\b/i.test(y) && /^any\b/i.test(y.trim()) ? sentence(y).replace(/\.$/, ' (if applicable).') : sentence(y)));
    if (parts.length > 1) return [{ at, text: parts[0], why: 'Two conditions in one item', also: parts.slice(1) }];
    if (x === t.trim()) return [];
    return [{ at, text: sentence(x), why: 'Shorthand spelled out' }];
  })),
  // Stand-in for the fast model phrasing questions for the counterparty: asks for what is needed, or about the finding
  phrase: (i) => gate(opts, 'phrase', () => i.items.map((x) => {
    const low = (t: string) => (/^[A-Z](?![A-Z])/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t).replace(/[.\s]+$/, '');
    return x.kind === 'finding' ? `Please explain “${x.what.replace(/[.\s]+$/, '')}”, and provide the documents that address it.` : `Please provide ${x.need ? low(x.need) : `the document showing: ${low(x.what)}`}.`;
  })),
  sameMeaning: (i) => gate(opts, 'sameMeaning', () => {
    // strict, as the model is told to be: two telling words or more, most of both, and the same figures, so that "Phase 1
    // permit" and "Phase 2 permit" are not a pair. Items worded the same are left out: the app finds those without a model.
    const read = (t: string) => ({ w: tellingWords(t), f: (t.match(/\d+(?:[.,]\d+)*/g) ?? []).sort().join(' '), k: key(t) });
    const like = (x: ReturnType<typeof read>, y: ReturnType<typeof read>) => {
      if (x.k === y.k || x.f !== y.f) return 0;
      const [small, big] = x.w.size <= y.w.size ? [x.w, y.w] : [y.w, x.w]; let n = 0; for (const w of small) if (big.has(w)) n++;
      return n < 2 ? 0 : n / big.size;
    };
    const mine = i.items.map(read); const theirs = i.against.map(read); const out: { a: number; b: number; inAgainst: boolean; why: string }[] = [];
    mine.forEach((m, a) => { for (let b = a + 1; b < mine.length; b++) if (like(m, mine[b]) >= 0.8) out.push({ a, b, inAgainst: false, why: 'Asks for the same thing' }); theirs.forEach((t, b) => { if (like(m, t) >= 0.8) out.push({ a, b, inAgainst: true, why: 'Already in the general list' }); }); });
    // `__sameMissed` on the window (tests): the first ask leaves out its last N items, as a part the service did not
    // answer would, and asking about just those (`only`) answers for them
    const missN = (globalThis as any).__sameMissed as number | undefined; const only = i.only ? new Set(i.only) : null;
    if (only) return { pairs: out.filter((p) => only.has(p.a) || (!p.inAgainst && only.has(p.b))) };
    if (!missN) return { pairs: out };
    const at = Array.from({ length: Math.min(missN, i.items.length) }, (_, k) => i.items.length - Math.min(missN, i.items.length) + k);
    return { pairs: out.filter((p) => p.a < at[0]), missed: { kind: 'unreachable' as const, at } };
  }),
  // Stand-in for the model reading an issues list: a text file's lines that start with a number ("12." "12)" "12<tab>")
  // are its points, a line that does not carries the point above it on. The title is the point's first words; the
  // workstream is found by a word or two. A point repeats a finding or an earlier point as `sameMeaning` pairs items:
  // most of their telling words, and the same figures. A file that is not text, or has no numbered lines, has no points.
  issuesList: (i) => gate(opts, 'issuesList', () => {
    // `__issues` on the window (screens and tests): the points as the model would give them, whatever the file
    const given = (globalThis as any).__issues as IssuePoint[] | undefined; if (given) return { points: given };
    let text = ''; try { text = new TextDecoder('utf-8', { fatal: true }).decode(attached.get(i.doc.docId) ?? new Uint8Array()); } catch { /* not text */ }
    const read: { n: string; text: string }[] = [];
    for (const line of text.split(/\r?\n/)) { const m = /^\s*(\d+(?:\.\d+)*)[.)\t]\s*(.+)$/.exec(line); if (m) read.push({ n: m[1], text: m[2].trim() }); else if (line.trim() && read.length) read[read.length - 1].text += ` ${line.trim()}`; }
    if (!read.length) return null;
    const sig = (t: string) => ({ w: tellingWords(t), f: (t.match(/\d+(?:[.,]\d+)*/g) ?? []).sort().join(' ') });
    const like = (x: ReturnType<typeof sig>, y: ReturnType<typeof sig>) => { if (x.f !== y.f) return 0; const [small, big] = x.w.size <= y.w.size ? [x.w, y.w] : [y.w, x.w]; let n = 0; for (const w of small) if (big.has(w)) n++; return n < 2 ? 0 : n / big.size; };
    const fs = i.findings.map((f) => sig(`${f.title} ${f.text}`)); const ps = read.map((p) => sig(p.text));
    const WS: [RegExp, string][] = [[/\b(tax|vat|withholding)\b/i, 'Tax'], [/\b(insur\w*)\b/i, 'Insurance'], [/\b(dscr|reserve|waterfall|debt|fees?|financ\w*)\b/i, 'Financial'], [/\b(ppa|offtake|o&m|epc|contractor)\b/i, 'Commercial'], [/\b(engineer\w*|technical|turbine|module)\b/i, 'Technical']];
    return { points: read.map((p, k) => {
      const f = fs.findIndex((x) => like(ps[k], x) >= 0.8); const e = ps.slice(0, k).findIndex((x) => like(ps[k], x) >= 0.8);
      const workstream = WS.find(([re]) => re.test(p.text))?.[1] ?? 'Legal';
      const same = f >= 0 ? { same: { finding: i.findings[f].id } } : e >= 0 ? { same: { point: e } } : {};
      return { n: p.n, text: p.text, title: p.text, workstream, ...same };
    }) };
  }).then((r) => (!r.ok ? r : r.value ? ok(r.value) : fail({ kind: 'failed', message: 'It could not be read as an issues list' }))),
  reassess: () => gate(opts, 'reassess', () => ({ body: ['Reassessed.'], sources: [] })),
  // The mock check of everything. It reads no documents, so by itself it finds nothing: a page that wants to see a
  // finding marked, or a spot check that disagrees, says so through `__check` on the window, as tests do.
  checkAll: async (i) => { await wait(opts.latency ? 0 : 700 + Math.random() * 600); return gate(opts, 'checkAll', async () => {
    const want = ((globalThis as any).__check ?? {}) as { mark?: number; spot?: { size: number; overturned: number }; unchecked?: { items: number; findings: number }; unread?: string[] };
    const open = repo ? (await storedFindings(repo, i.dealId)).filter((f) => f.status === 'open') : []; let toReassess = 0;
    for (const f of open.filter((f) => !f.updated).slice(0, want.mark ?? 0)) {
      const got = await repo!.get('finding', f.id); if (!got.ok || !got.value) continue;
      const w = await repo!.transaction({ writes: [{ kind: 'finding', id: f.id, data: { ...(got.value.envelope.data as object), updated: true, updatedWhy: CHECK_REASON, updatedAt: new Date().toISOString() }, expectedRev: got.value.rev }] });
      if (w.ok) { toReassess++; (repo as Announcing).announce('finding', f.id); }
    }
    const sample = i.deep ? null : want.spot ?? { size: Math.min(5, open.length), overturned: 0 }; const at = new Date().toISOString();
    const offerDeep = !!sample && sample.size > 0 && sample.overturned / sample.size > 0.2;
    // a check that could not check everything does not count as one: the date stays where it was
    // what it left out is remembered, so the page can offer to check only that; the mock's documents never change
    if (want.unchecked && (want.unchecked.items || want.unchecked.findings)) { mockChecked.set(i.dealId, { ...(mockChecked.get(i.dealId) ?? { at: null, offerDeep: null }), left: { ...want.unchecked, at, changed: false } }); return { at: null, items: 0, findings: open.length, toReassess, newFindings: 0, sample, offerDeep, unchecked: want.unchecked, ...(want.unread?.length ? { unread: want.unread } : {}) }; }
    // a folder in the data room this PC could not open and no PC has read: not complete, so the date stays
    if (want.unread?.length) return { at: null, items: 0, findings: open.length, toReassess, newFindings: 0, sample, offerDeep, unchecked: { items: 0, findings: 0 }, unread: want.unread };
    mockChecked.set(i.dealId, { at, offerDeep: offerDeep ? sample : null, left: null });
    return { at, items: 0, findings: open.length, toReassess, newFindings: 0, sample, offerDeep, unchecked: { items: 0, findings: 0 } };
  }); },
  checked: async (dealId) => ok(mockChecked.get(dealId) ?? { at: null, offerDeep: null }),
  // The mock reads no documents. Once its first pass has run it reports a made-up but steady share of each folder as core and as read,
  // so the screens that show progress have something to show; before that, nothing has been read.
  progress: async (dealId) => {
    const folders = await storedFolders(repo, dealId) ?? [];
    const rows = await mockChecklist(repo, dealId); const passed = rows.length > 0; const count = (r: ChecklistRow['result']) => rows.filter((x) => x.result === r).length;
    // window.__copies = { [folder path]: n } says that n of a folder's files are copies of documents counted once
    const copiesIn = (path: string) => Math.max(0, (globalThis as { __copies?: Record<string, number> }).__copies?.[path] ?? 0);
    // window.__alsoIn = { [deal id]: [{ dealId, docs, of }] } says another deal's data room holds `docs` of this deal's `of` own documents
    const alsoIn = (globalThis as { __alsoIn?: Record<string, { dealId: string; docs: number; of: number }[]> }).__alsoIn?.[dealId];
    return ok({ ...(alsoIn?.length ? { alsoIn } : {}), folders: folders.map((f) => { const copies = Math.min(f.files, copiesIn(f.path)); const files = f.files - copies; const core = passed ? Math.min(files, Math.max(1, Math.round(files * 0.04))) : 0; return { folder: f.path, files, read: passed ? Math.min(files, core + Math.round(files * 0.02)) : 0, core, coreRead: core, ...(copies ? { copies } : {}) }; }), checklist: { items: rows.length, satisfied: count('satisfied'), findings: count('finding'), gaps: count('gap'), unsettled: count('unsettled') + count('unchecked') } });
  },
  checklist: async (dealId) => ok(await mockChecklist(repo, dealId)),
});
/**
 * The mock's checklist: sample items, the same for every deal. Nothing is listed until its first pass has run. Three
 * items came to the mock's three findings (an item whose finding a person has since deleted still names it, as it
 * would in the product), two found nothing that settles them, and the rest are satisfied by a named document.
 */
const MOCK_ITEMS: { text: string; finding?: string; need?: string; doc?: string; quote?: string; read?: string[]; unread?: string[]; searched?: { q: string; n: number }[] }[] = [
  { text: 'Operating assumptions agree across the advisors’ reports', finding: 'Technical report and information memorandum disagree on the operating assumption' },
  { text: 'Lock-up ratio matches the term sheet', finding: 'Lock-up ratio in the credit agreement draft differs from the term sheet' },
  { text: 'Contracted revenue covers the base case capacity', finding: 'Revenue contract covers less capacity than the base case assumes' },
  { text: 'Insurance advisor report (final)', need: 'The final report from the insurance advisor', read: ['Insurance advisor report (draft).pdf', 'Technical advisor report.pdf', 'Information memorandum.pdf'], unread: ['Insurance certificate.pdf'], searched: [{ q: 'insurance advisor report final', n: 3 }, { q: 'insurance due diligence report', n: 2 }, { q: 'lenders insurance advisor', n: 0 }] },
  { text: 'Executed direct agreement', need: 'A signed copy of the direct agreement', read: ['Direct agreement (draft).pdf', 'Credit agreement (draft 1).pdf'], searched: [{ q: 'direct agreement executed', n: 2 }, { q: 'signed direct agreement', n: 2 }] },
  { text: 'Financial model has been audited', doc: 'Model audit report.pdf' },
  { text: 'Construction contract is fixed price, date certain', doc: 'EPC contract.pdf', quote: 'The Contract Price is a fixed lump sum and the Contractor shall achieve Substantial Completion by the Scheduled Completion Date.' },
  { text: 'Operation and maintenance agreement covers the debt tenor', doc: 'O&M agreement.pdf' },
  { text: 'Interconnection agreement is executed', doc: 'Interconnection agreement.pdf' },
  { text: 'Land rights cover the site and the cable route', doc: 'Legal due diligence report.pdf' },
  { text: 'Environmental permits are in place', doc: 'Environmental and social report.pdf' },
  { text: 'Debt service reserve covers six months', doc: 'Term sheet (signed).pdf', quote: 'The Borrower shall maintain a Debt Service Reserve Account funded to six months of scheduled debt service.' },
  { text: 'Sponsor equity is committed before first drawdown', doc: 'Equity commitment letter.pdf' },
  { text: 'Hedging strategy covers the interest rate exposure', doc: 'Hedging strategy paper.pdf' },
  { text: 'Technical advisor confirms the energy yield', doc: 'Technical advisor report.pdf' },
  { text: 'Tax structure has been reviewed', doc: 'Tax due diligence report.pdf' },
  { text: 'Offtaker credit rating meets the minimum in the term sheet', doc: 'Offtaker credit report.pdf' },
  { text: 'Insurance program covers construction and operation', doc: 'Insurance summary.pdf' },
  { text: 'Decommissioning reserve is provided for', doc: 'Financial model.xlsx' },
  { text: 'Change of control provisions protect the lenders', doc: 'Credit agreement (draft 1).pdf' },
  { text: 'Security package covers shares, accounts and contracts', doc: 'Security term sheet.pdf' },
  { text: 'Construction program supports the scheduled completion date', doc: 'Technical advisor report.pdf' },
  { text: 'Warranties on the main equipment cover at least five years', doc: 'Supply agreement.pdf' },
  { text: 'Corporate approvals of the borrower are in place', doc: 'Legal due diligence report.pdf' },
];
async function mockChecklist(repo: Repository | undefined, dealId: string): Promise<ChecklistRow[]> {
  const stored = await storedFindings(repo, dealId);
  // A deal with items of its own (from the firm's list) lists those, as the product does, not turned off ones. An item
  // worded as one of the samples stands as that sample does once the first pass has run; the rest are not checked yet.
  const its = repo ? await repo.list('item', dealId) : null;
  if (its?.ok && its.value.length) {
    const items = its.value.map((l) => l.envelope.data as { id: string; text: string; off?: boolean }).filter((it) => !it.off);
    const rows = mockChecked.has(dealId) || stored.length ? await sampleRows() : [];
    return items.map((it) => { const r = rows.find((x) => key(x.text) === key(it.text)); return r ? { ...r, id: it.id } : { id: it.id, text: it.text, result: 'unchecked' as const, docs: [] }; });
  }
  if (!mockChecked.has(dealId) && !stored.length) return [];
  return sampleRows();
  async function sampleRows(): Promise<ChecklistRow[]> {
  // as in the product, the check still names a finding a person has deleted since: its id is kept with its tombstone
  const tombs = repo ? await repo.list('tombstone', dealId) : null; const gone = tombs?.ok ? tombs.value.map((l) => l.envelope.data as any).filter((t) => t.kind === 'finding') : [];
  return MOCK_ITEMS.map((it, i) => {
    const f = it.finding ? stored.find((x) => x.title === it.finding) ?? gone.find((x) => x.title === it.finding) : undefined;
    return { id: `m${i + 1}`, text: it.text, result: it.finding ? 'finding' as const : it.need ? 'gap' as const : 'satisfied' as const, ...(f ? { findingId: f.id } : {}), ...(it.need ? { need: it.need } : {}), docs: it.doc ? [{ docId: `mock-${i + 1}`, name: it.doc }] : (it.read ?? []).map((n) => ({ docId: mockDocId(dealId, n), name: n })), ...(it.unread ? { unread: it.unread.map((n) => ({ docId: mockDocId(dealId, n), name: n })) } : {}), ...(it.searched ? { searched: it.searched } : {}),
      ...(it.doc ? { sources: [{ doc: it.doc, docId: mockDocId(dealId, it.doc), loc: /\.xlsx$/.test(it.doc) ? 'Reserves!C14' : `p. ${4 + (i * 7) % 60}`, ...(it.quote ? { quote: it.quote } : {}) }], at: mockChecked.get(dealId)?.at ?? undefined } : {}) };
  });
  }
}
/** when the mock last checked everything on a deal: set by its first pass and by its check of everything */
const mockChecked = new Map<string, CheckState>();

export const browserFiles: FileSystem = {
  // window.__pickFolder = path stands in for the folder a person picks in the desktop's folder dialog; without it the browser has none
  get pickFolders() { const p = (globalThis as any).__pickFolder as string | undefined; return (globalThis as any).punchlist?.pickFolders ?? (p === undefined ? null : async () => ok([p])); },
  pathFor: (globalThis as any).punchlist?.pathFor ?? null,
  async save(name, bytes, mime) {
    try {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })); const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return ok('saved' as const);
    } catch (e: any) { return fail({ kind: 'failed', message: 'Couldn’t save the file' }); }
  },
};

/**
 * The mock first pass. In the product this is the backend's agents writing findings through
 * the repository; the app only hears about them through the change feed. Here it writes three
 * AI findings once indexing finishes, skipping any whose title a person has deleted (tombstones).
 */
export async function mockFirstPass(repo: Announcing, dealId: string, dealName: string, opts?: MockOptions) {
  const have = await repo.list('finding', dealId); const tombs = await repo.list('tombstone', dealId);
  if (!have.ok || !tombs.ok) return;
  const titles = new Set([...have.value.map((l) => (l.envelope.data as any).title), ...tombs.value.map((l) => (l.envelope.data as any).title)]);
  const now = new Date().toISOString(); if (!mockChecked.has(dealId)) mockChecked.set(dealId, { at: now, offerDeep: null });
  const seeds = [
    {
      title: 'Technical report and information memorandum disagree on the operating assumption',
      workstream: 'Technical',
      body: ['The technical advisor supports a lower figure than the one the information memorandum relies on. [1] '
        + 'The base case uses the higher figure throughout. [2]'],
      sources: [
        { doc: 'Technical advisor report.pdf', loc: 'p. 41' },
        { doc: 'Information memorandum.pdf', loc: 'p. 22' },
      ],
    },
    {
      title: 'Lock-up ratio in the credit agreement draft differs from the term sheet', workstream: 'Legal',
      body: ['The draft sets the distribution lock-up at 1.25x. [1] The signed term sheet has 1.30x. [2]'],
      sources: [
        { doc: 'Credit agreement (draft 1).pdf', loc: 'p. 142' },
        { doc: 'Term sheet (signed).pdf', loc: 'p. 6' },
      ],
    },
    {
      title: 'Revenue contract covers less capacity than the base case assumes', workstream: 'Commercial',
      body: ['The executed contract covers part of the capacity only. [1] '
        + 'The model treats all of it as contracted. [2]'],
      sources: [{ doc: 'Capacity agreement.pdf', loc: 'p. 88' }, { doc: 'Financial model.xlsx', loc: 'Revenue!D14' }],
    },
  ].filter((f) => !titles.has(f.title));
  // as in the product, a finding names the deal's item whose check raised it, when the deal holds that sample item
  const its = await repo.list('item', dealId); const itemOf = new Map((its.ok ? its.value : []).map((l) => l.envelope.data as { id: string; text: string }).map((it) => [key(it.text), it.id]));
  for (const f of seeds) {
    const id = `f_${ulid()}`; const sample = MOCK_ITEMS.find((m) => m.finding === f.title); const item = sample && itemOf.get(key(sample.text));
    const data = {
      id, dealId, rev: 0, createdAt: now, updatedAt: now, title: f.title, workstream: f.workstream, status: 'open',
      raisedAt: now, body: f.body, sources: withIds(opts, dealId, f.sources), origin: 'ai', note: '', reviewed: null,
      updated: false, ...(item ? { itemId: item } : {}),
    };
    const r = await repo.transaction({ writes: [{ kind: 'finding', id, data, expectedRev: null }], index: { dealId, add: [{ kind: 'finding', id }] } });
    if (r.ok) repo.announce('finding', id);
  }
}
