import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, sha256Hex } from '../../../src/lib/voice-stack/sha256';

const enc = (s: string) => new TextEncoder().encode(s);
const ref = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Deterministic pseudo-random bytes (xorshift32), so failures are reproducible. */
function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe('sha256 known-answer vectors (FIPS 180-4 / NIST CSRC examples)', () => {
  it.each([
    ['the empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'the 896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
    ['the quick brown fox', 'The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ])('%s', (_label, input, digest) => {
    expect(sha256Hex(enc(input))).toBe(digest);
  });

  it('one million "a"s', () => {
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('sha256 against node:crypto', () => {
  it('agrees at every length from 0 to 300 bytes (all padding boundaries)', () => {
    for (let n = 0; n <= 300; n++) {
      const bytes = bytesOf(n, n + 1);
      expect(sha256Hex(bytes), `length ${n}`).toBe(ref(bytes));
    }
  });

  it.each([55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 191, 192])('agrees at the block boundary length %i', (n) => {
    for (const fill of [0x00, 0x80, 0xff]) {
      const bytes = new Uint8Array(n).fill(fill);
      expect(sha256Hex(bytes)).toBe(ref(bytes));
    }
  });

  it('agrees on a 16 KB input (the largest code the spec allows) and on UTF-8 text', () => {
    const big = bytesOf(16_384, 99);
    expect(sha256Hex(big)).toBe(ref(big));
    const text = enc('नमस्ते 🎙️ ଓଡ଼ିଆ ✓'.repeat(50));
    expect(sha256Hex(text)).toBe(ref(text));
  });

  it('agrees on a subarray view with a non-zero offset', () => {
    const backing = bytesOf(200, 7);
    const view = backing.subarray(13, 150);
    expect(sha256Hex(view)).toBe(ref(view));
  });
});

describe('sha256 output', () => {
  it('returns 32 raw bytes that hex-encode to sha256Hex', () => {
    const digest = sha256(enc('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest).toHaveLength(32);
    expect(Buffer.from(digest).toString('hex')).toBe(sha256Hex(enc('abc')));
  });

  it('is lowercase hex, 64 characters', () => {
    for (let n = 0; n < 20; n++) expect(sha256Hex(bytesOf(n * 7, n + 3))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not mutate its input and is deterministic', () => {
    const input = bytesOf(70, 5);
    const copy = input.slice();
    const a = sha256Hex(input);
    expect(input).toEqual(copy);
    expect(sha256Hex(input)).toBe(a);
  });

  it('changes completely for a one-bit change', () => {
    const a = new Uint8Array(64);
    const b = a.slice();
    b[63] ^= 1;
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});
