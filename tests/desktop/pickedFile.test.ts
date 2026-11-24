import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { writePickedFile } from '../../src/desktop/pickedFile';
import { ok } from '../../src/domain/result';

it('keeps a picked file available after a refusal and consumes its ID after success', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'picked-memo-'));
  const file = path.join(folder, 'Deal memo.docx');
  const previous = 'Previous memo';
  fs.writeFileSync(file, previous);
  const bytes = new TextEncoder().encode('Updated memo');
  const picked = new Map([['pick', file]]);
  const written = new Map<string, string>();
  const write = vi.spyOn(fs, 'writeFileSync')
    .mockImplementationOnce(() => { throw Object.assign(new Error(`file locked: ${file}`), { code: 'EBUSY' }); })
    .mockImplementationOnce(() => { throw Object.assign(new Error(`no permission: ${file}`), { code: 'EACCES' }); });
  try {
    expect(writePickedFile(picked, written, 'pick', bytes)).toEqual({
      ok: false, error: { kind: 'failed', message: 'Couldn’t save the file · Open elsewhere' },
    });
    expect(writePickedFile(picked, written, 'pick', bytes)).toEqual({
      ok: false, error: { kind: 'failed', message: 'Couldn’t save the file' },
    });
    expect(picked.get('pick')).toBe(file);
    expect(written.size).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);

    expect(writePickedFile(picked, written, 'pick', bytes)).toEqual(ok('saved'));
    expect(picked.has('pick')).toBe(false);
    expect(written.get('pick')).toBe(file);
    expect(writePickedFile(picked, written, 'pick', new Uint8Array([0])).ok).toBe(false);
    expect(write).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('Updated memo');
  } finally {
    write.mockRestore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
