/**
 * Ids made from what a record is rather than drawn at random, for records that two PCs can each make from the same
 * shared source (an imported list) before either has the other's: both make the same id, so the change files hold one
 * record, not two. Ids are still opaque: nothing reads a wording or number back out of one.
 */
import { sha256Hex } from './checklist';

/** Crockford base32, as ULIDs use, so a derived id passes the same check as a drawn one (`id()` in model.ts) */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `prefix_` and 26 Crockford base32 characters (130 bits) taken from the SHA-256 of the parts joined by NUL. The caller
 * chooses and normalizes the parts; a part must not itself hold a NUL, or two different lists of parts could read the same.
 */
export function derivedId(prefix: string, parts: readonly string[]): string {
  const hex = sha256Hex(parts.join('\0'));
  let bits = ''; for (const h of hex.slice(0, 33)) bits += parseInt(h, 16).toString(2).padStart(4, '0');   // 132 bits, 130 used
  let out = ''; for (let i = 0; i < 26; i++) out += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `${prefix}_${out}`;
}
