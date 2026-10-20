import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  RIG_COLORS,
  blankRig,
  chainOf,
  envCommandOf,
  loadRigs,
  rigColor,
  rigLetter,
  saveRigs,
  seedRigs,
  slotsOf,
  startConfigOf,
  switchMode,
  switchProvider,
  switchSttModel,
  switchVoicedLanguage,
  switchVoicedModel,
  typedVoiceIdOf,
  withDefaults,
} from '../../src/lib/rigs';
import type { Rig } from '../../src/lib/rigs';
import type { ProviderEntry } from '../../src/lib/catalog';
import {
  MemoryStorage,
  PROVIDERS,
  cartesiaTts,
  m,
  mockLlm,
  mockRealtime,
  mockStt,
  mockTts,
  provider,
  rig,
  sarvamStt,
  sarvamTts,
  unregisteredTts,
} from './fixtures';

const STRING_FIELDS: (keyof Rig)[] = [
  'id',
  'name',
  'realtimeProviderId',
  'realtimeModelId',
  'sttProviderId',
  'sttModelId',
  'llmProviderId',
  'llmModelId',
  'ttsProviderId',
  'ttsModelId',
  'voice',
  'customVoiceId',
  'language',
  'sttLanguage',
  'ttsLanguage',
];

/* --------------------------------- identity -------------------------------- */

