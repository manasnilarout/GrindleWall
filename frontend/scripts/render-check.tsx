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
import { SessionReport } from '../src/components/SessionReport';
import { UsagePanel } from '../src/components/UsagePanel';
import { PastSessions } from '../src/components/PastSessions';
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
  latency: { ttfaMedianMs: 812, ttfaP95Ms: 1403, ttfaMinMs: 640, ttfaMaxMs: 1403 },
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
  'Conversation ended',
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

check('UsagePanel (realtime shape)', () =>
  renderToString(h(UsagePanel, {
    usage: [{
      turnId: 1, at: Date.now(), costUsd: 0, costInr: 0, unpriced: [],
      legs: [{ leg: 'realtime' as const, providerId: 'mock-realtime', modelId: 'mock-s2s',
        unit: 'audio_seconds' as const, inputUnits: 2, outputUnits: 4, source: 'local' as const }],
    }],
  })), ['Audio in', 'Audio out']);

check('UsagePanel with an unpriced leg', () =>
  renderToString(h(UsagePanel, {
    usage: [{
      turnId: 1, at: Date.now(), costUsd: 0, costInr: 0, unpriced: ['elevenlabs-tts:v3'],
      legs: [{ leg: 'tts' as const, providerId: 'elevenlabs-tts', modelId: 'v3',
        unit: 'characters' as const, inputUnits: 0, outputUnits: 100, source: 'local' as const,
        unpricedReason: 'No rate on file' }],
    }],
  })), ['floor, not a bill']);

check('PastSessions (pre-fetch)', () => renderToString(h(PastSessions, { refreshKey: 0 })), ['Past conversations']);

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

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log('\nALL PANELS RENDER');
