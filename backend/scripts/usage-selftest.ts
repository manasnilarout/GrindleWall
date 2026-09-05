/**
 * Checks the money arithmetic against hand-computed values.
 *
 *   npm run usage:selftest
 *
 * Every expectation below is derived from the vendor's published denomination
 * (₹30 per 10K characters, $0.30 per 1M tokens, 3 credits per second) rather
 * than from what the code happens to produce, so a wrong rate or a unit slip
 * fails here instead of quietly showing a plausible number in the UI.
 *
 * Needs no API key and touches no network.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LegUsage, StartConfig } from '../src/shared/protocol.js';
import { priceLeg, rateFor, effective, inrPerUsd, usdPerInr } from '../src/pricing/rates.js';
import { UsageLedger } from '../src/pricing/UsageLedger.js';
import { SessionStore } from '../src/store/SessionStore.js';
import { redactSecrets } from '../src/config.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) < 1e-9
      : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
    console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(name: string, condition: boolean, detail = ''): void {
  check(name + (detail ? ` (${detail})` : ''), condition, true);
}

const leg = (over: Partial<LegUsage>): LegUsage => ({
  leg: 'llm',
  providerId: 'google-llm',
  modelId: 'gemini-3.5-flash-lite',
  unit: 'tokens',
  inputUnits: 0,
  outputUnits: 0,
  source: 'vendor',
  ...over,
});

console.log('\nGemini — $0.30 in / $2.50 out per 1M tokens (gemini-3.5-flash-lite)');
{
  const p = priceLeg(leg({ inputUnits: 1_000_000 }));
  check('1M input tokens = $0.30', p.cost?.amount, 0.3);
  check('...and USD equals native for a USD vendor', p.cost?.amountUsd, 0.3);
  check('...with the rupee equivalent alongside', p.cost?.amountInr, Number((0.3 / usdPerInr).toFixed(6)));
  check('currency is USD', p.cost?.currency, 'USD');

  check('1M output tokens = $2.50', priceLeg(leg({ outputUnits: 1_000_000 })).cost?.amount, 2.5);
  check(
    'a realistic voice turn (900 in / 40 out)',
    priceLeg(leg({ inputUnits: 900, outputUnits: 40 })).cost?.amount,
    Number((900 * 3e-7 + 40 * 2.5e-6).toFixed(8)),
  );
}

console.log('\nGemini — cached input is billed at the cache rate, not twice');
{
  // 1M input of which 800K cached: 200K @ $0.30/M + 800K @ $0.03/M.
  const p = priceLeg(leg({ inputUnits: 1_000_000, cachedInputTokens: 800_000 }));
  check('cache discount applied', p.cost?.amount, Number((200_000 * 3e-7 + 800_000 * 3e-8).toFixed(8)));
  ok('cheaper than billing it all at full rate', (p.cost?.amount ?? 1) < 0.3);
}

console.log('\nGemini — thinking tokens ride the output rate and are not double counted');
{
  // The provider folds thinking into outputTokens; thinkingTokens is a breakdown only.
  const p = priceLeg(leg({ outputUnits: 300, thinkingTokens: 200 }));
  check('300 output (200 of them thinking) prices as 300', p.cost?.amount, Number((300 * 2.5e-6).toFixed(8)));
}

console.log('\nGemini — model-variant suffixes are stripped before lookup');
{
  ok('gemini-3.8-flash@off resolves', rateFor('google-llm', 'gemini-3.8-flash@off') !== undefined);
  ok('gemini-3.5-flash-lite@minimal resolves', rateFor('google-llm', 'gemini-3.5-flash-lite@minimal') !== undefined);
  check(
    'the suffix does not change the price',
    priceLeg(leg({ modelId: 'gemini-3.5-flash-lite@high', outputUnits: 1_000_000 })).cost?.amount,
    2.5,
  );
}

console.log("\nGemini — Google's promotional Flash rate steps up on 2027-01-01");
{
  const promo = rateFor('google-llm', 'gemini-3.8-flash')!;
  const before = priceLeg(leg({ modelId: 'gemini-3.8-flash', inputUnits: 1_000_000 }), Date.parse('2026-09-05'));
  const after = priceLeg(leg({ modelId: 'gemini-3.8-flash', inputUnits: 1_000_000 }), Date.parse('2027-01-15'));
  check('today: $0.75 per 1M input', before.cost?.amount, 0.75);
  check('2027: $1.50 per 1M input', after.cost?.amount, 1.5);
  ok('the expiry is recorded on the rate', effective(promo, Date.parse('2027-01-15')).note?.includes('expired') === true);
}

console.log('\nSarvam — ₹30 per 10K characters (TTS) and ₹30 per hour (STT)');
{
  const tts = priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v3', unit: 'characters', outputUnits: 10_000, source: 'local' }));
  check('10K characters = ₹30', tts.cost?.amount, 30);
  check('...reported in rupees', tts.cost?.currency, 'INR');
  check('...the rupee figure is the vendor’s own, unconverted', tts.cost?.amountInr, 30);
  check('...converted for the USD column', tts.cost?.amountUsd, Number((30 * usdPerInr).toFixed(8)));

  const stt = priceLeg(leg({ leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 3600, source: 'local' }));
  check('one hour of audio = ₹30', stt.cost?.amount, 30);
}
{
  const stt = priceLeg(leg({ leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v4-realtime@balanced', unit: 'audio_seconds', inputUnits: 4, source: 'local' }));
  check('4s of audio = ₹30 * 4/3600', stt.cost?.amount, Number(((30 / 3600) * 4).toFixed(8)));
  ok('an unlisted Saaras model still prices via the provider fallback', stt.cost !== undefined);
}

console.log('\nCartesia — 1 credit/char, ink-2 3 credits/s, ink-whisper 1 credit/s');
{
  const perCredit = 5 / 100_000;
  const tts = priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 1000, source: 'local' }));
  check('1000 characters = 1000 credits', tts.cost?.amount, Number((1000 * perCredit).toFixed(8)));

  const ink2 = priceLeg(leg({ leg: 'stt', providerId: 'cartesia-stt', modelId: 'ink-2', unit: 'audio_seconds', inputUnits: 10, source: 'local' }));
  const whisper = priceLeg(leg({ leg: 'stt', providerId: 'cartesia-stt', modelId: 'ink-whisper', unit: 'audio_seconds', inputUnits: 10, source: 'local' }));
  check('ink-2: 10s = 30 credits', ink2.cost?.amount, Number((30 * perCredit).toFixed(8)));
  check('ink-whisper: 10s = 10 credits', whisper.cost?.amount, Number((10 * perCredit).toFixed(8)));
  ok('ink-2 costs 3x ink-whisper', Math.abs((ink2.cost!.amount) - 3 * whisper.cost!.amount) < 1e-9);
}

console.log('\nMurf — priced, but flagged because the vendor’s own sources disagree');
{
  const p = priceLeg(leg({ leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', outputUnits: 1000, source: 'local' }));
  check('1000 characters = $0.03', p.cost?.amount, 0.03);
  check('flagged ambiguous', p.cost?.confidence, 'ambiguous');
  ok('the conflict is spelled out', (p.cost?.note ?? '').includes('1 cent per minute'));
}

console.log('\nOpenAI Realtime — audio and text tokens are two prices in one request');
{
  const rt = (over: Partial<LegUsage>) =>
    leg({ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', ...over });

  // gpt-realtime-2.1: audio $32 in / $64 out, text $4 in / $24 out, per 1M.
  check(
    '1M audio input tokens = $32, not the $4 text price',
    priceLeg(rt({ inputUnits: 1_000_000, audioInputTokens: 1_000_000 })).cost?.amount,
    32,
  );
  check(
    '1M text input tokens = $4',
    priceLeg(rt({ inputUnits: 1_000_000 })).cost?.amount,
    4,
  );

  // The audio count sits INSIDE inputUnits, so the remainder is text.
  check(
    'a mixed turn bills each half at its own rate',
    priceLeg(rt({ inputUnits: 1000, audioInputTokens: 900 })).cost?.amount,
    Number((900 * 32e-6 + 100 * 4e-6).toFixed(8)),
  );
  check(
    'output splits the same way',
    priceLeg(rt({ outputUnits: 1000, audioOutputTokens: 800 })).cost?.amount,
    Number((800 * 64e-6 + 200 * 24e-6).toFixed(8)),
  );

  // Cached audio is inside BOTH cachedInputTokens and audioInputTokens; billing
  // it twice, or at the uncached audio rate, are the two easy mistakes.
  check(
    'cached audio bills at the cache rate and only once',
    priceLeg(rt({ inputUnits: 1000, audioInputTokens: 1000, cachedInputTokens: 400, cachedAudioInputTokens: 400 }))
      .cost?.amount,
    Number((600 * 32e-6 + 400 * 0.4e-6).toFixed(8)),
  );

  const mini = priceLeg(
    leg({ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1-mini', inputUnits: 1_000_000, audioInputTokens: 1_000_000 }),
  );
  check('the mini model is cheaper per audio token', mini.cost?.amount, 10);

  // The trap this guard exists for: a vendor whose rate has one token price
  // must never quietly bill audio tokens at it — on the flagship that would
  // understate the turn 8x while still looking like a number.
  const wrongRate = priceLeg(leg({ inputUnits: 1000, audioInputTokens: 1000 }));
  ok('audio tokens against a text-only rate refuse to price', wrongRate.cost === undefined);
  ok('...and say why', (wrongRate.unpricedReason ?? '').includes('audio tokens'));
}

console.log('\nCached realtime tokens make a turn cheaper, never dearer');
{
  const rt = (over: Partial<LegUsage>) =>
    priceLeg(leg({ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', ...over }));
  const AUDIO = 32e-6;
  const CACHED_AUDIO = 0.4e-6;

  // OpenAI omits cached_tokens_details when there is nothing text-side to
  // report, leaving only the cached_tokens total. Treating that remainder as
  // TEXT cache bills tokens the leg never reported — and because a realtime
  // conversation resends its whole history every turn, the cached share grows
  // with the conversation, so the error grows with it too.
  const allAudioCached = rt({ inputUnits: 10_000, audioInputTokens: 10_000, cachedInputTokens: 9_000 });
  check(
    '9K of 10K audio tokens cached, no per-modality detail',
    allAudioCached.cost?.amount,
    Number((1_000 * AUDIO + 9_000 * CACHED_AUDIO).toFixed(8)),
  );
  ok(
    '...which is far cheaper than the same turn uncached',
    (allAudioCached.cost?.amount ?? 0) < (rt({ inputUnits: 10_000, audioInputTokens: 10_000 }).cost?.amount ?? 0),
  );
  ok(
    '...and never bills more tokens than the leg reported',
    (allAudioCached.cost?.amount ?? 0) <= 10_000 * AUDIO,
  );

  // An explicit split must still win over the derivation.
  check(
    'an explicit cachedAudioInputTokens is honoured as given',
    rt({ inputUnits: 1000, audioInputTokens: 900, cachedInputTokens: 400, cachedAudioInputTokens: 300 }).cost?.amount,
    Number((600 * AUDIO + 300 * CACHED_AUDIO + 100 * 0.4e-6).toFixed(8)),
  );

  // And a pure-text leg must be untouched by any of this.
  check(
    'a text-only leg still prices on the text rates',
    rt({ inputUnits: 1000, cachedInputTokens: 400 }).cost?.amount,
    Number((600 * 4e-6 + 400 * 0.4e-6).toFixed(8)),
  );

  // The mixed line: audio and text BOTH nonzero on input, and both partly
  // cached. Every other realtime check here has textIn == 0, so the text half
  // of the split was never exercised with a nonzero result.
  // 450*$32 + 250*$0.40 + 150*$4 + 150*$0.40 per 1M.
  check(
    'a leg with audio and text, both partly cached',
    rt({ inputUnits: 1000, audioInputTokens: 700, cachedInputTokens: 400, cachedAudioInputTokens: 250 }).cost?.amount,
    Number((450 * 32e-6 + 250 * 0.4e-6 + 150 * 4e-6 + 150 * 0.4e-6).toFixed(8)),
  );
}

console.log('\nA breakdown bigger than its total is refused, not clamped into a plausible number');
{
  const rt = (over: Partial<LegUsage>) =>
    priceLeg(leg({ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', ...over }));

  // Every field below is documented as counted INSIDE its total. A provider that
  // reported them additively would, without this guard, have the excess absorbed
  // by a clamp and be billed a number that looks entirely reasonable — 500 audio
  // tokens charged on a leg whose own total says 100.
  const overAudioIn = rt({ inputUnits: 100, audioInputTokens: 500 });
  ok('audioInputTokens > inputUnits is unpriced', overAudioIn.cost === undefined);
  ok('...and names the contradiction', (overAudioIn.unpricedReason ?? '').includes('audioInputTokens'));

  ok('audioOutputTokens > outputUnits is unpriced', rt({ outputUnits: 10, audioOutputTokens: 1000 }).cost === undefined);
  ok('cachedInputTokens > inputUnits is unpriced', rt({ inputUnits: 100, cachedInputTokens: 500 }).cost === undefined);
  ok(
    'cachedAudioInputTokens beyond its two parents is unpriced',
    rt({ inputUnits: 1000, audioInputTokens: 1000, cachedInputTokens: 100, cachedAudioInputTokens: 900 }).cost === undefined,
  );

  // The guard must not fire on well-formed usage — including the boundary case
  // where the breakdown exactly equals its total, which is the common one.
  ok('a leg whose breakdown equals its total still prices', rt({ inputUnits: 1000, audioInputTokens: 1000 }).cost !== undefined);
  ok('a leg with no audio fields at all still prices', rt({ inputUnits: 1000, outputUnits: 100 }).cost !== undefined);
}

console.log('\nElevenLabs — dollars per character, and the rate is per model');
{
  const el = (modelId: string, chars: number) =>
    priceLeg(leg({ leg: 'tts', providerId: 'elevenlabs-tts', modelId, unit: 'characters', outputUnits: chars, source: 'local' }));

  // Billed in USD per character. The subscription CREDIT pool is a different
  // billing system; pricing this leg off credits overstates it ~3x, which is
  // the mistake these two checks exist to catch.
  check('flash: 1000 characters = $0.05', el('eleven_flash_v2_5', 1000).cost?.amount, 0.05);
  check('multilingual_v2 is twice the price', el('eleven_multilingual_v2', 1000).cost?.amount, 0.1);
  ok(
    'an unlisted model falls back to the expensive tier, not the cheap one',
    (el('eleven_something_new', 1000).cost?.amount ?? 0) === 0.1,
  );
  check('reported in USD, the currency the vendor bills in', el('eleven_flash_v2_5', 1000).cost?.currency, 'USD');
}

console.log('\nOpenAI LLM — $0.20 in / $1.20 out per 1M (gpt-5.6-luna), suffix stripped');
{
  const o = (over: Partial<LegUsage>) => leg({ providerId: 'openai-llm', modelId: 'gpt-5.6-luna', ...over });
  check('1M input tokens = $0.20', priceLeg(o({ inputUnits: 1_000_000 })).cost?.amount, 0.2);
  check('1M output tokens = $1.20', priceLeg(o({ outputUnits: 1_000_000 })).cost?.amount, 1.2);
  ok('the @variant suffix resolves to the same rate', rateFor('openai-llm', 'gpt-5.6-luna@none') !== undefined);
  check(
    'reasoning effort does not change the price per token',
    priceLeg(o({ modelId: 'gpt-5.6-luna@medium', outputUnits: 1_000_000 })).cost?.amount,
    1.2,
  );
  // Reasoning tokens are folded into outputTokens by the provider, exactly as
  // Gemini's thinking tokens are, so 300 output of which 200 reasoning is 300.
  check(
    'reasoning tokens ride the output rate, once',
    priceLeg(o({ outputUnits: 300, thinkingTokens: 200 })).cost?.amount,
    Number((300 * 1.2e-6).toFixed(8)),
  );
  ok('a model with no @variant still resolves', rateFor('openai-llm', 'gpt-4o-mini') !== undefined);
}

console.log('\nGemini speech — the STT leg prices, the TTS leg cannot');
{
  const stt = priceLeg(
    leg({ leg: 'stt', providerId: 'gemini-stt', modelId: 'gemini-3.5-transcribe-live', unit: 'audio_seconds', inputUnits: 60, source: 'local' }),
  );
  check('one minute of audio = $0.009', stt.cost?.amount, Number((0.009).toFixed(8)));
  check('flagged ambiguous — it is a blended rate', stt.cost?.confidence, 'ambiguous');

  // Google bills Gemini TTS per token; this leg counts characters. The rate is
  // on file so the gap explains itself rather than reading as "no rate".
  const tts = priceLeg(
    leg({ leg: 'tts', providerId: 'gemini-tts', modelId: 'gemini-2.5-flash-preview-tts', unit: 'characters', outputUnits: 1000, source: 'local' }),
  );
  ok('a character count against a token rate refuses to price', tts.cost === undefined);
  ok('...and names the mismatch', (tts.unpricedReason ?? '').includes('per tokens'));
}

console.log('\nMock providers are free, so a mock run costs nothing');
{
  check('mock TTS', priceLeg(leg({ leg: 'tts', providerId: 'mock-tts', modelId: 'mock-voice', unit: 'characters', outputUnits: 5000, source: 'local' })).cost?.amount, 0);
  check('mock LLM', priceLeg(leg({ providerId: 'mock-llm', modelId: 'mock-chat', inputUnits: 999, outputUnits: 999, source: 'local' })).cost?.amount, 0);
}

console.log('\nMissing or mismatched rates are reported, never silently zeroed');
{
  const unknown = priceLeg(leg({ providerId: 'deepgram-tts', modelId: 'whatever' }));
  ok('no cost is invented', unknown.cost === undefined);
  ok('and the reason is stated', (unknown.unpricedReason ?? '').includes('No rate on file'));

  // Sarvam TTS bills per character; handing it seconds must not be priced as characters.
  const mismatch = priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v3', unit: 'audio_seconds', outputUnits: 100, source: 'local' }));
  ok('a unit mismatch refuses to price', mismatch.cost === undefined);
  ok('...and says why', (mismatch.unpricedReason ?? '').includes('per characters'));
}

console.log('\nBoth currencies are carried on every leg, whichever the vendor bills in');
{
  const inrNative = priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v3', unit: 'characters', outputUnits: 10_000, source: 'local' })).cost!;
  const usdNative = priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 1000, source: 'local' })).cost!;

  ok('a rupee-billed leg still reports USD', inrNative.amountUsd > 0);
  ok('a dollar-billed leg still reports INR', usdNative.amountInr > 0);
  check('USD -> INR round trips', Number((usdNative.amountUsd / usdPerInr).toFixed(6)), usdNative.amountInr);
  check('INR -> USD round trips', Number((inrNative.amountInr * usdPerInr).toFixed(8)), inrNative.amountUsd);
  check('the two FX constants agree', Number((1 / inrPerUsd).toFixed(10)), Number(usdPerInr.toFixed(10)));
  ok('a rupee is worth less than a dollar', inrPerUsd > 1);
}

console.log('\nLedger — totals are the sum of the turns the UI already showed');
{
  const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const ledger = new UsageLedger('sess', 'pipeline', 'test', config);

  const turnLegs = (): LegUsage[] => [
    leg({ leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 3, source: 'local' }),
    leg({ inputUnits: 500, outputUnits: 50, thinkingTokens: 10 }),
    leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 200, audioSeconds: 4, source: 'local' }),
  ];

  const t1 = ledger.record(1, turnLegs());
  const t2 = ledger.record(2, turnLegs());
  // The production path is noteLatency; noteTtfa alone exercises a call the
  // socket no longer makes.
  ledger.noteLatency({ timeToFirstAudioMs: 400, sttLatencyMs: 210, llmTtftMs: 140, ttsTtfbMs: 180, audioDurationMs: 2600 });
  ledger.noteLatency({ timeToFirstAudioMs: 600, sttLatencyMs: 230, llmTtftMs: 160, ttsTtfbMs: 200, audioDurationMs: 3000 });
  const s = ledger.summary();

  check('turn count', s.turnCount, 2);
  check('total is the sum of both turns', s.costUsd, Number((t1.costUsd + t2.costUsd).toFixed(8)));
  check('...in rupees too', s.costInr, Number((t1.costInr + t2.costInr).toFixed(6)));
  ok('the two session totals describe the same money',
    Math.abs(s.costUsd - s.costInr * usdPerInr) < 1e-6);
  check('one totals row per leg', s.totals.length, 3);
  check('LLM input tokens doubled', s.totals.find((l) => l.leg === 'llm')?.inputUnits, 1000);
  check('thinking tokens doubled', s.totals.find((l) => l.leg === 'llm')?.thinkingTokens, 20);
  check('TTS characters doubled', s.totals.find((l) => l.leg === 'tts')?.outputUnits, 400);
  check('TTS audio seconds doubled', s.totals.find((l) => l.leg === 'tts')?.audioSeconds, 8);
  check('STT seconds doubled', s.totals.find((l) => l.leg === 'stt')?.inputUnits, 6);
  check('median TTFA is the midpoint of the pair, not the upper value', s.latency.ttfaMedianMs, 500);
  /*
   * Each leg is banked into its own array. A single shared array would still
   * produce plausible medians while pairing the n-th STT figure with an
   * unrelated turn's TTS figure — and the compare view is built entirely on
   * these numbers, so a mix-up there is invisible and permanent.
   */
  check('STT median is the STT figures', s.latency.sttMedianMs, 220);
  check('LLM TTFT median is the LLM figures', s.latency.llmTtftMedianMs, 150);
  check('TTS TTFB median is the TTS figures', s.latency.ttsTtfbMedianMs, 190);
  check('audio duration median is the audio figures', s.latency.audioMedianMs, 2800);
  ok('no leg borrowed another leg\'s numbers',
    s.latency.sttMedianMs !== s.latency.llmTtftMedianMs &&
    s.latency.llmTtftMedianMs !== s.latency.ttsTtfbMedianMs);
  check('the FX assumption is on the record', s.usdPerInr, usdPerInr);
  ok('rupee and dollar legs both counted', s.costUsd > 0);
}

