import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LLM_REASONING_LEVELS,
  UNSAFE_TEXT_MESSAGE,
  VOICE_STACK_CHECKSUM_LENGTH,
  VOICE_STACK_KIND,
  VOICE_STACK_MAX_CODE_LENGTH,
  VOICE_STACK_MAX_LANGUAGES,
  VOICE_STACK_MAX_PROVENANCE_BYTES,
  VOICE_STACK_PREFIX,
  VOICE_STACK_SPEC_VERSION,
  VoiceStackEncodeError,
  behaviourHash,
  decodeVoiceStack,
  defaultLanguage,
  encodeVoiceStack,
  isSafeText,
  languageRowFor,
  parseVoiceStackSpec,
  voiceStackSpecSchema,
} from '../../../src/lib/voice-stack/spec';
import type { VoiceStackSpecInput } from '../../../src/lib/voice-stack/spec';
import { base64UrlEncode } from '../../../src/lib/voice-stack/bytes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const base = (): VoiceStackSpecInput => ({
  kind: VOICE_STACK_KIND,
  specVersion: VOICE_STACK_SPEC_VERSION,
  architecture: 'cascade',
  stt: { provider: 'sarvam', model: 'saaras:v3', options: { streamType: 'fast' } },
  llm: { provider: 'google', model: 'gemini-3.1-flash-lite', options: { reasoning: 'minimal' } },
  tts: { provider: 'sarvam', model: 'bulbul:v3', options: {} },
  languages: [
    { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' },
    { code: 'or', stt: 'or-IN', tts: 'od-IN', voice: 'shubh' },
  ],
  turn: { detection: 'server_vad' },
  meta: { name: 'Hindi collections', description: 'Two rows', provenance: { source: 'grindelwald', sessions: ['rec-1'] } },
});

/** Hand-builds a code around arbitrary bytes, with a correct checksum. */
const codeOf = (payload: Uint8Array) =>
  `${VOICE_STACK_PREFIX}${base64UrlEncode(payload)}.${createHash('sha256').update(payload).digest('hex').slice(0, 8)}`;
const codeOfText = (text: string) => codeOf(new TextEncoder().encode(text));

const issuesOf = (value: unknown) => {
  const r = parseVoiceStackSpec(value);
  return r.ok ? [] : r.error.issues ?? [];
};
const pathsOf = (value: unknown) => issuesOf(value).map((i) => i.path);

describe('constants', () => {
  it('pins the v1 wire format', () => {
    expect(VOICE_STACK_SPEC_VERSION).toBe(1);
    expect(VOICE_STACK_PREFIX).toBe('mvs1.');
    expect(VOICE_STACK_KIND).toBe('magickvoice.voice-stack');
    expect(VOICE_STACK_MAX_CODE_LENGTH).toBe(16_384);
    expect(VOICE_STACK_CHECKSUM_LENGTH).toBe(8);
    expect(VOICE_STACK_MAX_PROVENANCE_BYTES).toBe(4_096);
    expect(VOICE_STACK_MAX_LANGUAGES).toBe(20);
    expect(LLM_REASONING_LEVELS).toEqual(['off', 'none', 'minimal', 'low', 'medium', 'high']);
  });
});

describe('isSafeText', () => {
  it.each(['', 'plain', 'ü 🎙️ नमस्ते', '\u007f', ' ', '🎙'])('accepts %j', (s) => {
    expect(isSafeText(s)).toBe(true);
  });

  it.each(['\u0000', 'a\nb', 'tab\t', '\u001f', '\uD800', 'x\uDC00', '\uDBFF\uD800', 'ok\uDE00ok'])('refuses %j', (s) => {
    expect(isSafeText(s)).toBe(false);
  });
});

