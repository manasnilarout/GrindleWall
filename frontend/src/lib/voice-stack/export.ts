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
import type { SessionIndexEntry, StartConfig } from '../protocol';
import { typedVoiceIdOf, type Rig } from '../rigs';
import { utf8Encode } from './bytes';
import { normaliseLanguageCode } from './language';
import { sha256Hex } from './sha256';
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
  /** SHA-256 of the system prompt the cited sessions ran under; see {@link promptSha256}. */
  promptSha256?: string;
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
 * What the bench is set to beyond the rig itself. Required, not optional, so a
 * caller cannot forget it: the dialog used to be handed only the rig, and a
 * bench on push-to-talk exported a server-VAD code with a green checklist.
 */
export interface ExportContext {
  /** The bench's turn detection (the prompt panel's select), which every session it runs uses. */
  turnDetection: StartConfig['turnDetection'];
  /** What {@link citeSessions} found, for the checklist's wording. Absent: no sessions read. */
  citation?: Citation;
}

/** Why a v1 code cannot carry this turn detection, or `null` when it can. */
function turnDetectionBlocker(turnDetection: StartConfig['turnDetection']): string | null {
  return turnDetection === 'server_vad'
    ? null
    : 'Push-to-talk (manual turn detection) cannot be exported — a v1 code carries server VAD only. ' +
        'Switch the bench to Server VAD, run the stack, then export.';
}

/**
 * The spec this rig and selection describe. Throws when a leg cannot be mapped
 * or the bench's turn detection is one a v1 code cannot carry, so call
 * {@link checkExportable} first: it reports the same failures, all of them, in
 * words.
 */
