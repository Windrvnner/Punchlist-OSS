import { describe, it, expect } from 'vitest';
import { findingFromAnswer } from '../../src/app/conversations';
import { TITLE_MAX } from '../../src/app/commands/findings';

const answer = (text: string) => ({ text, sources: [] }) as unknown as Parameters<typeof findingFromAnswer>[0];

describe('a finding started from an answer', () => {
  it('takes the whole first sentence as its title, ended at a full stop and a space, not inside "1.5x"', () => {
    expect(findingFromAnswer(answer('Revenue grew 1.5x in 2025. More follows.')).title).toBe('Revenue grew 1.5x in 2025');
  });
  it('leaves the title for the person to word when the sentence is longer than a title may be, and cuts nothing', () => {
    const long = `${'word '.repeat(100)}end.`;
    const found = findingFromAnswer(answer(long));
    expect(long.length).toBeGreaterThan(TITLE_MAX);
    expect(found.title).toBe('');
    expect(found.text).toBe(long);
  });
});
