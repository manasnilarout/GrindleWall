/**
 * Renders the new usage panels against a real persisted session record.
 *
 * `tsc` did not catch the last UI crash in this project (a concise-arrow
 * useEffect returning a value), so type-checking alone is not evidence that a
 * component renders. This actually runs them.
 */
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionIndexEntry, SessionSummary, StartConfig } from '../src/lib/protocol';
import App, { Bench } from '../src/App';
import { LoginPage } from '../src/components/LoginPage';
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
import { Recordings } from '../src/components/Recordings';
import { CreateCodeDialog } from '../src/components/CreateCodeDialog';
import {
  buildVoiceStackSpec, checkExportable, citeSessions, initialRows, promptSha256, provenanceFrom, rowFor, sharedLanguages,
  CANONICAL_PROVIDER_IDS, type ExportCheck, type ExportContext, type ExportLanguage, type ExportSelection,
} from '../src/lib/voice-stack/export';
import { decodeVoiceStack, encodeVoiceStack } from '../src/lib/voice-stack/spec';


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

/*
 * The Recordings panel lives in its own component (`Recordings.tsx`) rather
 * than inline here, and this is why. `ComparePage` fills `runs` from a
 * `useEffect` fetch, and `renderToString` never runs effects — so nested markup
 * is unreachable from this harness in the only state that matters, and the
 * panel would ship with nothing but its own absence verified.
 *
 * Two checks, therefore: this one pins the empty state through ComparePage
 * itself (the guard must suppress the whole section, not render an empty box),
 * and the block below renders the panel directly with runs in hand.
 */

check('ComparePage (pre-fetch) does not draw the Recordings panel before any run is loaded', () => {
  const html = renderToString(h(ComparePage, { onOpenReport: () => {} }));
  if (html.includes('Recordings')) throw new Error('the Recordings heading rendered with no runs loaded');
  if (html.includes('<audio')) throw new Error('an <audio> element rendered with no runs loaded');
  if (html.includes('left: you · right: the assistant')) {
    throw new Error('the channel hint rendered with no runs loaded');
  }
  return html;
}, ['Nothing recorded yet']);

{
  /*
   * recordId and sessionId are deliberately DIFFERENT. They are the same value
   * in a lot of real records, so a fixture that conflates them cannot tell a
   * player built from the record id — the only one the audio route accepts —
   * from one built from the transient socket id, and a check written against it
   * passes either way.
   */
  const run = (id: string, label: string): SessionSummary =>
    normalizeSummary({ ...SYNTHETIC, recordId: id, sessionId: `socket-${id}`, label });
  const two = [run('rec-a', 'cartesia-tts:sonic-3.6'), run('rec-b', 'elevenlabs-tts:eleven_flash_v2_5')];

  check('Recordings panel with two runs', () => renderToString(h(Recordings, { runs: two })), [
    'Recordings',
    // The channel layout is explained nowhere else in the UI.
    'left: you \u00b7 right: the assistant',
    '<audio',
    'controls',
    'preload="metadata"',
    // Each run gets its own player, pointed at that record's own audio.
    '/api/sessions/rec-a/audio',
    '/api/sessions/rec-b/audio',
    'cartesia-tts:sonic-3.6',
    'elevenlabs-tts:eleven_flash_v2_5',
  ]);

  // A record id needing escaping must not break out of the src attribute.
  check('Recordings escapes an awkward record id',
    () => renderToString(h(Recordings, { runs: [run('a b&c', 'x')] })),
    ['/api/sessions/a%20b%26c/audio']);

  check('Recordings players are keyed by record id, not session id',
    () => renderToString(h(Recordings, { runs: two })),
    ['/api/sessions/rec-a/audio']);
  check('...and never by the session id', () => {
    const html = renderToString(h(Recordings, { runs: two }));
    if (html.includes('socket-rec-a')) throw new Error('the player src was built from sessionId');
    return html;
  }, ['<audio']);

  check('Recordings renders nothing when no run has audio', () => {
    const html = renderToString(h(Recordings, { runs: [] }));
    if (html.includes('<audio') || html.includes('Recordings')) {
      throw new Error('the panel rendered with no runs');
    }
    return 'empty';
  }, ['empty']);
}

/*
 * A SOURCE check, not a render check, and labelled as one because it cannot be
 * anything else. `Recordings` returns null with no runs, and no runs is the
 * only state ComparePage can be server-rendered in — so deleting the element
 * from ComparePage entirely leaves every render check above green (verified by
 * mutation: both ComparePage renders stay byte-identical at 1972 chars). The
 * rendered output cannot distinguish "wired up" from "deleted", so the wiring
 * is pinned at the source instead of pretending otherwise.
 */
check('ComparePage actually renders the Recordings panel', () => {
  const src = readFileSync(new URL('../src/components/ComparePage.tsx', import.meta.url), 'utf8');
  if (!/<Recordings\s+runs=\{runs\}\s*\/>/.test(src)) {
    throw new Error('ComparePage does not render <Recordings runs={runs} />');
  }
  return 'wired';
}, ['wired']);

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

/*
 * The Nova Sonic shape, and a third one again: languages hang off the MODEL and
 * each language carries its own voices. It is here as a fixture, not only in
 * the live-catalog section at the bottom, because that section returns early
 * whenever the backend is not running — so with these cases only down there,
 * the ordinary offline `npm run render-check` covered the realtime
 * language -> voices path not at all, which is the one path this provider
 * introduced. A realtime rig reads `rig.language`, not `rig.ttsLanguage`:
 * different field, different branch, and `tsc` sees nothing wrong with either.
 */
