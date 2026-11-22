/**
 * Reading and rewriting a zip package (an .xlsx or .xlsm is one) with Node's own zlib, so that a part the app does not
 * change goes back out exactly as it came in: its compressed bytes are copied, not inflated and packed again. Only the
 * parts given new contents are compressed afresh. No ZIP64 and no encryption: a Q&A log is neither.
 */
import zlib from 'node:zlib';

interface Entry { name: string; method: number; flags: number; time: number; date: number; crc: number; size: number; usize: number; data: Uint8Array; extra: Uint8Array; comment: Uint8Array; attrs: number; made: number; version: number }
export interface ZipPackage { entries: Entry[] }

/** the parts of a zip, in their order; throws on anything this reader cannot take apart safely */
export function readZip(bytes: Uint8Array): ZipPackage {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(end + 10); let at = b.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('ZIP64 is not supported');
  const entries: Entry[] = [];
  for (let k = 0; k < count; k++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const flags = b.readUInt16LE(at + 8); if (flags & 1) throw new Error('the file is encrypted');
    const nl = b.readUInt16LE(at + 28), xl = b.readUInt16LE(at + 30), cl = b.readUInt16LE(at + 32); const local = b.readUInt32LE(at + 42);
    const size = b.readUInt32LE(at + 20);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);   // the local header's own name and extra lengths
    entries.push({
      name: b.toString('utf8', at + 46, at + 46 + nl), made: b.readUInt16LE(at + 4), version: b.readUInt16LE(at + 6), flags: flags & ~8, method: b.readUInt16LE(at + 10),
      time: b.readUInt16LE(at + 12), date: b.readUInt16LE(at + 14), crc: b.readUInt32LE(at + 16), size, usize: b.readUInt32LE(at + 24),
      extra: new Uint8Array(b.subarray(at + 46 + nl, at + 46 + nl + xl)), comment: new Uint8Array(b.subarray(at + 46 + nl + xl, at + 46 + nl + xl + cl)), attrs: b.readUInt32LE(at + 38),
      data: new Uint8Array(b.subarray(start, start + size)),
    });
    at += 46 + nl + xl + cl;
  }
  return { entries };
}

/** a part's contents as text */
export function partText(z: ZipPackage, name: string): string | null {
  const e = z.entries.find((x) => x.name === name); if (!e) return null;
  return Buffer.from(e.method === 8 ? zlib.inflateRawSync(e.data) : e.data).toString('utf8');
}

/** gives a part new contents, compressed afresh; the other parts are left as they are */
export function setPart(z: ZipPackage, name: string, text: string): void {
  const e = z.entries.find((x) => x.name === name); if (!e) throw new Error(`the file has no ${name}`);
  const raw = Buffer.from(text, 'utf8');
  Object.assign(e, { method: 8, data: new Uint8Array(zlib.deflateRawSync(raw)), crc: zlib.crc32(raw), usize: raw.length });
  e.size = e.data.length;
}

/** the package as bytes: each part's header written anew with its sizes, so none needs a data descriptor */
export function writeZip(z: ZipPackage): Uint8Array {
  const out: Buffer[] = []; const dir: Buffer[] = []; let at = 0;
  for (const e of z.entries) {
    const name = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(e.version, 4); h.writeUInt16LE(e.flags, 6); h.writeUInt16LE(e.method, 8); h.writeUInt16LE(e.time, 10); h.writeUInt16LE(e.date, 12);
    h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.size, 18); h.writeUInt32LE(e.usize, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(e.made, 4); c.writeUInt16LE(e.version, 6); c.writeUInt16LE(e.flags, 8); c.writeUInt16LE(e.method, 10); c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(e.extra.length, 30); c.writeUInt16LE(e.comment.length, 32); c.writeUInt32LE(e.attrs, 38); c.writeUInt32LE(at, 42);
    out.push(h, name, Buffer.from(e.data)); dir.push(c, name, Buffer.from(e.extra), Buffer.from(e.comment));
    at += 30 + name.length + e.data.length;
  }
  const size = dir.reduce((n, x) => n + x.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(z.entries.length, 8); end.writeUInt16LE(z.entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...out, ...dir, end]));
}
