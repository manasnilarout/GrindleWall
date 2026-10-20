import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PROVIDER_IDS,
  buildVoiceStackSpec,
  checkExportable,
  citeSessions,
  initialRows,
  mapLeg,
  matchingSessions,
  measuredLanguageOf,
  pickedVoiceFor,
  promptSha256,
  provenanceFrom,
  rowFor,
  sharedLanguages,
} from '../../../src/lib/voice-stack/export';
import type { Citation, ExportCheck, ExportContext, ExportLanguage, ExportSelection } from '../../../src/lib/voice-stack/export';
import { LLM_REASONING_LEVELS, decodeVoiceStack, encodeVoiceStack } from '../../../src/lib/voice-stack/spec';
import type { ProviderEntry, ProviderKind } from '../../../src/lib/catalog';
import type { SessionIndexEntry, StartConfig } from '../../../src/lib/protocol';
import type { Rig } from '../../../src/lib/rigs';
import { PROVIDERS, cartesiaTts, m, murfTts, provider, rig, sarvamStt, sarvamTts } from '../fixtures';

const PROMPT = 'Reply in Hindi, briefly.';
const VAD: ExportContext = { turnDetection: 'server_vad' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const hiOr: ExportLanguage[] = [
  { code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' },
  { code: 'or', sttLang: 'or-IN', ttsLang: 'od-IN', voice: 'shubh' },
];

const selection = (over: Partial<ExportSelection> = {}): ExportSelection => ({
  languages: hiOr,
  name: 'Hindi collections',
  provenance: { source: 'grindelwald', sessions: ['rec-1'], measuredLanguages: ['hi', 'or'] },
  ...over,
});

const config = (over: Partial<StartConfig> = {}): Omit<StartConfig, 'systemPrompt'> => ({
  mode: 'pipeline',
  sttProviderId: 'sarvam-stt',
  sttModelId: 'saaras:v3-realtime@fast',
  llmProviderId: 'google-llm',
  llmModelId: 'gemini-3.1-flash-lite@minimal',
  ttsProviderId: 'sarvam-tts',
  ttsModelId: 'bulbul:v3',
  voice: 'pooja',
  sttLanguage: 'hi-IN',
  ttsLanguage: 'hi-IN',
  turnDetection: 'server_vad',
  ...over,
});

const row = (over: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
  recordId: 'rec',
  label: 'l',
  mode: 'pipeline',
  startedAt: 1_000,
  endedAt: 61_000,
  turnCount: 3,
  costUsd: 0.01,
  costInr: 0.9,
  unpriced: [],
  config: config(),
  promptSha256: sha(PROMPT),
  durationMs: 60_000,
  speechSeconds: 30,
  latency: { ttfaMedianMs: 900, ttfaP95Ms: 1400 },
  ...over,
});

const blocks = (checks: ExportCheck[]) => checks.filter((c) => c.level === 'block').map((c) => c.message);
const warns = (checks: ExportCheck[]) => checks.filter((c) => c.level === 'warn').map((c) => c.message);

/* --------------------------------- mapLeg --------------------------------- */

describe('CANONICAL_PROVIDER_IDS', () => {
  it('maps bench ids to core vendor ids per leg', () => {
    expect(CANONICAL_PROVIDER_IDS).toEqual({
      stt: { 'sarvam-stt': 'sarvam', 'gemini-stt': 'gemini', 'cartesia-stt': 'cartesia', 'deepgram-stt': 'deepgram' },
      llm: { 'openai-llm': 'openai', 'google-llm': 'google' },
      tts: { 'sarvam-tts': 'sarvam', 'cartesia-tts': 'cartesia', 'elevenlabs-tts': 'elevenlabs', 'murf-tts': 'murf', 'gemini-tts': 'gemini' },
    });
  });

  it('only ever maps to an id the spec accepts', () => {
    for (const legs of Object.values(CANONICAL_PROVIDER_IDS)) {
      for (const id of Object.values(legs)) expect(id).toMatch(/^[a-z][a-z0-9_-]{0,39}$/);
    }
  });
});

describe('mapLeg', () => {
  it('maps a plain model id with no options', () => {
    expect(mapLeg('tts', 'sarvam-tts', 'bulbul:v3')).toEqual({ ok: true, value: { provider: 'sarvam', model: 'bulbul:v3', options: {} } });
  });

  it('refuses a provider with no counterpart in core, naming what is exportable', () => {
    expect(mapLeg('llm', 'mock-llm', 'mock-chat')).toEqual({
      ok: false,
      error: 'mock-llm has no MagickVoice LLM provider id (exportable: openai-llm, google-llm)',
    });
  });

  it('refuses a provider mapped under a different leg', () => {
    const r = mapLeg('stt', 'sarvam-tts', 'bulbul:v3');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^sarvam-tts has no MagickVoice STT provider id/);
  });

  it.each(['fast', 'balanced'])('turns a Sarvam @%s into a streamType option', (v) => {
    expect(mapLeg('stt', 'sarvam-stt', `saaras:v3-realtime@${v}`)).toEqual({
      ok: true,
      value: { provider: 'sarvam', model: 'saaras:v3-realtime', options: { streamType: v } },
    });
  });

  it('refuses an unknown Sarvam stream type rather than dropping it', () => {
    expect(mapLeg('stt', 'sarvam-stt', 'saaras:v3-realtime@turbo')).toEqual({
      ok: false,
      error: 'sarvam-stt: unknown Sarvam stream type "@turbo" (known: fast, balanced)',
    });
  });

  it.each(LLM_REASONING_LEVELS.flatMap((level) => [['google-llm', level], ['openai-llm', level]]))(
    'turns %s @%s into a reasoning option',
    (id, level) => {
      const r = mapLeg('llm', id, `model-x@${level}`);
      expect(r).toEqual({ ok: true, value: { provider: CANONICAL_PROVIDER_IDS.llm[id], model: 'model-x', options: { reasoning: level } } });
    },
  );

  it('refuses an unknown reasoning level', () => {
    expect(mapLeg('llm', 'google-llm', 'gemini@ultra')).toEqual({
      ok: false,
      error: 'google-llm: unknown reasoning level "@ultra" (known: off, none, minimal, low, medium, high)',
    });
  });

  it('refuses a variant on a provider that has no rule for one', () => {
    expect(mapLeg('tts', 'cartesia-tts', 'sonic-3.6@fast')).toEqual({
      ok: false,
      error: 'cartesia-tts model "sonic-3.6@fast" carries a variant this export cannot translate',
    });
  });

  it('refuses an empty model or one that is all variant', () => {
    expect(mapLeg('stt', 'sarvam-stt', '')).toEqual({ ok: false, error: 'sarvam-stt has no model selected' });
    expect(mapLeg('stt', 'sarvam-stt', '@fast')).toEqual({ ok: false, error: 'sarvam-stt has no model selected' });
  });

  it('splits on the LAST @, the way the bench providers do', () => {
    expect(mapLeg('stt', 'sarvam-stt', 'a@b@fast')).toEqual({ ok: true, value: { provider: 'sarvam', model: 'a@b', options: { streamType: 'fast' } } });
  });

  it('treats a trailing @ as no variant', () => {
    expect(mapLeg('tts', 'cartesia-tts', 'sonic-3.6@')).toEqual({ ok: true, value: { provider: 'cartesia', model: 'sonic-3.6', options: {} } });
  });
});

