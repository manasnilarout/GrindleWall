// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/spec.ts
// by `npm run sync-voice-stack-spec`; edit it in core and re-run that.

import { z } from 'zod';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from './bytes.js';
import { canonicalJson } from './canonical-json.js';
import { normaliseLanguageCode } from './language.js';
import { sha256Hex } from './sha256.js';

/**
 * Voice Stack spec v1: the schema of a portable "voice stack" (STT + LLM + TTS
 * + per-language rows) and its shareable text code.
 *
 *   mvs1.<base64url(UTF-8 canonical JSON), no padding>.<first 8 hex of sha256(those bytes)>
 *
 * Grindelwald produces codes, core imports them. This directory is copied
 * VERBATIM into Grindelwald's browser frontend (`frontend/src/lib/voice-stack/`,
 * by its sync script — never hand-edit the mirror), so every file here imports
 * only `zod` and its siblings: no Node APIs (`bytes.ts` and `sha256.ts` are the
 * portable codecs and digest), and nothing that could load `src/config/index.js`
 * (see CLAUDE.md, "Module graph & tests").
 *
 * VERSIONING: the version lives in the PREFIX. A breaking change is spec v2 —
 * prefix `mvs2.`, its own schema, and a new branch in `decodeVoiceStack` — never
 * a silent change to what `mvs1.` means. Codes already handed out must keep
 * decoding to the same spec forever. Additive optional fields are still a v2:
 * `.strict()` objects make an older decoder refuse them, which is the point.
 *
 * What the schema does NOT decide: whether a provider/model/voice exists or can
 * run. Ids are only shape-checked here; core's `validate.ts` checks them
 * against the provider registry and reports precisely what it cannot run.
 */

export const VOICE_STACK_SPEC_VERSION = 1;
export const VOICE_STACK_PREFIX = `mvs${VOICE_STACK_SPEC_VERSION}.`;
export const VOICE_STACK_KIND = 'magickvoice.voice-stack';
/** Longest code `decodeVoiceStack` accepts and `encodeVoiceStack` may produce. */
export const VOICE_STACK_MAX_CODE_LENGTH = 16_384;
/** Hex characters of the sha256 checksum carried in the code. */
export const VOICE_STACK_CHECKSUM_LENGTH = 8;
/** Bound on `meta.provenance`, measured as UTF-8 bytes of its canonical JSON. */
export const VOICE_STACK_MAX_PROVENANCE_BYTES = 4_096;
export const VOICE_STACK_MAX_LANGUAGES = 20;

// ── Field shapes ─────────────────────────────────────────────────────────────

/** Canonical provider id (`sarvam`, `google`, `cartesia`, …). Lowercase only. */
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/;
/** The vendor's own model id, verbatim: `saaras:v3`, `gemini-3.1-flash-lite`, `models/x`. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:\-/]{0,79}$/i;
/** A vendor language code: `hi-IN`, `od-IN`, `cmn-Hans-CN`, `es-419`, `unknown`. */
const VENDOR_LANGUAGE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,34}$/;
/** A voice name or id: `anushka`, `Kore`, a Cartesia UUID, an ElevenLabs id. */
const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,127}$/;
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_OPTIONS = 32;

// ── Text safety ─────────────────────────────────────────────────────────────
//
// A string that decodes as valid JSON is not necessarily storable: Postgres
// `jsonb` refuses U+0000 (`\u0000`) and an unpaired surrogate (`\ud800`), so a
// code carrying either decodes, validates, then 500s on the INSERT (and a
// rename to one 500s on the UPDATE). Every free-text string is therefore
// refused when it holds a C0 control (U+0000–U+001F, no exceptions — names and
// descriptions are single-line) or a surrogate that is not half of a pair.

/** C0 control characters (U+0000–U+001F). */
const C0_CONTROL = /[\u0000-\u001F]/;
/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const UNSAFE_TEXT_MESSAGE = 'must not contain control characters or unpaired surrogates';

/** Whether `value` is free of C0 controls and unpaired surrogates (storable in jsonb / text). */
export function isSafeText(value: string): boolean {
  return !C0_CONTROL.test(value) && !LONE_SURROGATE.test(value);
}

