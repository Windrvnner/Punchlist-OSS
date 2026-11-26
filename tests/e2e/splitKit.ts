// The kit for the work-splitting tests (docs/architecture.md, Checks, and how PCs share them): two PCs on the real backend, each with its own
// copy of the data room and its own sync folder, a link between the sync folders that stands in for OneDrive (and can
// be paused, each way), a stand-in model that is slow enough for the PCs to overlap, and short times for liveness.
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, pcApp, until, StandInService, type PcApp } from './kit';
import { CreateDeal } from '../../src/app/commands/deals';
import { startIndexing } from '../../src/app/indexing';
import {
  isPickAsk,
  isPickForAsk,
  isDescribeAsk,
  isAffectsAsk,
  isVerifyAsk,
  isHearAsk,
  itemsIn,
  listed,
  nth,
} from '../backend/reviewKit';
import type { Timing, nodeAi } from '../../src/backend/ai';
import { view, type RLine } from '../../src/backend/rounds';
import { signedOut } from '../../src/backend/signInToken';

/** short times, so that a PC that stops is seen to have gone within a second */
export const FAST: Partial<Timing> = { lapse: 900, renew: 200, watch: 40, retryFirst: 40, retryMax: 200, giveUp: 400, retryEvery: 150 };
export const roots: string[] = [];

/** OneDrive between two sync folders: every few milliseconds each gets what the other has that it lacks, unless that way is paused */
export function link(a: string, b: string, every = 20) {
  const on = { ab: true, ba: true };
  const one = (from: string, to: string) => {
    const walk = (rel: string) => { for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) { fs.mkdirSync(path.join(to, r), { recursive: true }); walk(r); continue; } if (e.name.endsWith('.tmp')) continue; try { const src = fs.readFileSync(path.join(from, r)); const dst = path.join(to, r); const have = fs.existsSync(dst) ? fs.statSync(dst).size : -1; if (src.length > have) { fs.writeFileSync(dst + '.sync', src); fs.renameSync(dst + '.sync', dst); } } catch { /* being written: next time */ } } };
    walk('');
  };
  const timer = setInterval(() => { if (on.ab) one(a, b); if (on.ba) one(b, a); }, every);
  return { pause(way: 'ab' | 'ba' | 'both') { if (way !== 'ba') on.ab = false; if (way !== 'ab') on.ba = false; }, resume() { on.ab = true; on.ba = true; }, stop() { clearInterval(timer); }, now() { one(a, b); one(b, a); } };
}

export const ITEM = (i: number) => ({ id: `c${i}`, text: `Clause ${i} of the finance documents is in order` });
export const numOf = (text: string) => +(/Clause (\d+)/.exec(text)?.[1] ?? 0);

