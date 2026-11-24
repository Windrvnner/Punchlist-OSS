// One limit on a folder's label everywhere: the commands that take a label, and the label taken from a folder's name.
import { describe, it, expect } from 'vitest';
import { CreateDeal, AddFolders, EditDeal, FOLDER_LABEL_MAX } from '../../src/app/commands/deals';
import '../ui/keptTextSession';
import { guessLabel, fitLabel } from '../../src/ui/dialogs';

const folder = (label: string) => ({ path: 'C:\\Deals\\vdr', label, files: 1, size: '0.1 GB' });
const dealId = 'd_01HPRBFXXXXXXXXXXXXXXXXXXX';

describe('a folder label', () => {
  it('is held to the same limit on a new deal, on folders added later and when it is changed', () => {
    const at = 'x'.repeat(FOLDER_LABEL_MAX); const over = at + 'x';
    expect(CreateDeal.input.safeParse({ name: 'Liberty', folders: [folder(at)] }).success).toBe(true);
    expect(CreateDeal.input.safeParse({ name: 'Liberty', folders: [folder(over)] }).success).toBe(false);
    expect(AddFolders.input.safeParse({ dealId, folders: [folder(over)] }).success).toBe(false);
    expect(EditDeal.input.safeParse({ dealId, folder: { path: 'C:\\Deals\\vdr', label: at } }).success).toBe(true);
    expect(EditDeal.input.safeParse({ dealId, folder: { path: 'C:\\Deals\\vdr', label: over } }).success).toBe(false);
  });

  it('taken from a long folder name, starts within the limit and ends on a whole word', () => {
    const long = 'Project Proseware Virtual Data Room export for lenders and their advisors 2026';
    const got = guessLabel(`C:\\Deals\\${long}\\`);
    expect(got.length).toBeLessThanOrEqual(FOLDER_LABEL_MAX);
    expect(long.startsWith(got)).toBe(true);
    expect(long[got.length]).toBe(' ');
    expect(got).toBe('Project Proseware Virtual Data Room export for lenders and');
  });

  it('a short name is kept as it is, and one with no space is cut at the limit', () => {
    expect(guessLabel('C:\\Deals\\Proseware VDR')).toBe('Proseware VDR');
    expect(fitLabel('y'.repeat(80))).toBe('y'.repeat(FOLDER_LABEL_MAX));
    expect(fitLabel(`${'a'.repeat(FOLDER_LABEL_MAX)} tail`)).toBe('a'.repeat(FOLDER_LABEL_MAX));
  });
});