const safeString = () => z.string().refine(isSafeText, UNSAFE_TEXT_MESSAGE);

/**
 * Every string — object keys included — inside an arbitrary JSON value that is
 * not {@link isSafeText}, with its path. For the passthrough parts of
 * provenance, whose shape the schema does not know.
 */
function unsafeTextPaths(value: unknown, path: (string | number)[], out: (string | number)[][], depth = 0): void {
  if (depth > 32 || out.length >= 10) return;
  if (typeof value === 'string') {
    if (!isSafeText(value)) out.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => unsafeTextPaths(item, [...path, i], out, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!isSafeText(key)) out.push([...path, key]);
      unsafeTextPaths(item, [...path, key], out, depth + 1);
    }
  }
}

const providerId = z
  .string()
  .trim()
  .regex(PROVIDER_ID, 'must be a lowercase provider id (e.g. "sarvam", "google")');

const modelId = z.string().trim().regex(MODEL_ID, "must be the vendor's model id (letters, digits, . _ : - /; max 80)");

const vendorLanguageCode = z
  .string()
  .trim()
  .regex(VENDOR_LANGUAGE_CODE, 'must be a vendor language code (e.g. "hi-IN")');

/** Free-form vendor options (STT/TTS): flat scalars only, bounded. */
const scalarOptions = z
  .record(
    z.string().regex(OPTION_KEY, 'option keys must be identifiers'),
    z.union([safeString().pipe(z.string().max(200)), z.number().finite(), z.boolean()]),
  )
  .refine((options) => Object.keys(options).length <= MAX_OPTIONS, {
    message: `at most ${MAX_OPTIONS} options`,
  })
  .default({});

const sttSchema = z
  .object({
    provider: providerId,
    model: modelId,
    /** Variants live here, never as an `@variant` model suffix (e.g. Sarvam `streamType`). */
    options: scalarOptions,
  })
  .strict();

const ttsSchema = z
  .object({
    provider: providerId,
    model: modelId,
    options: scalarOptions,
  })
  .strict();

export const LLM_REASONING_LEVELS = ['off', 'none', 'minimal', 'low', 'medium', 'high'] as const;

const llmSchema = z
  .object({
    provider: providerId,
    model: modelId,
    options: z
      .object({
        reasoning: z.enum(LLM_REASONING_LEVELS).optional(),
        temperature: z.number().finite().min(0).max(2).optional(),
        maxTokens: z.number().int().min(16).max(4096).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const languageRowSchema = z
  .object({
    /** Normalised base code (`hi`, not `hi-IN`) — the key calls are matched on. */
    code: z
      .string()
      .trim()
      .refine(
        (code) => normaliseLanguageCode(code) === code,
        (code) => {
          const suggestion = normaliseLanguageCode(code);
          return {
            message: suggestion
              ? `must be the normalised base code "${suggestion}"`
              : 'must be a 2–3 letter base language code (e.g. "hi")',
          };
        },
      ),
    /** The STT vendor's spelling of this language. */
    stt: vendorLanguageCode,
    /** The TTS vendor's spelling of this language. */
    tts: vendorLanguageCode,
    voice: z.string().trim().regex(VOICE_ID, 'must be a voice name or id (no spaces; max 128)'),
    default: z.boolean().optional(),
  })
  .strict();

const languagesSchema = z
  .array(languageRowSchema)
  .min(1, 'at least one language is required')
  .max(VOICE_STACK_MAX_LANGUAGES, `at most ${VOICE_STACK_MAX_LANGUAGES} languages`)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    let defaults = 0;
    rows.forEach((row, i) => {
      if (seen.has(row.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'code'], message: `duplicate language "${row.code}"` });
      }
      seen.add(row.code);
      if (row.default === true && ++defaults > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'default'], message: 'at most one language may be the default' });
      }
    });
  });

const boundedText = (max: number) => safeString().pipe(z.string().trim().max(max));

/**
 * Where the stack came from (Grindelwald session ids, measured latency/cost).
 * Informational only — never read by the engine, excluded from `behaviourHash`.
 * Passthrough so Grindelwald can add measurements without a spec version bump,
 * which is why it is bounded by SIZE rather than by shape.
 */
