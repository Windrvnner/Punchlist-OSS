// A store and deal for Q&A import tests, and files to import into it: each test makes its own.
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField, SetQuestionStatus }
  from '../../src/app/commands/questions';
import { CreateFinding, DeleteFinding, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField,
  SetQuestionStatus, CreateFinding, DeleteFinding, RestoreFindingSnapshot, ImportQuestions, RevertImport,
  RestoreQuestionSnapshot];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

/** a store on an in-memory repository, with mock services */
export function make() {
  const opts = { latency: [0, 0] as [number, number] }; const kv = disk(); const repo = memRepo(clock.now, kv);
  const fs = { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) };
  const services = { repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs, sheets: csvCodec,
    session: mockSession(opts), local: new MemoryLocal(), clock, ids };
  const store = new Store(services, COMMANDS);
  return { store, kv, repo };
}
/** a new deal, loaded: its id */
export async function deal(store: Store) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
  const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id); return id;
}
/** a CSV file's rows as the import reads them; the file is marked UTF-8, as Excel writes one */
export const rowsFrom = (csv: string) => {
  const table = readCsv(new TextEncoder().encode('\uFEFF' + csv)); if (!table.ok) throw new Error('csv');
  return prepareImport(table.value.rows, suggestMapping(table.value.columns)).rows;
};
/** rows under a header line, each cell quoted */
export const sheet = (header: string, rows: string[][]) =>
  rowsFrom([header, ...rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n'));
/** the columns of `fileRow`'s file */
export const mapping = suggestMapping(['Number', 'Question', 'Response', 'Submitted by', 'Workstream']);
/** a one-row file from a lender */
export const fileRow = (n: number, text: string, response: string) => rowsFrom(
  `Number,Question,Response,Submitted by,Workstream\n${n},${text},${response},Lender,Finance\n`,
);
