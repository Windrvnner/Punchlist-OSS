import { createHash } from 'node:crypto';

/** A moved-aside fixture with a known original filename. */
export function asideFixtureName(file: string, attempt = '0a1b2c3d'): string {
  const identity = createHash('sha256').update(file, 'utf8').digest('hex');
  return `~qa-log-${identity}.${attempt}.old`;
}
