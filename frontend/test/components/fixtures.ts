/**
 * Shared fixtures for the component and hook tests.
 *
 * Copied (not imported) from `scripts/render-check.tsx`, which is a script with
 * side effects at module load. Shapes are kept identical so the two suites
 * describe the same records, catalogs and rigs.
 */
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { ProviderEntry } from '../../src/lib/catalog';
import type { SessionIndexEntry, SessionSummary, StartConfig, TurnUsage } from '../../src/lib/protocol';
import { blankRig, type Rig } from '../../src/lib/rigs';
import type { LogLine, TurnRecord } from '../../src/hooks/useVoiceSession';
import type { VoiceSessionHandle } from '../../src/components/BenchView';
import type { ExportLanguage } from '../../src/lib/voice-stack/export';

/** Fixed clock for the synthetic record, so dates in the markup are stable. */
export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

/** Covers the branches a mock-only session would not: rupees, thinking, unpriced. */
export const SYNTHETIC: SessionSummary = {
  recordId: 'synthetic',
  sessionId: 'synthetic',
  mode: 'pipeline',
  label: 'sarvam-stt:saaras:v3-realtime@fast → google-llm:gemini-3.8-flash@low → murf-tts:falcon-2',
  config: { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' },
  startedAt: NOW - 62_000,
  endedAt: NOW,
  durationMs: 62_000,
  turnCount: 2,
  costUsd: 0.0041,
  costInr: 0.3628,
  unpriced: ['elevenlabs-tts:v3'],
  usdPerInr: 0.0113,
  latency: {
    ttfaMedianMs: 812, ttfaP95Ms: 1403, ttfaMinMs: 640, ttfaMaxMs: 1403,
    sttMedianMs: 214, llmTtftMedianMs: 486, ttsTtfbMedianMs: 640,
    totalTurnMedianMs: 3120, audioMedianMs: 2740,
  },
  totals: [
    { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds',
      inputUnits: 7.4, outputUnits: 0, source: 'local',
      cost: { amount: 0.0617, currency: 'INR', amountUsd: 0.0007, amountInr: 0.0617, rate: '₹30 per hour of audio', confidence: 'verified' } },
    { leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.8-flash@low', unit: 'tokens',
      inputUnits: 1240, outputUnits: 410, thinkingTokens: 302, cachedInputTokens: 900, source: 'vendor',
      cost: { amount: 0.0025, currency: 'USD', amountUsd: 0.0025, amountInr: 0.2212, rate: '$0.75 in / $3.75 out per 1M tokens', confidence: 'verified' } },
    { leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters',
      inputUnits: 0, outputUnits: 296, audioSeconds: 11.2, source: 'local',
      cost: { amount: 0.0089, currency: 'USD', amountUsd: 0.0089, amountInr: 0.7876, rate: '$0.03 per 1K characters',
        confidence: 'ambiguous', note: 'Murf markets Falcon at "1 cent per minute" instead.' } },
    { leg: 'tts', providerId: 'elevenlabs-tts', modelId: 'v3', unit: 'characters',
      inputUnits: 0, outputUnits: 40, source: 'local', unpricedReason: 'No rate on file for elevenlabs-tts:v3' },
  ],
  turns: [
    { turnId: 1, at: NOW - 40_000, costUsd: 0.0019, costInr: 0.1681, unpriced: [],
      legs: [
        { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 3.2, outputUnits: 0, source: 'local' },
        { leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.8-flash@low', unit: 'tokens', inputUnits: 520, outputUnits: 180, thinkingTokens: 140, source: 'vendor' },
        { leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', inputUnits: 0, outputUnits: 140, audioSeconds: 5.1, source: 'local' },
      ] },
    { turnId: 2, at: NOW - 10_000, costUsd: 0.0022, costInr: 0.1947, unpriced: ['elevenlabs-tts:v3'],
      legs: [
        { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 4.2, outputUnits: 0, source: 'local' },
        { leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.8-flash@low', unit: 'tokens', inputUnits: 720, outputUnits: 230, thinkingTokens: 162, source: 'local' },
        { leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', inputUnits: 0, outputUnits: 156, audioSeconds: 6.1, source: 'local' },
      ] },
  ],
};

/** A realtime record billed in tokens, audio tokens broken out. */
export const REALTIME_SUMMARY: SessionSummary = {
  ...SYNTHETIC,
  recordId: 'rt-1',
  sessionId: 'sock-rt-1',
  mode: 'realtime',
  label: 'openai-realtime:gpt-realtime-2.1',
  config: { mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime-2.1', systemPrompt: '', turnDetection: 'server_vad' },
  unpriced: [],
  latency: { ttfaMedianMs: 700 },
  totals: [{ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', unit: 'tokens',
    inputUnits: 132, outputUnits: 121, audioInputTokens: 13, audioOutputTokens: 91, source: 'vendor' }],
  turns: [{ turnId: 1, at: NOW, costUsd: 0, costInr: 0, unpriced: [],
    legs: [{ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', unit: 'tokens',
      inputUnits: 132, outputUnits: 121, source: 'vendor' }] }],
};

/** Display names for the synthetic record's providers. */
export const namedProviders: ProviderEntry[] = [
  { id: 'sarvam-stt', name: 'Sarvam Saaras' },
  { id: 'google-llm', name: 'Google Gemini' },
  { id: 'murf-tts', name: 'Murf Falcon' },
  { id: 'openai-realtime', name: 'OpenAI Realtime' },
].map((p) => ({ ...p, kind: 'stt', implemented: true, registered: true, ready: true, envKeys: [], missingEnv: [], models: [] })) as ProviderEntry[];

/* ------------------------------ rig picker ------------------------------ */

export const pickerProviders: ProviderEntry[] = [
  { id: 'mock-stt', name: 'Mock (canned)', kind: 'stt', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'mock-asr', name: 'Canned transcript' }] },
  { id: 'mock-llm', name: 'Mock (echo)', kind: 'llm', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'mock-chat', name: 'Echo' }] },
  { id: 'sarvam-tts', name: 'Sarvam Bulbul', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: ['SARVAM_API_KEY'], missingEnv: [], models: [{ id: 'bulbul:v3', name: 'bulbul:v3' }],
    voices: [{ id: 'priya', name: 'Priya (f)' }], languages: [{ id: 'en-IN', name: 'English (India)' }] },
  { id: 'murf-tts', name: 'Murf Falcon', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: ['MURF_API_KEY'], missingEnv: [], acceptsVoiceId: true, voiceIdHint: 'Any Murf voice id.',
    models: [
      { id: 'falcon-2', name: 'falcon-2',
        voices: [{ id: 'en-US-natalie', name: 'Natalie (F) · en-US' }],
        languages: [{ id: 'en-US', name: 'English (en-US)' }] },
      { id: 'gen2', name: 'gen2',
        voices: [{ id: 'en-US-imani', name: 'Imani (F) · en-US' }],
        languages: [{ id: 'en-US', name: 'English (en-US)' }] },
    ] },
  { id: 'cartesia-tts', name: 'Cartesia Sonic', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: ['CARTESIA_API_KEY'], missingEnv: [], acceptsVoiceId: true,
    voicesByLanguage: {
      en: [{ id: 'skylar-id', name: 'Skylar (F)' }],
      hi: [{ id: 'aadhya-id', name: 'Aadhya (F)' }, { id: 'amrit-id', name: 'Amrit (M)' }],
    },
    models: [
      { id: 'sonic-3.6', name: 'sonic-3.6', languages: [{ id: 'en', name: 'English' }, { id: 'hi', name: 'Hindi' }] },
      { id: 'sonic-2', name: 'sonic-2', languages: [{ id: 'en', name: 'English' }] },
    ] },
];

export const novaProviders: ProviderEntry[] = [
  { id: 'aws-nova-sonic', name: 'AWS Nova Sonic', kind: 'realtime', implemented: true,
    registered: true, ready: true,
    envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], missingEnv: [],
    models: [{
      id: 'amazon.nova-2-sonic-v1:0', name: 'Nova 2 Sonic',
      languages: [
        { id: 'en-IN', name: 'English (India)', voices: [
          { id: 'kiara', name: 'Kiara (feminine)' },
          { id: 'tiffany', name: 'Tiffany (polyglot)' },
        ] },
        { id: 'fr-FR', name: 'French', voices: [
          { id: 'ambre', name: 'Ambre (feminine)' },
          { id: 'tiffany', name: 'Tiffany (polyglot)' },
        ] },
      ],
    }] },
];

export const openaiRealtime: ProviderEntry = {
  id: 'openai-realtime', name: 'OpenAI Realtime', kind: 'realtime', implemented: true,
  registered: true, ready: true, envKeys: [], missingEnv: [],
  models: [{ id: 'gpt-realtime-2.1', name: 'gpt-realtime-2.1' }],
  voices: [{ id: 'marin', name: 'Marin' }, { id: 'cedar', name: 'Cedar' }],
};

/** Every kind at once, so mode switches in the builder have somewhere to land. */
export const allProviders: ProviderEntry[] = [...pickerProviders, ...novaProviders, openaiRealtime];

export const novaRig: Rig = {
  ...blankRig('Rig N', 0),
  id: 'rig-n',
  mode: 'realtime',
  realtimeProviderId: 'aws-nova-sonic', realtimeModelId: 'amazon.nova-2-sonic-v1:0',
  language: 'en-IN', voice: 'kiara',
};

export const baseRig: Rig = {
  ...blankRig('Rig A', 0),
  id: 'rig-a',
  mode: 'pipeline',
  sttProviderId: 'mock-stt', sttModelId: 'mock-asr',
  llmProviderId: 'mock-llm', llmModelId: 'mock-chat',
  ttsProviderId: 'sarvam-tts', ttsModelId: 'bulbul:v3',
  voice: 'priya', ttsLanguage: 'en-IN',
};

export const murfRig: Rig = {
  ...baseRig,
  ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', voice: 'en-US-natalie', ttsLanguage: 'en-US',
};

export const cartesiaRig: Rig = {
  ...baseRig,
  ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', voice: 'skylar-id', ttsLanguage: 'en',
};

/* -------------------------------- turns -------------------------------- */

export const pipelineTurn: TurnRecord = {
  turnId: 1,
  label: 'sarvam → gemini → murf',
  clientTtfaMs: 612,
  marks: [
    { name: 'user_speech_end', atMs: 0 },
    { name: 'stt_final', atMs: 214 },
    { name: 'llm_request_sent', atMs: 216 },
    { name: 'llm_first_token', atMs: 362 },
    { name: 'tts_request_sent', atMs: 364 },
    { name: 'tts_first_audio', atMs: 548 },
    { name: 'first_audio_out', atMs: 549 },
  ],
  derived: { timeToFirstAudioMs: 548, sttLatencyMs: 214, llmTtftMs: 148, ttsTtfbMs: 186, totalTurnMs: 3277, audioDurationMs: 2740 },
};

export const slowTurn: TurnRecord = {
  ...pipelineTurn,
  turnId: 2,
  clientTtfaMs: 2184,
  derived: { ...pipelineTurn.derived, ttsTtfbMs: 1758, timeToFirstAudioMs: 2120, audioDurationMs: 2800 },
};

export const realtimeTurn: TurnRecord = {
  turnId: 3,
  label: 'openai-realtime',
  clientTtfaMs: 498,
  marks: [{ name: 'user_speech_end', atMs: 0 }, { name: 'first_audio_out', atMs: 441 }, { name: 'stt_final', atMs: 620 }],
  derived: { timeToFirstAudioMs: 441, sttLatencyMs: 620, totalTurnMs: 2701, audioDurationMs: 2260 },
};

/* --------------------------------- logs --------------------------------- */

export const logs: LogLine[] = [
  { at: NOW, level: 'info', message: 'session started', kind: 'log', source: 'session' },
  { at: NOW + 1, level: 'warn', message: 'turn 3 abandoned — banked audio handed to turn 4', kind: 'log', source: 'session' },
  { at: NOW + 2, level: 'error', message: 'no rate on file for groq-llm', kind: 'log', source: 'llm' },
  { at: NOW + 3, level: 'info', message: 'tts_request_sent', kind: 'mark', source: 'tts', turnId: 4, atMs: 364,
    detail: 'marked before open() — the handshake is inside the window' },
];

/* -------------------------------- session -------------------------------- */

/** A stand-in for `useVoiceSession()`'s return, every action a spy. */
export function makeSession(over: Partial<VoiceSessionHandle> = {}): VoiceSessionHandle {
  return {
    state: 'idle', label: '', sessionId: '', micOn: false, micLevel: 0, assistantSpeaking: false,
    utterances: [], turns: [], mode: undefined, usage: [], summary: null, logs: [],
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), endConversation: vi.fn(async () => {}),
    startMic: vi.fn(async () => {}), stopMic: vi.fn(async () => {}), sendText: vi.fn(), commitAudio: vi.fn(), interrupt: vi.fn(),
    ...over,
  };
}

