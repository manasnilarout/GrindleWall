import { describe, expect, it } from 'vitest';
import { normalizeSummary } from '../../src/lib/session';
import type { LegUsage, SessionSummary } from '../../src/lib/protocol';

const fullLeg: LegUsage = {
  leg: 'tts',
  providerId: 'cartesia-tts',
  modelId: 'sonic-3.6',
  unit: 'characters',
  inputUnits: 0,
  outputUnits: 120,
  audioSeconds: 4.2,
  source: 'vendor',
  cost: {
    amount: 0.0042,
    currency: 'USD',
    amountUsd: 0.0042,
    amountInr: 0.4,
    rate: '$0.035 / 1K chars',
    confidence: 'ambiguous',
    note: 'credit rate assumed',
  },
};

const full: SessionSummary = {
  recordId: 'rec-1',
  sessionId: 'sock-1',
  mode: 'realtime',
  label: 'OpenAI Realtime',
  config: { mode: 'realtime', realtimeProviderId: 'openai-realtime', systemPrompt: 'Be brief.', turnDetection: 'manual' },
  startedAt: 1000,
  endedAt: 61_000,
  durationMs: 60_000,
  turnCount: 1,
  totals: [fullLeg],
  costUsd: 0.0042,
  costInr: 0.4,
  unpriced: ['stt'],
  turns: [{ turnId: 1, at: 2000, legs: [fullLeg], costUsd: 0.0042, costInr: 0.4, unpriced: [] }],
  latency: { ttfaMedianMs: 900, ttfaP95Ms: 1200, sttMedianMs: 100 },
  usdPerInr: 0.0106,
};

describe('normalizeSummary', () => {
  it('passes a well-formed record through unchanged', () => {
    expect(normalizeSummary(full)).toEqual(full);
  });

  it.each([undefined, null, {}, 5, 'garbage', true, []])('fills every field for %j', (raw) => {
    const s = normalizeSummary(raw);
    expect(s).toEqual({
      recordId: 'unknown',
      sessionId: 'unknown',
      mode: 'pipeline',
      label: '(no pipeline recorded)',
      config: { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' },
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      turnCount: 0,
      totals: [],
      costUsd: 0,
      costInr: 0,
      unpriced: [],
      turns: [],
      latency: {},
      usdPerInr: 0.0113,
    });
  });

  it.each([0, -1, NaN, Infinity, '0.01', null])('replaces an unusable FX rate (%j) with a sane divisor', (rate) => {
    expect(normalizeSummary({ ...full, usdPerInr: rate }).usdPerInr).toBe(0.0113);
  });

  it('keeps a valid FX rate', () => {
    expect(normalizeSummary({ ...full, usdPerInr: 0.0105897 }).usdPerInr).toBe(0.0105897);
  });

  it('turns non-finite and non-number numerics into 0, not NaN', () => {
    const s = normalizeSummary({ ...full, startedAt: NaN, endedAt: '61000', durationMs: Infinity, turnCount: null, costUsd: undefined });
    expect([s.startedAt, s.endedAt, s.durationMs, s.turnCount, s.costUsd]).toEqual([0, 0, 0, 0, 0]);
    expect(s.costInr).toBe(0.4);
  });

  it('replaces non-array collections with empty ones', () => {
    const s = normalizeSummary({ ...full, totals: 'x', turns: { 0: {} }, unpriced: null });
    expect(s.totals).toEqual([]);
    expect(s.turns).toEqual([]);
    expect(s.unpriced).toEqual([]);
  });

  it('keeps only string entries of unpriced, at both levels', () => {
    const s = normalizeSummary({
      ...full,
      unpriced: ['stt', 3, null, 'tts'],
      turns: [{ ...full.turns[0], unpriced: [{}, 'llm'] }],
    });
    expect(s.unpriced).toEqual(['stt', 'tts']);
    expect(s.turns[0].unpriced).toEqual(['llm']);
  });

  it('heals a truncated turn', () => {
    const s = normalizeSummary({ turns: [null, { turnId: 4 }] });
    expect(s.turns).toEqual([
      { turnId: 0, at: 0, legs: [], costUsd: 0, costInr: 0, unpriced: [] },
      { turnId: 4, at: 0, legs: [], costUsd: 0, costInr: 0, unpriced: [] },
    ]);
  });

  it('heals a truncated leg', () => {
    const [leg] = normalizeSummary({ totals: [{}] }).totals;
    expect(leg).toEqual({
      leg: 'llm',
      providerId: 'unknown',
      modelId: 'unknown',
      unit: 'tokens',
      inputUnits: 0,
      outputUnits: 0,
      source: 'local',
      cost: undefined,
    });
    expect(normalizeSummary({ totals: [null] }).totals[0].leg).toBe('llm');
  });

  it("never renders an unrecognised source as a vendor measurement", () => {
    const legs = normalizeSummary({ totals: [{ source: 'VENDOR' }, { source: 'vendor' }, { source: 'local' }, {}] }).totals;
    expect(legs.map((l) => l.source)).toEqual(['local', 'vendor', 'local', 'local']);
  });

  it('heals a partial cost', () => {
    const [leg] = normalizeSummary({ totals: [{ ...fullLeg, cost: { amount: 'x', confidence: 'guess' } }] }).totals;
    expect(leg.cost).toEqual({
      amount: 0,
      amountUsd: 0,
      amountInr: 0,
      currency: 'USD',
      rate: 'unknown rate',
      confidence: 'verified',
    });
  });

  it('keeps an ambiguous confidence and a non-USD currency', () => {
    const [leg] = normalizeSummary({ totals: [{ ...fullLeg, cost: { ...fullLeg.cost, currency: 'INR' } }] }).totals;
    expect(leg.cost?.confidence).toBe('ambiguous');
    expect(leg.cost?.currency).toBe('INR');
    expect(leg.cost?.note).toBe('credit rate assumed');
  });

  it('drops a null cost rather than dereferencing it', () => {
    expect(normalizeSummary({ totals: [{ ...fullLeg, cost: null }] }).totals[0].cost).toBeUndefined();
  });

  it('preserves optional leg fields it does not need to heal', () => {
    const leg = { ...fullLeg, thinkingTokens: 12, cachedInputTokens: 3, audioInputTokens: 40, unpricedReason: 'no rate' };
    expect(normalizeSummary({ totals: [leg] }).totals[0]).toMatchObject({
      thinkingTokens: 12,
      cachedInputTokens: 3,
      audioInputTokens: 40,
      unpricedReason: 'no rate',
      audioSeconds: 4.2,
    });
  });

  it('keeps a record that predates the per-leg latency fields', () => {
    expect(normalizeSummary({ ...full, latency: { ttfaMedianMs: 700 } }).latency).toEqual({ ttfaMedianMs: 700 });
  });

  it('is idempotent', () => {
    const messy = { recordId: 'r', totals: [{ cost: {} }], turns: [{ legs: [null] }], usdPerInr: -3 };
    const once = normalizeSummary(messy);
    expect(normalizeSummary(once)).toEqual(once);
  });

  it('does not mutate its input', () => {
    const raw = JSON.parse(JSON.stringify({ totals: [{ cost: {} }], turns: [{}] }));
    const snapshot = JSON.stringify(raw);
    normalizeSummary(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
