import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedMetrics, LegUsage, StartConfig } from '../../../src/shared/protocol.js';

/**
 * UsageLedger prices through rates.ts, which reads the FX / credit / region env
 * at import. Each test gets a fresh module graph with all four pinned.
 *
 * Expected money is hand-computed from vendor denominations:
 *   sarvam-stt  ₹30 / hour       → 6 s  = ₹0.05      ($0.05 / 94.43 = $0.00052949)
 *   gemini-3.5-flash-lite $0.30 in / $2.50 out per 1M → 1000 in + 200 out = $0.0003 + $0.0005 = $0.0008 (₹0.075544)
 *   cartesia-tts $0.00005 / char → 400 chars = $0.02 (₹1.8886)
 */
type LedgerModule = typeof import('../../../src/pricing/UsageLedger.js');

async function loadLedger(env: Record<string, string | undefined> = {}): Promise<LedgerModule> {
  vi.resetModules();
  for (const k of ['USD_PER_INR', 'CARTESIA_USD_PER_CREDIT', 'AWS_REGION', 'AWS_DEFAULT_REGION']) vi.stubEnv(k, env[k]);
  return import('../../../src/pricing/UsageLedger.js');
}

const CONFIG: StartConfig = {
  mode: 'pipeline',
  sttProviderId: 'sarvam-stt',
  sttModelId: 'saaras:v3-realtime@fast',
  llmProviderId: 'google-llm',
  llmModelId: 'gemini-3.5-flash-lite',
  ttsProviderId: 'cartesia-tts',
  ttsModelId: 'sonic-3.6',
  systemPrompt: 'You are terse.',
  language: 'en',
  turnDetection: 'server_vad',
};

const stt = (o: Partial<LegUsage> = {}): LegUsage => ({
  leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3-realtime@fast', unit: 'audio_seconds',
  inputUnits: 6, outputUnits: 0, source: 'vendor', ...o,
});
const llm = (o: Partial<LegUsage> = {}): LegUsage => ({
  leg: 'llm', providerId: 'google-llm', modelId: 'gemini-3.5-flash-lite', unit: 'tokens',
  inputUnits: 1000, outputUnits: 200, thinkingTokens: 10, source: 'vendor', ...o,
});
const tts = (o: Partial<LegUsage> = {}): LegUsage => ({
  leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters',
  inputUnits: 0, outputUnits: 400, audioSeconds: 4, source: 'local', ...o,
});

const T0 = Date.parse('2026-10-20T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UsageLedger identity', () => {
  it('mints a filesystem-safe record id from the start time plus 8 hex chars', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('sock-1', 'pipeline', 'label', CONFIG);
    expect(l.recordId).toMatch(/^2026-10-20T10-00-00-000Z-[0-9a-f]{8}$/);
    // Same character class the store accepts, so the record can always be written.
    expect(l.recordId).toMatch(/^[A-Za-z0-9_-]{1,120}$/);
    expect(l.startedAt).toBe(T0);
  });

  it('two ledgers started in the same millisecond get different record ids', async () => {
    const { UsageLedger } = await loadLedger();
    const a = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const b = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    expect(a.recordId).not.toBe(b.recordId);
  });

  it('starts with zero turns', async () => {
    const { UsageLedger } = await loadLedger();
    expect(new UsageLedger('s', 'pipeline', 'l', CONFIG).turnCount).toBe(0);
  });
});

