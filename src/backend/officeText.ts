/**
 * The text of a Word (.docx, .docm) or PowerPoint (.pptx, .pptm) file, read straight from the file with no converter
 *. Such a file is a zip of XML parts: Word's text is in word/document.xml, PowerPoint's
 * in one part per slide. This is for indexing only: what a document is found by. Its pages are made by the converter
 * when it is first sent to the model service or opened, so that the cited page and the page shown are the same page.
 *
 * Word's tracked changes are read as accepted, as its pages show them: inserted text counts, deleted text does not.
 */
import { inflateRawSync } from 'node:zlib';

/** the files whose text is read this way; older formats (.doc, .ppt, .rtf) are still converted at indexing */
export const DIRECT = /\.(docx|docm|pptx|pptm)$/i;

/** The parts of a zip file whose names pass `want`, by name. Throws on a file that is not a zip it can read. */
export function unzip(bytes: Uint8Array, want: (name: string) => boolean): Map<string, Buffer> {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the end of the central directory is in the last 64 KB (its comment can be up to 65,535 bytes)
  let end = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(end + 10); let at = b.readUInt32LE(end + 16); const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error('a damaged zip file');
    const method = b.readUInt16LE(at + 10), size = b.readUInt32LE(at + 20), nameLen = b.readUInt16LE(at + 28), extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32), local = b.readUInt32LE(at + 42);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen); at += 46 + nameLen + extra + comment;
    if (!want(name)) continue;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28); const raw = b.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(raw)); else if (method === 8) out.set(name, inflateRawSync(raw)); else throw new Error('a zip method this reader does not know');
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const plain = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m));

/**
 * The words of an XML part, paragraph by paragraph: the text of every `textTag` element, a new line at the end of each
 * `paraTag`, and nothing from deleted text (`w:delText` is a different element, so it is never read).
 */
function textOf(xml: string, textTag: string, paraTag: string): string {
  const out: string[] = []; const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|</${paraTag}>|<w:tab/>|<w:br/>`, 'g');
  for (const m of xml.matchAll(re)) out.push(m[1] !== undefined ? plain(m[1]) : m[0].startsWith('</') ? '\n' : ' ');
  return out.join('').replace(/[ \t]+\n/g, '\n');
}

/** what indexing needs of the file: all its text, the start of it (the first slide, for a deck) for its title, and Word's count of tracked changes */
export interface OfficeText { text: string; first: string; tracked: number }

/** Read the text of a .docx or .pptx file. Throws when the file cannot be read (damaged, or locked with a password, which makes it no zip). */
export function officeText(bytes: Uint8Array, name: string): OfficeText {
  if (/\.ppt[xm]$/i.test(name)) {
    const parts = unzip(bytes, (n) => /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
    const read = (kind: string) => [...parts].filter(([n]) => n.includes(`/${kind}`)).sort((a, b) => +a[0].replace(/\D/g, '') - +b[0].replace(/\D/g, '')).map(([, x]) => textOf(x.toString('utf8'), 'a:t', 'a:p'));
    const slides = read('slide'); const notes = read('notesSlide');   // the speaker notes are text of the file too
    return { text: [...slides, ...notes].join('\n'), first: slides[0] ?? '', tracked: 0 };
  }
  const parts = unzip(bytes, (n) => n === 'word/document.xml' || /^word\/(?:header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
  const doc = parts.get('word/document.xml'); if (!doc) throw new Error('not a Word document');
  const xml = doc.toString('utf8');
  // text moved away keeps its words in w:t at the old place: as accepted, only the new place has them
  const words = (part: string) => textOf(part.replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, ''), 'w:t', 'w:p');
  const text = words(xml);
  // headers, footers, footnotes and endnotes (what the PDF shows) follow the body; the title stays the body's start
  const others = [...parts].filter(([n]) => n !== 'word/document.xml').map(([, x]) => words(x.toString('utf8')));
  // each tracked change is one element: an insertion, a deletion, a move (from and to), a change of format, or a table cell added or taken out. Counted so, Word's count matches LibreOffice's
  const tracked = (xml.match(/<w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange|tblPrChange|trPrChange|tcPrChange|sectPrChange|cellIns|cellDel)[\s>]/g) ?? []).length;
  return { text: [text, ...others].join('\n'), first: text, tracked };
}
