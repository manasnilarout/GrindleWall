import type { ProviderEntry } from './catalog';
import { languagesFor, resolveVoice, voicesFor } from './catalog';
import type { ProviderKind } from './catalog';
import type { SessionMode, StartConfig } from './protocol';

/**
 * A **rig** is one complete provider combination, named and kept.
 *
 * The bench exists to A/B providers, but the UI could only ever hold one
 * combination at a time: comparing two meant rebuilding the second by hand from
 * memory, running it, and comparing numbers in your head. A rig is that
 * combination made durable — you switch between them in one click, and each
 * carries its own measured numbers.
 *
 * Rigs live in localStorage rather than on the server. They are a workspace
 * preference, not a measurement: losing them costs you some dropdown clicks,
 * whereas the numbers they produced are already filed on disk by the backend
 * after every turn.
 */
export interface Rig {
  id: string;
  name: string;
  /** Assigned on creation and never reused, so a rig keeps its colour on the tabs. */
  colorIndex: number;
  mode: SessionMode;
  realtimeProviderId: string;
  realtimeModelId: string;
  sttProviderId: string;
  sttModelId: string;
  llmProviderId: string;
  llmModelId: string;
  ttsProviderId: string;
  ttsModelId: string;
  voice: string;
  /** Free-text voice id, for vendors that accept ids no dropdown can enumerate. Wins over `voice`. */
  customVoiceId: string;
  language: string;
  sttLanguage: string;
  ttsLanguage: string;
}

/**
 * Rig identity colours, in fixed order. Same rule as the leg palette: the
 * colour follows the rig, not its position, so deleting rig B does not repaint
 * rig C into B's colour and quietly invalidate a chart the user was reading.
 */
export const RIG_COLORS = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#c98500', '#d55181'];

export const rigColor = (rig: Pick<Rig, 'colorIndex'>): string => RIG_COLORS[rig.colorIndex % RIG_COLORS.length];

const STORAGE_KEY = 'bench.rigs.v1';

/** A rig with every slot empty. Filled in against the catalog by `withDefaults`. */
export function blankRig(name: string, colorIndex: number): Rig {
  return {
    id: `rig_${Math.random().toString(36).slice(2, 9)}`,
    name,
    colorIndex,
    mode: 'pipeline',
    realtimeProviderId: '',
    realtimeModelId: '',
    sttProviderId: '',
    sttModelId: '',
    llmProviderId: '',
    llmModelId: '',
    ttsProviderId: '',
    ttsModelId: '',
    voice: '',
    customVoiceId: '',
    language: '',
    sttLanguage: '',
    ttsLanguage: '',
  };
}

/**
 * Fills any empty slot from the catalog, preferring a provider that is actually
 * wired up. Runs over restored rigs too: a rig saved when a provider was
 * registered, reopened after that provider was removed, would otherwise sit
 * there naming a slot the factory will refuse.
 */
export function withDefaults(raw: Rig, providers: ProviderEntry[]): Rig {
  // Every string field is coerced before anything reads it. This is the only
  // place a rig from storage is healed, so a field it skips is a field that
  // reaches the UI as `undefined` — and `customVoiceId.trim()` on `undefined`
  // is a white screen, not a failed click.
  const rig: Rig = { ...blankRig(raw.name, raw.colorIndex), ...strip(raw) };
  if (providers.length === 0) return rig;

  const first = (kind: ProviderEntry['kind']) =>
    providers.find((p) => p.kind === kind && p.registered) ?? providers.find((p) => p.kind === kind);
  /**
   * Kind is part of the identity, not just the id. Without it a stored rig
   * naming `murf-tts` in its STT slot passes as "known", gets handed Murf's
   * models, and is presented as a valid rig that the factory then refuses at
   * connect — the exact surprise the readiness dots exist to prevent.
   */
  const known = (kind: ProviderEntry['kind'], id: string) =>
    providers.some((p) => p.id === id && p.kind === kind);
  const modelsOf = (id: string) => providers.find((p) => p.id === id)?.models ?? [];

  const pick = (kind: ProviderEntry['kind'], providerId: string, modelId: string) => {
    const provider = known(kind, providerId) ? providerId : (first(kind)?.id ?? '');
    const models = modelsOf(provider);
    const model = models.some((m) => m.id === modelId) ? modelId : (models[0]?.id ?? '');
    return { provider, model };
  };

  const rt = pick('realtime', rig.realtimeProviderId, rig.realtimeModelId);
  const stt = pick('stt', rig.sttProviderId, rig.sttModelId);
  const llm = pick('llm', rig.llmProviderId, rig.llmModelId);
  const tts = pick('tts', rig.ttsProviderId, rig.ttsModelId);

  // Language settles before voice, because on Cartesia the language is what
  // narrows the voice list under it.
  const lang = (providerId: string, modelId: string, current: string) => {
    const options = languagesFor(providers, providerId, modelId);
    if (options.length === 0) return '';
    return options.some((l) => l.id === current) ? current : options[0].id;
  };

  const language = lang(rt.provider, rt.model, rig.language);
  const sttLanguage = lang(stt.provider, stt.model, rig.sttLanguage);
  const ttsLanguage = lang(tts.provider, tts.model, rig.ttsLanguage);

  const voiceOwner = rig.mode === 'realtime' ? rt : tts;
  const voiceLang = rig.mode === 'realtime' ? language : ttsLanguage;
  const voices = voicesFor(providers, voiceOwner.provider, voiceOwner.model, voiceLang);
  const voice = voices.some((v) => v.id === rig.voice) ? rig.voice : (voices[0]?.id ?? '');

  return {
    ...rig,
    realtimeProviderId: rt.provider,
    realtimeModelId: rt.model,
    sttProviderId: stt.provider,
    sttModelId: stt.model,
    llmProviderId: llm.provider,
    llmModelId: llm.model,
    ttsProviderId: tts.provider,
    ttsModelId: tts.model,
    language,
    sttLanguage,
    ttsLanguage,
    voice,
  };
}

