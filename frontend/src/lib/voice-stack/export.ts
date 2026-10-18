/**
 * Rig → MagickVoice voice stack. Hand-written; the rest of this directory is
 * core's spec, synced by `npm run sync-voice-stack-spec` and never edited here.
 *
 * The bench and core name things differently, and this file is the whole of the
 * translation:
 *
 * - **Provider ids.** The bench keys a provider by vendor AND leg
 *   (`sarvam-stt`, `sarvam-tts`); core keys it by vendor alone and the leg is
 *   the spec field it sits in. A bench provider absent from the map has no
 *   counterpart in core, and export refuses it rather than guessing a name.
 * - **`@variant` model ids.** The bench encodes a variant in the model id
 *   (`saaras:v3-realtime@fast`, `gemini-3.1-flash-lite@minimal`); core takes the
 *   vendor's model id verbatim and the variant as an option. A variant this file
 *   does not know how to translate also refuses — dropping it would export a
 *   different stack from the one that was measured.
 *
 * This validates against the bench's own catalog only. Core re-validates
 * against what it can actually run and reports what it cannot, so a clean
 * checklist here means "well-formed and consistent with what was measured", not
 * "core will accept it".
 */
import { languagesFor, resolveVoice, voicesFor, type ProviderEntry } from '../catalog';
import type { SessionIndexEntry } from '../protocol';
import type { Rig } from '../rigs';
import { normaliseLanguageCode } from './language';
import {
  LLM_REASONING_LEVELS,
  VOICE_STACK_KIND,
  VOICE_STACK_MAX_LANGUAGES,
  VOICE_STACK_SPEC_VERSION,
  voiceStackSpecSchema,
  type VoiceStackSpecInput,
} from './spec';

type Leg = 'stt' | 'llm' | 'tts';

/** Bench provider id → core's canonical provider id, per leg. */
export const CANONICAL_PROVIDER_IDS: Readonly<Record<Leg, Readonly<Record<string, string>>>> = {
  stt: {
    'sarvam-stt': 'sarvam',
    'gemini-stt': 'gemini',
    'cartesia-stt': 'cartesia',
    'deepgram-stt': 'deepgram',
  },
  llm: {
    'openai-llm': 'openai',
    'google-llm': 'google',
  },
  tts: {
    'sarvam-tts': 'sarvam',
    'cartesia-tts': 'cartesia',
    'elevenlabs-tts': 'elevenlabs',
    'murf-tts': 'murf',
    'gemini-tts': 'gemini',
  },
};

type Options = Record<string, string | number | boolean>;
type VariantRule = (variant: string) => Options | string;

const SARVAM_STREAM_TYPES = ['fast', 'balanced'];

/**
 * How a bench `@variant` becomes options, per bench provider. Returns the
 * options, or a message saying why the variant cannot be exported.
 */
const VARIANT_RULES: Readonly<Record<string, VariantRule>> = {
  'sarvam-stt': (v) =>
    SARVAM_STREAM_TYPES.includes(v) ? { streamType: v } : `unknown Sarvam stream type "@${v}" (known: ${SARVAM_STREAM_TYPES.join(', ')})`,
  'google-llm': reasoningVariant,
  'openai-llm': reasoningVariant,
};

function reasoningVariant(v: string): Options | string {
  return (LLM_REASONING_LEVELS as readonly string[]).includes(v)
    ? { reasoning: v }
    : `unknown reasoning level "@${v}" (known: ${LLM_REASONING_LEVELS.join(', ')})`;
}

export interface MappedLeg {
  provider: string;
  model: string;
  options: Options;
}