describe('encodeVoiceStack / decodeVoiceStack', () => {
  it('round-trips a spec through its code', () => {
    const code = encodeVoiceStack(base());
    expect(code.startsWith('mvs1.')).toBe(true);
    expect(code).toMatch(/^mvs1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    const decoded = decodeVoiceStack(code);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.spec).toEqual(voiceStackSpecSchema.parse(base()));
    expect(decoded.checksum).toBe(code.slice(-8));
  });

  it('carries the sha256 of the canonical JSON bytes as its checksum', () => {
    const code = encodeVoiceStack(base());
    const [, payload, checksum] = code.split('.');
    const bytes = Buffer.from(payload, 'base64url');
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 8)).toBe(checksum);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(voiceStackSpecSchema.parse(base()));
  });

  it('is canonical: key order and whitespace do not change the code', () => {
    const shuffled = JSON.parse(JSON.stringify(base()), (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    );
    expect(encodeVoiceStack(shuffled)).toBe(encodeVoiceStack(base()));
    const decoded = decodeVoiceStack(encodeVoiceStack(base()));
    if (!decoded.ok) throw new Error('decode failed');
    expect(encodeVoiceStack(decoded.spec)).toBe(encodeVoiceStack(base()));
  });

  it('applies defaults and trims strings before encoding', () => {
    const spec = base();
    spec.stt = { provider: '  sarvam ', model: ' saaras:v3 ' };
    spec.meta = { name: '  Padded  ' };
    const decoded = decodeVoiceStack(encodeVoiceStack(spec));
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.spec.stt).toEqual({ provider: 'sarvam', model: 'saaras:v3', options: {} });
    expect(decoded.spec.meta).toEqual({ name: 'Padded' });
  });

  it('round-trips the reserved realtime architecture, unicode text and every reasoning level', () => {
    for (const reasoning of LLM_REASONING_LEVELS) {
      const spec = { ...base(), architecture: 'realtime' as const, llm: { provider: 'openai', model: 'gpt-5', options: { reasoning, temperature: 0.7, maxTokens: 256 } } };
      spec.meta = { name: 'हिन्दी 🎙️ stack', description: 'ଓଡ଼ିଆ' };
      const decoded = decodeVoiceStack(encodeVoiceStack(spec));
      expect(decoded.ok && decoded.spec.llm.options.reasoning).toBe(reasoning);
      expect(decoded.ok && decoded.spec.meta.name).toBe('हिन्दी 🎙️ stack');
    }
  });

  it('round-trips every scalar option type', () => {
    const spec = base();
    spec.tts.options = { speed: 1.25, loud: true, pitch: -2, style: 'calm', zero: 0 };
    const decoded = decodeVoiceStack(encodeVoiceStack(spec));
    expect(decoded.ok && decoded.spec.tts.options).toEqual({ speed: 1.25, loud: true, pitch: -2, style: 'calm', zero: 0 });
  });

  it('throws VoiceStackEncodeError("schema") for an invalid spec, with issues', () => {
    let caught: unknown;
    try {
      encodeVoiceStack({ ...base(), languages: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VoiceStackEncodeError);
    const e = caught as VoiceStackEncodeError;
    expect(e.name).toBe('VoiceStackEncodeError');
    expect(e.code).toBe('schema');
    expect(e.issues).toEqual([{ path: 'languages', message: 'at least one language is required' }]);
    expect(e.message).toBe('Invalid voice stack — languages: at least one language is required');
  });

  it('throws VoiceStackEncodeError("too_long") for a code past the limit', () => {
    const many = (prefix: string) =>
      Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`${prefix}${i}`.padEnd(40, 'x'), 'v'.repeat(200)]));
    const spec = base();
    spec.stt.options = many('s');
    spec.tts.options = many('t');
    let caught: unknown;
    try {
      encodeVoiceStack(spec);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VoiceStackEncodeError);
    expect((caught as VoiceStackEncodeError).code).toBe('too_long');
    expect((caught as VoiceStackEncodeError).issues).toEqual([]);
    expect((caught as Error).message).toMatch(/^Voice stack code is \d+ characters; at most 16384 allowed$/);
  });
});

describe('decodeVoiceStack: tolerance', () => {
  const code = encodeVoiceStack(base());

  it('strips whitespace and invisible paste noise anywhere in the code', () => {
    const wrapped = code.replace(/(.{20})/g, '$1\n  ');
    expect(decodeVoiceStack(`  ${wrapped}\t\r\n`).ok).toBe(true);
    const noisy = [...code].map((c, i) => (i % 7 === 0 ? `${c}​­` : i % 11 === 0 ? `${c}﻿⁠‌‍` : c)).join('');
    expect(decodeVoiceStack(noisy).ok).toBe(true);
  });

  it('accepts an uppercase checksum and reports it in lowercase', () => {
    const upper = code.slice(0, -8) + code.slice(-8).toUpperCase();
    const decoded = decodeVoiceStack(upper);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.checksum).toBe(code.slice(-8));
  });
});