/**
 * The `StartConfig` this rig would send.
 *
 * A typed voice id only counts for a vendor that takes one, so switching mode
 * or provider cannot smuggle an id into a session that would reject it — the
 * same rule the picker applies when it resolves the dropdown.
 */
export function startConfigOf(
  rig: Rig,
  providers: ProviderEntry[],
  systemPrompt: string,
  turnDetection: StartConfig['turnDetection'],
): StartConfig {
  const owner = providers.find(
    (p) => p.id === (rig.mode === 'realtime' ? rig.realtimeProviderId : rig.ttsProviderId),
  );
  const voice = owner?.acceptsVoiceId && rig.customVoiceId.trim() ? rig.customVoiceId.trim() : rig.voice;

  return {
    mode: rig.mode,
    realtimeProviderId: rig.realtimeProviderId,
    realtimeModelId: rig.realtimeModelId,
    sttProviderId: rig.sttProviderId,
    sttModelId: rig.sttModelId,
    llmProviderId: rig.llmProviderId,
    llmModelId: rig.llmModelId,
    ttsProviderId: rig.ttsProviderId,
    ttsModelId: rig.ttsModelId,
    systemPrompt,
    voice,
    language: rig.language,
    sttLanguage: rig.sttLanguage,
    ttsLanguage: rig.ttsLanguage,
    turnDetection,
  };
}

/* ------------------------------ transitions ------------------------------ */

/**
 * The rules for changing one part of a rig.
 *
 * These live here rather than inside the picker because each one marks a live
 * vendor error someone had to debug, and — as `resolveVoice` above already
 * establishes — a rule that cannot be called from a test is a rule nothing
 * checks. `RigBuilder` is the only caller; `render-check` is the only prover.
 *
 * The invariant they share: **a typed `customVoiceId` never survives a change
 * of the catalogue it was typed against.** `startConfigOf` prefers that id over
 * the dropdown, so a stale one is sent to the vendor while the picker displays
 * a different, valid voice.
 */
export function switchProvider(rig: Rig, providers: ProviderEntry[], kind: ProviderKind, id: string): Rig {
  const entry = providers.find((p) => p.id === id);
  const model = entry?.models[0]?.id ?? '';
  // Providers declare their own language sets, so reset to a valid one on switch.
  const lang = languagesFor(providers, id, model)[0]?.id ?? '';
  const voice = voicesFor(providers, id, model, lang)[0]?.id ?? '';

  if (kind === 'realtime') {
    return { ...rig, realtimeProviderId: id, realtimeModelId: model, voice, customVoiceId: '', language: lang };
  }
  if (kind === 'stt') return { ...rig, sttProviderId: id, sttModelId: model, sttLanguage: lang };
  if (kind === 'llm') return { ...rig, llmProviderId: id, llmModelId: model };
  return { ...rig, ttsProviderId: id, ttsModelId: model, voice, customVoiceId: '', ttsLanguage: lang };
}

/**
 * Switching architecture switches which provider OWNS `voice` — the realtime
 * one, or the TTS leg's. That field is shared, so leaving it alone hands one
 * vendor another's id: toggling from a Cartesia pipeline to OpenAI Realtime
 * sent a Cartesia UUID as a custom voice object, and toggling back sent `marin`
 * as the ElevenLabs voice_id path segment. Both are 400s the user cannot
 * explain.
 */
