import { describe, it, expect } from 'vitest';
import { alsoIn } from '../../src/ui/docMenu';

// a document's other places, under its name in reading mode's list
describe('alsoIn', () => {
  const at = (folder: string, name = 'TA report.pdf') => ({ folder, name });
  it('says nothing for a document in one place', () => { expect(alsoIn([])).toBeNull(); expect(alsoIn([at('vdr/Technical')])).toBeNull(); });
  it('names one other folder, or counts several, with the full paths as the tooltip', () => {
    expect(alsoIn([at('vdr/Technical'), at('vdr/Archive')])).toEqual({ text: 'Also in Archive', title: 'vdr › Archive › TA report.pdf' });
    expect(alsoIn([at('vdr/Technical'), at('vdr/Archive'), at('vdr/09 Superseded', 'TA (final).pdf')])!.text).toBe('Also in 2 more folders: Archive, 09 Superseded');
  });
  it('names a copy in the same folder by its own name, and a folder holding two copies once', () => {
    expect(alsoIn([at('vdr/Technical'), at('vdr/Technical', 'TA report (1).pdf')])!.text).toBe('Also in TA report (1).pdf');
    expect(alsoIn([at('vdr/Technical'), at('vdr/Archive'), at('vdr/Archive', 'Copy.pdf')])!.text).toBe('Also in Archive');
  });
});
