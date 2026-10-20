import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegUsage } from '../../../src/shared/protocol.js';
import type { Rate } from '../../../src/pricing/rates.js';

/**
 * rates.ts reads USD_PER_INR, CARTESIA_USD_PER_CREDIT, AWS_REGION and
 * AWS_DEFAULT_REGION once, at import. Every test loads a fresh module instance
 * with ALL FOUR pinned (unset unless given), so a developer's shell cannot leak
 * into the numbers.
 *
 * Every expected amount below is hand-computed from the vendor denomination in
 * the comment beside it — never by calling back into the code under test.
 */
type RatesModule = typeof import('../../../src/pricing/rates.js');
const ENV_KEYS = ['USD_PER_INR', 'CARTESIA_USD_PER_CREDIT', 'AWS_REGION', 'AWS_DEFAULT_REGION'] as const;

async function loadRates(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): Promise<RatesModule> {
  vi.resetModules();
  for (const k of ENV_KEYS) vi.stubEnv(k, env[k]);
  return import('../../../src/pricing/rates.js');
}

const leg = (o: Partial<LegUsage> & Pick<LegUsage, 'providerId' | 'modelId'>): LegUsage => ({
  leg: 'llm',
  unit: 'tokens',
  inputUnits: 0,
  outputUnits: 0,
  source: 'vendor',
  ...o,
});

/** A moment well inside Google's promotional window, and one well past it. */
const PROMO = Date.parse('2026-10-20T12:00:00Z');
const POST_PROMO = Date.parse('2027-02-01T12:00:00Z');
const STEP_BOUNDARY = Date.parse('2026-12-31T23:59:59Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('FX: usdPerInr / inrPerUsd / USD_PER_INR', () => {
  it('defaults to ₹94.43 per $1, read on 2026-09-05', async () => {
    const r = await loadRates();
    expect(r.usdPerInr).toBe(1 / 94.43);
    expect(r.inrPerUsd).toBeCloseTo(94.43, 10);
    expect(r.FX_CHECKED_ON).toBe('2026-09-05');
  });

  it('the two constants are reciprocals', async () => {
    const r = await loadRates();
    expect(r.usdPerInr * r.inrPerUsd).toBeCloseTo(1, 12);
  });

  it('a valid USD_PER_INR overrides both directions', async () => {
    const r = await loadRates({ USD_PER_INR: '0.0125' }); // ₹80 / $1
    expect(r.usdPerInr).toBe(0.0125);
    expect(r.inrPerUsd).toBe(80);
  });

  it('a valid override flows into every converted figure', async () => {
    const r = await loadRates({ USD_PER_INR: '0.0125' });
    // Sarvam bills ₹30 per 10K chars; at ₹80/$ that is $0.375.
    const sarvam = r.priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v3', unit: 'characters', outputUnits: 10_000 }));
    expect(sarvam.cost?.amount).toBe(30);
    expect(sarvam.cost?.amountInr).toBe(30);
    expect(sarvam.cost?.amountUsd).toBe(0.375);
    // Gemini Flash-Lite $0.30 per 1M in; at ₹80/$ that is ₹24.
    const gem = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', inputUnits: 1_000_000 }));
    expect(gem.cost?.amountUsd).toBe(0.3);
    expect(gem.cost?.amountInr).toBe(24);
  });

  it('accepts scientific notation and surrounding whitespace (Number() semantics)', async () => {
    expect((await loadRates({ USD_PER_INR: '1.25e-2' })).usdPerInr).toBe(0.0125);
    expect((await loadRates({ USD_PER_INR: ' 0.0125 ' })).usdPerInr).toBe(0.0125);
  });

  it.each([
    ['junk', 'abc'],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-0.0125'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['a unit suffix', '0.0125USD'],
  ])('a %s USD_PER_INR falls back to the default rather than poisoning every figure', async (_label, raw) => {
    const r = await loadRates({ USD_PER_INR: raw });
    expect(r.usdPerInr).toBe(1 / 94.43);
    expect(r.inrPerUsd).toBeCloseTo(94.43, 10);
  });
});