const provenanceSchema = z
  .object({
    source: boundedText(200).optional(),
    exportedAt: boundedText(64).optional(),
    exportedBy: boundedText(200).optional(),
    sessions: z.array(boundedText(128)).max(100).optional(),
    latency: z.record(z.string(), z.unknown()).optional(),
    costPerMinute: z.record(z.string(), z.unknown()).optional(),
    measuredLanguages: z.array(boundedText(35)).max(50).optional(),
  })
  .passthrough()
  .superRefine((provenance, ctx) => {
    // The typed keys are checked by their own schemas; this catches the rest
    // (passthrough keys, the measurement records) — anything that reaches jsonb.
    const unsafe: (string | number)[][] = [];
    unsafeTextPaths(provenance, [], unsafe);
    for (const path of unsafe) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: UNSAFE_TEXT_MESSAGE });
    let json: string;
    try {
      json = canonicalJson(provenance);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be plain JSON (${err instanceof Error ? err.message : String(err)})`,
      });
      return;
    }
    const bytes = utf8Encode(json).length;
    if (bytes > VOICE_STACK_MAX_PROVENANCE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `is ${bytes} bytes; at most ${VOICE_STACK_MAX_PROVENANCE_BYTES} allowed`,
      });
    }
  });

const metaSchema = z
  .object({
    name: safeString().pipe(z.string().trim().min(1, 'name is required').max(80)),
    description: boundedText(500).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export const voiceStackSpecSchema = z
  .object({
    kind: z.literal(VOICE_STACK_KIND),
    specVersion: z.literal(VOICE_STACK_SPEC_VERSION),
    /** `realtime` is reserved: the schema accepts it, core's validator refuses it in v1. */
    architecture: z.enum(['cascade', 'realtime']),
    stt: sttSchema,
    llm: llmSchema,
    tts: ttsSchema,
    languages: languagesSchema,
    turn: z.object({ detection: z.literal('server_vad') }).strict(),
    meta: metaSchema,
  })
  .strict();

/** A validated spec (defaults applied, strings trimmed). */
export type VoiceStackSpec = z.output<typeof voiceStackSpecSchema>;
/** What a producer may hand to `encodeVoiceStack` (`options` may be omitted). */
export type VoiceStackSpecInput = z.input<typeof voiceStackSpecSchema>;
export type VoiceStackLanguage = VoiceStackSpec['languages'][number];

// ── Results and errors ───────────────────────────────────────────────────────

export type VoiceStackErrorCode =
  | 'bad_prefix'
  | 'unsupported_version'
  | 'bad_encoding'
  | 'checksum_mismatch'
  | 'too_long'
  | 'invalid_json'
  | 'schema';

export interface VoiceStackIssue {
  /** Dotted path into the decoded JSON, e.g. `languages.1.voice`; `''` for the root. */
  path: string;
  message: string;
}

export interface VoiceStackError {
  code: VoiceStackErrorCode;
  message: string;
  /** Present for `schema` errors only. */
  issues?: VoiceStackIssue[];
}

export type VoiceStackDecodeResult =
  | { ok: true; spec: VoiceStackSpec; checksum: string }
  | { ok: false; error: VoiceStackError };

export type VoiceStackParseResult = { ok: true; spec: VoiceStackSpec } | { ok: false; error: VoiceStackError };

/**
 * Thrown by `encodeVoiceStack` / `behaviourHash` on an invalid spec. That is a
 * bug in the PRODUCER (it built the spec), so it throws rather than returning a
 * result the way decoding untrusted input does.
 */
export class VoiceStackEncodeError extends Error {
  readonly code: 'schema' | 'too_long';
  readonly issues: VoiceStackIssue[];

  constructor(code: 'schema' | 'too_long', message: string, issues: VoiceStackIssue[] = []) {
    super(message);
    this.name = 'VoiceStackEncodeError';
    this.code = code;
    this.issues = issues;
  }
}

function toIssues(error: z.ZodError): VoiceStackIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function schemaError(issues: VoiceStackIssue[]): VoiceStackError {
  const first = issues[0];
  const summary = first ? `${first.path || '(root)'}: ${first.message}` : 'invalid voice stack';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return { code: 'schema', message: `Invalid voice stack — ${summary}${more}`, issues };
}

function fail(code: VoiceStackErrorCode, message: string): { ok: false; error: VoiceStackError } {
  return { ok: false, error: { code, message } };
}

// ── Parse / encode / decode ──────────────────────────────────────────────────

/** Validate an already-decoded value (e.g. a stored `spec` jsonb). Never throws. */
export function parseVoiceStackSpec(value: unknown): VoiceStackParseResult {
  const parsed = voiceStackSpecSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: schemaError(toIssues(parsed.error)) };
  return { ok: true, spec: parsed.data };
}

function parseOrThrow(spec: VoiceStackSpecInput): VoiceStackSpec {
  const parsed = parseVoiceStackSpec(spec);
  if (!parsed.ok) {
    throw new VoiceStackEncodeError('schema', parsed.error.message, parsed.error.issues ?? []);
  }
  return parsed.spec;
}

/**
 * Encode a spec as an `mvs1.` code. Validates first and encodes the PARSED
 * value, so the output is canonical: `encodeVoiceStack(decode(code).spec)`
 * reproduces a canonical code exactly, whatever key order or whitespace the
 * producer used. Throws {@link VoiceStackEncodeError} on an invalid spec or one
 * whose code would exceed {@link VOICE_STACK_MAX_CODE_LENGTH}.
 */
export function encodeVoiceStack(spec: VoiceStackSpecInput): string {
  const bytes = utf8Encode(canonicalJson(parseOrThrow(spec)));
  const checksum = sha256Hex(bytes).slice(0, VOICE_STACK_CHECKSUM_LENGTH);
  const code = `${VOICE_STACK_PREFIX}${base64UrlEncode(bytes)}.${checksum}`;
  if (code.length > VOICE_STACK_MAX_CODE_LENGTH) {
    throw new VoiceStackEncodeError(
      'too_long',
      `Voice stack code is ${code.length} characters; at most ${VOICE_STACK_MAX_CODE_LENGTH} allowed`,
    );
  }
  return code;
}

const VERSIONED_PREFIX = /^mvs([1-9]\d{0,5})\./;
const CHECKSUM = new RegExp(`^[0-9a-f]{${VOICE_STACK_CHECKSUM_LENGTH}}$`, 'i');

/** `JSON.parse` reviver: a `__proto__` key is never legitimate here and is refused outright. */
function refuseProtoKeys(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new SyntaxError('forbidden key "__proto__"');
  return value;
}

/**
 * What a paste can add to a code without anyone seeing it: whitespace (chat
 * apps and email wrap long lines) and the invisible format characters rich
 * text inserts — zero-width space / non-joiner / joiner (U+200B–U+200D), word
 * joiner (U+2060), BOM (U+FEFF) and soft hyphen (U+00AD). None of them is a
 * base64url character, so stripping them cannot change what a code decodes to.
 */
const PASTE_NOISE = /[\s\u200B-\u200D\u2060\uFEFF\u00AD]+/g;

/**
 * Decode untrusted input (a pasted code). NEVER throws: every failure is a
 * structured error with a stable `code`.
 *
 * All whitespace and invisible paste noise ({@link PASTE_NOISE}) is stripped
 * first (codes get wrapped by chat apps and email),
 * then checked in order: length, prefix/version, shape, base64url, checksum
 * (over the decoded BYTES, so it is checked before UTF-8 and catches any
 * altered byte), UTF-8, JSON, schema.
 */
export function decodeVoiceStack(input: string): VoiceStackDecodeResult {
  try {
    return decodeUnsafe(input);
  } catch (err) {
    // Unreachable by design; the contract is "never throws", so hold it regardless.
    return fail('bad_encoding', `Could not decode voice stack code: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function decodeUnsafe(input: unknown): VoiceStackDecodeResult {
  if (typeof input !== 'string') return fail('bad_prefix', `Not a voice stack code (expected "${VOICE_STACK_PREFIX}…")`);
  // Bound the work before the whitespace strip touches a huge string.
  if (input.length > VOICE_STACK_MAX_CODE_LENGTH * 2) return tooLong(input.length);
  const code = input.replace(PASTE_NOISE, '');
  if (code.length > VOICE_STACK_MAX_CODE_LENGTH) return tooLong(code.length);

  const versioned = VERSIONED_PREFIX.exec(code);
  if (!versioned) return fail('bad_prefix', `Not a voice stack code (expected "${VOICE_STACK_PREFIX}…")`);
  const version = Number(versioned[1]);
  if (version !== VOICE_STACK_SPEC_VERSION) {
    return fail(
      'unsupported_version',
      `Voice stack spec v${version} is not supported (this build reads v${VOICE_STACK_SPEC_VERSION})`,
    );
  }

  const parts = code.slice(versioned[0].length).split('.');
  const [payload, checksumText] = parts;
  if (parts.length !== 2 || !payload || !checksumText) {
    return fail('bad_encoding', 'Malformed voice stack code (expected "mvs1.<payload>.<checksum>")');
  }
  if (!CHECKSUM.test(checksumText)) {
    return fail('bad_encoding', `Malformed checksum (expected ${VOICE_STACK_CHECKSUM_LENGTH} hex characters)`);
  }
  const bytes = base64UrlDecode(payload);
  if (!bytes) return fail('bad_encoding', 'Voice stack payload is not valid base64url');

  const checksum = sha256Hex(bytes).slice(0, VOICE_STACK_CHECKSUM_LENGTH);
  if (checksum !== checksumText.toLowerCase()) {
    return fail('checksum_mismatch', 'Voice stack code is corrupted (checksum mismatch) — copy it again');
  }

  const text = utf8Decode(bytes);
  if (text === null) return fail('bad_encoding', 'Voice stack payload is not valid UTF-8');

  let json: unknown;
  try {
    json = JSON.parse(text, refuseProtoKeys);
  } catch (err) {
    return fail('invalid_json', `Voice stack payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseVoiceStackSpec(json);
  if (!parsed.ok) return parsed;
  return { ok: true, spec: parsed.spec, checksum };
}

function tooLong(length: number): VoiceStackDecodeResult {
  return fail('too_long', `Voice stack code is ${length} characters; at most ${VOICE_STACK_MAX_CODE_LENGTH} allowed`);
}

// ── Behaviour identity and language lookup ───────────────────────────────────

/**
 * Identity of what a stack DOES: sha256 hex of the canonical JSON of the spec
 * without `meta`. Two specs that differ only in name, description or provenance
 * — or only in key order — hash the same, which is what lets an import of an
 * already-known stack merge into it instead of creating a duplicate.
 *
 * Also normalises the two language-row choices that cannot change behaviour:
 * row ORDER (rows are keyed by `code`, so they are hashed sorted by it) and how
 * the default is SPELLED (an implicit first-row default, `default: true` on that
 * row, and `default: false` on the others are all one stack). Throws
 * {@link VoiceStackEncodeError} on an invalid spec.
 */
export function behaviourHash(spec: VoiceStackSpecInput): string {
  const parsed = parseOrThrow(spec);
  const defaultCode = defaultLanguage(parsed).code;
  const { meta: _meta, ...behaviour } = parsed;
  const languages = parsed.languages
    .map(({ default: _default, ...row }) => (row.code === defaultCode ? { ...row, default: true } : row))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sha256Hex(utf8Encode(canonicalJson({ ...behaviour, languages })));
}

/** The default language row: the one marked `default: true`, else the first. */
export function defaultLanguage(spec: Pick<VoiceStackSpec, 'languages'>): VoiceStackLanguage {
  const row = spec.languages.find((candidate) => candidate.default === true) ?? spec.languages[0];
  if (!row) throw new Error('voice stack has no languages'); // impossible for a parsed spec
  return row;
}

/**
 * The row covering `code` (any spelling `normaliseLanguageCode` accepts:
 * `hi`, `HI`, `hi-IN`, `hi_IN`), or `null` when the stack does not cover it.
 * No fallback to the default — callers decide that (outbound refuses, inbound
 * falls back).
 */
export function languageRowFor(
  spec: Pick<VoiceStackSpec, 'languages'>,
  code: string | null | undefined,
): VoiceStackLanguage | null {
  const base = normaliseLanguageCode(code);
  if (!base) return null;
  return spec.languages.find((row) => row.code === base) ?? null;
}
