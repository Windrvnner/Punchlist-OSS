// @vitest-environment node
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
    ['const input = <input max={9} />;', 'limit'],
    ['const over = x.length > LISTED;', 'limit'],
    ['Date.parse(s);', 'date'],
    ['new Date(value);', 'date'],
    ['/^\\d{4}-\\d{2}-\\d{2}$/.test(v);', 'pattern'],
    ['new RegExp(s);', 'pattern'],
    ['RegExp(s);', 'pattern'],
    ['window["setTimeout"](save, 500);', 'timer'],
    ['const { "setTimeout": wait } = window;', 'timer'],
    ['if (typeof setTimeout === "function") run();', 'timer'],
    ['rows["filter"](keep);', 'list'],
    ['Date["now"]();', 'date'],
    ['globalThis.Date.now();', 'date'],
    ['new window.Date(value);', 'date'],
    ['window.RegExp(s);', 'pattern'],
    ['new window.RegExp(s);', 'pattern'],
    ['const more = i < rows.length - 1;', 'limit'],
    ['const more = rows.length + 1 >= i;', 'limit'],
    ['const input = <input maxlength={80} />;', 'limit'],
    ['const input = <input minlength="3" />;', 'limit'],
    ['const input = <input max={-1} />;', 'limit'],
    ['const input = <input min="1" />;', 'limit'],
    ['async function f() { for await (const x of xs) use(x); }', 'loop'],
  ])('records %s as %s on line 1', (source, kind) => {
    expect(newKinds(source)[kind]).toEqual([1]);
  });

  it.each([
    'const empty = x.length === 0;',
    'const input = <input maxLength={limit} />;',
    'new Date();',
    'let fade: ReturnType<typeof setTimeout>;',
    'type T = typeof window.setTimeout;',
    'window[name](save);',
    'const more = i < rows.length * 2;',
    'const input = <input min="abc" />;',
    '// setTimeout(save, 500) rows.filter(a)\nconst name = "setTimeout";',
  ])('records nothing for %s', (source) => {
    expect(newKinds(source)).toEqual({});
  });

  it('counts each call of a chain on its own line', () => {
    expect(newKinds('rows\n  .filter(a)\n  .slice(0, 3);').list).toEqual([2, 3]);
  });

  it('records two limit attributes on one element once each, on the same line', () => {
    expect(newKinds('const input = <input min="1" max={9} />;').limit).toEqual([1, 1]);
  });

  it('keeps the existing kinds running beside the new ones', () => {
    const found = matchesIn(file, 'localStorage.getItem("a");\nfetch(url).then(x => x.slice(1));');
    expect(found.storage).toEqual([1]);
    expect(found.network).toEqual([2]);
    expect(found.list).toEqual([2]);
  });
});
