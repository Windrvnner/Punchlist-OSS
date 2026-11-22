// "Previous version" on a finding shows the words an update replaced, never an update that left them as they were.
import { describe, it, expect } from 'vitest';
import { previousVersion } from '../../src/app/findings';

describe('the previous version of a finding', () => {
  it('is the latest update that replaced the words', () => {
    const one = { kind: 'reassessed', from: ['First.'], to: ['Second.'] };
    const same = { kind: 'reassessed', from: ['Second.'], to: ['Second.'] };
    expect(previousVersion([one, { kind: 'edited' }, same])).toBe(one);
    expect(previousVersion([same])).toBeUndefined();
    expect(previousVersion([one, { kind: 'reassessed', from: ['Second.'], to: ['Third.'] }])?.from).toEqual(['Second.']);
  });
});