/** One leg in core's terms, or why it has none. */
export function mapLeg(leg: Leg, benchProviderId: string, benchModelId: string): { ok: true; value: MappedLeg } | { ok: false; error: string } {
  const provider = CANONICAL_PROVIDER_IDS[leg][benchProviderId];
  if (!provider) {
    const known = Object.keys(CANONICAL_PROVIDER_IDS[leg]).join(', ');
    return { ok: false, error: `${benchProviderId} has no MagickVoice ${leg.toUpperCase()} provider id (exportable: ${known})` };
  }
  // Same split the bench providers use: the LAST `@` starts the variant.
  const at = benchModelId.lastIndexOf('@');
  const model = at === -1 ? benchModelId : benchModelId.slice(0, at);
  const variant = at === -1 ? '' : benchModelId.slice(at + 1);
  if (!model) return { ok: false, error: `${benchProviderId} has no model selected` };
  if (!variant) return { ok: true, value: { provider, model, options: {} } };

  const rule = VARIANT_RULES[benchProviderId];
  if (!rule) return { ok: false, error: `${benchProviderId} model "${benchModelId}" carries a variant this export cannot translate` };
  const options = rule(variant);
  if (typeof options === 'string') return { ok: false, error: `${benchProviderId}: ${options}` };
  return { ok: true, value: { provider, model, options } };
}

/* -------------------------------- selection -------------------------------- */

export interface ExportLanguage {
  /** Any spelling `normaliseLanguageCode` accepts; the spec gets the base code. */
  code: string;
  /** The STT vendor's code for this language, as the bench catalog spells it. */
  sttLang: string;
  /** The TTS vendor's code, which can differ: Sarvam STT `or-IN`, Sarvam TTS `od-IN`. */
  ttsLang: string;
  voice: string;
}

/**
 * Informational only: core never reads it, and it is excluded from the stack's
 * identity. A `type`, not an interface, so it is assignable to the spec's
 * passthrough record.
 */
export type ExportProvenance = {
  source?: string;
  exportedAt?: string;
  exportedBy?: string;
  sessions?: string[];
  sessionCount?: number;
  latency?: Record<string, unknown>;
  costPerMinute?: Record<string, unknown>;
  measuredLanguages?: string[];
};

export interface ExportSelection {
  /** In order; the first row is the stack's default language. */
  languages: ExportLanguage[];
  name: string;
  description?: string;
  provenance?: ExportProvenance;
}

export interface ExportCheck {
  level: 'block' | 'warn' | 'ok';
  message: string;
}

/**
 * The spec this rig and selection describe. Throws when a leg cannot be mapped,
 * so call {@link checkExportable} first: it reports the same failures, all of
 * them, in words.
 */
export function buildVoiceStackSpec(rig: Rig, _providers: ProviderEntry[], selection: ExportSelection): VoiceStackSpecInput {
  const legs = legsOf(rig);
  const mapped = legs.map(({ leg, providerId, modelId }) => {
    const result = mapLeg(leg, providerId, modelId);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
  const [stt, llm, tts] = mapped as [MappedLeg, MappedLeg, MappedLeg];

  const description = selection.description?.trim();
  return {
    kind: VOICE_STACK_KIND,
    specVersion: VOICE_STACK_SPEC_VERSION,
    architecture: 'cascade',
    stt,
    llm,
    tts,
    languages: selection.languages.map((row) => ({
      // An unnormalisable code is left as typed so the schema names it, rather
      // than being silently swapped for something else.
      code: normaliseLanguageCode(row.code) ?? row.code.trim(),
      stt: row.sttLang.trim(),
      tts: row.ttsLang.trim(),
      voice: row.voice.trim(),
    })),
    turn: { detection: 'server_vad' },
    meta: {
      name: selection.name.trim(),
      ...(description ? { description } : {}),
      ...(selection.provenance ? { provenance: selection.provenance } : {}),
    },
  };
}

/**
 * Everything that stands between this rig and a code, as a checklist. `block`
 * means no code is produced; `warn` is exported anyway and said out loud.
 */
export function checkExportable(rig: Rig, providers: ProviderEntry[], selection: ExportSelection): ExportCheck[] {
  if (rig.mode === 'realtime') {
    return [{ level: 'block', message: 'Realtime stacks are not supported by core yet — export a pipeline rig (STT → LLM → TTS).' }];
  }

  const checks: ExportCheck[] = [];
  const block = (message: string) => checks.push({ level: 'block', message });

  let legsOk = true;
  for (const { leg, providerId, modelId } of legsOf(rig)) {
    const label = leg.toUpperCase();
    const entry = providers.find((p) => p.id === providerId && p.kind === leg);
    if (!entry) {
      block(`${label}: ${providerId || 'nothing'} is not in the catalog.`);
      legsOk = false;
      continue;
    }
    if (providerId.startsWith('mock-')) {
      block(`${label}: ${entry.name} is a mock provider — pick a real one to export.`);
      legsOk = false;
      continue;
    }
    if (!entry.implemented) {
      block(`${label}: ${entry.name} is not implemented in the bench, so nothing about it was measured.`);
      legsOk = false;
      continue;
    }
    if (!entry.models.some((m) => m.id === modelId)) {
      block(`${label}: model "${modelId}" is not one ${entry.name} lists.`);
      legsOk = false;
      continue;
    }
    const mapped = mapLeg(leg, providerId, modelId);
    if (!mapped.ok) {
      block(`${label}: ${mapped.error}.`);
      legsOk = false;
    }
  }

  checks.push(...checkLanguages(rig, providers, selection));
  checks.push(...checkMeasured(selection));

  // Last, and only when everything above is clean: the spec's own schema. It
  // catches what the catalog cannot — a name too long, a voice id the spec's
  // character set refuses — in the same words core will use.
  if (legsOk && !checks.some((c) => c.level === 'block')) {
    const parsed = voiceStackSpecSchema.safeParse(buildVoiceStackSpec(rig, providers, selection));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) block(`${issue.path.join('.') || 'spec'}: ${issue.message}`);
    }
  }

  if (!checks.some((c) => c.level === 'block')) {
    const n = selection.languages.length;
    checks.push({
      level: 'ok',
      message: `Ready: ${n} language${n === 1 ? '' : 's'}, default ${normaliseLanguageCode(selection.languages[0]?.code) ?? '—'}.`,
    });
  }
  return checks;
}