export function buildVoiceStackSpec(
  rig: Rig,
  _providers: ProviderEntry[],
  selection: ExportSelection,
  context: ExportContext,
): VoiceStackSpecInput {
  const turnBlocker = turnDetectionBlocker(context.turnDetection);
  if (turnBlocker) throw new Error(turnBlocker);
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
export function checkExportable(
  rig: Rig,
  providers: ProviderEntry[],
  selection: ExportSelection,
  context: ExportContext,
): ExportCheck[] {
  if (rig.mode === 'realtime') {
    return [{ level: 'block', message: 'Realtime stacks are not supported by core yet — export a pipeline rig (STT → LLM → TTS).' }];
  }
  // Same shape as the realtime refusal, for the same reason: the code would
  // describe a turn loop other than the one the bench is running.
  const turnBlocker = turnDetectionBlocker(context.turnDetection);
  if (turnBlocker) return [{ level: 'block', message: turnBlocker }];

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
  checks.push(...checkMeasured(selection, context.citation));

  // Last, and only when everything above is clean: the spec's own schema. It
  // catches what the catalog cannot — a name too long, a voice id the spec's
  // character set refuses — in the same words core will use.
  if (legsOk && !checks.some((c) => c.level === 'block')) {
    const parsed = voiceStackSpecSchema.safeParse(buildVoiceStackSpec(rig, providers, selection, context));
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

function checkMeasured(selection: ExportSelection, citation?: Citation): ExportCheck[] {
  const out: ExportCheck[] = [];
  const warn = (message: string) => out.push({ level: 'warn', message });
  const provenance = selection.provenance;
  const cited = Boolean(provenance?.sessions?.length);

  if (!cited) {
    warn(
      "No recorded session used this exact stack (STT/LLM/TTS, server VAD, the current system prompt, and a row's language " +
        'in its voice) — the code carries no measurements.',
    );
  }
  if (citation?.otherPrompt) {
    warn(`${plural(citation.otherPrompt)} on these legs ran under a different system prompt and ${citation.otherPrompt === 1 ? 'is' : 'are'} not cited — the prompt moves TTFA.`);
  }
  if (citation?.unhashed) {
    warn(
      `${plural(citation.unhashed)} on these legs ${citation.unhashed === 1 ? 'was' : 'were'} listed without a prompt hash ` +
        '(a backend older than this export) and cannot be matched on the prompt, so not cited — update and restart the backend.',
    );
  }

  const measured = new Set(provenance?.measuredLanguages ?? []);
  const unmeasured: string[] = [];
  for (const row of selection.languages) {
    const code = normaliseLanguageCode(row.code);
    if (!code || measured.has(code)) continue;
    // A session that spoke this language in ANOTHER voice is not evidence for
    // this row — TTS latency moves with the voice — but it is worth naming.
    const others = citation?.otherVoices[code] ?? [];
    if (others.length) {
      warn(`${code}: no recorded session used the voice "${row.voice.trim()}" — sessions on this stack spoke ${code} in ${others.map((v) => `"${v}"`).join(', ')}, so none is cited for it.`);
    } else {
      unmeasured.push(code);
    }
  }
  if (cited && unmeasured.length) warn(`Never measured on this combination: ${unmeasured.join(', ')}.`);
  return out;
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
 * under server VAD — the first cut of {@link citeSessions}, which then narrows
 * by prompt and per-row voice — the only turn detection a v1 code carries (`turn.detection:
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
 * The index row's prompt fingerprint, computed the way the backend computes it
 * (`promptSha256` in `backend/src/store/SessionStore.ts`): SHA-256 of the
 * UTF-8 prompt exactly as sent, untrimmed, as lowercase hex.
 */
export function promptSha256(prompt: string): string {
  return sha256Hex(utf8Encode(prompt));
}

/** Which recorded sessions a code may cite, and what was left out and why. */
export interface Citation {
  /** Cited as this stack's measurements, newest first. */
  cited: SessionIndexEntry[];
  /** The prompt hash they were matched on. */
  promptSha256: string;
  /** Same legs under server VAD, but another system prompt. Not cited. */
  otherPrompt: number;
  /** Same legs under server VAD, listed without a prompt hash (an older backend). Not cited. */
  unhashed: number;
  /**
   * Per stack row (base code): the voices other sessions on these legs and this
   * prompt spoke that language in, when that is not the row's voice.
   */
  otherVoices: Record<string, string[]>;
}

/**
 * The sessions that measured THIS stack: {@link matchingSessions} (the three
 * legs under server VAD), run under the bench's current system prompt, and
 * speaking one of the stack's languages in that row's voice.
 *
 * The prompt and the voice are both latency inputs — the prompt presets exist
 * to move TTFA, and TTS time-to-first-byte moves with the voice — so averaging
 * across either would cite a number this stack never produced. A row from a
 * backend that lists no prompt hash cannot be matched on the prompt, and is
 * counted (so the checklist can say so) rather than either cited or silently
 * dropped. A session in a language the stack does not carry measures nothing
 * about it.
 */
export function citeSessions(rig: Rig, sessions: SessionIndexEntry[], rows: ExportLanguage[], systemPrompt: string): Citation {
  const hash = promptSha256(systemPrompt);
  const voiceOf = new Map<string, string>();
  for (const row of rows) {
    const code = normaliseLanguageCode(row.code);
    if (code && !voiceOf.has(code)) voiceOf.set(code, row.voice.trim());
  }

  const citation: Citation = { cited: [], promptSha256: hash, otherPrompt: 0, unhashed: 0, otherVoices: {} };
  for (const s of matchingSessions(rig, sessions)) {
    if (typeof s.promptSha256 !== 'string') {
      citation.unhashed += 1;
      continue;
    }
    if (s.promptSha256 !== hash) {
      citation.otherPrompt += 1;
      continue;
    }
    const code = measuredLanguageOf(s);
    const want = code ? voiceOf.get(code) : undefined;
    if (!code || want === undefined) continue;
    const voice = s.config?.voice?.trim() ?? '';
    if (voice && voice === want) {
      citation.cited.push(s);
    } else {
      const seen = (citation.otherVoices[code] ??= []);
      const name = voice || '(no voice recorded)';
      if (!seen.includes(name)) seen.push(name);
    }
  }
  citation.cited.sort((a, b) => b.startedAt - a.startedAt);
  return citation;
}

/**
 * What the cited records measured, in the shape the spec carries.
 *
 * Each index row holds its session's TTFA median and p95, not its turns, so the
 * cross-record figures are medians OF those per-session values, and they are
 * named that way: `ttfaSessionP95MedianMs` is the median of per-session p95s,
 * NOT a p95 of turns — a 2-turn session's p95 is nearly its max. `basis` says
 * so in words.
 *
 * Cost per minute divides by minutes of assistant SPEECH (`speechSeconds`),
 * never by `durationMs`: that is wall clock, so silence and a tab left open
 * counted as usage and one long-open session pulled the rate toward zero. A row
 * without speech time — no TTS audio reported, or an older backend — is left
 * out of the rate entirely (its cost too), never counted as zero minutes.
 */
export function provenanceFrom(citation: Citation | undefined, now = new Date()): ExportProvenance {
  const provenance: ExportProvenance = { source: 'grindelwald', exportedAt: now.toISOString() };
  const matched = citation?.cited ?? [];
  if (matched.length === 0) return provenance;

  provenance.sessions = matched.slice(0, MAX_PROVENANCE_SESSIONS).map((s) => s.recordId);
  provenance.sessionCount = matched.length;
  provenance.measuredLanguages = [...new Set(matched.map(measuredLanguageOf).filter((c): c is string => Boolean(c)))].sort();
  provenance.promptSha256 = citation!.promptSha256;

  const medians = matched.map((s) => s.latency?.ttfaMedianMs).filter(isNum);
  const p95s = matched.map((s) => s.latency?.ttfaP95Ms).filter(isNum);
  if (medians.length) {
    provenance.latency = {
      ttfaMedianMs: round1(median(medians)),
      ...(p95s.length ? { ttfaSessionP95MedianMs: round1(median(p95s)) } : {}),
      basis:
        `median across ${plural(medians.length)} of each session's own TTFA median` +
        (p95s.length ? `; the p95 figure is the median of ${plural(p95s.length)}' own p95s, not a p95 of turns` : ''),
    };
  }

  const spoken = matched.filter((s) => isNum(s.speechSeconds) && s.speechSeconds > 0);
  const minutes = spoken.reduce((sum, s) => sum + (s.speechSeconds as number), 0) / 60;
  if (minutes > 0) {
    provenance.costPerMinute = {
      usd: round4(spoken.reduce((sum, s) => sum + s.costUsd, 0) / minutes),
      inr: round4(spoken.reduce((sum, s) => sum + s.costInr, 0) / minutes),
      floor: spoken.some((s) => s.unpriced.length > 0),
      speechMinutes: round2(minutes),
      basis:
        `total cost over minutes of assistant speech (TTS audio), pooled across ${spoken.length} of ${plural(matched.length)}` +
        (spoken.length < matched.length ? '; sessions with no speech time recorded are left out' : ''),
    };
  }
  return provenance;
}

const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
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
 * The voice a row for `ttsLang` starts with, as a session would SEND it: the
 * rig's typed id where its TTS vendor takes one (`startConfigOf` sends that,
 * not the dropdown), else the rig's own voice on the rig's own language — kept
 * even when the list no longer offers it, so the checklist names it rather than
 * it quietly changing — else the rig's voice if that language offers it, else
 * the first it lists (`resolveVoice`'s rule).
 */
export function pickedVoiceFor(rig: Rig, providers: ProviderEntry[], ttsLang: string): string {
  if (ttsLang === rig.ttsLanguage && rig.voice) return rig.voice;
  return resolveVoice(providers, rig.ttsProviderId, rig.ttsModelId, ttsLang, rig.voice);
}

/**
 * A row for `option`, prefilled. The ONE row builder: the rig's own row and
 * every language added after it go through here, so an added language carries
 * the same voice the rig measured. (It did not: only the first row folded in a
 * typed Cartesia/Murf/ElevenLabs id, and an added row silently switched to the
 * catalog voice under a green checklist.) Vendor codes are the rig's own where
 * they name this language, else the first spelling each leg lists.
 */
export function rowFor(rig: Rig, providers: ProviderEntry[], option: LanguageOption): ExportLanguage {
  const sttLang = option.stt.includes(rig.sttLanguage) ? rig.sttLanguage : option.stt[0];
  const ttsLang = option.tts.includes(rig.ttsLanguage) ? rig.ttsLanguage : option.tts[0];
  return { code: option.code, sttLang, ttsLang, voice: typedVoiceIdOf(rig, providers) || pickedVoiceFor(rig, providers, ttsLang) };
}

/**
 * The row the rig itself speaks, or none. When both legs share that language
 * it is {@link rowFor}'s; when they do not, the rig's own codes are kept as
 * they are so the checklist says what is wrong with them instead of the row
 * quietly vanishing.
 */
export function initialRows(rig: Rig, providers: ProviderEntry[]): ExportLanguage[] {
  if (rig.mode !== 'pipeline') return [];
  const code = normaliseLanguageCode(rig.ttsLanguage) ?? normaliseLanguageCode(rig.sttLanguage);
  if (!code) return [];
  const option = sharedLanguages(rig, providers).find((o) => o.code === code);
  if (option) return [rowFor(rig, providers, option)];
  return [{ code, sttLang: rig.sttLanguage, ttsLang: rig.ttsLanguage, voice: typedVoiceIdOf(rig, providers) || rig.voice }];
}
