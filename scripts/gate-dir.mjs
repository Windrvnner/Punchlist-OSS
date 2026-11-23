// The run folders of check:all live under out/gate/ in this checkout (#95). Every script that reads or writes one
// takes it only from there, so a stray environment value or argument never reads or writes elsewhere.
import path from 'node:path';

export const GATE_ROOT = path.resolve('out/gate');

/** The folder as an absolute path when it is inside out/gate/; null for anything else, or nothing. */
export function insideGate(dir) {
  if (!dir) return null;
  const full = path.resolve(dir);
  return full.startsWith(GATE_ROOT + path.sep) ? full : null;
}