describe('CARTESIA_USD_PER_CREDIT', () => {
  it('defaults to the Pro plan: $5 per 100K credits = $0.00005/credit', async () => {
    const r = await loadRates();
    // 1 credit per character: 1000 chars = 1000 credits = $0.05
    const tts = r.priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 1000 }));
    expect(tts.cost?.amount).toBe(0.05);
    expect(tts.cost?.currency).toBe('USD');
    expect(tts.cost?.rate).toBe('1 credit/char @ $0.0000500/credit');
  });

  it('ink-2 meters 3 credits/s, ink-whisper 1 credit/s, an unknown STT model the ink-2 rate', async () => {
    const r = await loadRates();
    const stt = (modelId: string) =>
      r.priceLeg(leg({ leg: 'stt', providerId: 'cartesia-stt', modelId, unit: 'audio_seconds', inputUnits: 10 }));
    expect(stt('ink-2').cost?.amount).toBe(0.0015); // 30 credits
    expect(stt('ink-2').cost?.rate).toBe('3 credits/s @ $0.0000500/credit');
    expect(stt('ink-whisper').cost?.amount).toBe(0.0005); // 10 credits
    expect(stt('ink-whisper').cost?.rate).toBe('1 credit/s @ $0.0000500/credit');
    expect(stt('ink-3').cost?.amount).toBe(0.0015);
  });

  it('a valid override reprices TTS and both STT models', async () => {
    // Startup plan: $49 per 1.25M credits = $0.0000392/credit
    const r = await loadRates({ CARTESIA_USD_PER_CREDIT: '0.0000392' });
    const tts = r.priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-2', unit: 'characters', outputUnits: 1000 }));
    expect(tts.cost?.amount).toBe(0.0392);
    expect(tts.cost?.rate).toBe('1 credit/char @ $0.0000392/credit');
    const ink2 = r.priceLeg(leg({ leg: 'stt', providerId: 'cartesia-stt', modelId: 'ink-2', unit: 'audio_seconds', inputUnits: 10 }));
    expect(ink2.cost?.amount).toBe(0.001176); // 30 credits * 0.0000392
  });

  it.each([['junk', 'free'], ['empty', ''], ['zero', '0'], ['negative', '-0.00005'], ['Infinity', 'Infinity']])(
    'a %s override falls back to the Pro rate',
    async (_label, raw) => {
      const r = await loadRates({ CARTESIA_USD_PER_CREDIT: raw });
      const tts = r.priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 1000 }));
      expect(tts.cost?.amount).toBe(0.05);
    },
  );

  it('does not move any other vendor', async () => {
    const r = await loadRates({ CARTESIA_USD_PER_CREDIT: '1' });
    const murf = r.priceLeg(leg({ leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', outputUnits: 1000 }));
    expect(murf.cost?.amount).toBe(0.03);
  });
});

describe('AWS Nova Sonic: per-region rates resolved from the environment', () => {
  const NOVA = 'amazon.nova-2-sonic-v1:0';
  const nova = (o: Partial<LegUsage>): LegUsage =>
    leg({ leg: 'realtime', providerId: 'aws-nova-sonic', modelId: NOVA, ...o });

  it('defaults to us-east-1 when neither region variable is set', async () => {
    const r = await loadRates();
    const rate = r.rateFor('aws-nova-sonic', NOVA);
    expect(rate?.rate).toBe('speech $3/$12 · text $0.33/$2.75 per 1M tokens (us-east-1)');
    expect(rate?.note).toContain('Priced for us-east-1');
  });

  it.each([
    // region, speech in, speech out, text in, text out — $ per 1M tokens
    ['us-east-1', 3, 12, 0.33, 2.75],
    ['us-west-2', 3, 12, 0.319, 2.651],
    ['eu-north-1', 2.91, 11.65, 0.363, 2.992],
    ['ap-northeast-1', 3.63, 14.52, 0.396, 3.311],
  ])('%s: 1M of each token kind prices at the published figure', async (region, sIn, sOut, tIn, tOut) => {
    const r = await loadRates({ AWS_REGION: region });
    const M = 1_000_000;
    expect(r.priceLeg(nova({ inputUnits: M, audioInputTokens: M })).cost?.amount).toBe(sIn);
    expect(r.priceLeg(nova({ outputUnits: M, audioOutputTokens: M })).cost?.amount).toBe(sOut);
    expect(r.priceLeg(nova({ inputUnits: M })).cost?.amount).toBe(tIn);
    expect(r.priceLeg(nova({ outputUnits: M })).cost?.amount).toBe(tOut);
    expect(r.rateFor('aws-nova-sonic', NOVA)?.rate).toContain(`(${region})`);
  });

  it('Tokyo speech input costs 21% more than us-east-1 for the same tokens', async () => {
    const us = (await loadRates({ AWS_REGION: 'us-east-1' })).priceLeg(nova({ inputUnits: 1e6, audioInputTokens: 1e6 }));
    const jp = (await loadRates({ AWS_REGION: 'ap-northeast-1' })).priceLeg(nova({ inputUnits: 1e6, audioInputTokens: 1e6 }));
    expect(us.cost?.amount).toBe(3);
    expect(jp.cost?.amount).toBe(3.63);
  });

  it('AWS_DEFAULT_REGION alone is honoured', async () => {
    const r = await loadRates({ AWS_DEFAULT_REGION: 'eu-north-1' });
    expect(r.rateFor('aws-nova-sonic', NOVA)?.rate).toContain('(eu-north-1)');
  });

  it('AWS_REGION wins over AWS_DEFAULT_REGION', async () => {
    const r = await loadRates({ AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'eu-north-1' });
    expect(r.rateFor('aws-nova-sonic', NOVA)?.rate).toContain('(ap-northeast-1)');
  });

  it.each(['ap-south-1', 'eu-west-1', 'US-EAST-1', 'us-east-1 '])(
    'an unlisted region (%j) gets NO rate — never the us-east-1 numbers',
    async (region) => {
      const r = await loadRates({ AWS_REGION: region });
      expect(r.rateFor('aws-nova-sonic', NOVA)).toBeUndefined();
      const p = r.priceLeg(nova({ inputUnits: 1000, audioInputTokens: 1000, outputUnits: 500, audioOutputTokens: 500 }));
      expect(p.cost).toBeUndefined();
      expect(p.unpricedReason).toBe(`No rate on file for aws-nova-sonic:${NOVA}`);
      expect(r.rateTable().some((row) => row.providerId === 'aws-nova-sonic')).toBe(false);
    },
  );

  it('an unlisted AWS_REGION is not rescued by a listed AWS_DEFAULT_REGION', async () => {
    const r = await loadRates({ AWS_REGION: 'ap-south-1', AWS_DEFAULT_REGION: 'us-east-1' });
    expect(r.rateFor('aws-nova-sonic', NOVA)).toBeUndefined();
  });

  /*
   * BUG (minor): NovaSonicProvider.ts:648 resolves the region with `||`, so an
   * EMPTY AWS_REGION (e.g. `AWS_REGION=` left blank in .env) falls through to
   * AWS_DEFAULT_REGION / us-east-1 and the session runs there. rates.ts:222
   * uses `??`, so the same environment resolves the region to '' and the leg
   * goes unpriced. The two disagree about where the session ran.
   */
  it.fails('an empty AWS_REGION falls through to AWS_DEFAULT_REGION, as the provider does', async () => {
    const r = await loadRates({ AWS_REGION: '', AWS_DEFAULT_REGION: 'ap-northeast-1' });
    expect(r.rateFor('aws-nova-sonic', NOVA)?.rate).toContain('(ap-northeast-1)');
  });

  it('carries no cached-token tier: cached speech is billed at the full speech rate', async () => {
    const r = await loadRates({ AWS_REGION: 'us-east-1' });
    const rate = r.rateFor('aws-nova-sonic', NOVA);
    expect(rate?.cachedInput).toBeUndefined();
    expect(rate?.cachedAudioInput).toBeUndefined();
    // 1000 speech tokens, all cached: 1000 * $3/1M = $0.003
    const p = r.priceLeg(nova({ inputUnits: 1000, audioInputTokens: 1000, cachedInputTokens: 1000, cachedAudioInputTokens: 1000 }));
    expect(p.cost?.amount).toBe(0.003);
  });

  it('a mixed speech + text turn bills each half at its own rate', async () => {
    const r = await loadRates({ AWS_REGION: 'us-east-1' });
    // in: 900 speech @ $3/1M + 100 text @ $0.33/1M = 0.0027 + 0.000033
    // out: 400 speech @ $12/1M + 100 text @ $2.75/1M = 0.0048 + 0.000275
    const p = r.priceLeg(nova({ inputUnits: 1000, audioInputTokens: 900, outputUnits: 500, audioOutputTokens: 400 }));
    expect(p.cost?.amount).toBe(0.007808);
  });
});

describe('rateFor', () => {
  it('returns undefined for an unknown provider', async () => {
    const r = await loadRates();
    expect(r.rateFor('deepgram-tts', 'aura-2')).toBeUndefined();
    expect(r.rateFor('', '')).toBeUndefined();
  });

  it('returns undefined for an unknown model of a provider that has no fallback', async () => {
    const r = await loadRates();
    expect(r.rateFor('google-llm', 'gemini-9-ultra')).toBeUndefined();
    expect(r.rateFor('openai-realtime', 'gpt-realtime-9')).toBeUndefined();
    // Deliberately absent: Google's page gave two contradictory rows for it.
    expect(r.rateFor('gemini-tts', 'gemini-3.1-flash-tts-preview')).toBeUndefined();
  });

  it('strips an @variant suffix before lookup — reasoning depth never changes the per-token price', async () => {
    const r = await loadRates();
    expect(r.rateFor('google-llm', 'gemini-3.8-flash@off')).toBe(r.rateFor('google-llm', 'gemini-3.8-flash'));
    expect(r.rateFor('openai-llm', 'gpt-5.6-luna@high')).toBe(r.rateFor('openai-llm', 'gpt-5.6-luna'));
    expect(r.rateFor('google-llm', 'gemini-3.8-flash@off')).toBeDefined();
  });

  it('strips at the FIRST @ only', async () => {
    const r = await loadRates();
    expect(r.rateFor('google-llm', 'gemini-3.5-flash@a@b')).toBe(r.rateFor('google-llm', 'gemini-3.5-flash'));
  });

  it('falls back to the provider-wide rate for an unlisted model', async () => {
    const r = await loadRates();
    expect(r.rateFor('sarvam-stt', 'saaras:v3-realtime@fast')).toBe(r.RATES['sarvam-stt'].fallback);
    expect(r.rateFor('elevenlabs-tts', 'eleven_v3')).toBe(r.RATES['elevenlabs-tts'].fallback);
    expect(r.rateFor('sarvam-tts', 'bulbul:v3')).toBe(r.RATES['sarvam-tts'].fallback);
  });

  it('a model-specific rate wins over the fallback', async () => {
    const r = await loadRates();
    expect(r.rateFor('sarvam-tts', 'bulbul:v4-flash')).toBe(r.RATES['sarvam-tts'].models?.['bulbul:v4-flash']);
    expect(r.rateFor('cartesia-stt', 'ink-whisper')).toBe(r.RATES['cartesia-stt'].models?.['ink-whisper']);
  });

  it('a model key that itself contains @ is still found by its full id', async () => {
    const r = await loadRates();
    const custom: Rate = {
      unit: 'tokens', currency: 'USD', input: 1, output: 1, rate: 'x', source: 'https://example.invalid', checkedOn: '2026-01-01', confidence: 'verified',
    };
    r.RATES['test-provider'] = { models: { 'm@v': custom } };
    expect(r.rateFor('test-provider', 'm@v')).toBe(custom);
    delete r.RATES['test-provider'];
  });

  it('is case-sensitive on ids', async () => {
    const r = await loadRates();
    expect(r.rateFor('Google-LLM', 'gemini-3.5-flash')).toBeUndefined();
    expect(r.rateFor('google-llm', 'Gemini-3.5-Flash')).toBeUndefined();
  });

  it('an inherited Object.prototype name as the PROVIDER id finds nothing', async () => {
    const r = await loadRates();
    expect(r.rateFor('constructor', 'x')).toBeUndefined();
    expect(r.rateFor('toString', 'x')).toBeUndefined();
  });

  /*
   * BUG (latent, minor): rates.ts:559 indexes plain object literals, so a model
   * id equal to an Object.prototype member resolves to that member — a FUNCTION
   * returned as a `Rate`. On a provider with a fallback (elevenlabs-tts) it
   * also shadows the fallback the model should have been priced at. The
   * factory validates model ids before a session starts, so it is unreachable
   * from the UI today.
   */
  it.fails('a model id equal to an Object.prototype member is not returned as a rate', async () => {
    const r = await loadRates();
    expect(r.rateFor('google-llm', 'toString')).toBeUndefined();
  });
});

describe('effective (dated step changes)', () => {
  it('Gemini Flash promo: $0.75 in / $3.75 out / $0.075 cached per 1M before the step', async () => {
    const r = await loadRates();
    const rate = r.effective(r.rateFor('google-llm', 'gemini-3.8-flash')!, PROMO);
    expect(rate.input).toBe(0.75 / 1e6);
    expect(rate.output).toBe(3.75 / 1e6);
    expect(rate.cachedInput).toBe(0.075 / 1e6);
    expect(rate.rate).toBe('$0.75 in / $3.75 out per 1M tokens');
  });

  it('...and exactly double from 2027-01-01', async () => {
    const r = await loadRates();
    const rate = r.effective(r.rateFor('google-llm', 'gemini-3.8-flash')!, POST_PROMO);
    expect(rate.input).toBe(1.5 / 1e6);
    expect(rate.output).toBe(7.5 / 1e6);
    expect(rate.cachedInput).toBe(0.15 / 1e6);
    expect(rate.rate).toBe('$1.5 in / $7.5 out per 1M tokens');
    expect(rate.note).toBe('Thinking tokens are billed at the output rate. Promotional rate expired 2026-12-31.');
  });

  it('the promo still applies at 2026-12-31T23:59:59Z exactly', async () => {
    const r = await loadRates();
    expect(r.effective(r.rateFor('google-llm', 'gemini-3.8-flash')!, STEP_BOUNDARY).input).toBe(0.75 / 1e6);
  });

  it('the step applies at 2027-01-01T00:00:00Z', async () => {
    const r = await loadRates();
    expect(r.effective(r.rateFor('google-llm', 'gemini-3.8-flash')!, Date.parse('2027-01-01T00:00:00Z')).input).toBe(1.5 / 1e6);
  });

  /*
   * BUG (negligible): rates.ts:565 compares against `${until}T23:59:59Z`, so the
   * last 999 ms of the `until` day already get the post-step rate. The doc says
   * "Past this ISO date `then` applies"; 23:59:59.5 on the 31st is not past it.
   */
  it.fails('the promo still applies in the last second of 2026-12-31', async () => {
    const r = await loadRates();
    expect(r.effective(r.rateFor('google-llm', 'gemini-3.8-flash')!, STEP_BOUNDARY + 500).input).toBe(0.75 / 1e6);
  });

  it('all three Flash tiers share the step; 3.5-flash and the lite tiers have none', async () => {
    const r = await loadRates();
    for (const m of ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
      expect(r.effective(r.rateFor('google-llm', m)!, POST_PROMO).input).toBe(1.5 / 1e6);
    }
    const flash35 = r.rateFor('google-llm', 'gemini-3.5-flash')!;
    expect(flash35.until).toBeUndefined();
    expect(r.effective(flash35, Date.parse('2030-01-01'))).toBe(flash35);
  });

  it('defaults `at` to the current time', async () => {
    const r = await loadRates();
    const flash = r.rateFor('google-llm', 'gemini-3.8-flash')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PROMO);
    expect(r.effective(flash).input).toBe(0.75 / 1e6);
    vi.setSystemTime(POST_PROMO);
    expect(r.effective(flash).input).toBe(1.5 / 1e6);
  });

  it('returns the very same object when no step change is encoded', async () => {
    const r = await loadRates();
    const rate = r.rateFor('murf-tts', 'falcon-2')!;
    expect(r.effective(rate, POST_PROMO)).toBe(rate);
  });

  it('an `until` with no `then` is ignored', async () => {
    const r = await loadRates();
    const rate: Rate = {
      unit: 'tokens', currency: 'USD', input: 1, output: 2, rate: 'r', source: 's', checkedOn: '2026-01-01', confidence: 'verified', until: '2026-01-31',
    };
    expect(r.effective(rate, Date.parse('2027-01-01'))).toBe(rate);
  });

  it('a `then` that omits cachedInput clears the old cache rate rather than keeping it', async () => {
    const r = await loadRates();
    const rate: Rate = {
      unit: 'tokens', currency: 'USD', input: 1, output: 2, cachedInput: 0.1, rate: 'old', source: 's',
      checkedOn: '2026-01-01', confidence: 'verified', until: '2026-01-31', then: { input: 3, output: 4, rate: 'new' },
    };
    const after = r.effective(rate, Date.parse('2026-02-01'));
    expect(after.input).toBe(3);
    expect(after.output).toBe(4);
    expect(after.cachedInput).toBeUndefined();
    expect(after.rate).toBe('new');
    expect(after.note).toBe('Promotional rate expired 2026-01-31.');
    // ...and the input rate is untouched.
    expect(rate.input).toBe(1);
  });

  it('keeps the rest of the rate (source, confidence, currency) across the step', async () => {
    const r = await loadRates();
    const before = r.rateFor('google-llm', 'gemini-3.8-flash')!;
    const after = r.effective(before, POST_PROMO);
    expect(after.source).toBe(before.source);
    expect(after.confidence).toBe(before.confidence);
    expect(after.currency).toBe('USD');
    expect(after.unit).toBe('tokens');
  });
});

