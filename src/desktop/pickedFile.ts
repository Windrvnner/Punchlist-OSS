import fs from 'node:fs';
import { fail, ok, type Result } from '../domain/result';

/** A failed write leaves its selected destination available to Retry (#656). */
export function writePickedFile(
  picked: Map<string, string>, written: Map<string, string>, id: string, bytes: Uint8Array,
): Result<'saved'> {
  const file = picked.get(id);
  const title = 'Couldn’t save the file';
  if (!file) return fail({ kind: 'failed', message: title });
  try {
    fs.writeFileSync(file, bytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === 'EBUSY' ? `${title} · Open elsewhere` : title;
    return fail({ kind: 'failed', message });
  }
  picked.delete(id);
  written.set(id, file);
  if (written.size > 20) written.delete(written.keys().next().value!);
  return ok('saved');
}
