import type { LegUsage, UsageUnit } from '../shared/protocol.js';

/**
 * Published vendor rates, read off each vendor's own pricing page on the date
 * recorded below. Prices move and FX moves, so nothing here is load-bearing:
 * every rate can be overridden from the environment, and the raw unit counts
 * are reported alongside every cost so a stale rate never hides the usage.
 *
 * Units are per single unit — per token, per character, per second of audio —
 * not per million. The vendor's own denomination is kept in `rate` for display.
 */

export type Confidence = 'verified' | 'ambiguous';

export interface Rate {
  unit: UsageUnit;
  /** The currency the vendor publishes in. Sarvam bills in rupees. */
  currency: 'USD' | 'INR';
  input: number;
  output: number;
  cachedInput?: number;
  /** Human-readable denomination, shown in the UI next to the cost. */
  rate: string;
  source: string;
  checkedOn: string;
  confidence: Confidence;
  note?: string;
  /**
   * Some vendors publish a dated step change. Past this ISO date `then` applies,
   * so the bench keeps estimating correctly instead of silently going stale.
   */
  until?: string;
  then?: { input: number; output: number; cachedInput?: number; rate: string };
}

const M = 1e6;

/**
 * Cartesia meters in credits: ~1 credit per TTS character, 3 credits/s for ink-2
 * and 1 credit/s for ink-whisper on the websocket endpoint. Dollars per credit
 * depend on the plan (Pro $5/100K, Startup $49/1.25M, Scale $299/8M — those
 * come from cartesia.ai/pricing, not the metering page cited below), so the
 * default is the Pro rate and CARTESIA_USD_PER_CREDIT overrides it.
 */
const usdPerCredit = num(process.env.CARTESIA_USD_PER_CREDIT, 5 / 100_000);

/**
 * Folds Sarvam's rupee prices into the USD total and vice versa.
 *
 * This is an ASSUMPTION, not a feed. ₹94.43 per $1 was the mid-market rate on
 * 2026-09-05 (xe / TradingEconomics / Morningstar agreed to within 0.1%). It
 * will drift, which is why the rate used travels inside every session record —
 * an old record stays interpretable at the rate it was priced with.
 *
 * Set USD_PER_INR to override. Currency drift is the largest error term in any
 * cross-vendor comparison here; the per-leg native amounts are exact regardless.
 */
export const FX_CHECKED_ON = '2026-09-05';
export const usdPerInr = num(process.env.USD_PER_INR, 1 / 94.43);

/** The same rate the other way up, which is how people actually quote it. */
export const inrPerUsd = 1 / usdPerInr;

const CARTESIA_SRC = 'https://docs.cartesia.ai/pricing';
const SARVAM_SRC = 'https://docs.sarvam.ai/api/getting-started/pricing';
const GEMINI_SRC = 'https://ai.google.dev/gemini-api/docs/pricing';
const MURF_SRC = 'https://help.murf.ai/murf-api-plans-and-limits';
const CHECKED = '2026-09-05';

const free = (unit: UsageUnit): Rate => ({
  unit,
  currency: 'USD',
  input: 0,
  output: 0,
  rate: 'local, no vendor',
  source: 'n/a',
  checkedOn: CHECKED,
  confidence: 'verified',
});

/** Gemini publishes input / output(incl. thinking) / cached-input per 1M tokens. */
function gemini(
  input: number,
  output: number,
  cachedInput: number,
  step?: { input: number; output: number; cachedInput: number },
): Rate {
  return {
    unit: 'tokens',
    currency: 'USD',
    input: input / M,
    output: output / M,
    cachedInput: cachedInput / M,
    rate: `$${input} in / $${output} out per 1M tokens`,
    source: GEMINI_SRC,
    checkedOn: CHECKED,
    confidence: 'verified',
    note: 'Thinking tokens are billed at the output rate.',
    ...(step
      ? {
          until: '2026-12-31',
          then: {
            input: step.input / M,
            output: step.output / M,
            cachedInput: step.cachedInput / M,
            rate: `$${step.input} in / $${step.output} out per 1M tokens`,
          },
        }
      : {}),
  };
}

/** Google's promotional rate on the 3.6/3.7/3.8 Flash tier doubles on 2027-01-01. */
const FLASH_PROMO = gemini(0.75, 3.75, 0.075, { input: 1.5, output: 7.5, cachedInput: 0.15 });

interface ProviderRates {
  /** Applied when no model-specific rate matches. */
  fallback?: Rate;
  models?: Record<string, Rate>;
}

function cartesiaStt(creditsPerSecond: number): Rate {
  return {
    unit: 'audio_seconds',
    currency: 'USD',
    input: creditsPerSecond * usdPerCredit,
    output: 0,
    rate: `${creditsPerSecond} credit${creditsPerSecond === 1 ? '' : 's'}/s @ $${usdPerCredit.toFixed(7)}/credit`,
    source: CARTESIA_SRC,
    checkedOn: CHECKED,
    confidence: 'verified',
    note: 'Silence is billed too — the meter runs on audio streamed, not on words recognised.',
  };
}