describe('priceLeg — vendor arithmetic, USD and INR on every leg', () => {
  it('Gemini 3.5 Flash-Lite: $0.30 per 1M in, $2.50 per 1M out', async () => {
    const r = await loadRates();
    const inp = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', inputUnits: 1_000_000 }));
    expect(inp.cost).toEqual({
      amount: 0.3,
      currency: 'USD',
      amountUsd: 0.3,
      amountInr: 28.329, // 0.30 * 94.43
      rate: '$0.3 in / $2.5 out per 1M tokens',
      confidence: 'verified',
      note: 'Thinking tokens are billed at the output rate.',
    });
    expect(inp.unpricedReason).toBeUndefined();
    const out = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', outputUnits: 1_000_000 }));
    expect(out.cost?.amount).toBe(2.5);
    expect(out.cost?.amountInr).toBe(236.075); // 2.50 * 94.43
  });

  it('cached input is billed at the cache rate and not again at the full rate', async () => {
    const r = await loadRates();
    // 1M in, 800K of them cached: 200K * $0.30/1M + 800K * $0.03/1M = 0.06 + 0.024
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', inputUnits: 1_000_000, cachedInputTokens: 800_000 }));
    expect(p.cost?.amount).toBe(0.084);
  });

  it('thinking tokens ride inside outputUnits and are not billed twice', async () => {
    const r = await loadRates();
    // 300 out (200 thinking) @ $2.50/1M = $0.00075
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', outputUnits: 300, thinkingTokens: 200 }));
    expect(p.cost?.amount).toBe(0.00075);
  });

  it('the Flash promo prices before the step and doubles after it', async () => {
    const r = await loadRates();
    const l = leg({ providerId: 'google-llm', modelId: 'gemini-3.8-flash@off', inputUnits: 1_000_000, outputUnits: 1_000_000, cachedInputTokens: 500_000 });
    // before: 500K*0.75 + 500K*0.075 + 1M*3.75 per 1M = 0.375 + 0.0375 + 3.75
    expect(r.priceLeg(l, PROMO).cost?.amount).toBe(4.1625);
    // after:  500K*1.5 + 500K*0.15 + 1M*7.5 per 1M = 0.75 + 0.075 + 7.5
    expect(r.priceLeg(l, POST_PROMO).cost?.amount).toBe(8.325);
    expect(r.priceLeg(l, POST_PROMO).cost?.rate).toBe('$1.5 in / $7.5 out per 1M tokens');
  });

  it('defaults the pricing moment to now', async () => {
    const r = await loadRates();
    const l = leg({ providerId: 'google-llm', modelId: 'gemini-3.7-flash', inputUnits: 1_000_000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(POST_PROMO);
    expect(r.priceLeg(l).cost?.amount).toBe(1.5);
  });

  it('Sarvam TTS: ₹30 per 10K characters, billed in rupees with USD alongside', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v3', unit: 'characters', outputUnits: 10_000 }));
    expect(p.cost?.currency).toBe('INR');
    expect(p.cost?.amount).toBe(30);
    expect(p.cost?.amountInr).toBe(30); // the vendor's own, unconverted
    expect(p.cost?.amountUsd).toBe(0.31769565); // 30 / 94.43
  });

  it('Sarvam Bulbul v4 Flash: ₹20 per 10K characters; a variant suffix still finds it', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v4-flash', unit: 'characters', outputUnits: 10_000 }));
    expect(p.cost?.amount).toBe(20);
    expect(p.cost?.amountUsd).toBe(0.2117971); // 20 / 94.43
    expect(p.cost?.rate).toBe('₹20 per 10K characters');
    const v = r.priceLeg(leg({ leg: 'tts', providerId: 'sarvam-tts', modelId: 'bulbul:v4-flash@x', unit: 'characters', outputUnits: 10_000 }));
    expect(v.cost?.amount).toBe(20);
  });

  it('Sarvam STT: ₹30 per hour, billed per second', async () => {
    const r = await loadRates();
    const hour = r.priceLeg(leg({ leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 3600 }));
    expect(hour.cost?.amount).toBe(30);
    const four = r.priceLeg(leg({ leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds', inputUnits: 4 }));
    expect(four.cost?.amount).toBe(0.03333333); // 30 * 4 / 3600
    expect(four.cost?.amountInr).toBe(0.033333);
    expect(four.cost?.amountUsd).toBe(0.000353); // 0.0333.../94.43 = 0.00035299...
  });

  it('Murf: $0.03 per 1K characters, flagged ambiguous', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'murf-tts', modelId: 'falcon-2', unit: 'characters', outputUnits: 1000 }));
    expect(p.cost?.amount).toBe(0.03);
    expect(p.cost?.confidence).toBe('ambiguous');
    expect(p.cost?.amountInr).toBe(2.8329);
  });

  it('ElevenLabs: dollars per character, per model family; an unknown model gets the dearer tier', async () => {
    const r = await loadRates();
    const el = (modelId: string) =>
      r.priceLeg(leg({ leg: 'tts', providerId: 'elevenlabs-tts', modelId, unit: 'characters', outputUnits: 1000 }));
    for (const m of ['eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5']) {
      expect(el(m).cost?.amount).toBe(0.05);
      expect(el(m).cost?.rate).toBe('$0.05 per 1K characters');
    }
    expect(el('eleven_multilingual_v2').cost?.amount).toBe(0.1);
    expect(el('eleven_v3').cost?.amount).toBe(0.1);
    expect(el('eleven_flash_v2_5').cost?.currency).toBe('USD');
    expect(el('eleven_flash_v2_5').cost?.confidence).toBe('ambiguous');
  });

  it('OpenAI text: gpt-5.6-luna $0.20 / $1.20 per 1M; gpt-4o-mini cache at $0.075', async () => {
    const r = await loadRates();
    const o = (x: Partial<LegUsage>) => r.priceLeg(leg({ providerId: 'openai-llm', modelId: 'gpt-5.6-luna@high', ...x }));
    expect(o({ inputUnits: 1_000_000 }).cost?.amount).toBe(0.2);
    expect(o({ outputUnits: 1_000_000 }).cost?.amount).toBe(1.2);
    const cached = r.priceLeg(leg({ providerId: 'openai-llm', modelId: 'gpt-4o-mini', inputUnits: 1_000_000, cachedInputTokens: 1_000_000 }));
    expect(cached.cost?.amount).toBe(0.075);
  });

  it('gpt-5.6-sol is promotional and flagged ambiguous', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'openai-llm', modelId: 'gpt-5.6-sol', inputUnits: 1_000_000 }));
    expect(p.cost?.amount).toBe(4);
    expect(p.cost?.confidence).toBe('ambiguous');
    expect(p.cost?.note).toContain('Promotional');
  });

  it('Gemini STT: ≈$0.009 per minute (blended), ambiguous', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'stt', providerId: 'gemini-stt', modelId: 'gemini-3.5-transcribe-live', unit: 'audio_seconds', inputUnits: 60 }));
    expect(p.cost?.amount).toBe(0.009);
    expect(p.cost?.confidence).toBe('ambiguous');
  });

  it('mock providers are priced — at a genuine zero — not reported unpriced', async () => {
    const r = await loadRates();
    const cases: LegUsage[] = [
      leg({ leg: 'stt', providerId: 'mock-stt', modelId: 'mock', unit: 'audio_seconds', inputUnits: 12, source: 'local' }),
      leg({ providerId: 'mock-llm', modelId: 'mock-chat', inputUnits: 999, outputUnits: 999, source: 'local' }),
      leg({ leg: 'tts', providerId: 'mock-tts', modelId: 'mock-voice', unit: 'characters', outputUnits: 5000, source: 'local' }),
      leg({ leg: 'realtime', providerId: 'mock-realtime', modelId: 'mock', unit: 'audio_seconds', inputUnits: 3, source: 'local' }),
    ];
    for (const l of cases) {
      const p = r.priceLeg(l);
      expect(p.unpricedReason).toBeUndefined();
      expect(p.cost).toMatchObject({ amount: 0, amountUsd: 0, amountInr: 0, rate: 'local, no vendor' });
    }
  });

  it('rounds the native and USD amounts to 8 dp and the INR amount to 6 dp', async () => {
    const r = await loadRates();
    // 1 character of Cartesia = $0.00005 = ₹0.0047215
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 1 }));
    expect(p.cost?.amount).toBe(0.00005);
    expect(p.cost?.amountInr).toBe(0.004722);
    // 1 token of gemini-3.1-flash-lite input = $0.00000025 → 8 dp keeps it
    const q = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.1-flash-lite', inputUnits: 1 }));
    expect(q.cost?.amount).toBe(0.00000025);
  });

  it('a zero-unit leg on a real rate prices at zero (the units are known)', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash' }));
    expect(p.cost?.amount).toBe(0);
    expect(p.unpricedReason).toBeUndefined();
  });

  it('is pure: never mutates the input leg, returns a new object', async () => {
    const r = await loadRates();
    const input = leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', inputUnits: 10, cachedInputTokens: 5 });
    const snapshot = structuredClone(input);
    const out = r.priceLeg(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(out).toMatchObject(snapshot);
  });

  it('preserves every usage field through costing', async () => {
    const r = await loadRates();
    const input = leg({
      leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters', outputUnits: 10, audioSeconds: 1.25, source: 'local',
    });
    const out = r.priceLeg(input);
    expect(out.audioSeconds).toBe(1.25);
    expect(out.source).toBe('local');
    expect(out.leg).toBe('tts');
  });
});

