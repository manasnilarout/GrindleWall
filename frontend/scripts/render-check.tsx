/**
 * Renders the new usage panels against a real persisted session record.
 *
 * `tsc` did not catch the last UI crash in this project (a concise-arrow
 * useEffect returning a value), so type-checking alone is not evidence that a
 * component renders. This actually runs them.
 */
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import type { SessionSummary } from '../src/lib/protocol';
import App from '../src/App';
import { SessionReport } from '../src/components/SessionReport';
import { UsagePanel } from '../src/components/UsagePanel';
import { ComparePage } from '../src/components/ComparePage';
import { Console } from '../src/components/Console';
import { InsightsPanel, CostPanel } from '../src/components/InsightsPanel';
import { RigBuilder } from '../src/components/RigBuilder';
import { RigRail } from '../src/components/RigRail';
import { RigTabs } from '../src/components/RigTabs';
import { Transcript } from '../src/components/Transcript';
import { TurnsPanel } from '../src/components/TurnsPanel';
import { languagesFor, resolveVoice, voicesFor, type ProviderEntry } from '../src/lib/catalog';
import { bandsOf, legMediansOf } from '../src/lib/legs';
import { sourceOfMessage } from '../src/lib/logsource';
import { summarize } from '../src/lib/stats';
import { claimTtfa, type TurnRecord, type LogLine } from '../src/hooks/useVoiceSession';
import {
  blankRig, envCommandOf, seedRigs, slotsOf, startConfigOf, withDefaults,
  switchMode, switchProvider, switchSttModel, switchVoicedLanguage, switchVoicedModel,
  type Rig,
} from '../src/lib/rigs';
import { normalizeSummary } from '../src/lib/session';