console.log('\nLedger — a leg that never reported has no median, not a zero');
{
  const config = { mode: 'realtime', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const l = new UsageLedger('s', 'realtime', 't', config);
  l.noteLatency({ timeToFirstAudioMs: 441, ttsTtfbMs: 441, audioDurationMs: 2260 });
  const { latency } = l.summary();
  check('TTFA is recorded', latency.ttfaMedianMs, 441);
  ok('no STT median on a speech-to-speech run', latency.sttMedianMs === undefined);
  ok('no LLM median either', latency.llmTtftMedianMs === undefined);
  ok('a zero would render as a vendor that answered instantly',
    latency.sttMedianMs !== 0 && latency.llmTtftMedianMs !== 0);
}

console.log('\nLedger — latency summary statistics');
{
  const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const build = (ttfas: number[]) => {
    const l = new UsageLedger('s', 'pipeline', 't', config);
    for (const v of ttfas) l.noteLatency({ timeToFirstAudioMs: v });
    return l.summary().latency;
  };

  check('odd count takes the middle value', build([100, 200, 900]).ttfaMedianMs, 200);
  check('even count averages the middle pair', build([400, 600]).ttfaMedianMs, 500);
  check('a single sample is its own median', build([250]).ttfaMedianMs, 250);
  check('order does not matter', build([900, 100, 200]).ttfaMedianMs, 200);

  // Nearest-rank: p95 must be a real observation at or above the 95th percentile.
  check('p95 of a small sample is the worst one', build([100, 200]).ttfaP95Ms, 200);
  check('p95 of 20 samples', build(Array.from({ length: 20 }, (_, i) => (i + 1) * 10)).ttfaP95Ms, 190);
  check('p95 of 100 samples', build(Array.from({ length: 100 }, (_, i) => i + 1)).ttfaP95Ms, 95);
  const wide = build([10, 20, 30, 40, 5000]);
  check('an outlier shows up in p95, not the median', [wide.ttfaMedianMs, wide.ttfaP95Ms], [30, 5000]);
  check('min and max', [wide.ttfaMinMs, wide.ttfaMaxMs], [10, 5000]);
}

console.log('\nLedger — an unpriced leg makes the total a floor, and says so');
{
  const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const ledger = new UsageLedger('sess', 'pipeline', 'test', config);
  ledger.record(1, [leg({ leg: 'tts', providerId: 'deepgram-tts', modelId: 'aura-2-thalia-en', unit: 'characters', outputUnits: 100, source: 'local' })]);
  const s = ledger.summary();
  check('flagged on the session', s.unpriced, ['deepgram-tts:aura-2-thalia-en']);
  check('and contributes nothing to the total', s.costUsd, 0);
}

console.log('\nStore — a session survives a round trip to disk');
{
  const dir = await mkdtemp(join(tmpdir(), 'voicebench-'));
  try {
    const store = new SessionStore(dir);
    const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
    const ledger = new UsageLedger('sess', 'pipeline', 'sarvam → gemini → cartesia', config);
    ledger.record(1, [leg({ inputUnits: 100, outputUnits: 20 })]);
    const summary = ledger.summary();

    await store.save(summary);
    // Saved again mid-conversation, as the socket layer does after every turn.
    await store.save(summary);

    const list = await store.list();
    check('one record, not one per save', list.length, 1);
    check('index carries the label', list[0]?.label, 'sarvam → gemini → cartesia');
    check('index carries the USD cost', list[0]?.costUsd, summary.costUsd);
    check('index carries the INR cost', list[0]?.costInr, summary.costInr);

    const back = await store.get(summary.recordId);
    check('round trip preserves the cost', back?.costUsd, summary.costUsd);
    check('round trip preserves the turns', back?.turns.length, 1);
    ok('a traversal id is rejected', (await store.get('../../etc/passwd')) === undefined);
    ok('an unknown id returns nothing', (await store.get('nope')) === undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\nA provider that leaks its credentials into an error must not reach the client');
{
  process.env.TEST_FAKE_API_KEY = 'sk-super-secret-value-1234';
  const leaked = redactSecrets('Vendor 401: bad key sk-super-secret-value-1234 for endpoint /v1');
  ok('the secret is gone', !leaked.includes('sk-super-secret-value-1234'));
  ok('and the reader is told what was removed', leaked.includes('TEST_FAKE_API_KEY'));
  ok('the rest of the message survives', leaked.includes('Vendor 401') && leaked.includes('/v1'));

  process.env.TEST_SHORT_KEY = 'abc';
  check('short values are left alone — too many false positives', redactSecrets('abc def'), 'abc def');
  process.env.TEST_PLAIN_SETTING = 'a-long-ordinary-value-here';
  check('only secret-shaped variable names are scrubbed', redactSecrets('a-long-ordinary-value-here'), 'a-long-ordinary-value-here');
  delete process.env.TEST_FAKE_API_KEY;
  delete process.env.TEST_SHORT_KEY;
  delete process.env.TEST_PLAIN_SETTING;
}

console.log('\nStore — overlapping unawaited saves must not corrupt the record');
{
  const dir = await mkdtemp(join(tmpdir(), 'voicebench-race-'));
  try {
    const store = new SessionStore(dir);
    const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
    const ledger = new UsageLedger('sess', 'pipeline', 'race', config);

    // Grow the record between saves so the writes differ in length — that is
    // what turned an interleave into a file that would not parse.
    const fired: Array<Promise<void>> = [];
    for (let i = 1; i <= 12; i++) {
      ledger.record(i, [leg({ inputUnits: 100 * i, outputUnits: 50 * i })]);
      fired.push(store.save(ledger.summary())); // fire-and-forget, as the socket layer does
    }
    await Promise.all(fired);

    const list = await store.list();
    check('exactly one record survives', list.length, 1);
    const back = await store.get(ledger.recordId);
    ok('and it parses', back !== undefined);
    check('with every turn intact', back?.turns.length, 12);
    check('and the last write wins', back?.turnCount, 12);

    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    check('no temp files are left behind', leftovers.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\nStore — retention is opt-in, and off by default');
{
  const dir = await mkdtemp(join(tmpdir(), 'voicebench-prune-'));
  try {
    const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
    const write = async (store: SessionStore, n: number) => {
      for (let i = 0; i < n; i++) {
        const l = new UsageLedger(`s${i}`, 'pipeline', 't', config);
        l.record(1, [leg({ inputUnits: 10 })]);
        await store.save(l.summary());
        await new Promise((r) => setTimeout(r, 2)); // distinct startedAt
      }
    };

    const unbounded = new SessionStore(dir);
    await write(unbounded, 5);
    check('nothing is deleted without a cap', (await unbounded.list()).length, 5);

    const capped = new SessionStore(dir, 3);
    await write(capped, 1);
    const kept = await capped.list();
    check('a cap keeps only the newest', kept.length, 3);
    ok('and it keeps the newest, not the oldest', kept[0].startedAt >= kept[2].startedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`\n${'-'.repeat(60)}`);
if (failures.length) {
  console.log(`${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
