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

console.log('\nMock providers are free, so a mock run costs nothing');
{
  check('mock TTS', priceLeg(leg({ leg: 'tts', providerId: 'mock-tts', modelId: 'mock-voice', unit: 'characters', outputUnits: 5000, source: 'local' })).cost?.amount, 0);
  check('mock LLM', priceLeg(leg({ providerId: 'mock-llm', modelId: 'mock-chat', inputUnits: 999, outputUnits: 999, source: 'local' })).cost?.amount, 0);
}

console.log('\nMissing or mismatched rates are reported, never silently zeroed');
{
  const unknown = priceLeg(leg({ providerId: 'elevenlabs-tts', modelId: 'whatever' }));
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
  ledger.noteTtfa(400);
  ledger.noteTtfa(600);
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
  check('the FX assumption is on the record', s.usdPerInr, usdPerInr);
  ok('rupee and dollar legs both counted', s.costUsd > 0);
}

console.log('\nLedger — latency summary statistics');
{
  const config = { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const build = (ttfas: number[]) => {
    const l = new UsageLedger('s', 'pipeline', 't', config);
    for (const v of ttfas) l.noteTtfa(v);
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
  ledger.record(1, [leg({ leg: 'tts', providerId: 'elevenlabs-tts', modelId: 'v3', unit: 'characters', outputUnits: 100, source: 'local' })]);
  const s = ledger.summary();
  check('flagged on the session', s.unpriced, ['elevenlabs-tts:v3']);
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