/* ---------------------------- voice-stack export ---------------------------- */

export const stackProviders: ProviderEntry[] = [
  { id: 'sarvam-stt', name: 'Sarvam Saaras', kind: 'stt', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [],
    models: [{ id: 'saaras:v3-realtime@fast', name: 'saaras:v3-realtime (fast)' }, { id: 'saaras:v3-realtime@turbo', name: 'bogus variant' }],
    languages: [{ id: 'auto', name: 'Auto-detect' }, { id: 'hi-IN', name: 'Hindi' }, { id: 'or-IN', name: 'Odia' }, { id: 'ta-IN', name: 'Tamil' }] },
  { id: 'google-llm', name: 'Google Gemini', kind: 'llm', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'gemini-3.1-flash-lite@minimal', name: 'gemini-3.1-flash-lite (minimal)' }] },
  { id: 'groq-llm', name: 'Groq', kind: 'llm', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'llama-3.3-70b', name: 'llama' }] },
  { id: 'sarvam-tts', name: 'Sarvam Bulbul', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'bulbul:v3', name: 'bulbul:v3' }],
    languages: [{ id: 'hi-IN', name: 'Hindi' }, { id: 'od-IN', name: 'Odia' }, { id: 'en-IN', name: 'English (India)' }],
    voices: [{ id: 'shubh', name: 'Shubh (m)' }, { id: 'pooja', name: 'Pooja (f)' }] },
  { id: 'mock-tts', name: 'Mock (tone)', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'mock-voice', name: 'tone' }], voices: [{ id: 'beep', name: 'Beep' }] },
  { id: 'openai-realtime', name: 'OpenAI Realtime', kind: 'realtime', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'gpt-realtime', name: 'gpt-realtime' }], voices: [{ id: 'marin', name: 'Marin' }] },
];

