import { describe, it, expect } from 'vitest';
import { ownFilesId, isOwnFiles } from '../../src/domain/model';

describe("a person's own files (attached on Home)", () => {
  it('have one id per person on every PC, safe in a file name, never a deal id', () => {
    const id = ownFilesId('adoe');
    expect(id).toMatch(/^me_[0-9a-f]{16}$/);
    expect(ownFilesId(' ADOE ')).toBe(id);                       // the name as signed in on another PC
    expect(ownFilesId('sroe')).not.toBe(id);
    expect(isOwnFiles(id)).toBe(true); expect(isOwnFiles('d_01HZX')).toBe(false); expect(isOwnFiles(undefined)).toBe(false);
  });
});