/* --------------------------- buildVoiceStackSpec -------------------------- */

describe('buildVoiceStackSpec', () => {
  it('builds the cascade spec the rig describes', () => {
    const spec = buildVoiceStackSpec(rig(), PROVIDERS, selection({ description: '  Two rows  ' }), VAD);
    expect(spec).toEqual({
      kind: 'magickvoice.voice-stack',
      specVersion: 1,
      architecture: 'cascade',
      stt: { provider: 'sarvam', model: 'saaras:v3-realtime', options: { streamType: 'fast' } },
      llm: { provider: 'google', model: 'gemini-3.1-flash-lite', options: { reasoning: 'minimal' } },
      tts: { provider: 'sarvam', model: 'bulbul:v3', options: {} },
      languages: [
        { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' },
        { code: 'or', stt: 'or-IN', tts: 'od-IN', voice: 'shubh' },
      ],
      turn: { detection: 'server_vad' },
      meta: {
        name: 'Hindi collections',
        description: 'Two rows',
        provenance: { source: 'grindelwald', sessions: ['rec-1'], measuredLanguages: ['hi', 'or'] },
      },
    });
  });

  it('normalises codes, trims vendor codes and voices, and keeps an unnormalisable code as typed', () => {
    const spec = buildVoiceStackSpec(
      rig(),
      PROVIDERS,
      selection({
        languages: [
          { code: ' HI-in ', sttLang: ' hi-IN ', ttsLang: 'hi-IN\t', voice: ' pooja ' },
          { code: 'od-IN', sttLang: 'or-IN', ttsLang: 'od-IN', voice: 'shubh' },
          { code: '  auto ', sttLang: 'unknown', ttsLang: 'hi-IN', voice: 'pooja' },
        ],
      }),
      VAD,
    );
    expect(spec.languages).toEqual([
      { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' },
      { code: 'or', stt: 'or-IN', tts: 'od-IN', voice: 'shubh' },
      { code: 'auto', stt: 'unknown', tts: 'hi-IN', voice: 'pooja' },
    ]);
  });

  it('omits a blank description and an absent provenance', () => {
    const spec = buildVoiceStackSpec(rig(), PROVIDERS, { languages: hiOr, name: ' Name ', description: '   ' }, VAD);
    expect(spec.meta).toEqual({ name: 'Name' });
  });

  it('throws for push-to-talk, which a v1 code cannot carry', () => {
    expect(() => buildVoiceStackSpec(rig(), PROVIDERS, selection(), { turnDetection: 'manual' })).toThrow(/Push-to-talk/);
  });

  it('throws for a leg it cannot map', () => {
    expect(() => buildVoiceStackSpec(rig({ llmProviderId: 'mock-llm', llmModelId: 'mock-chat' }), PROVIDERS, selection(), VAD)).toThrow(
      'mock-llm has no MagickVoice LLM provider id',
    );
  });
});

/* ----------------------------- checkExportable ---------------------------- */

describe('checkExportable', () => {
  it('passes a clean rig with a single ok line', () => {
    const checks = checkExportable(rig(), PROVIDERS, selection(), VAD);
    expect(checks).toEqual([{ level: 'ok', message: 'Ready: 2 languages, default hi.' }]);
  });

  it('says "1 language" in the singular', () => {
    const checks = checkExportable(rig(), PROVIDERS, selection({ languages: [hiOr[0]], provenance: { sessions: ['r'], measuredLanguages: ['hi'] } }), VAD);
    expect(checks.at(-1)).toEqual({ level: 'ok', message: 'Ready: 1 language, default hi.' });
  });

  it('refuses a realtime rig outright', () => {
    expect(checkExportable(rig({ mode: 'realtime' }), PROVIDERS, selection(), VAD)).toEqual([
      { level: 'block', message: 'Realtime stacks are not supported by core yet — export a pipeline rig (STT → LLM → TTS).' },
    ]);
  });

  it('refuses a push-to-talk bench outright', () => {
    const checks = checkExportable(rig(), PROVIDERS, selection(), { turnDetection: 'manual' });
    expect(checks).toHaveLength(1);
    expect(checks[0].level).toBe('block');
    expect(checks[0].message).toMatch(/^Push-to-talk \(manual turn detection\) cannot be exported/);
  });

  it.each<[string, Partial<Rig>, ProviderEntry[], string]>([
    ['a provider missing from the catalog', { sttProviderId: 'nope-stt' }, PROVIDERS, 'STT: nope-stt is not in the catalog.'],
    ['an empty slot', { llmProviderId: '' }, PROVIDERS, 'LLM: nothing is not in the catalog.'],
    ['a provider of the wrong kind', { sttProviderId: 'sarvam-tts' }, PROVIDERS, 'STT: sarvam-tts is not in the catalog.'],
    ['a mock provider', { ttsProviderId: 'mock-tts', ttsModelId: 'mock-voice' }, PROVIDERS, 'TTS: Mock TTS is a mock provider — pick a real one to export.'],
    [
      'an unimplemented provider',
      { ttsProviderId: 'sarvam-tts' },
      PROVIDERS.map((p) => (p.id === 'sarvam-tts' ? { ...p, implemented: false } : p)),
      'TTS: Sarvam Bulbul is not implemented in the bench, so nothing about it was measured.',
    ],
    ['a model the provider does not list', { ttsModelId: 'bulbul:v9' }, PROVIDERS, 'TTS: model "bulbul:v9" is not one Sarvam Bulbul lists.'],
    [
      'a listed model whose variant cannot be translated',
      { sttModelId: 'saaras:v3-realtime@turbo' },
      PROVIDERS,
      'STT: sarvam-stt: unknown Sarvam stream type "@turbo" (known: fast, balanced).',
    ],
    [
      'a listed LLM variant with no reasoning level',
      { llmModelId: 'gemini-3.1-flash-lite@wild' },
      PROVIDERS,
      'LLM: google-llm: unknown reasoning level "@wild" (known: off, none, minimal, low, medium, high).',
    ],
  ])('blocks %s', (_label, over, providers, message) => {
    expect(blocks(checkExportable(rig(over), providers, selection(), VAD))).toContain(message);
  });

  it('reports every bad leg, not just the first', () => {
    const found = blocks(checkExportable(rig({ sttProviderId: 'x', llmProviderId: 'y', ttsProviderId: 'z' }), PROVIDERS, selection(), VAD));
    expect(found).toEqual(expect.arrayContaining(['STT: x is not in the catalog.', 'LLM: y is not in the catalog.', 'TTS: z is not in the catalog.']));
  });

  it('blocks no languages and too many languages', () => {
    expect(blocks(checkExportable(rig(), PROVIDERS, selection({ languages: [] }), VAD))).toContain('Pick at least one language.');
    const many = Array.from({ length: 21 }, () => hiOr[0]);
    expect(blocks(checkExportable(rig(), PROVIDERS, selection({ languages: many }), VAD))).toContain('At most 20 languages fit in one stack.');
  });

  it('blocks a row that is not a language (auto-detect cannot be a row)', () => {
    const found = blocks(checkExportable(rig(), PROVIDERS, selection({ languages: [{ code: 'unknown', sttLang: 'unknown', ttsLang: 'hi-IN', voice: 'pooja' }] }), VAD));
    expect(found).toContain('"unknown" is not a language — a stack row needs a real one (auto-detect cannot be a row).');
  });

  it('blocks a duplicate language however it is spelled', () => {
    const found = blocks(checkExportable(rig(), PROVIDERS, selection({ languages: [hiOr[0], { ...hiOr[0], code: 'hi-IN' }] }), VAD));
    expect(found).toContain('hi is listed twice.');
  });

  it("blocks a vendor code that names another language, or none", () => {
    const found = blocks(
      checkExportable(rig(), PROVIDERS, selection({ languages: [{ code: 'hi', sttLang: 'en-IN', ttsLang: '', voice: 'pooja' }] }), VAD),
    );
    expect(found).toContain('hi: the STT code "en-IN" is not hi.');
    expect(found).toContain('hi: the TTS code "(blank)" is not hi.');
  });

  it('blocks a vendor code the model does not list', () => {
    const found = blocks(checkExportable(rig(), PROVIDERS, selection({ languages: [{ code: 'hi', sttLang: 'hi', ttsLang: 'hi-IN', voice: 'pooja' }] }), VAD));
    expect(found).toContain('hi: saaras:v3-realtime@fast does not list STT language "hi".');
  });

  it('warns, not blocks, when the catalog lists no languages for a model', () => {
    const bare: ProviderEntry[] = PROVIDERS.map((p) => (p.id === 'sarvam-stt' ? { ...p, languages: undefined } : p));
    const checks = checkExportable(rig(), bare, selection(), VAD);
    expect(blocks(checks)).toEqual([]);
    expect(warns(checks)).toContain('hi: the catalog lists no languages for saaras:v3-realtime@fast, so "hi-IN" is unchecked.');
    expect(checks.at(-1)?.level).toBe('ok');
  });

  it('blocks a missing voice', () => {
    expect(blocks(checkExportable(rig(), PROVIDERS, selection({ languages: [{ ...hiOr[0], voice: '  ' }] }), VAD))).toContain('hi: pick a voice.');
  });

  it("blocks a voice the TTS model does not offer, unless the vendor takes ids", () => {
    const sel = selection({ languages: [{ ...hiOr[0], voice: 'cloned-7' }] });
    expect(blocks(checkExportable(rig(), PROVIDERS, sel, VAD))).toContain('hi: "cloned-7" is not a bulbul:v3 voice for hi-IN.');
    const idTaker = PROVIDERS.map((p) => (p.id === 'sarvam-tts' ? { ...p, acceptsVoiceId: true } : p));
    const checks = checkExportable(rig(), idTaker, sel, VAD);
    expect(blocks(checks)).toEqual([]);
    expect(warns(checks)).toContain('hi: "cloned-7" is a custom voice id the bench cannot check against bulbul:v3.');
  });

  it("blocks what only the spec's own schema catches, in the spec's words", () => {
    const found = blocks(checkExportable(rig(), PROVIDERS, selection({ name: 'n'.repeat(81) }), VAD));
    expect(found).toEqual(['meta.name: String must contain at most 80 character(s)']);
    expect(blocks(checkExportable(rig(), PROVIDERS, selection({ name: '' }), VAD))).toEqual(['meta.name: name is required']);
  });

  it('does not run the schema check while a leg is already blocked', () => {
    const found = blocks(checkExportable(rig({ ttsProviderId: 'mock-tts', ttsModelId: 'mock-voice' }), PROVIDERS, selection({ name: '' }), VAD));
    expect(found.some((m) => m.startsWith('meta.name'))).toBe(false);
  });

  describe('measurement warnings', () => {
    it('says out loud when no session is cited', () => {
      const checks = checkExportable(rig(), PROVIDERS, selection({ provenance: { source: 'grindelwald' } }), VAD);
      expect(warns(checks)).toEqual([
        "No recorded session used this exact stack (STT/LLM/TTS, server VAD, the current system prompt, and a row's language in its voice) — the code carries no measurements.",
      ]);
      expect(checks.at(-1)?.level).toBe('ok');
      expect(warns(checkExportable(rig(), PROVIDERS, selection({ provenance: undefined }), VAD))).toHaveLength(1);
    });

    it('names sessions left out for another prompt, singular and plural', () => {
      const one: Citation = { cited: [], promptSha256: 'x', otherPrompt: 1, unhashed: 0, otherVoices: {} };
      expect(warns(checkExportable(rig(), PROVIDERS, selection(), { ...VAD, citation: one }))).toContain(
        '1 session on these legs ran under a different system prompt and is not cited — the prompt moves TTFA.',
      );
      expect(warns(checkExportable(rig(), PROVIDERS, selection(), { ...VAD, citation: { ...one, otherPrompt: 3 } }))).toContain(
        '3 sessions on these legs ran under a different system prompt and are not cited — the prompt moves TTFA.',
      );
    });

    it('names sessions listed without a prompt hash', () => {
      const c: Citation = { cited: [], promptSha256: 'x', otherPrompt: 0, unhashed: 2, otherVoices: {} };
      const found = warns(checkExportable(rig(), PROVIDERS, selection(), { ...VAD, citation: c }));
      expect(found.some((w) => w.startsWith('2 sessions on these legs were listed without a prompt hash'))).toBe(true);
      const single = warns(checkExportable(rig(), PROVIDERS, selection(), { ...VAD, citation: { ...c, unhashed: 1 } }));
      expect(single.some((w) => w.startsWith('1 session on these legs was listed without a prompt hash'))).toBe(true);
    });

    it('names the other voices a language was measured in', () => {
      const c: Citation = { cited: [], promptSha256: 'x', otherPrompt: 0, unhashed: 0, otherVoices: { or: ['pooja', 'meera'] } };
      const sel = selection({ provenance: { sessions: ['rec-1'], measuredLanguages: ['hi'] } });
      expect(warns(checkExportable(rig(), PROVIDERS, sel, { ...VAD, citation: c }))).toEqual([
        'or: no recorded session used the voice "shubh" — sessions on this stack spoke or in "pooja", "meera", so none is cited for it.',
      ]);
    });

    it('lists the languages never measured on this combination, only when something was', () => {
      const sel = selection({ provenance: { sessions: ['rec-1'], measuredLanguages: ['hi'] } });
      expect(warns(checkExportable(rig(), PROVIDERS, sel, VAD))).toEqual(['Never measured on this combination: or.']);
      const uncited = selection({ provenance: { measuredLanguages: [] } });
      expect(warns(checkExportable(rig(), PROVIDERS, uncited, VAD)).some((w) => w.startsWith('Never measured'))).toBe(false);
    });
  });
});

/* ---------------------- round trip for every provider --------------------- */

describe('export -> code -> decode, for every provider the export maps', () => {
  const langs = [m('hi-IN', { name: 'Hindi' }), m('en-IN', { name: 'English' })];
  const generic = (id: string, kind: ProviderKind, model: string): ProviderEntry =>
    provider(id, kind, { models: [m(model)], languages: langs, ...(kind === 'tts' ? { voices: [m('voice-1')] } : {}) });

  const MODEL_OF: Record<string, string> = {
    'sarvam-stt': 'saaras:v3-realtime@balanced',
    'google-llm': 'gemini-3.1-flash-lite@low',
    'openai-llm': 'gpt-5-mini@off',
  };
  const modelOf = (id: string) => MODEL_OF[id] ?? `${id.split('-')[0]}-model.v1`;

  const cases: Array<{ leg: 'stt' | 'llm' | 'tts'; id: string }> = (['stt', 'llm', 'tts'] as const).flatMap((leg) =>
    Object.keys(CANONICAL_PROVIDER_IDS[leg]).map((id) => ({ leg, id })),
  );

  it.each(cases)('$leg $id', ({ leg, id }) => {
    const pick = { stt: 'sarvam-stt', llm: 'google-llm', tts: 'sarvam-tts', [leg]: id };
    const providers = [generic(pick.stt, 'stt', modelOf(pick.stt)), generic(pick.llm, 'llm', modelOf(pick.llm)), generic(pick.tts, 'tts', modelOf(pick.tts))];
    const r = rig({
      sttProviderId: pick.stt,
      sttModelId: modelOf(pick.stt),
      llmProviderId: pick.llm,
      llmModelId: modelOf(pick.llm),
      ttsProviderId: pick.tts,
      ttsModelId: modelOf(pick.tts),
      voice: 'voice-1',
    });
    const sel: ExportSelection = {
      languages: [{ code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'voice-1' }],
      name: `${id} stack`,
      provenance: { source: 'grindelwald', sessions: ['rec-x'], measuredLanguages: ['hi'] },
    };

    const checks = checkExportable(r, providers, sel, VAD);
    expect(blocks(checks)).toEqual([]);
    expect(checks.at(-1)?.level).toBe('ok');

    const code = encodeVoiceStack(buildVoiceStackSpec(r, providers, sel, VAD));
    const decoded = decodeVoiceStack(code);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.spec[leg].provider).toBe(CANONICAL_PROVIDER_IDS[leg][id]);
    expect(decoded.spec[leg].model).toBe(modelOf(id).split('@')[0]);
    expect(decoded.spec.languages).toEqual([{ code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'voice-1' }]);
    expect(decoded.spec.meta.provenance).toEqual({ source: 'grindelwald', sessions: ['rec-x'], measuredLanguages: ['hi'] });
    expect(encodeVoiceStack(decoded.spec)).toBe(code);

    // A single altered character never decodes to a stack.
    const tampered = code.replace(/\.([A-Za-z0-9_-])/, (_, c: string) => `.${c === 'A' ? 'B' : 'A'}`);
    expect(decodeVoiceStack(tampered).ok).toBe(false);
  });

  it('carries the variants as options', () => {
    const code = encodeVoiceStack(buildVoiceStackSpec(rig(), PROVIDERS, selection(), VAD));
    const decoded = decodeVoiceStack(code);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.spec.stt.options).toEqual({ streamType: 'fast' });
    expect(decoded.spec.llm.options).toEqual({ reasoning: 'minimal' });
  });
});

