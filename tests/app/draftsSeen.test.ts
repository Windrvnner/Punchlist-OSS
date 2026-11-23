/** When this PC first saw another PC's pending drafts, kept per deal on this PC (#24). */
import { describe, it, expect } from 'vitest';
import { seenSince } from '../../src/app/draftsSeen';
import { MemoryLocal } from '../../src/adapters/local';
import type { LocalStore } from '../../src/ports';

const DEAL = 'deal_1';
const KEY = `draftsSeen:${DEAL}`;

describe('seenSince', () => {
  it('keeps the first sighting, counts a new one as now, and keeps only the drafts asked about', () => {
    const local = new MemoryLocal();
    expect([...seenSince(local, DEAL, ['a', 'b'], 1_000)]).toEqual([['a', 1_000], ['b', 1_000]]);
    expect([...seenSince(local, DEAL, ['b', 'c'], 5_000)]).toEqual([['b', 1_000], ['c', 5_000]]);
    expect(local.read(KEY)).toEqual({ b: 1_000, c: 5_000 });
    seenSince(local, DEAL, [], 9_000);
    expect(local.read(KEY)).toEqual({});
  });

  it('counts a time after now (the clock was put back) or a damaged entry as now', () => {
    const local = new MemoryLocal();
    local.write(KEY, { a: 50_000, b: 'yesterday', c: null });
    expect([...seenSince(local, DEAL, ['a', 'b', 'c'], 2_000)]).toEqual([['a', 2_000], ['b', 2_000], ['c', 2_000]]);
    local.write(KEY, 'not a list');
    expect(seenSince(local, DEAL, ['a'], 3_000).get('a')).toBe(3_000);
  });

  it('a local store that cannot be read or written still gives every draft its time', () => {
    const broken: LocalStore = {
      read: () => { throw new Error('unreadable'); },
      write: () => { throw new Error('full'); },
    };
    expect([...seenSince(broken, DEAL, ['a'], 7_000)]).toEqual([['a', 7_000]]);
  });

  it('300 drafts pending elsewhere are written once, then not again while nothing changes', () => {
    const local = new MemoryLocal(); let writes = 0;
    const counting: LocalStore = {
      read: (k) => local.read(k),
      write: (k, v) => { writes++; return local.write(k, v); },
    };
    const ids = Array.from({ length: 300 }, (_, i) => `op_${i}`);
    seenSince(counting, DEAL, ids, 1_000);
    for (let n = 0; n < 10; n++) seenSince(counting, DEAL, ids, 1_000 + n * 20_000);
    expect(writes).toBe(1);
  });
});
