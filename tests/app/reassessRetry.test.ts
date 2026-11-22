/**
 * An update from documents that still fails after the backend's quiet retries says so with Retry on its notice
 * (decisions: Retries), and Retry runs it again. Nothing the person had is changed by the failure. On a deal of 2,000 questions.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, EditFinding, Reassess, ApplyReassessment } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { reassess } from '../../src/app/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { MemoryLocal } from '../../src/adapters/local';
import { ok, fail } from '../../src/domain/result';

const COMMANDS = [CreateDeal, CreateFinding, EditFinding, Reassess, ApplyReassessment, ImportQuestions];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

describe('Update from documents fails after its retries', () => {
  it('the notice offers Retry, and Retry runs the update again; the finding is unchanged until it lands', async () => {
    const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
    let calls = 0; const NEW = { body: ['The liability cap is 20% of the contract price.'], sources: [] };
    const ai = { ...mockAi(opts, repo), reassess: async () => (++calls === 1 ? fail({ kind: 'failed' as const, message: 'said 500' }) : ok(NEW)) };
    const store = new Store({ repo, ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
    await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
    const dealId = Object.values(store.get().deals)[0].id; await store.loadDeal(dealId);
    const csv = ['No.,Question', ...Array.from({ length: 2000 }, (_, i) => `${i + 1},"Question ${i + 1} on item ${i * 7919 % 10007}?"`)].join('\n');
    const table = readCsv(new TextEncoder().encode(csv)); if (!table.ok) throw new Error('csv');
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: prepareImport(table.value.rows, suggestMapping(table.value.columns)).rows }, { quiet: true })).ok).toBe(true);
    await store.dispatch(CreateFinding, { dealId, title: 'Liability cap', workstream: 'Legal', body: ['The cap is not stated.'], origin: 'chat' }, { quiet: true });
    const findingId = Object.values(store.get().findings)[0].id; const f = () => store.get().findings[findingId];

    await reassess(store, dealId, findingId); await new Promise((r) => setTimeout(r, 0));
    const notice = store.get().ui.toasts.at(-1)!;
    expect(notice.text).toBe('Couldn’t update the finding. Nothing was changed.'); expect(notice.action?.label).toBe('Retry');
    expect(f().body).toEqual(['The cap is not stated.']);                         // nothing was changed by the failure

    notice.action!.run!(); for (let i = 0; i < 20 && JSON.stringify(f().body) !== JSON.stringify(NEW.body); i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(2); expect(f().body).toEqual(NEW.body);
  });
});
