// People never see a finding named by an id in what the AI writes.
import { describe, it, expect } from 'vitest';
import { unid } from '../../src/backend/ai';

const ID = 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ';

describe('a finding id the model writes outside a link is taken out', () => {
  it('a link keeps its id; an id in brackets goes; a bare id becomes words', () => {
    const ids = new Set([ID]);
    expect(unid(`The {lock-up ratio differs|${ID}}.`, ids)).toBe(`The {lock-up ratio differs|${ID}}.`);
    expect(unid(`The lock-up ratio differs (${ID}).`, ids)).toBe('The lock-up ratio differs.');
    expect(unid(`As finding ${ID} says, the ratio differs.`, ids)).toBe('As this finding says, the ratio differs.');
    expect(unid('Nothing to take out here.', ids)).toBe('Nothing to take out here.');
  });
});