describe('priceLeg — never priced at zero when the price is unknown', () => {
  it('a provider-declared unpricedReason survives costing, with no cost attached', async () => {
    const r = await loadRates();
    const declared = leg({
      leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1',
      unpricedReason: 'Vendor reported no usage for this turn',
    });
    const p = r.priceLeg(declared);
    expect(p.unpricedReason).toBe('Vendor reported no usage for this turn');
    expect(p.cost).toBeUndefined();
    expect(p).not.toBe(declared);
  });

  it('a declared reason wins even when units and a real rate would price it', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', inputUnits: 1e6, unpricedReason: 'x' }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toBe('x');
  });

  it('an unknown provider is reported, not zeroed', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'deepgram-tts', modelId: 'aura-2-thalia-en', unit: 'characters', outputUnits: 100 }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toBe('No rate on file for deepgram-tts:aura-2-thalia-en');
  });

  it('an unknown model of a provider with no fallback is reported with its full id', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-9@off', inputUnits: 1 }));
    expect(p.unpricedReason).toBe('No rate on file for google-llm:gemini-9@off');
  });

  it('a unit mismatch is reported: Gemini TTS bills tokens, the leg counts characters', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'gemini-tts', modelId: 'gemini-2.5-flash-preview-tts', unit: 'characters', outputUnits: 500 }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toBe('Rate for gemini-tts is per tokens, usage is in characters');
  });

  it('a mismatch in the other direction too: an STT rate given tokens', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'sarvam-stt', modelId: 'saaras:v3', unit: 'tokens', inputUnits: 10 }));
    expect(p.unpricedReason).toBe('Rate for sarvam-stt is per audio_seconds, usage is in tokens');
  });

  it('the Gemini 3.1 TTS preview, deliberately absent, is reported as having no rate', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ leg: 'tts', providerId: 'gemini-tts', modelId: 'gemini-3.1-flash-tts-preview', unit: 'characters', outputUnits: 1 }));
    expect(p.unpricedReason).toBe('No rate on file for gemini-tts:gemini-3.1-flash-tts-preview');
  });

  it.each([
    ['audio input', { inputUnits: 100, audioInputTokens: 10 }],
    ['audio output', { outputUnits: 100, audioOutputTokens: 1 }],
  ])('%s tokens against a single-price rate are left unpriced, never billed at the text rate', async (_l, extra) => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', ...extra }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toBe(
      'Rate for google-llm:gemini-3.5-flash has one token price, but the leg reports audio tokens, which this vendor bills at a separate rate',
    );
  });

  it('explicitly-zero audio fields on a single-price rate do not block pricing', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', inputUnits: 1e6, audioInputTokens: 0, audioOutputTokens: 0 }));
    expect(p.cost?.amount).toBe(1.5);
  });

  it('a cached-audio count with no audio on a single-price rate is a contradiction, not a price', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', inputUnits: 100, cachedInputTokens: 50, cachedAudioInputTokens: 10 }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toContain('cachedAudioInputTokens 10 exceeds cachedInputTokens 50 or audioInputTokens 0');
  });
});

