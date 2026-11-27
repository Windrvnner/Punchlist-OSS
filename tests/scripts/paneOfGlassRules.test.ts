// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the script is plain JavaScript
import { matchesIn } from '../../scripts/pane-of-glass-matches.mjs';

const file = 'src/ui/x.tsx';
const kinds = ['timer', 'list', 'loop', 'limit', 'date', 'pattern'];

function newKinds(source: string) {
  const found: Record<string, number[]> = matchesIn(file, source);
  return Object.fromEntries(Object.entries(found).filter(([kind]) => kinds.includes(kind)));
}

describe('pane-of-glass rule kinds', () => {
  it.each([
    ['window.setTimeout(save, 500);', 'timer'],
    ['const wait = setTimeout;', 'timer'],
    ['const { setTimeout: wait } = window;', 'timer'],
    ['requestIdleCallback(run);', 'timer'],
    ['toasts.slice(-3);', 'list'],
    ['text.slice(0, end);', 'list'],
    ['for (const r of rows) if (r.open) n++;', 'loop'],
    ['while (more()) next();', 'loop'],
    ['const tooLong = name.length <= 32;', 'limit'],
    ['const input = <input maxLength={80} />;', 'limit'],
    ['const input = <input min="1" max={9} />;', 'limit'],
    ['const over = x.length > LISTED;', 'limit'],
    ['Date.parse(s);', 'date'],
    ['new Date(value);', 'date'],
    ['/^\\d{4}-\\d{2}-\\d{2}$/.test(v);', 'pattern'],
    ['new RegExp(s);', 'pattern'],
    ['RegExp(s);', 'pattern'],
  ])('records %s as %s on line 1', (source, kind) => {
    expect(newKinds(source)[kind]).toEqual([1]);
  });

  it.each([
    'const empty = x.length === 0;',
    'const input = <input maxLength={limit} />;',
    'new Date();',
    'let fade: ReturnType<typeof setTimeout>;',
    '// setTimeout(save, 500) rows.filter(a)\nconst name = "setTimeout";',
  ])('records nothing for %s', (source) => {
    expect(newKinds(source)).toEqual({});
  });

  it('counts each call of a chain on its own line', () => {
    expect(newKinds('rows\n  .filter(a)\n  .slice(0, 3);').list).toEqual([2, 3]);
  });

  it('keeps the existing kinds running beside the new ones', () => {
    const found = matchesIn(file, 'localStorage.getItem("a");\nfetch(url).then(x => x.slice(1));');
    expect(found.storage).toEqual([1]);
    expect(found.network).toEqual([2]);
    expect(found.list).toEqual([2]);
  });

  it('counts the UI tree on main as the spec does', () => {
    const totals: Record<string, number> = {};
    const sources = readdirSync('src/ui', { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'));
    for (const name of sources) {
      const found = matchesIn(`src/ui/${name}`, readFileSync(path.join('src/ui', name), 'utf8'));
      for (const kind of kinds) totals[kind] = (totals[kind] ?? 0) + (found[kind]?.length ?? 0);
    }
    expect(totals).toEqual({ timer: 14, list: 180, loop: 49, limit: 57, date: 11, pattern: 43 });
  });
});