describe('UsageLedger.record', () => {
  it('prices every leg and sums the turn in both currencies', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const turn = l.record(1, [stt(), llm(), tts()]);
    expect(turn.turnId).toBe(1);
    expect(turn.at).toBe(T0);
    expect(turn.legs).toHaveLength(3);
    expect(turn.legs[0].cost).toMatchObject({ amount: 0.05, currency: 'INR', amountInr: 0.05, amountUsd: 0.00052949 });
    expect(turn.legs[1].cost).toMatchObject({ amount: 0.0008, currency: 'USD', amountUsd: 0.0008, amountInr: 0.075544 });
    expect(turn.legs[2].cost).toMatchObject({ amount: 0.02, currency: 'USD', amountUsd: 0.02, amountInr: 1.8886 });
    expect(turn.costUsd).toBe(0.02132949); // 0.00052949 + 0.0008 + 0.02
    expect(turn.costInr).toBe(2.014144); // 0.05 + 0.075544 + 1.8886
    expect(turn.unpriced).toEqual([]);
    expect(l.turnCount).toBe(1);
  });

  it('does not mutate the legs it was handed', async () => {
    const { UsageLedger } = await loadLedger();
    const legs = [stt(), llm()];
    const snapshot = structuredClone(legs);
    new UsageLedger('s', 'pipeline', 'l', CONFIG).record(1, legs);
    expect(legs).toEqual(snapshot);
  });

  it('names every unpriced leg, and an unpriced leg contributes nothing — the total is a floor', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const turn = l.record(1, [
      stt(),
      llm(),
      tts({ providerId: 'deepgram-tts', modelId: 'aura-2-thalia-en' }),
    ]);
    expect(turn.unpriced).toEqual(['deepgram-tts:aura-2-thalia-en']);
    expect(turn.legs[2].cost).toBeUndefined();
    expect(turn.legs[2].unpricedReason).toBe('No rate on file for deepgram-tts:aura-2-thalia-en');
    expect(turn.costUsd).toBe(0.00132949); // 0.00052949 + 0.0008
    expect(turn.costInr).toBe(0.125544); // 0.05 + 0.075544
  });

  it('audio tokens on a single-price LLM leave the leg unpriced rather than billed at the text rate', async () => {
    const { UsageLedger } = await loadLedger();
    const turn = new UsageLedger('s', 'pipeline', 'l', CONFIG).record(1, [llm({ audioInputTokens: 500 })]);
    expect(turn.unpriced).toEqual(['google-llm:gemini-3.5-flash-lite']);
    expect(turn.costUsd).toBe(0);
    expect(turn.legs[0].cost).toBeUndefined();
  });

  it('a turn with no legs at all costs zero and is still filed', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const turn = l.record(7, []);
    expect(turn).toMatchObject({ turnId: 7, legs: [], costUsd: 0, costInr: 0, unpriced: [] });
    expect(l.turnCount).toBe(1);
  });

  it('a tail record carrying only an STT leg is billed like any other turn', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [stt(), llm(), tts()]);
    // 3.6 s of audio streamed after the last turn, still metered by Sarvam: ₹0.03
    const tail = l.record(2, [stt({ inputUnits: 3.6 })]);
    expect(tail.legs).toHaveLength(1);
    expect(tail.legs[0].leg).toBe('stt');
    expect(tail.costInr).toBe(0.03);
    expect(tail.costUsd).toBe(0.0003177); // 0.03 / 94.43 = 0.000317695...
    const s = l.summary();
    expect(s.turnCount).toBe(2);
    // The tail's seconds land in the STT total: 6 + 3.6
    expect(s.totals.find((t) => t.leg === 'stt')?.inputUnits).toBe(9.6);
    expect(s.costInr).toBe(2.044144); // 2.014144 + 0.03
  });

  it('prices at the moment the turn lands — a dated step change between turns is honoured', async () => {
    const { UsageLedger } = await loadLedger();
    const flash = (): LegUsage => llm({ modelId: 'gemini-3.8-flash@off', inputUnits: 1_000_000, outputUnits: 0, thinkingTokens: undefined });
    vi.setSystemTime(Date.parse('2026-12-31T12:00:00Z'));
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const before = l.record(1, [flash()]);
    vi.setSystemTime(Date.parse('2027-01-01T00:00:01Z'));
    const after = l.record(2, [flash()]);
    expect(before.costUsd).toBe(0.75); // promo: $0.75 per 1M in
    expect(after.costUsd).toBe(1.5); // doubled
    const s = l.summary();
    // Summed from the rows, NOT re-derived at today's rate (which would be $3.00).
    expect(s.costUsd).toBe(2.25);
    const row = s.totals.find((t) => t.leg === 'llm');
    expect(row?.inputUnits).toBe(2_000_000);
    expect(row?.cost?.amountUsd).toBe(2.25);
  });
});

