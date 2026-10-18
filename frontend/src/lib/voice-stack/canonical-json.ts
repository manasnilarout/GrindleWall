// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/canonical-json.ts
// by `npm run sync-voice-stack-spec`; edit it in core and re-run that.

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays kept in
 * order. Two values that are equal as JSON serialise to the same string — the
 * property the Voice Stack checksum and `behaviourHash` rely on.
 *
 * Keys sort by UTF-16 code unit (`Array.prototype.sort`'s default), which is the
 * same in every JS engine, so Node and the Grindelwald browser copy agree.
 * Primitive formatting is `JSON.stringify`'s (ES2019 well-formed strings).
 *
 * Throws {@link CanonicalJsonError} on anything that is not plain JSON —
 * non-finite numbers, bigint, functions, symbols, `undefined` array elements,
 * non-plain objects (Date, Map, class instances) — and on nesting deeper than
 * {@link MAX_DEPTH} (which also stops a cycle). Object properties whose value is
 * `undefined` are omitted, exactly as `JSON.stringify` omits them.
 *
 * IMPORT-FREE ON PURPOSE (see CLAUDE.md, "Module graph & tests").
 */

const MAX_DEPTH = 32;

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, 0, '$');
}

function write(value: unknown, depth: number, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: non-finite number`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not JSON`);
  }

  if (depth >= MAX_DEPTH) throw new CanonicalJsonError(`${path}: nested deeper than ${MAX_DEPTH}`);

  if (Array.isArray(value)) {
    const parts = value.map((item, i) => {
      if (item === undefined) throw new CanonicalJsonError(`${path}[${i}]: undefined is not JSON`);
      return write(item, depth + 1, `${path}[${i}]`);
    });
    return `[${parts.join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(`${path}: not a plain object`);
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${write(item, depth + 1, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}
