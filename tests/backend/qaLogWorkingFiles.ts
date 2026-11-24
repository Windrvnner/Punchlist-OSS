import { createHash } from 'node:crypto';
import path from 'node:path';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const workingFixtureId = (file: string, attempt: string) => `~qa-log-${hash(file)}.${attempt}`;

/** A moved-aside fixture with a known original filename. */
export function asideFixtureName(file: string, opts: { base?: Uint8Array; attempt?: string } = {}): string {
  const ext = path.extname(file);
  const archive = `${path.basename(file, ext)} 2026-11-17 1000${ext}`;
  const id = workingFixtureId(file, opts.attempt ?? '0a1b2c3d');
  return `${id}.${hash(archive)}.${hash(opts.base ?? '')}.old`;
}

export const temporaryFixtureName = (file: string, attempt: string): string => `${workingFixtureId(file, attempt)}.tmp`;