describe('UsageLedger.summary — totals come from the per-turn rows', () => {
  it('a two-turn pipeline conversation', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('sock-9', 'pipeline', 'sarvam → gemini → cartesia', CONFIG);
    const t1 = l.record(1, [stt(), llm(), tts()]);
    vi.setSystemTime(T0 + 5_000);
    const t2 = l.record(2, [stt(), llm(), tts()]);
    vi.setSystemTime(T0 + 12_345);
    const s = l.summary();

    expect(s.recordId).toBe(l.recordId);
    expect(s.sessionId).toBe('sock-9');
    expect(s.mode).toBe('pipeline');
    expect(s.label).toBe('sarvam → gemini → cartesia');
    expect(s.config).toEqual(CONFIG);
    expect(s.startedAt).toBe(T0);
    expect(s.endedAt).toBe(T0 + 12_345);
    expect(s.durationMs).toBe(12_345);
    expect(s.turnCount).toBe(2);
    expect(s.turns).toEqual([t1, t2]);
    expect(s.costUsd).toBe(0.04265898); // 2 * 0.02132949
    expect(s.costInr).toBe(4.028288); // 2 * 2.014144
    expect(s.unpriced).toEqual([]);
    expect(s.usdPerInr).toBe(1 / 94.43);

    expect(s.totals).toHaveLength(3);
    const by = (leg: string) => s.totals.find((t) => t.leg === leg)!;
    expect(by('stt')).toMatchObject({ inputUnits: 12, outputUnits: 0, unit: 'audio_seconds' });
    expect(by('stt').cost).toMatchObject({ amount: 0.1, amountInr: 0.1, amountUsd: 0.00105898, currency: 'INR' });
    expect(by('llm')).toMatchObject({ inputUnits: 2000, outputUnits: 400, thinkingTokens: 20 });
    expect(by('llm').cost).toMatchObject({ amount: 0.0016, amountUsd: 0.0016, amountInr: 0.151088 });
    expect(by('tts')).toMatchObject({ outputUnits: 800, audioSeconds: 8, source: 'local' });
    expect(by('tts').cost).toMatchObject({ amount: 0.04, amountUsd: 0.04, amountInr: 3.7772 });
  });

  it('the summary total equals the sum of the per-turn rows, and of the totals rows, in both currencies', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const sizes = [1.1, 2.37, 0.5, 7.25, 3];
    for (const [i, sec] of sizes.entries()) {
      l.record(i + 1, [stt({ inputUnits: sec }), llm({ inputUnits: 100 * (i + 1), outputUnits: 37 * (i + 1) }), tts({ outputUnits: 51 * (i + 1) })]);
    }
    const s = l.summary();
    const sumTurnsUsd = s.turns.reduce((a, t) => a + t.costUsd, 0);
    const sumTurnsInr = s.turns.reduce((a, t) => a + t.costInr, 0);
    expect(s.costUsd).toBeCloseTo(sumTurnsUsd, 8);
    expect(s.costInr).toBeCloseTo(sumTurnsInr, 6);
    const sumRowsUsd = s.totals.reduce((a, t) => a + (t.cost?.amountUsd ?? 0), 0);
    const sumRowsInr = s.totals.reduce((a, t) => a + (t.cost?.amountInr ?? 0), 0);
    expect(s.costUsd).toBeCloseTo(sumRowsUsd, 7);
    expect(s.costInr).toBeCloseTo(sumRowsInr, 5);
    // STT seconds: 1.1 + 2.37 + 0.5 + 7.25 + 3 = 14.22 (rounded to 4 dp, so no float dust)
    expect(s.totals.find((t) => t.leg === 'stt')?.inputUnits).toBe(14.22);
  });

  it('is idempotent: summarising twice gives the same totals and never mutates the turns', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [stt(), llm(), tts()]);
    l.record(2, [stt(), llm(), tts()]);
    const turnsBefore = structuredClone(l.summary().turns);
    const a = l.summary();
    const b = l.summary();
    expect(b.totals).toEqual(a.totals);
    expect(b.costUsd).toBe(a.costUsd);
    expect(a.turns).toEqual(turnsBefore);
    // The first turn's leg is the seed of every totals row — it must have been copied.
    expect(a.turns[0].legs[0].inputUnits).toBe(6);
    expect(a.turns[0].legs[0].cost?.amount).toBe(0.05);
  });

  it('one totals row per (leg, provider, model, unit) — differing units never sum together', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [tts(), tts({ unit: 'tokens', providerId: 'cartesia-tts' })]);
    l.record(2, [tts({ modelId: 'sonic-2' })]);
    l.record(3, [stt({ providerId: 'cartesia-stt', modelId: 'ink-2' })]);
    const s = l.summary();
    expect(s.totals).toHaveLength(4);
    const chars = s.totals.filter((t) => t.providerId === 'cartesia-tts' && t.unit === 'characters');
    expect(chars.map((t) => t.modelId).sort()).toEqual(['sonic-2', 'sonic-3.6']);
    const tokenRow = s.totals.find((t) => t.unit === 'tokens');
    expect(tokenRow?.unpricedReason).toBe('Rate for cartesia-tts is per characters, usage is in tokens');
    expect(s.unpriced).toEqual(['cartesia-tts:sonic-3.6']);
  });

  it('dedupes the unpriced list across turns, keeping first-seen order', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [tts({ providerId: 'deepgram-tts', modelId: 'aura' }), llm({ providerId: 'x-llm', modelId: 'y' })]);
    l.record(2, [tts({ providerId: 'deepgram-tts', modelId: 'aura' })]);
    l.record(3, [stt(), llm({ providerId: 'x-llm', modelId: 'y' })]);
    const s = l.summary();
    expect(s.unpriced).toEqual(['deepgram-tts:aura', 'x-llm:y']);
    expect(s.costInr).toBe(0.05); // only the one priced STT leg
  });

  it('an all-unpriced conversation totals zero but says it is a floor', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [tts({ providerId: 'deepgram-tts', modelId: 'aura' })]);
    const s = l.summary();
    expect(s.costUsd).toBe(0);
    expect(s.unpriced).toHaveLength(1);
    expect(s.totals[0].cost).toBeUndefined();
    expect(s.totals[0].unpricedReason).toContain('No rate on file');
  });

  it('a single local turn makes the whole totals row an estimate', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [llm({ source: 'vendor' })]);
    l.record(2, [llm({ source: 'local' })]);
    l.record(3, [llm({ source: 'vendor' })]);
    expect(l.summary().totals[0].source).toBe('local');
  });

  it('an all-vendor row stays vendor', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [llm()]);
    l.record(2, [llm()]);
    expect(l.summary().totals[0].source).toBe('vendor');
  });

  it('sums every breakdown field alongside its total, including ones absent from the first turn', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'realtime', 'l', { ...CONFIG, mode: 'realtime' });
    const rt = (o: Partial<LegUsage>): LegUsage => ({
      leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', unit: 'tokens',
      inputUnits: 0, outputUnits: 0, source: 'vendor', ...o,
    });
    l.record(1, [rt({ inputUnits: 1000, audioInputTokens: 800, outputUnits: 500, audioOutputTokens: 400 })]);
    l.record(2, [rt({ inputUnits: 2000, audioInputTokens: 1500, cachedInputTokens: 900, cachedAudioInputTokens: 700, outputUnits: 300, audioOutputTokens: 300, thinkingTokens: 5 })]);
    const row = l.summary().totals[0];
    expect(row).toMatchObject({
      inputUnits: 3000,
      outputUnits: 800,
      audioInputTokens: 2300,
      audioOutputTokens: 700,
      cachedInputTokens: 900,
      cachedAudioInputTokens: 700,
      thinkingTokens: 5,
    });
    // turn 1: 0.0544 (800a@32 + 200t@4 + 400a@64 + 100t@24 per 1M)
    // turn 2: 1500 audio in (700 cached) + 500 text in (the other 200 cached); 300 audio out
    //       = 800@32 + 700@0.4 + 300@4 + 200@0.4 + 300@64 (per 1M)
    //       = 0.0256 + 0.00028 + 0.0012 + 0.00008 + 0.0192 = 0.04636
    expect(row.cost?.amountUsd).toBe(0.10076);
    expect(l.summary().costUsd).toBe(0.10076);
  });

  it('rounds summed audio seconds to 3 dp and units to 4 dp, so float dust never shows', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [tts({ audioSeconds: 0.1, outputUnits: 0.1 })]);
    l.record(2, [tts({ audioSeconds: 0.2, outputUnits: 0.2 })]);
    const row = l.summary().totals[0];
    expect(row.audioSeconds).toBe(0.3);
    expect(row.outputUnits).toBe(0.3);
  });

  it('the first unpricedReason on a row wins', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [llm({ unpricedReason: 'first' })]);
    l.record(2, [llm({ unpricedReason: 'second' })]);
    expect(l.summary().totals[0].unpricedReason).toBe('first');
  });

  it('a priced turn followed by an unpriced one: the row keeps the priced cost and is flagged', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [llm()]);
    l.record(2, [llm({ unpricedReason: 'Vendor reported no usage' })]);
    const s = l.summary();
    const row = s.totals[0];
    expect(row.cost?.amountUsd).toBe(0.0008);
    expect(row.unpricedReason).toBe('Vendor reported no usage');
    expect(s.costUsd).toBe(0.0008);
    expect(s.totals.reduce((a, t) => a + (t.cost?.amountUsd ?? 0), 0)).toBe(s.costUsd);
  });

  /*
   * BUG: UsageLedger.ts:134 seeds a totals row from the first leg's cost, and
   * :157 only accumulates `if (acc.cost && leg.cost)`. So when a leg's FIRST
   * turn is unpriced (e.g. a realtime turn the vendor reported no usage for)
   * and a later turn is priced, the totals row never gets a cost at all — the
   * same two turns in the other order (test above) do. The session costUsd
   * (summed from turns) then disagrees with the totals rows.
   */
  it.fails('an unpriced turn followed by a priced one: the row still carries the priced cost', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [llm({ unpricedReason: 'Vendor reported no usage' })]);
    l.record(2, [llm()]);
    const s = l.summary();
    expect(s.costUsd).toBe(0.0008);
    expect(s.totals.reduce((a, t) => a + (t.cost?.amountUsd ?? 0), 0)).toBe(s.costUsd);
  });

  it('carries the FX rate it priced with, including an override', async () => {
    const { UsageLedger } = await loadLedger({ USD_PER_INR: '0.0125' });
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [stt({ inputUnits: 3600 }), llm({ inputUnits: 1_000_000, outputUnits: 0 })]);
    const s = l.summary();
    expect(s.usdPerInr).toBe(0.0125);
    // ₹30 @ ₹80/$ = $0.375, plus $0.30 = $0.675; ₹30 + $0.30 * 80 = ₹54
    expect(s.costUsd).toBe(0.675);
    expect(s.costInr).toBe(54);
  });

  it('an empty conversation summarises to zeros, with no medians invented', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const s = l.summary();
    expect(s).toMatchObject({ turnCount: 0, totals: [], turns: [], costUsd: 0, costInr: 0, unpriced: [] });
    expect(s.latency.ttfaMedianMs).toBeUndefined();
    expect(s.latency.ttfaP95Ms).toBeUndefined();
    expect('ttfaMedianMs' in s.latency).toBe(false);
    expect(s.latency.sttMedianMs).toBeUndefined();
  });
});

