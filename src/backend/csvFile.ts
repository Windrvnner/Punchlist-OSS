/**
 * The cells of a CSV file on disk, read a piece at a time, so the file is never held in memory whole: the reader keeps
 * one piece and the cell being read, and what grows with the file is only what the caller keeps of its cells.
 * The encoding is decided by `encodingOf`, as `decodeText` decides it, from the start of the file. The start alone
 * cannot say whether all of a file is UTF-8, so a file that is not UTF-16 is read once through to find out. A file
 * with no byte-order mark that is not UTF-8 is Windows-1252; one whose mark names an encoding it is not valid in is
 * refused with `decodeText`'s message (#382).
 */
import fs from 'node:fs';
import { CsvCells } from '../domain/csvCells';
import { encodingOf, invalidTextMessage } from '../domain/textEncoding';

const PIECE = 1 << 20;

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

/** the file's encoding as a TextDecoder label, and the length of the byte-order mark to skip */
async function labelOf(at: string): Promise<{ label: string; skip: number }> {
  const encoding = encodingOf(head(at));
  const label = encoding.replace('-bom', '');
  const wide = label.startsWith('utf-16');
  const skip = encoding.endsWith('-bom') ? (wide ? 2 : 3) : 0;
  if (wide) return { label, skip };
  if (await isUtf8(at, skip)) return { label: 'utf-8', skip };
  if (skip > 0) throw new Error(invalidTextMessage(label));
  return { label: 'windows-1252', skip };
}

/** each cell of a CSV file, in order, handed to `onCell` as it ends */
export async function eachCsvCell(at: string, onCell: (cell: string) => void): Promise<void> {
  const { label, skip } = await labelOf(at);
  const decoder = new TextDecoder(label, { fatal: true });
  const cells = new CsvCells(onCell);
  try {
    await eachPiece(at, skip, (piece) => cells.push(decoder.decode(piece, { stream: true })));
    cells.push(decoder.decode());
  } catch (error) {
    if (error instanceof TypeError) throw new Error(invalidTextMessage(label));
    throw error;
  }
  cells.end();
}