/* -------------------------------- provenance ------------------------------- */

describe('promptSha256', () => {
  it('is the hex SHA-256 of the UTF-8 prompt, untrimmed', () => {
    for (const p of ['', 'Be brief.', ' Be brief. ', 'हिन्दी में ✓', "Don't\nlist"]) expect(promptSha256(p)).toBe(sha(p));
    expect(promptSha256('a')).not.toBe(promptSha256('a '));
  });
});

describe('matchingSessions', () => {
  it('keeps pipeline, server-VAD records on the same three legs with turns', () => {
    const ok = row({ recordId: 'ok' });
    const sessions = [
      ok,
      row({ recordId: 'realtime', mode: 'realtime' }),
      row({ recordId: 'no-turns', turnCount: 0 }),
      row({ recordId: 'no-config', config: undefined }),
      row({ recordId: 'manual', config: config({ turnDetection: 'manual' }) }),
      row({ recordId: 'stt-model', config: config({ sttModelId: 'saaras:v3-realtime@balanced' }) }),
      row({ recordId: 'llm', config: config({ llmProviderId: 'openai-llm' }) }),
      row({ recordId: 'llm-variant', config: config({ llmModelId: 'gemini-3.1-flash-lite@high' }) }),
      row({ recordId: 'tts', config: config({ ttsProviderId: 'cartesia-tts' }) }),
      row({ recordId: 'tts-model', config: config({ ttsModelId: 'bulbul:v2' }) }),
      row({ recordId: 'other-lang', config: config({ ttsLanguage: 'en-IN', sttLanguage: 'en-IN' }) }),
    ];
    expect(matchingSessions(rig(), sessions).map((s) => s.recordId)).toEqual(['ok', 'other-lang']);
  });

  it('is empty for a realtime rig', () => {
    expect(matchingSessions(rig({ mode: 'realtime' }), [row()])).toEqual([]);
  });
});