export function switchMode(rig: Rig, providers: ProviderEntry[], mode: SessionMode): Rig {
  if (mode === rig.mode) return rig;
  const realtime = mode === 'realtime';
  const voice = resolveVoice(
    providers,
    realtime ? rig.realtimeProviderId : rig.ttsProviderId,
    realtime ? rig.realtimeModelId : rig.ttsModelId,
    realtime ? rig.language : rig.ttsLanguage,
    rig.voice,
  );
  return { ...rig, mode, voice, customVoiceId: '' };
}

/**
 * Changing the model can change the voice and language lists under it — Murf's
 * two models share only 100 of their voices, and the vendor rejects the other
 * model's voice outright. Language settles first, because it can itself narrow
 * the voice list, so it has to be valid before the voice is checked against it.
 */
export function switchVoicedModel(rig: Rig, providers: ProviderEntry[], kind: 'realtime' | 'tts', modelId: string): Rig {
  const providerId = kind === 'realtime' ? rig.realtimeProviderId : rig.ttsProviderId;
  const langs = languagesFor(providers, providerId, modelId);
  const current = kind === 'realtime' ? rig.language : rig.ttsLanguage;
  const lang = langs.some((l) => l.id === current) ? current : (langs[0]?.id ?? '');
  const voice = resolveVoice(providers, providerId, modelId, lang, rig.voice);

  return kind === 'realtime'
    ? { ...rig, realtimeModelId: modelId, voice, customVoiceId: '', language: lang }
    : { ...rig, ttsModelId: modelId, voice, customVoiceId: '', ttsLanguage: lang };
}

/** Cartesia files its 934 voices under a language, so the language changes the list. */
export function switchVoicedLanguage(rig: Rig, providers: ProviderEntry[], kind: 'realtime' | 'tts', languageId: string): Rig {
  const providerId = kind === 'realtime' ? rig.realtimeProviderId : rig.ttsProviderId;
  const modelId = kind === 'realtime' ? rig.realtimeModelId : rig.ttsModelId;
  const voice = resolveVoice(providers, providerId, modelId, languageId, rig.voice);

  return kind === 'realtime'
    ? { ...rig, language: languageId, voice, customVoiceId: '' }
    : { ...rig, ttsLanguage: languageId, voice, customVoiceId: '' };
}

/**
 * The STT leg has no voice, but its languages can still narrow per model — the
 * TTS side already does exactly that (44 languages on sonic-3.6, 8 on sonic-2).
 */
export function switchSttModel(rig: Rig, providers: ProviderEntry[], modelId: string): Rig {
  const langs = languagesFor(providers, rig.sttProviderId, modelId);
  const lang = langs.some((l) => l.id === rig.sttLanguage) ? rig.sttLanguage : (langs[0]?.id ?? '');
  return { ...rig, sttModelId: modelId, sttLanguage: lang };
}

export interface RigSlot {
  key: 'realtime' | 'stt' | 'llm' | 'tts';
  /** Shown on the rail; matches the leg names the metrics use. */
  label: string;
  providerId: string;
  modelId: string;
  providerName: string;
  color: string;
  /** Registered in the factory *and* holding every env var it declares. */
  ready: boolean;
  /** Why it is not ready, in the words the catalog uses. */
  blocker?: string;
}

/** The rig's legs, in wire order, resolved against the catalog. */
export function slotsOf(rig: Rig, providers: ProviderEntry[]): RigSlot[] {
  const build = (key: RigSlot['key'], label: string, color: string, providerId: string, modelId: string): RigSlot => {
    const entry = providers.find((p) => p.id === providerId);
    return {
      key,
      label,
      color,
      providerId,
      modelId,
      providerName: entry?.name ?? providerId ?? '—',
      ready: Boolean(entry?.registered) && (entry?.missingEnv.length ?? 0) === 0,
      blocker: !entry
        ? 'not in the catalog'
        : !entry.registered
          ? 'not wired up'
          : entry.missingEnv.length
            ? `needs ${entry.missingEnv.join(', ')}`
            : undefined,
    };
  };

  if (rig.mode === 'realtime') {
    return [build('realtime', 'S2S', '#199e70', rig.realtimeProviderId, rig.realtimeModelId)];
  }
  return [
    build('stt', 'STT', '#3987e5', rig.sttProviderId, rig.sttModelId),
    build('llm', 'LLM', '#d95926', rig.llmProviderId, rig.llmModelId),
    build('tts', 'TTS', '#199e70', rig.ttsProviderId, rig.ttsModelId),
  ];
}

/** Short breadcrumb for the top bar and the tabs: provider names only. */
export function chainOf(rig: Rig, providers: ProviderEntry[]): string[] {
  return slotsOf(rig, providers).map((s) => s.providerName);
}