/** The same TTS leg on a vendor that takes typed ids. */
export const idProviders: ProviderEntry[] = stackProviders.map((p) => (p.id === 'sarvam-tts' ? { ...p, acceptsVoiceId: true } : p));

export const stackRig: Rig = {
  ...blankRig('Hindi collections', 0),
  id: 'rig-stack',
  sttProviderId: 'sarvam-stt', sttModelId: 'saaras:v3-realtime@fast', sttLanguage: 'auto',
  llmProviderId: 'google-llm', llmModelId: 'gemini-3.1-flash-lite@minimal',
  ttsProviderId: 'sarvam-tts', ttsModelId: 'bulbul:v3', ttsLanguage: 'hi-IN', voice: 'pooja',
};

/** The backend's own digest, not the export's — so a match is cross-implementation evidence. */
export const backendSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const stackPrompt = 'You are a polite collections agent. नमस्ते से शुरू करें।';

const stackConfig = (over: Partial<StartConfig>): Omit<StartConfig, 'systemPrompt'> => ({
  mode: 'pipeline', turnDetection: 'server_vad',
  sttProviderId: stackRig.sttProviderId, sttModelId: stackRig.sttModelId, sttLanguage: 'auto',
  llmProviderId: stackRig.llmProviderId, llmModelId: stackRig.llmModelId,
  ttsProviderId: stackRig.ttsProviderId, ttsModelId: stackRig.ttsModelId, ttsLanguage: 'hi-IN', voice: 'pooja', ...over,
});