describe('measuredLanguageOf', () => {
  it('prefers the TTS language, then the shared one, as a base code', () => {
    expect(measuredLanguageOf(row({ config: config({ ttsLanguage: 'od-IN' }) }))).toBe('or');
    expect(measuredLanguageOf(row({ config: config({ ttsLanguage: undefined, language: 'en-IN' }) }))).toBe('en');
    expect(measuredLanguageOf(row({ config: config({ ttsLanguage: 'unknown', language: 'hi' }) }))).toBe('hi');
    expect(measuredLanguageOf(row({ config: config({ ttsLanguage: undefined, language: undefined }) }))).toBeNull();
    expect(measuredLanguageOf(row({ config: undefined }))).toBeNull();
  });
});

describe('citeSessions', () => {
  const sessions = [
    row({ recordId: 'hi-old', startedAt: 1_000 }),
    row({ recordId: 'hi-new', startedAt: 5_000 }),
    row({ recordId: 'or', startedAt: 3_000, config: config({ sttLanguage: 'or-IN', ttsLanguage: 'od-IN', voice: 'shubh' }) }),
    row({ recordId: 'hi-other-voice', config: config({ voice: 'shubh' }) }),
    row({ recordId: 'hi-other-voice-2', config: config({ voice: 'shubh ' }) }),
    row({ recordId: 'hi-no-voice', config: config({ voice: undefined }) }),
    row({ recordId: 'en-not-a-row', config: config({ ttsLanguage: 'en-IN' }) }),
    row({ recordId: 'other-prompt', promptSha256: sha('Something else') }),
    row({ recordId: 'unhashed', promptSha256: undefined }),
    row({ recordId: 'manual', config: config({ turnDetection: 'manual' }) }),
  ];

  it('cites matching sessions in each row voice, newest first', () => {
    const c = citeSessions(rig(), sessions, hiOr, PROMPT);
    expect(c.cited.map((s) => s.recordId)).toEqual(['hi-new', 'or', 'hi-old']);
    expect(c.promptSha256).toBe(sha(PROMPT));
  });

  it('counts, rather than cites, other-prompt and unhashed sessions', () => {
    const c = citeSessions(rig(), sessions, hiOr, PROMPT);
    expect(c.otherPrompt).toBe(1);
    expect(c.unhashed).toBe(1);
  });

  it('records the other voices per language, de-duplicated after trimming', () => {
    const c = citeSessions(rig(), sessions, hiOr, PROMPT);
    expect(c.otherVoices).toEqual({ hi: ['shubh', '(no voice recorded)'] });
  });

  it('matches the prompt exactly, untrimmed', () => {
    const c = citeSessions(rig(), sessions, hiOr, `${PROMPT} `);
    expect(c.cited).toEqual([]);
    expect(c.otherPrompt).toBe(8);
  });

  it('uses the first row for a language listed twice, and trims the row voice', () => {
    const rows: ExportLanguage[] = [{ ...hiOr[0], voice: ' shubh ' }, hiOr[0]];
    const c = citeSessions(rig(), sessions, rows, PROMPT);
    expect(c.cited.map((s) => s.recordId)).toEqual(['hi-other-voice', 'hi-other-voice-2']);
  });

  it('is empty for no sessions or no rows', () => {
    expect(citeSessions(rig(), [], hiOr, PROMPT)).toEqual({ cited: [], promptSha256: sha(PROMPT), otherPrompt: 0, unhashed: 0, otherVoices: {} });
    expect(citeSessions(rig(), sessions, [], PROMPT).cited).toEqual([]);
  });
});