describe('rig identity', () => {
  it('has six distinct colours', () => {
    expect(RIG_COLORS).toHaveLength(6);
    expect(new Set(RIG_COLORS).size).toBe(6);
    for (const c of RIG_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('letters and colours follow the colour index, wrapping', () => {
    expect([0, 1, 25, 26, 27].map((colorIndex) => rigLetter({ colorIndex }))).toEqual(['A', 'B', 'Z', 'A', 'B']);
    expect(rigColor({ colorIndex: 0 })).toBe(RIG_COLORS[0]);
    expect(rigColor({ colorIndex: 5 })).toBe(RIG_COLORS[5]);
    expect(rigColor({ colorIndex: 6 })).toBe(RIG_COLORS[0]);
    expect(rigColor({ colorIndex: 13 })).toBe(RIG_COLORS[1]);
  });

  it('does not reuse the leg hexes', () => {
    for (const leg of ['#3987e5', '#d95926', '#199e70']) expect(RIG_COLORS).not.toContain(leg);
  });
});

describe('blankRig', () => {
  it('has every slot empty, pipeline mode, and a random id', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const r = blankRig('Rig Q', 4);
    expect(r).toEqual({
      id: `rig_${(0.123456789).toString(36).slice(2, 9)}`,
      name: 'Rig Q',
      colorIndex: 4,
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
    });
  });

  it('mints distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => blankRig('x', 0).id));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^rig_[0-9a-z]{1,7}$/);
  });
});

/* ------------------------------- withDefaults ------------------------------ */

describe('withDefaults', () => {
  it('heals a partial stored rig with no field left undefined', () => {
    const partial = { id: 'x', name: 'Old', mode: 'pipeline', colorIndex: 2 } as unknown as Rig;
    const healed = withDefaults(partial, PROVIDERS);
    for (const k of STRING_FIELDS) expect(typeof healed[k], k).toBe('string');
    expect(healed).toMatchObject({
      id: 'x',
      name: 'Old',
      colorIndex: 2,
      realtimeProviderId: 'mock-realtime',
      realtimeModelId: 'mock-s2s',
      sttProviderId: 'mock-stt',
      sttModelId: 'mock-asr',
      llmProviderId: 'mock-llm',
      llmModelId: 'mock-chat',
      ttsProviderId: 'mock-tts',
      ttsModelId: 'mock-voice',
      voice: 'mock-tone',
      customVoiceId: '',
      language: '',
      sttLanguage: '',
      ttsLanguage: '',
    });
  });

  it('coerces null fields away without a catalog', () => {
    const raw = { ...rig(), customVoiceId: null, voice: undefined } as unknown as Rig;
    const healed = withDefaults(raw, []);
    expect(healed.customVoiceId).toBe('');
    expect(healed.voice).toBe('');
    expect(healed.ttsProviderId).toBe('sarvam-tts'); // not checked without a catalog
  });

  it('leaves a valid rig exactly as it was', () => {
    expect(withDefaults(rig(), PROVIDERS)).toEqual(rig());
    const cartesia = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'hi', voice: 'uuid-shared' });
    expect(withDefaults(cartesia, PROVIDERS)).toEqual(cartesia);
  });

  it('prefers a registered provider when filling a slot', () => {
    const healed = withDefaults(rig({ ttsProviderId: '' }), [unregisteredTts, sarvamTts]);
    expect(healed.ttsProviderId).toBe('sarvam-tts');
    expect(withDefaults(rig({ ttsProviderId: '' }), [unregisteredTts]).ttsProviderId).toBe('ghost-tts');
  });

  it('keeps a known but unregistered provider the rig already names', () => {
    expect(withDefaults(rig({ ttsProviderId: 'ghost-tts', ttsModelId: 'ghost-1' }), PROVIDERS).ttsProviderId).toBe('ghost-tts');
  });

  it('replaces a provider of the wrong kind rather than healing it into the slot', () => {
    const crossed = withDefaults(rig({ sttProviderId: 'murf-tts', sttModelId: 'falcon-2' }), PROVIDERS);
    expect(crossed.sttProviderId).toBe('mock-stt');
    expect(crossed.sttModelId).toBe('mock-asr');
  });

  it('replaces a provider that is gone from the catalog', () => {
    const gone = withDefaults(rig({ llmProviderId: 'retired-llm', llmModelId: 'x' }), PROVIDERS);
    expect(gone.llmProviderId).toBe('mock-llm');
    expect(gone.llmModelId).toBe('mock-chat');
  });

  it("falls back to the provider's first model for an unknown model", () => {
    expect(withDefaults(rig({ sttModelId: 'saaras:v1' }), PROVIDERS).sttModelId).toBe('saaras:v3-realtime@fast');
  });

  it('carries a renamed model id to its new name', () => {
    expect(withDefaults(rig({ sttModelId: 'saaras:v4-realtime@fast' }), PROVIDERS).sttModelId).toBe('saaras:v4@fast');
    expect(withDefaults(rig({ sttModelId: 'saaras:v4-realtime@balanced' }), PROVIDERS).sttModelId).toBe('saaras:v4@balanced');
  });

  it('does not rename into a model the provider no longer offers', () => {
    const v3only: ProviderEntry = { ...sarvamStt, models: [m('saaras:v3-realtime@fast')] };
    const healed = withDefaults(rig({ sttModelId: 'saaras:v4-realtime@fast' }), [...PROVIDERS.filter((p) => p.id !== 'sarvam-stt'), v3only]);
    expect(healed.sttModelId).toBe('saaras:v3-realtime@fast');
  });

  it('keeps a valid language and resets an invalid one to the first offered', () => {
    expect(withDefaults(rig({ sttLanguage: 'or-IN' }), PROVIDERS).sttLanguage).toBe('or-IN');
    expect(withDefaults(rig({ sttLanguage: 'xx-XX' }), PROVIDERS).sttLanguage).toBe('unknown');
    const sonic2 = withDefaults(rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-2', ttsLanguage: 'hi', voice: 'uuid-hi-1' }), PROVIDERS);
    expect(sonic2.ttsLanguage).toBe('en');
    expect(sonic2.voice).toBe('uuid-en-1'); // language settled first, then the voice against it
  });

  it('empties a language the provider does not take', () => {
    expect(withDefaults(rig({ llmProviderId: 'google-llm', language: 'hi' }), PROVIDERS).language).toBe('');
  });

  it('settles the voice against the TTS leg in pipeline mode', () => {
    expect(withDefaults(rig({ voice: 'marin' }), PROVIDERS).voice).toBe('pooja');
    expect(withDefaults(rig({ voice: 'shubh' }), PROVIDERS).voice).toBe('shubh');
  });

  it('settles the voice against the realtime provider in realtime mode', () => {
    const rt = rig({ mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime', voice: 'pooja', language: 'fr' });
    const healed = withDefaults(rt, PROVIDERS);
    expect(healed.voice).toBe('marin');
    expect(healed.language).toBe('en');
    expect(withDefaults({ ...rt, voice: 'cedar', language: 'hi' }, PROVIDERS)).toMatchObject({ voice: 'cedar', language: 'hi' });
  });

  it('empties the voice when the owner has none', () => {
    const noVoices = provider('silent-tts', 'tts', { models: [m('s1')] });
    expect(withDefaults(rig({ ttsProviderId: 'silent-tts', ttsModelId: 's1', voice: 'pooja' }), [noVoices]).voice).toBe('');
  });

  it('does not mutate its input', () => {
    const input = rig({ sttProviderId: 'nope' });
    const snapshot = JSON.stringify(input);
    withDefaults(input, PROVIDERS);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  // BUG (src/lib/rigs.ts:408-411): `strip` is documented as dropping
  // "undefined/non-string fields" but only drops undefined and null, so a stored
  // `customVoiceId: 42` survives `withDefaults` as a number and
  // `typedVoiceIdOf` / `envCommandOf` then throw on `.trim()`.
  it.fails('coerces a non-string field from storage to a string', () => {
    const healed = withDefaults({ ...rig(), customVoiceId: 42 } as unknown as Rig, PROVIDERS);
    expect(typeof healed.customVoiceId).toBe('string');
  });
});

/* ---------------------------- voice and config ----------------------------- */

describe('typedVoiceIdOf', () => {
  it('returns the trimmed typed id when the voice owner takes ids', () => {
    expect(typedVoiceIdOf(rig({ ttsProviderId: 'cartesia-tts', customVoiceId: '  clone-7 ' }), PROVIDERS)).toBe('clone-7');
  });

  it('ignores the typed id for a vendor that takes none', () => {
    expect(typedVoiceIdOf(rig({ customVoiceId: 'clone-7' }), PROVIDERS)).toBe('');
  });

  it('asks the realtime provider in realtime mode, not the TTS leg', () => {
    const r = rig({ mode: 'realtime', ttsProviderId: 'cartesia-tts', customVoiceId: 'clone-7' });
    expect(typedVoiceIdOf(r, PROVIDERS)).toBe('');
    const idRealtime = provider('idrt-realtime', 'realtime', { acceptsVoiceId: true });
    expect(typedVoiceIdOf({ ...r, realtimeProviderId: 'idrt-realtime' }, [idRealtime])).toBe('clone-7');
  });

  it('is empty for an unknown owner', () => {
    expect(typedVoiceIdOf(rig({ ttsProviderId: 'nope', customVoiceId: 'x' }), PROVIDERS)).toBe('');
  });
});

describe('startConfigOf', () => {
  it('copies every slot and the prompt and turn detection', () => {
    const r = rig({ language: 'en' });
    expect(startConfigOf(r, PROVIDERS, 'Be brief.', 'manual')).toEqual({
      mode: 'pipeline',
      realtimeProviderId: 'mock-realtime',
      realtimeModelId: 'mock-s2s',
      sttProviderId: 'sarvam-stt',
      sttModelId: 'saaras:v3-realtime@fast',
      llmProviderId: 'google-llm',
      llmModelId: 'gemini-3.1-flash-lite@minimal',
      ttsProviderId: 'sarvam-tts',
      ttsModelId: 'bulbul:v3',
      systemPrompt: 'Be brief.',
      voice: 'pooja',
      language: 'en',
      sttLanguage: 'hi-IN',
      ttsLanguage: 'hi-IN',
      turnDetection: 'manual',
    });
  });

  it('sends the typed voice id over the dropdown where the vendor takes one', () => {
    const r = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', voice: 'uuid-en-1', customVoiceId: 'clone' });
    expect(startConfigOf(r, PROVIDERS, '', 'server_vad').voice).toBe('clone');
    expect(startConfigOf({ ...r, customVoiceId: '   ' }, PROVIDERS, '', 'server_vad').voice).toBe('uuid-en-1');
    expect(startConfigOf({ ...r, ttsProviderId: 'sarvam-tts' }, PROVIDERS, '', 'server_vad').voice).toBe('uuid-en-1');
  });

  it('keeps the prompt verbatim, untrimmed', () => {
    expect(startConfigOf(rig(), PROVIDERS, '  spaced \n', 'server_vad').systemPrompt).toBe('  spaced \n');
  });
});

/* ------------------------------- transitions ------------------------------- */

describe('switchProvider', () => {
  const start = rig({ customVoiceId: 'typed', language: 'en' });

  it('TTS: takes the first model, its first language and that language\'s first voice, and drops the typed id', () => {
    expect(switchProvider(start, PROVIDERS, 'tts', 'cartesia-tts')).toEqual({
      ...start,
      ttsProviderId: 'cartesia-tts',
      ttsModelId: 'sonic-3.6',
      ttsLanguage: 'en',
      voice: 'uuid-en-1',
      customVoiceId: '',
    });
    expect(switchProvider(start, PROVIDERS, 'tts', 'murf-tts')).toMatchObject({
      ttsModelId: 'falcon-2',
      ttsLanguage: 'en-US',
      voice: 'en-US-falcon-only',
    });
  });

  it('realtime: resets model, language and voice, and drops the typed id', () => {
    expect(switchProvider(start, PROVIDERS, 'realtime', 'openai-realtime')).toEqual({
      ...start,
      realtimeProviderId: 'openai-realtime',
      realtimeModelId: 'gpt-realtime',
      language: 'en',
      voice: 'marin',
      customVoiceId: '',
    });
  });

  it('STT: resets model and STT language only', () => {
    expect(switchProvider(start, PROVIDERS, 'stt', 'mock-stt')).toEqual({
      ...start,
      sttProviderId: 'mock-stt',
      sttModelId: 'mock-asr',
      sttLanguage: '',
    });
    expect(switchProvider(rig(), PROVIDERS, 'stt', 'sarvam-stt').sttLanguage).toBe('unknown');
  });

  it('LLM: resets the model only', () => {
    expect(switchProvider(start, PROVIDERS, 'llm', 'mock-llm')).toEqual({ ...start, llmProviderId: 'mock-llm', llmModelId: 'mock-chat' });
  });

  it('empties the model, language and voice for an id the catalog does not know', () => {
    expect(switchProvider(start, PROVIDERS, 'tts', 'nope-tts')).toMatchObject({
      ttsProviderId: 'nope-tts',
      ttsModelId: '',
      ttsLanguage: '',
      voice: '',
    });
  });

  it('does not mutate the rig', () => {
    const before = JSON.stringify(start);
    switchProvider(start, PROVIDERS, 'tts', 'cartesia-tts');
    expect(JSON.stringify(start)).toBe(before);
  });
});

describe('switchMode', () => {
  it('returns the very same rig when the mode does not change', () => {
    const r = rig();
    expect(switchMode(r, PROVIDERS, 'pipeline')).toBe(r);
  });

  it("hands the voice to the realtime provider's list on the way in", () => {
    const pipe = rig({
      ttsProviderId: 'cartesia-tts',
      ttsModelId: 'sonic-3.6',
      ttsLanguage: 'en',
      voice: 'uuid-en-1',
      customVoiceId: 'clone',
      realtimeProviderId: 'openai-realtime',
      realtimeModelId: 'gpt-realtime',
      language: 'en',
    });
    const rt = switchMode(pipe, PROVIDERS, 'realtime');
    expect(rt).toEqual({ ...pipe, mode: 'realtime', voice: 'marin', customVoiceId: '' });

    const back = switchMode({ ...rt, voice: 'cedar' }, PROVIDERS, 'pipeline');
    expect(back).toEqual({ ...pipe, mode: 'pipeline', voice: 'uuid-en-1', customVoiceId: '' });
  });

  it('keeps a voice both owners offer', () => {
    const shared: ProviderEntry[] = [
      provider('a-realtime', 'realtime', { voices: [m('alloy'), m('common')] }),
      provider('b-tts', 'tts', { voices: [m('other'), m('common')] }),
    ];
    const r = rig({ realtimeProviderId: 'a-realtime', realtimeModelId: 'a-realtime-model', ttsProviderId: 'b-tts', ttsModelId: 'b-tts-model', voice: 'common' });
    expect(switchMode(r, shared, 'realtime').voice).toBe('common');
  });
});

describe('switchVoicedModel', () => {
  const murf = rig({ ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', ttsLanguage: 'en-IN', voice: 'en-US-shared', customVoiceId: 'x' });

  it('keeps a voice the new model shares and resets a language it lacks', () => {
    expect(switchVoicedModel(murf, PROVIDERS, 'tts', 'gen2')).toEqual({
      ...murf,
      ttsModelId: 'gen2',
      ttsLanguage: 'en-US',
      voice: 'en-US-shared',
      customVoiceId: '',
    });
  });

  it("replaces a voice that belongs to the other model's catalogue", () => {
    expect(switchVoicedModel({ ...murf, voice: 'en-US-falcon-only' }, PROVIDERS, 'tts', 'gen2').voice).toBe('en-US-gen2-only');
  });

  it('settles the language before the voice (Cartesia sonic-3.6 -> sonic-2)', () => {
    const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'hi', voice: 'uuid-hi-1' });
    expect(switchVoicedModel(c, PROVIDERS, 'tts', 'sonic-2')).toMatchObject({ ttsLanguage: 'en', voice: 'uuid-en-1' });
    expect(switchVoicedModel({ ...c, voice: 'uuid-shared' }, PROVIDERS, 'tts', 'sonic-2').voice).toBe('uuid-shared');
  });

  it('works on the realtime slot', () => {
    const rt = rig({ mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime', language: 'hi', voice: 'cedar', customVoiceId: 'y' });
    expect(switchVoicedModel(rt, PROVIDERS, 'realtime', 'gpt-realtime-mini')).toEqual({
      ...rt,
      realtimeModelId: 'gpt-realtime-mini',
      language: 'hi',
      voice: 'cedar',
      customVoiceId: '',
    });
  });
});

describe('switchVoicedLanguage', () => {
  const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'en', voice: 'uuid-en-1', customVoiceId: 'z' });

  it('narrows the voice to the new language', () => {
    expect(switchVoicedLanguage(c, PROVIDERS, 'tts', 'hi')).toEqual({ ...c, ttsLanguage: 'hi', voice: 'uuid-hi-1', customVoiceId: '' });
  });

  it('keeps a voice the new language also files', () => {
    expect(switchVoicedLanguage({ ...c, voice: 'uuid-shared' }, PROVIDERS, 'tts', 'hi').voice).toBe('uuid-shared');
  });

  it('empties the voice for a language with no voices', () => {
    expect(switchVoicedLanguage(c, PROVIDERS, 'tts', 'fr').voice).toBe('');
  });

  it('writes the realtime language for the realtime slot', () => {
    const rt = rig({ mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime', language: 'en', voice: 'cedar' });
    expect(switchVoicedLanguage(rt, PROVIDERS, 'realtime', 'hi')).toEqual({ ...rt, language: 'hi', voice: 'cedar', customVoiceId: '' });
  });
});

describe('switchSttModel', () => {
  const perModel = provider('pm-stt', 'stt', {
    models: [m('wide', { languages: [m('en'), m('hi')] }), m('narrow', { languages: [m('en')] }), m('none')],
  });
  const r = rig({ sttProviderId: 'pm-stt', sttModelId: 'wide', sttLanguage: 'hi' });

  it('keeps a language the new model takes', () => {
    expect(switchSttModel({ ...r, sttLanguage: 'en' }, [perModel], 'narrow')).toEqual({ ...r, sttModelId: 'narrow', sttLanguage: 'en' });
  });

  it('resets a language the new model lacks', () => {
    expect(switchSttModel(r, [perModel], 'narrow').sttLanguage).toBe('en');
  });

  it('empties the language when the model lists none', () => {
    expect(switchSttModel(r, [perModel], 'none').sttLanguage).toBe('');
  });

  it('touches nothing but the STT model and language', () => {
    const out = switchSttModel(r, [perModel], 'narrow');
    expect({ ...out, sttModelId: r.sttModelId, sttLanguage: r.sttLanguage }).toEqual(r);
  });
});

/* ---------------------------------- slots ---------------------------------- */

describe('slotsOf / chainOf', () => {
  it('lists the three pipeline legs in wire order', () => {
    const slots = slotsOf(rig(), PROVIDERS);
    expect(slots.map((s) => [s.key, s.label, s.color, s.providerName, s.modelId, s.ready, s.blocker])).toEqual([
      ['stt', 'STT', '#3987e5', 'Sarvam Saaras', 'saaras:v3-realtime@fast', true, undefined],
      ['llm', 'LLM', '#d95926', 'Google Gemini', 'gemini-3.1-flash-lite@minimal', true, undefined],
      ['tts', 'TTS', '#199e70', 'Sarvam Bulbul', 'bulbul:v3', true, undefined],
    ]);
  });

  it('is a single S2S leg in realtime mode', () => {
    const slots = slotsOf(rig({ mode: 'realtime' }), PROVIDERS);
    expect(slots).toEqual([
      {
        key: 'realtime',
        label: 'S2S',
        color: '#199e70',
        providerId: 'mock-realtime',
        modelId: 'mock-s2s',
        providerName: 'Mock Realtime',
        ready: true,
        blocker: undefined,
      },
    ]);
  });

  it('names what blocks a leg', () => {
    const slots = slotsOf(rig({ sttProviderId: 'nope-stt', llmProviderId: 'groq-llm', ttsProviderId: 'ghost-tts' }), PROVIDERS);
    expect(slots.map((s) => [s.providerName, s.ready, s.blocker])).toEqual([
      ['nope-stt', false, 'not in the catalog'],
      ['Groq', false, 'needs GROQ_API_KEY, GROQ_ORG'],
      ['Ghost', false, 'not wired up'],
    ]);
  });

  it('chains the provider names', () => {
    expect(chainOf(rig(), PROVIDERS)).toEqual(['Sarvam Saaras', 'Google Gemini', 'Sarvam Bulbul']);
    expect(chainOf(rig({ mode: 'realtime' }), PROVIDERS)).toEqual(['Mock Realtime']);
  });
});

/* ------------------------------- envCommandOf ------------------------------ */

/** The names `backend/scripts/smoke.mjs` reads (CLAUDE.md pins them). */
const CONTRACT = new Set([
  'TTS',
  'TTS_MODEL',
  'STT',
  'STT_MODEL',
  'LLM',
  'LLM_MODEL',
  'REALTIME',
  'REALTIME_MODEL',
  'VOICE',
  'LANG_CODE',
  'STT_LANG',
  'TTS_LANG',
  'SYSTEM',
  'PROMPT',
]);

const SH = ['/bin/sh', '/usr/bin/sh'].find((p) => existsSync(p));

/**
 * Executes the command in a real POSIX shell, with the smoke script swapped for
 * a probe that prints what it received. Proves the quoting parses back to the
 * exact values, which string comparison alone cannot.
 */
function runInShell(cmd: string): { env: Record<string, string>; argv: string[] } {
  const probe = 'process.stdout.write(JSON.stringify({env:process.env,argv:process.argv.slice(1)}))';
  const swapped = cmd.replace('node scripts/smoke.mjs', `"${process.execPath}" -e '${probe}' --`);
  expect(swapped).not.toBe(cmd);
  const out = execFileSync(SH!, ['-c', swapped], { env: {}, encoding: 'utf8' });
  const parsed = JSON.parse(out) as { env: Record<string, string>; argv: string[] };
  const env = Object.fromEntries(Object.entries(parsed.env).filter(([k]) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)));
  return { env, argv: parsed.argv };
}

describe('envCommandOf', () => {
  const pipelineRig = rig();
  const realtimeRig = rig({ mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime', voice: 'marin', language: 'en' });

  it('spells a pipeline rig exactly', () => {
    expect(envCommandOf(pipelineRig, PROVIDERS)).toBe(
      [
        'STT=sarvam-stt STT_MODEL=saaras:v3-realtime@fast STT_LANG=hi-IN \\',
        'LLM=google-llm LLM_MODEL=gemini-3.1-flash-lite@minimal \\',
        'TTS=sarvam-tts TTS_MODEL=bulbul:v3 TTS_LANG=hi-IN VOICE=pooja \\',
        '  node scripts/smoke.mjs pipeline',
      ].join('\n'),
    );
  });

  it('spells a realtime rig exactly, with the mode as argv', () => {
    expect(envCommandOf(realtimeRig, PROVIDERS)).toBe(
      ['REALTIME=openai-realtime REALTIME_MODEL=gpt-realtime \\', 'VOICE=marin LANG_CODE=en \\', '  node scripts/smoke.mjs realtime'].join('\n'),
    );
  });

  it('adds the system prompt, trimmed and quoted, before the command', () => {
    expect(envCommandOf(pipelineRig, PROVIDERS, "  Don't use lists \n")).toBe(
      [
        'STT=sarvam-stt STT_MODEL=saaras:v3-realtime@fast STT_LANG=hi-IN \\',
        'LLM=google-llm LLM_MODEL=gemini-3.1-flash-lite@minimal \\',
        'TTS=sarvam-tts TTS_MODEL=bulbul:v3 TTS_LANG=hi-IN VOICE=pooja \\',
        "SYSTEM='Don'\\''t use lists' \\",
        '  node scripts/smoke.mjs pipeline',
      ].join('\n'),
    );
    expect(envCommandOf(realtimeRig, PROVIDERS, 'brief')).toContain('SYSTEM=brief \\\n  node scripts/smoke.mjs realtime');
  });

  it('omits SYSTEM for an absent or blank prompt', () => {
    expect(envCommandOf(pipelineRig, PROVIDERS)).not.toContain('SYSTEM');
    expect(envCommandOf(pipelineRig, PROVIDERS, '')).not.toContain('SYSTEM');
    expect(envCommandOf(pipelineRig, PROVIDERS, '  \n\t ')).not.toContain('SYSTEM');
  });

  it('omits VOICE when there is none, in either mode', () => {
    expect(envCommandOf(rig({ voice: '' }), PROVIDERS)).not.toContain('VOICE');
    const rt = envCommandOf({ ...realtimeRig, voice: '' }, PROVIDERS);
    expect(rt).not.toContain('VOICE');
    expect(rt.split('\n')[1]).toBe('LANG_CODE=en \\');
  });

  it("emits '' for an empty value rather than leaving the assignment dangling", () => {
    const out = envCommandOf(rig({ sttLanguage: '', ttsLanguage: '' }), PROVIDERS);
    expect(out).toContain("STT_LANG='' \\");
    expect(out).toContain("TTS_LANG='' VOICE=pooja");
    expect(envCommandOf({ ...realtimeRig, language: '' }, PROVIDERS)).toContain("LANG_CODE='' \\");
  });

  it('prefers the typed voice id only where the vendor takes ids', () => {
    const c = rig({ ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', ttsLanguage: 'en', voice: 'uuid-en-1', customVoiceId: ' clone-9 ' });
    expect(envCommandOf(c, PROVIDERS)).toContain('VOICE=clone-9 \\');
    expect(envCommandOf({ ...c, customVoiceId: '   ' }, PROVIDERS)).toContain('VOICE=uuid-en-1 \\');
    expect(envCommandOf(rig({ customVoiceId: 'clone-9' }), PROVIDERS)).toContain('VOICE=pooja \\');
  });

  it('agrees with startConfigOf on the voice it sends', () => {
    const cases = [
      rig(),
      rig({ ttsProviderId: 'cartesia-tts', customVoiceId: 'typed' }),
      rig({ ttsProviderId: 'cartesia-tts', customVoiceId: '  ' }),
      { ...realtimeRig, customVoiceId: 'typed' },
    ];
    for (const r of cases) {
      const voice = startConfigOf(r, PROVIDERS, '', 'server_vad').voice;
      expect(envCommandOf(r, PROVIDERS)).toContain(`VOICE=${voice}`);
    }
  });

  it('leaves safe characters unquoted and quotes everything else', () => {
    const out = envCommandOf(rig({ voice: 'en-US_v1.2/x:y@z' }), PROVIDERS);
    expect(out).toContain('VOICE=en-US_v1.2/x:y@z \\');
    for (const [voice, quoted] of [
      ['my voice', "'my voice'"],
      ['$HOME', "'$HOME'"],
      ['a"b', `'a"b'`],
      ['`id`', "'`id`'"],
      ['x;y', "'x;y'"],
      ['a=b', "'a=b'"],
      ['~', "'~'"],
      ['*', "'*'"],
      ["it's", "'it'\\''s'"],
      ['ü', "'ü'"],
    ]) {
      expect(envCommandOf(rig({ voice }), PROVIDERS)).toContain(`VOICE=${quoted} \\`);
    }
  });

  it('only ever assigns variables smoke.mjs reads, and never MODE or LANG', () => {
    const rigs = [pipelineRig, realtimeRig, rig({ voice: '' }), { ...realtimeRig, voice: '' }];
    for (const r of rigs) {
      const cmd = envCommandOf(r, PROVIDERS, 'prompt');
      const names = [...cmd.matchAll(/(?:^|\s)([A-Z][A-Z_]*)=/g)].map((x) => x[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(CONTRACT.has(n), n).toBe(true);
      expect(names).not.toContain('MODE');
      expect(names).not.toContain('LANG');
    }
  });

  it('always pairs a provider with its *_MODEL (smoke refuses one without the other)', () => {
    const cmd = envCommandOf(pipelineRig, PROVIDERS);
    for (const k of ['STT', 'LLM', 'TTS']) {
      expect(cmd).toMatch(new RegExp(`(^|\\s)${k}=\\S+ ${k}_MODEL=\\S+`));
    }
    expect(envCommandOf(realtimeRig, PROVIDERS)).toMatch(/^REALTIME=\S+ REALTIME_MODEL=\S+/);
  });

  describe.skipIf(!SH)('parsed by a real POSIX shell', () => {
    it('delivers every pipeline value exactly, and the mode as argv', () => {
      const { env, argv } = runInShell(envCommandOf(pipelineRig, PROVIDERS, 'Be brief.'));
      expect(argv).toEqual(['pipeline']);
      expect(env).toEqual({
        STT: 'sarvam-stt',
        STT_MODEL: 'saaras:v3-realtime@fast',
        STT_LANG: 'hi-IN',
        LLM: 'google-llm',
        LLM_MODEL: 'gemini-3.1-flash-lite@minimal',
        TTS: 'sarvam-tts',
        TTS_MODEL: 'bulbul:v3',
        TTS_LANG: 'hi-IN',
        VOICE: 'pooja',
        SYSTEM: 'Be brief.',
      });
    });

    it('delivers every realtime value exactly', () => {
      const { env, argv } = runInShell(envCommandOf(realtimeRig, PROVIDERS));
      expect(argv).toEqual(['realtime']);
      expect(env).toEqual({ REALTIME: 'openai-realtime', REALTIME_MODEL: 'gpt-realtime', VOICE: 'marin', LANG_CODE: 'en' });
    });

    it('survives a hostile system prompt and hostile values without injection or truncation', () => {
      const prompt = `It's "quoted" — $HOME \`id\` $(echo pwned) \\ back\\slash; rm -rf / & | > < * ~ ''' 🎙️\nsecond line`;
      const hostile = rig({ voice: "o'clock $USER", sttLanguage: 'a b', ttsLanguage: '"x"' });
      const { env } = runInShell(envCommandOf(hostile, PROVIDERS, prompt));
      expect(env.SYSTEM).toBe(prompt);
      expect(env.VOICE).toBe("o'clock $USER");
      expect(env.STT_LANG).toBe('a b');
      expect(env.TTS_LANG).toBe('"x"');
    });

    it("delivers an empty value as the empty string", () => {
      const { env } = runInShell(envCommandOf({ ...realtimeRig, language: '' }, PROVIDERS));
      expect(env.LANG_CODE).toBe('');
    });
  });
});

/* --------------------------------- storage --------------------------------- */

describe('loadRigs / saveRigs', () => {
  const useStorage = (storage: Storage) => vi.stubGlobal('window', { localStorage: storage });
  const r1 = rig({ id: 'rig_a', name: 'A', colorIndex: 0 });
  const r2 = rig({ id: 'rig_b', name: 'B', colorIndex: 1, mode: 'realtime' });

  it('round-trips rigs and the active id', () => {
    const storage = new MemoryStorage();
    useStorage(storage);
    saveRigs([r1, r2], 'rig_b');
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe('bench.rigs.v1');
    expect(loadRigs()).toEqual({ rigs: [r1, r2], activeId: 'rig_b' });
  });

  it('is null when nothing is stored', () => {
    useStorage(new MemoryStorage());
    expect(loadRigs()).toBeNull();
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['JSON null', 'null'],
    ['a number', '5'],
    ['a string', '"rigs"'],
    ['rigs not an array', JSON.stringify({ rigs: { 0: {} } })],
    ['an empty list', JSON.stringify({ rigs: [] })],
    ['only invalid rigs', JSON.stringify({ rigs: [null, 3, { id: '', name: 'x', mode: 'pipeline', colorIndex: 0 }] })],
  ])('is null for %s', (_label, raw) => {
    const storage = new MemoryStorage();
    storage.setItem('bench.rigs.v1', raw);
    useStorage(storage);
    expect(loadRigs()).toBeNull();
  });

  it('drops rigs missing a field that cannot be healed', () => {
    const base = { id: 'ok', name: 'ok', mode: 'pipeline', colorIndex: 0 };
    const storage = new MemoryStorage();
    storage.setItem(
      'bench.rigs.v1',
      JSON.stringify({
        rigs: [
          base,
          { ...base, id: undefined },
          { ...base, id: 7 },
          { ...base, name: 3 },
          { ...base, mode: 'hybrid' },
          { ...base, colorIndex: '1' },
          { ...base, colorIndex: null },
          'rig',
        ],
      }),
    );
    useStorage(storage);
    const loaded = loadRigs()!;
    expect(loaded.rigs.map((r) => r.id)).toEqual(['ok']);
  });

  it('heals an old, minimal rig shape into a full one', () => {
    const storage = new MemoryStorage();
    storage.setItem('bench.rigs.v1', JSON.stringify({ rigs: [{ id: 'old', name: 'Old', mode: 'realtime', colorIndex: 3, voice: 'marin' }] }));
    useStorage(storage);
    const [healed] = loadRigs()!.rigs;
    expect(healed).toMatchObject({ id: 'old', name: 'Old', mode: 'realtime', colorIndex: 3, voice: 'marin', customVoiceId: '', ttsProviderId: '' });
    for (const k of STRING_FIELDS) expect(typeof healed[k], k).toBe('string');
  });

  it('falls back to the first rig for a missing, stale or non-string active id', () => {
    for (const activeId of [undefined, 'rig_gone', 42, null]) {
      const storage = new MemoryStorage();
      storage.setItem('bench.rigs.v1', JSON.stringify({ rigs: [r1, r2], activeId }));
      useStorage(storage);
      expect(loadRigs()!.activeId).toBe('rig_a');
    }
  });

  it('is null, not a crash, when the store throws or does not exist', () => {
    useStorage(new MemoryStorage({ get: true }));
    expect(loadRigs()).toBeNull();
    vi.stubGlobal('window', undefined);
    expect(loadRigs()).toBeNull();
  });

  it('swallows a full or missing store on save', () => {
    useStorage(new MemoryStorage({ set: true }));
    expect(() => saveRigs([r1], 'rig_a')).not.toThrow();
    vi.stubGlobal('window', undefined);
    expect(() => saveRigs([r1], 'rig_a')).not.toThrow();
  });

  // Consequence of the `strip` bug above: a stored non-string field reaches the UI.
  it.fails('never hands the UI a rig whose envCommandOf throws', () => {
    const storage = new MemoryStorage();
    storage.setItem('bench.rigs.v1', JSON.stringify({ rigs: [{ ...rig({ ttsProviderId: 'cartesia-tts' }), customVoiceId: 42 }] }));
    useStorage(storage);
    const [loaded] = loadRigs()!.rigs;
    expect(() => envCommandOf(withDefaults(loaded, PROVIDERS), PROVIDERS)).not.toThrow();
  });
});

describe('seedRigs', () => {
  it('seeds three named, coloured, filled rigs', () => {
    const rigs = seedRigs([mockRealtime, mockStt, mockLlm, mockTts, sarvamStt, sarvamTts, cartesiaTts]);
    expect(rigs.map((r) => [r.name, r.colorIndex, r.mode])).toEqual([
      ['Rig A', 0, 'pipeline'],
      ['Rig B', 1, 'pipeline'],
      ['Rig C', 2, 'pipeline'],
    ]);
    expect(new Set(rigs.map((r) => r.id)).size).toBe(3);
    for (const r of rigs) {
      expect(r).toMatchObject({ sttProviderId: 'mock-stt', llmProviderId: 'mock-llm', ttsProviderId: 'mock-tts', voice: 'mock-tone' });
    }
  });

  it('seeds blank rigs against an empty catalog', () => {
    for (const r of seedRigs([])) expect(r.ttsProviderId).toBe('');
  });
});
