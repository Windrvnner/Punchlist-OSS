// @vitest-environment node
// Conversations kept in the synced folder: started at the office, carried on at home; each person sees
// their own; an answer retried replaces the failed one; a line cut short, a damaged line or a lost line costs nothing.
import { describe, it, expect, vi } from 'vitest';
import { conversationLog } from '../../src/backend/conversationLog';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { ask, convKey, type Scope } from '../../src/app/conversations';
import { CreateDeal } from '../../src/app/commands/deals';
import { registry } from '../../src/app/commands/undo';
import type { KeptMessage } from '../../src/ports';
import { Mem, Tearing } from './reviewKit';
import { wholeLines } from '../../src/backend/ownFile';
import { composeBackend } from '../../src/backend/compose';
import { StandInService } from '../../src/backend/service';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 13, 9, 0, 0, t++)).toISOString();
const msg = (id: string, role: 'me' | 'ai', text: string, at: string, state: 'done' | 'failed' = 'done'): KeptMessage => ({ id, role, text, state, at });
class Refusing extends Mem { refuse = false; code = 'EACCES'; append(n: string, x: string) { if (this.refuse) throw Object.assign(new Error(this.code), { code: this.code }); super.append(n, x); } }

describe('conversations in the synced folder', () => {
  it('a conversation started at the office carries on at home, and the office sees what was added', async () => {
    const shared = new Mem();
    const office = conversationLog({ shared, local: new Mem(), installId: 'office', user: () => 'adoe', clock });
    const home = conversationLog({ shared, local: new Mem(), installId: 'home', user: () => 'adoe', clock });
    const at = clock();
    expect((await office.save('deal:d1:c1', [msg('m1', 'me', 'What are the three biggest issues?', at), msg('m2', 'ai', 'The lock-up ratio.', at)])).ok).toBe(true);
    const there = await home.load(); expect(there.ok && there.value['deal:d1:c1'].map((m) => m.text)).toEqual(['What are the three biggest issues?', 'The lock-up ratio.']);
    const at2 = clock();
    await home.save('deal:d1:c1', [...(there.ok ? there.value['deal:d1:c1'] : []), msg('m3', 'me', 'Which is worse?', at2), msg('m4', 'ai', 'The lock-up.', at2)]);
    const back = await office.load(); expect(back.ok && back.value['deal:d1:c1'].map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    // what was already kept is not written again
    expect(shared.files.get('talk-home-0.jsonl')!.trim().split('\n').length).toBe(2);
  });

  it('each person sees only their own conversations', async () => {
    const shared = new Mem(); let who = 'adoe';
    const pc = conversationLog({ shared, local: new Mem(), installId: 'pc', user: () => who, clock });
    const first = msg('m1', 'me', 'adoe asks', clock()); await pc.save('deal:d1:c1', [first]);
    const kroe = conversationLog({ shared, local: new Mem(), installId: 'laptop', user: () => 'kdoe', clock });
    await kroe.save('deal:d1:c2', [msg('k1', 'me', 'kroe asks', clock())]);
    const a = await pc.load(); expect(a.ok && Object.keys(a.value)).toEqual(['deal:d1:c1']);
    who = 'kdoe'; const k = await pc.load(); expect(k.ok && Object.keys(k.value)).toEqual(['deal:d1:c2']);
    // back to the first person: only their lines are held, so theirs are read again, and this PC's numbering carries on
    who = 'adoe';
    const b = await pc.load();
    expect(b.ok && b.value['deal:d1:c1']?.map((m) => m.text)).toEqual(['adoe asks']);
    expect(b.ok && Object.keys(b.value)).toEqual(['deal:d1:c1']);
    await pc.save('deal:d1:c1', [first, msg('m2', 'ai', 'An answer', clock())]);
    const seqs = [...shared.files.entries()].filter(([n]) => n.startsWith('talk-pc-')).flatMap(([, t]) => t.trim().split('\n')).map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual([0, 1]);
  });

  it('an answer retried replaces the failed one; a line cut short or damaged is passed over; lost lines are put back', async () => {
    const shared = new Mem(), local = new Mem();
    const log = conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock });
    const at = clock();
    await log.save('all:c1', [msg('m1', 'me', 'Q', at), msg('m2', 'ai', '', at, 'failed')]);
    await log.save('all:c1', [msg('m1', 'me', 'Q', at), msg('m2', 'ai', 'Now answered', at)]);
    shared.append(
      'talk-other-0.jsonl',
      '{"v":1,"pc":"other","seq":0,"at":"x","by":"adoe","key":"all:c9","m":{"id":"z","role":"me","text":"cut ' + 'sho',
    );
    shared.append('talk-other-1.jsonl', 'not json\n');
    const r = await conversationLog({
      shared,
      local: new Mem(),
      installId: 'reader',
      user: () => 'adoe',
      clock,
    }).load();
    expect(r.ok && r.value).toEqual({ 'all:c1': [msg('m1', 'me', 'Q', at), msg('m2', 'ai', 'Now answered', at)] });
    shared.files.set('talk-pc-0.jsonl', '');                                          // the sync client lost every line
    await log.load();                                                                  // this PC puts them back from its own copy
    const again = await conversationLog({
      shared,
      local: new Mem(),
      installId: 'reader2',
      user: () => 'adoe',
      clock,
    }).load();
    expect(again.ok && again.value['all:c1'][1].text).toBe('Now answered');
  });

  it('a local copy that cannot be written says so, keeps nothing half-written, and numbers the next line as if it had not happened', async () => {
    const shared = new Mem(), local = new Refusing();
    const log = conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock });
    local.refuse = true;
    const r = await log.save('all:c1', [msg('m1', 'me', 'Q', clock())]); expect(!r.ok && r.error.kind).toBe('failed');        // nothing was kept anywhere
    expect(local.files.get('talk-pc-0.jsonl') ?? '').toBe(''); expect(shared.files.get('talk-pc-0.jsonl') ?? '').toBe('');
    local.refuse = false;
    await log.save('all:c1', [msg('m1', 'me', 'Q', clock())]);
    expect(JSON.parse(shared.files.get('talk-pc-0.jsonl')!.trim()).seq).toBe(0);
  });

  it('a shared folder that cannot be written says so; the line is kept on this PC and shared, once, at the next look', async () => {
    const shared = new Refusing(), local = new Mem();
    const log = conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock });
    shared.refuse = true; const m = msg('m1', 'me', 'Q', clock());
    const r = await log.save('all:c1', [m]); expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(shared.files.get('talk-pc-0.jsonl') ?? '').toBe(''); expect(JSON.parse(local.files.get('talk-pc-0.jsonl')!.trim()).seq).toBe(0);
    const here = await log.load(); expect(here.ok && here.value['all:c1'].map((m) => m.id)).toEqual(['m1']);
    shared.refuse = false;
    await log.save('all:c1', [m]);                                                      // already kept: nothing new is written, the lost line is put back
    expect(shared.files.get('talk-pc-0.jsonl')!.trim().split('\n').map((l) => JSON.parse(l).seq)).toEqual([0]);
  });

  it('a shared folder that cannot be read costs nothing of what this PC kept: its conversations still load', async () => {
    const shared = new Mem(), local = new Mem(); const at = clock();
    await conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock }).save('all:c1', [
      msg('m1', 'me', 'Q', at),
      msg('m2', 'ai', 'A', at),
    ]);
    shared.list = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    // the next start, with the folder out of reach
    const r = await conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock }).load();
    expect(r.ok && r.value['all:c1'].map((m) => m.text)).toEqual(['Q', 'A']);
  });

  it('starts a new file when one is full', async () => {
    const shared = new Mem();
    const log = conversationLog({
      shared,
      local: new Mem(),
      installId: 'pc',
      user: () => 'adoe',
      clock,
      segmentBytes: 300,
    });
    for (let i = 0; i < 4; i++) await log.save('all:c1', [msg('m' + i, 'me', 'A question long enough to fill the file quickly ' + i, clock())]);
    expect([...shared.files.keys()].filter((n) => n.startsWith('talk-pc-')).length).toBeGreaterThan(1);
    const r = await conversationLog({
      shared,
      local: new Mem(),
      installId: 'reader',
      user: () => 'adoe',
      clock,
    }).load();
    expect(r.ok && r.value['all:c1'].length).toBe(4);
  });

  it('the app: asked at the office, the conversation is on the home PC when it starts, and carries on there', async () => {
    registry.set(CreateDeal.name, CreateDeal);
    // each PC is an install of its own, on one shared folder for the records and one for the conversations
    const shared = new Mem(); const records = new Mem(); const opts = { latency: [0, 0] as [number, number] }; let n = 0;
    const app = (pc: string) => {
      const repo = memRepo(clock, { shared: records });
      return new Store(
        {
          repo,
          ai: mockAi(opts, repo),
          docs: mockDocuments(opts),
          fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
          sheets: csvCodec,
          session: mockSession(opts),
          local: new MemoryLocal(),
          conversations: conversationLog({ shared, local: new Mem(), installId: pc, user: () => 'adoe', clock }),
          clock: { now: clock },
          ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}` },
        },
        [CreateDeal],
      );
    };
    const office = app('office'); await office.boot(); await office.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
    const dealId = Object.keys(office.get().deals)[0]; const scope: Scope = { kind: 'deal', dealId, conv: 'c0000office' };
    await ask(office, scope, 'What are the three biggest issues?'); await new Promise((r) => setTimeout(r, 20));
    const home = app('home'); await home.boot(); await new Promise((r) => setTimeout(r, 20));
    expect(home.get().threads[convKey(scope)]?.map((m) => m.role)).toEqual(['me', 'ai']);
    await ask(home, scope, 'Which is the worst?'); await new Promise((r) => setTimeout(r, 20));
    await office.loadConversations();
    expect(office.get().threads[convKey(scope)].map((m) => m.text.slice(0, 20))[2]).toBe('Which is the worst?');
  });

  it('conversations follow the person the model service signs in, not the Windows login', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')); const shared = path.join(root, 'shared');
    const pc = (name: string, login: string) => composeBackend({ sharedPath: shared, localPath: path.join(root, `local-${name}`), workPath: path.join(root, `work-${name}`), label: name, user: () => login, service: new StandInService() });
    const office = pc('office', 'adoe'); const home = pc('home', 'adoe');
    try {
      await office.session.load(); await home.session.load();
      expect((await office.conversations!.save('all:c1', [msg('m1', 'me', 'Asked at the office', clock())])).ok).toBe(true);
      const there = await home.conversations!.load(); expect(there.ok && there.value['all:c1']?.map((m) => m.text)).toEqual(['Asked at the office']);
    } finally { office.close(); home.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a conversation the shared folder refused is tried again on its own, without waiting for anything else to happen', async () => {
    const shared = new Refusing(); shared.refuse = true;
    const store = new Store(
      {
        repo: memRepo(clock),
        ai: mockAi({ latency: [0, 0] }),
        docs: mockDocuments({}),
        fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
        sheets: csvCodec,
        session: mockSession({ latency: [0, 0] }),
        local: new MemoryLocal(),
        conversations: conversationLog({ shared, local: new Mem(), installId: 'pc', user: () => 'adoe', clock }),
        clock: { now: clock },
        ids: { next: (p: string) => `${p}_${t++}` },
      } as any,
      [],
    );
    // the folder is looked at again on the store's own timer (`watch`), which puts back what this PC kept; start-up itself waits on real timeouts
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); await store.boot();
    try {
      const at = clock(); store.setThread('all:c1', [msg('q1', 'me', 'Q', at), msg('a1', 'ai', 'A', at)]); await Promise.resolve(); await Promise.resolve();
      expect(shared.files.size).toBe(0); shared.refuse = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect([...shared.files.keys()]).toEqual(['talk-pc-0.jsonl']);
    } finally { vi.useRealTimers(); }
  });

  it('a message read back with its fields in another order is not written again', async () => {
    const shared = new Mem();
    const pc = conversationLog({ shared, local: new Mem(), installId: 'pc', user: () => 'adoe', clock });
    const at = clock(); const m = { id: 'm1', role: 'me' as const, text: 'Q', sources: [], state: 'done' as const, at };
    await pc.save('all:c1', [m]); await pc.save('all:c1', [{ at, state: 'done', sources: [], text: 'Q', role: 'me', id: 'm1' }]);
    expect(shared.files.get('talk-pc-0.jsonl')!.trim().split('\n').length).toBe(1);
  });

  it('a message this PC cannot keep at all is said to be not saved, stays on screen, and Retry keeps it once the disk has room', async () => {
    for (const code of ['ENOSPC', 'EACCES']) {
      const shared = new Mem(), local = new Refusing(); local.code = code;
      const store = new Store(
        {
          repo: memRepo(clock),
          ai: mockAi({ latency: [0, 0] }),
          docs: mockDocuments({}),
          fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
          sheets: csvCodec,
          session: mockSession({ latency: [0, 0] }),
          local: new MemoryLocal(),
          conversations: conversationLog({ shared, local, installId: 'pc', user: () => 'adoe', clock }),
          clock: { now: clock },
          ids: { next: (p: string) => `${p}_${t++}` },
        } as any,
        [],
      );
      await store.boot();
      local.refuse = true; const at = clock(); store.setThread('all:c1', [msg('q1', 'me', 'Asked with the disk full', at), msg('a1', 'ai', 'The answer.', at)]); await new Promise((r) => setTimeout(r, 5));
      const said = store.get().ui.toasts.at(-1)!;
      expect(said.text).toMatch(/^Conversation not saved/); expect(said.text).not.toMatch(/kept on this PC/); expect(said.sticky).toBe(true); expect(said.action?.label).toBe('Retry');
      expect(shared.files.size + local.files.size).toBe(0);                                            // nothing was kept anywhere
      await store.loadConversations(); expect(store.get().threads['all:c1'].map((m) => m.text)).toEqual(['Asked with the disk full', 'The answer.']);   // still on screen
      local.refuse = false; said.action!.run!(); await new Promise((r) => setTimeout(r, 5));
      const back = await conversationLog({
        shared,
        local: new Mem(),
        installId: 'other',
        user: () => 'adoe',
        clock,
      }).load();
      expect(back.ok && back.value['all:c1'].map((m) => m.text)).toEqual(['Asked with the disk full', 'The answer.']);
    }
  });

  it('an answer retried here wins over the failed copy kept earlier, and is kept once the folder is back', async () => {
    const shared = new Refusing();
    const kept = conversationLog({ shared, local: new Mem(), installId: 'pc', user: () => 'adoe', clock });
    const store = new Store({ repo: memRepo(clock), ai: mockAi({ latency: [0, 0] }), docs: mockDocuments({}), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession({ latency: [0, 0] }), local: new MemoryLocal(), conversations: kept, clock: { now: clock }, ids: { next: (p: string) => `${p}_${t++}` } } as any, []);
    await store.boot();
    const at = clock(); const q = { id: 'q1', role: 'me' as const, text: 'Q', state: 'done' as const, at };
    store.setThread('all:c1', [q, { id: 'a1', role: 'ai', text: '', state: 'failed', at }]); await new Promise((r) => setTimeout(r, 5));
    shared.refuse = true; store.setThread('all:c1', [q, { id: 'a1', role: 'ai', text: 'The answer.', state: 'done', at }]); await new Promise((r) => setTimeout(r, 5));
    await store.loadConversations(); expect(store.get().threads['all:c1'][1]).toMatchObject({ state: 'done', text: 'The answer.' });
    shared.refuse = false; await store.loadConversations(); await new Promise((r) => setTimeout(r, 5));
    const back = await conversationLog({
      shared,
      local: new Mem(),
      installId: 'other',
      user: () => 'adoe',
      clock,
    }).load();
    expect(back.ok && back.value['all:c1'][1]).toMatchObject({ state: 'done', text: 'The answer.' });
  });

  it('a question whose answer never arrived gets a failed answer to retry, the same on every PC, and pairs stay in step', async () => {
    const shared = new Mem();
    const office = conversationLog({ shared, local: new Mem(), installId: 'office', user: () => 'adoe', clock });
    const at = clock(); await office.save('all:c1', [msg('q1', 'me', 'Asked at the office', at)]);   // the first PC closed before the answer came
    const store = new Store(
      {
        repo: memRepo(clock),
        ai: mockAi({ latency: [0, 0] }),
        docs: mockDocuments({}),
        fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) },
        sheets: csvCodec,
        session: mockSession({ latency: [0, 0] }),
        local: new MemoryLocal(),
        conversations: conversationLog({ shared, local: new Mem(), installId: 'home', user: () => 'adoe', clock }),
        clock: { now: clock },
        ids: { next: (p: string) => `${p}_${t++}` },
      } as any,
      [],
    );
    await store.boot(); await new Promise((r) => setTimeout(r, 5));
    expect(store.get().threads['all:c1'].map((m) => [m.role, m.state])).toEqual([['me', 'done'], ['ai', 'failed']]);
    const later = clock(); store.setThread('all:c1', [...store.get().threads['all:c1'], { id: 'q2', role: 'me', text: 'Asked at home', state: 'done', at: later }, { id: 'a2', role: 'ai', text: 'Answered.', state: 'done', at: later }]);
    await new Promise((r) => setTimeout(r, 5)); await office.load(); const there = await office.load();
    expect(there.ok && there.value['all:c1'].map((m) => m.role)).toEqual(['me', 'ai', 'me', 'ai']);
  });
  it('a save cut short by a full disk is saved whole once there is room and survives a rollback (#126)', async () => {
    const shared = new Mem();
    const local = new Tearing();
    const file = 'talk-office-0.jsonl';
    const log = conversationLog({ shared, local, installId: 'office', user: () => 'adoe', clock });
    const ask = (n: number) => `For contract ${n}, is revenue recognized on delivery or on acceptance? See §4.2.`;
    const answer = (n: number) => `Contract ${n} recognizes revenue on acceptance; 12% is deferred.`;
    const turn = (n: number, at: string) => [msg(`q${n}`, 'me', ask(n), at), msg(`a${n}`, 'ai', answer(n), at)];
    let thread: KeptMessage[] = [];
    for (let n = 1; n <= 150; n++) {
      thread = [...thread, ...turn(n, clock())];
      expect((await log.save('deal:d1:c1', thread)).ok).toBe(true);
    }
    const kept = local.files.get(file)!;
    thread = [...thread, ...turn(151, clock())];
    local.tear = 330;                                                   // the first line and part of the second
    local.refuseWrites = true;                                          // and then the disk is full
    expect((await log.save('deal:d1:c1', thread)).ok).toBe(false);
    expect(local.files.get(file)!.slice(kept.length)).toMatch(/^\{.*"q151".*\n\{/);   // not cut off yet
    await log.load();                                       // a look at the folder meanwhile takes none of it
    local.refuseWrites = false;
    expect((await log.save('deal:d1:c1', thread)).ok).toBe(true);
    const ids = wholeLines(local.files.get(file)!).map((l) => JSON.parse(l).m.id);
    expect(ids.length).toBe(302);
    expect(ids.slice(-2)).toEqual(['q151', 'a151']);
    shared.files.set(file, kept.split('\n').slice(0, 40).join('\n') + '\n');     // the sync client rolled back
    await log.load();
    const home = conversationLog({ shared, local: new Mem(), installId: 'home', user: () => 'adoe', clock });
    const there = await home.load();
    expect(there.ok && there.value['deal:d1:c1'].map((m) => m.id)).toEqual(thread.map((m) => m.id));
  });
  it('while a failed save cannot be cut off, the lines saved before it are still read here (#126)', async () => {
    const shared = new Mem();
    const local = new Tearing();
    let who = 'adoe';
    const log = conversationLog({ shared, local, installId: 'pc', user: () => who, clock });
    const at = clock();
    const first = msg('m1', 'me', 'Is the earn-out capped?', at);
    expect((await log.save('deal:d1:c1', [first])).ok).toBe(true);
    shared.list = () => { throw new Error('The folder cannot be reached'); };
    local.tear = 5;
    local.refuseWrites = true;
    const answer = msg('m2', 'ai', 'Yes, at 20% of the price.', at);
    expect((await log.save('deal:d1:c1', [first, answer])).ok).toBe(false);
    who = 'kdoe';                                                      // another person signs in and out again
    await log.load();
    who = 'adoe';
    const back = await log.load();
    expect(back.ok && back.value).toEqual({ 'deal:d1:c1': [first] });
  });
  it('a number left in a failed save that cannot be cut off is not given to the next save (#126)', async () => {
    const shared = new Mem();
    let local = new Tearing();
    const open = (folder: Mem) => conversationLog({
      shared, local: folder, installId: 'pc', user: () => 'adoe', clock, segmentBytes: 400,   // a file two lines long
    });
    const log = open(local);
    const at = clock();
    const ask = (id: string) => msg(id, 'me', `Does clause ${id} survive a change of control of the borrower?`, at);
    expect((await log.save('deal:d1:cA', [ask('a1'), ask('a2')])).ok).toBe(true);
    local.tear = 250;                                                   // one whole line and part of the next
    local.refuseWrites = true;                                          // and then too full to cut them off
    expect((await log.save('deal:d1:cA', [ask('a1'), ask('a2'), ask('a3'), ask('a4')])).ok).toBe(false);
    expect(local.files.get('talk-pc-1.jsonl')).toMatch(/"a3".*\n\{/);   // a3 whole, a4 begun: not cut off yet
    expect((await log.save('deal:d1:cB', [ask('b1')])).ok).toBe(true);
    const restarted = new Tearing();                                    // the app restarts: what failed is not known
    restarted.files = new Map(local.files);
    local = restarted;
    await open(local).load();
    shared.files = new Map([...shared.files].sort());                  // listed by name, as a disk lists them
    const home = conversationLog({ shared, local: new Mem(), installId: 'home', user: () => 'adoe', clock });
    const there = await home.load();
    expect(there.ok && there.value['deal:d1:cB']?.map((m) => m.id)).toEqual(['b1']);
  });
});
