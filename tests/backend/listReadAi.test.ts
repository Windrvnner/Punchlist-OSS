// @vitest-environment node
// A list brought in is read by the model whole, in one call; a request the service refuses as too long, or a reply cut
// off, is asked again in halves. These check that the model's line numbers and ranges come back as the right lines.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';
import { TOO_LONG_REPLY, TOO_LONG_ASK } from '../../src/backend/limits';

describe('reading a list in, whole, in one call', () => {
  const isRead = (c: Call) => c.prompt.includes('Say what kind each line is');
  /** the lines a call shows, by number */
  const shown = (c: Call) => c.prompt.split('\n').flatMap((l) => {
    const handle = /^\[L(\d+)\] /.exec(l);
    return handle ? [Number(handle[1])] : [];
  });
  const handles = (ns: number[]) => ns.map((n) => `L${n}`);
  const many = Array.from({ length: 2000 }, (_, i) => `1.${i + 2} Item ${i + 2} is in place`);
  const list = ['1. Site', '', '1.1 Title report', 'Page 2 of 6', ...many];
  const pc = { shared: new Mem(), installId: 'pc' };
  /** a model that replies to the list read with `reply`, and to nothing else */
  const replying = (reply: unknown) => setup((c) => (isRead(c) ? reply : {}), {}, pc);
  it('shows every line of a 2,004-line list in one call and maps the ranges back to each line', async () => {
    const s = replying({ lines: { section: ['L1'], item: ['L3', 'L5-L2004'], left: ['L4'] } });
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
    const columns = { item: 2, section: '1', subsection: 'x', heading: 3, subheading: '1' };
    const s = replying({ lines: { item: ['L1-L4', 'L3000'], left: ['L4'] }, columns });
    const out = val(await s.ai.readList!({ lines: list.slice(0, 5) }));
    expect(out.lines.map((r) => r.n)).toEqual([1, 3]);
    expect(out.cells).toEqual({ item: 2, section: 1, heading: 3, subheading: 1 });
  });
  it('takes no section or subsection column that is the item column', async () => {
    const s = replying({ lines: { item: ['L3-L5'] }, columns: { item: 2, section: 2, subsection: 2, heading: 2 } });
    const out = val(await s.ai.readList!({ lines: list.slice(0, 5) }));
    expect(out.lines.map((r) => r.n)).toEqual([3, 4, 5]);
    expect(out.cells).toEqual({ item: 2, heading: 2 });
  });
  it('reads the whole list on the thorough model when asked to', async () => {
    const s = replying({ lines: { left: ['L1-L2004'] } });
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
      return { lines: { item: handles(shown(c)) }, columns: shown(c)[0] === 1 ? { item: 2 } : undefined };
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
    const answer = (c: Call) => (shown(c).length > 600 ? cut() : { lines: { item: handles(shown(c)) } });
    const s = setup((c) => (isRead(c) ? answer(c) : {}), {}, pc);
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
  it('gives each line a handle no line\'s own text can be taken for, and says what it is', async () => {
    const lines = ['1.2 Title report', 'Q1 2026 audited accounts', '3', '[L3] odd line'];
    const s = replying({ lines: { item: ['L1', 'L2'], left: ['L3'], section: ['L4'] } });
    const out = val(await s.ai.readList!({ lines }));
    const prompt = s.calls.filter(isRead)[0].prompt;
    expect(prompt).toContain('[L1] 1.2 Title report');
    expect(prompt).toContain('[L2] Q1 2026 audited accounts');
    expect(prompt).toMatch(/handle.*square brackets/);
    expect(out.lines).toEqual([{ n: 1, k: 'item' }, { n: 2, k: 'item' }, { n: 3, k: 'left' }, { n: 4, k: 'section' }]);
  });
  it('takes a handle only as the prompt gives it: a bare number or another range form is no line', async () => {
    const lines = ['1.2 Title report', 'Q1 2026 audited accounts', 'Third', 'Fourth', 'Fifth'];
    const reply = { lines: { item: ['1', '2', 'l3', 'L4–L5', 'L4 to L5', 'L5-L4'], left: ['L1-L2'] } };
    const out = val(await replying(reply).ai.readList!({ lines }));
    expect(out.lines).toEqual([{ n: 1, k: 'left' }, { n: 2, k: 'left' }]);
  });
  it('asks for a range in exactly one form, and the columns apart from the lines', async () => {
    const s = replying({ lines: {} });
    await s.ai.readList!({ lines: ['a', 'b'] });
    const prompt = s.calls.filter(isRead)[0].prompt;
    expect(prompt).toContain('"L4-L39"');
    expect(prompt).not.toMatch(/en dash|\bto\b L\d/);
    expect(prompt).toContain('"columns"');
  });
  it('makes no call for a half that holds only blank lines', async () => {
    const refuse = () => { throw Object.assign(new Error('too long'), { code: 'toolong' }); };
    const blanks = ['Item one', 'Item two', ...Array.from({ length: 6 }, () => '')];
    const s = setup((c) => (isRead(c) ? (shown(c).length > 1 ? refuse() : { lines: { item: handles(shown(c)) } }) : {}),
      {}, pc);
    const out = val(await s.ai.readList!({ lines: blanks }));
    const asked = s.calls.filter(isRead).map((c) => shown(c));
    expect(asked.every((shownLines) => shownLines.length > 0)).toBe(true);
    expect(out.lines.map((r) => r.n)).toEqual([1, 2]);
  });
});