function checkLanguages(rig: Rig, providers: ProviderEntry[], selection: ExportSelection): ExportCheck[] {
  const out: ExportCheck[] = [];
  const rows = selection.languages;
  if (rows.length === 0) out.push({ level: 'block', message: 'Pick at least one language.' });
  if (rows.length > VOICE_STACK_MAX_LANGUAGES) {
    out.push({ level: 'block', message: `At most ${VOICE_STACK_MAX_LANGUAGES} languages fit in one stack.` });
  }

  const sttLangs = languagesFor(providers, rig.sttProviderId, rig.sttModelId);
  const ttsLangs = languagesFor(providers, rig.ttsProviderId, rig.ttsModelId);
  const tts = providers.find((p) => p.id === rig.ttsProviderId);
  const seen = new Set<string>();

  for (const row of rows) {
    const code = normaliseLanguageCode(row.code);
    const name = code ?? (row.code || '(blank)');
    if (!code) {
      out.push({ level: 'block', message: `"${row.code}" is not a language — a stack row needs a real one (auto-detect cannot be a row).` });
      continue;
    }
    if (seen.has(code)) out.push({ level: 'block', message: `${code} is listed twice.` });
    seen.add(code);

    for (const [leg, vendorCode, list, model] of [
      ['STT', row.sttLang, sttLangs, rig.sttModelId],
      ['TTS', row.ttsLang, ttsLangs, rig.ttsModelId],
    ] as const) {
      if (normaliseLanguageCode(vendorCode) !== code) {
        out.push({ level: 'block', message: `${name}: the ${leg} code "${vendorCode || '(blank)'}" is not ${code}.` });
      } else if (list.length > 0 && !list.some((l) => l.id === vendorCode)) {
        out.push({ level: 'block', message: `${name}: ${model} does not list ${leg} language "${vendorCode}".` });
      } else if (list.length === 0) {
        out.push({ level: 'warn', message: `${name}: the catalog lists no languages for ${model}, so "${vendorCode}" is unchecked.` });
      }
    }

    const voice = row.voice.trim();
    const voices = voicesFor(providers, rig.ttsProviderId, rig.ttsModelId, row.ttsLang);
    if (!voice) {
      out.push({ level: 'block', message: `${name}: pick a voice.` });
    } else if (!voices.some((v) => v.id === voice)) {
      if (tts?.acceptsVoiceId) {
        out.push({ level: 'warn', message: `${name}: "${voice}" is a custom voice id the bench cannot check against ${rig.ttsModelId}.` });
      } else {
        out.push({ level: 'block', message: `${name}: "${voice}" is not a ${rig.ttsModelId} voice for ${row.ttsLang}.` });
      }
    }
  }
  return out;
}