describe('provenanceFrom', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');
  const citation = (cited: SessionIndexEntry[]): Citation => ({ cited, promptSha256: 'abc', otherPrompt: 0, unhashed: 0, otherVoices: {} });

  it('is just the source and time without a citation', () => {
    expect(provenanceFrom(undefined, NOW)).toEqual({ source: 'grindelwald', exportedAt: '2026-10-20T12:00:00.000Z' });
    expect(provenanceFrom(citation([]), NOW)).toEqual({ source: 'grindelwald', exportedAt: '2026-10-20T12:00:00.000Z' });
  });

  it('defaults the export time to now', () => {
    const before = Date.now();
    const at = Date.parse(provenanceFrom(undefined).exportedAt!);
    expect(at).toBeGreaterThanOrEqual(before);
  });

  it('summarises the cited sessions', () => {
    const cited = [
      row({ recordId: 'a', costUsd: 0.02, costInr: 1.8, speechSeconds: 30, latency: { ttfaMedianMs: 900, ttfaP95Ms: 1400 } }),
      row({ recordId: 'b', costUsd: 0.01, costInr: 0.9, speechSeconds: 30, unpriced: ['x'], latency: { ttfaMedianMs: 1100, ttfaP95Ms: 1600 } }),
      row({ recordId: 'c', config: config({ ttsLanguage: 'od-IN' }), costUsd: 0.5, costInr: 45, speechSeconds: undefined, latency: { ttfaMedianMs: 1000 } }),
    ];
    expect(provenanceFrom(citation(cited), NOW)).toEqual({
      source: 'grindelwald',
      exportedAt: '2026-10-20T12:00:00.000Z',
      sessions: ['a', 'b', 'c'],
      sessionCount: 3,
      measuredLanguages: ['hi', 'or'],
      promptSha256: 'abc',
      latency: {
        ttfaMedianMs: 1000,
        ttfaSessionP95MedianMs: 1500,
        basis: "median across 3 sessions of each session's own TTFA median; the p95 figure is the median of 2 sessions' own p95s, not a p95 of turns",
      },
      costPerMinute: {
        usd: 0.03,
        inr: 2.7,
        floor: true,
        speechMinutes: 1,
        basis: 'total cost over minutes of assistant speech (TTS audio), pooled across 2 of 3 sessions; sessions with no speech time recorded are left out',
      },
    });
  });

  it('omits latency and cost it has no basis for', () => {
    const p = provenanceFrom(citation([row({ latency: {}, speechSeconds: 0 }), row({ latency: undefined, speechSeconds: NaN })]), NOW);
    expect(p.latency).toBeUndefined();
    expect(p.costPerMinute).toBeUndefined();
    expect(p.sessionCount).toBe(2);
  });

  it('omits the p95 figure when no session has one, and says "1 session"', () => {
    const p = provenanceFrom(citation([row({ latency: { ttfaMedianMs: 812.34 } })]), NOW);
    expect(p.latency).toEqual({ ttfaMedianMs: 812.3, basis: "median across 1 session of each session's own TTFA median" });
    expect(p.costPerMinute).toMatchObject({ floor: false, speechMinutes: 0.5 });
    expect((p.costPerMinute as { basis: string }).basis).toBe('total cost over minutes of assistant speech (TTS audio), pooled across 1 of 1 session');
  });

  it('rounds cost per minute to 4 places and speech minutes to 2', () => {
    const p = provenanceFrom(citation([row({ costUsd: 0.0123456, costInr: 1.1111111, speechSeconds: 7 })]), NOW);
    expect(p.costPerMinute).toMatchObject({ usd: 0.1058, inr: 9.5238, speechMinutes: 0.12 });
  });

  it('cites at most 40 session ids but counts them all', () => {
    const many = Array.from({ length: 45 }, (_, i) => row({ recordId: `rec-${i}` }));
    const p = provenanceFrom(citation(many), NOW);
    expect(p.sessions).toHaveLength(40);
    expect(p.sessions?.[39]).toBe('rec-39');
    expect(p.sessionCount).toBe(45);
  });

  it('produces provenance the spec accepts', () => {
    const many = Array.from({ length: 45 }, (_, i) => row({ recordId: `2026-10-20T12-00-00-000Z-${String(i).padStart(4, '0')}` }));
    const p = provenanceFrom(citation(many), NOW);
    const code = encodeVoiceStack(buildVoiceStackSpec(rig(), PROVIDERS, selection({ provenance: p }), VAD));
    const decoded = decodeVoiceStack(code);
    expect(decoded.ok && decoded.spec.meta.provenance).toEqual(p);
  });
});

