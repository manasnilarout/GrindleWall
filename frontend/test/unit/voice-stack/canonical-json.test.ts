import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from '../../../src/lib/voice-stack/canonical-json';

const nestArrays = (depth: number): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
const nestObjects = (depth: number): unknown => {
  let v: unknown = 'leaf';
  for (let i = 0; i < depth; i++) v = { k: v };
  return v;
};

describe('canonicalJson: primitives', () => {
  it.each([
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [-0, '0'],
    [1.0, '1'],
    [-12.5, '-12.5'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [Number.MIN_VALUE, '5e-324'],
    ['', '""'],
    ['a"b\\c', '"a\\"b\\\\c"'],
    ['line\nbreak\ttab', '"line\\nbreak\\ttab"'],
    ['\u0000\u001f', '"\\u0000\\u001f"'],
    ['ü 🎙️ नमस्ते', '"ü 🎙️ नमस्ते"'],
    ['  ', '"  "'],
  ])('%j -> %s', (value, out) => {
    expect(canonicalJson(value)).toBe(out);
  });

  it('writes lone surrogates as escapes (well-formed JSON.stringify)', () => {
    expect(canonicalJson('\uD800')).toBe('"\\ud800"');
    expect(canonicalJson('a\uDC00b')).toBe('"a\\udc00b"');
  });

  it('matches JSON.stringify on primitives', () => {
    for (const v of [0, 1, -1, 3.14159, 1e300, -1e-300, 'x', '', true, null]) {
      expect(canonicalJson(v)).toBe(JSON.stringify(v));
    }
  });
});

describe('canonicalJson: structure', () => {
  it('sorts object keys and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2, c: { z: true, y: null } })).toBe('{"a":2,"b":1,"c":{"y":null,"z":true}}');
  });

  it('sorts nested keys recursively, including inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: [{ d: 1, c: 2 }] }])).toBe('[{"a":[{"c":2,"d":1}],"b":1}]');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2, 'b', 'a'])).toBe('[3,1,2,"b","a"]');
  });

  it('serialises empty containers', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it('sorts keys by UTF-16 code unit, not by locale or code point', () => {
    // Uppercase before lowercase; digits before letters.
    expect(canonicalJson({ b: 1, B: 2, a: 3, '1': 4, _: 5 })).toBe('{"1":4,"B":2,"_":5,"a":3,"b":1}');
    // U+1F399 is the surrogate pair D83C DF99, which sorts before U+FFFD (but after it by code point).
    expect(canonicalJson({ '�': 1, '🎙': 2 })).toBe('{"🎙":2,"�":1}');
    expect(canonicalJson({ é: 1, z: 2 })).toBe('{"z":2,"é":1}');
  });

  it('escapes keys exactly as JSON.stringify does', () => {
    expect(canonicalJson({ 'a"b': 1, 'x\ny': 2 })).toBe('{"a\\"b":1,"x\\ny":2}');
  });

  it('omits undefined-valued properties like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ a: undefined })).toBe('{}');
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });

  it('serialises an own "__proto__" key as data', () => {
    const o = JSON.parse('{"__proto__":{"x":1},"a":1}');
    expect(canonicalJson(o)).toBe('{"__proto__":{"x":1},"a":1}');
  });

  it('ignores symbol keys', () => {
    expect(canonicalJson({ [Symbol('s')]: 1, a: 1 })).toBe('{"a":1}');
  });

  it('is independent of key insertion order', () => {
    const a = { x: 1, y: { p: [1, { r: 1, q: 2 }], o: 'z' } };
    const b = { y: { o: 'z', p: [1, { q: 2, r: 1 }] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('is a fixed point through JSON.parse', () => {
    const value = { z: [1, 'two', { b: null, a: false }], a: { '🎙': 1, A: -0.5 } };
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
    expect(JSON.parse(once)).toEqual({ z: [1, 'two', { b: null, a: false }], a: { '🎙': 1, A: -0.5 } });
  });
});

describe('canonicalJson: rejection', () => {
  it.each([
    ['NaN', NaN, '$: non-finite number'],
    ['Infinity', Infinity, '$: non-finite number'],
    ['-Infinity', -Infinity, '$: non-finite number'],
    ['undefined', undefined, '$: undefined is not JSON'],
    ['a bigint', 10n, '$: bigint is not JSON'],
    ['a function', () => 1, '$: function is not JSON'],
    ['a symbol', Symbol('x'), '$: symbol is not JSON'],
    ['a Date', new Date(0), '$: not a plain object'],
    ['a Map', new Map(), '$: not a plain object'],
    ['a Set', new Set(), '$: not a plain object'],
    ['a RegExp', /x/, '$: not a plain object'],
    ['a typed array', new Uint8Array(2), '$: not a plain object'],
    ['a boxed string', Object('x'), '$: not a plain object'],
    ['a class instance', new (class Foo {})(), '$: not a plain object'],
  ])('throws CanonicalJsonError for %s', (_label, value, message) => {
    let caught: unknown;
    try {
      canonicalJson(value);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonError);
    expect((caught as Error).name).toBe('CanonicalJsonError');
    expect((caught as Error).message).toBe(message);
  });

  it('names the path of a nested failure', () => {
    expect(() => canonicalJson({ a: [1, { b: NaN }] })).toThrow('$.a[1].b: non-finite number');
    expect(() => canonicalJson({ list: [1, undefined] })).toThrow('$.list[1]: undefined is not JSON');
    expect(() => canonicalJson([{ when: new Date() }])).toThrow('$[0].when: not a plain object');
  });

  it('allows 32 levels of nesting and refuses the 33rd', () => {
    expect(canonicalJson(nestArrays(32))).toBe('['.repeat(32) + '0' + ']'.repeat(32));
    expect(() => canonicalJson(nestArrays(33))).toThrow('nested deeper than 32');
    expect(() => canonicalJson(nestObjects(32))).not.toThrow();
    expect(() => canonicalJson(nestObjects(33))).toThrow(CanonicalJsonError);
  });

  it('stops a cycle with a CanonicalJsonError rather than a stack overflow', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(CanonicalJsonError);
  });

  // BUG (src/lib/voice-stack/canonical-json.ts:53): `Array.prototype.map` skips
  // holes, so a sparse array never reaches the `undefined` check and serialises
  // as `[1,,2]` — which is not JSON — instead of throwing. Repro:
  // `canonicalJson([1, , 2])` returns "[1,,2]".
  //
  // Left pinned: this file is a synced copy, so the fix belongs upstream in
  // magic-voice-core (then `npm run sync-voice-stack-spec`). The bench cannot
  // reach it: canonicalJson is only called from spec.ts, on zod-parsed values,
  // and zod's array parse (`[...ctx.data]`) turns any hole into `undefined`,
  // which the element schema rejects. The only unparsed values are
  // provenance's `latency` / `costPerMinute` passthroughs, which
  // `provenanceFrom` builds as object literals with no arrays; every other
  // array export.ts and CreateCodeDialog build comes from map/filter/spread
  // over dense arrays.
  it.fails('rejects a sparse-array hole the way it rejects an undefined element', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 2])).toThrow(CanonicalJsonError);
  });
});
