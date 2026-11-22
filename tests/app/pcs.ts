/** Two (or three) PCs on stand-in folders, each with its own Store and clock, and a sync client that carries files across by hand. */
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { SetDealMember } from '../../src/app/commands/members';
import { CreateQuestion, EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, DeleteFinding, RestoreFinding } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { RestoreVersion } from '../../src/app/commands/keptVersions';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import type { ImportRow } from '../../src/domain/importExport';

export class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
/** the sync client: every PC's copy of the shared folder ends up with every file at its longest */
export function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, DeleteDeal, SetDealMember, CreateQuestion, EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, EditFinding, DeleteFinding, RestoreFinding, ImportQuestions, RevertImport, ResolveConflict, ReopenConflict, RestoreVersion, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
/** One PC: its own copy of the shared folder, its own local folder, its own clock (`skewMs` ahead of or behind the others). */
export function pc(label: string, user: string, skewMs = 0) {
  const shared = new Mem(), local = new Mem(); let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 12, 9, 0, 0, 0) + skewMs + (tick++) * 10).toISOString();
  const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => label.replace(/\W/g, '').toLowerCase() });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: user, initials: 'XX' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: new MemoryLocal(),
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXT${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  return { repo, shared, local, store, label };
}
export type PC = ReturnType<typeof pc>;
export const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
export async function syncAll(...ps: PC[]) { carry(...ps.map((p) => p.shared)); for (const p of ps) await p.repo.sync(); await settle(); }
/** a deal with one question and one finding on A, opened on B (and C) as well */
export async function twoPcs(skewB = 0) {
  const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe', skewB);
  await A.store.boot(); await A.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(A.store.get().deals)[0]; await A.store.loadDeal(dealId, { gaps: false });
  await A.store.dispatch(CreateQuestion, { dealId, text: 'Is there a decommissioning bond?' }); const qid = dealQuestions(A.store.get(), dealId)[0].id;
  await A.store.dispatch(CreateFinding, { dealId, title: 'Lock-up ratio below covenant', body: ['DSCR 1.05x against 1.10x.'], workstream: 'Financial' }); const fid = dealFindings(A.store.get(), dealId)[0].id;
  carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
  return { A, B, dealId, qid, fid };
}
/** one row of a Q&A import */
export const row = (n: number, text: string, response = ''): ImportRow => ({ n, text, askedBy: '', received: '', workstream: '', priority: '', response, respondedBy: '', responded: '', status: '' }) as ImportRow;
export const okd = (r: { ok: boolean; error?: { message: string } }) => { if (!r.ok) throw new Error(r.error?.message ?? 'refused'); return r as any; };