describe('UsageLedger.summary — records hold no credentials', () => {
  it('serialises nothing from the environment, only the StartConfig, usage and cost', async () => {
    const { UsageLedger } = await loadLedger();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-THIS-MUST-NOT-BE-PERSISTED-123456');
    vi.stubEnv('SARVAM_API_KEY', 'sarvam-secret-value-abcdef');
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.record(1, [stt(), llm(), tts()]);
    const json = JSON.stringify(l.summary());
    expect(json).not.toContain('sk-test-THIS-MUST-NOT-BE-PERSISTED');
    expect(json).not.toContain('sarvam-secret-value');
    expect(json).not.toMatch(/API_KEY|credentials/i);
    expect(Object.keys(l.summary()).sort()).toEqual(
      ['config', 'costInr', 'costUsd', 'durationMs', 'endedAt', 'label', 'latency', 'mode', 'recordId', 'sessionId',
        'startedAt', 'totals', 'turnCount', 'turns', 'unpriced', 'usdPerInr'].sort(),
    );
  });

  it('persists the system prompt deliberately — it produced the numbers', async () => {
    const { UsageLedger } = await loadLedger();
    expect(new UsageLedger('s', 'pipeline', 'l', CONFIG).summary().config.systemPrompt).toBe('You are terse.');
  });
});

