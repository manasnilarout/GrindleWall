/**
 * Shared catalog fixtures for the lib unit tests. Not a test file itself (the
 * vitest include pattern only picks up `*.test.ts`).
 *
 * Shapes are modelled on the real catalog's structural quirks — Murf's per-model
 * voice catalogues, Cartesia's per-model languages with a shared
 * `voicesByLanguage` library, provider-level languages for Sarvam — but the ids
 * are fixtures, not vendor claims.
 */
import type { ModelEntry, ProviderEntry, ProviderKind } from '../../src/lib/catalog';
import type { Rig } from '../../src/lib/rigs';

export const m = (id: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({ id, name: id, ...extra });

export function provider(id: string, kind: ProviderKind, over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id,
    name: over.name ?? id,
    kind,
    implemented: true,
    registered: true,
    ready: true,
    envKeys: [],
    missingEnv: [],
    models: [m(`${id}-model`)],
    ...over,
  };
}

export const mockRealtime = provider('mock-realtime', 'realtime', {
  name: 'Mock Realtime',
  models: [m('mock-s2s')],
  voices: [m('mock-voice-a'), m('mock-voice-b')],
});
export const openaiRealtime = provider('openai-realtime', 'realtime', {
  name: 'OpenAI Realtime',
  models: [m('gpt-realtime'), m('gpt-realtime-mini')],
  voices: [m('marin'), m('cedar')],
  languages: [m('en'), m('hi')],
});
export const mockStt = provider('mock-stt', 'stt', { name: 'Mock STT', models: [m('mock-asr')] });
export const mockLlm = provider('mock-llm', 'llm', { name: 'Mock LLM', models: [m('mock-chat')] });
export const mockTts = provider('mock-tts', 'tts', {
  name: 'Mock TTS',
  models: [m('mock-voice')],
  voices: [m('mock-tone')],
});
export const sarvamStt = provider('sarvam-stt', 'stt', {
  name: 'Sarvam Saaras',
  models: [
    m('saaras:v3-realtime@fast'),
    m('saaras:v3-realtime@balanced'),
    m('saaras:v4@fast'),
    m('saaras:v4@balanced'),
    m('saaras:v3-realtime@turbo'),
  ],
  languages: [m('unknown', { name: 'Auto-detect' }), m('hi-IN', { name: 'Hindi' }), m('or-IN', { name: 'Odia' }), m('en-IN', { name: 'English' })],
});
export const googleLlm = provider('google-llm', 'llm', {
  name: 'Google Gemini',
  models: [m('gemini-3.1-flash-lite@minimal'), m('gemini-3.1-flash-lite@high'), m('gemini-plain'), m('gemini-3.1-flash-lite@wild')],
});
export const sarvamTts = provider('sarvam-tts', 'tts', {
  name: 'Sarvam Bulbul',
  models: [m('bulbul:v3')],
  languages: [m('hi-IN', { name: 'Hindi' }), m('od-IN', { name: 'Odia' }), m('en-IN', { name: 'English' })],
  voices: [m('pooja'), m('shubh')],
});
/** Per-model language lists over a shared, language-keyed voice library. */
export const cartesiaTts = provider('cartesia-tts', 'tts', {
  name: 'Cartesia Sonic',
  acceptsVoiceId: true,
  models: [
    m('sonic-3.6', { languages: [m('en', { name: 'English' }), m('hi', { name: 'Hindi' }), m('fr', { name: 'French' })] }),
    m('sonic-2', { languages: [m('en', { name: 'English' })] }),
  ],
  voicesByLanguage: {
    en: [m('uuid-en-1'), m('uuid-shared')],
    hi: [m('uuid-hi-1'), m('uuid-shared')],
  },
});
/** Each model carries its own voice catalogue and locale list. */
export const murfTts = provider('murf-tts', 'tts', {
  name: 'Murf',
  acceptsVoiceId: true,
  models: [
    m('falcon-2', {
      voices: [m('en-US-falcon-only'), m('en-US-shared')],
      languages: [m('en-US', { name: 'English (US)' }), m('en-IN', { name: 'English (India)' }), m('hi-IN', { name: 'Hindi' })],
    }),
    m('gen2', {
      voices: [m('en-US-gen2-only'), m('en-US-shared')],
      languages: [m('en-US', { name: 'English (US)' })],
    }),
  ],
});
export const elevenTts = provider('elevenlabs-tts', 'tts', {
  name: 'ElevenLabs',
  acceptsVoiceId: true,
  models: [m('eleven_flash_v2_5')],
  voices: [m('voice-rachel')],
});
export const unregisteredTts = provider('ghost-tts', 'tts', { name: 'Ghost', registered: false, models: [m('ghost-1')] });
export const keylessLlm = provider('groq-llm', 'llm', {
  name: 'Groq',
  ready: false,
  envKeys: ['GROQ_API_KEY', 'GROQ_ORG'],
  missingEnv: ['GROQ_API_KEY', 'GROQ_ORG'],
  models: [m('llama-3.3-70b')],
});

export const PROVIDERS: ProviderEntry[] = [
  mockRealtime,
  openaiRealtime,
  mockStt,
  sarvamStt,
  mockLlm,
  googleLlm,
  keylessLlm,
  mockTts,
  sarvamTts,
  cartesiaTts,
  murfTts,
  elevenTts,
  unregisteredTts,
];

/** A fully populated pipeline rig, valid against {@link PROVIDERS}. */
export function rig(over: Partial<Rig> = {}): Rig {
  return {
    id: 'rig_test',
    name: 'Test rig',
    colorIndex: 0,
    mode: 'pipeline',
    realtimeProviderId: 'mock-realtime',
    realtimeModelId: 'mock-s2s',
    sttProviderId: 'sarvam-stt',
    sttModelId: 'saaras:v3-realtime@fast',
    llmProviderId: 'google-llm',
    llmModelId: 'gemini-3.1-flash-lite@minimal',
    ttsProviderId: 'sarvam-tts',
    ttsModelId: 'bulbul:v3',
    voice: 'pooja',
    customVoiceId: '',
    language: '',
    sttLanguage: 'hi-IN',
    ttsLanguage: 'hi-IN',
    ...over,
  };
}

/** An in-memory `Storage`, optionally with a failing accessor. */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  constructor(private readonly failing: Partial<Record<'get' | 'set' | 'remove', boolean>> = {}) {}
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    if (this.failing.get) throw new Error('SecurityError: storage disabled');
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    if (this.failing.remove) throw new Error('SecurityError: storage disabled');
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failing.set) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
}
