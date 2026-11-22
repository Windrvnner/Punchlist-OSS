// The journal entry that travels with a change says "succeeded" only once the line is written. A save that fails
// or is cut off leaves it pending, for the next start to offer; one whose line is found written is marked succeeded.
import { describe, it, expect } from 'vitest';
import { memRepo, disk, refuse, Mem } from '../adapters/memRepo';

let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 17, 9, 0, 0, t++)).toISOString();
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const pending = (id: string) => ({ writes: [{ kind: 'op' as const, id, data: { state: 'pending' }, expectedRev: null }] });
/** a change to question `q` with its journal entry, as the Store sends one */
const edit = (q: string, text: string, op: string, rev: number | null) => ({ writes: [{ kind: 'question' as const, id: q, data: { dealId: 'd1', text }, expectedRev: rev }, { kind: 'op' as const, id: op, data: { state: 'succeeded' }, expectedRev: 1 }], index: { dealId: 'd1', add: [{ kind: 'question' as const, id: q }] } });
const state = async (repo: ReturnType<typeof memRepo>, op: string) => (val(await repo.get('op', op))!.envelope.data as { state: string }).state;
const text = async (repo: ReturnType<typeof memRepo>, q: string) => (val(await repo.get('question', q))?.envelope.data as { text: string } | undefined)?.text;
/** a deal's worth of questions, so the files are not three lines long */
async function filled(d = disk()) { const repo = memRepo(clock, d); for (let i = 0; i < 400; i++) val(await repo.transaction({ writes: [{ kind: 'question', id: `q${i}`, data: { dealId: 'd1', text: `Question ${i}` }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: `q${i}` }] } })); return { repo, d }; }
const journal = (m: Mem) => JSON.parse(m.files.get('ops.json') ?? '{}');