describe('decodeVoiceStack: rejection', () => {
  const code = encodeVoiceStack(base());
  const errorOf = (input: unknown) => {
    const r = decodeVoiceStack(input as string);
    if (r.ok) throw new Error('decoded unexpectedly');
    return r.error;
  };

  it.each([
    ['empty input', ''],
    ['no prefix', 'hello'],
    ['the wrong family', 'mvx1.abc.12345678'],
    ['a version zero', 'mvs0.abc.12345678'],
    ['a leading zero version', 'mvs01.abc.12345678'],
    ['a missing dot', 'mvs1abc'],
    ['a capitalised prefix', 'MVS1.abc.12345678'],
  ])('bad_prefix: %s', (_label, input) => {
    expect(errorOf(input).code).toBe('bad_prefix');
  });

  it('bad_prefix for a non-string input', () => {
    for (const input of [undefined, null, 42, { code }, [code]]) expect(errorOf(input).code).toBe('bad_prefix');
  });

  it('unsupported_version for a future spec', () => {
    const e = errorOf(code.replace('mvs1.', 'mvs2.'));
    expect(e).toEqual({ code: 'unsupported_version', message: 'Voice stack spec v2 is not supported (this build reads v1)' });
    expect(errorOf('mvs999999.x.y').code).toBe('unsupported_version');
  });

  it('too_long, measured after the noise strip, and bounded before it', () => {
    expect(errorOf(`mvs1.${'A'.repeat(VOICE_STACK_MAX_CODE_LENGTH)}.12345678`).code).toBe('too_long');
    expect(errorOf(' '.repeat(VOICE_STACK_MAX_CODE_LENGTH * 2 + 1)).code).toBe('too_long');
    // Lots of whitespace that strips to a valid code is fine.
    expect(decodeVoiceStack(code + ' '.repeat(VOICE_STACK_MAX_CODE_LENGTH)).ok).toBe(true);
  });

  it.each([
    ['no checksum part', () => code.slice(0, code.lastIndexOf('.'))],
    ['an empty checksum', () => code.slice(0, -8)],
    ['an empty payload', () => `mvs1..${code.slice(-8)}`],
    ['an extra part', () => `${code}.deadbeef`],
    ['a short checksum', () => code.slice(0, -1)],
    ['a long checksum', () => `${code}0`],
    ['a non-hex checksum', () => `${code.slice(0, -8)}zzzzzzzz`],
    ['a payload with an illegal character', () => code.replace('mvs1.', 'mvs1.*')],
    ['a dangling base64 character', () => `mvs1.${code.split('.')[1]}A.${code.slice(-8)}`],
  ])('bad_encoding: %s', (_label, make) => {
    expect(errorOf(make()).code).toBe('bad_encoding');
  });

  it('checksum_mismatch for a different checksum', () => {
    const last = code.slice(-1);
    const other = last === '0' ? '1' : '0';
    expect(errorOf(code.slice(0, -1) + other)).toEqual({
      code: 'checksum_mismatch',
      message: 'Voice stack code is corrupted (checksum mismatch) — copy it again',
    });
  });

  it('every single-character substitution in the payload is caught', () => {
    const [, payload, checksum] = code.split('.');
    let checked = 0;
    for (let i = 0; i < payload.length; i++) {
      const replacement = ALPHABET[(ALPHABET.indexOf(payload[i]) + 1) % 64];
      const tampered = `mvs1.${payload.slice(0, i)}${replacement}${payload.slice(i + 1)}.${checksum}`;
      const r = decodeVoiceStack(tampered);
      expect(r.ok, `position ${i}`).toBe(false);
      if (!r.ok) expect(['checksum_mismatch', 'bad_encoding']).toContain(r.error.code);
      checked++;
    }
    expect(checked).toBe(payload.length);
  });

  it('every single-character substitution in the checksum is caught', () => {
    for (let i = 1; i <= 8; i++) {
      const c = code[code.length - i];
      const replacement = c === 'f' ? '0' : (parseInt(c, 16) + 1).toString(16);
      const tampered = code.slice(0, code.length - i) + replacement + code.slice(code.length - i + 1);
      expect(errorOf(tampered).code).toBe('checksum_mismatch');
    }
  });

  it('a truncated code is caught', () => {
    const [, payload, checksum] = code.split('.');
    for (const cut of [1, 2, 3, 4, 10, payload.length - 1]) {
      const r = decodeVoiceStack(`mvs1.${payload.slice(0, payload.length - cut)}.${checksum}`);
      expect(r.ok, `cut ${cut}`).toBe(false);
    }
  });

  it('bad_encoding for bytes that are not UTF-8, even with a correct checksum', () => {
    expect(errorOf(codeOf(new Uint8Array([0x7b, 0xff, 0x7d])))).toEqual({
      code: 'bad_encoding',
      message: 'Voice stack payload is not valid UTF-8',
    });
  });

  it('invalid_json for text that is not JSON, or that smuggles __proto__', () => {
    expect(errorOf(codeOfText('{not json')).code).toBe('invalid_json');
    expect(errorOf(codeOfText('')).code).toBe('bad_encoding'); // empty payload part
    const proto = errorOf(codeOfText('{"__proto__":{"polluted":true}}'));
    expect(proto.code).toBe('invalid_json');
    expect(proto.message).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const nested = errorOf(codeOfText(JSON.stringify({ meta: { provenance: { x: 1 } } }).replace('"x"', '"__proto__"')));
    expect(nested.code).toBe('invalid_json');
  });

  it('schema for well-encoded JSON that is not a voice stack, with dotted issue paths', () => {
    const e = errorOf(codeOfText(JSON.stringify({ ...voiceStackSpecSchema.parse(base()), languages: [{ code: 'hi', stt: 'hi-IN', tts: 'hi IN', voice: 'pooja' }] })));
    expect(e.code).toBe('schema');
    expect(e.issues).toEqual([{ path: 'languages.0.tts', message: 'must be a vendor language code (e.g. "hi-IN")' }]);
    expect(e.message).toBe('Invalid voice stack — languages.0.tts: must be a vendor language code (e.g. "hi-IN")');
    const many = errorOf(codeOfText('{}'));
    expect(many.code).toBe('schema');
    expect(many.message).toMatch(/\(\+\d+ more\)$/);
    expect(errorOf(codeOfText('[]')).message).toBe(`Invalid voice stack — (root): ${issuesOf([])[0].message}`);
  });

  it('never throws, whatever it is given', () => {
    const inputs = ['mvs1.', 'mvs1..', 'mvs1.\u0000.\u0000', `mvs1.${'_'.repeat(5000)}.00000000`, '\uD800', 'mvs1.A.' + 'f'.repeat(8)];
    for (const input of inputs) expect(() => decodeVoiceStack(input)).not.toThrow();
  });
});