export interface Script {
  /** milliseconds each model call takes */
  delay?: number;
  /** items the documents raise a finding on */
  finding?: (n: number, model: string) => boolean;
  /** items left unsettled: the reply on them cannot be used */
  weak?: (n: number, model: string) => boolean;
  /** the fast model's look disagrees on these (it says more is needed) */
  doubt?: (n: number) => boolean;
  /** whether a finding stands, by model */
  stands?: (title: string, model: string) => boolean | null;
  /** throw as a service that cannot be reached */
  down?: () => boolean;
  /** throw as a call that has waited for sign-in as long as it may (nobody is signed in to the model service) */
  signedOut?: () => boolean;
  /** a call waits on this before it answers */
  hold?: (c: { model: string; prompt: string }) => Promise<void> | undefined;
}
/** a stand-in model for one PC, with the script its replies follow (which can be changed during a test) */
export function model(script: Script = {}) {
  const s = { script };
  const svc = new StandInService(async (c) => {
    const sc = s.script; await new Promise((r) => setTimeout(r, sc.delay ?? 15)); const held = sc.hold?.(c); if (held) await held;
    if (sc.down?.()) throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' });
    if (sc.signedOut?.()) throw signedOut();
    const ref = (n: number) => nth(c, n);
    if (isDescribeAsk(c as any)) return JSON.stringify({ summary: 'A finance document.', keywords: ['finance'] });
    if (isPickAsk(c as any) || isPickForAsk(c as any))
      return JSON.stringify({
        read: listed(c as any)
          .slice(0, 2)
          .map((r) => r.id),
      });
    if (isAffectsAsk(c as any) || isHearAsk(c as any)) return JSON.stringify({ affected: [] });
    if (isVerifyAsk(c as any)) { const title = /Title: (.*)/.exec(c.prompt)?.[1] ?? ''; const st = sc.stands ? sc.stands(title, c.model) : true; return st === null ? 'no idea' : JSON.stringify({ stands: st, why: st ? 'It stands.' : 'A document now settles it.' }); }
    const items = itemsIn(c as any);
    if (items.length) return JSON.stringify({ items: items.map((it) => { const n = numOf(it.text);
      if (sc.weak?.(n, c.model)) return { id: it.tag, result: 'nonsense' };
      if (c.model === 'fast' && sc.doubt?.(n)) return { id: it.tag, result: 'more', need: 'another report' };
      if (sc.finding?.(n, c.model)) return { id: it.tag, result: 'finding', title: `Clause ${n} differs between the documents`, workstream: 'Legal', body: ['One says this. [1] The other says that. [2]'], next: 'Ask.', sources: [{ doc: ref(1), page: 1 }, { doc: ref(1), page: 2 }] };
      return c.prompt.includes('Add "where"') ? { id: it.tag, result: 'ok', where: [{ doc: ref(1), page: 1, quote: 'in order' }] } : { id: it.tag, result: 'ok' }; }) });
    return JSON.stringify({ text: 'ok', sources: [] });
  });
  return Object.assign(svc, { set(next: Script) { s.script = next; } });
}
export type Model = ReturnType<typeof model>;
/** the items each call to a model checked, by model: [model, item numbers] */
export const checks = (svc: StandInService) => svc.calls.filter((c) => itemsIn(c as any).length).map((c) => [c.model, itemsIn(c as any).map((it) => numOf(it.text))] as [string, number[]]);
export const verifies = (svc: StandInService) => svc.calls.filter((c) => isVerifyAsk(c as any)).map((c) => [c.model, /Title: (.*)/.exec(c.prompt)?.[1] ?? ''] as [string, string]);

export interface Pair {
  A: PcApp;
  B: PcApp;
  dealId: string;
  sync: { A: string; B: string };
  net: ReturnType<typeof link>;
  svcA: Model;
  svcB: Model;
  list: { on: boolean; items: { id: string; text: string }[] };
  touch: { A: boolean; B: boolean };
  root: string;
  /** ends the work both PCs started, then the link; resolves before the case removes the folders */
  close(): Promise<void>;
}
/**
 * Two PCs on one deal, each with its own copy of the data room, indexed; the checklist is held back while they index,
 * so no round starts until a test starts one.
 */
