// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/language.ts
// by `npm run sync-voice-stack-spec`; edit it in core and re-run that.

/**
 * The one language-code normaliser for Voice Stacks.
 *
 * A stack's language rows are keyed by a BASE code (`hi`, `te`, `en`); vendors
 * spell the same language their own way (`hi-IN`, `hi_IN`, `HI`). Every place
 * that matches a requested language against a row — the stack validator, the
 * call validator, the inbound resolver and the cascade engine — goes through
 * this function, so they can never disagree about whether `hi-IN` is covered by
 * a `hi` row.
 *
 * Vendor-specific base codes collapse to the ISO 639-1 code through the small,
 * explicit {@link VENDOR_BASE_ALIASES} map, so a row keyed `or` covers a call
 * that arrives in Sarvam's `od-IN`. Add an entry only for a real vendor case,
 * with a comment naming the vendor.
 *
 * IMPORT-FREE ON PURPOSE, and free of zod too: it is copied verbatim into
 * Grindelwald's browser frontend, and imported by modules that must never load
 * `src/config/index.js` (see CLAUDE.md, "Module graph & tests").
 */

const BASE_CODE = /^[a-z]{2,3}$/;

/** Vendor base code → ISO 639-1. Keys and values are lowercase base codes. */
const VENDOR_BASE_ALIASES: Readonly<Record<string, string>> = {
  od: 'or', // Sarvam spells Odia `od-IN` (STT and TTS); ISO 639-1 is `or`.
};

/**
 * Trim, lowercase, take the segment before the first `-` or `_`, and accept it
 * only if it is 2–3 ASCII letters, then apply the vendor alias map (`od` →
 * `or`). Anything else (empty, `x`, `hindi`, a non-string) is `null`.
 */
export function normaliseLanguageCode(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const base = input.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  if (!BASE_CODE.test(base)) return null;
  return Object.prototype.hasOwnProperty.call(VENDOR_BASE_ALIASES, base) ? VENDOR_BASE_ALIASES[base]! : base;
}
