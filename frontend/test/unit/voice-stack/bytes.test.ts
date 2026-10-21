import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../../../src/lib/voice-stack/bytes';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('utf8Encode / utf8Decode', () => {
  it.each(['', 'ascii', 'héllo', 'नमस्ते', 'ଓଡ଼ିଆ', '🎙️ voice', '\u0000nul', '﻿bom-first'])('round-trips %j', (s) => {
    const encoded = utf8Encode(s);
    expect(Buffer.from(encoded).toString('utf8')).toBe(s);
    expect(utf8Decode(encoded)).toBe(s);
  });

  it('encodes code points with the right byte widths', () => {
    expect(utf8Encode('A')).toEqual(bytes(0x41));
    expect(utf8Encode('é')).toEqual(bytes(0xc3, 0xa9));
    expect(utf8Encode('€')).toEqual(bytes(0xe2, 0x82, 0xac));
    expect(utf8Encode('😀')).toEqual(bytes(0xf0, 0x9f, 0x98, 0x80));
  });

  it('encodes a lone surrogate as U+FFFD (TextEncoder rule)', () => {
    expect(utf8Encode('\uD800')).toEqual(bytes(0xef, 0xbf, 0xbd));
  });

  it('keeps a leading BOM rather than stripping it', () => {
    expect(utf8Decode(bytes(0xef, 0xbb, 0xbf, 0x41))).toBe('﻿A');
  });

  it.each([
    ['a lone continuation byte', bytes(0x80)],
    ['an invalid lead byte', bytes(0xff)],
    ['a truncated two-byte sequence', bytes(0xc3)],
    ['a truncated four-byte sequence', bytes(0xf0, 0x9f, 0x98)],
    ['an overlong NUL', bytes(0xc0, 0x80)],
    ['an encoded surrogate', bytes(0xed, 0xa0, 0x80)],
    ['a code point above U+10FFFF', bytes(0xf4, 0x90, 0x80, 0x80)],
    ['garbage after valid text', bytes(0x41, 0x42, 0xfe)],
  ])('returns null, not U+FFFD, for %s', (_label, input) => {
    expect(utf8Decode(input)).toBeNull();
  });
});

describe('base64UrlEncode', () => {
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('RFC 4648 test vector %j -> %j (no padding)', (input, out) => {
    expect(base64UrlEncode(ascii(input))).toBe(out);
  });

  it('uses the URL-safe alphabet', () => {
    expect(base64UrlEncode(bytes(0xfb, 0xff, 0xbf))).toBe('-_-_');
    expect(base64UrlEncode(bytes(0xff))).toBe('_w');
    expect(base64UrlEncode(bytes(0x3e))).toBe('Pg');
  });

  it("matches Node's base64url for many lengths", () => {
    for (let n = 0; n < 200; n++) {
      const b = bytesOf(n, n + 11);
      expect(base64UrlEncode(b), `length ${n}`).toBe(Buffer.from(b).toString('base64url'));
    }
  });
});

describe('base64UrlDecode', () => {
  it('round-trips every length and every byte value', () => {
    for (let n = 0; n < 200; n++) {
      const b = bytesOf(n, n + 101);
      expect(base64UrlDecode(base64UrlEncode(b)), `length ${n}`).toEqual(b);
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64UrlDecode(base64UrlEncode(all))).toEqual(all);
  });

  it('decodes the RFC 4648 vectors', () => {
    expect(base64UrlDecode('')).toEqual(new Uint8Array(0));
    expect(new TextDecoder().decode(base64UrlDecode('Zm9vYmFy')!)).toBe('foobar');
    expect(new TextDecoder().decode(base64UrlDecode('Zm9vYg')!)).toBe('foob');
  });

  it('tolerates correct = padding', () => {
    expect(base64UrlDecode('Zg==')).toEqual(ascii('f'));
    expect(base64UrlDecode('Zm8=')).toEqual(ascii('fo'));
    expect(base64UrlDecode('Zm9v')).toEqual(ascii('foo'));
  });

  it('tolerates the standard alphabet', () => {
    expect(base64UrlDecode('+/+/')).toEqual(bytes(0xfb, 0xff, 0xbf));
    expect(base64UrlDecode('-_+/')).toEqual(bytes(0xfb, 0xff, 0xbf));
    const b = bytesOf(99, 4);
    expect(base64UrlDecode(Buffer.from(b).toString('base64'))).toEqual(b);
  });

  it.each([
    ['too much padding', 'Zg==='],
    ['padding that does not complete a group', 'Zg='],
    ['padding alone', '=='],
    ['four padding characters', '===='],
    ['padding in the middle', 'Zg=a'],
    ['a dangling single character', 'Z'],
    ['a dangling character after a group', 'Zm9vY'],
    ['a space', 'Zm9 v'],
    ['a newline', 'Zm9v\n'],
    ['a dot', 'Zm.v'],
    ['a non-ASCII character', 'Zm9é'],
    ['a fullwidth letter', 'Ｚｇ'],
  ])('rejects %s', (_label, text) => {
    expect(base64UrlDecode(text)).toBeNull();
  });

  it('rejects non-zero trailing bits, so two texts never decode to the same bytes', () => {
    expect(base64UrlDecode('Zg')).toEqual(ascii('f'));
    expect(base64UrlDecode('Zh')).toBeNull(); // 'h' leaves 4 bits set
    expect(base64UrlDecode('Zm8')).toEqual(ascii('fo'));
    expect(base64UrlDecode('Zm9')).toBeNull(); // '9' leaves 2 bits set
    // Exhaustive: of the 64 final characters for a 1-byte tail, exactly 4 are canonical.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const accepted = [...ALPHABET].filter((c) => base64UrlDecode(`Z${c}`) !== null);
    expect(accepted).toEqual(['A', 'Q', 'g', 'w']);
  });

  it('agrees with re-encoding: any accepted text re-encodes to itself (modulo padding and alphabet)', () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const a of ALPHABET) {
      for (const b of 'AQgw_') {
        const text = `Zm9v${a}${b}`;
        const decoded = base64UrlDecode(text);
        if (decoded) expect(base64UrlEncode(decoded)).toBe(text);
      }
    }
  });
});
