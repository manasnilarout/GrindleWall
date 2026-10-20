import { describe, expect, it } from 'vitest';
import { normaliseLanguageCode } from '../../../src/lib/voice-stack/language';

describe('normaliseLanguageCode', () => {
  it.each([
    ['hi', 'hi'],
    ['hi-IN', 'hi'],
    ['hi_IN', 'hi'],
    ['HI', 'hi'],
    ['Hi-in', 'hi'],
    ['  te-IN  ', 'te'],
    ['en-US', 'en'],
    ['en-UK', 'en'],
    ['cmn-Hans-CN', 'cmn'],
    ['es-419', 'es'],
    ['fil', 'fil'],
    ['zh-', 'zh'],
    ['hi-', 'hi'],
  ])('%j -> %j', (input, out) => {
    expect(normaliseLanguageCode(input)).toBe(out);
  });

  it("collapses Sarvam's Odia spelling to ISO 639-1", () => {
    expect(normaliseLanguageCode('od-IN')).toBe('or');
    expect(normaliseLanguageCode('OD')).toBe('or');
    expect(normaliseLanguageCode('or-IN')).toBe('or');
  });

  it.each([
    '',
    '   ',
    'x',
    'hindi',
    'unknown',
    'auto',
    'h1',
    '12',
    '-IN',
    '_IN',
    'hi IN',
    'éé',
    'हि',
  ])('rejects %j', (input) => {
    expect(normaliseLanguageCode(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normaliseLanguageCode(null)).toBeNull();
    expect(normaliseLanguageCode(undefined)).toBeNull();
    expect(normaliseLanguageCode(42 as unknown as string)).toBeNull();
    expect(normaliseLanguageCode(['hi'] as unknown as string)).toBeNull();
  });

  it('does not treat Object.prototype keys as aliases', () => {
    expect(normaliseLanguageCode('constructor')).toBeNull();
    expect(normaliseLanguageCode('toString')).toBeNull();
  });

  it('is idempotent', () => {
    for (const input of ['hi-IN', 'od-IN', 'cmn-Hans-CN', 'EN']) {
      const once = normaliseLanguageCode(input)!;
      expect(normaliseLanguageCode(once)).toBe(once);
    }
  });
});
