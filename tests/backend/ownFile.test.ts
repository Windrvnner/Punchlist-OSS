// @vitest-environment node
// A PC's own notes and check files are kept whole: lines lost from the synced copy are put back from the copy kept on the
// PC, before the file is read or written again; a line that cannot be kept here is not shared; one that cannot be shared is
// not kept.
import { describe, it, expect } from 'vitest';
import { appendOwn, healOwn, wholeLines } from '../../src/backend/ownFile';
import { nodeAi, type AiDocs } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import { Mem } from './reviewKit';

class Refusing extends Mem { refuse = false; append(n: string, t: string) { if (this.refuse) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); super.append(n, t); } }

describe('own files', () => {
  it('appends to the local copy first; a failed shared write takes the line back out; lost lines are put back once', () => {
    const shared = new Refusing(), local = new Refusing();
    appendOwn(shared, local, 'f', 'one\n'); appendOwn(shared, local, 'f', 'two\n');
    local.refuse = true; expect(() => appendOwn(shared, local, 'f', 'three\n')).toThrow(); expect(shared.files.get('f')).toBe('one\ntwo\n'); local.refuse = false;
    shared.refuse = true; expect(() => appendOwn(shared, local, 'f', 'four\n')).toThrow(); expect(local.files.get('f')).toBe('one\ntwo\n'); shared.refuse = false;
    shared.files.set('f', 'one\n');                                                     // the sync client put back an older copy
    healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n'); healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n');
  });

  it('with keep, a line the shared folder refuses stays in the local copy and is shared by the next heal', () => {
    const shared = new Refusing(), local = new Refusing();
    expect(appendOwn(shared, local, 'f', 'one\n', true)).toBeUndefined();
    shared.refuse = true; expect((appendOwn(shared, local, 'f', 'two\n', true) as { code?: string }).code).toBe('ENOSPC');
    expect(local.files.get('f')).toBe('one\ntwo\n'); expect(shared.files.get('f')).toBe('one\n');
    healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\n');            // still refused: tried again at the next look
    shared.refuse = false; healOwn(shared, local, 'f'); expect(shared.files.get('f')).toBe('one\ntwo\n');
    local.refuse = true; expect(() => appendOwn(shared, local, 'f', 'three\n', true)).toThrow(); expect(shared.files.get('f')).toBe('one\ntwo\n');
  });

  it('the check log: results lost from the synced copy are back when it is read again, and every PC reads them', async () => {
    const shared = new Mem(), local = new Mem(); const repo = memRepo();
    await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Proseware' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
    const svc = new StandInService((c) => JSON.stringify(c.prompt.includes('Check each of these') ? { items: [{ id: 'I1', result: 'more', need: 'the audit report' }] } : { core: [] }));
    const docs: AiDocs = { records: () => [{ docId: 'doc_1', hash: 'h', name: 'A.pdf', folder: 'vdr', rel: 'A.pdf', size: 1, pages: 1 }], wanted: async () => [{ docId: 'doc_1', name: 'A.pdf', read: async () => new TextEncoder().encode('A') }] } as any;
    const make = (installId: string, loc?: Mem) => nodeAi({ service: svc, docs, keeper: new StoreKeeper(svc, new Mem(), { recheckMs: 0 }), repo, shared, local: loc, installId, checklist: () => ({ broad: [{ id: 'b1', text: 'The model is audited' }], product: [], sector: [] }) });
    const office = make('office', local);
    expect((await office.firstPass('d1')).ok).toBe(true); expect((await office.gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);
    shared.files.set('checks-office-d1.jsonl', '');                                     // the sync client lost every line
    expect((await make('home').gaps('d1') as any).value).toEqual([]);                  // a PC reading now sees nothing yet
    expect((await office.gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);   // the office reads its file again: put back
    expect((await make('home').gaps('d1') as any).value).toEqual([{ title: 'The model is audited' }]);
  });

  it('counts a line once across a file, a conflict copy of it and a read again, and keeps only the key it is given for each', () => {
    const once = new Set<string>(); const long = (n: number) => `{"v":1,"n":${n},"text":"${'x'.repeat(500)}"}`; const key = (l: string) => `k${l.length}:${l.slice(0, 12)}`;
    const read = (text: string) => wholeLines(text, 0, once, key);
    expect(read(`${long(1)}\n${long(2)}\n`)).toEqual([long(1), long(2)]);
    expect(read(`${long(1)}\n${long(2)}\n${long(3)}\n`)).toEqual([long(3)]);   // the whole file read again: only the new line
    expect(read(`${long(2)}\n${long(4)}\n${long(5)}`)).toEqual([long(4)]);      // a conflict copy; a last line with no end is not there yet
    expect([...once]).toEqual([1, 2, 3, 4].map((n) => key(long(n))));         // the keys, not the lines, which could hold the whole text
  });
});