const indexRow = (over: Partial<SessionIndexEntry>): SessionIndexEntry => ({
  recordId: 'x', label: 'x', mode: 'pipeline', startedAt: 1, endedAt: 2, turnCount: 3, costUsd: 0, costInr: 0, unpriced: [],
  promptSha256: backendSha(stackPrompt), config: stackConfig({}), ...over,
});

export const stackSessions: SessionIndexEntry[] = [
  indexRow({ recordId: 'rec-hi-1', startedAt: 2_000, endedAt: 62_000, turnCount: 4, costUsd: 0.02, costInr: 1.8,
    durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 900, ttfaP95Ms: 1400 } }),
  indexRow({ recordId: 'rec-or-1', startedAt: 1_000, endedAt: 61_000, turnCount: 2, costUsd: 0.01, costInr: 0.9,
    unpriced: ['x'], durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 1100, ttfaP95Ms: 1600 },
    config: stackConfig({ sttLanguage: 'or-IN', ttsLanguage: 'od-IN', voice: 'shubh' }) }),
  indexRow({ recordId: 'rec-hi-open-tab', startedAt: 1_500, endedAt: 3_601_500, turnCount: 3, costUsd: 0.5, costInr: 45,
    durationMs: 3_600_000, latency: { ttfaMedianMs: 1000, ttfaP95Ms: 1500 } }),
  indexRow({ recordId: 'rec-hi-shubh', startedAt: 6_000, costUsd: 0.4, costInr: 36, durationMs: 60_000, speechSeconds: 30,
    latency: { ttfaMedianMs: 9000, ttfaP95Ms: 9900 }, config: stackConfig({ voice: 'shubh' }) }),
  indexRow({ recordId: 'rec-other-prompt', startedAt: 7_000, costUsd: 0.4, costInr: 36, durationMs: 60_000, speechSeconds: 30,
    latency: { ttfaMedianMs: 7000, ttfaP95Ms: 7700 }, promptSha256: backendSha('Reply in one short sentence.') }),
  indexRow({ recordId: 'rec-unhashed', startedAt: 8_000, costUsd: 0.4, costInr: 36, durationMs: 60_000,
    latency: { ttfaMedianMs: 8000, ttfaP95Ms: 8800 }, promptSha256: undefined }),
  indexRow({ recordId: 'rec-other-llm', startedAt: 3_000, endedAt: 9_000, costUsd: 0.5, costInr: 45, durationMs: 6_000,
    latency: { ttfaMedianMs: 5000 }, config: stackConfig({ llmModelId: 'gemini-3.1-flash-lite@high' }) }),
  { recordId: 'rec-legacy', label: 'x', mode: 'pipeline', startedAt: 4_000, endedAt: 9_000, turnCount: 3,
    costUsd: 0, costInr: 0, unpriced: [] },
  indexRow({ recordId: 'rec-manual-turns', startedAt: 5_000, endedAt: 65_000, turnCount: 5, costUsd: 0.9, costInr: 80,
    durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 4000, ttfaP95Ms: 6000 },
    config: stackConfig({ turnDetection: 'manual' }) }),
];