/**
 * The same rig spelled as the environment variables this repo's scripts already
 * take, so the bench and the CLI stop being two ways of saying the same thing.
 *
 * The names here are read off `backend/scripts/smoke.mjs`, not from memory:
 * realtime is `REALTIME` / `REALTIME_MODEL` (there is no `MODE` variable — the
 * mode is `argv[2]`), and the system prompt is `SYSTEM`. Getting one wrong does
 * not error, it silently falls back to a mock provider or to smoke's default
 * `"Be brief."` prompt — so the copied command would benchmark something other
 * than the rig it came from and give no sign of it.
 *
 * The prompt is included for the same reason the session record keeps it: it is
 * part of what produced the numbers, so a reproduction without it is a
 * different measurement.
 */
export function envCommandOf(rig: Rig, providers: ProviderEntry[], systemPrompt?: string): string {
  const owner = providers.find(
    (p) => p.id === (rig.mode === 'realtime' ? rig.realtimeProviderId : rig.ttsProviderId),
  );
  const voice = owner?.acceptsVoiceId && rig.customVoiceId.trim() ? rig.customVoiceId.trim() : rig.voice;
  const prompt = systemPrompt?.trim();

  const lines =
    rig.mode === 'realtime'
      ? [
          `REALTIME=${sh(rig.realtimeProviderId)} REALTIME_MODEL=${sh(rig.realtimeModelId)} \\`,
          `${voice ? `VOICE=${sh(voice)} ` : ''}LANG_CODE=${sh(rig.language)} \\`,
        ]
      : [
          `STT=${sh(rig.sttProviderId)} STT_MODEL=${sh(rig.sttModelId)} STT_LANG=${sh(rig.sttLanguage)} \\`,
          `LLM=${sh(rig.llmProviderId)} LLM_MODEL=${sh(rig.llmModelId)} \\`,
          `TTS=${sh(rig.ttsProviderId)} TTS_MODEL=${sh(rig.ttsModelId)} TTS_LANG=${sh(rig.ttsLanguage)}${voice ? ` VOICE=${sh(voice)}` : ''} \\`,
        ];

  if (prompt) lines.push(`SYSTEM=${sh(prompt)} \\`);
  lines.push(`  node scripts/smoke.mjs ${rig.mode}`);
  return lines.join('\n');
}

/**
 * POSIX single-quoting. A system prompt is free text and routinely contains an
 * apostrophe, which naive quoting would turn into a command that either fails
 * to parse or — worse — runs with the prompt truncated at the apostrophe.
 */
function sh(value: string): string {
  if (value === '') return "''";
  if (/^[\w:@./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Drops undefined/non-string fields so a spread cannot reintroduce a hole. */
function strip(rig: Rig): Partial<Rig> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rig)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<Rig>;
}

/* --------------------------------- storage --------------------------------- */

/**
 * Reads the saved rigs, tolerating anything at all in the key.
 *
 * localStorage is shared with every other tab and survives every version of
 * this app, so what comes back may predate the current shape or be someone
 * else's JSON entirely. A bad value returns null and the caller seeds fresh
 * rigs — losing a workspace preference is a much smaller failure than a bench
 * that will not open.
 */
export function loadRigs(): { rigs: Rig[]; activeId: string } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { rigs?: unknown; activeId?: unknown };
    // Healed here rather than at the call site: `loadRigs` is the boundary
    // between arbitrary stored JSON and the rest of the app, and a rig that
    // escapes it un-normalised is one `undefined` away from a blank page.
    const rigs = (Array.isArray(parsed.rigs) ? parsed.rigs.filter(isRig) : []).map((r) => withDefaults(r, []));
    if (rigs.length === 0) return null;
    const activeId = typeof parsed.activeId === 'string' ? parsed.activeId : rigs[0].id;
    return { rigs, activeId: rigs.some((r) => r.id === activeId) ? activeId : rigs[0].id };
  } catch {
    return null;
  }
}

export function saveRigs(rigs: Rig[], activeId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rigs, activeId }));
  } catch {
    // A full or disabled store is not worth interrupting a session over.
  }
}

/**
 * Only the fields that cannot be healed are required: an id to key on, a usable
 * name and colour, and a mode that decides which slots are even read. Everything
 * else `withDefaults` fills in from the catalog, so demanding it here would
 * throw away a rig that is merely from an older version of this shape.
 */
function isRig(v: unknown): v is Rig {
  const r = v as Partial<Rig> | null;
  return Boolean(
    r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.length > 0 &&
      typeof r.name === 'string' &&
      (r.mode === 'pipeline' || r.mode === 'realtime') &&
      typeof r.colorIndex === 'number' &&
      Number.isFinite(r.colorIndex),
  );
}

/** Three rigs to start from, so the compare view has something to compare. */
export function seedRigs(providers: ProviderEntry[]): Rig[] {
  return ['Rig A', 'Rig B', 'Rig C'].map((name, i) => withDefaults(blankRig(name, i), providers));
}
