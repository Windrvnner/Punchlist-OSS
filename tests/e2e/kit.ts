// The end-to-end kit: the app's store on the real backend, put together by `composeBackend` (the same function the
// Windows shell uses), on real folders: a data room of real files, one sync folder per PC, and a carry step that stands in
// for OneDrive between them. Only the model is a stand-in (or Claude, when a key is set: see live.test.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeBackend, type Backend } from '../../src/backend/compose';
import { StandInService, type ModelService } from '../../src/backend/service';
import { Store } from '../../src/app/store';
import { registry } from '../../src/app/commands/undo';
import { CreateDeal, AddFolders, DeleteDeal, EditDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, UseAsResponse, RenumberQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { ImportIssuesList, RevertIssuesList } from '../../src/app/commands/issuesList';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { Undo } from '../../src/app/commands/undo';
import { MemoryLocal } from '../../src/adapters/local';
import { ulidIds } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { startIndexing } from '../../src/app/indexing';
import type { Checklist, Timing } from '../../src/backend/ai';

/** the same list of commands the shell registers */
export const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, EditDeal, EditFinding, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding, UseAsResponse, ImportQuestions, RevertImport, ImportIssuesList, RevertIssuesList, ResolveConflict, ReopenConflict, RenumberQuestion, Undo];
for (const c of COMMANDS) registry.set(c.name, c);

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dil-e2e-'));
export function put(dir: string, rel: string, bytes: Uint8Array | string) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); }

/** a real, small PDF whose pages each say `text`, or each say their own text from a list */
export function pdf(text: string | string[], pages = 1): Uint8Array {
  // one text on every page, or (a list) each page's own text, so a document can end on an execution page
  const texts = Array.isArray(text) ? text : Array.from({ length: pages }, () => text); pages = texts.length;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  // the text is set in lines short enough to stay on the page, so the whole of it can be read
  const linesOf = (t: string) => { const lines: string[] = []; for (const w of t.split(' ')) { const last = lines[lines.length - 1]; if (last !== undefined && (last + ' ' + w).length <= 70) lines[lines.length - 1] = last + ' ' + w; else lines.push(w); } return lines; };
  for (let i = 0; i < pages; i++) { const body = [...linesOf(texts[i]), `page ${i + 1}`].map((l, k) => `${k === 0 ? '72 720 Td' : '0 -16 Td'} (${l}) Tj`).join(' '); const stream = `BT /F1 12 Tf ${body} ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let out = '%PDF-1.4\n'; const at: number[] = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** OneDrive between two PCs: each one's sync folder gets what the other has written that it lacks (the longer copy of a file wins, as an append-only file grows) */
export function carry(a: string, b: string) {
  for (const [from, to] of [[a, b], [b, a]]) {
    const walk = (rel: string) => { for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) { fs.mkdirSync(path.join(to, r), { recursive: true }); walk(r); continue; } const src = fs.readFileSync(path.join(from, r)); const dst = path.join(to, r); const have = fs.existsSync(dst) ? fs.readFileSync(dst) : null; if (!have || src.length > have.length) fs.writeFileSync(dst, src); } };
    walk('');
  }
}

export interface PcApp { backend: Backend; store: Store; service: ModelService; dirs: { shared: string; local: string; work: string } }
/** one PC: its own local and work folders, its copy of the sync folder, the real backend, and the app's store on it */
export async function pcApp(root: string, name: string, o: { service: ModelService; checklist?: () => Checklist; user?: string; /** one sync folder for several PCs: OneDrive with no delay */ shared?: string; timing?: Partial<Timing>; inTouch?: () => boolean; now?: () => number; clock?: () => string; batch?: number }): Promise<PcApp> {
  const dirs = { shared: o.shared ?? path.join(root, `sync-${name}`), local: path.join(root, `local-${name}`), work: path.join(root, `work-${name}`) };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const backend = composeBackend({ retry: { sleep: async () => {} }, sharedPath: dirs.shared, localPath: dirs.local, workPath: dirs.work, label: name, user: () => o.user ?? name, service: o.service, checklist: o.checklist ? () => o.checklist!() : undefined, tuning: { width: 4, batch: o.batch ?? 10 }, timing: o.timing, inTouch: o.inTouch, now: o.now, clock: o.clock });
  const store = new Store({
    repo: backend.repo, ai: backend.ai, docs: backend.docs, session: backend.session,
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) } as any, sheets: csvCodec, local: new MemoryLocal(),
    clock: { now: () => new Date().toISOString() }, ids: ulidIds,
  }, COMMANDS);
  await store.boot();
  return { backend, store, service: o.service, dirs };
}

/** wait for something on a PC, a little at a time */
export async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for: ${what}`);
}

/** create a deal with one data-room folder on this PC and index it, as the New deal dialog does; resolves when its first pass has ended */
export async function newDeal(pc: PcApp, name: string, vdr: string, indexingTimeout?: number) {
  const r = await pc.store.dispatch(CreateDeal, { name, folders: [{ path: vdr, label: 'Data room', files: 0, size: '' }] });
  if (!r.ok) throw new Error(r.error.message);
  const id = Object.values(pc.store.get().deals).find((d) => d.name === `Project ${name}` || d.name === name)!.id;
  await startIndexing(pc.store, id, pc.store.get().deals[id].folders);
  await until('indexing to finish', async () => {
    const progress = await pc.backend.docs.poll(id);
    return progress.ok && progress.value.done;
  }, indexingTimeout);
  await pc.backend.idle();
  return id;
}

export { StandInService };
