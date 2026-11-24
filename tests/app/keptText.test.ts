// @vitest-environment node
// Drafts kept across a restart: kept in storage as they change, read back at start, checked entry by entry.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { fail } from '../../src/domain/result';
import { KEPT_TEXT_KEY } from '../../src/ports';

let local: MemoryLocal;
const fresh = () => {
  vi.resetModules();
  return import('../../src/app/keptText');
};
const load = async () => {
  const drafts = await fresh();
  drafts.initializeKeptText(local);
  return drafts;
};
beforeEach(() => {
  vi.useRealTimers();
  local = new MemoryLocal();
});

describe('drafts kept across a restart', () => {
  it('come back after a flush, and are still there after a second start that ends in a crash', async () => {
    let k = await load();
    k.keptDrafts('test-notes', k.hasTexts('text')).set('f_1', { text: 'Confirmed with counsel' });
    k.saveKeptDrafts();
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
    expect(local.read(KEPT_TEXT_KEY)).toBe(null);
    vi.advanceTimersByTime(1000);
    expect(local.read(KEPT_TEXT_KEY)).toEqual({ 'test-text': [['d_1', 'What does the lock-up test?']] });
    m.delete('d_1'); vi.advanceTimersByTime(1000);
    expect(local.read(KEPT_TEXT_KEY)).toBe(null);
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
    const original = drafts.keptChecklistQuestions.open('deal:item');
    original.begin('original');
    original.write('Which ratio applies?');
    drafts.renameKept({ deal: 'copy', item: 'copied-item', original: 'copied-finding' });
    expect(drafts.keptChecklistQuestions.open('copy:copied-item').findingId).toBe('copied-finding');
    original.write('Which lock-up ratio applies?');
    drafts.saveKeptDrafts();
    drafts = await load();
    const reopened = drafts.keptChecklistQuestions.open('copy:copied-item');
    expect(reopened.findingId).toBe('copied-finding');
    expect(reopened.text).toBe('Which lock-up ratio applies?');
  });

  it('keeps an edit from the original Checklist card on its finding after two recoveries', async () => {
    let drafts = await load();
    const original = drafts.keptChecklistQuestions.open('deal:item');
    original.begin('finding');
    original.write('Which ratio applies?');
    drafts.renameKept({ deal: 'copy', item: 'copied-item', finding: 'copied-finding' });
    drafts.renameKept({ copy: 'latest', 'copied-item': 'latest-item', 'copied-finding': 'latest-finding' });
    original.write('Which ratio applies on the first distribution date?', 'another-finding');
    drafts.saveKeptDrafts();
    drafts = await load();
    const latest = drafts.keptChecklistQuestions.open('latest:latest-item');
    expect(latest.text).toBe('Which ratio applies on the first distribution date?');
    expect(latest.findingId).toBe('latest-finding');
  });

  it('keep what a map not made yet this session left', async () => {
    local.write(KEPT_TEXT_KEY, { 'test-later': [['a', 'left']] });
    const k = await load();
    k.keptDrafts('test-text', k.isText).set('b', 'new');
    k.saveKeptDrafts();
    expect(local.read(KEPT_TEXT_KEY)).toEqual({ 'test-later': [['a', 'left']], 'test-text': [['b', 'new']] });
  });

  it('drop an entry not of the map’s shape and keep the rest; unreadable storage brings nothing back', async () => {
    local.write(KEPT_TEXT_KEY, { 'test-text': [['a', 'kept'], ['b', 42], ['c'], 'x'] });
    let k = await load();
    expect([...k.keptDrafts('test-text', k.isText).entries()]).toEqual([['a', 'kept']]);
    local.map.set(KEPT_TEXT_KEY, '{not json');
    k = await load();
    expect(k.keptDrafts('test-text', k.isText).size).toBe(0);
  });

  it('requires initialization, then reads once without writing or clearing at start', async () => {
    const read = vi.spyOn(local, 'read');
    const write = vi.spyOn(local, 'write');
    const drafts = await fresh();
    expect(() => drafts.keptDrafts('composer', drafts.isText)).toThrow('Initialize kept text');

    drafts.initializeKeptText(local);
    drafts.keptDrafts('composer', drafts.isText);
    drafts.keptDrafts('finding-ask', drafts.isText);

    expect(read).toHaveBeenCalledExactlyOnceWith(KEPT_TEXT_KEY);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps text in memory when storage is full and writes it the next time the port is available', async () => {
    const drafts = await load();
    const map = drafts.keptDrafts('composer', drafts.isText);
    const write = vi.spyOn(local, 'write')
      .mockReturnValueOnce(fail({ kind: 'storageFull', message: 'Storage is full' }));
    const text = 'Confirm whether the consent applies to the whole term loan facility.';
    map.set('project-aster', text);
    drafts.saveKeptDrafts();

    expect(write).toHaveBeenCalledTimes(1);
    expect(local.read(KEPT_TEXT_KEY)).toBe(null);
    expect(map.get('project-aster')).toBe(text);

    drafts.saveKeptDrafts();
    const restarted = await load();
    expect(restarted.keptDrafts('composer', restarted.isText).get('project-aster')).toBe(text);
  });
});
