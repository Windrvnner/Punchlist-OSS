// @vitest-environment jsdom
// An import in progress kept on this PC. jsdom has no IndexedDB, so this checks the kept parts in memory;
// the browser checks (lostwork, issueslist, firmlist) check them across a reload in Chrome's own IndexedDB.
import { describe, it, expect, vi } from 'vitest';

const load = async () => { vi.resetModules(); return import('../../src/ui/keptImports'); };

describe('an import kept as it was left', () => {
  it('is ready at once without IndexedDB, and keeps each part as handed over', async () => {
    const k = await load(); await k.keptImportsReady;
    const table = { rows: Array.from({ length: 2000 }, (_, i) => [`Question ${i + 1}`]) };
    k.keepImport('qa:d_1', { table, choices: { mode: 'append' } });
    expect(k.keptImport('qa:d_1')?.table).toBe(table);
    // a later change hands over the whole state again: the table is the same value, and only the choices change
    k.keepImport('qa:d_1', { table, choices: { mode: 'merge' } });
    expect(k.keptImport('qa:d_1')).toEqual({ table, choices: { mode: 'merge' } });
  });

  it('keeps a part left out as it was, so a paste alone does not take the list it came from', async () => {
    const k = await load();
    k.keepImport(k.importKey.checklist(), { paste: 'Insurance is in place', text: { lines: ['a'] } });
    k.keepImport(k.importKey.checklist(), { paste: 'Insurance is in place\nSurvey delivered' });
    expect(k.keptImport(k.importKey.checklist())).toEqual({ paste: 'Insurance is in place\nSurvey delivered', text: { lines: ['a'] } });
  });

  it('is per deal, and dropping one lets only that one go', async () => {
    const k = await load();
    k.keepImport(k.importKey.issues('d_1'), { kept: new Set([2]) }); k.keepImport(k.importKey.issues('d_2'), { kept: new Set([5]) });
    k.dropImport(k.importKey.issues('d_1'));
    expect(k.keptImport(k.importKey.issues('d_1'))).toBeUndefined();
    expect(k.keptImport(k.importKey.issues('d_2'))?.kept).toEqual(new Set([5]));
    k.dropImport('none');   // nothing kept: nothing happens
  });
});