function checkMeasured(selection: ExportSelection): ExportCheck[] {
  const provenance = selection.provenance;
  if (!provenance?.sessions?.length) {
    return [{ level: 'warn', message: 'No recorded session used this exact STT/LLM/TTS combination — the code carries no measurements.' }];
  }
  const measured = new Set(provenance.measuredLanguages ?? []);
  const unmeasured = selection.languages
    .map((row) => normaliseLanguageCode(row.code))
    .filter((code): code is string => Boolean(code) && !measured.has(code as string));
  return unmeasured.length
    ? [{ level: 'warn', message: `Never measured on this combination: ${unmeasured.join(', ')}.` }]
    : [];
}

function legsOf(rig: Rig): Array<{ leg: Leg; providerId: string; modelId: string }> {
  return [
    { leg: 'stt', providerId: rig.sttProviderId, modelId: rig.sttModelId },
    { leg: 'llm', providerId: rig.llmProviderId, modelId: rig.llmModelId },
    { leg: 'tts', providerId: rig.ttsProviderId, modelId: rig.ttsModelId },
  ];
}

/* ------------------------------- provenance -------------------------------- */

/** Ids carried in the code. Provenance is bounded to 4 KB, and a record id is ~40 bytes. */
const MAX_PROVENANCE_SESSIONS = 40;

/**
 * Records that ran this rig's three legs, provider and model (variant included),
 * under server VAD — the only turn detection a v1 code carries (`turn.detection:
 * 'server_vad'`), so a push-to-talk ('manual') record measured a different
 * turn loop and its latency is not this stack's. Languages may differ.
 */
export function matchingSessions(rig: Rig, sessions: SessionIndexEntry[]): SessionIndexEntry[] {
  if (rig.mode !== 'pipeline') return [];
  return sessions.filter((s) => {
    const c = s.config;
    return (
      s.mode === 'pipeline' &&
      s.turnCount > 0 &&
      c !== undefined &&
      c.turnDetection === 'server_vad' &&
      c.sttProviderId === rig.sttProviderId &&
      c.sttModelId === rig.sttModelId &&
      c.llmProviderId === rig.llmProviderId &&
      c.llmModelId === rig.llmModelId &&
      c.ttsProviderId === rig.ttsProviderId &&
      c.ttsModelId === rig.ttsModelId
    );
  });
}

/** The language a record SPOKE (its TTS language), as a base code. */
export function measuredLanguageOf(session: SessionIndexEntry): string | null {
  return normaliseLanguageCode(session.config?.ttsLanguage) ?? normaliseLanguageCode(session.config?.language);
}

/**
 * What the matching records measured, in the shape the spec carries.
 *
 * Each record already holds its own TTFA median and p95, but not its turns, so
 * the cross-record figures are medians OF those per-record values — the
 * `basis` field says exactly that, so nobody reads them as a pooled p95. Cost
 * per minute is pooled honestly (total cost over total minutes) and marked a
 * floor when any record had an unpriced leg.
 */
