// Regressions for defects in records, imports and exports.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, type MemRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, SetQuestionStatus, EditQuestionField } from '../../src/app/commands/questions';
import { CreateFinding, ReviewFinding } from '../../src/app/commands/findings';
import { RecoverDrafts } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { localYmd } from '../../src/domain/model';
import { findingsSheet } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, SetResponse, SetQuestionStatus, EditQuestionField, CreateFinding, ReviewFinding, RecoverDrafts];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 15, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZW${String(seq++).padStart(7, '0')}` };
/** A second "window": its own Store over the same records (the PC's one store, as the desktop app's windows share its backend) and the same per-person local data. */
class SharedLocal extends MemoryLocal { listeners = new Set<(k: string) => void>(); watchers = new Map<object, (k: string) => void>(); }
function windowOn(repo: MemRepo, shared: Map<string, string>, peers: ((k: string) => void)[][], at = clock) {
  const opts: MockOptions = { latency: [0, 0] };
  const mine: ((k: string) => void)[] = []; peers.push(mine);
  const local = { read: (k: string) => { const raw = shared.get(k); return raw ? JSON.parse(raw) : null; }, write: (k: string, v: unknown) => { shared.set(k, JSON.stringify(v)); for (const p of peers) if (p !== mine) for (const fn of p) fn(k); return { ok: true as const, value: undefined }; }, watch: (fn: (k: string) => void) => { mine.push(fn); return () => {}; } };
  return new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local, clock: at, ids }, COMMANDS);
}
const msg = (id: string, role: 'me' | 'ai', text: string) => ({ id, role, text, state: 'done' as const, at: clock.now() });

describe('two windows', () => {
  it('each keeps the other’s conversations: a window changes one conversation, never the whole set', async () => {
    const kv = memRepo(clock.now); const shared = new Map<string, string>(); const peers: ((k: string) => void)[][] = [];
    const a = windowOn(kv, shared, peers), b = windowOn(kv, shared, peers); await a.boot(); await b.boot();
    a.setThread('deal:d_1', [msg('a1', 'me', 'asked in window A'), msg('a2', 'ai', 'answered in A')]);
    b.setThread('all', [msg('b1', 'me', 'asked in window B'), msg('b2', 'ai', 'answered in B')]);
    const stored = JSON.parse(shared.get('threads')!);
    expect(Object.keys(stored).sort()).toEqual(['all', 'deal:d_1']);
    await new Promise((r) => setTimeout(r, 0));                                          // conversations are read through the (asynchronous) ConversationStore
    expect(Object.keys(a.get().threads).sort()).toEqual(['all', 'deal:d_1']);          // A follows what B wrote
    const again = windowOn(kv, shared, peers); await again.boot(); await new Promise((r) => setTimeout(r, 0));
    expect(again.get().threads['deal:d_1'].map((m) => m.text)).toEqual(['asked in window A', 'answered in A']);
  });
  it('a window still showing the other’s answer as waiting never takes that answer back', async () => {
    const kv = memRepo(clock.now); const shared = new Map<string, string>(); const peers: ((k: string) => void)[][] = [];
    const a = windowOn(kv, shared, peers), b = windowOn(kv, shared, peers); await a.boot(); await b.boot();
    const q = msg('a1', 'me', 'asked in window A'); const waiting = { ...msg('a2', 'ai', ''), state: 'pending' as const };
    a.setThread('all', [q, waiting]); await new Promise((r) => setTimeout(r, 0));
    expect(b.get().threads.all.map((m) => m.state)).toEqual(['done', 'pending']);
    // A's answer lands, and B asks in the same conversation before the storage event telling it so has arrived
    const late = peers[1].splice(0);
    a.setThread('all', [q, { ...waiting, text: 'answered in A', state: 'done' }]);
    b.setThread('all', [...b.get().threads.all, msg('b1', 'me', 'asked in window B'), msg('b2', 'ai', 'answered in B')]);
    peers[1].push(...late); for (const fn of late) fn('threads');
    await new Promise((r) => setTimeout(r, 0));
    const c = windowOn(kv, shared, peers); await c.boot(); await new Promise((r) => setTimeout(r, 0));
    for (const w of [a, b, c]) expect(w.get().threads.all.map((m) => m.text)).toEqual(['asked in window A', 'answered in A', 'asked in window B', 'answered in B']);
  });
  it('and the other’s preferences: choosing a theme in one and a column in the other keeps both', async () => {
    const kv = memRepo(clock.now); const shared = new Map<string, string>(); const peers: ((k: string) => void)[][] = [];
    const a = windowOn(kv, shared, peers), b = windowOn(kv, shared, peers); await a.boot(); await b.boot();
    a.setPrefs({ theme: 'dark' }); b.setPrefs({ hideCols: { ...b.get().prefs.hideCols, priority: true } });
    expect(JSON.parse(shared.get('prefs')!)).toMatchObject({ theme: 'dark', hideCols: { priority: true, askedBy: false } });
    expect(a.get().prefs).toMatchObject({ theme: 'dark', hideCols: { priority: true } }); expect(b.get().prefs.theme).toBe('dark');
    // preferences saved by an earlier build know only two columns and nothing of the pane: they load, and the rest take their defaults
    shared.set('prefs', JSON.stringify({ theme: 'light', model: null, hideCols: { priority: true, askedBy: true } }));
    const c = windowOn(kv, shared, peers); await c.boot();
    expect(c.get().prefs).toEqual({ theme: 'light', model: null, hideCols: { priority: true, askedBy: true, response: false, status: false, respondedBy: true, responded: true }, qaOpen: {}, landing: 'overview', railOpen: { live: true }, qaSeen: {} });
    // which sidebar groups are unfolded is kept with the other view choices, on top of what is stored
    c.setPrefs({ railOpen: { live: false, pitch: true } });
    expect(JSON.parse(shared.get('prefs')!)).toMatchObject({ theme: 'light', railOpen: { live: false, pitch: true } });
    const e = windowOn(kv, shared, peers); await e.boot(); expect(e.get().prefs.railOpen).toEqual({ live: false, pitch: true });
  });
});

describe('an Answered question keeps its response', () => {
  it('clearing the response is refused until the status is changed, and the question stays editable', async () => {
    const kv = memRepo(clock.now); const s = windowOn(kv, new Map(), []); await s.boot();
    await s.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(s.get().deals)[0]; await s.loadDeal(dealId);
    await s.dispatch(CreateQuestion, { dealId, text: 'What is the ratio?' }); const q = dealQuestions(s.get(), dealId)[0];
    await s.dispatch(SetResponse, { dealId, questionId: q.id, response: '1.25x' }); await s.dispatch(SetQuestionStatus, { dealId, questionId: q.id, status: 'answered' });
    const r = await s.dispatch(SetResponse, { dealId, questionId: q.id, response: '' }, { quiet: true });
    expect(!r.ok && r.error.message).toMatch(/Change its status before clearing the response/);
    expect(s.get().questions[q.id]).toMatchObject({ status: 'answered', response: '1.25x' });
    expect((await s.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'What is the lock-up ratio?' }, { quiet: true })).ok).toBe(true);
    await s.dispatch(SetQuestionStatus, { dealId, questionId: q.id, status: 'open' });
    expect((await s.dispatch(SetResponse, { dealId, questionId: q.id, response: '' }, { quiet: true })).ok).toBe(true);
  });
});

describe('calendar dates', () => {
  it('are the local date of the moment, not the UTC date', () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(localYmd('2026-11-10T02:07:00.000Z')).toBe('2026-11-09');      // 6:07 pm on Nov 9 in Los Angeles
      expect(localYmd('2026-11-09T20:00:00.000Z')).toBe('2026-11-09');
      const f: any = { title: 't', workstream: 'Legal', status: 'open', raisedAt: '2026-11-10T02:07:00.000Z',
        origin: 'human', reviewed: { by: 'adoe', at: '2026-11-10T03:00:00.000Z' }, sources: [], note: '' };
      f.body = []; const row = findingsSheet([f])[1]; expect([row[4], row[6]]).toEqual(['2026-11-09', '2026-11-09']);
      process.env.TZ = 'America/New_York';
      expect(localYmd('2026-11-10T04:59:00.000Z')).toBe('2026-11-09'); expect(localYmd('2026-11-10T05:00:00.000Z')).toBe('2026-11-10');
      expect(localYmd('not a date')).toBe('');
    } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  });
});
