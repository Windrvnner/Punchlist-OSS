// @vitest-environment node
// A list brought in is read by the model whole, in one call; a request the service refuses as too long, or a reply cut
// off, is asked again in halves. These check that the model's line numbers and ranges come back as the right lines.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';
import { TOO_LONG_REPLY, TOO_LONG_ASK } from '../../src/backend/limits';

describe('reading a list in, whole, in one call', () => {
  const isRead = (c: Call) => c.prompt.includes('Say what kind each line is');
  /** the lines a call shows, by number */
  const shown = (c: Call) => c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => Number(l.split(':')[0]));
  const many = Array.from({ length: 2000 }, (_, i) => `1.${i + 2} Item ${i + 2} is in place`);
  const list = ['1. Site', '', '1.1 Title report', 'Page 2 of 6', ...many];
  const pc = { shared: new Mem(), installId: 'pc' };
  /** a model that replies to the list read with `reply`, and to nothing else */
  const replying = (reply: unknown) => setup((c) => (isRead(c) ? reply : {}), {}, pc);
  it('shows every line of a 2,004-line list in one call and maps the ranges back to each line', async () => {
    const s = replying({ section: ['1'], item: ['3', '5-2004'], left: [4] });
    const out = val(await s.ai.readList!({ lines: list }));
    const calls = s.calls.filter(isRead);
    expect(calls.map((c) => c.model)).toEqual(['standard']);
    expect(shown(calls[0])).toEqual(list.flatMap((l, i) => (l.trim() ? [i + 1] : [])));
    expect(calls[0].prompt).not.toContain('context only');
    expect(out.lines.length).toBe(2003);
    expect(out.cells).toBeUndefined();
    const ends = [0, 1, 2, 2002].map((at) => out.lines[at]);
    expect(ends).toEqual([{ n: 1, k: 'section' }, { n: 3, k: 'item' }, { n: 4, k: 'left' }, { n: 2004, k: 'item' }]);
  });
  it('drops a line under two kinds, a blank line and a line past the list, and keeps a table\'s columns', async () => {
    const cells = { item: 2, section: '1', subsection: 'x', heading: 3, subheading: '1' };
    const s = replying({ item: ['1-4', '3000'], left: ['4'], cells });
    const out = val(await s.ai.readList!({ lines: list.slice(0, 5) }));
    expect(out.lines.map((r) => r.n)).toEqual([1, 3]);
    expect(out.cells).toEqual({ item: 2, section: 1, heading: 3, subheading: 1 });
  });
  it('takes a range written with an en dash, and no section or subsection column that is the item column', async () => {
    const s = replying({ item: ['3–5'], cells: { item: 2, section: 2, subsection: 2, heading: 2 } });
    const out = val(await s.ai.readList!({ lines: list.slice(0, 5) }));
    expect(out.lines.map((r) => r.n)).toEqual([3, 4, 5]);
    expect(out.cells).toEqual({ item: 2, heading: 2 });
  });
  it('reads the whole list on the thorough model when asked to', async () => {
    const s = replying({ left: ['1-2004'] });
    val(await s.ai.readList!({ lines: list, thorough: true }));
    const calls = s.calls.filter(isRead);
    expect(calls.map((c) => c.model)).toEqual(['thorough']);
    expect(shown(calls[0]).length).toBe(2003);
  });
  it('a reply that cannot be read fails the read, so half a list is never shown as all of it', async () => {
    expect((await replying('not JSON at all').ai.readList!({ lines: list.slice(0, 5) })).ok).toBe(false);
  });
  it('a list refused as too long is read in halves, each line named once, columns from the first part', async () => {
    const refuse = () => { throw Object.assign(new Error('too long'), { code: 'toolong' }); };
    const s = setup((c) => {
      if (!isRead(c)) return {};
      if (shown(c).length > 600) return refuse();
      return { item: shown(c).map(String), cells: shown(c)[0] === 1 ? { item: 2 } : undefined };
    }, {}, pc);
    const out = val(await s.ai.readList!({ lines: list }));
    const calls = s.calls.filter(isRead);
    expect(calls.length).toBeGreaterThan(3);
    const every = list.flatMap((l, i) => (l.trim() ? [i + 1] : []));
    expect(calls.flatMap((c) => (shown(c).length <= 600 ? shown(c) : []))).toEqual(every);
    expect(out.lines.map((r) => r.n)).toEqual(every);
    expect(out.cells).toEqual({ item: 2 });
  });
  it('a list too long even as one line fails the read, saying so', async () => {
    const refuse = () => { throw Object.assign(new Error('too long'), { code: 'toolong' }); };
    const s = setup((c) => (isRead(c) ? refuse() : {}), {}, pc);
    const r = await s.ai.readList!({ lines: list.slice(0, 5) });
    expect(r.ok ? '' : r.error.message).toBe(TOO_LONG_ASK);
  });
  it('a reply cut off at the length limit is asked again in halves, never for a shorter reply', async () => {
    const cut = () => { throw Object.assign(new Error('cut off'), { code: 'cutoff' }); };
    const s = setup((c) => (isRead(c) ? (shown(c).length > 600 ? cut() : { item: shown(c).map(String) }) : {}), {}, pc);
    const out = val(await s.ai.readList!({ lines: list }));
    const calls = s.calls.filter(isRead);
    expect(calls.every((c) => !c.prompt.includes('cut off at the length limit'))).toBe(true);
    expect(out.lines.map((r) => r.n)).toEqual(list.flatMap((l, i) => (l.trim() ? [i + 1] : [])));
  });
  it('a reply that is cut off at every size fails the read, saying so', async () => {
    const cut = () => { throw Object.assign(new Error('cut off'), { code: 'cutoff' }); };
    const s = setup((c) => (isRead(c) ? cut() : {}), {}, pc);
    const r = await s.ai.readList!({ lines: list });
    expect(r.ok ? '' : r.error.message).toBe(TOO_LONG_REPLY);
  });
});