export function provenanceFrom(rig: Rig, sessions: SessionIndexEntry[], now = new Date()): ExportProvenance {
  const matched = matchingSessions(rig, sessions).sort((a, b) => b.startedAt - a.startedAt);
  const provenance: ExportProvenance = { source: 'grindelwald', exportedAt: now.toISOString() };
  if (matched.length === 0) return provenance;

  provenance.sessions = matched.slice(0, MAX_PROVENANCE_SESSIONS).map((s) => s.recordId);
  provenance.sessionCount = matched.length;
  provenance.measuredLanguages = [...new Set(matched.map(measuredLanguageOf).filter((c): c is string => Boolean(c)))].sort();

  const medians = matched.map((s) => s.latency?.ttfaMedianMs).filter(isNum);
  const p95s = matched.map((s) => s.latency?.ttfaP95Ms).filter(isNum);
  if (medians.length) {
    provenance.latency = {
      ttfaMedianMs: round1(median(medians)),
      ...(p95s.length ? { ttfaP95Ms: round1(median(p95s)) } : {}),
      basis: `median across ${medians.length} session${medians.length === 1 ? '' : 's'} of each session's own value`,
    };
  }

  const minutes = matched.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) / 60_000;
  if (minutes > 0) {
    provenance.costPerMinute = {
      usd: round4(matched.reduce((sum, s) => sum + s.costUsd, 0) / minutes),
      inr: round4(matched.reduce((sum, s) => sum + s.costInr, 0) / minutes),
      floor: matched.some((s) => s.unpriced.length > 0),
    };
  }
  return provenance;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------ language rows ------------------------------ */

export interface LanguageOption {
  /** Base code (`or`). */
  code: string;
  /** Display name, from the TTS leg's catalog entry. */
  name: string;
  /** Every STT / TTS spelling of it the model lists, e.g. Murf's `en-US`, `en-UK`, `en-IN`. */
  stt: string[];
  tts: string[];
}

/**
 * The languages BOTH legs list, grouped by base code. Auto-detect normalises to
 * nothing and so never appears: a stack row names one language.
 */
export function sharedLanguages(rig: Rig, providers: ProviderEntry[]): LanguageOption[] {
  const group = (providerId: string, modelId: string) => {
    const byCode = new Map<string, { ids: string[]; name: string }>();
    for (const l of languagesFor(providers, providerId, modelId)) {
      const code = normaliseLanguageCode(l.id);
      if (!code) continue;
      const slot = byCode.get(code) ?? { ids: [], name: l.name };
      slot.ids.push(l.id);
      byCode.set(code, slot);
    }
    return byCode;
  };
  const stt = group(rig.sttProviderId, rig.sttModelId);
  const tts = group(rig.ttsProviderId, rig.ttsModelId);
  return [...tts.entries()]
    .filter(([code]) => stt.has(code))
    .map(([code, t]) => ({ code, name: t.name, stt: stt.get(code)!.ids, tts: t.ids }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A new row for `option`, prefilled: the rig's own vendor codes where they name
 * this language (so the rig's own row is exactly what was measured), else the
 * first spelling each leg lists; the voice is kept when this language still
 * offers it, the same rule `resolveVoice` applies everywhere else.
 */
export function rowFor(rig: Rig, providers: ProviderEntry[], option: LanguageOption): ExportLanguage {
  const sttLang = option.stt.includes(rig.sttLanguage) ? rig.sttLanguage : option.stt[0];
  const ttsLang = option.tts.includes(rig.ttsLanguage) ? rig.ttsLanguage : option.tts[0];
  return { code: option.code, sttLang, ttsLang, voice: resolveVoice(providers, rig.ttsProviderId, rig.ttsModelId, ttsLang, rig.voice) };
}

/**
 * The row the rig itself speaks, or none. When both legs share that language
 * it is prefilled from the rig; when they do not, the rig's own codes are kept
 * as they are so the checklist says what is wrong with them instead of the row
 * quietly vanishing.
 */
export function initialRows(rig: Rig, providers: ProviderEntry[]): ExportLanguage[] {
  if (rig.mode !== 'pipeline') return [];
  const code = normaliseLanguageCode(rig.ttsLanguage) ?? normaliseLanguageCode(rig.sttLanguage);
  if (!code) return [];
  const option = sharedLanguages(rig, providers).find((o) => o.code === code);
  const tts = providers.find((p) => p.id === rig.ttsProviderId);
  const custom = tts?.acceptsVoiceId ? rig.customVoiceId.trim() : '';
  if (option) {
    const row = rowFor(rig, providers, option);
    return [{ ...row, voice: custom || (option.tts.includes(rig.ttsLanguage) ? rig.voice || row.voice : row.voice) }];
  }
  return [{ code, sttLang: rig.sttLanguage, ttsLang: rig.ttsLanguage, voice: custom || rig.voice }];
}
