// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { LogRepository, COPIED, type Folder } from '../../src/backend/logRepository';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, EditDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import type { Repository } from '../../src/ports';

/** A folder in memory. Each PC has its own copy of the shared folder; `carry` is the sync client. */
class Mem implements Folder {
  files = new Map<string, string>(); refuse = 0; reads: string[] = [];
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { this.reads.push(n); return this.files.get(n) ?? null; }
  append(n: string, t: string) { if (this.refuse && !--this.refuse) { const e: any = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
/** Sync: every file ends up, on both sides, as the longer of its two copies. `upTo` cuts what is delivered short, as a sync caught part-way would. */
function carry(a: Mem, b: Mem, upTo?: (text: string) => string) {
  for (const [from, to] of [[a, b], [b, a]] as const) for (const [n, t] of from.files) { const have = to.files.get(n) ?? ''; if (t.length > have.length) to.files.set(n, upTo ? upTo(t) : t); }
}
let clockN = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, 0, clockN++)).toISOString();
function pc(label: string, user: string, shared = new Mem(), local = new Mem(), segmentBytes?: number) {
  let n = 0; const repo = new LogRepository({ shared, local, label, user: () => user, clock, segmentBytes, newId: () => `${label.replace(/\W/g, '').toLowerCase()}${n++ || ''}` });
  return { repo, shared, local };
}
const file = (id: string, deal: string, n = 1) => `changes-${id}-${deal}-${String(n).padStart(4, '0')}.jsonl`;
/** the id of the latest version of a record in a folder's change files (a version's id carries a random part) */
const verOf = (m: Mem, id: string): string => [...m.files.values()].join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).flatMap((l) => l.recs).filter((r: any) => r.id === id).at(-1).ver;
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const text = async (r: Repository, id: string) => (val(await r.get('question', id))?.envelope.data as any)?.text ?? null;

describe('change files between two PCs', () => {
  const q = (id: string, t: string, dealId = 'd1') => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  async function two() {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }, { ...q('q2', 'two'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }, { kind: 'question', id: 'q2' }] } }));
    carry(A.shared, B.shared); val(await B.repo.sync());
    return { A, B };
  }

  it('what one PC writes the other reads, and is told about', async () => {
    const { A, B } = await two();
    expect(await text(B.repo, 'q1')).toBe('one'); expect(val(await B.repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1', 'q2']);
    const seen: string[] = []; const off = A.repo.watch((c) => seen.push(`${c.kind}/${c.id}`), 1e9);
    val(await B.repo.transaction({ writes: [{ ...q('q2', 'two, edited at home'), expectedRev: 1 }] }));
    carry(A.shared, B.shared); const s = val(await A.repo.sync()); off();
    expect(await text(A.repo, 'q2')).toBe('two, edited at home'); expect(seen).toContain('question/q2'); expect(seen).toContain('sync/');
    expect(s.self.label).toBe('PC A'); expect(s.peers.map((p) => [p.label, p.by])).toEqual([['PC B', 'sroe']]); expect(s.clashes).toEqual([]);
    const stale = await A.repo.transaction({ writes: [{ ...q('q2', 'office, not knowing'), expectedRev: 1 }] });       // the office window still held the old version
    expect(!stale.ok && stale.error.kind).toBe('conflict'); expect(!stale.ok && stale.error.message).not.toContain('q2');   // said on screen as it is: no record id
  });

  it('the same record changed on both before either saw the other: both versions kept, the rest untouched, a person’s choice settles it', async () => {
    const { A, B } = await two();
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: 1 }, { ...q('q3', 'three, new at home'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q3' }] } }));
    carry(A.shared, B.shared); const sa = val(await A.repo.sync()), sb = val(await B.repo.sync());
    const a1 = val(await A.repo.get('question', 'q1'))!, b1 = val(await B.repo.get('question', 'q1'))!;
    expect(a1.conflict!.map((v) => [(v.data as any).text, v.from, v.by, !!v.here])).toEqual([['office edit', 'PC A', 'adoe', true], ['home edit', 'PC B', 'sroe', false]]);
    expect(b1.conflict!.map((v) => (v.data as any).text)).toEqual(['office edit', 'home edit']); expect((b1.envelope.data as any).text).toBe('office edit');   // every PC shows the same one first
    expect(sa.clashes).toEqual([{ dealId: 'd1', kind: 'question', id: 'q1' }]); expect(sb.clashes).toEqual(sa.clashes);
    expect(await text(A.repo, 'q3')).toBe('three, new at home'); expect(val(await A.repo.get('question', 'q2'))!.conflict).toBeUndefined();
    const plain = await A.repo.transaction({ writes: [{ ...q('q1', 'typed over it'), expectedRev: a1.rev }] }); expect(!plain.ok && plain.error.kind).toBe('rejected'); expect(!plain.ok && plain.error.message).not.toContain('q1');
    const other = await A.repo.transaction({ writes: [{ ...q('q2', 'two, office'), expectedRev: 1 }] }); expect(other.ok).toBe(true);          // the clash is on q1 only
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: b1.rev, resolves: b1.conflict!.map((v) => v.id) }] }));
    carry(A.shared, B.shared); const after = val(await A.repo.sync());
    expect(after.clashes).toEqual([]); expect(val(await A.repo.get('question', 'q1'))!.conflict).toBeUndefined(); expect(await text(A.repo, 'q1')).toBe('home edit');
  });

  it('both make the same change: one version, no clash', async () => {
    const { A, B } = await two();
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'agreed wording'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'agreed wording'), expectedRev: 1 }] }));
    carry(A.shared, B.shared); const s = val(await A.repo.sync());
    expect(s.clashes).toEqual([]); const g = val(await A.repo.get('question', 'q1'))!; expect(g.conflict).toBeUndefined(); expect(g.rev).toBe(3);          // the number counts both versions taken in
  });

  for (const who of ['the first', 'the second'] as const) it(`both make the same change, then ${who} changes it again: still one version on both PCs, no clash`, async () => {
    const { A, B } = await two();
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'agreed wording'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'agreed wording'), expectedRev: 1 }] }));
    carry(A.shared, B.shared); val(await A.repo.sync()); val(await B.repo.sync());
    const P = who === 'the first' ? A : B; const cur = val(await P.repo.get('question', 'q1'))!;
    val(await P.repo.transaction({ writes: [{ ...q('q1', 'changed once more'), expectedRev: cur.rev }] }));
    carry(A.shared, B.shared); const sa = val(await A.repo.sync()), sb = val(await B.repo.sync());
    expect(sa.clashes).toEqual([]); expect(sb.clashes).toEqual([]);
    for (const R of [A, B]) { const g = val(await R.repo.get('question', 'q1'))!; expect(g.conflict).toBeUndefined(); expect((g.envelope.data as any).text).toBe('changed once more'); }
  });

  it('undoing a choice puts the versions back, on every PC', async () => {
    const { A, B } = await two();
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: 1 }] }));
    carry(A.shared, B.shared); val(await A.repo.sync());
    const c = val(await A.repo.get('question', 'q1'))!; const chosen = val(await A.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: c.rev, resolves: c.conflict!.map((v) => v.id) }] }));
    const back = val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: chosen.q1 }], reopen: [{ kind: 'question', id: 'q1', versions: c.conflict! }] }));
    expect(back.q1).toBeGreaterThan(chosen.q1);
    carry(A.shared, B.shared); val(await B.repo.sync());
    for (const r of [A.repo, B.repo]) expect(val(await r.get('question', 'q1'))!.conflict!.map((v) => v.id)).toEqual(c.conflict!.map((v) => v.id));
  });

  it('undoing a choice that the other PC had already edited on top of leaves three versions to choose from, and holds nothing back', async () => {
    const { A, B } = await two();
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: 1 }] }));
    carry(A.shared, B.shared); val(await A.repo.sync()); val(await B.repo.sync());
    const c = val(await A.repo.get('question', 'q1'))!; const chosen = val(await A.repo.transaction({ writes: [{ ...q('q1', 'home edit'), expectedRev: c.rev, resolves: c.conflict!.map((v) => v.id) }] }));
    carry(A.shared, B.shared); val(await B.repo.sync());
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit, refined'), expectedRev: val(await B.repo.get('question', 'q1'))!.rev }] }));
    // the office takes its choice back before the home edit arrives
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: chosen.q1 }], reopen: [{ kind: 'question', id: 'q1', versions: c.conflict! }] }));
    carry(A.shared, B.shared);
    for (const R of [A, B]) {
      const s = val(await R.repo.sync()); expect(s.waiting).toEqual([]); expect(s.clashes).toEqual([{ dealId: 'd1', kind: 'question', id: 'q1' }]);
      expect(val(await R.repo.get('question', 'q1'))!.conflict!.map((v) => (v.data as any).text)).toEqual(['office edit', 'home edit', 'home edit, refined']);
    }
    const b = val(await B.repo.get('question', 'q1'))!;
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'home edit, refined'), expectedRev: b.rev, resolves: b.conflict!.map((v) => v.id) }] }));
    carry(A.shared, B.shared); expect(val(await A.repo.sync()).clashes).toEqual([]); expect(await text(A.repo, 'q1')).toBe('home edit, refined');
  });

  it('a line caught part-way through arriving is not there yet, and nothing breaks when the rest arrives', async () => {
    const { A, B } = await two();
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'edited at home'), expectedRev: 1 }] }));
    carry(A.shared, B.shared, (t) => t.slice(0, t.length - 25)); val(await A.repo.sync());
    expect(await text(A.repo, 'q1')).toBe('one');
    carry(A.shared, B.shared); val(await A.repo.sync());
    expect(await text(A.repo, 'q1')).toBe('edited at home');
  });

  it('a change that depends on one that has not arrived is held back, says what it waits for, and stops nothing meanwhile', async () => {
    const { A, B } = await two(); const C = pc('HC-LT-0412', 'pdoe');
    val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'q9', data: { id: 'q9', dealId: 'd2', text: 'another deal' }, expectedRev: null }], index: { dealId: 'd2', add: [{ kind: 'question', id: 'q9' }] } }));
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'edited at home'), expectedRev: 1 }] }));
    for (const from of [A.shared, B.shared]) for (const [n, t] of from.files) C.shared.files.set(n, t);                 // the laptop has everything; nothing flows back yet
    val(await C.repo.sync());
    val(await C.repo.transaction({ writes: [{ ...q('q1', 'edited again on the laptop'), expectedRev: 2 }] }));
    // the laptop's change reaches the office before the home change it was based on
    for (const [n, t] of C.shared.files) if (n.includes(C.repo.id)) A.shared.files.set(n, t);
    const s = val(await A.repo.sync());
    expect(s.waiting).toEqual([{ pc: B.repo.id, label: null, from: ['HC-LT-0412'], changes: 1, since: expect.any(String), deals: ['d1'] }]);   // nothing of the PC B's has arrived here, so it has no name yet
    expect(await text(A.repo, 'q1')).toBe('one');                                                                         // the version this PC has, as if the laptop's change had not arrived
    expect((await A.repo.transaction({ writes: [{ ...q('q2', 'two, office'), expectedRev: 1 }] })).ok).toBe(true);        // the same deal takes changes as usual
    expect(val(await A.repo.sync()).waiting[0].since).toBe(s.waiting[0].since);                                            // the wait is timed from when it began
    carry(A.shared, B.shared); const now = val(await A.repo.sync());
    expect(now.waiting).toEqual([]); expect(await text(A.repo, 'q1')).toBe('edited again on the laptop'); expect(now.clashes).toEqual([]);
  });

  it('a second copy of a change file, as a sync conflict leaves behind, is read and combined, never ignored', async () => {
    const { A, B } = await two();
    val(await B.repo.transaction({ writes: [{ ...q('q2', 'two, edited at home'), expectedRev: 1 }] }));
    const name = file(B.repo.id, 'd1'); A.shared.files.set(name.replace('.jsonl', '-PC-B.jsonl'), B.shared.files.get(name)!);      // only the duplicate reaches the office
    val(await A.repo.sync()); expect(await text(A.repo, 'q2')).toBe('two, edited at home');
    carry(A.shared, B.shared); const s = val(await A.repo.sync());                                                                             // then the original as well: nothing counted twice
    expect(s.clashes).toEqual([]); expect(val(await A.repo.get('question', 'q2'))!.rev).toBe(2); expect(s.peers.length).toBe(1);
  });
});

