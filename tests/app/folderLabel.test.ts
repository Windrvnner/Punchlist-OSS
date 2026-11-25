// One limit on a folder's label everywhere: the commands that take a label, and the label taken from a folder's name.
import { describe, it, expect } from 'vitest';
import { CreateDeal, AddFolders, EditDeal, FOLDER_LABEL_MAX } from '../../src/app/commands/deals';
import '../ui/keptTextSession';
import { guessLabel, folderName } from '../../src/app/dealFolders';

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

  it('taken from a long folder name is never cut: the folder starts with no label and shows its whole name', () => {
    const long = 'Project Proseware Virtual Data Room export for lenders and their advisors 2026';
    expect(guessLabel(`C:\\Deals\\${long}\\`)).toBe('');
    expect(folderName(`C:\\Deals\\${long}\\`)).toBe(long);
  });

  it('a name that fits is the label as it is', () => {
    expect(guessLabel('C:\\Deals\\Proseware VDR')).toBe('Proseware VDR');
    expect(guessLabel(`C:\\Deals\\${'y'.repeat(FOLDER_LABEL_MAX)}`)).toBe('y'.repeat(FOLDER_LABEL_MAX));
  });
});
