// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { officeText, DIRECT } from '../../src/backend/officeText';

const fixture = (n: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', n)));

describe('Word and PowerPoint text read straight from the file', () => {
  it("reads a Word file's paragraphs, with its tracked changes accepted, and counts them as LibreOffice does", () => {
    const notes = officeText(fixture('Notes.docx'), 'Notes.docx');
    expect(notes.text).toBe('Page one of the notes.\n\nPage two of the notes.\n\nPage three.\n'); expect(notes.tracked).toBe(0);
    const tracked = officeText(fixture('Tracked.docx'), 'Tracked.docx');
    expect(tracked.tracked).toBe(13);                                                       // LibreOffice's count of the same file (documents.test.ts)
    expect(tracked.text).toContain('MOVEDSENTENCE new place.'); expect(tracked.text).not.toContain('MOVEDSENTENCE old place.');   // moved text is at its new place only
    expect(tracked.text).toContain('INSERTEDROW'); expect(tracked.first).toBe(tracked.text);
  });
  it("reads a deck's slides in their order, the first slide giving its title", () => {
    const deck = officeText(fixture('Deck.pptx'), 'Deck.pptx');
    expect(deck.text).toBe('Lender presentation\nProseware Solar & Storage\n\nSecond slide: tariff\n\nTenth slide: interconnection\n');
    expect(deck.first).toBe('Lender presentation\nProseware Solar & Storage\n'); expect(deck.tracked).toBe(0);
  });
  it('throws on a file it cannot read, and covers only the newer formats', () => {
    expect(() => officeText(new TextEncoder().encode('not a zip'), 'Broken.docx')).toThrow();
    expect(() => officeText(fixture('Deck.pptx'), 'Deck.docx')).toThrow('not a Word document');
    expect(['a.docx', 'a.DOCM', 'a.pptx', 'a.pptm'].every((n) => DIRECT.test(n))).toBe(true); expect(['a.doc', 'a.ppt', 'a.rtf', 'a.pdf'].some((n) => DIRECT.test(n))).toBe(false);
  });
});