const novaProviders: ProviderEntry[] = [
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
const novaRig: Rig = {
  ...blankRig('Rig N', 0),
  mode: 'realtime',
  realtimeProviderId: 'aws-nova-sonic', realtimeModelId: 'amazon.nova-2-sonic-v1:0',
  language: 'en-IN', voice: 'kiara',
};

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

// Realtime, offline: the voice list must come from `rig.language`. Reading the
// wrong field resolves no language at all, and `voicesFor` then hands back the
// provider's whole list — which still contains the right voice, so "the right
// voice is present" passes on its own. The exclusion is what discriminates.
check('RigBuilder renders a realtime provider\'s per-language voices', () => {
  const html = renderToString(h(RigBuilder, {
    providers: novaProviders, rig: novaRig, onChange: () => {}, onClose: () => {}, disabled: false,
  }));
  if (html.includes('Ambre')) throw new Error('en-IN also offers the French voice, so nothing narrowed');
  return html;
}, ['Voice', 'Kiara (feminine)']);
// A flat provider-level list would render identically under either language,
// which is exactly the bug the narrowing exists to prevent — so the assertion
// is that French does NOT offer the Indian voice, not merely that it offers one.
check('a realtime language change actually changes the voice list (fixture)', () => {
  const html = renderToString(h(RigBuilder, {
    providers: novaProviders, rig: { ...novaRig, language: 'fr-FR', voice: 'ambre' },
    onChange: () => {}, onClose: () => {}, disabled: false,
  }));
  if (html.includes('Kiara')) throw new Error('fr-FR still offers the en-IN voice');
  if (!html.includes('Ambre')) throw new Error('fr-FR offers no French voice');
  // The polyglot voice is valid in both and must survive the narrowing.
  if (!html.includes('Tiffany')) throw new Error('the polyglot voice went missing');
  return html;
}, ['Ambre (feminine)']);
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
  onEdit: () => {}, onRename: () => {}, onDelete: () => {}, onCreateCode: () => {},
})), ['Rig', 'Mock (canned)', 'bulbul:v3', 'STT=mock-stt', '214 ms', 'Create code']);

