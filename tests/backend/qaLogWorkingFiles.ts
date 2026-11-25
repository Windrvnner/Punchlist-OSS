import path from 'node:path';
import { sha256 as hash } from '../../src/backend/qaLogFolder';
import { windowsPath } from '../../src/domain/sheets';

const workingFixtureId = (file: string, attempt: string) =>
  `~qa-log-${hash(Buffer.from(windowsPath(file)))}.${attempt}`;

/** A moved-aside fixture with a known original filename. */
export function asideFixtureName(file: string, opts: { base?: Uint8Array; attempt?: string } = {}): string {
  const ext = path.extname(file);
  const archive = `${path.basename(file, ext)} 2026-11-17 1000${ext}`;
  const id = workingFixtureId(file, opts.attempt ?? '0a1b2c3d');
  return `${id}.${hash(Buffer.from(archive))}.${hash(opts.base ?? new Uint8Array())}.old`;
}

export const temporaryFixtureName = (file: string, attempt: string): string => `${workingFixtureId(file, attempt)}.tmp`;
