// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/bytes.ts
// by `npm run sync-voice-stack-spec`; edit it in core and re-run that.

/**
 * UTF-8 and base64url codecs that behave identically in Node and the browser.
 *
 * No `Buffer` (Node-only) and no `btoa`/`atob` (Latin-1 strings, and absent
 * from older Node type surfaces): the Voice Stack spec modules are copied
 * verbatim into Grindelwald's browser frontend. `TextEncoder`/`TextDecoder` are
 * globals in both (Node >= 11).
 *
 * IMPORT-FREE ON PURPOSE (see CLAUDE.md, "Module graph & tests").
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** char code → 6-bit value, or -1. Accepts the standard alphabet's `+` / `/` too. */
const DECODE_TABLE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  table['+'.charCodeAt(0)] = 62;
  table['/'.charCodeAt(0)] = 63;
  return table;
})();

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Strict UTF-8 decode: `null` on any malformed sequence (never a U+FFFD substitution). */
export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** base64url, RFC 4648 §5, WITHOUT padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/**
 * Decode base64url. Returns `null` for anything that is not a valid encoding.
 *
 * Deliberately TOLERANT of two things a copy/paste or a re-encoding tool can
 * introduce, because the checksum (over the decoded bytes, not the text) is what
 * guards integrity: trailing `=` padding, and the standard alphabet's `+` / `/`.
 *
 * Deliberately STRICT about non-zero trailing bits in the final character: two
 * texts must never decode to the same bytes. Without that, flipping the last
 * character of a code could leave the bytes — and so the checksum — unchanged.
 */
export function base64UrlDecode(text: string): Uint8Array | null {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x3d /* = */) end--;
  // Padding is at most two characters and only completes a 4-char group.
  const padding = text.length - end;
  if (padding > 2 || (padding > 0 && text.length % 4 !== 0)) return null;
  if (end % 4 === 1) return null;

  const out = new Uint8Array(Math.floor((end * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? DECODE_TABLE[code]! : -1;
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >>> bits) & 0xff;
    }
  }
  // Leftover bits (2 or 4) are padding inside the last character and must be zero.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
