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
  /**
   * Speech-to-speech vendors publish TWO token prices in the same request —
   * audio tokens cost several times what text tokens cost. Where these are set,
   * `input`/`output`/`cachedInput` mean the TEXT half and these mean the audio
   * half; `priceLeg` splits the leg using the audio counts on `LegUsage`.
   *
   * Setting them is what marks a rate as able to price an audio-token leg at
   * all. A leg that reports audio tokens against a rate without them is left
   * unpriced rather than billed at the text price — quietly charging OpenAI's
   * audio tokens at its text rate would understate the turn by ~17x, and a
   * plausible-looking small number is worse than a visible gap.
   */
  audioInput?: number;
  audioOutput?: number;
  cachedAudioInput?: number;
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
const OPENAI_SRC = 'https://developers.openai.com/api/docs/pricing';
const ELEVENLABS_SRC = 'https://elevenlabs.io/pricing';
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

/**
 * OpenAI's realtime models publish four numbers per model — audio and text, each
 * with its own cached-input rate — and audio costs 8x what text costs on the
 * flagship. `Rate` carries both halves and `priceLeg` splits the leg using the
 * audio token counts the session reports.
 *
 * The split is not a nicety: a realtime turn is almost entirely audio tokens, so
 * pricing one at the text rate would understate it by roughly an order of
 * magnitude while still looking like a plausible number.
 */
function openaiRealtime(
  audio: { input: number; cached: number; output: number },
  text: { input: number; cached: number; output: number },
): Rate {
  return {
    unit: 'tokens',
    currency: 'USD',
    input: text.input / M,
    output: text.output / M,
    cachedInput: text.cached / M,
    audioInput: audio.input / M,
    audioOutput: audio.output / M,
    cachedAudioInput: audio.cached / M,
    rate: `audio $${audio.input}/$${audio.output} · text $${text.input}/$${text.output} per 1M tokens`,
    source: OPENAI_SRC,
    checkedOn: CHECKED,
    confidence: 'verified',
    note:
      'Audio tokens run ~1 per 100ms of user speech and ~1 per 50ms of assistant speech, so a turn is ' +
      'mostly audio. The whole conversation is resent as input every turn, which is why later turns cost ' +
      'more. UNDERCOUNT: input transcription runs on a separate ASR model billed PER MINUTE ' +
      '(gpt-transcribe ~$0.0045/min), which this leg does not meter — so a realtime total is a floor.',
  };
}

/** OpenAI text models: input / output / cached input, per 1M tokens. */
function openaiText(input: number, output: number, cachedInput: number): Rate {
  return {
    unit: 'tokens',
    currency: 'USD',
    input: input / M,
    output: output / M,
    cachedInput: cachedInput / M,
    rate: `$${input} in / $${output} out per 1M tokens`,
    source: OPENAI_SRC,
    checkedOn: CHECKED,
    confidence: 'verified',
    note:
      'Short-context tier. Reasoning tokens are billed at the output rate and are already inside ' +
      'outputTokens. The 5.6 family charges roughly double past 272K input tokens, which this rate ' +
      'does not model — a voice turn never reaches it.',
  };
}

/** ElevenLabs TTS: USD per 1K characters, billed in dollars rather than credits. */
function elevenlabs(perThousand: number): Rate {
  return {
    unit: 'characters',
    currency: 'USD',
    input: 0,
    output: perThousand / 1000,
    rate: `$${perThousand.toFixed(2)} per 1K characters`,
    source: ELEVENLABS_SRC,
    checkedOn: CHECKED,
    confidence: 'ambiguous',
    note:
      'Read off the public API price list, never against an invoice — there is no ElevenLabs key here. ' +
      'A promotional banner offering 50% off API pricing for life was live on 2026-09-05; an account ' +
      'that took it pays half this. The subscription credit pool is a separate billing system and is ' +
      'not what this prices.',
  };
}

