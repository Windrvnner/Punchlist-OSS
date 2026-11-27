// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import type { ChecklistChoices } from '../../src/app/checklistKept';
import { dropImport, importKey, keepImport, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { recoveryApp } from './recoveryKit';
const key = importKey.checklist();
/** A kept import this build cannot show: its layer is not a layer (#381) */
const unreadable = {
  paste: 'Corporate records\nMaterial contracts\nLitigation',
  table: null, text: null, reads: null, review: null,
  choices: {
    mapping: { item: 0, section: null }, layer: 'not-a-layer', name: '', askReword: false, askSame: false,
    shown: false, askedFor: '', useReword: new Set(), remove: new Set(), readFailed: '', byColumns: false,
    bringIn: new Set(),
  },
};
const choices: Omit<ChecklistChoices, 'askedFor'> = {
  mapping: { item: 0, section: null }, layer: 'broad', name: '', askReword: false, askSame: false, shown: false,
  useReword: new Set(), remove: new Set(), readFailed: '', byColumns: false, bringIn: new Set(),
};

const app = recoveryApp();
const sessions: ChecklistImportSession[] = [];
function open() {
  const session = new ChecklistImportSession(app.store, {});
  sessions.push(session);
  return session;
}
describe('a kept checklist import that cannot be shown (#381)', () => {
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    dropImport(key);
  });

  it('is left as it is when the import opens, closes and opens again with nothing typed', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    const session = open();
    expect(session.view.source.paste).toBe('');
    session.close();
    expect(open().view.source.paste).toBe('');
    expect(keptImport(key)).toEqual(unreadable);
  });

  it('is replaced whole by a new paste, which then opens as a paste alone', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    const session = open();
    session.setPaste('Tax returns');
    expect(keptImport(key)).toEqual({
      paste: 'Tax returns', table: null, text: null, reads: null, review: null, choices: undefined,
    });
    session.close();
    expect(open().view.source.paste).toBe('Tax returns');
  });

  it('keeps a new paste cleared after it was typed, as typed', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    const session = open();
    session.setPaste('Tax returns');
    session.setPaste('');
    expect(keptImport(key)?.paste).toBe('');
    expect(keptImport(key)?.choices).toBeUndefined();
  });

  it('clears an unused heading when a paste replaces the saved import (#380)', async () => {
    await keptImportsReady;
    const headingDraft = { sheet: 'Main', headerRow: 1, text: '0' };
    keepImport(key, { ...unreadable, headingDraft });
    const session = open();
    expect(keptImport(key)?.headingDraft).toEqual(headingDraft);
    session.setPaste('Tax returns');
    expect(keptImport(key)).toMatchObject({ paste: 'Tax returns', headingDraft: null });
  });

  it('is replaced whole by a list read in its place', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    const session = open();
    await session.load(new File(['Item\nCorporate records'], 'list.csv'));
    expect(keptImport(key)).toMatchObject({
      paste: '', table: { name: 'list.csv', rows: [['Corporate records']] }, choices: { layer: 'broad' },
    });
  });

  it('leaves a readable kept import to be shown and kept as it changes', async () => {
    await keptImportsReady;
    keepImport(key, { paste: 'Corporate records' });
    const session = open();
    expect(session.view.source.paste).toBe('Corporate records');
    session.setPaste('');
    expect(keptImport(key)?.paste).toBe('');
  });

  it('shows a text import kept with a bare Map of readings, as an earlier build kept it (#1073)', async () => {
    await keptImportsReady;
    const old = new Map([[1, { n: 1, k: 'item', text: 'Corporate records' }]]);
    keepImport(key, { paste: 'Corporate records\nTax returns', reads: old, choices });
    expect(open().view.source).toMatchObject({ paste: 'Corporate records\nTax returns', reads: { reads: old } });
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
