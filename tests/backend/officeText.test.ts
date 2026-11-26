// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { officeText, DIRECT } from '../../src/backend/officeText';

const fixture = (n: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', n)));

/** a zip of the given parts, stored uncompressed: enough for `officeText`'s reader */
function zipOf(parts: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt32LE(crc32(data), 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
const word = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const slide = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;

describe('Word and PowerPoint text read straight from the file', () => {
  it("reads a Word file's paragraphs, with its tracked changes accepted, and counts them as LibreOffice does", () => {
    const notes = officeText(fixture('Notes.docx'), 'Notes.docx');
    expect(notes.text).toBe('Page one of the notes.\n\nPage two of the notes.\n\nPage three.\n'); expect(notes.tracked).toBe(0);
    const tracked = officeText(fixture('Tracked.docx'), 'Tracked.docx');
    expect(tracked.tracked).toBe(13);                                                       // LibreOffice's count of the same file (documents.test.ts)
    expect(tracked.text).toContain('MOVEDSENTENCE new place.'); expect(tracked.text).not.toContain('MOVEDSENTENCE old place.');   // moved text is at its new place only
    expect(tracked.text).toContain('INSERTEDROW');
    // a footer is text of the file too, after the body; the title is the body's start
    expect(tracked.text).toContain('Draft FOOTERNEW');
    expect(tracked.first).not.toContain('FOOTERNEW');
    expect(tracked.text.startsWith(tracked.first)).toBe(true);
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
  it('reads a Word file\'s header, footnotes and endnotes and a deck\'s speaker notes, after the body (#1025)', () => {
    const docx = officeText(zipOf({
      'word/document.xml': word('Body BODYTEXT'),
      'word/header1.xml': word('HEADERONLY'),
      'word/footnotes.xml': word('FOOTNOTEONLY'),
      'word/endnotes.xml': word('ENDNOTEONLY'),
    }), 'Memo.docx');
    const lines = (text: string) => text.split('\n').filter(Boolean);
    expect(lines(docx.text)).toEqual(['Body BODYTEXT', 'HEADERONLY', 'FOOTNOTEONLY', 'ENDNOTEONLY']);
    expect(docx.first).toBe(docx.text.split('\n')[0] + '\n');
    const pptx = officeText(zipOf({
      'ppt/slides/slide1.xml': slide('SLIDEONE'),
      'ppt/slides/slide2.xml': slide('SLIDETWO'),
      'ppt/notesSlides/notesSlide1.xml': slide('NOTESONLY'),
    }), 'Deck.pptx');
    expect(lines(pptx.text)).toEqual(['SLIDEONE', 'SLIDETWO', 'NOTESONLY']);
    expect(pptx.first).toBe('SLIDEONE\n');
  });
});
