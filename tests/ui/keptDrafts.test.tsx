// @vitest-environment jsdom
// Drafts kept across a restart: kept in storage as they change, read back at start, checked entry by entry.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'dil/1/kept-drafts';
const load = async () => { vi.resetModules(); return import('../../src/ui/keptDrafts'); };
beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe('drafts kept across a restart', () => {
  it('come back after the page goes, and are still there after a second start that ends in a crash', async () => {
    let k = await load();
    k.keptDrafts('test-notes', k.hasTexts('text')).set('f_1', { text: 'Confirmed with counsel' });
    window.dispatchEvent(new Event('pagehide'));
    k = await load();                                   // started again: the note is back
    expect(k.keptDrafts('test-notes', k.hasTexts('text')).get('f_1')).toEqual({ text: 'Confirmed with counsel' });
    k = await load();                                   // that session died with no page-hide: the note is still kept
    expect(k.keptDrafts('test-notes', k.hasTexts('text')).get('f_1')).toEqual({ text: 'Confirmed with counsel' });
  });

  it('are written shortly after each change, with no page-hide, and a draft taken away goes from storage too', async () => {
    vi.useFakeTimers();
    const k = await load();
    const m = k.keptDrafts('test-text', k.isText);
    m.set('d_1', 'What does the lock-up test?');
    expect(localStorage.getItem(KEY)).toBe(null);
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ 'test-text': [['d_1', 'What does the lock-up test?']] });
    m.delete('d_1'); vi.advanceTimersByTime(1000);
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  it('move to a deleted deal’s copy: those kept now, and any put later under the old ids, marked so the field asks', async () => {
    const k = await load();
    const m = k.keptDrafts('test-field', k.hasTexts('text', 'base'));
    m.set('q_old:response', { text: 'Typed before the copy', base: '' }); m.set('q_other:response', { text: 'Not moved', base: '' });
    k.renameKept({ q_old: 'q_new', d_old: 'd_new' }, (v) => ({ ...(v as object), stale: true }));
    expect([...m.entries()]).toEqual([['q_other:response', { text: 'Not moved', base: '' }], ['q_new:response', { text: 'Typed before the copy', base: '', stale: true }]]);
    m.set('d_old:name', { text: 'Put as the page went', base: '' });
    expect(m.get('d_new:name')).toEqual({ text: 'Put as the page went', base: '', stale: true });
    expect(m.get('d_old:name')).toEqual(m.get('d_new:name'));          // the old field, still on screen, finds it, and can take it away
    m.delete('d_old:name'); expect(m.has('d_new:name')).toBe(false);
  });

  it('moves a question’s original finding with its item when a deal is recovered', async () => {
    let drafts = await load();
    const targets = drafts.keptDrafts('checklist-ask-on', drafts.isText, (id, moved) => moved.get(id) ?? id);
    targets.set('deal:item', 'original');
    drafts.renameKept({ deal: 'copy', item: 'copied-item', original: 'copied-finding' });
    expect(targets.get('copy:copied-item')).toBe('copied-finding');
    targets.set('deal:item', 'original');
    drafts.saveKeptDrafts();
    drafts = await load();
    expect(drafts.keptDrafts('checklist-ask-on', drafts.isText).get('copy:copied-item')).toBe('copied-finding');
  });

  it('keep what a map not made yet this session left', async () => {
    localStorage.setItem(KEY, JSON.stringify({ 'test-later': [['a', 'left']] }));
    const k = await load();
    k.keptDrafts('test-text', k.isText).set('b', 'new');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ 'test-later': [['a', 'left']], 'test-text': [['b', 'new']] });
  });

  it('drop an entry not of the map’s shape and keep the rest; unreadable storage brings nothing back', async () => {
    localStorage.setItem(KEY, JSON.stringify({ 'test-text': [['a', 'kept'], ['b', 42], ['c'], 'x'] }));
    let k = await load();
    expect([...k.keptDrafts('test-text', k.isText).entries()]).toEqual([['a', 'kept']]);
    localStorage.setItem(KEY, '{not json');
    k = await load();
    expect(k.keptDrafts('test-text', k.isText).size).toBe(0);
  });
});