describe('UsageLedger.noteLatency — medians per leg', () => {
  const d = (o: DerivedMetrics): DerivedMetrics => o;

  it('banks each leg separately and takes a true median of each', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.noteLatency(d({ timeToFirstAudioMs: 400, sttLatencyMs: 200, llmTtftMs: 100, ttsTtfbMs: 180, totalTurnMs: 3000, audioDurationMs: 2500 }));
    l.noteLatency(d({ timeToFirstAudioMs: 600, sttLatencyMs: 240, llmTtftMs: 200, ttsTtfbMs: 200, totalTurnMs: 4000, audioDurationMs: 3100 }));
    const lat = l.summary().latency;
    expect(lat).toEqual({
      ttfaMedianMs: 500,
      ttfaP95Ms: 600,
      ttfaMinMs: 400,
      ttfaMaxMs: 600,
      sttMedianMs: 220,
      llmTtftMedianMs: 150,
      ttsTtfbMedianMs: 190,
      totalTurnMedianMs: 3500,
      audioMedianMs: 2800,
    });
  });

  it('a leg that never reported has no median — undefined, not zero', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'realtime', 'l', { ...CONFIG, mode: 'realtime' });
    l.noteLatency(d({ timeToFirstAudioMs: 441, totalTurnMs: 2000 }));
    const lat = l.summary().latency;
    expect(lat.ttfaMedianMs).toBe(441);
    expect(lat.sttMedianMs).toBeUndefined();
    expect(lat.llmTtftMedianMs).toBeUndefined();
    expect(lat.ttsTtfbMedianMs).toBeUndefined();
    expect(lat.audioMedianMs).toBeUndefined();
    expect(lat.totalTurnMedianMs).toBe(2000);
  });

  it('legs missing on different turns are not paired up across turns', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.noteLatency(d({ sttLatencyMs: 100 }));
    l.noteLatency(d({ ttsTtfbMs: 900 }));
    l.noteLatency(d({ sttLatencyMs: 300, ttsTtfbMs: 1100 }));
    const lat = l.summary().latency;
    expect(lat.sttMedianMs).toBe(200);
    expect(lat.ttsTtfbMedianMs).toBe(1000);
    expect(lat.ttfaMedianMs).toBeUndefined();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
  ])('discards a %s figure', async (_l, bad) => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.noteLatency(d({ timeToFirstAudioMs: bad, sttLatencyMs: bad }));
    l.noteLatency(d({ timeToFirstAudioMs: 300 }));
    const lat = l.summary().latency;
    expect(lat.ttfaMedianMs).toBe(300);
    expect(lat.ttfaMinMs).toBe(300);
    expect(lat.sttMedianMs).toBeUndefined();
  });

  it('keeps a zero — it is a measurement', async () => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    l.noteLatency(d({ timeToFirstAudioMs: 0 }));
    expect(l.summary().latency.ttfaMedianMs).toBe(0);
  });

  const ttfa = async (values: number[]) => {
    const { UsageLedger } = await loadLedger();
    const l = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    for (const v of values) l.noteLatency(d({ timeToFirstAudioMs: v }));
    return l.summary().latency;
  };

  it('odd count takes the middle value, regardless of insertion order', async () => {
    expect((await ttfa([100, 200, 900])).ttfaMedianMs).toBe(200);
    expect((await ttfa([900, 100, 200])).ttfaMedianMs).toBe(200);
  });

  it('even count averages the middle pair, rounded to 0.1 ms', async () => {
    expect((await ttfa([400, 600])).ttfaMedianMs).toBe(500);
    expect((await ttfa([100, 101])).ttfaMedianMs).toBe(100.5);
    expect((await ttfa([1, 2, 3.33, 9])).ttfaMedianMs).toBe(2.7); // (2 + 3.33) / 2 = 2.665 → 2.7
  });

  it('sorts numerically, not lexically', async () => {
    expect((await ttfa([1000, 90, 200])).ttfaMedianMs).toBe(200);
    expect((await ttfa([1000, 90, 200])).ttfaMinMs).toBe(90);
    expect((await ttfa([1000, 90, 200])).ttfaMaxMs).toBe(1000);
  });

  it('a single sample is its own median, p95, min and max', async () => {
    expect(await ttfa([250])).toMatchObject({ ttfaMedianMs: 250, ttfaP95Ms: 250, ttfaMinMs: 250, ttfaMaxMs: 250 });
  });

  it('p95 is nearest-rank', async () => {
    expect((await ttfa([100, 200])).ttfaP95Ms).toBe(200);
    expect((await ttfa(Array.from({ length: 20 }, (_, i) => (i + 1) * 10))).ttfaP95Ms).toBe(190); // rank ceil(19) = 19th
    expect((await ttfa(Array.from({ length: 100 }, (_, i) => i + 1))).ttfaP95Ms).toBe(95);
    expect((await ttfa(Array.from({ length: 21 }, (_, i) => i + 1))).ttfaP95Ms).toBe(20); // ceil(19.95) = 20th
  });

  it('an outlier shows in p95 and max, not in the median', async () => {
    const lat = await ttfa([10, 20, 30, 40, 5000]);
    expect([lat.ttfaMedianMs, lat.ttfaP95Ms, lat.ttfaMinMs, lat.ttfaMaxMs]).toEqual([30, 5000, 10, 5000]);
  });
});