describe('change files on one PC', () => {
  it('a record deleted and restored carries on numbering its revisions: a save based on a copy read before the delete is refused', async () => {
    const { repo } = pc('Office', 'adoe');
    val(await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'one' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const before = val(await repo.get('question', 'q1'))!.rev; expect(before).toBe(1);
    val(await repo.transaction({ writes: [], deletes: [{ kind: 'question', id: 'q1', expectedRev: before }] }));
    val(await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'one' }, expectedRev: null }] }));
    expect(val(await repo.get('question', 'q1'))!.rev).toBe(3);
    const stale = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'from the old copy' }, expectedRev: before }] });
    expect(!stale.ok && stale.error.kind).toBe('conflict'); expect(await text(repo, 'q1')).toBe('one');
  });
  it('starting again finds everything, and carries on numbering its own lines', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'one' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    val(await a.repo.transaction({ writes: [{ kind: 'op', id: 'op1', data: { state: 'pending' }, expectedRev: null }] }));
    const b = pc('Office', 'adoe', shared, local);
    expect(b.repo.id).toBe(a.repo.id); expect(await text(b.repo, 'q1')).toBe('one'); expect(val(await b.repo.get('op', 'op1'))!.rev).toBe(1);
    val(await b.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'one, edited' }, expectedRev: 1 }] }));
    const lines = shared.files.get(file(a.repo.id, 'd1'))!.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2]); expect(lines.every((l) => l.recs.every((r: any) => r.kind !== 'op'))).toBe(true);        // the undo journal never leaves the PC
    expect([...shared.files.keys()]).toEqual([file(a.repo.id, 'd1')]);
  });

  it('lines lost from the synced copy of its own file are put back from the copy kept on the PC', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    for (const t of ['one', 'two', 'three']) val(await a.repo.transaction({ writes: [{ kind: 'question', id: t, data: { dealId: 'd1', text: t }, expectedRev: null }] }));
    const name = file(a.repo.id, 'd1'); shared.files.set(name, shared.files.get(name)!.split('\n').slice(0, 1).join('\n') + '\n');       // the folder was rolled back to an earlier state
    const b = pc('Office', 'adoe', shared, local);
    expect(await text(b.repo, 'three')).toBe('three'); expect(shared.files.get(name)!.trim().split('\n').length).toBe(3);
  });

  it('lines lost from the synced copy while the app runs are put back at the next look, and before the next write, so the other PCs get every line', async () => {
    const A = pc('Office', 'adoe'), B = pc('Home', 'sroe');
    for (const t of ['one', 'two']) val(await A.repo.transaction({ writes: [{ kind: 'question', id: t, data: { dealId: 'd1', text: t }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: t }] } }));
    const name = file(A.repo.id, 'd1'); const roll = () => A.shared.files.set(name, A.shared.files.get(name)!.split('\n').slice(0, 1).join('\n') + '\n');
    roll(); val(await A.repo.sync!());                                                         // the sync client put back an older copy; the next look heals it
    carry(A.shared, B.shared); val(await B.repo.sync!()); expect(await text(B.repo, 'two')).toBe('two');
    // rolled back again, and a write comes before any look: the lost line goes back first, then the new one
    roll(); val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'three', data: { dealId: 'd1', text: 'three' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'three' }] } }));
    const C = pc('Laptop', 'kroe'); carry(A.shared, C.shared); val(await C.repo.sync!());
    expect(val(await C.repo.list('question', 'd1')).map((x) => x.id).sort()).toEqual(['one', 'three', 'two']);
    expect(A.shared.files.get(name)!.trim().split('\n').length).toBe(3);                       // each line once
  });

  it('a newly connected shared folder gets nothing this PC wrote in the last one, and Undo there cannot write it either; going back carries on as before', async () => {
    const A = new Mem(), B = new Mem(), local = new Mem(); let n = 0;
    const open = (shared: Mem, place: string) =>
      new LogRepository({ shared, local, label: 'Office', user: () => 'adoe', clock, newId: () => `pc${n++}`, place });
    const a = open(A, '/onedrive/team-a');
    val(await a.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'Q1' }, expectedRev: null }, { kind: 'op', id: 'op1', data: { label: 'Add Q1' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const b = open(B, '/onedrive/personal');                                                          // Settings > Change
    expect(b.id).not.toBe(a.id); expect([...B.files.keys()]).toEqual([]); expect(await text(b, 'q1')).toBe(null);
    expect(val(await b.list('op'))).toEqual([]); expect(local.files.get(`ops-${a.id}.json`)).toContain('op1');   // the undo journal is kept aside, not dropped
    val(await b.transaction({ writes: [{ kind: 'question', id: 'q2', data: { dealId: 'd2', text: 'Q2' }, expectedRev: null }] }));
    expect(open(B, '/onedrive/personal').id).toBe(b.id);                                              // started again on the same folder: the same install
    expect([...B.files.keys()].every((f) => f.startsWith(`changes-${b.id}-`))).toBe(true);
    const back = open(A, '/onedrive/team-a');                                                         // changed back: under the id it had there, with its Undo
    expect(back.id).toBe(a.id); expect(await text(back, 'q1')).toBe('Q1'); expect(await text(back, 'q2')).toBe(null);
    expect(val(await back.list('op')).map((o) => o.id)).toEqual(['op1']);
    val(await back.transaction({ writes: [{ kind: 'question', id: 'q3', data: { dealId: 'd1', text: 'Q3' }, expectedRev: null }] }));
    const s = val(await back.sync!()); expect(s.self.note).toBeUndefined(); expect(s.peers).toEqual([]);   // not taken for a copied install, nor for another PC
    const name = file(a.id, 'd1'); A.files.set(name, '');                                             // and its files there are still healed (a OneDrive rollback)
    expect(await text(open(A, '/onedrive/team-a'), 'q1')).toBe('Q1'); expect(A.files.get(name)).toContain('"Q1"');
    expect(open(B, '/onedrive/personal').id).toBe(b.id); expect([...B.files.keys()].every((f) => f.startsWith(`changes-${b.id}-`))).toBe(true);
  });

  it('a start on another folder that cannot save install.json moves nothing: going back finds its Undo', async () => {
    const A = new Mem(), B = new Mem(), local = new Mem(); let n = 0;
    const open = (shared: Mem, place: string) =>
      new LogRepository({ shared, local, label: 'Office', user: () => 'adoe', clock, newId: () => `pc${n++}`, place });
    const a = open(A, '/onedrive/team-a');
    val(await a.transaction({ writes: [{ kind: 'op', id: 'op1', data: { label: 'Add Q1' }, expectedRev: null }] }));
    const write = local.write.bind(local);
    local.write = (name, text) => { if (name === 'install.json') throw new Error('ENOSPC: no space left on device'); write(name, text); };
    expect(() => open(B, '/onedrive/personal')).toThrow(/ENOSPC/);
    local.write = write;
    const back = open(A, '/onedrive/team-a');
    expect(back.id).toBe(a.id); expect(val(await back.list('op')).map((o) => o.id)).toEqual(['op1']);
  });

  describe('a damaged install.json', () => {
    const add = (id: string, op: string) => ({ writes: [{ kind: 'question' as const, id, data: { dealId: 'd1', text: id }, expectedRev: null }, { kind: 'op' as const, id: op, data: { label: `Add ${id}`, state: 'pending' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question' as const, id }] } });
    const setup = () => {
      const A = new Mem(), B = new Mem(), local = new Mem(); let n = 0;
      const open = (shared: Mem, place: string, l = local, machine = 'M1') =>
        new LogRepository({
          shared,
          local: l,
          label: 'Office',
          user: () => 'adoe',
          clock,
          newId: () => `pc${++n}`,
          machine: () => machine,
          place,
        });
      return { A, B, local, open };
    };
    const ops = async (r: Repository) => val(await r.list('op')).map((o) => o.id).sort();
    const aside = (local: Mem) => [...local.files].filter(([k]) => k.startsWith('install.damaged-'));
    const clone = (m: Mem) => { const c = new Mem(); for (const [k, v] of m.files) c.files.set(k, v); return c; };
    /** both what the PC keeps about itself and its spare copy, damaged the same way */
    const damage = (local: Mem, how: (t: string) => string) => { for (const f of ['install.json', 'install.spare.json']) local.files.set(f, how(local.files.get(f)!)); };

    it('cut off part way: the PC keeps its id and its Undo, and a copy of the file as it was is kept aside, once', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team'); val(await a.transaction(add('q1', 'op1')));
      const cut = local.files.get('install.json')!.slice(0, 30); local.files.set('install.json', cut);
      const b = open(A, '/onedrive/team');
      expect(b.id).toBe(a.id); expect(await ops(b)).toEqual(['op1']);
      expect(aside(local)).toHaveLength(1); expect(aside(local)[0][0]).toMatch(/^install\.damaged-[0-9TZ-]+\.json$/); expect(aside(local)[0][1]).toBe(cut);
      expect(JSON.parse(local.files.get('install.json')!)).toMatchObject({ id: a.id, place: '/onedrive/team', machine: 'M1' });
      expect(local.files.get('install.spare.json')).toBe(local.files.get('install.json'));
      expect(open(A, '/onedrive/team').id).toBe(a.id); expect(aside(local)).toHaveLength(1);           // written whole again: nothing more is kept aside
    });

    it('both copies empty or written over: the id is found from this PC’s own change files in that folder, never another folder’s', async () => {
      const { A, B, local, open } = setup(); const a = open(A, '/onedrive/team'); val(await a.transaction(add('q1', 'op1')));
      const b = open(B, '/onedrive/personal'); val(await b.transaction(add('q2', 'op2')));
      damage(local, (t) => '\0'.repeat(40) + t.slice(40));
      const c = open(A, '/onedrive/team');
      expect(c.id).toBe(a.id); expect(await ops(c)).toEqual(['op1']); expect(await text(c, 'q1')).toBe('q1');
      damage(local, () => '');
      const d = open(B, '/onedrive/personal'); expect(d.id).toBe(b.id); expect(await ops(d)).toEqual(['op2']);
      // a folder this PC has written nothing in yet is a new install there, as before: the others' ids and Undo stay theirs
      damage(local, () => '{"id":');
      const e = open(new Mem(), '/onedrive/new'); expect([a.id, b.id]).not.toContain(e.id); expect(await ops(e)).toEqual([]);
      expect(open(A, '/onedrive/team').id).toBe(a.id); expect(open(B, '/onedrive/personal').id).toBe(b.id);
    });

    /** every change file in the shared folder lost, and both install files emptied (#29) */
    const loseAll = (shared: Mem, local: Mem) => { shared.files.clear(); damage(local, () => ''); };
    const lineCount = (shared: Mem, id: string) => shared.files.get(file(id, 'd1'))!.trim().split('\n').length;

    it('every shared file and both install files lost: this PC’s id, lines and Undo come back (#29)', async () => {
      const { A, local, open } = setup();
      const a = open(A, '/onedrive/team');
      for (let i = 1; i <= 300; i++) val(await a.transaction(add(`q${i}`, `op${i}`)));
      await a.close();
      loseAll(A, local);
      const b = open(A, '/onedrive/team');
      await b.ready();
      expect(b.id).toBe(a.id);
      expect(await text(b, 'q1')).toBe('q1');
      expect(await text(b, 'q300')).toBe('q300');
      expect(lineCount(A, a.id)).toBe(300);
      expect(await ops(b)).toHaveLength(300);
      val(await b.transaction(add('q301', 'op301')));
      await b.close();
      const c = open(A, '/onedrive/team');
      await c.ready();
      expect(c.id).toBe(a.id);
      // a second start adds nothing twice
      expect(lineCount(A, a.id)).toBe(301);
    });

    it('every shared file lost: a copy on another machine takes a new id, and both keep their work (#29)', async () => {
      const { A, local, open } = setup();
      const a = open(A, '/onedrive/team');
      val(await a.transaction(add('q1', 'op1')));
      await a.close();
      loseAll(A, local);
      const copy = clone(local);
      const B2 = new Mem();
      const b = open(A, '/onedrive/team');
      const c = open(B2, '/onedrive/team', copy, 'M2');
      await b.ready();
      await c.ready();
      expect(b.id).toBe(a.id);
      expect(c.id).not.toBe(a.id);
      val(await b.transaction(add('qb', 'opb')));
      val(await c.transaction(add('qc', 'opc')));
      carry(A, B2);
      for (const r of [b, c]) expect(val(await r.sync()).self.note).toBeUndefined();
      for (const r of [b, c]) for (const q of ['q1', 'qb', 'qc']) expect(await text(r, q)).toBe(q);
    });

    it('every shared file lost: a copy on this machine, opened after the lines are back, is found (#29)', async () => {
      const { A, local, open } = setup();
      const a = open(A, '/onedrive/team');
      val(await a.transaction(add('q1', 'op1')));
      await a.close();
      loseAll(A, local);
      const copy = clone(local);
      const b = open(A, '/onedrive/team');
      await b.ready();
      expect(b.id).toBe(a.id);
      const c = open(A, '/onedrive/team', copy);
      await c.ready();
      val(await b.transaction(add('qb', 'opb')));
      const refused = await c.transaction(add('qc', 'opc'));
      expect(!refused.ok && refused.error.message).toBe(COPIED);
      val(await b.transaction(add('qd', 'opd')));
      expect(await text(b, 'qd')).toBe('qd');
    });

    it('recovers carried Undo before the replacement id writes a change (#750)', async () => {
      const { A, B, local, open } = setup();
      const place = '/shared/team';
      const original = open(A, place);
      val(await original.transaction(add('q1', 'op1')));
      const copy = open(A, place, clone(local));
      val(await copy.transaction(add('q2', 'op2')));
      expect(val(await original.sync()).self.note).toBe(COPIED);
      await original.close();
      await copy.close();

      const moved = open(A, place);
      expect(moved.id).not.toBe(original.id);
      expect(await ops(moved)).toEqual(['op1']);
      expect(local.files.has(file(moved.id, 'd1'))).toBe(false);
      await moved.close();
      loseAll(A, local);

      const otherPlace = open(B, '/shared/other', clone(local));
      const otherMachine = open(A, place, clone(local), 'M2');
      for (const other of [otherPlace, otherMachine]) {
        expect(other.id).not.toBe(moved.id);
        expect(await ops(other)).toEqual([]);
        await other.close();
      }

      const again = open(A, place);
      expect(await ops(again)).toEqual(['op1']);
      expect(again.id).toBe(moved.id);
      await again.close();
    });

    const holdUnusedMarker = (local: Mem) => {
      local.files.set('place-unused.json', JSON.stringify({ place: '/shared/other', machine: 'M1' }));
      const read = local.read.bind(local);
      local.read = (name) => {
        if (name === 'place-unused.json') throw new Error('EBUSY: resource busy');
        return read(name);
      };
    };

    it.each([
      { reason: 'the original writes only to its journal', journalOnly: true, carried: ['pending'] },
      { reason: 'marking the old id as left is refused', heldRetirement: true, carried: ['op1', 'pending'] },
      { reason: 'an unrelated marker without a journal is held', unusedMarker: true, carried: ['op1'] },
    ])('recovers carried Undo when $reason (#750)', async ({ journalOnly, heldRetirement, unusedMarker, carried }) => {
      const { A, local, open } = setup();
      const place = '/shared/team';
      const pending = {
        kind: 'op' as const,
        id: 'pending',
        data: { label: 'Update the credit agreement response', state: 'pending' },
        expectedRev: null,
      };
      const original = open(A, place);
      val(await original.transaction(journalOnly ? { writes: [pending] } : add('q1', 'op1')));
      const copy = open(A, place, clone(local));
      val(await copy.transaction(add('q2', 'op2')));
      const write = local.write.bind(local);
      if (heldRetirement) local.write = (name, value) => {
        if (name === `place-${original.id}.json`) throw new Error('EBUSY: resource busy');
        write(name, value);
      };
      expect(val(await original.sync()).self.note).toBe(COPIED);
      await original.close();
      const moved = open(A, place);
      if (heldRetirement) val(await moved.transaction({ writes: [pending] }));
      expect(await ops(moved)).toEqual(carried);
      await moved.close();
      local.write = write;
      loseAll(A, local);

      if (unusedMarker) holdUnusedMarker(local);
      const again = open(A, place);
      expect({ id: again.id, ops: await ops(again) }).toEqual({ id: moved.id, ops: carried });
      await again.close();
      await copy.close();
    });

    it('recovers the connected folder while an unrelated journal marker is held (#750)', async () => {
      const { A, B, local, open } = setup();
      const archive = open(B, '/shared/archive');
      val(await archive.transaction(add('archiveQuestion', 'archiveOp')));
      await archive.close();
      const team = open(A, '/shared/team');
      val(await team.transaction(add('teamQuestion', 'teamOp')));
      await team.close();
      loseAll(A, local);

      const read = local.read.bind(local);
      local.read = (name) => {
        if (name === `place-${archive.id}.json`) throw new Error('EBUSY: resource busy');
        return read(name);
      };
      const recovered = open(A, '/shared/team');
      expect(recovered.id).toBe(team.id);
      expect(await ops(recovered)).toEqual(['teamOp']);
      expect(await text(recovered, 'teamQuestion')).toBe('teamQuestion');
      await recovered.close();
    });

    it.each([
      { timing: 'before a change', afterFirstWrite: false, entries: ['op1'] },
      { timing: 'after a change', afterFirstWrite: true, entries: ['op1', 'op3'] },
    ])('recovers carried Undo $timing with a held folder marker (#750)', async ({ afterFirstWrite, entries }) => {
      const { A, local, open } = setup();
      const place = '/shared/team';
      const original = open(A, place);
      val(await original.transaction(add('q1', 'op1')));
      const copy = open(A, place, clone(local));
      val(await copy.transaction(add('q2', 'op2')));
      expect(val(await original.sync()).self.note).toBe(COPIED);
      await original.close();
      await copy.close();

      const write = local.write.bind(local);
      local.write = (name, value) => {
        if (name.startsWith('place-') && name !== `place-${original.id}.json`) throw new Error('EBUSY');
        write(name, value);
      };
      const moved = open(A, place);
      expect(await ops(moved)).toEqual(['op1']);
      expect(local.files.has(`place-${moved.id}.json`)).toBe(false);
      if (afterFirstWrite) val(await moved.transaction(add('q3', 'op3')));
      await moved.close();
      local.write = write;
      loseAll(A, local);

      const recovered = open(A, place);
      expect(recovered.id).toBe(moved.id);
      expect(await ops(recovered)).toEqual(entries);
      if (afterFirstWrite) expect(await text(recovered, 'q3')).toBe('q3');
      await recovered.close();
    });

    it('settles a recovered journal from its predecessor receipt before offering Retry (#750)', async () => {
      const { A, local, open } = setup();
      const place = '/shared/team';
      const original = open(A, place);
      const saved = add('q1', 'op1');
      const [question, pending] = saved.writes;
      val(await original.transaction({ writes: [pending] }));
      const append = local.append.bind(local);
      const write = local.write.bind(local);
      const oldJournal = `ops-${original.id}.json`;
      let held = false;
      local.append = (name, value) => {
        append(name, value);
        held = true;
      };
      local.write = (name, value) => {
        if (held && name === oldJournal) throw new Error('EBUSY');
        write(name, value);
      };
      const receipt = { ...pending, data: { label: 'Add question', state: 'succeeded' }, expectedRev: 1 };
      val(await original.transaction({ ...saved, writes: [question, receipt] }));
      expect(local.files.get(oldJournal)).toContain('"state":"pending"');
      local.append = append;
      const copy = open(A, place, clone(local));
      val(await copy.transaction(add('q2', 'op2')));
      expect(val(await original.sync()).self.note).toBe(COPIED);
      await original.close();
      await copy.close();
      local.write = write;

      const read = local.read.bind(local);
      local.read = (name) => {
        if (name.startsWith('ops-') && name !== oldJournal && local.files.has(name)) throw new Error('EBUSY');
        return read(name);
      };
      const moved = open(A, place);
      expect(local.files.get(`ops-${moved.id}.json`)).toContain('"state":"pending"');
      await moved.close();
      local.read = read;
      damage(local, () => '');

      const recovered = open(A, place);
      expect(recovered.id).toBe(moved.id);
      expect(await text(recovered, 'q1')).toBe('q1');
      expect(val(await recovered.get('op', 'op1'))?.envelope.data).toMatchObject({ state: 'succeeded' });
      await recovered.close();
    });

    for (const busy of [false, true]) it(`every shared file lost: an id left after a copy was found is not taken back${
      busy ? ', though its folder record was held when the copy was found' : ''} (#29)`, async () => {
      const { A, local, open } = setup();
      const a = open(A, '/onedrive/team');
      val(await a.transaction(add('q1', 'op1')));
      const other = open(A, '/onedrive/team', clone(local));
      val(await other.transaction(add('qo', 'opo')));
      const write = local.write.bind(local);
      const held = (n: string) => busy && n.startsWith('place-');
      local.write = (n, t) => { if (held(n)) throw new Error('EBUSY: resource busy'); write(n, t); };
      expect(val(await a.sync()).self.note).toBe(COPIED);
      local.write = write;
      await a.close();
      const moved = open(A, '/onedrive/team');
      expect(moved.id).not.toBe(a.id);
      await moved.close();
      loseAll(A, local);
      const again = open(A, '/onedrive/team');
      expect(again.id).not.toBe(a.id);
      val(await again.transaction(add('qt', 'opt')));
      for (const r of [other, again]) expect(val(await r.sync()).self.note).toBeUndefined();
      for (const q of ['q1', 'qo', 'qt']) expect(await text(other, q)).toBe(q);
    });

    it('every shared file lost: an id recorded for another folder is never taken here (#29)', async () => {
      const { A, B, local, open } = setup();
      const b = open(B, '/onedrive/personal');
      val(await b.transaction(add('q2', 'op2')));
      await b.close();
      loseAll(B, local);
      expect(open(A, '/onedrive/team').id).not.toBe(b.id);
      expect(A.files.get(file(b.id, 'd1'))).toBeUndefined();
    });

    it('a local folder copied to another PC never takes the first PC’s id, even with install.json lost or damaged', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team'); val(await a.transaction(add('q1', 'op1')));
      const gone = clone(local); gone.files.delete('install.json');                                   // its spare still names the machine
      expect(open(A, '/onedrive/team', gone, 'M2').id).not.toBe(a.id);
      const cut = clone(local); damage(cut, (t) => t.slice(0, t.indexOf('"place"') + 5));             // the machine is still whole
      expect(open(A, '/onedrive/team', cut, 'M2').id).not.toBe(a.id);
      const lost = clone(local); damage(lost, () => '');                                              // nothing left: the first PC writing on gives it away
      val(await a.transaction(add('q2', 'op2')));
      expect(open(A, '/onedrive/team', lost, 'M2').id).not.toBe(a.id);
    });

    it('a shared folder copied to a new one: each folder gets back its own id and Undo', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/old'); val(await a.transaction(add('q1', 'op1')));
      const B = clone(A); const b = open(B, '/onedrive/new'); val(await b.transaction(add('q2', 'op2')));
      val(await open(A, '/onedrive/old').transaction(add('q3', 'op3')));                               // back in the old one, later
      damage(local, () => '');
      const b2 = open(B, '/onedrive/new'); expect(b2.id).toBe(b.id); expect(await ops(b2)).toEqual(['op2']);
      const a2 = open(A, '/onedrive/old'); expect(a2.id).toBe(a.id); expect(await ops(a2)).toEqual(['op1', 'op3']);
    });

    it('a folder copied while this PC went on in the old one is never given the old one’s id once both files are lost', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/old'); val(await a.transaction(add('q1', 'op1')));
      const B = clone(A); val(await a.transaction(add('q3', 'op3'))); val(await a.transaction(add('q4', 'op4')));
      damage(local, () => '');
      const b = open(B, '/onedrive/new'); expect(b.id).not.toBe(a.id);
      expect(open(A, '/onedrive/old').id).toBe(a.id);
    });

    it('a copy of a folder opened after both files are lost is a new install: neither folder gets the other’s Undo or changes', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/old'); val(await a.transaction(add('q1', 'op1')));
      const B = clone(A); damage(local, () => '');
      const b = open(B, '/onedrive/new'); expect(b.id).not.toBe(a.id); expect(await ops(b)).toEqual([]);
      val(await b.transaction(add('qB', 'opB')));
      const back = open(A, '/onedrive/old'); expect(back.id).toBe(a.id); expect(await ops(back)).toEqual(['op1']);
      expect(await text(back, 'qB')).toBe(null); expect([...A.files.values()].join('')).not.toContain('"qB"');
    });

    it('this PC’s own file rolled back in the shared folder (a sync client) does not hide its id once both files are lost', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team'); for (const q of ['q1', 'q2', 'q3']) val(await a.transaction(add(q, `op${q}`)));
      const name = file(a.id, 'd1'); A.files.set(name, `${A.files.get(name)!.split('\n')[0]}\n`); damage(local, () => '');
      const b = open(A, '/onedrive/team'); expect(b.id).toBe(a.id); expect(await ops(b)).toEqual(['opq1', 'opq2', 'opq3']);
      expect(A.files.get(name)!.trim().split('\n')).toHaveLength(3);                                   // and the lines are put back
    });

    it('install.json found empty at the very first start, with nothing kept here yet, is a new install, not a lost one', () => {
      const { A, local, open } = setup(); local.files.set('install.json', '');
      open(A, '/onedrive/team'); expect(JSON.parse(local.files.get('install.json')!).lost).toBeUndefined();
    });

    it('a torn write left in the shared folder, or a save cut off before it got there, does not hide the PC’s own id', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team'); val(await a.transaction(add('q1', 'op1')));
      const name = file(a.id, 'd1'); A.files.set(name, `${A.files.get(name)!}{"v":1,"pc":"torn\n`);
      local.files.set(name, `${local.files.get(name)!}${local.files.get(name)!.split('\n')[0].replace('"seq":1', '"seq":9')}\n`);   // and one line here only
      damage(local, () => '');
      expect(open(A, '/onedrive/team').id).toBe(a.id);
    });

    it('a new install is not taken for a lost one, and with neither file whole the ids of one are never mixed with the other’s folder', async () => {
      const { A, B, local, open } = setup(); open(A, '/onedrive/a');
      expect(JSON.parse(local.files.get('install.json')!).lost).toBeUndefined();
      const b = open(B, '/onedrive/b'); local.files.set('install.spare.json', '{"id":"pc1","machine":"M1","place":"/onedrive/a"');   // a write behind, and cut off
      local.files.set('install.json', local.files.get('install.json')!.slice(0, local.files.get('install.json')!.indexOf('"place"')));
      expect(open(A, '/onedrive/a').id).not.toBe(b.id);
    });

    it('a file that will not open, or a copy that cannot be kept aside, fails the start, writes nothing and keeps one copy', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team'); val(await a.transaction(add('q1', 'op1')));
      const read = local.read.bind(local), write = local.write.bind(local); let busy = ['install.json', 'install.spare.json'];
      local.read = (n) => { if (busy.includes(n)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return read(n); };
      expect(() => open(A, '/onedrive/team')).toThrow(/EBUSY/);
      busy = ['install.json']; expect(open(A, '/onedrive/team').id).toBe(a.id); local.read = read;         // the spare is whole
      damage(local, () => '{"id":"');
      let refuse = true; local.write = (n, t) => { if (refuse && n.startsWith('install')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); write(n, t); };
      expect(() => open(A, '/onedrive/team')).toThrow(/ENOSPC/); expect(local.files.get('install.json')).toBe('{"id":"'); expect(aside(local)).toHaveLength(0);
      refuse = false; const list = A.list.bind(A); A.list = () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
      for (let i = 0; i < 3; i++) expect(() => open(A, '/onedrive/team')).toThrow(/ENOENT/);
      expect(aside(local)).toHaveLength(1); expect(local.files.get('install.json')).toBe('{"id":"'); A.list = list;
      const b = open(A, '/onedrive/team'); expect(b.id).toBe(a.id); expect(await ops(b)).toEqual(['op1']);
    });

    it('a damaged spare that cannot be kept aside on a full disk does not stop a start whose install.json is whole', async () => {
      const { A, local, open } = setup(); const a = open(A, '/onedrive/team');
      local.files.set('install.spare.json', '{"id":'); const write = local.write.bind(local);
      local.write = (n, t) => { if (n.startsWith('install')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); write(n, t); };
      expect(open(A, '/onedrive/team').id).toBe(a.id); local.write = write;
      expect(open(A, '/onedrive/team').id).toBe(a.id); expect(local.files.get('install.spare.json')).toBe(local.files.get('install.json'));
      expect([...local.files].filter(([k]) => k.startsWith('install.spare.damaged-')).map(([, t]) => t)).toEqual(['{"id":']);
    });

    it('what is whole in a damaged file is read, a folder name with braces included', async () => {
      const { A, B, local, open } = setup(); const PA = 'C:\\Users\\x\\OneDrive - Contoso {EU}\\Punchlist';
      const a = open(A, PA); val(await a.transaction(add('q1', 'op1'))); const b = open(B, '/onedrive/personal');
      damage(local, (t) => `${t}\0`);
      expect(open(B, '/onedrive/personal').id).toBe(b.id); expect(Object.keys(JSON.parse(local.files.get('install.json')!).ids).sort()).toEqual(['/onedrive/personal', PA]);
    });

    it('a first start in a folder, with install.json whole, reads none of the change files there', () => {
      const { A, local, open } = setup(); open(new Mem(), '/onedrive/team');
      for (let p = 0; p < 50; p++) for (let d = 0; d < 100; d++) A.files.set(file(`peer${p}`, `d${d}`), '');
      A.reads = []; const size = A.size.bind(A); let sizes = 0; A.size = (x) => { sizes++; return size(x); };
      open(A, '/onedrive/other'); expect(A.reads.filter((x) => x.startsWith('changes-'))).toEqual([]); expect(sizes).toBeLessThan(10); void local;
    });
  });

  it('a change of folder moves no Undo journal, so a journal write that fails meanwhile loses nothing', async () => {
    const A = new Mem(), B = new Mem(), local = new Mem(); let n = 0;
    const open = (shared: Mem, place: string) =>
      new LogRepository({ shared, local, label: 'Office', user: () => 'adoe', clock, newId: () => `pc${n++}`, place });
    const a = open(A, '/onedrive/team-a');
    val(await a.transaction({ writes: [{ kind: 'op', id: 'op1', data: { label: 'Add Q1' }, expectedRev: null }] }));
    const write = local.write.bind(local);
    local.write = (name, text) => { if (name.startsWith('ops')) { const e: any = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } write(name, text); };
    const b = open(B, '/onedrive/personal');
    expect(val(await b.list('op'))).toEqual([]);                                                  // A's Undo is never offered on B
    local.write = write;
    const back = open(A, '/onedrive/team-a');
    expect(back.id).toBe(a.id); expect(val(await back.list('op')).map((o) => o.id)).toEqual(['op1']);
    expect([...local.files.keys()].filter((f) => f.startsWith('ops')).sort()).toEqual([`ops-${a.id}.json`]);
  });

  it('close waits for a change already started, so a backend opened next on the same files reads it, and refuses any later one', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    const started = a.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'Q1' }, expectedRev: null }] });
    await a.repo.close(); expect(shared.files.get(file(a.repo.id, 'd1'))).toContain('"Q1"'); val(await started);
    const late = await a.repo.transaction({ writes: [{ kind: 'question', id: 'q2', data: { dealId: 'd1', text: 'Q2' }, expectedRev: null }] });
    expect(late.ok).toBe(false); expect(shared.files.get(file(a.repo.id, 'd1'))).not.toContain('"Q2"');   // a check finishing after the close writes nothing
    expect(await text(pc('Office', 'adoe', shared, local).repo, 'q1')).toBe('Q1');
  });

  it('an install from before the shared folder was kept takes the folder it starts on as its own, with the same id', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'Q1' }, expectedRev: null }] }));
    const name = file(a.repo.id, 'd1'); shared.files.set(name, '');                                    // and the folder lost its lines
    const b = new LogRepository({
      shared,
      local,
      label: 'Office',
      user: () => 'adoe',
      clock,
      newId: () => 'unused',
      place: '/onedrive/team',
    });
    expect(b.id).toBe(a.repo.id); expect(await text(b, 'q1')).toBe('Q1'); expect(JSON.parse(local.files.get('install.json')!).place).toBe('/onedrive/team');
  });

  it('a line this PC cannot keep is not shared; a line that cannot be shared is not kept, so it never comes back later as a change the person was told had failed', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'one', data: { dealId: 'd1', text: 'one' }, expectedRev: null }] }));
    const name = file(a.repo.id, 'd1');
    local.refuse = 1; const noLocal = await a.repo.transaction({ writes: [{ kind: 'question', id: 'two', data: { dealId: 'd1', text: 'two' }, expectedRev: null }] });
    expect(noLocal.ok).toBe(false); expect(shared.files.get(name)).not.toContain('"two"');
    shared.refuse = 1; const noShared = await a.repo.transaction({ writes: [{ kind: 'question', id: 'three', data: { dealId: 'd1', text: 'three' }, expectedRev: null }] });
    expect(!noShared.ok && noShared.error.kind).toBe('storageFull'); expect(local.files.get(name)).not.toContain('"three"');
    val(await a.repo.sync!()); expect(shared.files.get(name)).not.toContain('"three"');
    const b = pc('Office', 'adoe', shared, local);
    expect(await text(b.repo, 'three')).toBe(null);
    expect(await text(b.repo, 'one')).toBe('one');
  });

  it('a folder copied to another PC is a new install: at start by the machine, and while running by a line it never wrote; nothing is lost and nothing is written under a shared name', async () => {
    // kroe's laptop starts with a copy of ldoe's local folder (a copied profile): the machine differs, so it takes an
    // id of its own
    const sharedLroe = new Mem(), localLroe = new Mem();
    const lroe = new LogRepository({ shared: sharedLroe, local: localLroe, label: 'Desktop', user: () => 'ldoe', clock, newId: () => 'pclroe', machine: () => 'MACHINE-1|S-1-5-21-1' });
    val(await lroe.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'Q1' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const localKroe = new Mem(); for (const [n, t] of localLroe.files) localKroe.files.set(n, t);
    const sharedKroe = new Mem(); carry(sharedLroe, sharedKroe);
    const kroe = new LogRepository({ shared: sharedKroe, local: localKroe, label: 'Laptop', user: () => 'kroe', clock, newId: () => 'pckroe', machine: () => 'MACHINE-2|S-1-5-21-2' });
    expect(kroe.id).toBe('pckroe'); expect(await text(kroe, 'q1')).toBe('Q1');
    val(await kroe.transaction({ writes: [{ kind: 'question', id: 'q3', data: { dealId: 'd1', text: 'Q3' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q3' }] } }));
    val(await lroe.transaction({ writes: [{ kind: 'question', id: 'q2', data: { dealId: 'd1', text: 'Q2' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } }));
    carry(sharedLroe, sharedKroe); val(await lroe.sync!()); val(await kroe.sync!());
    for (const r of [lroe, kroe]) expect(val(await r.list('question', 'd1')).map((x) => x.id).sort()).toEqual(['q1', 'q2', 'q3']);   // both see all three: nothing dropped

    // with no machine to go by (a copy made before the machine was kept), the first line it did not write gives it away
    const sharedA = new Mem(), localA = new Mem(); const a = pc('Desktop', 'ldoe', sharedA, localA);
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'qa', data: { dealId: 'd1', text: 'A' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qa' }] } }));
    const localB = new Mem(); for (const [n, t] of localA.files) localB.files.set(n, t); const sharedB = new Mem(); carry(sharedA, sharedB);
    const b = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'fresh',
    });
    expect(b.id).toBe(a.repo.id);                                                                  // it cannot tell yet
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'qb', data: { dealId: 'd1', text: 'B' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qb' }] } }));
    carry(sharedA, sharedB); await b.ready();
    const s1 = val(await b.sync!()); expect(s1.self.note).toBe(COPIED);                            // a line under its id that it never wrote
    const refused = await b.transaction({ writes: [{ kind: 'question', id: 'qc', data: { dealId: 'd1', text: 'C' }, expectedRev: null }] });
    expect(!refused.ok && refused.error.message).toBe(COPIED);                                    // nothing more is written under the shared name
    expect(await text(b, 'qb')).toBe('B');                                                         // and what the other wrote is read
    const again = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'unused',
    });
    expect(again.id).toBe('fresh'); expect(val(await again.sync!()).self.note).toBeUndefined();   // started again under a name of its own
    val(await again.transaction({ writes: [{ kind: 'question', id: 'qc', data: { dealId: 'd1', text: 'C' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qc' }] } }));
  });

  it('a copy that takes an id of its own keeps its Undo journal, whether the machine gives it away at start or a line does while running', async () => {
    const op = (id: string) => ({ writes: [{ kind: 'op' as const, id, data: { label: id }, expectedRev: null }] });
    const place = '/onedrive/team';
    // at start: a local folder copied to another PC (kroe's laptop takes over ldoe's profile)
    const sharedLroe = new Mem(), localLroe = new Mem();
    const lroe = new LogRepository({ shared: sharedLroe, local: localLroe, label: 'Desktop', user: () => 'ldoe', clock, newId: () => 'pclroe', machine: () => 'MACHINE-1', place });
    val(await lroe.transaction(op('lroeOp')));
    // an action whose line was written but whose entry was not yet marked done (the app closed between the two)
    val(await lroe.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'Q1' }, expectedRev: null }, { kind: 'op', id: 'lroeDone', data: { label: 'Add Q1', state: 'pending' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const localKroe = new Mem(); for (const [n, t] of localLroe.files) localKroe.files.set(n, t);
    const sharedKroe = new Mem(); carry(sharedLroe, sharedKroe);
    const kroe = new LogRepository({ shared: sharedKroe, local: localKroe, label: 'Laptop', user: () => 'kroe', clock, newId: () => 'pckroe', machine: () => 'MACHINE-2', place });
    expect(kroe.id).toBe('pckroe'); expect(val(await kroe.list('op')).map((o) => o.id).sort()).toEqual(['lroeDone', 'lroeOp']);
    // its line is in the folder under the last id, so it is settled, not offered for a Retry that would do it twice
    await new Promise((r) => setTimeout(r, 0));
    expect((val(await kroe.get('op', 'lroeDone'))!.envelope.data as { state: string }).state).toBe('succeeded');
    val(await kroe.transaction(op('kimOp')));
    expect(val(await new LogRepository({ shared: sharedKroe, local: localKroe, label: 'Laptop', user: () => 'kroe', clock, newId: () => 'unused', machine: () => 'MACHINE-2', place }).list('op')).map((o) => o.id).sort()).toEqual(['kimOp', 'lroeDone', 'lroeOp']);
    // while running: the same machine (a disk image), found out by the original's next line; the copy then restarts
    const sharedA = new Mem(), localA = new Mem();
    const a = new LogRepository({
      shared: sharedA,
      local: localA,
      label: 'Desktop',
      user: () => 'ldoe',
      clock,
      newId: () => 'pca',
      machine: () => 'M',
      place,
    });
    val(await a.transaction({ writes: [{ kind: 'question', id: 'qa', data: { dealId: 'd1', text: 'A' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qa' }] } }));
    const localB = new Mem(); for (const [n, t] of localA.files) localB.files.set(n, t); const sharedB = new Mem(); carry(sharedA, sharedB);
    const b = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'fresh',
      machine: () => 'M',
      place,
    });
    val(await b.transaction(op('copyOp')));                                                            // its own Undo, before it is found out
    val(await a.transaction({ writes: [{ kind: 'question', id: 'qb', data: { dealId: 'd1', text: 'B' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qb' }] } }));
    carry(sharedA, sharedB); await b.ready(); expect(val(await b.sync!()).self.note).toBe(COPIED);
    val(await b.transaction(op('afterOp')));                                                           // the journal is still written while it runs
    const again = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'unused',
      machine: () => 'M',
      place,
    });
    expect(again.id).toBe('fresh'); expect(val(await again.list('op')).map((o) => o.id).sort()).toEqual(['afterOp', 'copyOp']);
  });

  it('a new id in a folder takes its Undo journal over at its first start there, whenever that is: after a change of folder, and after the PC is copied again', async () => {
    const op = (id: string) => ({ writes: [{ kind: 'op' as const, id, data: { label: id }, expectedRev: null }] });
    const A = '/onedrive/a', B = '/onedrive/b'; let n = 0;
    const open = (shared: Mem, local: Mem, place: string, machine = 'M') =>
      new LogRepository({
        shared,
        local,
        label: 'Laptop',
        user: () => 'kroe',
        clock,
        newId: () => `p${n++}`,
        machine: () => machine,
        place,
      });
    const ops = async (r: LogRepository) => val(await r.list('op')).map((o) => o.id).sort();
    // found to be a copy while running on A; the person changes to B and back before restarting
    const sharedA = new Mem(), sharedB = new Mem(), local = new Mem();
    const orig = open(sharedA, new Mem(), A); val(await orig.transaction({ writes: [{ kind: 'question', id: 'qa', data: { dealId: 'd1', text: 'A' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qa' }] } }));
    for (const [k, t] of (orig as any).o.local.files) local.files.set(k, t);
    const copy = open(sharedA, local, A); expect(copy.id).toBe(orig.id); val(await copy.transaction(op('copyOp')));
    val(await orig.transaction({ writes: [{ kind: 'question', id: 'qb', data: { dealId: 'd1', text: 'B' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qb' }] } }));
    await copy.ready(); expect(val(await copy.sync!()).self.note).toBe(COPIED); val(await copy.transaction(op('afterOp')));
    const onB = open(sharedB, local, B); val(await onB.transaction(op('bOp')));
    const back = open(sharedA, local, A); expect(back.id).not.toBe(orig.id); expect(await ops(back)).toEqual(['afterOp', 'copyOp']);
    // the same, but the local folder is copied to another PC before it goes back to A: A's last id never got a journal
    const local2 = new Mem(); for (const [k, t] of (orig as any).o.local.files) local2.files.set(k, t);
    const copy2 = open(sharedA, local2, A); val(await copy2.transaction(op('copy2Op')));
    val(await orig.transaction({ writes: [{ kind: 'question', id: 'qc', data: { dealId: 'd1', text: 'C' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'qc' }] } }));
    await copy2.ready(); expect(val(await copy2.sync!()).self.note).toBe(COPIED);
    open(sharedB, local2, B);
    const elsewhere = new Mem(); for (const [k, t] of local2.files) elsewhere.files.set(k, t);
    expect(await ops(open(sharedA, elsewhere, A, 'M2'))).toEqual(['copy2Op']);
    // moved to another PC while on A, it keeps B's journal as well as A's
    const moved = new Mem(); for (const [k, t] of local.files) moved.files.set(k, t);
    expect(await ops(open(sharedA, moved, A, 'M3'))).toEqual(['afterOp', 'copyOp']); expect(await ops(open(sharedB, moved, B, 'M3'))).toEqual(['bOp']);
  });

  it('a journal that will not open for a moment at start: an action saved before is settled once it opens, not offered for a Retry that makes it twice', async () => {
    const opts = { latency: [0, 0] as [number, number] }; let n = 0;
    const store = (repo: Repository) => new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}` } }, [CreateDeal]);
    const shared = new Mem(), local = new Mem(); const place = '/onedrive/team'; const busy = { write: false, reads: 0 };
    const write = local.write.bind(local), read = local.read.bind(local);
    local.write = (name, t) => { if (busy.write && name.startsWith('ops-')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); write(name, t); };
    local.read = (name) => { if (name.startsWith('ops-') && busy.reads > 0) { busy.reads--; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } return read(name); };
    const open = () =>
      new LogRepository({
        shared,
        local,
        label: 'Desktop',
        user: () => 'ldoe',
        clock,
        newId: () => 'pc1',
        machine: () => 'M1',
        place,
      });
    // the deal's line is written, but its journal entry cannot be settled before the app closes
    const r1 = open(); const first = store(r1); await first.boot();
    const append = local.append.bind(local); local.append = (name, t) => { append(name, t); if (name.startsWith('changes-')) busy.write = true; };
    await first.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); busy.write = false; local.append = append;
    // the next start finds the journal held for a moment: its first read is refused
    busy.reads = 1; const b = store(open()); await b.boot();
    expect(b.interruptedOps()).toEqual([]); expect(Object.values(b.get().deals).map((d) => d.name)).toEqual(['Project Proseware']);
    // held for longer: start-up waits, and goes on by itself once the journal opens
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      busy.reads = 1e9; const c = store(open()); await c.boot(); expect(c.get().boot.stage).toBe('journal'); expect(c.get().boot.error).toBeTruthy();
      busy.reads = 0; await vi.advanceTimersByTimeAsync(10_000);
      expect(c.get().boot.stage).toBe('ready'); expect(c.interruptedOps()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('a copy taken mid-save on a PC still in use, which then finishes the save: the copy does not offer it for a Retry that would make it twice', async () => {
    const opts = { latency: [0, 0] as [number, number] }; let n = 0;
    const store = (repo: Repository) => new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}` } }, [CreateDeal]);
    const place = '/onedrive/team'; const sharedLroe = new Mem(), localLroe = new Mem();
    // ldoe's local folder is copied to kroe's laptop as a deal is being made: its journal entry is pending, its line
    // not yet written
    let copy: Mem | null = null; const append = localLroe.append.bind(localLroe);
    localLroe.append = (name, t) => { if (!copy && name.startsWith('changes-')) { copy = new Mem(); for (const [k, v] of localLroe.files) copy.files.set(k, v); } append(name, t); };
    const lroe = store(new LogRepository({ shared: sharedLroe, local: localLroe, label: 'Desktop', user: () => 'ldoe', clock, newId: () => 'pclroe', machine: () => 'M1', place }));
    await lroe.boot(); expect((await lroe.dispatch(CreateDeal, { name: 'Proseware', folders: [] })).ok).toBe(true);
    const sharedKroe = new Mem(); carry(sharedLroe, sharedKroe);
    const kroe = store(new LogRepository({ shared: sharedKroe, local: copy!, label: 'Laptop', user: () => 'kroe', clock, newId: () => 'pckroe', machine: () => 'M2', place }));
    await kroe.boot();
    expect(kroe.interruptedOps()).toEqual([]); expect(Object.values(kroe.get().deals).map((d) => d.name)).toEqual(['Project Proseware']);
  });

  it('a line a copy wrote under this PC’s id is found at start-up, before its deal is read in the background', async () => {
    const q = (id: string, t: string) => ({ kind: 'question' as const, id, data: { id, dealId: 'd1', text: t } });
    const sharedA = new Mem(), localA = new Mem(); const a = pc('Desktop', 'ldoe', sharedA, localA);
    val(await a.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const localB = new Mem(); for (const [n, t] of localA.files) localB.files.set(n, t); const sharedB = new Mem(); carry(sharedA, sharedB);
    const b = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'fresh',
    });
    val(await b.transaction({ writes: [{ ...q('q2', 'on the copy'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } }));
    carry(sharedA, sharedB);
    const restarted = new LogRepository({
      shared: sharedA,
      local: localA,
      label: 'Desktop',
      user: () => 'ldoe',
      clock,
      newId: () => 'unused',
    });
    expect(val(await restarted.sync()).self.note).toBe(COPIED);                                    // at once, not once d1's turn comes
    const refused = await restarted.transaction({ writes: [{ kind: 'deal', id: 'd2', data: { id: 'd2' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd2' }] } });
    expect(!refused.ok && refused.error.message).toBe(COPIED);
  });

  it('a copy and its original that both change a record before either is found out leave two versions, read the same way on every PC', async () => {
    const q = (id: string, t: string) => ({ kind: 'question' as const, id, data: { id, dealId: 'd1', text: t } });
    // a copy made before the machine was kept: the copy and the original write their next line under the same id and number
    const sharedA = new Mem(), localA = new Mem(); const a = pc('Desktop', 'ldoe', sharedA, localA);
    val(await a.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const localB = new Mem(); for (const [n, t] of localA.files) localB.files.set(n, t); const sharedB = new Mem(); carry(sharedA, sharedB);
    const b = new LogRepository({
      shared: sharedB,
      local: localB,
      label: 'Laptop',
      user: () => 'kroe',
      clock,
      newId: () => 'fresh',
    });
    await b.ready();
    val(await a.repo.transaction({ writes: [{ ...q('q1', 'on the original'), expectedRev: 1 }] }));
    val(await b.transaction({ writes: [{ ...q('q1', 'on the copy'), expectedRev: 1 }] }));
    // the sync client keeps the file changed in two places as two files; a third PC may come across either first
    const name = file(a.repo.id, 'd1'); const copyName = name.replace('.jsonl', '-Laptop.jsonl');
    for (const copyFirst of [false, true]) {
      const t = pc('Tablet' + Number(copyFirst), 'pdoe');
      const files: [string, string][] = [[name, sharedA.files.get(name)!], [copyName, sharedB.files.get(name)!]];
      for (const [n, x] of copyFirst ? files.reverse() : files) t.shared.files.set(n, x);
      val(await t.repo.sync());
      expect(val(await t.repo.get('question', 'q1'))!.conflict!.map((v) => (v.data as any).text).sort()).toEqual(['on the copy', 'on the original']);
    }
    // the original, finding a line under its name that it never wrote, shows the copy's version beside its own
    sharedA.files.set(copyName, sharedB.files.get(name)!); const s = val(await a.repo.sync());
    expect(s.self.note).toBe(COPIED); expect(val(await a.repo.get('question', 'q1'))!.conflict!.map((v) => (v.data as any).text).sort()).toEqual(['on the copy', 'on the original']);
  });

  it('works on a real folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-'));
    const open = () =>
      new LogRepository({
        shared: nodeFolder(path.join(dir, 'shared')),
        local: nodeFolder(path.join(dir, 'local')),
        label: 'Office',
        user: () => 'adoe',
        clock,
      });
    const a = open(); val(await a.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1', text: 'on disk' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    val(await a.transaction({ writes: [{ kind: 'op', id: 'op1', data: {}, expectedRev: null }] }));
    const b = open(); expect(await text(b, 'q1')).toBe('on disk'); expect(val(await b.list('question', 'd1')).length).toBe(1); expect(val(await b.get('op', 'op1'))!.rev).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'shared'))).toEqual([file(a.id, 'd1')]);
    expect(fs.readdirSync(path.join(dir, 'local')).sort()).toEqual([
      file(a.id, 'd1'), 'install.json', 'install.spare.json', 'ops.json', `pending-changes-${a.id}.json`,
    ]);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'local', 'ops.json'), 'utf8')))).toEqual(['dil/1/op/op1']);   // the journal's one format: each entry under dil/1/op/<id>
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('change files split by deal and by size', () => {
  const q = (id: string, t: string, dealId: string) => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  const add = async (r: Repository, id: string, t: string, dealId: string) => val(await r.transaction({ writes: [{ ...q(id, t, dealId), expectedRev: null }], index: { dealId, add: [{ kind: 'question', id }] } }));
  const edit = async (r: Repository, id: string, t: string, dealId: string, rev: number) => val(await r.transaction({ writes: [{ ...q(id, t, dealId), expectedRev: rev }] }));

  it('each deal has its own files, and the deals themselves are kept apart from both', async () => {
    const a = pc('Office', 'adoe');
    val(await a.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Proseware' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } }));
    val(await a.repo.transaction({ writes: [{ kind: 'deal', id: 'd2', data: { id: 'd2', name: 'Wingtip' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd2' }] } }));
    await add(a.repo, 'q1', 'one', 'd1'); await add(a.repo, 'q2', 'two', 'd2'); await edit(a.repo, 'q1', 'one, edited', 'd1', 1);
    val(await a.repo.transaction({ deletes: [{ kind: 'question', id: 'q2', expectedRev: 1 }], writes: [] }));                              // a delete is filed with the deal the record belonged to
    expect([...a.shared.files.keys()].sort()).toEqual([file(a.repo.id, '_'), file(a.repo.id, 'd1'), file(a.repo.id, 'd2')].sort());
    const count = (n: string) => a.shared.files.get(n)!.trim().split('\n').length;
    expect([count(file(a.repo.id, '_')), count(file(a.repo.id, 'd1')), count(file(a.repo.id, 'd2'))]).toEqual([2, 2, 2]);
    expect([...a.local.files.keys()].filter((n) => n.startsWith('changes-')).sort()).toEqual([...a.shared.files.keys()].sort());           // and a copy of each is kept on the PC
  });

  it('a file that is full is never touched again; the next one is started, in the middle of a session and after a restart', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local, 700);
    for (let i = 1; i <= 6; i++) await add(a.repo, `q${i}`, `Question ${i}: café, naïve, “quoted” — and long enough to fill a file quickly.`, 'd1');
    const names = () => [...shared.files.keys()].sort(); const before = names(); expect(before.length).toBeGreaterThan(1);
    expect(before).toEqual(before.map((_, i) => file(a.repo.id, 'd1', i + 1)));
    for (const n of before) expect(shared.size(n)).toBeLessThanOrEqual(700);                                                               // measured in bytes, not characters
    const frozen = new Map(before.slice(0, -1).map((n) => [n, shared.files.get(n)!]));
    // the app is closed and opened again
    const b = pc('Office', 'adoe', shared, local, 700);
    for (let i = 7; i <= 12; i++) await add(b.repo, `q${i}`, `Question ${i}: café, naïve, “quoted” — and long enough to fill a file quickly.`, 'd1');
    const after = names(); expect(after.length).toBeGreaterThan(before.length); expect(after).toEqual(after.map((_, i) => file(a.repo.id, 'd1', i + 1)));
    for (const [n, t] of frozen) expect(shared.files.get(n)).toBe(t);
    const seqs = after.flatMap((n) => shared.files.get(n)!.trim().split('\n').map((l) => JSON.parse(l).seq)); expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const other = pc('Home', 'sroe', new Mem()); carry(shared, other.shared); val(await other.repo.sync());
    expect(val(await other.repo.list('question', 'd1')).map((x) => x.id)).toEqual(Array.from({ length: 12 }, (_, i) => `q${i + 1}`));
  });

  it('one change bigger than the limit still goes in, in a file of its own', async () => {
    const a = pc('Office', 'adoe', new Mem(), new Mem(), 300);
    await add(a.repo, 'q1', 'short', 'd1'); await add(a.repo, 'q2', 'x'.repeat(2000), 'd1'); await add(a.repo, 'q3', 'short again', 'd1');
    expect([...a.shared.files.keys()].sort()).toEqual([1, 2, 3].map((n) => file(a.repo.id, 'd1', n)));
    expect(await text(a.repo, 'q2')).toBe('x'.repeat(2000));
  });

  it('a later file that arrives before an earlier one is held back until the earlier one arrives; nothing else waits', async () => {
    const A = pc('Office', 'adoe', new Mem(), new Mem(), 1), B = pc('Home', 'sroe');                                                        // a limit of 1: every change in a file of its own
    await add(A.repo, 'q1', 'one', 'd1'); await edit(A.repo, 'q1', 'one, edited', 'd1', 1); await add(A.repo, 'q9', 'elsewhere', 'd2');
    const second = file(A.repo.id, 'd1', 2); B.shared.files.set(second, A.shared.files.get(second)!); B.shared.files.set(file(A.repo.id, 'd2'), A.shared.files.get(file(A.repo.id, 'd2'))!);
    const early = val(await B.repo.sync()); expect(early.waiting.map((w) => [w.label, w.changes])).toEqual([['Office', 1]]);
    expect(await text(B.repo, 'q1')).toBe(null);
    await edit(B.repo, 'q9', 'elsewhere, edited at home', 'd2', 1);
    carry(A.shared, B.shared); const now = val(await B.repo.sync()); expect(now.waiting).toEqual([]); expect(await text(B.repo, 'q1')).toBe('one, edited');
  });

  it('a file that has not grown is not opened again', async () => {
    const A = pc('Office', 'adoe'), B = pc('Home', 'sroe');
    await add(A.repo, 'q1', 'café — one', 'd1'); await add(A.repo, 'q2', 'naïve — two', 'd2');
    carry(A.shared, B.shared); val(await B.repo.sync()); B.shared.reads = [];
    val(await B.repo.sync()); expect(B.shared.reads).toEqual([]);
    await edit(A.repo, 'q2', 'two, edited', 'd2', 1); carry(A.shared, B.shared); val(await B.repo.sync());
    expect(B.shared.reads).toEqual([file(A.repo.id, 'd2')]); expect(await text(B.repo, 'q2')).toBe('two, edited');
    A.shared.reads = []; await edit(A.repo, 'q1', 'one, edited', 'd1', 1); val(await A.repo.sync()); expect(A.shared.reads).toEqual([]);   // nor is its own, after writing to it
  });
});

describe('start-up reads the deals first, and each deal’s files in the background', () => {
  const q = (id: string, t: string, dealId: string) => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  /** three deals written at the office, the last with a clash from home, all of it synced to a PC that has not started yet */
  async function before() {
    const A = pc('Office', 'adoe'), B = pc('Home', 'sroe');
    for (const d of ['d1', 'd2', 'd3']) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      val(await A.repo.transaction({ writes: [{ ...q(`q-${d}`, `question in ${d}`, d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] } }));
    }
    carry(A.shared, B.shared); val(await B.repo.sync());
    val(await A.repo.transaction({ writes: [{ ...q('q-d3', 'office wording', 'd3'), expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q-d3', 'home wording', 'd3'), expectedRev: 1 }] }));
    carry(A.shared, B.shared);
    const third = new Mem(); carry(A.shared, third); return { A, shared: third };
  }
  const parts = (m: Mem) => [...new Set(m.reads.map((n) => /-(d\d|_)-\d{4}\.jsonl$/.exec(n)?.[1]))].sort();

  it('start-up reads the deals first and each deal in the background; an opened deal jumps the queue, and nothing read is announced as news', async () => {
    const { shared } = await before();
    const c = pc('Laptop', 'adoe', shared);
    const seen: string[] = [];
    c.repo.watch((x) => seen.push(`${x.kind}/${x.id}`), 1e9);
    expect(parts(shared)).toEqual(['_']);                                                                        // only the deals, before the constructor returns
    expect(val(await c.repo.list('deal', '_')).map((x) => x.id)).toEqual(['d1', 'd2', 'd3']);
    expect(val(await c.repo.list('question', 'd2')).map((x) => (x.envelope.data as any).text)).toEqual(['question in d2']);
    expect(parts(shared)).toEqual(['_', 'd2']);                                                                  // the opened deal, ahead of the others
    await c.repo.ready(); expect(parts(shared)).toEqual(['_', 'd1', 'd2', 'd3']);                               // then the rest, without being asked
    expect(val(await c.repo.sync()).clashes).toEqual([{ dealId: 'd3', kind: 'question', id: 'q-d3' }]);
    expect(seen).toEqual(['sync/']);                                                                             // the clash once d3 was read; no record as news
    expect(await text(c.repo, 'q-d1')).toBe('question in d1');
  });

  it('a record asked for by id alone, before its deal has been read, is read in full', async () => {
    const { shared } = await before(); const c = pc('Laptop', 'adoe', shared);
    expect(await text(c.repo, 'q-d1')).toBe('question in d1');
    const d3 = val(await c.repo.get('question', 'q-d3')); expect(d3?.conflict?.length).toBe(2);                 // both versions, not part of its history
  });

  it('a write made right after a restart follows every line this copy has written, in every deal', async () => {
    const shared = new Mem(), local = new Mem(); const a = pc('Office', 'adoe', shared, local);
    for (const d of ['d1', 'd2']) val(await a.repo.transaction({ writes: [{ ...q(`q-${d}`, 'one', d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] } }));
    const b = pc('Office', 'adoe', shared, local);
    val(await b.repo.transaction({ writes: [{ kind: 'deal', id: 'd9', data: { id: 'd9' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd9' }] } }));
    const seqs = [...shared.files.values()].flatMap((t) => t.trim().split('\n').map((l) => JSON.parse(l).seq)).sort(); expect(seqs).toEqual([1, 2, 3]);
    const stale = await b.repo.transaction({ writes: [{ ...q('q-d2', 'two', 'd2'), expectedRev: null }] }); expect(!stale.ok && stale.error.kind).toBe('conflict');   // and is judged against all of it
  });

  it('an edit or delete made before its deal has been read is built on the latest version, not a needless choice', async () => {
    const { A, shared } = await before(); val(await A.repo.transaction({ writes: [{ ...q('q-d1', 'edited at the office', 'd1'), expectedRev: 1 }] })); carry(A.shared, shared);
    const c = pc('Laptop', 'adoe', shared);
    val(await c.repo.transaction({ writes: [{ ...q('q-d1', 'edited on the laptop', 'd1'), expectedRev: 2 }] }));       // d1 is read first, so rev 2 is known
    const now = val(await c.repo.get('question', 'q-d1'))!; expect(now.conflict).toBeUndefined(); expect((now.envelope.data as any).text).toBe('edited on the laptop');
    const c2 = pc('Desk', 'adoe', shared);
    val(await c2.repo.transaction({ deletes: [{ kind: 'question', id: 'q-d2', expectedRev: 1 }], writes: [] }));         // a delete names no deal: every deal is read
    expect(val(await c2.repo.get('question', 'q-d2'))).toBeNull();
  });

  it('a change that arrives after a deal is read is announced; one to a deal not read yet is taken in when it is', async () => {
    const { A, shared } = await before();
    const c = pc('Laptop', 'adoe', shared);
    const seen: string[] = [];
    c.repo.watch((x) => seen.push(`${x.kind}/${x.id}`), 1e9);
    val(await c.repo.list('question', 'd1'));
    val(await A.repo.transaction({ writes: [{ ...q('q-d1', 'edited at the office', 'd1'), expectedRev: 1 }] })); val(await A.repo.transaction({ writes: [{ ...q('q-d2', 'edited at the office', 'd2'), expectedRev: 1 }] }));
    carry(A.shared, shared); val(await c.repo.sync());
    expect(seen).toContain('question/q-d1'); expect(seen).not.toContain('question/q-d2');                        // nobody has read d2 yet
    expect(await text(c.repo, 'q-d1')).toBe('edited at the office'); expect(await text(c.repo, 'q-d2')).toBe('edited at the office');
    val(await A.repo.transaction({ writes: [{ ...q('q-d2', 'edited again', 'd2'), expectedRev: 2 }] }));
    await c.repo.ready(); carry(A.shared, shared); val(await c.repo.sync()); expect(seen).toContain('question/q-d2');
  });
});

describe('reading deals in the background: edge cases', () => {
  const q = (id: string, t: string, dealId: string) => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  const parts = (m: Mem) => [...new Set(m.reads.map((n) => /-(d\d|_)-\d{4}\.jsonl$/.exec(n)?.[1]))].sort();

  it('a deal’s edit held back on that deal’s own lines is announced once they are read, and is not shown as waiting meanwhile', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Original' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } }));
    val(await A.repo.transaction({ writes: [{ kind: 'item', id: 'i1', data: { id: 'i1', dealId: 'd1', off: false }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'item', id: 'i1' }] } }));
    val(await A.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Renamed' }, expectedRev: 1 }, { kind: 'item', id: 'i1', data: { id: 'i1', dealId: 'd1', off: true }, expectedRev: 1 }] }));
    const shared = new Mem();
    carry(A.shared, shared);
    const c = pc('Laptop', 'adoe', shared);
    const seen: string[] = [];
    c.repo.watch((x) => seen.push(`${x.kind}/${x.id}`), 1e9);
    expect(val(await c.repo.sync()).waiting).toEqual([]);                                              // not a wait: d1 is still to be read
    await c.repo.ready();
    expect(seen).toContain('deal/d1'); expect((val(await c.repo.get('deal', 'd1'))!.envelope.data as any).name).toBe('Renamed');
    expect(val(await c.repo.sync()).waiting).toEqual([]);
  });

  it('a deal edited right after start-up, while an earlier edit of it waits on its unread files, is built on that edit', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Original' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } }));
    val(await A.repo.transaction({ writes: [{ kind: 'item', id: 'i1', data: { id: 'i1', dealId: 'd1', off: false }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'item', id: 'i1' }] } }));
    val(await A.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Renamed' }, expectedRev: 1 }, { kind: 'item', id: 'i1', data: { id: 'i1', dealId: 'd1', off: true }, expectedRev: 1 }] }));
    const shared = new Mem(); carry(A.shared, shared); const c = pc('Laptop', 'adoe', shared);
    const stale = await c.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Laptop name' }, expectedRev: 1 }] });
    expect(!stale.ok && stale.error.kind).toBe('conflict');                                            // as on a PC that had read every deal
    val(await c.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Laptop name' }, expectedRev: 2 }] }));
    await c.repo.ready(); expect(val(await c.repo.get('deal', 'd1'))!.conflict).toBeUndefined();
  });

  it('this PC’s own files, under an id that ends in digits, are still read in the background', async () => {
    const shared = new Mem(); let n = 0; const ids = ['8c1f3b2a-1d4e-4f6a-9b7c-123456789012', 'other'];
    const a = new LogRepository({
      shared,
      local: new Mem(),
      label: 'Office',
      user: () => 'adoe',
      clock,
      newId: () => ids[n++],
    });
    val(await a.transaction({ writes: [{ ...q('q1', 'one', 'd1'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    const c = pc('Laptop', 'adoe', shared); expect(parts(shared)).toEqual([]);
    expect(val(await c.repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1']);
  });

  it('start-up with no firm checklist saved yet, and with members, still reads only the deals', async () => {
    const A = pc('Office', 'adoe');
    for (const d of ['d1', 'd2']) val(await A.repo.transaction({ writes: [{ ...q(`q-${d}`, 'one', d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] } }));
    const shared = new Mem(); carry(A.shared, shared); const c = pc('Laptop', 'adoe', shared);
    expect(val(await c.repo.get('firmList', 'firm'))).toBeNull(); expect(val(await c.repo.list('member', '_'))).toEqual([]); expect(val(await c.repo.get('member', 'm_x'))).toBeNull();
    expect(parts(shared).filter((p) => p !== '_')).toEqual([]);                                     // neither deal's files
  });

  it('a sync client’s copy of a deal’s file, with a name ending in digits, is read at start-up, not taken for a deal of its own', async () => {
    const A = pc('Office', 'adoe');
    val(
      await A.repo.transaction({
        writes: [{ ...q('q1', 'one', 'd1'), expectedRev: null }],
        index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] },
      }),
    );
    const shared = new Mem(); for (const [n, t] of A.shared.files) shared.files.set(n.replace('.jsonl', '-PC-0042.jsonl'), t);
    const c = pc('Laptop', 'adoe', shared);
    expect(val(await c.repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1']);
  });

  it('a deal whose folder cannot be listed just now is not taken as read: the read fails, and the next one finds it all', async () => {
    const A = pc('Office', 'adoe');
    val(
      await A.repo.transaction({
        writes: [{ ...q('q1', 'one', 'd1'), expectedRev: null }],
        index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] },
      }),
    );
    const shared = new Mem(); carry(A.shared, shared); const c = pc('Laptop', 'adoe', shared);
    const list = shared.list.bind(shared); let fails = 1; shared.list = () => { if (fails && fails--) throw new Error('EIO'); return list(); };
    const r = await c.repo.list('question', 'd1'); expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(val(await c.repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1']);
    await c.repo.close(); await c.repo.ready();                                                       // close ends the wait, too
  });
});

describe('a deal file that cannot be opened for a moment', () => {
  const q = (id: string, t: string, dealId: string) => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  /** three deals of three questions, the second's first question edited at the office, and a laptop whose `read` of d2's file throws while `stuck` */
  async function three() {
    const A = pc('Office', 'adoe');
    for (const d of ['d1', 'd2', 'd3']) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      const ids = [0, 1, 2].map((k) => `q-${d}-${k}`);
      val(await A.repo.transaction({ writes: ids.map((id) => ({ ...q(id, 'asked', d), expectedRev: null })), index: { dealId: d, add: ids.map((id) => ({ kind: 'question' as const, id })) } }));
    }
    val(await A.repo.transaction({ writes: [{ ...q('q-d2-0', 'edited at the office', 'd2'), expectedRev: 1 }] }));
    const shared = new Mem(); carry(A.shared, shared); const state = { stuck: 1 };
    const read = shared.read.bind(shared); shared.read = (n: string) => { if (state.stuck && /-d2-\d{4}\.jsonl$/.test(n)) { if (state.stuck !== Infinity) state.stuck--; throw new Error('EBUSY: resource busy or locked'); } return read(n); };
    let now = Date.UTC(2026, 10, 10, 9, 0, 0); const clock = () => new Date(now).toISOString();
    const c = new LogRepository({
      shared,
      local: new Mem(),
      label: 'Laptop',
      user: () => 'adoe',
      clock,
      newId: () => 'laptop',
    });
    return { c, state, later: (ms: number) => { now += ms; } };
  }

  it('a read of the deal fails (not as offline: the folder itself is fine), not as an empty or partial deal, and the next read has all of it', async () => {
    const { c } = await three();
    const r = await c.list('question', 'd2'); expect(!r.ok && r.error.kind).toBe('failed');
    expect(val(await c.list('question', 'd2'))).toHaveLength(3);
    expect(await text(c, 'q-d2-0')).toBe('edited at the office');
  });

  it('a change to the deal is refused rather than judged against part of it; the same change after is judged against all of it', async () => {
    const { c } = await three();
    const r = await c.transaction({ writes: [{ ...q('q-d2-0', 'typed on the laptop', 'd2'), expectedRev: null }] }); expect(!r.ok && r.error.kind).toBe('failed');
    const again = await c.transaction({ writes: [{ ...q('q-d2-0', 'typed on the laptop', 'd2'), expectedRev: null }] }); expect(!again.ok && again.error.kind).toBe('conflict');
    expect(val(await c.get('question', 'q-d2-0'))!.conflict).toBeUndefined();
  });

  it('the other deals are read in the background meanwhile; a deal whose file will not open is never shown without it, however long, and is read once it opens', async () => {
    const { c, state, later } = await three(); state.stuck = Infinity;
    await new Promise((r) => setTimeout(r, 20));
    expect(val(await c.list('question', 'd1'))).toHaveLength(3); expect(val(await c.list('question', 'd3'))).toHaveLength(3);
    expect((await c.list('question', 'd2')).ok).toBe(false);
    later(24 * 60 * 60_000); val(await c.sync());
    const r = await c.list('question', 'd2'); expect(!r.ok && r.error.kind).toBe('failed');
    const w = await c.transaction({ writes: [{ ...q('q-d2-9', 'typed on the laptop', 'd2'), expectedRev: null }], index: { dealId: 'd2', add: [{ kind: 'question', id: 'q-d2-9' }] } }); expect(!w.ok && w.error.kind).toBe('failed');
    state.stuck = 0; val(await c.sync()); await c.ready();
    expect(val(await c.list('question', 'd2'))).toHaveLength(3); expect(await text(c, 'q-d2-0')).toBe('edited at the office');
  });
});

describe('one file that will not open holds up only what depends on it', () => {
  const q = (id: string, t: string, dealId: string) => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  /** a laptop whose shared folder throws on reading the files whose names match `locked` while `on.stuck` */
  function lockedPc(shared: Mem, locked: RegExp, label = 'Laptop', clockFn: () => string = clock) {
    const on = { stuck: true }; const read = shared.read.bind(shared);
    shared.read = (n: string) => { if (on.stuck && locked.test(n)) throw new Error('EBUSY: resource busy or locked'); return read(n); };
    return {
      repo: new LogRepository({
        shared,
        local: new Mem(),
        label,
        user: () => 'adoe',
        clock: clockFn,
        newId: () => label.toLowerCase(),
      }),
      on,
    };
  }

  it('a change held for another PC is reported, and let go after a day, while an unrelated deal’s file is locked', async () => {
    const A = pc('Office', 'adoe'), H = pc('Home', 'sroe');
    for (const d of ['d1', 'd2']) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      val(await A.repo.transaction({ writes: [{ ...q(`q-${d}`, 'asked', d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] } }));
    }
    carry(A.shared, H.shared); val(await H.repo.sync());
    val(await H.repo.transaction({ writes: [{ ...q('q-d1', 'home wording', 'd1'), expectedRev: 1 }] }));
    val(await A.repo.transaction({ writes: [{ ...q('q-d1', 'office wording', 'd1'), expectedRev: 1 }] }));
    val(await H.repo.transaction({ writes: [{ ...q('q-d1', 'home again', 'd1'), expectedRev: 2 }] }));
    // the desk has everything but the office's d1 file, so home's second edit, built on nothing it lacks, is not held, but a
    // change of home's built on the office's would be: use home's file without its first line to hold the second
    const desk = new Mem(); for (const [n, t] of A.shared.files) if (!n.includes('-d1-')) desk.files.set(n, t);
    for (const [n, t] of H.shared.files) if (n.includes('-d1-')) desk.files.set(n, t.split('\n').slice(1).join('\n'));
    let now = Date.parse(clock()); const at = () => new Date(now).toISOString();
    const { repo, on } = lockedPc(desk, /-d2-\d{4}\.jsonl$/, 'Desk', at);
    val(await repo.list('question', 'd1'));
    const s = val(await repo.sync()); expect(s.waiting.map((w) => [w.pc, w.deals])).toEqual([['home', ['d1']]]);
    now += 25 * 60 * 60_000; val(await repo.sync()); now += 20 * 60_000; expect(val(await repo.sync()).waiting).toEqual([]);   // let go, though d2 is still locked
    expect((await repo.list('question', 'd2')).ok).toBe(false); on.stuck = false;
  });

  it('a wait for a deal whose files have not reached this PC at all is reported while another deal’s file is locked', async () => {
    const A = pc('Office', 'adoe'), H = pc('Home', 'sroe');
    for (const d of ['d1', 'd2']) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      val(await A.repo.transaction({ writes: [{ kind: 'item', id: `i-${d}`, data: { id: `i-${d}`, dealId: d, off: false }, expectedRev: null }], index: { dealId: d, add: [{ kind: 'item', id: `i-${d}` }] } }));
    }
    carry(A.shared, H.shared); val(await H.repo.sync());
    val(await H.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Renamed' }, expectedRev: 1 }, { kind: 'item', id: 'i-d1', data: { id: 'i-d1', dealId: 'd1', off: true }, expectedRev: 1 }] }));
    const desk = new Mem(); for (const m of [A.shared, H.shared]) for (const [n, t] of m.files) if (!n.includes('-d1-')) desk.files.set(n, t);   // no file of d1 here yet
    const { repo, on } = lockedPc(desk, /-d2-\d{4}\.jsonl$/, 'Desk');
    expect(val(await repo.sync()).waiting.map((w) => [w.pc, w.deals])).toEqual([['office', ['d1']]]);
    on.stuck = false;
  });

  it('a locked deal file is not taken for being offline in the window: the deal shows Retry, the rest works', async () => {
    const shared = new Mem(); const A = pc('Office', 'adoe', shared);
    for (const d of ['d1', 'd2']) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      val(await A.repo.transaction({ writes: [{ ...q(`q-${d}`, 'asked', d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] } }));
    }
    const there = new Mem(); carry(shared, there); const { repo, on } = lockedPc(there, /-d2-\d{4}\.jsonl$/);
    const { Store } = await import('../../src/app/store'); const { mockAi, mockDocuments, mockSession } = await import('../../src/adapters/mocks');
    const opts = { latency: [0, 0] as [number, number] };
    const b = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZZZZZZZZ`.slice(0, 28) } }, []);
    await b.boot(); await b.loadDeal('d2', { gaps: false }); await b.loadDeal('d1', { gaps: false });
    expect(b.get().dealLoad.d2).toBe('failed'); expect(b.get().net.down).toBe(false); expect(b.get().dealLoad.d1).toBe('loaded');
    on.stuck = false; await b.retryDeal('d2'); expect(b.get().dealLoad.d2).toBe('loaded');
  });

  it('start-up with a file of the deals locked is refused, never shown with part of the list, and tried again every 10 seconds until it opens', async () => {
    const opts = { latency: [0, 0] as [number, number] };
    const store = (repo: Repository) => new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}` } }, [CreateDeal]); let n = 0;
    const A = pc('Office', 'adoe'); const a = store(A.repo); await a.boot(); expect((await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] })).ok).toBe(true);
    const there = new Mem(); carry(A.shared, there);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { repo, on } = lockedPc(there, /-_-\d{4}\.jsonl$/);
      const b = store(repo);
      await b.boot(); expect(b.get().boot.stage).toBe('deals'); expect(b.get().boot.error).toBeTruthy(); expect(b.get().deals).toEqual({}); expect(b.get().net.down).toBe(false);
      // the message stays on screen while it tries again: it is never cleared while the file is locked (no flicker)
      let cleared = 0; b.subscribe((s) => { if (s.boot.stage !== 'ready' && !s.boot.error) cleared++; });
      await vi.advanceTimersByTimeAsync(10_000); expect(b.get().boot.stage).toBe('deals');           // still locked: still refused, and tried again
      expect(cleared).toBe(0);
      on.stuck = false; await vi.advanceTimersByTimeAsync(10_000);
      expect(b.get().boot.stage).toBe('ready'); expect(Object.keys(b.get().deals)).toEqual(Object.keys(a.get().deals));
    } finally { vi.useRealTimers(); }
  });

  it('a sync client’s copy of a deal’s file that will not open at start-up keeps that deal from showing without it', async () => {
    const A = pc('Office', 'adoe');
    val(
      await A.repo.transaction({
        writes: [{ ...q('q1', 'one', 'd1'), expectedRev: null }],
        index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] },
      }),
    );
    const there = new Mem(); for (const [n, t] of A.shared.files) there.files.set(n.replace('.jsonl', '-PC-0042.jsonl'), t);
    const { repo, on } = lockedPc(there, /-PC-0042\.jsonl$/);
    const r = await repo.list('question', 'd1'); expect(!r.ok && r.error.kind).toBe('failed');
    on.stuck = false; expect(val(await repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1']);
  });

  it('a file of the deals that will not open at start-up: the list of deals and the firm checklist are not read as empty, and a save is refused until it opens', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'd1' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } }));
    val(await A.repo.transaction({ writes: [{ kind: 'firmList', id: 'firm', data: { id: 'firm', lists: [] }, expectedRev: null }], audit: [] }));
    const there = new Mem(); carry(A.shared, there); const { repo, on } = lockedPc(there, /-_-\d{4}\.jsonl$/);
    const ds = await repo.list('deal', '_'); expect(!ds.ok && ds.error.kind).toBe('failed');
    const fl = await repo.get('firmList', 'firm'); expect(fl.ok).toBe(false);
    const w = await repo.transaction({ writes: [{ kind: 'firmList', id: 'firm', data: { id: 'firm', lists: ['mine'] }, expectedRev: null }], audit: [] }); expect(w.ok).toBe(false);
    on.stuck = false;
    expect(val(await repo.list('deal', '_')).map((x) => x.id)).toEqual(['d1']);
    const again = await repo.transaction({ writes: [{ kind: 'firmList', id: 'firm', data: { id: 'firm', lists: ['mine'] }, expectedRev: null }], audit: [] }); expect(!again.ok && again.error.kind).toBe('conflict');
  });
});

describe('start-up at deal scale', () => {
  it('20 deals of 2,000 questions each: start-up reads only the deals, an opened deal is read alone and ahead of the rest, and the rest follow', async () => {
    const A = pc('Office', 'adoe');
    const deals = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, '0')}`);
    for (const d of deals) {
      val(await A.repo.transaction({ writes: [{ kind: 'deal', id: d, data: { id: d, name: d }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: d }] } }));
      for (let b = 0; b < 20; b++) {                                                                                  // 2,000 questions a deal (deal scale), 100 to a change
        const ids = Array.from({ length: 100 }, (_, k) => `q-${d}-${b * 100 + k}`);
        val(await A.repo.transaction({ writes: ids.map((id) => ({ kind: 'question' as const, id, data: { id, dealId: d, text: `question ${id} `.repeat(8) }, expectedRev: null })), index: { dealId: d, add: ids.map((id) => ({ kind: 'question' as const, id })) } }));
      }
    }
    const shared = new Mem(); carry(A.shared, shared);
    const parts = () => [...new Set(shared.reads.map((n) => /-(d\d+|_)-\d{4}\.jsonl$/.exec(n)?.[1]))].sort();
    let t = performance.now(); const c = pc('Laptop', 'adoe', shared); const start = performance.now() - t;
    expect(parts()).toEqual(['_']); expect(val(await c.repo.list('deal', '_'))).toHaveLength(20);
    t = performance.now(); const opened = val(await c.repo.list('question', 'd17')); const open = performance.now() - t;
    expect(opened).toHaveLength(2000); expect(parts()).toEqual(['_', 'd17']);
    t = performance.now(); await c.repo.ready(); const rest = performance.now() - t;
    expect(parts()).toEqual(['_', ...deals].sort());
    for (const d of deals) expect(val(await c.repo.list('question', d))).toHaveLength(2000);
    console.log(`start-up ${start.toFixed(0)} ms, opened deal ${open.toFixed(0)} ms, the other 19 in the background ${rest.toFixed(0)} ms`);
  }, 120_000);
});

describe('the app on change files', () => {
  const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, EditDeal, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, ResolveConflict, ReopenConflict];
  for (const c of COMMANDS) registry.set(c.name, c);
  function app(repo: Repository) {
    let t = 0, n = 0; const opts = { latency: [0, 0] as [number, number] };
    return new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(),
      clock: { now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, 0, t++)).toISOString() }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(n++).padStart(7, '0')}` } }, COMMANDS);
  }
  /** an ordinary session: a deal, questions, a finding, edits, a response, deletes, undos */
  async function session(store: Store) {
    await store.boot();
    const ok = async (p: Promise<{ ok: boolean; value?: { opId: string } }>) => { const r = await p; expect(r.ok).toBe(true); return r.value!.opId; };
    await ok(store.dispatch(CreateDeal, { name: 'Proseware', folders: [] })); const dealId = Object.keys(store.get().deals)[0];
    for (const t of ['Confirm the lock-up ratio.', 'Provide the revenue contract.', 'Who holds the land rights?']) await ok(store.dispatch(CreateQuestion, { dealId, text: t }));
    await ok(store.dispatch(CreateFinding, { dealId, title: 'Lock-up differs between documents', workstream: 'Legal' }));
    const [q1, q2, q3] = dealQuestions(store.get(), dealId).map((x) => x.id); const f = dealFindings(store.get(), dealId)[0].id;
    await ok(store.dispatch(EditQuestionField, { dealId, questionId: q1, field: 'text', value: 'Confirm the lock-up ratio from financial close.' }));
    await ok(store.dispatch(SetResponse, { dealId, questionId: q2, response: 'Attached as 14.3.', origin: 'human' } as any));
    await ok(store.dispatch(SetQuestionStatus, { dealId, questionId: q2, status: 'answered' }));
    const gone = await ok(store.dispatch(DeleteQuestion, { dealId, questionId: q3 }));
    await ok(store.undo(gone));
    await ok(store.dispatch(DeleteQuestion, { dealId, questionId: q1 }));
    const closed = await ok(store.dispatch(SetFindingStatus, { dealId, findingId: f, status: 'closed' })); await ok(store.undo(closed));
    await ok(store.dispatch(ReviewFinding, { dealId, findingId: f, reviewed: true }));
    return dealId;
  }
  /** where `session` ended on the key-value store the app was built on (since removed): the change files must end in the same state. One rule differs on purpose: Q3 was deleted and restored, and a delete now counts as a revision, so it stands at 3, not 1 */
  const BUILT_ON = { dealId: 'd_01HZZZZZZZZZZZZZZZZ0000001', picture: { deal: { name: 'Project Proseware', group: 'live' }, questions: [{ id: 'q_01HZZZZZZZZZZZZZZZZ0000005', n: 2, text: 'Provide the revenue contract.', status: 'answered', response: 'Attached as 14.3.', rev: 3 }, { id: 'q_01HZZZZZZZZZZZZZZZZ0000007', n: 3, text: 'Who holds the land rights?', status: 'open', response: '', rev: 3 }], findings: [{ id: 'f_01HZZZZZZZZZZZZZZZZ0000009', status: 'open', reviewed: true, rev: 4 }], deleted: ['q_01HZZZZZZZZZZZZZZZZ0000003'] } };
  const picture = (store: Store, dealId: string) => JSON.parse(JSON.stringify({
    deal: (({ name, group, mode }) => ({ name, group, mode }))(store.get().deals[dealId]),
    questions: dealQuestions(store.get(), dealId).map((x) => ({ id: x.id, n: x.n, text: x.text, status: x.status, response: x.response, rev: x.rev })),
    findings: dealFindings(store.get(), dealId).map((x) => ({ id: x.id, status: x.status, reviewed: !!x.reviewed, rev: x.rev })),
    deleted: Object.values(store.get().tombstones ?? {}).map((x: any) => x.id).sort(),
  }));

  it('a deal whose file cannot be opened shows as not loaded; Retry loads all of it, and the next question takes the next number', async () => {
    const shared = new Mem();
    const A = pc('Office', 'adoe', shared);
    const a = app(A.repo);
    const dealId = await session(a);
    const before = dealQuestions(a.get(), dealId).map((x) => x.n);
    const there = new Mem(); carry(shared, there); let stuck = true; const read = there.read.bind(there);
    there.read = (n: string) => { if (stuck && n.includes(`-${dealId}-`)) throw new Error('EBUSY: resource busy or locked'); return read(n); };
    const B = pc('Laptop', 'adoe', there); const b = app(B.repo); await b.boot();
    await b.loadDeal(dealId, { gaps: false }); expect(b.get().dealLoad[dealId]).toBe('failed'); expect(dealQuestions(b.get(), dealId)).toEqual([]);
    expect((await b.dispatch(CreateQuestion, { dealId, text: 'typed while it cannot be read' })).ok).toBe(false);          // nothing is saved on a deal not loaded
    stuck = false; await b.retryDeal(dealId); expect(b.get().dealLoad[dealId]).toBe('loaded'); expect(dealQuestions(b.get(), dealId).map((x) => x.n)).toEqual(before);
    expect((await b.dispatch(CreateQuestion, { dealId, text: 'typed after Retry' })).ok).toBe(true);
    const numbers = dealQuestions(b.get(), dealId).map((x) => x.n); expect(new Set(numbers).size).toBe(numbers.length); expect(numbers).toHaveLength(before.length + 1);
  });

  it('a record’s history is still read while another deal’s file cannot be opened', async () => {
    const A = pc('Office', 'adoe');
    const q = (id: string, d: string) => ({ kind: 'question' as const, id, data: { id, dealId: d, text: 'asked' } });
    for (const d of ['d1', 'd2']) val(await A.repo.transaction({ writes: [{ ...q(`q-${d}`, d), expectedRev: null }], index: { dealId: d, add: [{ kind: 'question', id: `q-${d}` }] }, audit: [{ kind: 'created', recordId: `q-${d}`, dealId: d, text: 'Added' } as any] }));
    const there = new Mem(); carry(A.shared, there); const read = there.read.bind(there); there.read = (n: string) => { if (/-d2-\d{4}\.jsonl$/.test(n)) throw new Error('EBUSY'); return read(n); };
    const B = pc('Laptop', 'adoe', there); val(await B.repo.list('question', 'd1'));
    expect(val(await B.repo.audit('q-d1'))).toHaveLength(1);
    const other = await B.repo.audit('q-d2'); expect(!other.ok && other.error.kind).toBe('failed');
  });

  it('an ordinary session ends in the same state as on the store the app was built on, and comes back the same after a restart', async () => {
    const shared = new Mem(),
      local = new Mem();
    const onFiles = app(pc('Office', 'adoe', shared, local).repo);
    const fileDeal = await session(onFiles);
    expect(fileDeal).toBe(BUILT_ON.dealId); expect(picture(onFiles, fileDeal)).toEqual(BUILT_ON.picture);
    expect(picture(onFiles, fileDeal).questions.map((x: any) => x.text)).toEqual(['Provide the revenue contract.', 'Who holds the land rights?']);
    const again = app(pc('Office', 'adoe', shared, local).repo); await again.boot(); await again.loadDeal(fileDeal);
    expect(picture(again, fileDeal)).toEqual(picture(onFiles, fileDeal));
  });

  /** a PC whose clock (the change files' and the app's) runs `ahead` ms off the others, with its own copy of the shared folder */
  let pcs = 0;
  function pcAt(label: string, user: string, ahead: number, shared = new Mem(), local = new Mem()) {
    // `me` keeps each PC's new ids apart, as their random parts do in the app
    const me = pcs++ % 10; let t = 0, n = 0; const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, 0, t++) + ahead).toISOString(); const opts = { latency: [0, 0] as [number, number] };
    const open = () => {
      const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => label.toLowerCase() });
      const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(),
        clock: { now }, ids: { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZ${me}${String(n++).padStart(7, '0')}` } }, COMMANDS);
      return { repo, store };
    };
    return { shared, open, tick: (ms: number) => { t += ms; } };
  }
  const listed = async (repo: Repository, dealId: string) => ({ questions: val(await repo.list('question', dealId)).length, findings: val(await repo.list('finding', dealId)).length, deleted: val(await repo.list('tombstone', dealId)).length });

  // what a deal lists followed each PC's wall clock, so a restore stamped earlier than the delete it undid lost to it on every PC
  for (const [name, ahead] of [['ahead of', 180_000], ['behind', -180_000], ['the same as', 0]] as const) {
    it(`a question and a finding deleted on one PC and restored on another stay restored on both, with the deleting PC's clock ${name} the other's`, async () => {
      const A = pcAt('Office', 'adoe', ahead), B = pcAt('Home', 'sroe', 0);
      let a = A.open(); await a.store.boot();
      val(await a.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] })); const dealId = Object.keys(a.store.get().deals)[0]; await a.store.loadDeal(dealId, { gaps: false });
      val(await a.store.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' })); val(await a.store.dispatch(CreateFinding, { dealId, title: 'Lock-up differs between documents', workstream: 'Legal' }));
      const q = dealQuestions(a.store.get(), dealId)[0].id, f = dealFindings(a.store.get(), dealId)[0].id;
      val(await a.store.dispatch(DeleteQuestion, { dealId, questionId: q })); val(await a.store.dispatch(DeleteFinding, { dealId, findingId: f }));
      expect(await listed(a.repo, dealId)).toEqual({ questions: 0, findings: 0, deleted: 2 });
      carry(A.shared, B.shared); B.tick(60_000);                                                          // a minute later, on the other PC
      let b = B.open(); await b.store.boot(); await b.store.loadDeal(dealId, { gaps: false });
      expect(await listed(b.repo, dealId)).toEqual({ questions: 0, findings: 0, deleted: 2 });
      val(await b.store.dispatch(RestoreQuestion, { dealId, questionId: q })); val(await b.store.dispatch(RestoreFinding, { dealId, findingId: f }));
      expect(await listed(b.repo, dealId)).toEqual({ questions: 1, findings: 1, deleted: 0 });
      carry(A.shared, B.shared);
      for (const P of [A, B]) {                                                                           // after a restart, on both
        const again = P.open(); await again.store.boot(); await again.store.loadDeal(dealId, { gaps: false });
        expect(await listed(again.repo, dealId)).toEqual({ questions: 1, findings: 1, deleted: 0 });
        expect(dealQuestions(again.store.get(), dealId).map((x) => x.id)).toEqual([q]); expect(dealFindings(again.store.get(), dealId).map((x) => x.id)).toEqual([f]);
        expect(Object.keys(again.store.get().tombstones ?? {})).toEqual([]);
      }
      // and deleted again on the PC that restored it (the earlier clock, when A is ahead), it is deleted on both
      b = B.open(); await b.store.boot(); await b.store.loadDeal(dealId, { gaps: false });
      val(await b.store.dispatch(DeleteQuestion, { dealId, questionId: q })); carry(A.shared, B.shared);
      a = A.open(); await a.store.boot(); await a.store.loadDeal(dealId, { gaps: false });
      expect(await listed(a.repo, dealId)).toEqual({ questions: 0, findings: 1, deleted: 1 }); expect(await listed(b.repo, dealId)).toEqual({ questions: 0, findings: 1, deleted: 1 });
    });
  }

  it('three PCs on clocks minutes apart, creating, editing, deleting and restoring with partial syncs: every question ends up listed or under Deleted, the same on each', async () => {
    let seed = 544; const rnd = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) % n; };   // mulberry32: the same runs every time
    for (let run = 0; run < 60; run++) {
      const P = [pcAt('Office', 'adoe', 0), pcAt('Home', 'sroe', 240_000), pcAt('Laptop', 'kroe', -180_000)];
      const first = P[0].open(); await first.store.boot(); val(await first.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] })); const dealId = Object.keys(first.store.get().deals)[0];
      for (let i = 0; i < 3; i++) val(await first.store.dispatch(CreateQuestion, { dealId, text: `Question ${i}` }));
      for (const o of P.slice(1)) carry(P[0].shared, o.shared);
      const made = new Set(dealQuestions(first.store.get(), dealId).map((x) => x.id));
      for (let step = 0; step < 30; step++) {
        const pc = P[rnd(3)]; pc.tick(rnd(5_000));
        if (rnd(3) === 0) { carry(pc.shared, P[rnd(3)].shared); continue; }
        // a refusal (a clash still open, a number taken) is part of ordinary use: the results are not checked, only where things end up
        const { store } = pc.open(); await store.boot(); await store.loadDeal(dealId, { gaps: false });
        const qs = dealQuestions(store.get(), dealId), gone = Object.values(store.get().tombstones ?? {}).filter((t: any) => t.kind === 'question');
        const what = rnd(4);
        if (what === 0 && gone.length) await store.dispatch(RestoreQuestion, { dealId, questionId: (gone[rnd(gone.length)] as any).id });
        else if (what === 1 && qs.length) await store.dispatch(DeleteQuestion, { dealId, questionId: qs[rnd(qs.length)].id });
        else if (what === 2 && qs.length) await store.dispatch(EditQuestionField, { dealId, questionId: qs[rnd(qs.length)].id, field: 'text', value: `Edited at step ${step}` });
        else { await store.dispatch(CreateQuestion, { dealId, text: `Added at step ${step}` }); for (const x of dealQuestions(store.get(), dealId)) made.add(x.id); }
      }
      for (let i = 0; i < 2; i++) for (const a of P) for (const b of P) carry(a.shared, b.shared);
      const ends: string[] = [];
      for (const pc of P) {
        const { repo } = pc.open(); await repo.ready();
        const here = new Set([...val(await repo.list('question', dealId)), ...val(await repo.list('tombstone', dealId))].map((x) => x.id));
        expect([...made].filter((id) => !here.has(id)), `run ${run}: questions in neither list`).toEqual([]);
        ends.push(JSON.stringify([val(await repo.list('question', dealId)).map((x) => x.id), val(await repo.list('tombstone', dealId)).map((x) => x.id)]));
      }
      expect(new Set(ends).size, `run ${run}: the PCs differ`).toBe(1);
    }
  }, 60_000);

  it('after a restart, Undo of an old edit is refused once the record has changed since, as it is before the restart', async () => {
    const shared = new Mem(),
      local = new Mem();
    const A = app(pc('Office', 'adoe', shared, local).repo);
    await A.boot();
    await A.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(A.get().deals)[0]; await A.loadDeal(dealId, { gaps: false });
    await A.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' }); const qid = dealQuestions(A.get(), dealId)[0].id;
    const edit = val(await A.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Confirm the lock-up ratio.' })).opId;
    val(await A.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Confirm the lock-up ratio from financial close.' }));
    const B = app(pc('Office', 'adoe', shared, local).repo); await B.boot(); await B.loadDeal(dealId, { gaps: false });
    const u = await B.undo(edit);
    expect(!u.ok && u.error.message).toBe('Changed since — undo refused');
    expect(B.get().questions[qid].text).toBe('Confirm the lock-up ratio from financial close.');
  });

  it('the same session with every change in a file of its own ends in the same state, on this PC and on another', async () => {
    const shared = new Mem(),
      local = new Mem();
    const onFiles = app(pc('Office', 'adoe', shared, local, 1).repo);
    const fileDeal = await session(onFiles);
    expect(picture(onFiles, fileDeal)).toEqual(BUILT_ON.picture); expect(shared.files.size).toBeGreaterThan(10);
    expect([...shared.files.keys()].every((n) => n.includes(`-${fileDeal}-`) || n.includes('-_-'))).toBe(true);
    const home = pc('Home', 'sroe'); carry(shared, home.shared); const there = app(home.repo); await there.boot(); await there.loadDeal(fileDeal);
    expect(picture(there, fileDeal)).toEqual(picture(onFiles, fileDeal));
  });

  it('a deal deleted on one PC is gone on the other too, with everything that was under it, and stays gone after a restart', async () => {
    const wait = async (ok: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 5)); return ok(); };
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); const a = app(A.repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    for (const t of ['Confirm the lock-up ratio.', 'Provide the revenue contract.']) await a.dispatch(CreateQuestion, { dealId, text: t });
    await a.dispatch(CreateFinding, { dealId, title: 'Lock-up differs between documents', workstream: 'Legal' });
    const whole = picture(a, dealId); expect([whole.questions.length, whole.findings.length]).toEqual([2, 1]);
    carry(A.shared, B.shared); const b = app(B.repo); await b.boot(); await b.loadDeal(dealId); expect(picture(b, dealId)).toEqual(whole);
    const under = async (r: Repository) => [val(await r.list('question', dealId)).length, val(await r.list('finding', dealId)).length];
    expect(await under(B.repo)).toEqual([2, 1]);
    expect((await a.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware' })).ok).toBe(true);
    expect(a.get().ui.toasts.find((x) => x.text === 'Project Proseware deleted')?.action).toBeUndefined();
    expect(await under(A.repo)).toEqual([0, 0]);
    carry(A.shared, B.shared); await b.refreshSync(); expect(await wait(() => !b.get().deals[dealId])).toBe(true); expect(await under(B.repo)).toEqual([0, 0]);
    const again = app(pc('PC A', 'adoe', A.shared, A.local).repo);
    await again.boot();
    expect(Object.keys(again.get().deals)).toEqual([]);
  });

  it('two people on one deal: a clash reaches the app as two versions, and choosing one settles it on both PCs', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); const a = app(A.repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(a.get().deals)[0]; await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the lock-up ratio.' });
    const q = dealQuestions(a.get(), dealId)[0].id;
    carry(A.shared, B.shared); const b = app(B.repo); await b.boot(); await b.loadDeal(dealId);
    expect((await a.dispatch(EditQuestionField, { dealId, questionId: q, field: 'text', value: 'Office wording' })).ok).toBe(true);
    expect((await b.dispatch(EditQuestionField, { dealId, questionId: q, field: 'text', value: 'Home wording' })).ok).toBe(true);
    carry(A.shared, B.shared); await a.refreshSync(); await b.refreshSync(); await a.loadDeal(dealId); await b.loadDeal(dealId);
    for (const s of [a, b]) for (let i = 0; i < 50 && !s.get().conflicts[q]; i++) await new Promise((r) => setTimeout(r, 5));
    expect(a.get().conflicts[q].versions.map((v: any) => v.data.text)).toEqual(['Office wording', 'Home wording']); expect(b.get().conflicts[q].versions.map((v: any) => v.from)).toEqual(['PC A', 'PC B']);
    const keep = b.get().conflicts[q].versions[1].id;
    expect((await b.dispatch(ResolveConflict, { dealId, recordId: q, keep })).ok).toBe(true);
    carry(A.shared, B.shared); await a.refreshSync(); for (let i = 0; i < 50 && a.get().conflicts[q]; i++) await new Promise((r) => setTimeout(r, 5));
    expect(a.get().conflicts[q]).toBeUndefined(); expect(a.get().questions[q].text).toBe('Home wording'); expect(b.get().questions[q].text).toBe('Home wording');
  });

  it('undoing a choice between versions brings both back, and they can be chosen between again', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); const a = app(A.repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(a.get().deals)[0]; await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the lock-up ratio.' });
    const q = dealQuestions(a.get(), dealId)[0].id;
    carry(A.shared, B.shared); const b = app(B.repo); await b.boot(); await b.loadDeal(dealId);
    val(await a.dispatch(EditDeal, { dealId, counterparty: 'Office sponsor' })); val(await a.dispatch(EditQuestionField, { dealId, questionId: q, field: 'text', value: 'Office wording' }));
    val(await b.dispatch(EditDeal, { dealId, counterparty: 'Home sponsor' })); val(await b.dispatch(EditQuestionField, { dealId, questionId: q, field: 'text', value: 'Home wording' }));
    carry(A.shared, B.shared); await b.refreshSync(); await b.loadDeal(dealId);
    for (let i = 0; i < 50 && !(b.get().conflicts[q] && b.get().conflicts[dealId]); i++) await new Promise((r) => setTimeout(r, 5));
    for (const id of [dealId, q]) {
      const keep = b.get().conflicts[id].versions[1].id;
      const chose = val(await b.dispatch(ResolveConflict, { dealId, recordId: id, keep })).opId;
      expect(b.get().conflicts[id]).toBeUndefined();
      const u = await b.undo(chose); expect(u.ok ? 'ok' : u.error.message).toBe('ok');
      expect(b.get().conflicts[id]?.versions.length).toBe(2);
      const again = await b.dispatch(ResolveConflict, { dealId, recordId: id, keep: b.get().conflicts[id].versions[0].id });
      expect(again.ok ? 'ok' : again.error.message).toBe('ok'); expect(b.get().conflicts[id]).toBeUndefined();
    }
    expect(b.get().deals[dealId].counterparty).toBe('Office sponsor'); expect(b.get().questions[q].text).toBe('Office wording');
    expect((await b.dispatch(CreateQuestion, { dealId, text: 'Still open for work?' })).ok).toBe(true);
  });

  it('undoing a choice of the deleted version brings both versions back, and the deal stays open for work', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); const a = app(A.repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(a.get().deals)[0]; await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the lock-up ratio.' });
    const q = dealQuestions(a.get(), dealId)[0].id;
    carry(A.shared, B.shared); const b = app(B.repo); await b.boot(); await b.loadDeal(dealId);
    val(await a.dispatch(DeleteQuestion, { dealId, questionId: q })); val(await b.dispatch(EditQuestionField, { dealId, questionId: q, field: 'text', value: 'Home wording' }));
    carry(A.shared, B.shared); await b.refreshSync(); await b.loadDeal(dealId);
    for (let i = 0; i < 50 && !b.get().conflicts[q]; i++) await new Promise((r) => setTimeout(r, 5));
    const gone = b.get().conflicts[q].versions.find((v: any) => v.deleted)!.id;
    const chose = val(await b.dispatch(ResolveConflict, { dealId, recordId: q, keep: gone })).opId;
    const u = await b.undo(chose); expect(u.ok ? 'ok' : u.error.message).toBe('ok');
    expect(b.get().conflicts[q]?.versions.length).toBe(2);
    const again = await b.dispatch(ResolveConflict, { dealId, recordId: q, keep: b.get().conflicts[q].versions.find((v: any) => !v.deleted)!.id });
    expect(again.ok ? 'ok' : again.error.message).toBe('ok'); expect(b.get().questions[q].text).toBe('Home wording');
    expect((await b.dispatch(CreateQuestion, { dealId, text: 'Still open for work?' })).ok).toBe(true);
  });

  it('a record last written by a newer build is read here but not changed or deleted; the rest of the deal is not affected', async () => {
    const A = pc('PC A', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { id: 'q1', dealId: 'd1', text: 'one' }, expectedRev: null }, { kind: 'question', id: 'q2', data: { id: 'q2', dealId: 'd1', text: 'two' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }, { kind: 'question', id: 'q2' }] } }));
    // a newer build on the home PC changes q1, with a field this build does not know
    const B = pc('PC B', 'sroe'); carry(A.shared, B.shared); val(await B.repo.sync());
    const st = val(await B.repo.get('question', 'q1'))!; const line = { v: 1, schema: 99, pc: 'pcb', seq: 1, at: '2026-11-12T10:00:00.000Z', by: 'sroe', from: 'PC B', recs: [{ kind: 'question', id: 'q1', ver: 'pcb.1.0', base: [verOf(A.shared, 'q1')], data: { id: 'q1', dealId: 'd1', text: 'one', outcome: { verdict: 'resolved' } } }] };
    expect(st.rev).toBe(1); B.shared.append(file('pcb', 'd1'), JSON.stringify(line) + '\n'); carry(A.shared, B.shared); val(await A.repo.sync());
    const got = val(await A.repo.get('question', 'q1'))!; expect(got.envelope.schema).toBe(99); expect((got.envelope.data as any).outcome).toEqual({ verdict: 'resolved' });
    const w = await A.repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { id: 'q1', dealId: 'd1', text: 'edited here' }, expectedRev: got.rev }] });
    expect(!w.ok && w.error).toEqual({ kind: 'rejected', message: 'This was last changed on a newer version of Punchlist. Update this PC to change it.' });
    const d = await A.repo.transaction({ writes: [], deletes: [{ kind: 'question', id: 'q1', expectedRev: got.rev }] }); expect(d.ok).toBe(false);
    val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'q2', data: { id: 'q2', dealId: 'd1', text: 'two, edited' }, expectedRev: 1 }] }));
    // what this build writes says which schema it was written with
    const written = [...A.shared.files.values()].join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.pc === 'pca');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((l) => l.schema === 1)).toBe(true);
  });

  it('a record carries the schema its content needs, not the writing build\'s; a write that only adds to the stored record as it is keeps its schema and is not refused', async () => {
    const A = pc('PC A', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'finding', id: 'f1', data: { id: 'f1', dealId: 'd1', title: 'one' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'finding', id: 'f1' }] } }));
    // what a newer build wrote: schema 99 on this one record
    const B = pc('PC B', 'sroe'); carry(A.shared, B.shared); val(await B.repo.sync());
    const line = { v: 1, schema: 99, pc: 'pcb', seq: 1, at: '2026-11-12T10:00:00.000Z', by: 'sroe', from: 'PC B', recs: [{ kind: 'finding', id: 'f1', ver: 'pcb.1.0', base: [verOf(A.shared, 'f1')], schema: 99, data: { id: 'f1', dealId: 'd1', title: 'one', future: { x: 1 } } }] };
    B.shared.append(file('pcb', 'd1'), JSON.stringify(line) + '\n'); carry(A.shared, B.shared); val(await A.repo.sync());
    const got = val(await A.repo.get('finding', 'f1'))!; expect(got.envelope.schema).toBe(99);
    // an ordinary write is refused; one that keeps the record as stored and only adds to it goes through, and the record keeps schema 99
    expect((await A.repo.transaction({ writes: [{ kind: 'finding', id: 'f1', data: { id: 'f1', dealId: 'd1', title: 'two' }, expectedRev: got.rev }] })).ok).toBe(false);
    val(await A.repo.transaction({ writes: [{ kind: 'finding', id: 'f1', data: { ...(got.envelope.data as object), updated: true }, expectedRev: got.rev, keepsSchema: true }] }));
    const after = val(await A.repo.get('finding', 'f1'))!; expect(after.envelope.schema).toBe(99); expect((after.envelope.data as any).future).toEqual({ x: 1 });
    // a record this build writes from scratch carries the schema its content needs (1 today), whatever line it is written on
    val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'q9', data: { id: 'q9', dealId: 'd1', text: 'new' }, expectedRev: null }] }));
    expect(val(await A.repo.get('question', 'q9'))!.envelope.schema).toBe(1);
  });

  it('a delete on one PC and an edit on another that had not seen it are two versions to choose between: nothing is lost, either can be kept, and Undo puts the choice back', async () => {
    const wait = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); return ok(); };
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); const a = app(A.repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    await a.dispatch(CreateQuestion, { dealId, text: 'Is there a decommissioning bond?' }); const q = dealQuestions(a.get(), dealId)[0].id;
    await a.dispatch(SetResponse, { dealId, questionId: q, response: 'Yes, issued March 3.' });
    carry(A.shared, B.shared); const b = app(B.repo); await b.boot(); await b.loadDeal(dealId);
    // the office closes it; at home, not having seen that, it is deleted
    expect((await a.dispatch(SetQuestionStatus, { dealId, questionId: q, status: 'closed' })).ok).toBe(true);
    expect((await b.dispatch(DeleteQuestion, { dealId, questionId: q })).ok).toBe(true);
    carry(A.shared, B.shared); await a.refreshSync(); await b.refreshSync(); await a.loadDeal(dealId); await b.loadDeal(dealId);
    for (const s of [a, b]) expect(await wait(() => !!s.get().conflicts[q])).toBe(true);
    // the same on both PCs: two versions, the closed question and the deletion; the question shows, as its readable version, and is not listed as deleted
    for (const s of [a, b]) {
      const c = s.get().conflicts[q];
      expect(c.versions.map((v: any) => (v.deleted ? `deleted on ${v.from}` : `${v.data.status} on ${v.from}`))).toEqual(['closed on PC A', 'deleted on PC B']);          // (both apps here sign in as the same person: the stand-in session)
      expect(s.get().questions[q]).toMatchObject({ status: 'closed', response: 'Yes, issued March 3.' });
      expect(Object.values(s.get().tombstones).filter((t) => t.dealId === dealId && !s.get().conflicts[t.id]).length).toBe(0);
    }
    // the deleted version shows the words it held: the question as the home PC had it
    for (const s of [a, b]) expect(s.get().conflicts[q].versions.find((v: any) => v.deleted)!.data).toMatchObject({ status: 'open', response: 'Yes, issued March 3.' });
    // the home PC keeps the closed version: the question stands everywhere, and the deleted copy is listed under Deleted on its own
    const closed = b.get().conflicts[q].versions.find((v: any) => !v.deleted)!.id;
    const kept = await b.dispatch(ResolveConflict, { dealId, recordId: q, keep: closed }); expect(kept.ok).toBe(true);
    carry(A.shared, B.shared); await a.refreshSync(); await a.loadDeal(dealId); expect(await wait(() => !a.get().conflicts[q])).toBe(true);
    for (const s of [a, b]) { expect(s.get().questions[q]).toMatchObject({ status: 'closed', response: 'Yes, issued March 3.' }); expect(s.get().tombstones[q]).toBeUndefined(); }
    expect(val(await A.repo.list('question', dealId)).map((x) => [x.id, !!x.conflict])).toEqual([[q, false]]);
    expect(val(await A.repo.list('tombstone', dealId)).map((x) => [(x.envelope.data as any).of, (x.envelope.data as any).snapshot.status, (x.envelope.data as any).from])).toEqual([[q, 'open', 'PC B']]);
    // Undo: the two versions stand again
    expect((await b.undo((kept as any).value.opId)).ok).toBe(true); expect(b.get().conflicts[q]?.versions.length).toBe(2);
    // this time it is kept deleted: gone everywhere, listed as deleted, and what was there is what Restore brings back
    const del = b.get().conflicts[q].versions.find((v: any) => v.deleted)!.id;
    const gone = await b.dispatch(ResolveConflict, { dealId, recordId: q, keep: del }); expect(gone.ok).toBe(true);
    carry(A.shared, B.shared); await a.refreshSync(); await a.loadDeal(dealId); expect(await wait(() => !a.get().questions[q])).toBe(true);
    for (const s of [a, b]) { expect(s.get().questions[q]).toBeUndefined(); expect(s.get().conflicts[q]).toBeUndefined(); expect(s.get().tombstones[q]).toBeTruthy(); }
    // the deletion note holds the copy the deleting PC had, and the closed version set aside is an entry of its own: both restore
    expect(((b.get().tombstones[q] as any).snapshot)).toMatchObject({ status: 'open', response: 'Yes, issued March 3.' });
    for (const s of [a, b]) expect(Object.values(s.get().tombstones).filter((t: any) => t.of === q).map((t: any) => [t.snapshot.status, t.from, !!t.edited])).toEqual([['closed', 'PC A', true]]);
    // and Undo of that choice brings the two versions back to choose between
    expect((await b.undo((gone as any).value.opId)).ok).toBe(true);
    expect(b.get().conflicts[q]?.versions.map((v: any) => !!v.deleted)).toEqual([false, true]); expect(b.get().questions[q].status).toBe('closed');
    // after a restart too
    const again = app(pc('PC B', 'sroe', B.shared, B.local).repo); await again.boot(); await again.loadDeal(dealId);
    expect(again.get().conflicts[q]?.versions.length).toBe(2);
  });
});

describe('changes made at the same moment in one window', () => {
  const q = (id: string, t: string, dealId = 'd1') => ({ kind: 'question' as const, id, data: { id, dealId, text: t } });
  const op = (id: string) => ({ kind: 'op' as const, id, data: {}, expectedRev: null });

  it('two saves started together both land, each on its own line', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }, { ...q('q2', 'two'), expectedRev: null }] }));
    // each carries its undo-journal entry, so each waits on this PC's own store part-way through
    const [r1, r2] = await Promise.all([
      A.repo.transaction({ writes: [{ ...q('q1', 'one, edited'), expectedRev: 1 }, op('op1')] }),
      A.repo.transaction({ writes: [{ ...q('q2', 'two, edited'), expectedRev: 1 }, op('op2')] }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const lines = [...A.shared.files.values()].join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(new Set(lines.map((l) => l.seq)).size).toBe(lines.length);
    const fresh = pc('Office', 'adoe', A.shared, A.local).repo;    // the same install started again reads both
    expect(await text(fresh, 'q1')).toBe('one, edited'); expect(await text(fresh, 'q2')).toBe('two, edited');
  });

  it('two saves of one record started together: the second is told it changed', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }] }));
    const [r1, r2] = await Promise.all([
      A.repo.transaction({ writes: [{ ...q('q1', 'from the first'), expectedRev: 1 }, op('op1')] }),
      A.repo.transaction({ writes: [{ ...q('q1', 'from the second'), expectedRev: 1 }, op('op2')] }),
    ]);
    expect(r1.ok).toBe(true); expect(!r2.ok && r2.error.kind).toBe('conflict');
    expect(await text(A.repo, 'q1')).toBe('from the first');
  });
});

describe('which file a change goes to', () => {
  it('a deal id as the app makes it (d_…) gets its own file', async () => {
    const A = pc('Office', 'adoe');
    val(await A.repo.transaction({ writes: [{ kind: 'question', id: 'q_1', data: { id: 'q_1', dealId: 'd_k7m2q9', text: 'one' }, expectedRev: null }], index: { dealId: 'd_k7m2q9', add: [{ kind: 'question', id: 'q_1' }] } }));
    expect(A.shared.files.has(file('office', 'd_k7m2q9'))).toBe(true);
    const fresh = pc('Office', 'adoe', A.shared, A.local).repo;    // and is read back as that deal's part
    expect(val(await fresh.list('question', 'd_k7m2q9')).map((x) => x.id)).toEqual(['q_1']);
  });
});

describe('a write to the shared folder that fails part-way', () => {
  const q = (id: string, t: string) => ({ kind: 'question' as const, id, data: { id, dealId: 'd1', text: t } });
  /** the next append writes `keep` of the text (all of it, or half) and then fails, as a network drive dropping mid-write can */
  class Torn extends Mem { cut: 'all' | 'half' | null = null; append(n: string, t: string) { const c = this.cut; if (!c) return super.append(n, t); this.cut = null; super.append(n, c === 'all' ? t : t.slice(0, Math.floor(t.length / 2))); throw new Error('EIO: i/o error'); } }

  it('a line that reached the shared file in full counts as written, and does not lock this PC out as a copy', async () => {
    const shared = new Torn(); const A = pc('Office', 'adoe', shared);
    shared.cut = 'all'; const r = await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }] });
    expect(r.ok).toBe(true); expect(await text(A.repo, 'q1')).toBe('one');
    val(await A.repo.sync()); expect(val(await A.repo.sync()).self.note).toBeUndefined();
    val(await A.repo.transaction({ writes: [{ ...q('q2', 'two'), expectedRev: null }] }));
  });

  it('half a line left in the shared file never swallows the next change', async () => {
    const shared = new Torn(); const A = pc('Office', 'adoe', shared);
    shared.cut = 'half'; const r = await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }] });
    expect(r.ok).toBe(false);
    val(await A.repo.transaction({ writes: [{ ...q('q2', 'two'), expectedRev: null }] }));
    const B = pc('Home', 'sroe', shared);                                 // another PC reading the same folder sees the change that was saved, and not the one that failed
    expect(await text(B.repo, 'q2')).toBe('two'); expect(await text(B.repo, 'q1')).toBeNull();
    expect(val(await A.repo.sync()).self.note).toBeUndefined();
  });
});

describe('durable recovery after a torn write', () => {
  const question = (text: string) => ({
    kind: 'question' as const,
    id: 'q1',
    data: { id: 'q1', dealId: 'd1', text },
  });

  class TornLocal extends Mem {
    tearNext = false;

    append(name: string, text: string) {
      if (!this.tearNext || !name.startsWith('changes-')) return super.append(name, text);
      this.tearNext = false;
      super.append(name, text.slice(0, 30));
      throw Object.assign(new Error('ENOSPC: partial local append'), { code: 'ENOSPC' });
    }
  }

  class LostReadback extends Mem {
    failNext = false;
    unreadable = false;
    portion: 'all' | 'half' | 'none' | 'no newline' = 'all';

    append(name: string, text: string) {
      if (!this.failNext || !name.startsWith('changes-')) return super.append(name, text);
      if (this.portion === 'all') super.append(name, text);
      if (this.portion === 'half') super.append(name, text.slice(0, 30));
      if (this.portion === 'no newline') super.append(name, text.slice(0, -1));
      this.failNext = false;
      this.unreadable = true;
      throw Object.assign(new Error('EIO: shared append lost its acknowledgment'), { code: 'EIO' });
    }

    read(name: string) {
      if (this.unreadable && name.startsWith('changes-')) throw new Error('EIO: readback unavailable');
      return super.read(name);
    }
  }

  it('a successful retry survives sync rollback after a partial local append', async () => {
    const shared = new Mem();
    const local = new TornLocal();
    const first = pc('Office', 'adoe', shared, local).repo;
    val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const name = file(first.id, 'd1');
    const before = shared.files.get(name)!;
    local.tearNext = true;
    const failed = await first.transaction({ writes: [{ ...question('Revised question'), expectedRev: 1 }] });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.kind).toBe('storageFull');
    val(await first.transaction({ writes: [{ ...question('Revised question'), expectedRev: 1 }] }));
    expect(await text(first, 'q1')).toBe('Revised question');
    shared.files.set(name, before);
    val(await first.sync());
    val(await first.sync());
    await first.close();
    const restarted = pc('Office', 'adoe', shared, local).repo;
    const recovered = await text(restarted, 'q1');
    const state = val(await restarted.sync());
    await restarted.close();
    expect(recovered).toBe('Revised question');
    expect(state.self.note).toBeUndefined();
  });

  it('a local tail left by a stopped write never makes the next saved line look copied', async () => {
    const shared = new Mem();
    const local = new Mem();
    const first = pc('Office', 'adoe', shared, local).repo;
    val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const name = file(first.id, 'd1');
    await first.close();
    local.files.set(name, `${local.files.get(name)!}{"v":1,"pc":"office","seq":2,`);
    const second = pc('Office', 'adoe', shared, local).repo;
    val(await second.transaction({ writes: [{ ...question('Saved after restart'), expectedRev: 1 }] }));
    await second.close();
    const third = pc('Office', 'adoe', shared, local).repo;
    const state = val(await third.sync());
    const saved = await text(third, 'q1');
    await third.close();
    expect(saved).toBe('Saved after restart');
    expect(state.self.note).toBeUndefined();
  });

  it('a landed shared line remains this PC\u2019s when its failed write cannot be read back', async () => {
    const shared = new LostReadback();
    const local = new Mem();
    const repo = pc('Office', 'adoe', shared, local).repo;
    val(await repo.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    shared.failNext = true;
    const uncertain = await repo.transaction({ writes: [{ ...question('Landed question'), expectedRev: 1 }] });
    expect(uncertain.ok).toBe(false);
    expect(!uncertain.ok && uncertain.error.kind).toBe('unreachable');
    shared.unreadable = false;
    const state = val(await repo.sync());
    expect(await text(repo, 'q1')).toBe('Landed question');
    const next = await repo.transaction({ writes: [{ ...question('Next saved question'), expectedRev: 2 }] });
    await repo.close();
    expect(state.self.note).toBeUndefined();
    expect(next.ok).toBe(true);
  });
});

describe('unconfirmed shared writes across restarts', () => {
  const question = (text: string) => ({
    kind: 'question' as const, id: 'q1', data: { id: 'q1', dealId: 'd1', text },
  });

  for (const portion of ['all', 'half', 'none', 'no newline'] as const) {
    it(`a shared ${portion} write with lost readback is recovered safely after restart`, async () => {
      const shared = new Mem();
      const local = new Mem();
      const first = pc('Office', 'adoe', shared, local).repo;
      val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
      const append = shared.append.bind(shared);
      const read = shared.read.bind(shared);
      shared.append = (name, value) => {
        shared.append = append;
        if (portion === 'all') append(name, value);
        if (portion === 'half') append(name, value.slice(0, 30));
        if (portion === 'no newline') append(name, value.slice(0, -1));
        shared.read = () => { throw new Error('EIO: readback unavailable'); };
        throw new Error('EIO: acknowledgment lost');
      };
      const failed = await first.transaction({ writes: [{ ...question('Uncertain question'), expectedRev: 1 }] });
      expect(failed.ok).toBe(false);
      const pending = JSON.parse(local.files.get(`pending-changes-${first.id}.json`)!);
      const attemptedSequence = JSON.parse(pending[0].text).seq;
      await first.close();
      shared.read = read;
      const restarted = pc('Office', 'adoe', shared, local).repo;
      const landed = portion === 'all';
      expect(await text(restarted, 'q1')).toBe(landed ? 'Uncertain question' : 'Initial question');
      expect(val(await restarted.sync()).self.note).toBeUndefined();
      val(await restarted.transaction({
        writes: [{ ...question('Explicit next save'), expectedRev: landed ? 2 : 1 }],
      }));
      const latest = shared.files.get(file(restarted.id, 'd1'))!.trim().split('\n').at(-1)!;
      expect(JSON.parse(latest).seq).toBeGreaterThan(attemptedSequence);
      await restarted.close();
      const again = pc('Office', 'adoe', shared, local).repo;
      const value = await text(again, 'q1');
      const state = val(await again.sync());
      await again.close();
      expect(value).toBe('Explicit next save');
      expect(state.self.note).toBeUndefined();
    });
  }

  it('a complete local JSON object missing its newline is kept aside without being published', async () => {
    const shared = new Mem();
    const local = new Mem();
    const first = pc('Office', 'adoe', shared, local).repo;
    val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const name = file(first.id, 'd1');
    const stopped = JSON.parse(shared.files.get(name)!.trim());
    stopped.seq = 2;
    stopped.recs[0].base = [stopped.recs[0].ver];
    stopped.recs[0].ver = 'office.2.0.stopped';
    stopped.recs[0].data.text = 'Never acknowledged';
    await first.close();
    local.files.set(name, local.files.get(name)! + JSON.stringify(stopped));
    const restarted = pc('Office', 'adoe', shared, local).repo;
    const value = await text(restarted, 'q1');
    await restarted.close();
    expect(value).toBe('Initial question');
    expect(shared.files.get(name)).not.toContain('Never acknowledged');
    expect(local.files.get(`torn-${name}`)).toContain('Never acknowledged');
  });

  it('a shared JSON object missing only its newline is not completed by healing', async () => {
    const shared = new Mem();
    const local = new Mem();
    const repo = pc('Office', 'adoe', shared, local).repo;
    val(await repo.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const append = shared.append.bind(shared);
    shared.append = (name, value) => {
      shared.append = append;
      append(name, value.slice(0, -1));
      throw new Error('EIO: failed before the newline');
    };
    expect((await repo.transaction({ writes: [{ ...question('Never acknowledged'), expectedRev: 1 }] })).ok)
      .toBe(false);
    val(await repo.sync());
    expect(await text(repo, 'q1')).toBe('Initial question');
    await repo.close();
    const restarted = pc('Office', 'adoe', shared, local).repo;
    const value = await text(restarted, 'q1');
    await restarted.close();
    expect(value).toBe('Initial question');
  });

  it('failed cleanup leaves ownership evidence without publishing an unwritten change', async () => {
    const shared = new Mem();
    const local = new Mem();
    const first = pc('Office', 'adoe', shared, local).repo;
    val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const write = local.write.bind(local);
    local.write = (name, value) => {
      if (name.startsWith('changes-')) throw new Error('EIO: cleanup unavailable');
      write(name, value);
    };
    const append = shared.append.bind(shared);
    const read = shared.read.bind(shared);
    shared.append = () => {
      shared.append = append;
      shared.read = () => { throw new Error('EIO: readback unavailable'); };
      throw new Error('EIO: wrote nothing');
    };
    expect((await first.transaction({ writes: [{ ...question('Unwritten change'), expectedRev: 1 }] })).ok)
      .toBe(false);
    expect(local.files.get(file(first.id, 'd1'))).toContain('Unwritten change');
    await first.close();
    shared.read = read;
    local.write = write;
    const restarted = pc('Office', 'adoe', shared, local).repo;
    const value = await text(restarted, 'q1');
    const state = val(await restarted.sync());
    await restarted.close();
    expect(value).toBe('Initial question');
    expect(shared.files.get(file(first.id, 'd1'))).not.toContain('Unwritten change');
    expect(state.self.note).toBeUndefined();
  });

  it('a landed uncertain line in a shared conflict copy is recognized as this PC\u2019s', async () => {
    const shared = new Mem();
    const local = new Mem();
    const first = pc('Office', 'adoe', shared, local).repo;
    val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const name = file(first.id, 'd1');
    const before = shared.files.get(name)!;
    const append = shared.append.bind(shared);
    const read = shared.read.bind(shared);
    shared.append = (fileName, value) => {
      shared.append = append;
      append(fileName, value);
      shared.read = () => { throw new Error('EIO: readback unavailable'); };
      throw new Error('EIO: acknowledgment lost');
    };
    expect((await first.transaction({ writes: [{ ...question('Landed in conflict copy'), expectedRev: 1 }] })).ok)
      .toBe(false);
    await first.close();
    shared.read = read;
    shared.files.set(name.replace('.jsonl', '-PC-COPY.jsonl'), shared.files.get(name)!);
    shared.files.set(name, before);
    const restarted = pc('Office', 'adoe', shared, local).repo;
    const value = await text(restarted, 'q1');
    const state = val(await restarted.sync());
    await restarted.close();
    expect(value).toBe('Landed in conflict copy');
    expect(local.files.get(name)).toContain('Landed in conflict copy');
    expect(state.self.note).toBeUndefined();
  });
});

describe('pending ownership storage failures', () => {
  const question = (text: string) => ({
    kind: 'question' as const, id: 'q1', data: { id: 'q1', dealId: 'd1', text },
  });

  it('refuses the change before touching either log when its ownership evidence cannot be kept', async () => {
    const shared = new Mem();
    const local = new Mem();
    const repo = pc('Office', 'adoe', shared, local).repo;
    val(await repo.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
    const name = file(repo.id, 'd1');
    const before = shared.files.get(name);
    const write = local.write.bind(local);
    local.write = (fileName, value) => {
      if (fileName.startsWith('pending-changes-')) {
        throw Object.assign(new Error('ENOSPC: ownership evidence cannot be kept'), { code: 'ENOSPC' });
      }
      write(fileName, value);
    };
    const result = await repo.transaction({ writes: [{ ...question('Must not be written'), expectedRev: 1 }] });
    await repo.close();
    expect(!result.ok && result.error.kind).toBe('storageFull');
    expect(shared.files.get(name)).toBe(before);
    expect(local.files.get(name)).toBe(before);
  });

  for (const rollback of [false, true]) {
    it(`a failed ownership clear grants no replay permission (rollback: ${rollback})`, async () => {
      const shared = new Mem();
      const local = new Mem();
      const first = pc('Office', 'adoe', shared, local).repo;
      val(await first.transaction({ writes: [{ ...question('Initial question'), expectedRev: null }] }));
      const name = file(first.id, 'd1');
      const before = shared.files.get(name)!;
      const write = local.write.bind(local);
      local.write = (fileName, value) => {
        if (fileName.startsWith('pending-changes-') && value === '[]') {
          throw Object.assign(new Error('ENOSPC: pending clear cannot be kept'), { code: 'ENOSPC' });
        }
        write(fileName, value);
      };
      const result = await first.transaction({ writes: [{ ...question('Landed question'), expectedRev: 1 }] });
      expect(!result.ok && result.error.kind).toBe('storageFull');
      await first.close();
      if (rollback) shared.files.set(name, before);
      local.write = write;
      const restarted = pc('Office', 'adoe', shared, local).repo;
      const value = await text(restarted, 'q1');
      const state = val(await restarted.sync());
      await restarted.close();
      expect(value).toBe(rollback ? 'Initial question' : 'Landed question');
      expect(state.self.note).toBeUndefined();
    });
  }
});

describe('changes held back until what they were built on arrives', () => {
  const q = (id: string, t: string, number = 1) => ({ kind: 'question' as const, id, data: { id, dealId: 'd1', text: t, number } });
  const copyAll = (from: Mem, to: Mem) => { for (const [n, t] of from.files) to.files.set(n, t); };
  const copyOwn = (from: { shared: Mem; repo: LogRepository }, to: Mem) => { for (const [n, t] of from.shared.files) if (n.includes(from.repo.id)) to.files.set(n, t); };
  const texts = async (r: Repository, id: string) => { const g = val(await r.get('question', id)); return g?.conflict ? g.conflict.map((v) => (v.deleted ? '<deleted>' : (v.data as any).text)) : g ? [(g.envelope.data as any).text] : []; };
  /** The office created q1, home edited it, and the laptop saw that and changed it again. The laptop's line reaches the office before the home one. */
  async function relay(laptop: (C: ReturnType<typeof pc>) => Promise<void>) {
    const A = pc('Office', 'adoe'), B = pc('Home', 'sroe'), C = pc('Laptop', 'pdoe');
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    copyAll(A.shared, B.shared); val(await B.repo.sync());
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'edited at home'), expectedRev: 1 }] }));
    copyAll(A.shared, C.shared); copyAll(B.shared, C.shared); val(await C.repo.sync());
    await laptop(C);
    copyOwn(C, A.shared); val(await A.repo.sync());
    return { A, release: async () => { copyOwn(B, A.shared); return val(await A.repo.sync()); } };
  }
  const laptopEdits = async (C: ReturnType<typeof pc>) => { val(await C.repo.transaction({ writes: [{ ...q('q1', 'edited again on the laptop'), expectedRev: 2 }] })); };
  const laptopDeletes = async (C: ReturnType<typeof pc>) => { val(await C.repo.transaction({ writes: [], deletes: [{ kind: 'question', id: 'q1', expectedRev: 2 }] })); };

  it('the record keeps its older version and can be edited; that edit and the held change become a choice, and nothing is lost', async () => {
    const { A, release } = await relay(laptopEdits);
    expect(await texts(A.repo, 'q1')).toEqual(['one']);
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit in the gap'), expectedRev: 1 }] }));
    const s = await release();
    expect(s.clashes?.map((c) => c.id)).toEqual(['q1']); expect((await texts(A.repo, 'q1')).sort()).toEqual(['edited again on the laptop', 'office edit in the gap']);
  });

  it('a delete relayed ahead of the edit it saw is not offered as a choice while held, and is a fair choice against an edit it never saw', async () => {
    const one = await relay(laptopDeletes);
    expect(await texts(one.A.repo, 'q1')).toEqual(['one']);
    let s = await one.release(); expect(s.clashes).toEqual([]); expect(await texts(one.A.repo, 'q1')).toEqual([]);         // nothing done meanwhile: deleted, as the laptop meant
    const two = await relay(laptopDeletes);
    val(await two.A.repo.transaction({ writes: [{ ...q('q1', 'office edit in the gap'), expectedRev: 1 }] }));
    s = await two.release(); expect((await texts(two.A.repo, 'q1')).sort()).toEqual(['<deleted>', 'office edit in the gap']);
  });

  it('a question added in a held change is not listed until it lands; one added meanwhile with the same number is a second question, both kept', async () => {
    const { A, release } = await relay(async (C) => { val(await C.repo.transaction({ writes: [{ ...q('q1', 'edited again on the laptop'), expectedRev: 2 }, { ...q('q2', 'laptop question', 2), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } })); });
    expect(val(await A.repo.list('question', 'd1')).map((x) => x.id)).toEqual(['q1']);
    val(await A.repo.transaction({ writes: [{ ...q('q3', 'office question', 2), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q3' }] } }));
    await release();
    const all = val(await A.repo.list('question', 'd1')); expect(all.map((x) => x.id).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(all.filter((x) => (x.envelope.data as any).number === 2).length).toBe(2);
  });

  it('a change that has waited a day for a lost one is let go: it stands as a choice beside the current version, ' +
    'the deal can be deleted, and nothing changes if the lost one turns up', async () => {
    const { A, release } = await relay(laptopEdits);
    let now = Date.UTC(2026, 10, 10, 20, 0, 0); const at = () => new Date(now).toISOString();
    const late = new LogRepository({ shared: A.shared, local: new Mem(), label: 'Desk', user: () => 'ddoe', clock: at }); await late.ready();   // a PC that holds it from the evening on
    now = Date.UTC(2026, 10, 11, 8, 59, 0); expect(val(await late.sync()).waiting).toHaveLength(1);                         // not yet a day since the change was made
    now = Date.UTC(2026, 10, 11, 9, 1, 0); expect(val(await late.sync()).waiting).toEqual([]);
    now = Date.UTC(2026, 10, 12, 9, 0, 0);
    const D = new LogRepository({ shared: A.shared, local: new Mem(), label: 'Desk', user: () => 'ddoe', clock: at }); await D.ready();   // a PC set up days later: given time for what is still syncing
    expect(val(await D.sync()).waiting).toHaveLength(1);
    now += 10 * 60_000; expect(val(await D.sync()).waiting).toHaveLength(1);
    now += 6 * 60_000; const s = val(await D.sync());
    expect(s.waiting).toEqual([]); expect(s.clashes?.map((c) => c.id)).toEqual(['q1']); expect((await texts(D, 'q1')).sort()).toEqual(['edited again on the laptop', 'one']);
    // should the lost change turn up after all, the choice settles as if it had come first
    await release(); const after = val(await D.sync()); expect(after.clashes).toEqual([]); expect(await texts(D, 'q1')).toEqual(['edited again on the laptop']);
    expect((await D.transaction({ writes: [], purgeDeal: 'd1' })).ok).toBe(true);
  });

  it('a write prepared against the older version is refused once the held change lands, and changes nothing', async () => {
    const { A, release } = await relay(laptopEdits);
    const before = val(await A.repo.get('question', 'q1'))!.rev;
    await release();
    const late = await A.repo.transaction({ writes: [{ ...q('q1', 'typed against the old version'), expectedRev: before }] });
    expect(!late.ok && late.error.kind).toBe('conflict'); expect(await texts(A.repo, 'q1')).toEqual(['edited again on the laptop']);
  });
});

describe('this PC out of touch with the shared folder', () => {
  it('says since when, and clears when it is back in touch', async () => {
    let touch = true;
    const A = new LogRepository({
      shared: new Mem(),
      local: new Mem(),
      label: 'Office',
      user: () => 'adoe',
      clock,
      inTouch: () => touch,
    });
    expect(val(await A.sync()).outOfTouchSince).toBeUndefined();
    touch = false; const first = val(await A.sync()).outOfTouchSince; expect(first).toEqual(expect.any(String));
    expect(val(await A.sync()).outOfTouchSince).toBe(first);                                    // timed from when it was first found
    touch = true; expect(val(await A.sync()).outOfTouchSince).toBeUndefined();
  });
});

describe('this PC’s own changes, and waits that outlast a restart', () => {
  const q = (id: string, t: string) => ({ kind: 'question' as const, id, data: { id, dealId: 'd1', text: t } });
  it('own changes stay in view when a file they were built on has gone from the folder', async () => {
    const shared = new Mem(), local = new Mem(); const A = pc('Office', 'adoe', shared, local), B = pc('Home', 'sroe');
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'from home'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }));
    carry(A.shared, B.shared); val(await A.repo.sync());
    val(await A.repo.transaction({ writes: [{ ...q('q1', 'office edit'), expectedRev: 1 }, { ...q('q2', 'office question'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } }));
    for (const n of [...shared.files.keys()]) if (!n.includes(A.repo.id)) shared.files.delete(n);    // the home PC's file is put back to nothing
    const again = pc('Office', 'adoe', shared, local);
    expect(await text(again.repo, 'q1')).toBe('office edit'); expect(await text(again.repo, 'q2')).toBe('office question');
    expect(val(await again.repo.sync()).waiting).toEqual([]);
  });

  it('a wait is timed from the held change, and OneDrive out of touch from when it was found, both the same after a restart', async () => {
    const { A, B } = await (async () => { const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe'); val(await A.repo.transaction({ writes: [{ ...q('q1', 'one'), expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } })); carry(A.shared, B.shared); val(await B.repo.sync()); return { A, B }; })();
    val(await B.repo.transaction({ writes: [{ ...q('q1', 'home') , expectedRev: 1 }] })); val(await B.repo.transaction({ writes: [{ ...q('q1', 'home, again'), expectedRev: 2 }] }));
    const later = [...B.shared.files.entries()].find(([n]) => n.includes(B.repo.id))!; const lines = later[1].trim().split('\n');
    const C = pc('Laptop', 'pdoe', new Mem(), new Mem()); for (const [n, t] of A.shared.files) C.shared.files.set(n, t); C.shared.files.set(later[0], lines.at(-1) + '\n');
    let touch = false; const local = new Mem();
    const first = new LogRepository({ shared: C.shared, local, label: 'Laptop', user: () => 'pdoe', clock, inTouch: () => touch });
    await first.ready(); const s1 = val(await first.sync()); expect(s1.waiting[0].since).toBe(JSON.parse(lines.at(-1)!).at); expect(s1.outOfTouchSince).toEqual(expect.any(String));
    const second = new LogRepository({ shared: C.shared, local, label: 'Laptop', user: () => 'pdoe', clock, inTouch: () => touch });
    await second.ready(); const s2 = val(await second.sync()); expect(s2.waiting[0].since).toBe(s1.waiting[0].since); expect(s2.outOfTouchSince).toBe(s1.outOfTouchSince);
    touch = true; expect(val(await second.sync()).outOfTouchSince).toBeUndefined();
  });
});
