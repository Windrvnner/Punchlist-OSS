/** Real journal and record storage, copied at a controlled interruption boundary. */
import { Store } from '../../src/app/store';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { CreateFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { AddDealItems, SetItemsOff } from '../../src/app/commands/checklist';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { KeepQaLog, RecordQaLogExport } from '../../src/app/commands/qaLogs';
import { memRepo, disk, type Disk } from '../adapters/memRepo';
import type { Transaction } from '../../src/ports';

const commands = [
  CreateDeal, CreateQuestion, SetResponse, CreateFinding, SetFindingStatus,
  AddDealItems, SetItemsOff, ImportQuestions,
  KeepQaLog, RecordQaLogExport,
];
let sequence = 0;

export function recoveryApp(saved = disk()) {
  const clock = { now: () => new Date(Date.UTC(2026, 10, 19, 10, 0, 0, sequence++)).toISOString() };
  const repo = memRepo(clock.now, saved);
  const options = { latency: [0, 0] as [number, number] };
  const store = new Store({
    repo, ai: mockAi(options, repo), docs: mockDocuments(options), sheets: csvCodec,
    qaLogs: {
      read: async () => ({ ok: false, error: { kind: 'failed', message: 'Not read by this test' } }),
      save: async () => ({ ok: false, error: { kind: 'failed', message: 'Not saved by this test' } }),
      create: async () => ({ ok: false, error: { kind: 'failed', message: 'Not created by this test' } }),
    },
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true, value: 'saved' }) },
    session: mockSession(options), local: new MemoryLocal(), clock,
    ids: { next: (kind) => `${kind}_01HZZZZZZZZZZZZZZZZ${String(sequence++).padStart(7, '0')}` },
  }, commands);
  return { store, repo, saved };
}
export type RecoveryApp = ReturnType<typeof recoveryApp>;

export function copyRecoveryDisk(saved: Disk): Disk {
  const copy = disk();
  copy.shared.files = new Map(saved.shared.files);
  copy.local.files = new Map(saved.local.files);
  return copy;
}

export async function recoveryDeal(app: RecoveryApp) {
  await app.store.boot();
  await app.store.dispatch(CreateDeal, { name: 'Recovery fixture', folders: [] });
  const dealId = Object.keys(app.store.get().deals)[0];
  await app.store.loadDeal(dealId, { gaps: false });
  return dealId;
}

/** Holds a genuine repository transaction before its writes; every other call reaches LogRepository unchanged. */
export function holdRecoveryWrite(
  app: RecoveryApp, matches: (transaction: Transaction) => boolean, afterCommit = false,
) {
  const original = app.repo.transaction.bind(app.repo);
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  app.repo.transaction = async (transaction) => {
    if (matches(transaction)) {
      const result = afterCommit ? await original(transaction) : null;
      reached();
      await barrier;
      if (result) return result;
    }
    return original(transaction);
  };
  return { entered, release: () => { app.repo.transaction = original; release(); } };
}

export function operationWrite(transaction: Transaction, command: string, state: string) {
  return transaction.writes.some((write) => write.kind === 'op'
    && (write.data as { command?: string }).command === command
    && (write.data as { state?: string }).state === state);
}