describe('priceLeg — OpenAI Realtime: audio and text tokens are two prices in one request', () => {
  const rt = (o: Partial<LegUsage>, modelId = 'gpt-realtime-2.1'): LegUsage =>
    leg({ leg: 'realtime', providerId: 'openai-realtime', modelId, ...o });

  it('1M audio in = $32, 1M text in = $4, 1M audio out = $64, 1M text out = $24', async () => {
    const r = await loadRates();
    const M = 1_000_000;
    expect(r.priceLeg(rt({ inputUnits: M, audioInputTokens: M })).cost?.amount).toBe(32);
    expect(r.priceLeg(rt({ inputUnits: M })).cost?.amount).toBe(4);
    expect(r.priceLeg(rt({ outputUnits: M, audioOutputTokens: M })).cost?.amount).toBe(64);
    expect(r.priceLeg(rt({ outputUnits: M })).cost?.amount).toBe(24);
  });

  it('the audio rate is 8x the text input rate', async () => {
    const r = await loadRates();
    const rate = r.rateFor('openai-realtime', 'gpt-realtime-2.1')!;
    expect(rate.audioInput! / rate.input).toBeCloseTo(8, 10);
  });

  it('a mixed turn bills each half at its own rate', async () => {
    const r = await loadRates();
    // in:  800 audio @ $32/1M + 200 text @ $4/1M  = 0.0256 + 0.0008
    // out: 400 audio @ $64/1M + 100 text @ $24/1M = 0.0256 + 0.0024
    const p = r.priceLeg(rt({ inputUnits: 1000, audioInputTokens: 800, outputUnits: 500, audioOutputTokens: 400 }));
    expect(p.cost?.amount).toBe(0.0544);
    expect(p.cost?.amountInr).toBe(5.136992); // 0.0544 * 94.43
  });

  it('the mini model: 1M audio in = $10', async () => {
    const r = await loadRates();
    expect(r.priceLeg(rt({ inputUnits: 1e6, audioInputTokens: 1e6 }, 'gpt-realtime-2.1-mini')).cost?.amount).toBe(10);
  });

  it('cached tokens with no explicit split are allocated to audio when text cannot hold them', async () => {
    const r = await loadRates();
    // 10K in, all audio, 9K cached: 1K @ $32/1M + 9K @ $0.40/1M = 0.032 + 0.0036
    const p = r.priceLeg(rt({ inputUnits: 10_000, audioInputTokens: 10_000, cachedInputTokens: 9_000 }));
    expect(p.cost?.amount).toBe(0.0356);
    // ...which is CHEAPER than the uncached turn ($0.32), never dearer.
    expect(p.cost!.amount).toBeLessThan(0.32);
  });

  it('an explicit cached-audio split is honoured; the remainder of the cache is text', async () => {
    const r = await loadRates();
    // 8K audio + 2K text in; 5K cached, 3K of it audio, so 2K cached text.
    // 5K audio @ 32 + 3K cached audio @ 0.4 + 0 text @ 4 + 2K cached text @ 0.4  (per 1M)
    // = 0.16 + 0.0012 + 0 + 0.0008
    const p = r.priceLeg(rt({ inputUnits: 10_000, audioInputTokens: 8_000, cachedInputTokens: 5_000, cachedAudioInputTokens: 3_000 }));
    expect(p.cost?.amount).toBe(0.162);
  });

  it('cache beyond what the text half can absorb overflows into audio', async () => {
    const r = await loadRates();
    // 8K audio + 2K text in; 6K cached, none declared audio.
    // text absorbs 2K, the other 4K must be audio:
    // 4K audio @ 32 + 4K cached audio @ 0.4 + 2K cached text @ 0.4 = 0.128 + 0.0016 + 0.0008
    const p = r.priceLeg(rt({ inputUnits: 10_000, audioInputTokens: 8_000, cachedInputTokens: 6_000 }));
    expect(p.cost?.amount).toBe(0.1304);
  });

  it('a text-only turn against a split rate prices at the text rate with its own cache rate', async () => {
    const r = await loadRates();
    // 1M text in, 500K cached: 500K @ $4/1M + 500K @ $0.40/1M = 2 + 0.2
    const p = r.priceLeg(rt({ inputUnits: 1e6, cachedInputTokens: 500_000 }));
    expect(p.cost?.amount).toBe(2.2);
  });

  it.each([
    ['audioInputTokens > inputUnits', { inputUnits: 100, audioInputTokens: 200 }, 'audioInputTokens 200 > inputUnits 100'],
    ['audioOutputTokens > outputUnits', { outputUnits: 100, audioOutputTokens: 101 }, 'audioOutputTokens 101 > outputUnits 100'],
    ['cachedInputTokens > inputUnits', { inputUnits: 100, cachedInputTokens: 150 }, 'cachedInputTokens 150 > inputUnits 100'],
    [
      'cachedAudio > cachedInput',
      { inputUnits: 100, audioInputTokens: 100, cachedInputTokens: 10, cachedAudioInputTokens: 20 },
      'cachedAudioInputTokens 20 exceeds cachedInputTokens 10 or audioInputTokens 100',
    ],
    [
      'cachedAudio > audioInput',
      { inputUnits: 100, audioInputTokens: 10, cachedInputTokens: 50, cachedAudioInputTokens: 20 },
      'cachedAudioInputTokens 20 exceeds cachedInputTokens 50 or audioInputTokens 10',
    ],
  ])('a breakdown bigger than its total (%s) is refused, not clamped', async (_l, extra, why) => {
    const r = await loadRates();
    const p = r.priceLeg(rt(extra));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toBe(
      `openai-realtime:gpt-realtime-2.1 reported inconsistent usage — ${why}. ` +
        'Each breakdown must be counted inside its total, so this cannot be priced.',
    );
  });

  it('reports the FIRST contradiction when several hold', async () => {
    const r = await loadRates();
    const p = r.priceLeg(rt({ inputUnits: 100, audioInputTokens: 200, cachedInputTokens: 300, outputUnits: 1, audioOutputTokens: 5 }));
    expect(p.unpricedReason).toContain('audioInputTokens 200 > inputUnits 100');
  });

  it('cached > input on a single-price LLM is refused too, not clamped to a plausible number', async () => {
    const r = await loadRates();
    const p = r.priceLeg(leg({ providerId: 'google-llm', modelId: 'gemini-3.5-flash', inputUnits: 100, cachedInputTokens: 500 }));
    expect(p.cost).toBeUndefined();
    expect(p.unpricedReason).toContain('cachedInputTokens 500 > inputUnits 100');
  });

  it('breakdowns exactly equal to their totals are consistent', async () => {
    const r = await loadRates();
    // 1000 audio in, all cached-audio: 1000 @ $0.40/1M; 1000 audio out @ $64/1M
    const p = r.priceLeg(rt({ inputUnits: 1000, audioInputTokens: 1000, cachedInputTokens: 1000, cachedAudioInputTokens: 1000, outputUnits: 1000, audioOutputTokens: 1000 }));
    expect(p.unpricedReason).toBeUndefined();
    expect(p.cost?.amount).toBe(0.0644); // 0.0004 + 0.064
  });

  it('the rate note warns that the transcription model is not metered, so the total is a floor', async () => {
    const r = await loadRates();
    expect(r.rateFor('openai-realtime', 'gpt-realtime-2.1')?.note).toContain('UNDERCOUNT');
  });
});

