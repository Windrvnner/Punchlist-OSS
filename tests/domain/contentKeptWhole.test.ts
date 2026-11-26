// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { strings } from '../../src/backend/lenient';
import { logName } from '../../src/app/qaLog';
import { folderName } from '../../src/app/dealFolders';
import { displayName } from '../../src/ui/docName';

const EDGES = ' \t text with edges \t ';

describe('content is kept exactly as it is given', () => {
  it('keeps the spaces and tabs around each string of a model reply, and drops one of only white space', () => {
    expect(strings([EDGES, ' \t ', 'plain'])).toEqual([EDGES, 'plain']);
  });

  it('names a log, a folder and a file as written', () => {
    expect(logName(' Lender A - vCurrent.xlsx')).toBe(' Lender A');
    expect(folderName('C:\\Deals\\ Kestrel \\')).toBe(' Kestrel ');
    expect(displayName(' Credit Agreement.pdf ')).toBe(' Credit Agreement.pdf ');
  });
});