/** Covers the branches a mock-only session would not: rupees, thinking, unpriced. */
const SYNTHETIC: SessionSummary = {
  recordId: 'synthetic',
  sessionId: 'synthetic',
  mode: 'pipeline',
  label: 'sarvam-stt:saaras:v3-realtime@fast \u2192 google-llm:gemini-3.8-flash@low \u2192 murf-tts:falcon-2',
  config: { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' },
  startedAt: Date.now() - 62_000,
  endedAt: Date.now(),
  durationMs: 62_000,
  turnCount: 2,
  costUsd: 0.0041,
  costInr: 0.3628,
  unpriced: ['elevenlabs-tts:v3'],
  usdPerInr: 0.0113,
  latency: {
    ttfaMedianMs: 812, ttfaP95Ms: 1403, ttfaMinMs: 640, ttfaMaxMs: 1403,
    // Deliberately summing to MORE than ttfaMedianMs: the legs overlap, and a
    // fixture that quietly added up to the turn would let a stacked chart back
    // in without failing anything.
    sttMedianMs: 214, llmTtftMedianMs: 486, ttsTtfbMedianMs: 640,
    totalTurnMedianMs: 3120, audioMedianMs: 2740,
  },
  totals: [
    { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds',
      inputUnits: 7.4, outputUnits: 0, source: 'local',
      cost: { amount: 0.0617, currency: 'INR', amountUsd: 0.0007, amountInr: 0.0617, rate: '\u20b930 per hour of audio', confidence: 'verified' } },
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
    { turnId: 1, at: Date.now() - 40_000, costUsd: 0.0019, costInr: 0.1681, unpriced: [],
      legs: [
        { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 3.2, outputUnits: 0, source: 'local' },
        { leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.8-flash@low', unit: 'tokens', inputUnits: 520, outputUnits: 180, thinkingTokens: 140, source: 'vendor' },
        { leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', inputUnits: 0, outputUnits: 140, audioSeconds: 5.1, source: 'local' },
      ] },
    { turnId: 2, at: Date.now() - 10_000, costUsd: 0.0022, costInr: 0.1947, unpriced: ['elevenlabs-tts:v3'],
      legs: [
        { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 4.2, outputUnits: 0, source: 'local' },
        { leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.8-flash@low', unit: 'tokens', inputUnits: 720, outputUnits: 230, thinkingTokens: 162, source: 'local' },
        { leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', inputUnits: 0, outputUnits: 156, audioSeconds: 6.1, source: 'local' },
      ] },
  ],
};

/**
 * Renders a real session record when one is passed, and a synthetic one that
 * exercises every branch — rupee costs, thinking tokens, an unpriced leg —
 * when it is not, so the check runs with no prior conversation on disk.
 */
const summary: SessionSummary = process.argv[2]
  ? (JSON.parse(readFileSync(process.argv[2], 'utf8')) as SessionSummary)
  : SYNTHETIC;

let failed = 0;
const check = (name: string, fn: () => string, mustContain: string[]) => {
  try {
    const html = fn();
    const missing = mustContain.filter((s) => !html.includes(s));
    if (missing.length) {
      console.log(`  FAIL ${name}: rendered but missing ${JSON.stringify(missing)}`);
      failed += 1;
    } else {
      console.log(`  ok   ${name} (${html.length} chars)`);
    }
  } catch (err) {
    console.log(`  FAIL ${name}: threw ${(err as Error).message}`);
    failed += 1;
  }
};

console.log(`\nrendering against ${summary.recordId} (${summary.turnCount} turn, $${summary.costUsd})`);

check('SessionReport', () => renderToString(h(SessionReport, { summary })), [
  'Conversation report',
  summary.label,
  'Per leg',
  'Per turn',
]);

// The INR columns were silently empty for a while because the fixture omitted
// the fields and `scripts` was outside tsconfig. Assert on real rupee values.
check('SessionReport shows both currencies', () => renderToString(h(SessionReport, { summary })), [
  '₹',
  '$',
  'per $1',
]);

check('SessionReport uses a custom title for archived records', () =>
  renderToString(h(SessionReport, { summary, title: 'Past conversation' })), ['Past conversation']);

check('SessionReport with dismiss', () => renderToString(h(SessionReport, { summary, onDismiss: () => {} })), ['dismiss']);

check('UsagePanel (pipeline)', () => renderToString(h(UsagePanel, { usage: summary.turns })), [
  'LLM in',
  'TTS chars',
]);

check('UsagePanel (empty)', () => renderToString(h(UsagePanel, { usage: [] })), ['nothing was consumed']);
check('UsagePanel (empty, compact) draws no heading of its own', () => {
  const html = renderToString(h(UsagePanel, { usage: [], compact: true }));
  if (html.includes('<h2>')) throw new Error('compact empty state still renders its own heading');
  return html;
}, ['nothing was consumed']);

// A realtime leg is metered in whatever unit its vendor bills: the mock counts
// seconds of audio, OpenAI counts tokens. The table used to hardcode an "s"
// suffix, which rendered 132 tokens as "132.0s" — a plausible-looking number
// that is wrong by the token/second ratio. Both shapes are rendered here so the
// suffix can never drift back to a constant.
check('UsagePanel (realtime shape, seconds-metered)', () =>
  renderToString(h(UsagePanel, {
    usage: [{
      turnId: 1, at: Date.now(), costUsd: 0, costInr: 0, unpriced: [],
      legs: [{ leg: 'realtime' as const, providerId: 'mock-realtime', modelId: 'mock-s2s',
        unit: 'audio_seconds' as const, inputUnits: 2, outputUnits: 4, source: 'local' as const }],
    }],
  })), ['2 s audio', '4 s audio']);

check('UsagePanel (realtime shape, token-metered) labels tokens as tokens', () => {
  const html = renderToString(h(UsagePanel, {
    usage: [{
      turnId: 1, at: Date.now(), costUsd: 0.0572, costInr: 5.4, unpriced: [],
      legs: [{ leg: 'realtime' as const, providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1',
        unit: 'tokens' as const, inputUnits: 132, outputUnits: 121,
        audioInputTokens: 13, audioOutputTokens: 91, cachedInputTokens: 64,
        audioSeconds: 5.2, source: 'vendor' as const }],
    }],
  }));
  // The specific regression: a token count wearing a seconds suffix.
  if (/13[12](\.0)?s/.test(html)) throw new Error('token count rendered with a seconds suffix');
  return html;
}, ['132 tokens', '121 tokens', '5.2s']);

check('UsagePanel with an unpriced leg', () =>
  renderToString(h(UsagePanel, {
    usage: [{
      turnId: 1, at: Date.now(), costUsd: 0, costInr: 0, unpriced: ['elevenlabs-tts:v3'],
      legs: [{ leg: 'tts' as const, providerId: 'elevenlabs-tts', modelId: 'v3',
        unit: 'characters' as const, inputUnits: 0, outputUnits: 100, source: 'local' as const,
        unpricedReason: 'No rate on file' }],
    }],
  })), ['floor, not a bill']);

// The architecture toggle shares one `voice` field between the realtime provider
// and the TTS leg. Carrying it across un-resolved handed one vendor another's
// id — a Cartesia UUID to OpenAI Realtime, `marin` to ElevenLabs' voice_id path
// segment — which is a 400 the user cannot explain. These pin the rule that
// stops it, against the real catalog shapes.
{
  const catalog: ProviderEntry[] = [
    { id: 'openai-realtime', name: 'OpenAI Realtime', kind: 'realtime', implemented: true, envKeys: [],
      registered: true, ready: true, missingEnv: [],
      models: [{ id: 'gpt-realtime-2.1', name: 'gpt-realtime-2.1' }],
      voices: [{ id: 'marin', name: 'Marin' }, { id: 'cedar', name: 'Cedar' }] },
    { id: 'elevenlabs-tts', name: 'ElevenLabs', kind: 'tts', implemented: true, envKeys: [],
      registered: true, ready: true, missingEnv: [],
      models: [{ id: 'eleven_flash_v2_5', name: 'eleven_flash_v2_5' }],
      voices: [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }] },
  ];
  const cases: Array<[string, string, string]> = [
    // a realtime voice must not survive into the ElevenLabs leg
    ['elevenlabs-tts', 'marin', 'JBFqnCBsd6RMkjVDRZzb'],
    // …nor an ElevenLabs id into the realtime one
    ['openai-realtime', 'JBFqnCBsd6RMkjVDRZzb', 'marin'],
    // a voice the target provider does offer is kept
    ['openai-realtime', 'cedar', 'cedar'],
  ];
  for (const [providerId, from, expected] of cases) {
    const model = catalog.find((p) => p.id === providerId)!.models[0].id;
    const got = resolveVoice(catalog, providerId, model, '', from);
    check(`resolveVoice: ${providerId} given "${from}" -> "${expected}"`,
      () => (got === expected ? got : (() => { throw new Error(`got "${got}"`); })()), [expected]);
  }
}

check('ComparePage (pre-fetch)', () => renderToString(h(ComparePage, { onOpenReport: () => {} })), [
  'Runs on disk',
  'Nothing recorded yet',
]);

/* --------------------------- the rig builder --------------------------- */
// The voice row has three shapes: a list alone, a list plus a free-text voice
// id, and one where a typed id has taken over. All three render here.
const pickerProviders: ProviderEntry[] = [
  { id: 'mock-stt', name: 'Mock (canned)', kind: 'stt', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'mock-asr', name: 'Canned transcript' }] },
  { id: 'mock-llm', name: 'Mock (echo)', kind: 'llm', implemented: true, registered: true, ready: true,
    envKeys: [], missingEnv: [], models: [{ id: 'mock-chat', name: 'Echo' }] },
  { id: 'sarvam-tts', name: 'Sarvam Bulbul', kind: 'tts', implemented: true, registered: true, ready: true,
    envKeys: ['SARVAM_API_KEY'], missingEnv: [], models: [{ id: 'bulbul:v3', name: 'bulbul:v3' }],
    voices: [{ id: 'anushka', name: 'Anushka (f)' }], languages: [{ id: 'en-IN', name: 'English (India)' }] },
  // The Murf shape: each model brings its own voice and language list.
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
];

// The Cartesia shape: voices filed under the language, languages under the model.
pickerProviders.push({
  id: 'cartesia-tts', name: 'Cartesia Sonic', kind: 'tts', implemented: true, registered: true, ready: true,
  envKeys: ['CARTESIA_API_KEY'], missingEnv: [], acceptsVoiceId: true,
  // Voices live once on the provider and the models name only their languages —
  // the shape /api/catalog actually serves, so the library travels once.
  voicesByLanguage: {
    en: [{ id: 'skylar-id', name: 'Skylar (F)' }],
    hi: [{ id: 'aadhya-id', name: 'Aadhya (F)' }, { id: 'amrit-id', name: 'Amrit (M)' }],
  },
  models: [
    { id: 'sonic-3.6', name: 'sonic-3.6', languages: [{ id: 'en', name: 'English' }, { id: 'hi', name: 'Hindi' }] },
    { id: 'sonic-2', name: 'sonic-2', languages: [{ id: 'en', name: 'English' }] },
  ],
});

const baseRig: Rig = {
  ...blankRig('Rig A', 0),
  mode: 'pipeline',
  sttProviderId: 'mock-stt', sttModelId: 'mock-asr',
  llmProviderId: 'mock-llm', llmModelId: 'mock-chat',
  ttsProviderId: 'sarvam-tts', ttsModelId: 'bulbul:v3',
  voice: 'anushka', ttsLanguage: 'en-IN',
};
const murfRig: Rig = {
  ...baseRig,
  ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', voice: 'en-US-natalie', ttsLanguage: 'en-US',
};
const picker = (rig: Rig) =>
  renderToString(h(RigBuilder, { providers: pickerProviders, rig, onChange: () => {}, onClose: () => {}, disabled: false }));

check('RigBuilder: a vendor with only a voice list', () => picker(baseRig), ['Voice', 'Anushka (f)']);
// The drawer is a modal: the dialog role belongs on the panel, not the scrim,
// or assistive tech announces the backdrop as the dialog.
check('RigBuilder marks the panel as the dialog, not the scrim', () => {
  const html = picker(baseRig);
  if (/class="drawer-scrim"[^>]*role="dialog"/.test(html)) throw new Error('the scrim is still the dialog');
  if (!/class="drawer"[^>]*role="dialog"/.test(html)) throw new Error('the panel is not a dialog');
  return html;
}, ['aria-modal="true"']);
// Every other field in the app is a <label>; the voice search was a bare div,
// leaving its input with no accessible name.
check('RigBuilder: every field control has a label', () => {
  const html = renderToString(h(RigBuilder, {
    providers: pickerProviders, rig: baseRig, onChange: () => {}, onClose: () => {}, disabled: false,
  }));
  if (/<div class="field"/.test(html)) throw new Error('a field is a div, so its control has no accessible name');
  return html;
}, ['<label class="field"']);
check('RigBuilder: a vendor that also takes a voice id', () => picker(murfRig),
  ['Voice id', 'Any Murf voice id.', 'Natalie (F) · en-US']);
check('RigBuilder: a typed voice id takes over the list', () =>
  picker({ ...murfRig, customVoiceId: 'en-IN-aarav' }), ['overridden by the voice id', 'disabled']);
// Readiness is on the chip now, not buried in <option> text nobody reads.
check('RigBuilder: an unregistered provider is unpickable and says why', () => {
  const withGap = [...pickerProviders, {
    id: 'deepgram-tts', name: 'Deepgram Aura', kind: 'tts' as const, implemented: false,
    registered: false, ready: false, envKeys: ['DEEPGRAM_API_KEY'], missingEnv: ['DEEPGRAM_API_KEY'],
    models: [{ id: 'aura-2', name: 'aura-2' }],
  }];
  return renderToString(h(RigBuilder, { providers: withGap, rig: baseRig, onChange: () => {}, onClose: () => {}, disabled: false }));
}, ['Deepgram Aura', 'disabled']);
const cartesiaRig: Rig = {
  ...baseRig,
  ttsProviderId: 'cartesia-tts', ttsModelId: 'sonic-3.6', voice: 'skylar-id', ttsLanguage: 'en',
};
// Picking Hindi is what makes the Hindi voices the list — the whole point of
// filing 934 voices under a language.
check('RigBuilder: voices follow the selected language', () => {
  const html = picker({ ...cartesiaRig, ttsLanguage: 'hi', voice: 'aadhya-id' });
  if (html.includes('Skylar')) throw new Error('English voice offered under Hindi');
  return html;
}, ['Aadhya (F)', 'Amrit (M)', 'Hindi']);
// sonic-2 does not accept Hindi at all, so the language must not be offered.
check('RigBuilder: languages follow the selected model', () => {
  const html = picker({ ...cartesiaRig, ttsModelId: 'sonic-2' });
  if (html.includes('Hindi')) throw new Error('a language the model refuses was offered');
  return html;
}, ['English', 'Skylar (F)']);

// Two models of one provider, two voice catalogues: the other model's voice must
// not be offered, because the vendor rejects it outright.
check('RigBuilder: voices follow the selected model', () => {
  const html = picker({ ...murfRig, ttsModelId: 'gen2', voice: 'en-US-imani' });
  if (html.includes('en-US-natalie')) throw new Error('falcon voice offered under gen2');
  return html;
}, ['en-US-imani']);

/*
 * A typed voice id outlives the dropdown by design — `startConfigOf` prefers it
 * — so every transition that changes which catalogue is in force must clear it.
 * Murf keeps a voice catalogue per MODEL and rejects the other model's voice
 * outright, so a Falcon id surviving into gen2 is a guaranteed vendor error,
 * sent while the picker displays a different, valid voice.
 */
{
  const typed: Rig = { ...murfRig, customVoiceId: 'en-IN-aarav' };
  for (const [name, next] of [
    ['a model switch', switchVoicedModel(typed, pickerProviders, 'tts', 'gen2')],
    ['a language switch', switchVoicedLanguage(typed, pickerProviders, 'tts', 'en-US')],
    ['a provider switch', switchProvider(typed, pickerProviders, 'tts', 'sarvam-tts')],
    ['an architecture switch', switchMode(typed, pickerProviders, 'realtime')],
  ] as Array<[string, Rig]>) {
    check(`a typed voice id does not survive ${name}`, () => {
      if (next.customVoiceId !== '') throw new Error(`survived as "${next.customVoiceId}"`);
      return 'cleared';
    }, ['cleared']);
  }

  // …and the dropdown voice is re-resolved to one the new model actually offers.
  check('a model switch re-resolves the voice to the new model catalogue', () => {
    const next = switchVoicedModel(murfRig, pickerProviders, 'tts', 'gen2');
    if (next.voice === 'en-US-natalie') throw new Error("falcon's voice survived into gen2");
    return next.voice;
  }, ['en-US-imani']);

  // The STT leg has no voice, but its language must still be valid for the model.
  check('an STT model switch keeps a language the model accepts', () => {
    const next = switchSttModel(baseRig, pickerProviders, 'mock-asr');
    const allowed = languagesFor(pickerProviders, next.sttProviderId, next.sttModelId).map((l) => l.id);
    if (allowed.length && !allowed.includes(next.sttLanguage)) throw new Error(`kept ${next.sttLanguage}`);
    return 'valid';
  }, ['valid']);

  // The architecture toggle is the one that used to hand a Cartesia UUID to
  // OpenAI Realtime, and `marin` to ElevenLabs' voice_id path segment.
  check('an architecture switch re-resolves the voice to the owning provider', () => {
    const rt: Rig = { ...baseRig, mode: 'pipeline', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime-2.1', voice: 'anushka' };
    const withRealtime = [...pickerProviders, {
      id: 'openai-realtime', name: 'OpenAI Realtime', kind: 'realtime' as const, implemented: true,
      registered: true, ready: true, envKeys: [], missingEnv: [],
      models: [{ id: 'gpt-realtime-2.1', name: 'gpt-realtime-2.1' }],
      voices: [{ id: 'marin', name: 'Marin' }],
    }];
    const next = switchMode(rt, withRealtime, 'realtime');
    if (next.voice === 'anushka') throw new Error("a Sarvam voice survived into OpenAI Realtime");
    return next.voice;
  }, ['marin']);
}

// Records are read back from disk and may be truncated, hand-edited, or written
// by an older build. Every one of these used to blank the page.
for (const [name, partial] of [
  ['empty object', {}],
  ['no totals', { ...summary, totals: undefined }],
  ['no turns', { ...summary, turns: undefined }],
  ['no unpriced', { ...summary, unpriced: undefined }],
  ['no latency', { ...summary, latency: undefined }],
  ['no usdPerInr', { ...summary, usdPerInr: undefined }],
  ['no costInr (pre-INR record)', { ...summary, costInr: undefined }],
  ['a turn with no legs', { ...summary, turns: [{ turnId: 1, at: 0, costUsd: 0, unpriced: [] }] }],
] as Array<[string, unknown]>) {
  check(`survives a record with ${name}`, () =>
    renderToString(h(SessionReport, { summary: normalizeSummary(partial) })), ['Per leg']);
}

check('a normalised record never prints NaN', () =>
  renderToString(h(SessionReport, { summary: normalizeSummary({}) })), ['per $1']);
if (renderToString(h(SessionReport, { summary: normalizeSummary({}) })).includes('NaN')) {
  console.log('  FAIL a normalised record never prints NaN: found NaN in the output');
  failed += 1;
}


/* ------------------------- the redesigned bench ------------------------- */

/**
 * A pipeline turn and a realtime turn. The realtime one is the interesting
 * fixture: it has no STT or LLM mark at all, because a speech-to-speech model
 * is one opaque leg — and the waterfall must render that as one band rather
 * than three zeroes.
 */
const pipelineTurn: TurnRecord = {
  turnId: 1,
  label: 'sarvam \u2192 gemini \u2192 murf',
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
const slowTurn: TurnRecord = {
  ...pipelineTurn,
  turnId: 2,
  clientTtfaMs: 2184,
  derived: { ...pipelineTurn.derived, ttsTtfbMs: 1758, timeToFirstAudioMs: 2120, audioDurationMs: 2800 },
};
const realtimeTurn: TurnRecord = {
  turnId: 3,
  label: 'openai-realtime',
  clientTtfaMs: 498,
  marks: [{ name: 'user_speech_end', atMs: 0 }, { name: 'first_audio_out', atMs: 441 }],
  derived: { timeToFirstAudioMs: 441, ttsTtfbMs: 441, totalTurnMs: 2701, audioDurationMs: 2260 },
};

check('TurnsPanel (pipeline turns)', () =>
  renderToString(h(TurnsPanel, { turns: [pipelineTurn, slowTurn], usage: summary.turns })),
  ['Turns', 'STT', 'LLM TTFT', 'TTS TTFB', 'different clock on a different origin']);

check('TurnsPanel (no turns yet)', () => renderToString(h(TurnsPanel, { turns: [], usage: [] })),
  ['Complete a turn']);

// A realtime turn has nothing to split. Three zero-width bands would read as
// three vendors that each answered instantly, which is the opposite of true.
check('Waterfall: a realtime turn draws one band, not three empty ones', () => {
  const html = renderToString(h(TurnsPanel, { turns: [realtimeTurn], usage: [] }));
  if (/width:\s*0(\.0+)?%/.test(html)) throw new Error('an unmeasured leg was drawn as a zero-width band');
  return html;
}, ['Turns']);

check('InsightsPanel', () => renderToString(h(InsightsPanel, { turns: [pipelineTurn, slowTurn] })),
  ['Time to first audio', 'p95', 'jitter', 'slowest leg', 'do not add up to the turn']);
check('InsightsPanel (no turns)', () => renderToString(h(InsightsPanel, { turns: [] })), ['Complete a turn']);
check('InsightsPanel (realtime, one band)', () => renderToString(h(InsightsPanel, { turns: [realtimeTurn] })),
  ['Time to first audio']);

check('CostPanel', () => renderToString(h(CostPanel, { usage: summary.turns })), ['/ turn', 'per month']);
check('CostPanel (empty)', () => renderToString(h(CostPanel, { usage: [] })), ['nothing was consumed']);
check('CostPanel names an unpriced leg as a floor', () =>
  renderToString(h(CostPanel, {
    usage: [{ turnId: 1, at: Date.now(), costUsd: 0, costInr: 0, unpriced: ['groq-llm:llama'],
      legs: [{ leg: 'llm' as const, providerId: 'groq-llm', modelId: 'llama', unit: 'tokens' as const,
        inputUnits: 10, outputUnits: 4, source: 'local' as const, unpricedReason: 'no rate' }] }],
  })), ['floor, not a bill']);

const logs: LogLine[] = [
  { at: Date.now(), level: 'info', message: 'session started', kind: 'log', source: 'session' },
  { at: Date.now(), level: 'warn', message: 'turn 3 abandoned \u2014 banked audio handed to turn 4', kind: 'log', source: 'session' },
  { at: Date.now(), level: 'error', message: 'no rate on file for groq-llm', kind: 'log', source: 'llm' },
  { at: Date.now(), level: 'info', message: 'tts_request_sent', kind: 'mark', source: 'tts', turnId: 4, atMs: 364,
    detail: 'marked before open() \u2014 the handshake is inside the window' },
];
check('Console (docked)', () => renderToString(h(Console, { logs, expanded: false, onToggleExpand: () => {} })),
  ['Console', 'info', 'warn', 'error', 'tts_request_sent']);
// Every line is expandable, so every line has to be reachable without a mouse.
check('Console lines are buttons, not click-handled divs', () => {
  const html = renderToString(h(Console, { logs, expanded: false, onToggleExpand: () => {} }));
  if (/<div[^>]*class="log-line/.test(html)) throw new Error('a log line is a div with a click handler');
  if (!/<button[^>]*class="log-line/.test(html)) throw new Error('log lines are not buttons');
  return html;
}, ['aria-expanded']);
check('Console (expanded, with the source rail)', () =>
  renderToString(h(Console, { logs, expanded: true, onToggleExpand: () => {} })),
  ['Sources', 'guessed', 'Filter by it']);
// Browser-origin lines never passed through redactSecrets; claiming otherwise
// tells a reader that pasting console output is unconditionally safe.
check('Console does not claim every line was scrubbed server-side', () => {
  const html = renderToString(h(Console, { logs, expanded: true, onToggleExpand: () => {} }));
  if (/Everything here was scrubbed/.test(html)) throw new Error('the blanket scrubbing claim is back');
  return html;
}, ['never went through it']);
check('Console (empty)', () => renderToString(h(Console, { logs: [], expanded: false, onToggleExpand: () => {} })),
  ['Quiet']);

check('Transcript', () => renderToString(h(Transcript, {
  utterances: [{ role: 'user' as const, text: 'hello', final: true }, { role: 'assistant' as const, text: 'hi', final: false }],
  speaking: true,
})), ['hello', 'hi']);

check('RigTabs', () => renderToString(h(RigTabs, {
  rigs: [baseRig, { ...murfRig, id: 'r2', name: 'Rig B', colorIndex: 1 }],
  activeId: baseRig.id,
  scores: { [baseRig.id]: { ttfaMedianMs: 612, turns: 4 } },
  locked: false,
  onSelect: () => {}, onAdd: () => {}, onCompare: () => {},
})), ['Rig A', 'Rig B', '612 ms', 'Compare runs']);

check('RigTabs locks the other tabs during a live session', () => {
  const html = renderToString(h(RigTabs, {
    rigs: [baseRig, { ...murfRig, id: 'r2', name: 'Rig B', colorIndex: 1 }],
    activeId: baseRig.id, scores: {}, locked: true,
    onSelect: () => {}, onAdd: () => {}, onCompare: () => {},
  }));
  if (!html.includes('disabled')) throw new Error('a rig was switchable mid-session');
  return html;
}, ['End the conversation to switch rig']);

check('RigRail', () => renderToString(h(RigRail, {
  rig: baseRig, providers: pickerProviders, systemPrompt: 'Be brief.', turns: [pipelineTurn], locked: false, canDelete: true,
  onEdit: () => {}, onRename: () => {}, onDelete: () => {},
})), ['Rig', 'Mock (canned)', 'bulbul:v3', 'STT=mock-stt', '214 ms']);

// A leg whose key is missing has to say so on the rail, not at connect time.
check('RigRail surfaces a missing key', () => renderToString(h(RigRail, {
  rig: { ...baseRig, llmProviderId: 'groq-llm', llmModelId: 'llama-3.3-70b' },
  providers: [...pickerProviders, {
    id: 'groq-llm', name: 'Groq', kind: 'llm' as const, implemented: true, registered: true, ready: false,
    envKeys: ['GROQ_API_KEY'], missingEnv: ['GROQ_API_KEY'], models: [{ id: 'llama-3.3-70b', name: 'llama' }],
  }],
  systemPrompt: 'Be brief.', turns: [], locked: false, canDelete: false,
  onEdit: () => {}, onRename: () => {}, onDelete: () => {},
})), ['needs GROQ_API_KEY']);

// The rail's command block is what makes a bench result reproducible from the
// CLI. smoke.mjs refuses a real provider given without its *_MODEL, so the pair
// must always travel together.
{
  const cmd = envCommandOf(murfRig, pickerProviders);
  check('envCommandOf emits every provider with its model', () =>
    (['STT=', 'STT_MODEL=', 'LLM=', 'LLM_MODEL=', 'TTS=', 'TTS_MODEL='].every((k) => cmd.includes(k))
      ? cmd
      : (() => { throw new Error(`missing a key in: ${cmd}`); })()), ['murf-tts', 'falcon-2']);
  // These names are read off backend/scripts/smoke.mjs. A wrong one does not
  // error — it falls back to mock-realtime and reports mock latency as the
  // vendor's — so they are pinned exactly.
  check('envCommandOf uses the realtime variables smoke.mjs actually reads', () =>
    envCommandOf({ ...baseRig, mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime' }, pickerProviders),
    ['REALTIME=openai-realtime', 'REALTIME_MODEL=gpt-realtime', 'smoke.mjs realtime']);
  check('envCommandOf carries the system prompt, shell-quoted', () => {
    const out = envCommandOf(murfRig, pickerProviders, "Don't use lists");
    if (!out.includes(`SYSTEM='Don'\\''t use lists'`)) throw new Error(`bad quoting: ${out}`);
    return out;
  }, ['SYSTEM=']);
}

// A rig restored from an older or partial localStorage payload must not reach
// the UI with an undefined field: `customVoiceId.trim()` on one is a blank page.
check('withDefaults heals a partial stored rig', () => {
  const partial = { id: 'x', name: 'Old', mode: 'pipeline', colorIndex: 0 } as unknown as Rig;
  const healed = withDefaults(partial, pickerProviders);
  for (const [k, v] of Object.entries(healed)) {
    if (v === undefined || v === null) throw new Error(`${k} survived as ${String(v)}`);
  }
  return envCommandOf(healed, pickerProviders, 'p');
}, ['STT=']);

// A stored rig naming a TTS provider in its STT slot must be replaced, not
// "healed" into a rig the factory will refuse at connect.
check('withDefaults rejects a cross-kind slot', () => {
  const crossed = withDefaults({ ...baseRig, sttProviderId: 'murf-tts', sttModelId: 'falcon-2' }, pickerProviders);
  if (crossed.sttProviderId === 'murf-tts') throw new Error('a TTS provider survived in the STT slot');
  return crossed.sttProviderId;
}, ['mock-stt']);

// A realtime rig is one leg, not three empty ones.
check('slotsOf: realtime is a single leg', () => {
  const slots = slotsOf({ ...baseRig, mode: 'realtime' }, pickerProviders);
  if (slots.length !== 1) throw new Error(`got ${slots.length} legs for a realtime rig`);
  return slots[0].label;
}, ['S2S']);

/**
 * The client-measured TTFA is the honest number in this UI — it is what a person
 * actually heard — which is exactly why it must never be shown for a turn that
 * did not produce it. `onFirstAudible` fires from a jitter-buffer timer, so it
 * is always late: a short turn's metrics can beat it, and a barge-in can cancel
 * the audio after it was scheduled. Both used to leave a stashed number that the
 * NEXT turn consumed and rendered as its own.
 */
for (const [name, stash, token, expected] of [
  ['the turn that measured it claims it', { token: 7, ms: 612 }, 7, 612],
  ['a later turn cannot claim a stale one', { token: 7, ms: 612 }, 8, undefined],
  ['an interrupted turn (token bumped by flush) cannot', { token: 7, ms: 612 }, 9, undefined],
  ['nothing stashed yields nothing', null, 7, undefined],
] as Array<[string, { token: number; ms: number } | null, number, number | undefined]>) {
  check(`claimTtfa: ${name}`, () => {
    const got = claimTtfa(stash, token);
    if (got !== expected) throw new Error(`got ${String(got)}, wanted ${String(expected)}`);
    return `ok ${String(got)}`;
  }, ['ok']);
}


/* ------------------ the legs overlap; nothing may stack them ------------------ */
/**
 * The bug this pins: leg latencies are measured against DIFFERENT origins and
 * overlap in wall time — a pipeline opens its TTS socket while the LLM is still
 * thinking. Laying them end to end drew a turn 1.63x longer than it was (the
 * repo's own smoke output: 468.5 ms of bands for a 287.9 ms turn) and reported
 * each leg's "share" of a total that never existed.
 */
{
  // The exact marks from `npm run smoke`, pipeline mode.
  const smokeTurn: TurnRecord = {
    turnId: 1,
    label: 'mock pipeline',
    clientTtfaMs: 300,
    marks: [
      { name: 'user_speech_end', atMs: 0 },
      { name: 'stt_final', atMs: 0.1 },
      { name: 'tts_request_sent', atMs: 0.3 },
      { name: 'llm_request_sent', atMs: 0.5 },
      { name: 'llm_first_token', atMs: 181.3 },
      { name: 'tts_first_audio', atMs: 287.9 },
      { name: 'first_audio_out', atMs: 287.9 },
    ],
    derived: { timeToFirstAudioMs: 287.9, sttLatencyMs: 0.1, llmTtftMs: 180.8, ttsTtfbMs: 287.6, audioDurationMs: 5310 },
  };

  check('bandsOf positions each leg at its real start, not end to end', () => {
    const bands = bandsOf(smokeTurn.derived, smokeTurn.marks);
    const tts = bands.find((b) => b.key === 'tts');
    const llm = bands.find((b) => b.key === 'llm');
    if (!tts || !llm) throw new Error('missing a band');
    // TTS opened BEFORE the LLM produced its first token. Stacking would put it after.
    if (!(tts.startMs < llm.startMs + llm.ms)) throw new Error('bands do not overlap — they were laid end to end');
    if (tts.startMs !== 0.3) throw new Error(`tts started at ${tts.startMs}, wanted its mark 0.3`);
    return `overlap ${(llm.startMs + llm.ms - tts.startMs).toFixed(1)}ms`;
  }, ['overlap']);

  check('the waterfall total is the measurement, never the sum of the bands', () => {
    const html = renderToString(h(TurnsPanel, { turns: [smokeTurn], usage: [] }));
    // 468 ms is what stacking produced. It must appear nowhere.
    if (/46[0-9] ms/.test(html)) throw new Error('a summed total leaked into the render');
    if (!html.includes('288 ms')) throw new Error('the server TTFA is missing from the row');
    return html;
  }, ['add up to the turn', '288 ms']);

  // A band measured as exactly 0 is a real measurement (TurnMetrics quantises to
  // 0.1 ms and mocks are instant); only an unmeasured leg may be absent.
  check('a 0 ms leg is kept, an unmeasured leg is dropped', () => {
    const bands = bandsOf(smokeTurn.derived, smokeTurn.marks);
    if (!bands.some((b) => b.key === 'stt')) throw new Error('the 0.1ms STT band was dropped');
    const realtime = bandsOf({ timeToFirstAudioMs: 441, ttsTtfbMs: 441 }, [{ name: 'tts_request_sent', atMs: 0 }]);
    if (realtime.some((b) => b.key === 'stt' || b.key === 'llm')) throw new Error('invented a leg a realtime turn never had');
    return `${bands.length} / ${realtime.length}`;
  }, ['3 / 1']);

  /*
   * `clientTtfaMs` starts its clock at the final transcript, not at t0, so it is
   * a different measurement on a different origin. Differencing it against the
   * server's TTFA produced a "network" band that was not a duration of
   * anything — and went negative whenever STT was slow.
   */
  check('no band is derived from the two TTFA numbers', () => {
    const bands = bandsOf(smokeTurn.derived, smokeTurn.marks);
    if (bands.some((b) => (b.key as string) === 'net')) throw new Error('the fabricated network band is back');
    return bands.map((b) => b.key).join(',');
  }, ['stt,tts,llm']);

  check('the waterfall axis uses the server figure, not the browser one', () => {
    // Browser figure deliberately far from the server figure; only the server
    // number may reach the axis total.
    const t = { ...smokeTurn, clientTtfaMs: 9999 };
    const html = renderToString(h(TurnsPanel, { turns: [t], usage: [] }));
    if (html.includes('9,999 ms</span>') || /9,999 ms<\/span>/.test(html)) {
      throw new Error('the browser figure was used as the turn total');
    }
    return html;
  }, ['288 ms']);

  check('legMediansOf reads per-leg medians off a record', () => {
    const legs = legMediansOf(SYNTHETIC.latency);
    if (legs.length !== 3) throw new Error(`got ${legs.length} legs`);
    return legs.map((l) => `${l.key}:${l.ms}`).join(' ');
  }, ['stt:214', 'llm:486', 'tts:640']);

  check('a record with no per-leg medians yields no bars rather than zeroes', () => {
    const legs = legMediansOf({ ttfaMedianMs: 500 });
    if (legs.length !== 0) throw new Error(`invented ${legs.length} legs`);
    return 'none';
  }, ['none']);

  // The report renders those medians as separate bars, and must not print a
  // percentage of a summed total anywhere.
  check('SessionReport shows per-leg medians without inventing a denominator', () => {
    const html = renderToString(h(SessionReport, { summary }));
    // The old stacked split labelled each leg "214 ms · 26%" — a share of a sum
    // that was not the turn. Percentages in inline `width:` are the bars
    // themselves and are fine; a percentage next to a millisecond figure is not.
    const share = html.match(/\d+\s*ms[^<]{0,6}·[^<]{0,6}\d+%/);
    if (share) throw new Error(`a percentage-of-total slipped back in: ${share[0]}`);
    return html;
  }, ['Median per leg', 'add up to the turn']);
}

// The frontend median must match UsageLedger digit for digit — the live panel
// and the filed record describe the same turns.
check('summarize matches the backend median on an even count', () => {
  const s = summarize([100.1, 100.2]);
  if (!s || s.median !== 100.2) throw new Error(`got ${String(s?.median)}, backend gives 100.2`);
  return String(s.median);
}, ['100.2']);

/* ------------------------- log source is a guess ------------------------- */
{
  const pipelineCfg = {
    mode: 'pipeline' as const, systemPrompt: '', turnDetection: 'server_vad' as const,
    sttProviderId: 'sarvam-stt', llmProviderId: 'google-llm', ttsProviderId: 'murf-tts',
    realtimeProviderId: 'openai-realtime',
  };
  const allMock = {
    ...pipelineCfg, sttProviderId: 'mock-stt', llmProviderId: 'mock-llm', ttsProviderId: 'mock-tts',
  };
  for (const [name, msg, cfg, want] of [
    ['a vendor name wins', 'murf first frame ttfb 188ms', pipelineCfg, 'tts'],
    ['a vendor socket close is not filed as browser noise',
     'websocket closed 1008 from murf gen2 host', pipelineCfg, 'tts'],
    ['an all-mock rig is ambiguous, so it stays session', 'mock provider ready', allMock, 'session'],
    ['a realtime slot is ignored in pipeline mode', 'openai llm stream opened', pipelineCfg, 'llm'],
    ['"dynamic" is not the microphone', 'dynamic range adjusted', pipelineCfg, 'session'],
    ['the microphone still is', 'mic open @ 48000Hz', pipelineCfg, 'mic'],
  ] as Array<[string, string, typeof pipelineCfg, string]>) {
    check(`sourceOfMessage: ${name}`, () => {
      const got = sourceOfMessage(msg, cfg);
      if (got !== want) throw new Error(`got "${got}", wanted "${want}"`);
      return got;
    }, [want]);
  }
}

// The whole app, shell only — effects do not run server-side, so this catches
// the class of failure that takes the page down before anything is fetched.
check('App (shell)', () => renderToString(h(App)), ['voice bench', 'Console']);

/* --------------------- against the real catalog ------------------------ */
/**
 * Everything above renders against fixtures. This renders against whatever
 * `/api/catalog` is actually serving — the path a browser takes on load, and
 * the one no fixture can stand in for: 26 providers, Cartesia's 934 voices
 * filed under 44 languages, Murf's per-model catalogues. A rig has to resolve
 * to a startable session against all of it.
 *
 * Skipped, not failed, when the backend is not running: this check is a bonus
 * on top of the fixture suite, and `npm run render-check` has to stay useful
 * with nothing else up.
 */
const CATALOG_URL = process.env.CATALOG_URL ?? 'http://localhost:8787/api/catalog';

const againstRealCatalog = async () => {
  let providers: ProviderEntry[];
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    providers = ((await res.json()) as { providers: ProviderEntry[] }).providers;
  } catch (err) {
    console.log(`\n  skip live catalog (${CATALOG_URL}: ${(err as Error).message}) — start the backend to include it`);
    return;
  }

  console.log(`\nagainst the live catalog: ${providers.length} providers`);

  const rigs = seedRigs(providers);
  check('seedRigs fills every slot from the catalog', () => {
    for (const rig of rigs) {
      for (const slot of slotsOf(rig, providers)) {
        if (!slot.providerId || !slot.modelId) throw new Error(`${rig.name} ${slot.label} is empty`);
      }
    }
    return rigs.map((r) => r.name).join(' ');
  }, ['Rig A', 'Rig B', 'Rig C']);

  // A rig that defaults to an unregistered provider would fail at connect with
  // a factory error, which is exactly the class of surprise the readiness dots
  // exist to prevent.
  check('a seeded rig prefers providers that are actually registered', () => {
    const unregistered = slotsOf(rigs[0], providers).filter((s) => {
      const entry = providers.find((p) => p.id === s.providerId);
      return entry && !entry.registered && providers.some((p) => p.kind === entry.kind && p.registered);
    });
    if (unregistered.length) throw new Error(`defaulted to unregistered ${unregistered.map((s) => s.providerId).join(', ')}`);
    return 'ok';
  }, ['ok']);

  check('RigRail renders a seeded rig', () => renderToString(h(RigRail, {
    rig: rigs[0], providers, systemPrompt: 'Be brief.', turns: [pipelineTurn], locked: false, canDelete: true,
    onEdit: () => {}, onRename: () => {}, onDelete: () => {},
  })), ['STT=', 'smoke.mjs']);

  // Cartesia is the stress case: the voice list under a language is the one
  // thing a fixture cannot approximate honestly.
  const cartesia = providers.find((p) => p.id === 'cartesia-tts');
  if (cartesia) {
    const rig: Rig = { ...rigs[0], mode: 'pipeline', ttsProviderId: 'cartesia-tts', ttsModelId: cartesia.models[0].id };
    const resolved = { ...rig, ttsLanguage: languagesFor(providers, 'cartesia-tts', rig.ttsModelId)[0]?.id ?? '' };
    const voices = voicesFor(providers, 'cartesia-tts', resolved.ttsModelId, resolved.ttsLanguage);
    check(`RigBuilder renders Cartesia's real voice library (${voices.length} under ${resolved.ttsLanguage})`, () =>
      renderToString(h(RigBuilder, {
        providers, rig: { ...resolved, voice: voices[0]?.id ?? '' },
        onChange: () => {}, onClose: () => {}, disabled: false,
      })), ['Voice', 'search by name or id']);

    // 934 <option> elements was the old shape. The list is capped so a long
    // library stays navigable rather than merely present.
    check('a long voice library is capped, and says how many it hid', () => {
      const html = renderToString(h(RigBuilder, {
        providers, rig: { ...resolved, voice: voices[0]?.id ?? '' },
        onChange: () => {}, onClose: () => {}, disabled: false,
      }));
      const rows = (html.match(/class="voice-row/g) ?? []).length;
      if (rows > 60) throw new Error(`rendered ${rows} voice rows`);
      return html;
    }, voices.length > 60 ? ['narrow the search'] : []);
  }

  // Every rig the UI can seed must produce a config the factory would accept.
  check('every seeded rig produces a startable config', () => {
    for (const rig of rigs) {
      const cfg = startConfigOf(rig, providers, 'prompt', 'server_vad');
      const need = rig.mode === 'realtime'
        ? [cfg.realtimeProviderId, cfg.realtimeModelId]
        : [cfg.sttProviderId, cfg.sttModelId, cfg.llmProviderId, cfg.llmModelId, cfg.ttsProviderId, cfg.ttsModelId];
      if (need.some((v) => !v)) throw new Error(`${rig.name} would start with an empty slot`);
    }
    return 'startable';
  }, ['startable']);
};

void againstRealCatalog().then(() => {
  if (failed) {
    console.log(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log('\nALL PANELS RENDER');
});