// A leg whose key is missing has to say so on the rail, not at connect time.
check('RigRail surfaces a missing key', () => renderToString(h(RigRail, {
  rig: { ...baseRig, llmProviderId: 'groq-llm', llmModelId: 'llama-3.3-70b' },
  providers: [...pickerProviders, {
    id: 'groq-llm', name: 'Groq', kind: 'llm' as const, implemented: true, registered: true, ready: false,
    envKeys: ['GROQ_API_KEY'], missingEnv: ['GROQ_API_KEY'], models: [{ id: 'llama-3.3-70b', name: 'llama' }],
  }],
  systemPrompt: 'Be brief.', turns: [], locked: false, canDelete: false,
  onEdit: () => {}, onRename: () => {}, onDelete: () => {}, onCreateCode: () => {},
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

/* ---------------------- voice-stack export ("Create code") ---------------------- */
/**
 * The export is the one place this bench hands something to another system,
 * and the receiving side (MagickVoice core) decodes with the very spec module
 * synced into `lib/voice-stack/`. So the assertions here are about the CODE,
 * not just the markup: it has to decode, and decode to what the rig ran —
 * Sarvam's `@fast` as an option rather than a model suffix, and Odia spelled
 * `or-IN` by the STT leg but `od-IN` by the TTS leg under one `or` row.
 */
const STACK_CODE = /mvs1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}/;
const stackProviders: ProviderEntry[] = [
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
/** The same TTS leg on a vendor that takes typed ids (Cartesia, Murf and ElevenLabs do). */
const idProviders = stackProviders.map((p) => (p.id === 'sarvam-tts' ? { ...p, acceptsVoiceId: true } : p));
const stackRig: Rig = {
  ...blankRig('Hindi collections', 0),
  sttProviderId: 'sarvam-stt', sttModelId: 'saaras:v3-realtime@fast', sttLanguage: 'auto',
  llmProviderId: 'google-llm', llmModelId: 'gemini-3.1-flash-lite@minimal',
  ttsProviderId: 'sarvam-tts', ttsModelId: 'bulbul:v3', ttsLanguage: 'hi-IN', voice: 'pooja',
};
/**
 * Fixture hashes come from node:crypto, the backend's own digest, NOT from the
 * export's `promptSha256` — so a citation matching here is evidence that the
 * browser and the backend agree on the hash, not that a function agrees with itself.
 */
const backendSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const stackPrompt = 'You are a polite collections agent. नमस्ते से शुरू करें।';
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
const stackSessions: SessionIndexEntry[] = [
  indexRow({ recordId: 'rec-hi-1', startedAt: 2_000, endedAt: 62_000, turnCount: 4, costUsd: 0.02, costInr: 1.8,
    durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 900, ttfaP95Ms: 1400 } }),
  // Odia in its own row's voice: cited for the `or` row.
  indexRow({ recordId: 'rec-or-1', startedAt: 1_000, endedAt: 61_000, turnCount: 2, costUsd: 0.01, costInr: 0.9,
    unpriced: ['x'], durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 1100, ttfaP95Ms: 1600 },
    config: stackConfig({ sttLanguage: 'or-IN', ttsLanguage: 'od-IN', voice: 'shubh' }) }),
  // A tab left open for an hour with no speech time on the row (an older
  // backend): its latency is evidence, but it must not enter the cost rate —
  // under wall clock its 60 minutes and $0.50 dominated it.
  indexRow({ recordId: 'rec-hi-open-tab', startedAt: 1_500, endedAt: 3_601_500, turnCount: 3, costUsd: 0.5, costInr: 45,
    durationMs: 3_600_000, latency: { ttfaMedianMs: 1000, ttfaP95Ms: 1500 } }),
  // Hindi in ANOTHER voice: TTS latency moves with the voice, so not cited.
  indexRow({ recordId: 'rec-hi-shubh', startedAt: 6_000, costUsd: 0.4, costInr: 36, durationMs: 60_000, speechSeconds: 30,
    latency: { ttfaMedianMs: 9000, ttfaP95Ms: 9900 }, config: stackConfig({ voice: 'shubh' }) }),
  // Same everything under a different system prompt (the Latency probe vs Naturalness probe case).
  indexRow({ recordId: 'rec-other-prompt', startedAt: 7_000, costUsd: 0.4, costInr: 36, durationMs: 60_000, speechSeconds: 30,
    latency: { ttfaMedianMs: 7000, ttfaP95Ms: 7700 }, promptSha256: backendSha('Reply in one short sentence.') }),
  // Listed by a backend older than the prompt hash: cannot be matched on the prompt.
  indexRow({ recordId: 'rec-unhashed', startedAt: 8_000, costUsd: 0.4, costInr: 36, durationMs: 60_000,
    latency: { ttfaMedianMs: 8000, ttfaP95Ms: 8800 }, promptSha256: undefined }),
  // A different LLM variant is a different stack: it must not be cited.
  indexRow({ recordId: 'rec-other-llm', startedAt: 3_000, endedAt: 9_000, costUsd: 0.5, costInr: 45, durationMs: 6_000,
    latency: { ttfaMedianMs: 5000 }, config: stackConfig({ llmModelId: 'gemini-3.1-flash-lite@high' }) }),
  // A record from a backend older than `config` on the index row: skipped, not crashed on.
  { recordId: 'rec-legacy', label: 'x', mode: 'pipeline', startedAt: 4_000, endedAt: 9_000, turnCount: 3,
    costUsd: 0, costInr: 0, unpriced: [] },
  // Same legs under push-to-talk: a different turn loop than the code's
  // `turn.detection: 'server_vad'`, so its latency must not be cited.
  indexRow({ recordId: 'rec-manual-turns', startedAt: 5_000, endedAt: 65_000, turnCount: 5, costUsd: 0.9, costInr: 80,
    durationMs: 60_000, speechSeconds: 30, latency: { ttfaMedianMs: 4000, ttfaP95Ms: 6000 },
    config: stackConfig({ turnDetection: 'manual' }) }),
];
const hiOr: ExportLanguage[] = [
  { code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' },
  { code: 'or', sttLang: 'or-IN', ttsLang: 'od-IN', voice: 'shubh' },
];
const stackCitation = (rows: ExportLanguage[] = hiOr, sessions = stackSessions) => citeSessions(stackRig, sessions, rows, stackPrompt);
const stackSelection = (over: Partial<ExportSelection> = {}): ExportSelection => ({
  languages: hiOr, name: 'Hindi collections', provenance: provenanceFrom(stackCitation()), ...over,
});
const vad: ExportContext = { turnDetection: 'server_vad', citation: stackCitation() };
const ptt: ExportContext = { turnDetection: 'manual', citation: stackCitation() };
const blocks = (checks: ExportCheck[]) => checks.filter((c) => c.level === 'block').map((c) => c.message);
const dialog = (props: Partial<Parameters<typeof CreateCodeDialog>[0]> = {}) =>
  renderToString(h(CreateCodeDialog, {
    rig: stackRig, providers: stackProviders, systemPrompt: stackPrompt, turnDetection: 'server_vad', onClose: () => {}, ...props,
  }));

check('promptSha256 is the backend digest, byte for byte', () => {
  for (const text of ['', 'abc', stackPrompt, '  untrimmed\n', '😀 emoji']) {
    if (promptSha256(text) !== backendSha(text)) throw new Error(`differs for ${JSON.stringify(text)}`);
  }
  return promptSha256('abc');
}, ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']);

check('sharedLanguages pairs Odia across or-IN / od-IN and never offers auto-detect', () => {
  const langs = sharedLanguages(stackRig, stackProviders);
  const odia = langs.find((l) => l.code === 'or');
  if (!odia || odia.stt[0] !== 'or-IN' || odia.tts[0] !== 'od-IN') throw new Error(`odia: ${JSON.stringify(odia)}`);
  if (langs.some((l) => l.code === 'ta' || l.code === 'en')) throw new Error('offered a language only one leg lists');
  if (langs.some((l) => !l.code || l.stt.includes('auto'))) throw new Error('auto-detect leaked into the rows');
  return langs.map((l) => l.code).join(',');
}, ['hi', 'or']);

check('initialRows pins an auto-detect STT rig to the language it speaks', () => {
  const rows = initialRows(stackRig, stackProviders);
  const want = { code: 'hi', sttLang: 'hi-IN', ttsLang: 'hi-IN', voice: 'pooja' };
  if (JSON.stringify(rows) !== JSON.stringify([want])) throw new Error(JSON.stringify(rows));
  return 'pinned';
}, ['pinned']);

// `startConfigOf` sends the typed id, not the dropdown, on a vendor that takes
// ids — so an ADDED language must carry it too. Only the first row used to.
check('rowFor carries the typed voice id onto every language, the same as the first row', () => {
  const rig = { ...stackRig, customVoiceId: ' cloned-7 ' };
  const added = sharedLanguages(rig, idProviders).map((o) => rowFor(rig, idProviders, o));
  const wrong = added.filter((r) => r.voice !== 'cloned-7');
  if (wrong.length) throw new Error(`added rows switched voice: ${JSON.stringify(wrong)}`);
  if (initialRows(rig, idProviders)[0]?.voice !== 'cloned-7') throw new Error('first row lost the typed id');
  if (startConfigOf(rig, idProviders, '', 'server_vad').voice !== 'cloned-7') throw new Error('startConfigOf disagrees');
  // And never on a vendor that does not take ids: there the dropdown is what is sent.
  const plain = sharedLanguages(rig, stackProviders).map((o) => rowFor(rig, stackProviders, o).voice);
  if (plain.includes('cloned-7')) throw new Error('typed id leaked onto a vendor that refuses ids');
  return added.map((r) => `${r.code}:${r.voice}`).join(' ');
}, ['hi:cloned-7', 'or:cloned-7']);

check('CreateCodeDialog keeps the typed voice on every row it is handed', () => {
  const rig = { ...stackRig, customVoiceId: 'cloned-7' };
  const rows = sharedLanguages(rig, idProviders).map((o) => rowFor(rig, idProviders, o));
  const html = dialog({ rig, providers: idProviders, sessions: [], languages: rows });
  const decoded = decodeVoiceStack(STACK_CODE.exec(html)?.[0] ?? '');
  if (!decoded.ok) throw new Error(decoded.error.message);
  const voices = decoded.spec.languages.map((l) => `${l.code}:${l.voice}`).join(' ');
  if (voices !== 'hi:cloned-7 or:cloned-7') throw new Error(`code carries ${voices}`);
  if (html.split('Voice — overridden').length - 1 !== 2) throw new Error('a row does not show the override');
  return html;
}, ['Voice — overridden', 'cloned-7']);

check('provenance cites only sessions of this exact stack: legs, server VAD, prompt, row voice', () => {
  const c = stackCitation();
  const p = provenanceFrom(c);
  const want = ['rec-hi-1', 'rec-hi-open-tab', 'rec-or-1'];
  if (JSON.stringify(p.sessions) !== JSON.stringify(want)) throw new Error(`sessions ${JSON.stringify(p.sessions)}`);
  if (c.otherPrompt !== 1 || c.unhashed !== 1) throw new Error(`otherPrompt ${c.otherPrompt}, unhashed ${c.unhashed}`);
  if (JSON.stringify(c.otherVoices) !== JSON.stringify({ hi: ['shubh'] })) throw new Error(`otherVoices ${JSON.stringify(c.otherVoices)}`);
  if (p.promptSha256 !== backendSha(stackPrompt)) throw new Error('provenance does not name the prompt it was measured under');
  return (p.measuredLanguages ?? []).join(',');
}, ['hi,or']);

check('cost per minute divides by speech time, and a row without it is left out', () => {
  const cost = provenanceFrom(stackCitation()).costPerMinute as { usd: number; inr: number; floor: boolean; speechMinutes: number; basis: string };
  // rec-hi-1 + rec-or-1: $0.03 over 30 s + 30 s of speech. The open tab is out
  // of BOTH sums; by wall clock it was $0.53 over 62 min, i.e. $0.0085.
  if (cost.usd !== 0.03 || cost.inr !== 2.7 || cost.speechMinutes !== 1 || cost.floor !== true) {
    throw new Error(`cost ${JSON.stringify(cost)}`);
  }
  const silent = stackSessions.filter((s) => s.recordId === 'rec-hi-open-tab');
  const none = provenanceFrom(stackCitation(hiOr, silent));
  if (none.costPerMinute !== undefined) throw new Error(`a row with no speech time produced ${JSON.stringify(none.costPerMinute)}`);
  if (!none.latency) throw new Error('its latency should still be cited');
  return cost.basis;
}, ['minutes of assistant speech', '2 of 3 sessions', 'no speech time recorded are left out']);

check('latency names the median of per-session p95s for what it is', () => {
  const latency = provenanceFrom(stackCitation()).latency as Record<string, unknown>;
  if ('ttfaP95Ms' in latency) throw new Error('a median of per-session p95s is labelled as a p95');
  if (latency.ttfaMedianMs !== 1000 || latency.ttfaSessionP95MedianMs !== 1500) throw new Error(`latency ${JSON.stringify(latency)}`);
  const html = dialog({ sessions: stackSessions, languages: hiOr });
  if (/[^n] p95 1500 ms/.test(html.replace(/median session p95/g, 'median session'))) throw new Error('dialog still prints a bare p95');
  return `${String(latency.basis)} ${html}`;
}, ['not a p95 of turns', 'median session p95 1500 ms', 'per minute of assistant speech']);

check('a pipeline rig with hi + or encodes, and decodes to what the rig ran', () => {
  const checks = checkExportable(stackRig, stackProviders, stackSelection(), vad);
  if (blocks(checks).length) throw new Error(`blocked: ${blocks(checks).join(' | ')}`);
  const decoded = decodeVoiceStack(encodeVoiceStack(buildVoiceStackSpec(stackRig, stackProviders, stackSelection(), vad)));
  if (!decoded.ok) throw new Error(decoded.error.message);
  const { stt, llm, tts, languages, turn } = decoded.spec;
  const got = JSON.stringify({ stt, llm, tts, languages, turn });
  const want = JSON.stringify({
    stt: { provider: 'sarvam', model: 'saaras:v3-realtime', options: { streamType: 'fast' } },
    llm: { provider: 'google', model: 'gemini-3.1-flash-lite', options: { reasoning: 'minimal' } },
    tts: { provider: 'sarvam', model: 'bulbul:v3', options: {} },
    languages: [
      { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' },
      { code: 'or', stt: 'or-IN', tts: 'od-IN', voice: 'shubh' },
    ],
    turn: { detection: 'server_vad' },
  });
  if (got !== want) throw new Error(`decoded ${got}`);
  if (checks.some((c) => c.message.startsWith('Never measured'))) throw new Error('both rows were measured');
  return checks.map((c) => c.message).join(' | ');
}, ['1 session on these legs ran under a different system prompt', 'listed without a prompt hash', 'Ready: 2 languages, default hi']);

check('a row in a voice no session used is warned about, and nothing is cited for it', () => {
  const rows = [hiOr[0], { ...hiOr[1], voice: 'pooja' }];
  const citation = stackCitation(rows);
  const p = provenanceFrom(citation);
  if (p.sessions?.includes('rec-or-1')) throw new Error('cited an Odia session in another voice');
  if (JSON.stringify(p.measuredLanguages) !== JSON.stringify(['hi'])) throw new Error(`measured ${JSON.stringify(p.measuredLanguages)}`);
  return checkExportable(stackRig, stackProviders, { languages: rows, name: 'x', provenance: p }, { turnDetection: 'server_vad', citation })
    .map((c) => `${c.level}:${c.message}`).join(' | ');
}, ['warn:or: no recorded session used the voice "pooja"', 'spoke or in "shubh"']);

check('a row no session spoke at all is "never measured"', () => {
  const sessions = stackSessions.filter((s) => s.recordId !== 'rec-or-1');
  const citation = stackCitation(hiOr, sessions);
  return checkExportable(stackRig, stackProviders, { languages: hiOr, name: 'x', provenance: provenanceFrom(citation) }, { turnDetection: 'server_vad', citation })
    .map((c) => `${c.level}:${c.message}`).join(' | ');
}, ['warn:Never measured on this combination: or']);

check('CreateCodeDialog renders a code that decodes', () => {
  const html = dialog({ sessions: stackSessions, languages: hiOr });
  const code = STACK_CODE.exec(html)?.[0];
  if (!code) throw new Error('no mvs1. code in the markup');
  const decoded = decodeVoiceStack(code);
  if (!decoded.ok) throw new Error(`rendered code does not decode: ${decoded.error.message}`);
  const codes = decoded.spec.languages.map((l) => l.code).join(',');
  if (codes !== 'hi,or') throw new Error(`rendered code carries ${codes}`);
  if (decoded.spec.meta.provenance?.sessions?.length !== 3) throw new Error('rendered code lost its provenance');
  return html;
}, ['aria-modal="true"', 'Create code', 'Copy code', 'decodes', 'od-IN', 'or-IN', 'streamType=fast', 'TTFA median', 'Decoded']);

check('CreateCodeDialog waits for the sessions before producing a code', () => {
  const html = dialog();
  if (STACK_CODE.test(html)) throw new Error('produced a code before provenance settled');
  return html;
}, ['Reading recorded sessions', 'Waiting for recorded sessions']);

check('CreateCodeDialog refuses a realtime rig', () => {
  const html = dialog({
    rig: { ...stackRig, mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime' },
    sessions: stackSessions,
  });
  if (STACK_CODE.test(html)) throw new Error('a realtime rig produced a code');
  return html;
}, ['Realtime stacks are not supported by core yet', 'Clear the blockers']);

// Nova Sonic arrived after the realtime gate was written. The gate keys on
// `rig.mode`, not on a provider list, so a new realtime vendor is refused with
// the same message — this pins that for the one realtime provider whose
// language/voice fields are populated, which is the shape most likely to tempt
// an exporter into treating it as exportable.
check('CreateCodeDialog refuses a Nova Sonic rig as realtime', () => {
  const providers = [...stackProviders, ...novaProviders];
  const found = checkExportable(novaRig, providers, stackSelection(), vad);
  if (found.length !== 1 || found[0]?.level !== 'block') {
    throw new Error(`expected exactly the realtime block, got: ${found.map((c) => `${c.level}:${c.message}`).join(' | ')}`);
  }
  const html = dialog({ rig: novaRig, providers, sessions: stackSessions });
  if (STACK_CODE.test(html)) throw new Error('a Nova Sonic rig produced a code');
  return `${found[0].message} ${html}`;
}, ['Realtime stacks are not supported by core yet', 'Clear the blockers']);

// A v1 code can only say `turn.detection: 'server_vad'`, and every session a
// push-to-talk bench runs is manual — so it is refused the way realtime is,
// rather than exported with a green checklist and server-VAD latency.
check('checkExportable refuses a push-to-talk bench, the way it refuses realtime', () => {
  const found = checkExportable(stackRig, stackProviders, stackSelection(), ptt);
  if (found.length !== 1 || found[0]?.level !== 'block') {
    throw new Error(`expected exactly the push-to-talk block, got: ${found.map((c) => `${c.level}:${c.message}`).join(' | ')}`);
  }
  return found[0].message;
}, ['Push-to-talk (manual turn detection) cannot be exported', 'server VAD only']);

check('buildVoiceStackSpec will not write a server-VAD code for a push-to-talk bench', () => {
  try {
    buildVoiceStackSpec(stackRig, stackProviders, stackSelection(), ptt);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('built a spec');
}, ['Push-to-talk']);

check('CreateCodeDialog refuses a push-to-talk bench', () => {
  const html = dialog({ turnDetection: 'manual', sessions: stackSessions, languages: hiOr });
  if (STACK_CODE.test(html)) throw new Error('a push-to-talk bench produced a code');
  if (html.includes('Ready:')) throw new Error('the checklist reads Ready');
  return html;
}, ['Push-to-talk (manual turn detection) cannot be exported', 'Clear the blockers']);

// The dialog's props are required, so tsc fails if they are left off — but a
// constant would satisfy it. The bench's OWN state is what must be passed.
check('App hands the dialog the bench\'s own prompt and turn detection', () => {
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const site = /<CreateCodeDialog\b[\s\S]*?\/>/.exec(src)?.[0];
  if (!site) throw new Error('no <CreateCodeDialog …/> in App.tsx');
  for (const prop of ['systemPrompt={systemPrompt}', 'turnDetection={turnDetection}']) {
    if (!site.includes(prop)) throw new Error(`App.tsx does not pass ${prop}`);
  }
  return site;
}, ['turnDetection={turnDetection}']);

for (const [name, rig, selection, want] of [
  ['a mock leg blocks', { ...stackRig, ttsProviderId: 'mock-tts', ttsModelId: 'mock-voice' }, stackSelection(), 'is a mock provider'],
  ['a provider core has no id for blocks', { ...stackRig, llmProviderId: 'groq-llm', llmModelId: 'llama-3.3-70b' }, stackSelection(), 'has no MagickVoice LLM provider id'],
  ['an untranslatable variant blocks', { ...stackRig, sttModelId: 'saaras:v3-realtime@turbo' }, stackSelection(), 'unknown Sarvam stream type'],
  ['no language blocks', stackRig, stackSelection({ languages: [] }), 'Pick at least one language'],
  ['auto-detect cannot be a row', stackRig, stackSelection({ languages: [{ code: 'auto', sttLang: 'auto', ttsLang: 'hi-IN', voice: 'pooja' }] }), 'auto-detect cannot be a row'],
  ['a duplicated base code blocks', stackRig, stackSelection({ languages: [hiOr[0], { ...hiOr[0], code: 'hi-IN' }] }), 'hi is listed twice'],
  ['a language one leg does not list blocks', stackRig, stackSelection({ languages: [{ code: 'ta', sttLang: 'ta-IN', ttsLang: 'ta-IN', voice: 'pooja' }] }), 'does not list TTS language "ta-IN"'],
  ['an unknown voice blocks where ids are not accepted', stackRig, stackSelection({ languages: [{ ...hiOr[0], voice: 'nobody' }] }), '"nobody" is not a bulbul:v3 voice'],
] as Array<[string, Rig, ExportSelection, string]>) {
  check(`checkExportable: ${name}`, () => {
    const found = blocks(checkExportable(rig, stackProviders, selection, vad));
    if (!found.length) throw new Error('nothing blocked');
    return found.join(' | ');
  }, [want]);
}

check('checkExportable: a custom voice id is a warning where the vendor takes ids', () => {
  const checks = checkExportable(stackRig, idProviders, stackSelection({ languages: [{ ...hiOr[0], voice: 'cloned-voice-7' }] }), vad);
  if (blocks(checks).length) throw new Error(`blocked: ${blocks(checks).join(' | ')}`);
  return checks.map((c) => `${c.level}:${c.message}`).join(' | ');
}, ['warn:hi: "cloned-voice-7" is a custom voice id']);

check('checkExportable: no measured session is said out loud', () =>
  checkExportable(stackRig, stackProviders, stackSelection({ provenance: provenanceFrom(undefined) }), { turnDetection: 'server_vad' })
    .map((c) => `${c.level}:${c.message}`).join(' | '),
['warn:No recorded session used this exact stack']);

/* -------------------- the core spec mirror (sync-voice-stack-spec) -------------------- */
/**
 * The sync script's default core path is pure arithmetic on its own location,
 * and was one `..` too many — it looked beside the directory HOLDING the repo,
 * not beside the repo. Run the real script in a throwaway layout
 * `<root>/parent/{repo/frontend/scripts, magic-voice-core}`: the sibling must
 * be found, and the off-by-one would have looked in `<root>/magic-voice-core`,
 * which does not exist. Never touches a real core checkout.
 */
{
  const SYNC_FILES = ['spec.ts', 'language.ts', 'canonical-json.ts', 'sha256.ts', 'bytes.ts'];
  const scriptSrc = readFileSync(new URL('../scripts/sync-voice-stack-spec.mjs', import.meta.url), 'utf8');
  const header = (file: string) =>
    `// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/${file}\n` +
    `// by \`npm run sync-voice-stack-spec\`; edit it in core and re-run that.\n\n`;
  const layout = (withCore: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'vs-sync-'));
    const scripts = join(root, 'parent', 'repo', 'frontend', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'sync-voice-stack-spec.mjs'), scriptSrc);
    const core = join(root, 'parent', 'magic-voice-core');
    if (withCore) {
      mkdirSync(join(core, 'src', 'voice-stacks'), { recursive: true });
      for (const f of SYNC_FILES) writeFileSync(join(core, 'src', 'voice-stacks', f), `export const ${f.replace(/\W/g, '_')} = 1;\n`);
    }
    return { root, scripts, core, target: join(root, 'parent', 'repo', 'frontend', 'src', 'lib', 'voice-stack') };
  };
  const run = (scripts: string, override?: string) => {
    const env = { ...process.env };
    delete env.MAGIC_VOICE_CORE;
    if (override !== undefined) env.MAGIC_VOICE_CORE = override;
    return spawnSync(process.execPath, [join(scripts, 'sync-voice-stack-spec.mjs')], { env, encoding: 'utf8' });
  };

  check('sync-voice-stack-spec finds core in the checkout beside this repo by default', () => {
    const l = layout(true);
    try {
      const r = run(l.scripts);
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr.trim()}`);
      for (const f of SYNC_FILES) {
        const got = readFileSync(join(l.target, f), 'utf8');
        if (got !== header(f) + readFileSync(join(l.core, 'src', 'voice-stacks', f), 'utf8')) throw new Error(`${f} is not header + core's bytes`);
      }
      return r.stdout;
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }, ['synced 5 files', join('parent', 'magic-voice-core')]);

  check('sync-voice-stack-spec says which path it tried and how to override it', () => {
    const l = layout(false);
    try {
      const r = run(l.scripts);
      if (r.status === 0) throw new Error('succeeded with no core anywhere');
      if (existsSync(l.target)) throw new Error('wrote a mirror with no source');
      return r.stderr;
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  }, [join('parent', 'magic-voice-core', 'src', 'voice-stacks'), 'MAGIC_VOICE_CORE=']);

  check('sync-voice-stack-spec: MAGIC_VOICE_CORE wins over the sibling', () => {
    const l = layout(false);
    const elsewhere = layout(true);
    try {
      const r = run(l.scripts, elsewhere.core);
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr.trim()}`);
      if (!r.stdout.includes(elsewhere.core)) throw new Error(`synced from somewhere else: ${r.stdout.trim()}`);
      return r.stdout;
    } finally {
      rmSync(l.root, { recursive: true, force: true });
      rmSync(elsewhere.root, { recursive: true, force: true });
    }
  }, ['synced 5 files']);

  // When a real core checkout is reachable (MAGIC_VOICE_CORE, or beside the
  // repo), the committed mirror must be exactly what a sync would write — a
  // hand edit, or a core change not yet re-synced, shows here. Read-only.
  const realCore = process.env.MAGIC_VOICE_CORE?.trim() || resolve(process.cwd(), '..', '..', 'magic-voice-core');
  if (existsSync(join(realCore, 'src', 'voice-stacks', 'spec.ts'))) {
    check('the committed voice-stack mirror is byte-identical to core', () => {
      const stale = SYNC_FILES.filter((f) =>
        readFileSync(new URL(`../src/lib/voice-stack/${f}`, import.meta.url), 'utf8') !==
        header(f) + readFileSync(join(realCore, 'src', 'voice-stacks', f), 'utf8'));
      if (stale.length) throw new Error(`differs from ${realCore}: ${stale.join(', ')} — run npm run sync-voice-stack-spec`);
      return `mirror matches ${realCore}`;
    }, ['mirror matches']);
  } else {
    console.log(`  skip voice-stack mirror drift (no core at ${realCore}) — set MAGIC_VOICE_CORE to include it`);
  }
}

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
// App now gates on login (auth config is fetched in an effect), so the SSR
// shell is the splash; the bench itself is `Bench`.
check('App (shell)', () => renderToString(h(App)), ['Grindelwald', 'powered by MagickVoice']);
check('Bench (shell)', () => renderToString(h(Bench, {})), ['Grindelwald', 'powered by MagickVoice', 'Console']);
check('Bench (signed in)', () => renderToString(h(Bench, {
  onLogout: () => {},
  username: 'admin@magickvoice.com',
})), ['Sign out', 'admin@magickvoice.com']);
check('LoginPage', () => renderToString(h(LoginPage, {
  username: 'admin@magickvoice.com',
  sessionTtlMs: 3 * 60 * 60 * 1000,
})), ['Sign in', 'admin@magickvoice.com', 'Password', 'session lasts']);

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

/**
 * The backend's `.env` is what arms the gate. This script is launched from
 * `frontend/`, so AUTH_* are not in `process.env` unless we read that file.
 * Missing them against a gated backend used to 401 and get reported as
 * "start the backend" — the backend was up; we just had no token.
 */
function loadBackendEnv(): void {
  const path = resolve(process.cwd(), '..', 'backend', '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function catalogHeaders(): Promise<HeadersInit> {
  loadBackendEnv();
  const password = process.env.AUTH_PASSWORD;
  const secret = process.env.AUTH_HMAC_SECRET;
  if (!password || !secret) return {};
  const { createHmac } = await import('node:crypto');
  const hmac = createHmac('sha256', secret).update(password, 'utf8').digest('hex');
  const loginUrl = (process.env.API_URL ?? 'http://localhost:8787') + '/api/auth/login';
  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@magickvoice.com', hmac }),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const { token } = (await res.json()) as { token?: string };
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const againstRealCatalog = async () => {
  let providers: ProviderEntry[];
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(2500), headers: await catalogHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    providers = ((await res.json()) as { providers: ProviderEntry[] }).providers;
  } catch (err) {
    const detail = (err as Error).message;
    const gated = /HTTP 401|login HTTP/.test(detail);
    console.log(
      `\n  skip live catalog (${CATALOG_URL}: ${detail}) — ` +
        (gated
          ? 'backend is gated; set AUTH_PASSWORD and AUTH_HMAC_SECRET'
          : 'start the backend to include it'),
    );
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
    onEdit: () => {}, onRename: () => {}, onDelete: () => {}, onCreateCode: () => {},
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

  /*
   * Nova Sonic is the first REALTIME provider whose voices narrow per language.
   * Every other realtime entry publishes one flat voice list, so the
   * language -> voices path through RigBuilder had only ever been exercised in
   * pipeline mode, on the TTS slot. A realtime rig reads `rig.language` rather
   * than `rig.ttsLanguage`, which is a different field on a different branch:
   * getting it wrong renders an empty Voice dropdown for a provider that has
   * sixteen of them, and `tsc` sees nothing wrong with it.
   */
  const nova = providers.find((p) => p.id === 'aws-nova-sonic');
  if (nova) {
    const model = nova.models[0].id;
    const langs = languagesFor(providers, 'aws-nova-sonic', model);
    const hindi = langs.find((l) => l.id === 'hi-IN')?.id ?? langs[0]?.id ?? '';
    const voices = voicesFor(providers, 'aws-nova-sonic', model, hindi);
    const rig: Rig = {
      ...rigs[0], mode: 'realtime', realtimeProviderId: 'aws-nova-sonic',
      realtimeModelId: model, language: hindi, voice: voices[0]?.id ?? '',
    };
    check(`RigBuilder renders Nova Sonic's per-language voices (${voices.length} under ${hindi})`, () =>
      renderToString(h(RigBuilder, {
        providers, rig, onChange: () => {}, onClose: () => {}, disabled: false,
      })), ['Voice', 'kiara']);

    // The polyglot pair is valid in every language and the per-locale pair only
    // in its own. A flat provider-level list would render identically under
    // every language, which is precisely the bug this narrowing exists to avoid.
    check('a realtime language change actually changes the voice list', () => {
      const french = voicesFor(providers, 'aws-nova-sonic', model, 'fr-FR').map((v) => v.id);
      const indian = voicesFor(providers, 'aws-nova-sonic', model, 'en-IN').map((v) => v.id);
      if (!french.includes('ambre')) throw new Error(`fr-FR has no ambre: ${french.join(',')}`);
      if (french.includes('kiara')) throw new Error('fr-FR wrongly offers the Indian voice');
      if (!indian.includes('kiara')) throw new Error(`en-IN has no kiara: ${indian.join(',')}`);
      // tiffany/matthew are documented polyglot, so they must survive both.
      if (!french.includes('tiffany') || !indian.includes('tiffany')) throw new Error('the polyglot voice went missing');
      return `${french.length}/${indian.length}`;
    }, ['/']);
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

  // The export's id map is written against the catalog's ids. A rename there
  // would not error — that leg would just stop being exportable — so every
  // mapped id must still exist, under the leg it is mapped for.
  check('every exportable provider id is still in the live catalog', () => {
    const gone = (Object.entries(CANONICAL_PROVIDER_IDS) as Array<[string, Record<string, string>]>)
      .flatMap(([leg, map]) => Object.keys(map).filter((id) => !providers.some((p) => p.id === id && p.kind === leg)));
    if (gone.length) throw new Error(`mapped but not in the catalog: ${gone.join(', ')}`);
    return 'mapped';
  }, ['mapped']);

  // The exact stack the synthetic check uses, against the real Sarvam tables:
  // if the catalog's Odia spellings move, this is where it shows.
  const live = withDefaults({
    ...blankRig('Live Sarvam', 0),
    sttProviderId: 'sarvam-stt', sttModelId: 'saaras:v3-realtime@fast', sttLanguage: 'auto',
    llmProviderId: 'google-llm', llmModelId: 'gemini-3.1-flash-lite@minimal',
    ttsProviderId: 'sarvam-tts', ttsModelId: 'bulbul:v3', ttsLanguage: 'hi-IN',
  }, providers);
  if (live.sttProviderId === 'sarvam-stt' && live.ttsProviderId === 'sarvam-tts') {
    check('the live Sarvam stack exports hi + or and the code decodes', () => {
      const langs = sharedLanguages(live, providers).filter((l) => l.code === 'hi' || l.code === 'or');
      const rows = langs.map((l) => ({ code: l.code, sttLang: l.stt[0], ttsLang: l.tts[0],
        voice: voicesFor(providers, live.ttsProviderId, live.ttsModelId, l.tts[0])[0]?.id ?? '' }));
      const selection = { languages: rows, name: 'Live Sarvam' };
      const blocked = checkExportable(live, providers, selection, { turnDetection: 'server_vad' }).filter((c) => c.level === 'block');
      if (blocked.length) throw new Error(blocked.map((c) => c.message).join(' | '));
      const decoded = decodeVoiceStack(encodeVoiceStack(buildVoiceStackSpec(live, providers, selection, { turnDetection: 'server_vad' })));
      if (!decoded.ok) throw new Error(decoded.error.message);
      return decoded.spec.languages.map((l) => `${l.code}:${l.stt}/${l.tts}`).join(' ');
    }, ['hi:', 'or:']);
  }
};

void againstRealCatalog().then(() => {
  if (failed) {
    console.log(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log('\nALL PANELS RENDER');
});
