import { describe, it, expect } from 'vitest';
import { LogRepository } from '../../src/backend/logRepository';
import { StorageFolder } from '../../src/adapters/folders';
import { contract } from './contract';
import { refuse, quota } from './memRepo';

const at = () => '2026-11-09T10:00:00.000Z';

// The one run of the contract: on the store the desktop app and the browser demo share, with the folders the demo keeps in
// the window's storage. A second tab is a PC of its own on the same shared folder. How it behaves between PCs is in
// tests/backend/logRepository.test.ts.
contract('change files in browser storage (jsdom)', () => {
  localStorage.clear(); sessionStorage.clear();
  const shared = new StorageFolder(localStorage, 'dil/2/shared/');
  const open = (local: StorageFolder, label: string) =>
    new LogRepository({ shared, local, label, user: () => 'adoe', clock: at });
  return { repo: open(new StorageFolder(sessionStorage, 'dil/2/local/'), 'This PC'), other: () => open(new StorageFolder(localStorage, 'other-tab/'), 'Another tab'), refuseSecondWrite: () => { refuse(shared, () => true, quota, 1); } };
});

describe('a folder in browser storage', () => {
  it('lists, reads and appends its own files only, and gives sizes in bytes as a disk does', () => {
    localStorage.clear(); localStorage.setItem('elsewhere', 'x');
    const f = new StorageFolder(localStorage, 'dil/2/shared/');
    expect(f.size('a.jsonl')).toBe(-1); expect(f.read('a.jsonl')).toBeNull();
    f.append('a.jsonl', 'one\n'); f.append('a.jsonl', 'twö\n');
    expect(f.read('a.jsonl')).toBe('one\ntwö\n'); expect(f.size('a.jsonl')).toBe(9); expect(f.list()).toEqual(['a.jsonl']);
    f.clear(); expect(f.list()).toEqual([]); expect(localStorage.getItem('elsewhere')).toBe('x');
  });
});

import { mockDocuments } from '../../src/adapters/mocks';
describe('mock document service', () => {
  it('indexes to completion and announces once', async () => {
    let announced = 0;
    const docs = mockDocuments({ latency: [0, 0], onIndexed: () => { announced++; } });
    const started = await docs.index('d1', [{ path: 'a', label: 'A', files: 40, size: '0.1 GB', indexed: 0, reviewed: 0 }]);
    expect(started.ok).toBe(true);
    let done = false; let polls = 0;
    while (!done && polls++ < 60) { const p = await docs.poll('d1'); expect(p.ok).toBe(true); if (p.ok) done = p.value.done; }
    expect(done).toBe(true); expect(announced).toBe(1);
    await docs.poll('d1'); expect(announced).toBe(1);
  });
});
