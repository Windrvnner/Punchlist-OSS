// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import type { ChecklistChoices } from '../../src/app/checklistKept';
import { dropImport, importKey, keepImport, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { recoveryApp } from './recoveryKit';
const key = importKey.checklist();
const choices: Omit<ChecklistChoices, 'askedFor'> = {
  mapping: { item: 0, section: null }, layer: 'broad', name: '', askReword: false, askSame: false, shown: false,
  useReword: new Set(), remove: new Set(), readFailed: '', byColumns: false, bringIn: new Set(),
};

const app = recoveryApp();
const sessions: ChecklistImportSession[] = [];
function open(fresh = false) {
  const session = new ChecklistImportSession(app.store, { fresh });
  sessions.push(session);
  return session;
}
describe('a kept checklist import the session sets aside or reads again', () => {
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    dropImport(key);
  });

  it('leaves a set-aside draft intact until the person types or accepts a new source', async () => {
    await keptImportsReady;
    keepImport(key, { paste: 'Earlier paste', review: { damaged: true } });
    const session = open(true);
    expect(session.view.source.paste).toBe('');
    session.close();
    expect(keptImport(key)).toEqual({ paste: 'Earlier paste', review: { damaged: true } });
    open().setPaste('  Provide tax returns.  ');
    expect(keptImport(key)).toMatchObject({ paste: '  Provide tax returns.  ', review: null, choices: undefined });
  });

  it('reads a table import kept with a bare Map again, keeping its table and choices, not leaving its rows out (#1073)',
    async () => {
      await keptImportsReady;
      const old = new Map([[2, { n: 2, k: 'item', text: 'Corporate records' }]]);
      const table = { name: 'list.csv', columns: ['Item'], rows: [['Corporate records']], bytes: new Uint8Array(1) };
      keepImport(key, { paste: 'a', table, reads: old, choices });
      const session = open();
      expect(session.view.source).toMatchObject({ table, reads: null });
      expect(session.view.target.layer).toBe('broad');
      await session.start();
      expect(session.view.source.reads).toBeTruthy();
    });
});