describe('rateTable and the provenance of every rate', () => {
  it('every row carries a source URL, a checked-on date and a confidence flag', async () => {
    const r = await loadRates();
    const rows = r.rateTable();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const where = `${row.providerId}:${row.modelId}`;
      if (row.providerId.startsWith('mock-')) {
        expect(row.source, where).toBe('n/a');
      } else {
        expect(row.source, where).toMatch(/^https:\/\/[^\s]+$/);
        expect(() => new URL(row.source), where).not.toThrow();
      }
      expect(row.checkedOn, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(row.checkedOn)), where).toBe(false);
      expect(['verified', 'ambiguous'], where).toContain(row.confidence);
      expect(['tokens', 'characters', 'audio_seconds'], where).toContain(row.unit);
      expect(['USD', 'INR'], where).toContain(row.currency);
      expect(row.rate.length, where).toBeGreaterThan(0);
    }
  });

  it('every rate in RATES — models and fallbacks — appears in the table exactly once', async () => {
    const r = await loadRates();
    const rows = r.rateTable();
    const keys = rows.map((row) => `${row.providerId}|${row.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [providerId, entry] of Object.entries(r.RATES)) {
      for (const modelId of Object.keys(entry.models ?? {})) expect(keys).toContain(`${providerId}|${modelId}`);
      if (entry.fallback) expect(keys).toContain(`${providerId}|*`);
    }
  });

  it('a fallback is listed under the wildcard model id', async () => {
    const r = await loadRates();
    const row = r.rateTable().find((x) => x.providerId === 'sarvam-stt');
    expect(row?.modelId).toBe('*');
    expect(row?.rate).toBe('₹30 per hour of audio');
    expect(row?.currency).toBe('INR');
  });

  it('every rate is per single unit, not per million (no token rate above $0.001)', async () => {
    const r = await loadRates();
    for (const row of r.rateTable()) {
      for (const v of [row.input, row.output, row.cachedInput, row.audioInput, row.audioOutput, row.cachedAudioInput]) {
        if (v === undefined) continue;
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        if (row.unit === 'tokens') expect(v).toBeLessThan(1e-3);
      }
    }
  });

  it('every cache rate is cheaper than (or equal to) the rate it discounts', async () => {
    const r = await loadRates();
    for (const row of r.rateTable()) {
      if (row.cachedInput !== undefined) expect(row.cachedInput).toBeLessThanOrEqual(row.input);
      if (row.cachedAudioInput !== undefined) expect(row.cachedAudioInput).toBeLessThanOrEqual(row.audioInput!);
    }
  });

  it('a split rate has both audio halves; only realtime vendors have one', async () => {
    const r = await loadRates();
    const split = r.rateTable().filter((row) => row.audioInput !== undefined || row.audioOutput !== undefined);
    expect(new Set(split.map((row) => row.providerId))).toEqual(new Set(['openai-realtime', 'aws-nova-sonic']));
    for (const row of split) {
      expect(row.audioInput).toBeDefined();
      expect(row.audioOutput).toBeDefined();
      expect(row.unit).toBe('tokens');
    }
  });

  it('a dated step change always carries its replacement', async () => {
    const r = await loadRates();
    for (const entry of Object.values(r.RATES)) {
      for (const rate of [...Object.values(entry.models ?? {}), ...(entry.fallback ? [entry.fallback] : [])]) {
        if (rate.until) {
          expect(rate.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(rate.then).toBeDefined();
        }
      }
    }
  });

  it('only Sarvam bills in rupees', async () => {
    const r = await loadRates();
    const inr = new Set(r.rateTable().filter((row) => row.currency === 'INR').map((row) => row.providerId));
    expect(inr).toEqual(new Set(['sarvam-stt', 'sarvam-tts']));
  });

  it('applies the step change as of now', async () => {
    const r = await loadRates();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PROMO);
    expect(r.rateTable().find((x) => x.modelId === 'gemini-3.8-flash')?.input).toBe(0.75 / 1e6);
    vi.setSystemTime(POST_PROMO);
    const row = r.rateTable().find((x) => x.modelId === 'gemini-3.8-flash');
    expect(row?.input).toBe(1.5 / 1e6);
    expect(row?.note).toContain('Promotional rate expired 2026-12-31.');
  });

  it('lists exactly one Nova row, for the configured region, and none for an unlisted one', async () => {
    const jp = (await loadRates({ AWS_REGION: 'ap-northeast-1' })).rateTable().filter((x) => x.providerId === 'aws-nova-sonic');
    expect(jp).toHaveLength(1);
    expect(jp[0].modelId).toBe('amazon.nova-2-sonic-v1:0');
    expect(jp[0].audioInput).toBe(3.63 / 1e6);
    expect(jp[0].checkedOn).toBe('2026-09-17');
  });
});