export const RATES: Record<string, ProviderRates> = {
  'mock-stt': { fallback: free('audio_seconds') },
  'mock-llm': { fallback: free('tokens') },
  'mock-tts': { fallback: free('characters') },
  'mock-realtime': { fallback: free('audio_seconds') },

  'google-llm': {
    models: {
      'gemini-3.8-flash': FLASH_PROMO,
      'gemini-3.7-flash': FLASH_PROMO,
      'gemini-3.6-flash': FLASH_PROMO,
      'gemini-3.5-flash': gemini(1.5, 9.0, 0.15),
      'gemini-3.5-flash-lite': gemini(0.3, 2.5, 0.03),
      'gemini-3.1-flash-lite': gemini(0.25, 1.5, 0.025),
    },
  },

  'sarvam-stt': {
    fallback: {
      unit: 'audio_seconds',
      currency: 'INR',
      input: 30 / 3600,
      output: 0,
      rate: '₹30 per hour of audio',
      source: SARVAM_SRC,
      checkedOn: CHECKED,
      confidence: 'verified',
      note: 'Billed per second. Diarization (₹45/hr) is not used here.',
    },
  },

  'sarvam-tts': {
    fallback: {
      unit: 'characters',
      currency: 'INR',
      input: 0,
      output: 30 / 10_000,
      rate: '₹30 per 10K characters',
      source: SARVAM_SRC,
      checkedOn: CHECKED,
      confidence: 'verified',
    },
  },

  'cartesia-tts': {
    fallback: {
      unit: 'characters',
      currency: 'USD',
      input: 0,
      output: usdPerCredit,
      rate: `1 credit/char @ $${usdPerCredit.toFixed(7)}/credit`,
      source: CARTESIA_SRC,
      checkedOn: CHECKED,
      confidence: 'verified',
      note: 'Credit value is plan-dependent; default is the Pro tier. Set CARTESIA_USD_PER_CREDIT for yours.',
    },
  },

  'cartesia-stt': {
    models: { 'ink-2': cartesiaStt(3), 'ink-whisper': cartesiaStt(1) },
    fallback: cartesiaStt(3),
  },

  'murf-tts': {
    fallback: {
      unit: 'characters',
      currency: 'USD',
      input: 0,
      output: 0.03 / 1000,
      rate: '$0.03 per 1K characters',
      source: MURF_SRC,
      checkedOn: CHECKED,
      confidence: 'ambiguous',
      note:
        'Murf publishes one pay-as-you-go character rate, but markets Falcon separately at "1 cent per minute" ' +
        'and third parties quote $0.01/1K chars for Falcon specifically. Treat Murf cost as the loosest number here.',
    },
  },
};

/**
 * Model ids carry provider-specific suffixes (`gemini-3.8-flash@off`,
 * `saaras:v3-realtime@fast`). Reasoning depth changes how many tokens are
 * produced, never the price per token, so the suffix is stripped for lookup.
 */
export function rateFor(providerId: string, modelId: string): Rate | undefined {
  const entry = RATES[providerId];
  if (!entry) return undefined;
  const base = modelId.split('@')[0];
  return entry.models?.[base] ?? entry.models?.[modelId] ?? entry.fallback;
}

/** Applies the dated step change, if the vendor announced one and it has passed. */
export function effective(rate: Rate, at = Date.now()): Rate {
  if (!rate.until || !rate.then) return rate;
  if (at <= Date.parse(`${rate.until}T23:59:59Z`)) return rate;
  return {
    ...rate,
    ...rate.then,
    // Spread alone would leave the pre-step cache rate in place if a future
    // `then` omits it, quietly billing cached tokens at the old price.
    cachedInput: rate.then.cachedInput,
    note: `${rate.note ?? ''} Promotional rate expired ${rate.until}.`.trim(),
  };
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Everything the UI needs to show which rates produced a cost. */
export function rateTable(): Array<{ providerId: string; modelId: string } & Rate> {
  const rows: Array<{ providerId: string; modelId: string } & Rate> = [];
  for (const [providerId, entry] of Object.entries(RATES)) {
    for (const [modelId, rate] of Object.entries(entry.models ?? {})) {
      rows.push({ providerId, modelId, ...effective(rate) });
    }
    if (entry.fallback) rows.push({ providerId, modelId: '*', ...effective(entry.fallback) });
  }
  return rows;
}

/** Fills in `cost` (or `unpricedReason`) on a leg. Pure — returns a new object. */
export function priceLeg(leg: LegUsage, at = Date.now()): LegUsage {
  const found = rateFor(leg.providerId, leg.modelId);
  if (!found) {
    return { ...leg, unpricedReason: `No rate on file for ${leg.providerId}:${leg.modelId}` };
  }
  const rate = effective(found, at);
  if (rate.unit !== leg.unit) {
    return { ...leg, unpricedReason: `Rate for ${leg.providerId} is per ${rate.unit}, usage is in ${leg.unit}` };
  }

  // Cached input is already inside inputUnits, so bill it separately and subtract.
  const cached = leg.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, leg.inputUnits - cached);
  const amount =
    uncachedInput * rate.input + cached * (rate.cachedInput ?? rate.input) + leg.outputUnits * rate.output;

  return {
    ...leg,
    cost: {
      amount: round(amount, 8),
      currency: rate.currency,
      // Whichever of the two is the vendor's own currency is exact; the other is
      // converted at the assumed rate, which travels with every summary.
      amountUsd: round(rate.currency === 'INR' ? amount * usdPerInr : amount, 8),
      amountInr: round(rate.currency === 'INR' ? amount : amount / usdPerInr, 6),
      rate: rate.rate,
      confidence: rate.confidence,
      note: rate.note,
    },
  };
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));
