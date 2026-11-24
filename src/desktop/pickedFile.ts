import fs from 'node:fs';
import { fail, ok, type Result } from '../domain/result';

function fileStamp(file: string): string | null | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

type PickedFile = { file: string; stamp: ReturnType<typeof fileStamp>; refused?: true };

export function pickedFile(file: string): PickedFile {
  return { file, stamp: fileStamp(file) };
}

/** A different file version needs a fresh save choice before the completed memo can replace it (#656). */
function newFileChoiceReason(target: PickedFile): string | undefined {
  const now = fileStamp(target.file);
  if (target.stamp === undefined || now === undefined) return target.refused ? 'Can’t verify file' : undefined;
  return now !== target.stamp ? 'File changed' : undefined;
}

/** A failed write leaves its selected destination available to Retry (#656). */
export function writePickedFile(
  picked: Map<string, PickedFile>, written: Map<string, string>, id: string, bytes: Uint8Array,
): Result<'saved'> {
  const target = picked.get(id);
  const title = 'Couldn’t save the file';
  if (!target) return fail({ kind: 'failed', message: title });
  const needsChoice = newFileChoiceReason(target);
  if (needsChoice) {
    picked.delete(id);
    return fail({ kind: 'conflict', message: `${title} · ${needsChoice}` });
  }
  try {
    fs.writeFileSync(target.file, bytes);
  } catch (error) {
    target.refused = true;
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === 'EBUSY' ? `${title} · Open elsewhere` : title;
    return fail({ kind: 'failed', message });
  }
  picked.delete(id);
  written.set(id, target.file);
  if (written.size > 20) written.delete(written.keys().next().value!);
  return ok('saved');
}