describe('voiceStackSpecSchema', () => {
  it('accepts the base spec and fills option defaults', () => {
    const spec = base();
    delete (spec.tts as { options?: unknown }).options;
    delete (spec.llm as { options?: unknown }).options;
    const r = parseVoiceStackSpec(spec);
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec.tts.options).toEqual({});
    expect(r.ok && r.spec.llm.options).toEqual({});
  });

  it.each([
    ['an extra top-level key', (s: any) => (s.extra = 1), ''],
    ['an extra leg key', (s: any) => (s.stt.voice = 'x'), 'stt'],
    ['an extra llm option', (s: any) => (s.llm.options.topP = 1), 'llm.options'],
    ['an extra language-row key', (s: any) => (s.languages[0].speed = 1), 'languages.0'],
    ['an extra meta key', (s: any) => (s.meta.author = 'me'), 'meta'],
    ['an extra turn key', (s: any) => (s.turn.silenceMs = 500), 'turn'],
    ['the wrong kind', (s: any) => (s.kind = 'voice-stack'), 'kind'],
    ['the wrong spec version', (s: any) => (s.specVersion = 2), 'specVersion'],
    ['an unknown architecture', (s: any) => (s.architecture = 'hybrid'), 'architecture'],
    ['manual turn detection', (s: any) => (s.turn.detection = 'manual'), 'turn.detection'],
    ['an uppercase provider id', (s: any) => (s.stt.provider = 'Sarvam'), 'stt.provider'],
    ['a provider id starting with a digit', (s: any) => (s.tts.provider = '11labs'), 'tts.provider'],
    ['a 41-character provider id', (s: any) => (s.tts.provider = 'a'.repeat(41)), 'tts.provider'],
    ['a model id with a space', (s: any) => (s.llm.model = 'gemini flash'), 'llm.model'],
    ['an @variant model id', (s: any) => (s.stt.model = 'saaras:v3@fast'), 'stt.model'],
    ['an 81-character model id', (s: any) => (s.llm.model = 'm'.repeat(81)), 'llm.model'],
    ['an empty model id', (s: any) => (s.llm.model = ''), 'llm.model'],
    ['an option key that is not an identifier', (s: any) => (s.stt.options = { 'stream-type': 'fast' }), 'stt.options.stream-type'],
    ['a 201-character option string', (s: any) => (s.tts.options = { style: 'x'.repeat(201) }), 'tts.options.style'],
    ['a non-finite option', (s: any) => (s.tts.options = { speed: Infinity }), 'tts.options.speed'],
    ['an object option', (s: any) => (s.tts.options = { nested: {} }), 'tts.options.nested'],
    ['a control character in an option', (s: any) => (s.tts.options = { style: 'a\nb' }), 'tts.options.style'],
    ['an unknown reasoning level', (s: any) => (s.llm.options.reasoning = 'max'), 'llm.options.reasoning'],
    ['a temperature above 2', (s: any) => (s.llm.options.temperature = 2.01), 'llm.options.temperature'],
    ['a negative temperature', (s: any) => (s.llm.options.temperature = -0.1), 'llm.options.temperature'],
    ['maxTokens below 16', (s: any) => (s.llm.options.maxTokens = 15), 'llm.options.maxTokens'],
    ['maxTokens above 4096', (s: any) => (s.llm.options.maxTokens = 4097), 'llm.options.maxTokens'],
    ['fractional maxTokens', (s: any) => (s.llm.options.maxTokens = 100.5), 'llm.options.maxTokens'],
    ['a vendor code with a space', (s: any) => (s.languages[0].stt = 'hi IN'), 'languages.0.stt'],
    ['a 36-character vendor code', (s: any) => (s.languages[0].tts = 'h'.repeat(36)), 'languages.0.tts'],
    ['a voice with a space', (s: any) => (s.languages[0].voice = 'my voice'), 'languages.0.voice'],
    ['a 129-character voice', (s: any) => (s.languages[0].voice = 'v'.repeat(129)), 'languages.0.voice'],
    ['a non-boolean default', (s: any) => (s.languages[0].default = 'yes'), 'languages.0.default'],
    ['an empty name', (s: any) => (s.meta.name = '   '), 'meta.name'],
    ['an 81-character name', (s: any) => (s.meta.name = 'n'.repeat(81)), 'meta.name'],
    ['a control character in the name', (s: any) => (s.meta.name = 'a\u0000b'), 'meta.name'],
    ['a lone surrogate in the description', (s: any) => (s.meta.description = 'x\uD800'), 'meta.description'],
    ['a 501-character description', (s: any) => (s.meta.description = 'd'.repeat(501)), 'meta.description'],
    ['101 provenance sessions', (s: any) => (s.meta.provenance = { sessions: Array.from({ length: 101 }, (_, i) => `r${i}`) }), 'meta.provenance.sessions'],
    ['a 129-character session id', (s: any) => (s.meta.provenance = { sessions: ['s'.repeat(129)] }), 'meta.provenance.sessions.0'],
    ['a control character in a passthrough provenance value', (s: any) => (s.meta.provenance = { note: 'a\tb' }), 'meta.provenance.note'],
    ['a lone surrogate in a passthrough provenance key', (s: any) => (s.meta.provenance = { latency: { ['k\uDC00']: 1 } }), 'meta.provenance.latency.k\uDC00'],
  ])('rejects %s', (_label, mutate, path) => {
    const spec = JSON.parse(JSON.stringify(base()));
    mutate(spec);
    expect(pathsOf(spec)).toContain(path);
  });

  it('words every unsafe-text refusal the same way', () => {
    const spec = { ...base(), meta: { name: 'a\u0000b', description: 'x\uD800', provenance: { note: 'a\nb' } } };
    const issues = issuesOf(spec);
    expect(issues.map((i) => i.path).sort()).toEqual(['meta.description', 'meta.name', 'meta.provenance.note']);
    for (const issue of issues) expect(issue.message).toBe(UNSAFE_TEXT_MESSAGE);
  });

  it('allows exactly 32 options and refuses 33', () => {
    const opts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, i]));
    expect(parseVoiceStackSpec({ ...base(), stt: { provider: 'sarvam', model: 'm', options: opts(32) } }).ok).toBe(true);
    expect(issuesOf({ ...base(), stt: { provider: 'sarvam', model: 'm', options: opts(33) } })).toEqual([
      { path: 'stt.options', message: 'at most 32 options' },
    ]);
  });

  it('accepts the boundary values of every bounded field', () => {
    const spec = base();
    spec.tts.provider = 'a'.repeat(40);
    spec.llm.model = 'models/' + 'm'.repeat(73);
    spec.llm.options = { temperature: 0, maxTokens: 16 };
    spec.languages = [{ code: 'cmn', stt: 'c'.repeat(35), tts: 'cmn-Hans-CN', voice: 'v'.repeat(128), default: true }];
    spec.meta = { name: 'n'.repeat(80), description: 'd'.repeat(500) };
    expect(parseVoiceStackSpec(spec).ok).toBe(true);
    spec.llm.options = { temperature: 2, maxTokens: 4096 };
    expect(parseVoiceStackSpec(spec).ok).toBe(true);
  });

  it('wants the normalised base code for a row, and says which', () => {
    const withCode = (code: string) => ({ ...base(), languages: [{ code, stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' }] });
    expect(issuesOf(withCode('hi-IN'))).toEqual([{ path: 'languages.0.code', message: 'must be the normalised base code "hi"' }]);
    expect(issuesOf(withCode('HI'))).toEqual([{ path: 'languages.0.code', message: 'must be the normalised base code "hi"' }]);
    expect(issuesOf(withCode('od'))).toEqual([{ path: 'languages.0.code', message: 'must be the normalised base code "or"' }]);
    expect(issuesOf(withCode('unknown'))).toEqual([{ path: 'languages.0.code', message: 'must be a 2–3 letter base language code (e.g. "hi")' }]);
    // Surrounding whitespace is trimmed before the check.
    expect(parseVoiceStackSpec(withCode(' hi ')).ok).toBe(true);
  });

  it('allows 1 to 20 languages', () => {
    const codes = 'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br'.split(' ');
    const rows = (n: number) => codes.slice(0, n).map((code) => ({ code, stt: code, tts: code, voice: 'v' }));
    expect(parseVoiceStackSpec({ ...base(), languages: rows(1) }).ok).toBe(true);
    expect(parseVoiceStackSpec({ ...base(), languages: rows(20) }).ok).toBe(true);
    expect(issuesOf({ ...base(), languages: rows(21) })).toEqual([{ path: 'languages', message: 'at most 20 languages' }]);
  });

  it('refuses a duplicate language and a second default', () => {
    const row = { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' };
    expect(issuesOf({ ...base(), languages: [row, { ...row, voice: 'other' }] })).toEqual([
      { path: 'languages.1.code', message: 'duplicate language "hi"' },
    ]);
    expect(
      issuesOf({ ...base(), languages: [{ ...row, default: true }, { code: 'en', stt: 'en-IN', tts: 'en-IN', voice: 'v', default: true }] }),
    ).toEqual([{ path: 'languages.1.default', message: 'at most one language may be the default' }]);
    expect(parseVoiceStackSpec({ ...base(), languages: [{ ...row, default: false }, { code: 'en', stt: 'en', tts: 'en', voice: 'v', default: true }] }).ok).toBe(true);
  });

  it('bounds provenance by size, not shape', () => {
    const fits = { source: 'grindelwald', blob: 'x'.repeat(4000) };
    expect(parseVoiceStackSpec({ ...base(), meta: { name: 'n', provenance: fits } }).ok).toBe(true);
    const tooBig = { source: 'grindelwald', blob: 'x'.repeat(4096) };
    const issues = issuesOf({ ...base(), meta: { name: 'n', provenance: tooBig } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('meta.provenance');
    expect(issues[0].message).toMatch(/^is \d+ bytes; at most 4096 allowed$/);
  });

  it('counts provenance size in UTF-8 bytes, not characters', () => {
    // 1400 three-byte characters: ~4.2 KB of UTF-8 but only 1400 UTF-16 units.
    const issues = issuesOf({ ...base(), meta: { name: 'n', provenance: { note: 'न'.repeat(1400) } } });
    expect(issues.map((i) => i.path)).toEqual(['meta.provenance']);
  });

  it('refuses provenance that is not plain JSON', () => {
    const issues = issuesOf({ ...base(), meta: { name: 'n', provenance: { latency: { at: new Date(0) } } } });
    expect(issues.some((i) => i.path === 'meta.provenance' && i.message.startsWith('must be plain JSON'))).toBe(true);
    const nan = issuesOf({ ...base(), meta: { name: 'n', provenance: { latency: { ttfa: NaN } } } });
    expect(nan.some((i) => i.message.includes('non-finite number'))).toBe(true);
  });

  it('passes unknown provenance keys through untouched', () => {
    const r = parseVoiceStackSpec({ ...base(), meta: { name: 'n', provenance: { sessionCount: 3, promptSha256: 'ab', latency: { x: [1, 2] } } } });
    expect(r.ok && r.spec.meta.provenance).toEqual({ sessionCount: 3, promptSha256: 'ab', latency: { x: [1, 2] } });
  });

  it('refuses non-objects outright', () => {
    for (const v of [null, undefined, 'mvs1.x', 42, []]) expect(parseVoiceStackSpec(v).ok).toBe(false);
  });
});

describe('behaviourHash', () => {
  const h = (spec: VoiceStackSpecInput) => behaviourHash(spec);

  it('is 64 hex characters', () => {
    expect(h(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores meta entirely', () => {
    const renamed = { ...base(), meta: { name: 'Something else', description: 'new', provenance: { sessions: ['x', 'y'] } } };
    expect(h(renamed)).toBe(h(base()));
  });

  it('ignores row order and how the default is spelled', () => {
    const [hi, or] = base().languages;
    const reordered = { ...base(), languages: [{ ...or }, { ...hi, default: true }] };
    const explicit = { ...base(), languages: [{ ...hi, default: true }, { ...or, default: false }] };
    expect(h(explicit)).toBe(h(base()));
    expect(h(reordered)).toBe(h(base()));
  });

  it('changes when the default language changes', () => {
    const [hi, or] = base().languages;
    expect(h({ ...base(), languages: [hi, { ...or, default: true }] })).not.toBe(h(base()));
  });

  it('changes when anything behavioural changes', () => {
    const variants: VoiceStackSpecInput[] = [
      { ...base(), stt: { ...base().stt, options: { streamType: 'balanced' } } },
      { ...base(), llm: { ...base().llm, options: { reasoning: 'high' } } },
      { ...base(), tts: { ...base().tts, model: 'bulbul:v2' } },
      { ...base(), languages: [{ ...base().languages[0], voice: 'other' }, base().languages[1]] },
      { ...base(), architecture: 'realtime' },
    ];
    const hashes = new Set([h(base()), ...variants.map(h)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('treats an omitted options object like an empty one', () => {
    const spec = base();
    delete (spec.tts as { options?: unknown }).options;
    expect(h(spec)).toBe(h(base()));
  });

  it('throws VoiceStackEncodeError for an invalid spec', () => {
    expect(() => h({ ...base(), kind: 'nope' } as unknown as VoiceStackSpecInput)).toThrow(VoiceStackEncodeError);
  });
});

describe('defaultLanguage / languageRowFor', () => {
  const spec = voiceStackSpecSchema.parse(base());

  it('defaults to the first row, or the one marked default', () => {
    expect(defaultLanguage(spec).code).toBe('hi');
    const marked = voiceStackSpecSchema.parse({ ...base(), languages: [base().languages[0], { ...base().languages[1], default: true }] });
    expect(defaultLanguage(marked).code).toBe('or');
  });

  it('throws on an empty language list (impossible for a parsed spec)', () => {
    expect(() => defaultLanguage({ languages: [] })).toThrow('voice stack has no languages');
  });

  it.each([
    ['hi', 'hi'],
    ['HI', 'hi'],
    ['hi-IN', 'hi'],
    ['hi_IN', 'hi'],
    ['or-IN', 'or'],
    ['od-IN', 'or'],
  ])('finds the row for %j', (code, want) => {
    expect(languageRowFor(spec, code)?.code).toBe(want);
  });

  it.each([['en'], ['en-IN'], [''], ['unknown'], [null], [undefined]])('has no row for %j, and no fallback', (code) => {
    expect(languageRowFor(spec, code as string | null | undefined)).toBeNull();
  });
});