export async function pair(o: { items?: number; list?: { id: string; text: string }[]; room?: (dir: string) => void; serviceA?: StandInService | import('../../src/backend/service').ModelService; serviceB?: StandInService | import('../../src/backend/service').ModelService; batch?: number; /** the person signed in at each PC, as whoami gives it */ users?: [string, string]; /** the office's checks wait, once a round is open, until the laptop is a member of it, so the two surely overlap however busy the machine is */ meet?: boolean; scriptA?: Script; scriptB?: Script; timing?: Partial<Timing>; nowA?: () => number; nowB?: () => number; clockB?: () => string; one?: boolean } = {}): Promise<Pair> {
  const root = tmp(); roots.push(root);
  const sync = { A: path.join(root, 'sync-A'), B: path.join(root, 'sync-B') }; for (const d of Object.values(sync)) fs.mkdirSync(d, { recursive: true });
  const vdrA = path.join(root, 'vdr-A'), vdrB = path.join(root, 'vdr-B');
  for (const v of [vdrA, vdrB]) { if (o.room) o.room(v); else { put(v, 'Credit agreement.pdf', pdf('Credit agreement: the finance documents in full', 2)); put(v, 'Term sheet.pdf', pdf('Term sheet: the finance documents in summary', 2)); } }
  const list = { on: false, items: o.list ?? Array.from({ length: o.items ?? 40 }, (_, i) => ITEM(i + 1)) };
  const checklist = () => ({ broad: list.on ? list.items : [], product: [], sector: [] });
  const touch = { A: true, B: true };
  const svcA = model(o.scriptA), svcB = model(o.scriptB);
  const net = link(sync.A, sync.B);
  const A = await pcApp(root, 'Office', {
    batch: o.batch,
    service: (o.serviceA as any) ?? svcA,
    checklist,
    user: o.users?.[0] ?? 'adoe',
    shared: sync.A,
    timing: { ...FAST, ...o.timing },
    inTouch: () => touch.A,
    now: o.nowA,
  });
  const r = await A.store.dispatch(CreateDeal, { name: 'Wingtip', folders: [{ path: vdrA, label: 'Data room', files: 0, size: '' }] }); if (!r.ok) throw new Error(r.error.message);
  const dealId = Object.keys(A.store.get().deals)[0];
  fs.mkdirSync(path.join(root, 'local-Laptop'), { recursive: true }); fs.writeFileSync(path.join(root, 'local-Laptop', 'folders.json'), JSON.stringify({ [dealId]: { [vdrA]: vdrB } }));
  net.now();
  const B = await pcApp(root, 'Laptop', { batch: o.batch, service: (o.serviceB as any) ?? svcB, checklist, user: o.users?.[1] ?? 'sroe', shared: sync.B, timing: { ...FAST, ...o.timing }, inTouch: () => touch.B, now: o.nowB, clock: o.clockB });
  await until('the laptop to see the deal', async () => { await B.backend.repo.sync!(); await B.store.boot(); return !!B.store.get().deals[dealId]; });
  await startIndexing(A.store, dealId, A.store.get().deals[dealId].folders);
  await until('the office to index', async () => { const p = await A.backend.docs.poll(dealId); return p.ok && p.value.done; });
  net.now();
  if (!o.one) { await startIndexing(B.store, dealId, B.store.get().deals[dealId].folders); await until('the laptop to index', async () => { const p = await B.backend.docs.poll(dealId); return p.ok && p.value.done; }); }
  await A.backend.idle(); await B.backend.idle(); net.now();
  const docsIn = (A.backend.docs as any).records(dealId).length;
  await until('both PCs to have the same documents', () => docsIn >= 2 && (B.backend.docs as any).records(dealId).length === docsIn);
  if (o.meet) {
    const own = o.scriptA?.hold; const bId = B.backend.installId;
    const met = () => logOf(sync.A, dealId).some((l) => l.member && l.member.pc === bId && logOf(sync.A, dealId).some((x) => x.plan?.id === l.member!.round));
    svcA.set({ ...o.scriptA, hold: (c) => own?.(c) ?? (itemsIn(c as any).length && !met() ? until('the laptop to join the round', met, 30000) : undefined) });
  }
  svcA.calls.length = 0; svcB.calls.length = 0; list.on = true;
  const close = async () => {
    // The work the PCs started ends while their folders still exist:
    // a pass that outlives its case would list a removed folder (#870).
    await Promise.all([A.backend.close(), B.backend.close()]);
    await Promise.all([A.backend.idle(), B.backend.idle()]);
    net.stop();
  };
  return { A, B, dealId, sync, net, svcA, svcB, list, touch, root, close };
}

/** every check-log line on the deal, as a PC's sync folder has them */
export function logOf(dir: string, dealId: string): (RLine & Record<string, any>)[] {
  const out: (RLine & Record<string, any>)[] = [];
  for (const f of fs.readdirSync(dir)) if (f.startsWith('checks-') && f.includes(dealId)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* cut short */ } }
  return out.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
}
export const roundsOf = (dir: string, dealId: string) => view(logOf(dir, dealId)).rounds;
/** wait until every round on the deal has ended, as both PCs see it */
export async function allEnded(p: Pair, ms = 20000) {
  await until('every round to end', () => { p.net.now(); const a = [...roundsOf(p.sync.A, p.dealId).values()], b = [...roundsOf(p.sync.B, p.dealId).values()]; return a.length > 0 && a.every((r) => r.end) && b.length === a.length && b.every((r) => r.end); }, ms);
  await p.A.backend.idle(); await p.B.backend.idle();
}
/** a PC's checks, with the entries the app does not call itself (the first pass, settled, close) */
export const aiOf = (P: PcApp) => P.backend.ai as unknown as ReturnType<typeof nodeAi>;
export { until, fs, path };
/** the checklist rows a PC shows, as `id:result[:finding]`, sorted */
export async function rowsOf(P: PcApp, dealId: string) {
  const r = await P.backend.ai.checklist!(dealId);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.map((row) => `${row.id}:${row.result}${row.findingId ? `:${row.findingId}` : ''}`).sort();
}