/** Gemini TTS: text tokens in, audio tokens out, both per 1M. */
function geminiTts(input: number, output: number): Rate {
  return {
    unit: 'tokens',
    currency: 'USD',
    input: input / M,
    output: output / M,
    rate: `$${input} text in / $${output} audio out per 1M tokens`,
    source: GEMINI_SRC,
    checkedOn: CHECKED,
    confidence: 'verified',
    note: 'Gemini bills TTS per token; this leg counts characters, so the row stays unpriced by design.',
  };
}

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

  /**
   * OpenAI text models, short-context tier, per 1M tokens.
   *
   * The 5.6 family prices LONG context (past 272K tokens) at roughly double, a
   * shape `Rate` cannot express — it keys on model, not on prompt size. A voice
   * turn is nowhere near that threshold, so the short-context rate is the honest
   * one here; a long-document workload priced through this bench would be
   * understated, which is why the note says so.
   */
  'openai-llm': {
    models: {
      // Promotional, per the pricing page's own footnote, through at least
      // 2026-11-21 — but OpenAI publishes no post-promo number, so there is
      // nothing to put in `then` and no step change is encoded. Flagged
      // ambiguous instead, so the UI does not present a temporary rate as settled.
      'gpt-5.6-sol': { ...openaiText(4, 20, 0.4), confidence: 'ambiguous' as const,
        note: 'Promotional pricing through at least 2026-11-21; no post-promo rate is published, ' +
          'so no dated step change is encoded — re-read before quoting. Short-context tier. ' +
          'The 5.6 family also bills cache WRITES on a line the Responses API does not report, ' +
          'so that part cannot be priced here at all.' },
      'gpt-5.6-terra': openaiText(2, 12, 0.2),
      'gpt-5.6-luna': openaiText(0.2, 1.2, 0.02),
      'gpt-5.4-mini': openaiText(0.75, 4.5, 0.075),
      'gpt-5.4-nano': openaiText(0.2, 1.25, 0.02),
      'gpt-4.1-mini': openaiText(0.4, 1.6, 0.1),
      'gpt-4o-mini': openaiText(0.15, 0.6, 0.075),
    },
  },

  'openai-realtime': {
    models: {
      'gpt-realtime-2.1': openaiRealtime(
        { input: 32, cached: 0.4, output: 64 },
        { input: 4, cached: 0.4, output: 24 },
      ),
      'gpt-realtime-2.1-mini': openaiRealtime(
        { input: 10, cached: 0.3, output: 20 },
        { input: 0.6, cached: 0.06, output: 2.4 },
      ),
    },
  },

  /**
   * Google prices the transcribe models two ways: per token (audio in, text out)
   * and as a blended per-minute figure. The STT leg is metered in seconds of
   * audio, so the per-minute figure is the one that fits without inventing a
   * token count this process cannot observe.
   *
   * Marked ambiguous because a blended rate is an average over an assumed
   * text-output length, not an arithmetic identity — a verbose transcript costs
   * more than this says.
   */
  'gemini-stt': {
    fallback: {
      unit: 'audio_seconds',
      currency: 'USD',
      input: 0.009 / 60,
      output: 0,
      rate: '≈$0.009 per minute of audio (blended)',
      source: GEMINI_SRC,
      checkedOn: CHECKED,
      confidence: 'ambiguous',
      note:
        'Google also publishes this per token — $3.50/1M audio in, $21.00/1M text out. This leg counts ' +
        'seconds, so the blended per-minute figure is used; it assumes an average transcript length.',
    },
  },

  /**
   * Gemini bills TTS in TOKENS, but the TTS leg of this pipeline is metered in
   * characters, because that is what every other TTS vendor here bills in and
   * the provider interface has no channel for a vendor-reported token count.
   *
   * The rate is on file anyway so the mismatch is reported as
   * "rate is per tokens, usage is in characters" rather than the blanker "no
   * rate on file" — the leg stays unpriced and the session total stays a floor
   * either way, but this way the gap explains itself.
   *
   * `gemini-3.1-flash-tts-preview` is deliberately absent: two reads of Google's
   * pricing page returned different rows for it and neither could be trusted, so
   * it is unpriced rather than guessed.
   */
  'gemini-tts': {
    models: {
      'gemini-2.5-flash-preview-tts': geminiTts(0.5, 10),
      'gemini-2.5-pro-preview-tts': geminiTts(1, 20),
    },
  },

  /**
   * ElevenLabs bills API usage in DOLLARS per character, not in credits — the
   * credit pool is the subscription product and a different billing system
   * entirely. Conflating the two overstates the cost roughly 3x, which is the
   * error this comment exists to stop coming back.
   *
   * Two rates, per model family, so the leg is priced per model rather than by a
   * single provider fallback: the Flash/Turbo tier at $0.05 and the higher
   * quality tier at $0.10 per 1K characters.
   */
  'elevenlabs-tts': {
    models: {
      eleven_flash_v2_5: elevenlabs(0.05),
      eleven_flash_v2: elevenlabs(0.05),
      eleven_turbo_v2_5: elevenlabs(0.05),
      eleven_multilingual_v2: elevenlabs(0.1),
    },
    // Any model not listed above is far likelier to be a quality tier than a
    // flash one, so the fallback is the expensive rate — an overestimate is the
    // safer direction for a number nobody has checked against an invoice.
    fallback: elevenlabs(0.1),
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
  const audioIn = leg.audioInputTokens ?? 0;
  const audioOut = leg.audioOutputTokens ?? 0;
  const splitRate = rate.audioInput !== undefined || rate.audioOutput !== undefined;

  if ((audioIn > 0 || audioOut > 0) && !splitRate) {
    return {
      ...leg,
      unpricedReason:
        `Rate for ${leg.providerId}:${leg.modelId} has one token price, but the leg reports ` +
        'audio tokens, which this vendor bills at a separate rate',
    };
  }

  /*
   * The audio fields are documented as living INSIDE their totals. A provider
   * that reports them additively instead is invisible to a type check, and the
   * clamps below would quietly absorb the contradiction and hand back a
   * plausible number — billing 500 audio tokens on a leg whose total says 100.
   *
   * `LlmUsage` in types.ts says of the analogous token invariants that "nothing
   * can detect a violation". For these three that is no longer true: a breakdown
   * larger than the total it breaks down is arithmetically impossible, so it is
   * caught here and the leg is reported unpriced. A visible gap beats a wrong
   * number that looks right.
   */
  const contradiction =
    audioIn > leg.inputUnits ? `audioInputTokens ${audioIn} > inputUnits ${leg.inputUnits}`
    : audioOut > leg.outputUnits ? `audioOutputTokens ${audioOut} > outputUnits ${leg.outputUnits}`
    : cached > leg.inputUnits ? `cachedInputTokens ${cached} > inputUnits ${leg.inputUnits}`
    : (leg.cachedAudioInputTokens ?? 0) > Math.min(cached, audioIn)
      ? `cachedAudioInputTokens ${leg.cachedAudioInputTokens} exceeds cachedInputTokens ${cached} or audioInputTokens ${audioIn}`
      : undefined;
  if (contradiction) {
    return {
      ...leg,
      unpricedReason:
        `${leg.providerId}:${leg.modelId} reported inconsistent usage — ${contradiction}. ` +
        'Each breakdown must be counted inside its total, so this cannot be priced.',
    };
  }

  let amount: number;
  if (splitRate) {
    // Audio and text are two prices in one request. Everything the leg reports
    // as audio is subtracted out of the totals, and what remains is text.
    const textIn = Math.max(0, leg.inputUnits - audioIn);
    const textOut = Math.max(0, leg.outputUnits - audioOut);

    /*
     * The cached tokens are a SUBSET of the input, split across those two
     * halves — and the vendor does not always say how. OpenAI omits
     * `cached_tokens_details` when there is nothing to report there, leaving
     * only the `cached_tokens` total, so the split has to be derived.
     *
     * Deriving it as "whatever is not explicitly audio-cached is text-cached"
     * is what a turn of a realtime conversation breaks: with 10K input tokens
     * all of them audio and 9K cached, that rule bills 10K audio at full rate
     * PLUS 9K text cache — 19K tokens against a leg that reported 10K, nine
     * times the true cost. Cache is meant to make later turns cheaper; that
     * made them dramatically dearer, and it lands precisely on the shape the
     * rate's own note describes ("the whole conversation is resent every turn").
     *
     * So the text half absorbs at most `textIn`, and the remainder must be
     * audio, because cached ⊆ input = audio + text. No guessing: it is the only
     * allocation the containment rule permits.
     */
    let cachedAudioIn = Math.min(leg.cachedAudioInputTokens ?? 0, Math.min(cached, audioIn));
    const cachedTextIn = Math.min(Math.max(0, cached - cachedAudioIn), textIn);
    const unallocatedCache = cached - cachedAudioIn - cachedTextIn;
    if (unallocatedCache > 0) cachedAudioIn = Math.min(audioIn, cachedAudioIn + unallocatedCache);

    const audioInRate = rate.audioInput ?? rate.input;
    const audioOutRate = rate.audioOutput ?? rate.output;
    amount =
      Math.max(0, audioIn - cachedAudioIn) * audioInRate +
      cachedAudioIn * (rate.cachedAudioInput ?? audioInRate) +
      Math.max(0, textIn - cachedTextIn) * rate.input +
      cachedTextIn * (rate.cachedInput ?? rate.input) +
      audioOut * audioOutRate +
      textOut * rate.output;
  } else {
    amount =
      Math.max(0, leg.inputUnits - cached) * rate.input +
      cached * (rate.cachedInput ?? rate.input) +
      leg.outputUnits * rate.output;
  }

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