export const hiOr: ExportLanguage[] = [
  { code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' },
  { code: 'or', sttLang: 'or-IN', ttsLang: 'od-IN', voice: 'shubh' },
];

export const STACK_CODE = /mvs1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}/;

/* ------------------------------ runs index ------------------------------ */

export const indexEntry = (recordId: string, over: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
  recordId, label: SYNTHETIC.label, mode: 'pipeline', startedAt: SYNTHETIC.startedAt, endedAt: SYNTHETIC.endedAt,
  turnCount: 4, costUsd: 0.02, costInr: 1.8, unpriced: [], latency: SYNTHETIC.latency, ...over,
});

export const runRows: SessionIndexEntry[] = [
  indexEntry('real-a', { unpriced: ['elevenlabs-tts:v3'], config: { mode: 'pipeline', turnDetection: 'server_vad', ttsLanguage: 'hi' } }),
  indexEntry('rt-b', { mode: 'realtime', label: 'openai-realtime:gpt-realtime-2.1-mini', turnCount: 1,
    latency: { ...SYNTHETIC.latency, ttfaMedianMs: 1070, ttfaP95Ms: 1070 } }),
  indexEntry('mock-c', { label: 'mock-stt:mock-asr → mock-llm:mock-echo → mock-tts:mock-tone' }),
  indexEntry('old-d', { latency: undefined, turnCount: 0, costUsd: 0 }),
];

/* -------------------------------- fetch -------------------------------- */

export interface FakeResponseInit {
  status?: number;
  body?: unknown;
  /** Make `.json()` reject, the way a non-JSON body would. */
  badJson?: boolean;
}

/** A minimal Response: only what `lib/auth` and the pages read. */
export function fakeResponse({ status = 200, body = {}, badJson = false }: FakeResponseInit = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (badJson) throw new SyntaxError('Unexpected token');
      return structuredClone(body);
    },
  } as unknown as Response;
}

export type Route = (url: string, init?: RequestInit) => FakeResponseInit | undefined | Promise<FakeResponseInit | undefined>;

/**
 * A `fetch` stub dispatching on the URL. A route returning undefined falls
 * through to a 404, so an unexpected request shows up as a failure, not a hang.
 */
export function routedFetch(route: Route) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await route(url, init);
    return fakeResponse(res ?? { status: 404, body: { error: `no route for ${url}` } });
  });
}

/** Turn usage rows shaped like a realtime mock session, seconds-metered. */
export const realtimeSecondsUsage: TurnUsage[] = [{
  turnId: 1, at: NOW, costUsd: 0, costInr: 0, unpriced: [],
  legs: [{ leg: 'realtime', providerId: 'mock-realtime', modelId: 'mock-s2s',
    unit: 'audio_seconds', inputUnits: 2, outputUnits: 4, source: 'local' }],
}];