describe('the journal entry that travels with a change', () => {
  it('stays pending when the shared folder refuses the line, on disk and after a restart', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    refuse(d.shared, () => true, () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
    const r = await repo.transaction(edit('q5', 'changed', 'op1', 1));
    expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(journal(d.local)['dil/1/op/op1']).toMatchObject({ rev: 1, data: { state: 'pending' } });
    const again = memRepo(clock, { shared: Object.assign(new Mem(), { files: d.shared.files }), local: d.local });
    expect(await state(again, 'op1')).toBe('pending'); expect(await text(again, 'q5')).toBe('Question 5');
  });

  it('stays pending when this PC’s own copy refuses the line', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    refuse(d.local, () => true, () => new Error('EIO'));
    const r = await repo.transaction(edit('q5', 'changed', 'op1', 1));
    expect(!r.ok && r.error.kind).toBe('failed'); expect(await state(repo, 'op1')).toBe('pending');
  });

  it('is still checked before anything is written: an entry that is not as expected refuses the change', async () => {
    const { repo, d } = await filled(); const before = [...d.shared.files.values()].join('').length;
    const r = await repo.transaction(edit('q5', 'changed', 'never-journaled', 1));
    expect(!r.ok && r.error.kind).toBe('conflict'); expect([...d.shared.files.values()].join('').length).toBe(before); expect(await text(repo, 'q5')).toBe('Question 5');
  });

  it('says succeeded once the line is written, at rev 2', async () => {
    const { repo } = await filled(); val(await repo.transaction(pending('op1')));
    const revs = val(await repo.transaction(edit('q5', 'changed', 'op1', 1)));
    expect(revs.op1).toBe(2); expect(await state(repo, 'op1')).toBe('succeeded'); expect(await text(repo, 'q5')).toBe('changed');
  });

  it('a journal that cannot be written after the line is: the change is made and reported as made, and the next start marks the entry succeeded', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    const write = d.local.write.bind(d.local); d.local.write = (n, x) => { if (n === 'ops.json') throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); write(n, x); };
    val(await repo.transaction(edit('q5', 'changed', 'op1', 1)));
    expect(await text(repo, 'q5')).toBe('changed'); expect(journal(d.local)['dil/1/op/op1'].data.state).toBe('pending');
    d.local.write = write;
    const again = memRepo(clock, d);
    expect(await state(again, 'op1')).toBe('succeeded'); expect(journal(d.local)['dil/1/op/op1'].data.state).toBe('succeeded'); expect(await text(again, 'q5')).toBe('changed');
  });

  it('a journal still busy at the next start: the entry reads as succeeded meanwhile (no Retry that would make it twice), and is written once the journal opens', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    const write = d.local.write.bind(d.local); let busy = true;
    d.local.write = (n, x) => { if (n === 'ops.json' && busy) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); write(n, x); };
    val(await repo.transaction(edit('q5', 'changed', 'op1', 1)));
    const again = memRepo(clock, d);
    expect(await state(again, 'op1')).toBe('succeeded'); expect(journal(d.local)['dil/1/op/op1'].data.state).toBe('pending');
    busy = false; val(await again.transaction(pending('op2')));
    expect(journal(d.local)['dil/1/op/op1']).toMatchObject({ rev: 2, data: { state: 'succeeded' } }); expect(await state(memRepo(clock, d), 'op1')).toBe('succeeded');
  });

  it('a read of the journal refused for a moment is not an empty journal: the next write keeps every entry', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('keep1'))); val(await repo.transaction(pending('keep2')));
    const read = d.local.read.bind(d.local); let busy = 1;
    d.local.read = (n) => { if (n === 'ops.json' && busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return read(n); };
    val(await repo.transaction(pending('new')));
    expect(Object.keys(journal(d.local)).sort()).toEqual(['dil/1/op/keep1', 'dil/1/op/keep2', 'dil/1/op/new']);
    // and at a start, with nothing read yet: the journal is not written over
    busy = 99; const again = memRepo(clock, d);
    expect((await again.transaction(pending('later'))).ok).toBe(false); expect((await again.list('op')).ok).toBe(false);
    expect(Object.keys(journal(d.local)).sort()).toEqual(['dil/1/op/keep1', 'dil/1/op/keep2', 'dil/1/op/new']);
    busy = 0; val(await again.transaction(pending('later'))); expect(Object.keys(journal(d.local))).toHaveLength(4);
  });

  it('a journal file cut off part way is not taken as empty: its whole entries are kept, and a copy of it as it was is kept aside', async () => {
    const { repo, d } = await filled(); for (const id of ['keep1', 'keep2', 'keep3']) val(await repo.transaction(pending(id)));
    const was = d.local.files.get('ops.json')!; const cut = was.slice(0, was.length - 20); d.local.files.set('ops.json', cut);   // keep3 cut off part way
    const again = memRepo(clock, d);
    expect(val(await again.list('op')).map((e) => e.id).sort()).toEqual(['keep1', 'keep2']);
    val(await again.transaction(pending('new')));
    expect(Object.keys(journal(d.local)).sort()).toEqual(['dil/1/op/keep1', 'dil/1/op/keep2', 'dil/1/op/new']);
    const aside = [...d.local.files].filter(([n]) => n.startsWith('ops.damaged-'));
    expect(aside).toHaveLength(1); expect(aside[0][0]).toMatch(/^ops\.damaged-[0-9TZ-]+\.json$/); expect(aside[0][1]).toBe(cut);
    // written whole again, nothing more is set aside
    val(await again.transaction(pending('later'))); expect([...d.local.files.keys()].filter((n) => n.startsWith('ops.damaged-'))).toHaveLength(1);
  });

  it('a journal written over in part: every whole entry around the damage is kept, and it is not written over while no copy can be kept aside', async () => {
    const { repo, d } = await filled(); for (const id of ['a', 'b', 'c', 'd']) val(await repo.transaction(pending(id)));
    const was = d.local.files.get('ops.json')!; const b = was.indexOf('"dil/1/op/b"'); const c = was.indexOf('"dil/1/op/c"');
    const damaged = was.slice(0, b + 30) + '\0'.repeat(c - b - 30) + was.slice(c); d.local.files.set('ops.json', damaged);   // b written over with zeros
    const write = d.local.write.bind(d.local); let full = true;
    d.local.write = (n, x) => { if (n.startsWith('ops.damaged-') && full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); write(n, x); };
    const again = memRepo(clock, d);
    expect(val(await again.list('op')).map((e) => e.id).sort()).toEqual(['a', 'c', 'd']);
    const r = await again.transaction(pending('new')); expect(!r.ok && r.error.kind).toBe('storageFull');
    expect(d.local.files.get('ops.json')).toBe(damaged);
    full = false; val(await again.transaction(pending('new')));
    expect(Object.keys(journal(d.local)).sort()).toEqual(['dil/1/op/a', 'dil/1/op/c', 'dil/1/op/d', 'dil/1/op/new']);
    expect([...d.local.files].filter(([n]) => n.startsWith('ops.damaged-')).map(([, t]) => t)).toEqual([damaged]);
  });

  it('an entry that lost a closing brace does not take the entries after it with it', async () => {
    const { repo, d } = await filled(); for (const id of ['a', 'b', 'c']) val(await repo.transaction(pending(id)));
    const was = d.local.files.get('ops.json')!; const end = was.indexOf(',"dil/1/op/b"');
    d.local.files.set('ops.json', was.slice(0, end - 1) + was.slice(end));                      // a's last brace gone
    expect(val(await memRepo(clock, d).list('op')).map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('a journal that parses but holds an entry that does not read: the copy as it was is kept aside before it is written', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('ok'))); val(await repo.transaction(pending('bad')));
    const j = journal(d.local); j['dil/1/op/bad'] = { rev: 'x' }; const damaged = JSON.stringify(j); d.local.files.set('ops.json', damaged);
    const again = memRepo(clock, d); val(await again.transaction(pending('new')));
    expect(Object.keys(journal(d.local)).sort()).toEqual(['dil/1/op/new', 'dil/1/op/ok']);
    expect([...d.local.files].filter(([n]) => n.startsWith('ops.damaged-')).map(([, t]) => t)).toEqual([damaged]);
  });

  it('power lost with the line in this PC’s copy only: the next start puts the line in the shared folder and marks the entry succeeded', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    const name = [...d.shared.files.keys()].find((n) => n.includes('-d1-'))!; const was = d.shared.files.get(name)!;
    val(await repo.transaction(edit('q5', 'changed', 'op1', 1)));
    // as the disk was when the power went: the line in the local copy, not in the shared one, the journal not yet settled
    d.shared.files.set(name, was); d.local.files.set('ops.json', JSON.stringify({ 'dil/1/op/op1': { schema: 1, kind: 'op', rev: 1, updatedAt: clock(), data: { state: 'pending' } } }));
    const again = memRepo(clock, d);
    expect(await text(again, 'q5')).toBe('changed'); expect(await state(again, 'op1')).toBe('succeeded');
  });

  it('power lost with half the line in this PC’s copy and nothing shared: the entry is pending at the next start, and the question as it was', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1')));
    const name = [...d.local.files.keys()].find((n) => n.includes('-d1-'))!; const was = d.local.files.get(name)!;
    const working = {
      list: d.local.list.bind(d.local), size: d.local.size.bind(d.local), read: d.local.read.bind(d.local),
      append: d.local.append.bind(d.local), write: d.local.write.bind(d.local),
    };
    let poweredOff = false;
    const stillOn = () => { if (poweredOff) throw new Error('power lost'); };
    // After the partial append no cleanup can run: this models a stopped PC, not a recoverable write error.
    d.local.list = () => {
      stillOn();
      return working.list();
    };
    d.local.size = (name) => {
      stillOn();
      return working.size(name);
    };
    d.local.read = (name) => {
      stillOn();
      return working.read(name);
    };
    d.local.write = (name, value) => {
      stillOn();
      working.write(name, value);
    };
    d.local.append = (name, value) => {
      stillOn();
      working.append(name, value.slice(0, Math.floor(value.length / 2)));
      poweredOff = true;
      throw new Error('power lost');
    };
    await repo.transaction(edit('q5', 'changed', 'op1', 1)).catch(() => undefined);
    Object.assign(d.local, working);
    expect(d.local.files.get(name)!.length).toBeGreaterThan(was.length);
    const again = memRepo(clock, d);
    expect(await state(again, 'op1')).toBe('pending'); expect(await text(again, 'q5')).toBe('Question 5');
    // and the next change goes on a line of its own
    val(await again.transaction(pending('op2'))); val(await again.transaction(edit('q6', 'after', 'op2', 1))); expect(await text(memRepo(clock, d), 'q6')).toBe('after');
  });

  it('an entry settled in an earlier run is left alone, and another PC’s line naming the same entry settles nothing here', async () => {
    const { repo, d } = await filled(); val(await repo.transaction(pending('op1'))); val(await repo.transaction(pending('op2')));
    val(await repo.transaction(edit('q5', 'changed', 'op1', 1)));
    const other = memRepo(clock, { shared: d.shared, local: new Mem() }); val(await other.transaction(pending('op2'))); val(await other.transaction(edit('q7', 'theirs', 'op2', 1)));
    const again = memRepo(clock, d);
    expect(await state(again, 'op1')).toBe('succeeded'); expect(val(await again.get('op', 'op1'))!.rev).toBe(2); expect(await state(again, 'op2')).toBe('pending');
  });
});