/* ------------------------------ language rows ------------------------------ */

describe('sharedLanguages', () => {
  it('intersects the two legs by base code, named from TTS, sorted by name', () => {
    expect(sharedLanguages(rig(), PROVIDERS)).toEqual([
      { code: 'en', name: 'English', stt: ['en-IN'], tts: ['en-IN'] },
      { code: 'hi', name: 'Hindi', stt: ['hi-IN'], tts: ['hi-IN'] },
      { code: 'or', name: 'Odia', stt: ['or-IN'], tts: ['od-IN'] },
    ]);
  });

  it('groups every spelling a model lists (Murf en-US, en-IN)', () => {
    const shared = sharedLanguages(rig({ ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2' }), PROVIDERS);
    expect(shared).toEqual([
      { code: 'en', name: 'English (US)', stt: ['en-IN'], tts: ['en-US', 'en-IN'] },
      { code: 'hi', name: 'Hindi', stt: ['hi-IN'], tts: ['hi-IN'] },
    ]);
  });

  it('follows the selected model (Cartesia sonic-2 has only English)', () => {
    expect(sharedLanguages(rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-2' }), PROVIDERS).map((o) => o.code)).toEqual(['en']);
  });

  it('never offers auto-detect', () => {
    expect(sharedLanguages(rig(), PROVIDERS).some((o) => o.stt.includes('unknown'))).toBe(false);
  });

  it('is empty when either leg lists nothing', () => {
    expect(sharedLanguages(rig({ ttsProviderId: 'elevenlabs-tts', ttsModelId: 'eleven_flash_v2_5' }), PROVIDERS)).toEqual([]);
    expect(sharedLanguages(rig({ sttProviderId: 'mock-stt' }), PROVIDERS)).toEqual([]);
  });
});

describe('pickedVoiceFor', () => {
  it("keeps the rig's own voice on the rig's own language, even when no longer offered", () => {
    expect(pickedVoiceFor(rig({ voice: 'retired' }), PROVIDERS, 'hi-IN')).toBe('retired');
  });

  it('resolves against the list for any other language', () => {
    const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'en', voice: 'uuid-en-1' });
    expect(pickedVoiceFor(c, PROVIDERS, 'hi')).toBe('uuid-hi-1');
    expect(pickedVoiceFor({ ...c, voice: 'uuid-shared' }, PROVIDERS, 'hi')).toBe('uuid-shared');
    expect(pickedVoiceFor({ ...c, voice: '' }, PROVIDERS, 'en')).toBe('uuid-en-1');
  });
});

describe('rowFor', () => {
  it("prefers the rig's own vendor codes when they name the language", () => {
    const [, hi] = sharedLanguages(rig(), PROVIDERS);
    expect(rowFor(rig(), PROVIDERS, hi)).toEqual({ code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' });
  });

  it('takes the first spelling each leg lists otherwise', () => {
    const murf = rig({ ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', ttsLanguage: 'hi-IN', voice: 'en-US-shared' });
    const en = sharedLanguages(murf, PROVIDERS).find((o) => o.code === 'en')!;
    expect(rowFor(murf, PROVIDERS, en)).toEqual({ code: 'en', sttLang: 'en-IN', ttsLang: 'en-US', voice: 'en-US-shared' });
  });

  it('carries a typed voice id into every row where the vendor takes ids', () => {
    const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'en', voice: 'uuid-en-1', customVoiceId: ' clone-1 ' });
    for (const option of sharedLanguages(c, PROVIDERS)) expect(rowFor(c, PROVIDERS, option).voice).toBe('clone-1');
  });

  it('ignores a typed voice id where the vendor takes none', () => {
    const r = rig({ customVoiceId: 'clone-1' });
    expect(rowFor(r, PROVIDERS, sharedLanguages(r, PROVIDERS)[1]).voice).toBe('pooja');
  });
});

describe('initialRows', () => {
  it('is the rig\'s own row when both legs share its language', () => {
    expect(initialRows(rig(), PROVIDERS)).toEqual([{ code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' }]);
    expect(initialRows(rig({ sttLanguage: 'or-IN', ttsLanguage: 'od-IN', voice: 'shubh' }), PROVIDERS)).toEqual([
      { code: 'or', sttLang: 'or-IN', ttsLang: 'od-IN', voice: 'shubh' },
    ]);
  });

  it('is empty for a realtime rig, or a rig with no language', () => {
    expect(initialRows(rig({ mode: 'realtime' }), PROVIDERS)).toEqual([]);
    expect(initialRows(rig({ sttLanguage: 'unknown', ttsLanguage: '' }), PROVIDERS)).toEqual([]);
  });

  it('falls back to the STT language when the TTS one is unset', () => {
    expect(initialRows(rig({ ttsLanguage: '' }), PROVIDERS)[0].code).toBe('hi');
  });

  it("keeps the rig's own codes when the legs do not share its language, so the checklist can say why", () => {
    const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'fr', voice: '', customVoiceId: 'clone' });
    const rows = initialRows(c, PROVIDERS);
    expect(rows).toEqual([{ code: 'fr', sttLang: 'hi-IN', ttsLang: 'fr', voice: 'clone' }]);
    expect(blocks(checkExportable(c, PROVIDERS, selection({ languages: rows }), VAD))).toContain('fr: the STT code "hi-IN" is not fr.');
  });

  it('round-trips the initial row into a clean export', () => {
    for (const r of [rig(), rig({ ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', ttsLanguage: 'hi-IN', voice: 'en-US-shared' })]) {
      const rows = initialRows(r, [...PROVIDERS, sarvamStt, sarvamTts, murfTts, cartesiaTts]);
      const sel = { languages: rows, name: 'x', provenance: { sessions: ['s'], measuredLanguages: ['hi'] } };
      expect(blocks(checkExportable(r, PROVIDERS, sel, VAD))).toEqual([]);
    }
  });
});
