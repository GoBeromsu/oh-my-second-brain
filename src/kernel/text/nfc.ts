/**
 * Unicode NFC helpers for comparing vault paths.
 *
 * macOS may store a Hangul filename decomposed (NFD) while callers type it
 * composed (NFC). Comparing both sides after NFC normalization makes the two
 * spellings of one name equal without touching the bytes on disk.
 */

/** Returns `value` in Unicode Normalization Form C. */
export function toNfc(value: string): string {
  return value.normalize("NFC");
}

/** True when `a` and `b` are the same text after NFC normalization. */
export function nfcEquals(a: string, b: string): boolean {
  return a === b || toNfc(a) === toNfc(b);
}
