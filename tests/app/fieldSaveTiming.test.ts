// @vitest-environment node
// When a typed field saves (#953): the app waits for a pause in typing, and flushes or cancels that wait when the
// field is left. The field only reports its events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import type { FieldCommit, FieldComposition, FieldInput } from '../../src/app/fieldSave';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const DEBOUNCE = 500;
const original = 'Provide the executed agreement with all amendments.';

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const kept = await import('../../src/app/keptText');
  kept.initializeKeptText(new MemoryLocal());
});
afterEach(() => vi.useRealTimers());

async function field() {
  const { FieldSave } = await import('../../src/app/fieldSave');
  let text = original;
  let composition: FieldComposition = 'idle';
  const input: FieldInput = {
    text: () => text,
    composition: () => composition,
    partial: () => false,
    partialNow: () => false,
    focused: () => true,
    locked: () => false,
    markPartial: () => {},
    replaceText: (value) => { text = value; },
    adoptBase: () => {},
    landedEntryText: () => {},
    show: () => {},
  };
  const save = new FieldSave({ value: original, rev: 1 }, undefined, undefined, input);
  const sent: string[] = [];
  const commit: FieldCommit = async (value) => {
    sent.push(value);
    return { ok: true };
  };
  const type = (value: string) => {
    text = value;
    save.typed(value, commit, DEBOUNCE);
  };
  const compose = (next: FieldComposition) => { composition = next; };
  return { save, sent, commit, type, compose };
}

describe('typing in a field', () => {
  it('saves once, the moment after the last keystroke of a long edit', async () => {
    const { sent, type } = await field();
    const words = portfolioQuestions()[7].split(' ');
    for (let at = 1; at <= words.length; at++) {
      type(words.slice(0, at).join(' '));
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    }
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([words.join(' ')]);
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
  });

  it('does not wait to save provisional text while an input method composes', async () => {
    const { sent, type, compose } = await field();
    compose('active');
    type('けいやく');
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
  });

  it('does not wait to save while the field shows Changed elsewhere', async () => {
    const { save, sent, type } = await field();
    type('Typed before the peer edit');
    save.receive({ value: 'A peer edit', rev: 2 });
    type('Typed after the peer edit');
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
  });
});

describe('leaving a field', () => {
  it('flushes a pending save once when the page hides, and nothing when none is pending', async () => {
    const { save, sent, commit, type } = await field();
    save.leave(commit);
    expect(sent).toEqual([]);
    type('Provide the executed credit agreement.');
    save.leave(commit);
    await vi.runAllTimersAsync();
    expect(sent).toEqual(['Provide the executed credit agreement.']);
  });

  it('saves on blur at once and not again when the wait would have ended', async () => {
    const { save, sent, commit, type } = await field();
    type('Provide the executed credit agreement.');
    save.blur(commit, false);
    await vi.runAllTimersAsync();
    expect(sent).toEqual(['Provide the executed credit agreement.']);
  });

  it('cancels the wait on blur when text not saved on entry is unchanged, leaving it for Retry', async () => {
    const { save, sent, commit, type } = await field();
    type('Not saved on entry');
    save.blur(commit, true);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
  });

  it('sends a pending save once when the field goes away', async () => {
    const { save, sent, commit, type } = await field();
    type('Provide the executed credit agreement.');
    save.unmount(commit);
    await vi.runAllTimersAsync();
    expect(sent).toEqual(['Provide the executed credit agreement.']);
  });

  it('cancels the wait when composition starts or Escape takes the edit back', async () => {
    const { save, sent, type } = await field();
    type('Provide the executed credit agreement.');
    expect(save.stopTimer()).toBe(true);
    expect(save.stopTimer()).toBe(false);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
  });
});
