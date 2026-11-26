/**
 * The cells of a CSV file on disk, read a piece at a time: a file of any size is read with the memory of one piece.
 * The file's encoding is told as `decodeText` tells it (a byte-order mark, UTF-16 without one, UTF-8, else
 * Windows-1252), and a file that is not UTF-16 is read once through to find out whether it is UTF-8, so that text
 * is never decoded as the wrong thing.
 */
import fs from 'node:fs';
import { CsvCells } from '../domain/csvCells';
import { encodingOf } from '../adapters/spreadsheet';

const PIECE = 1 << 20;
const UTF8_MARK = 3;

function head(at: string): Uint8Array {
  const fd = fs.openSync(at, 'r');
  try {
    const bytes = new Uint8Array(4096);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

async function eachPiece(at: string, skip: number, onPiece: (piece: Uint8Array) => void): Promise<void> {
  let left = skip;
  for await (const chunk of fs.createReadStream(at, { highWaterMark: PIECE }) as AsyncIterable<Uint8Array>) {
    const cut = Math.min(left, chunk.length);
    left -= cut;
    if (cut < chunk.length) onPiece(chunk.subarray(cut));
  }
}

async function isUtf8(at: string, skip: number): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    await eachPiece(at, skip, (piece) => decoder.decode(piece, { stream: true }));
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

async function labelOf(at: string): Promise<{ label: string; skip: number }> {
  const first = head(at);
  const encoding = encodingOf(first);
  if (encoding.startsWith('utf-16')) return { label: encoding.slice(0, 8), skip: encoding.endsWith('-bom') ? 2 : 0 };
  const marked = first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf;
  const skip = marked ? UTF8_MARK : 0;
  return { label: (await isUtf8(at, skip)) ? 'utf-8' : 'windows-1252', skip };
}

/** each cell of a CSV file, in order, handed to `onCell` as it ends */
export async function eachCsvCell(at: string, onCell: (cell: string) => void): Promise<void> {
  const { label, skip } = await labelOf(at);
  const decoder = new TextDecoder(label);
  const cells = new CsvCells(onCell);
  await eachPiece(at, skip, (piece) => cells.push(decoder.decode(piece, { stream: true })));
  cells.push(decoder.decode());
  cells.end();
}
