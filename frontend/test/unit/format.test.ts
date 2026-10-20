import { describe, expect, it, vi } from 'vitest';
import {
  UNIT_LABEL,
  duration,
  inr,
  isPipeline,
  legOf,
  monthly,
  ms,
  num,
  pct,
  secs,
  usd,
  when,
} from '../../src/lib/format';
import type { LegUsage, TurnUsage } from '../../src/lib/protocol';

describe('usd / inr', () => {
  it.each([undefined, NaN, Infinity, -Infinity])('renders %s as an em dash', (v) => {
    expect(usd(v)).toBe('—');
    expect(inr(v)).toBe('—');
  });

  it('renders zero (and negative zero) without decimals', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(-0)).toBe('$0');
    expect(inr(0)).toBe('₹0');
  });

  it.each([
    [1, '$1.00'],
    [0.01, '$0.01'],
    [0.1, '$0.10'],
    [12.345678, '$12.35'],
    [1234.5, '$1,234.50'],
    [1_000_000_000, '$1,000,000,000.00'],
  ])('uses two decimals and thousands separators at or above a cent: %s', (v, out) => {
    expect(usd(v)).toBe(out);
  });

  it.each([
    [0.0099, '$0.0099'],
    [0.005, '$0.0050'],
    [0.001, '$0.0010'],
    [0.00123, '$0.0012'],
    [0.000456, '$0.00046'],
    [2.5e-7, '$0.00000025'],
  ])('keeps two significant digits below a cent: %s', (v, out) => {
    expect(usd(v)).toBe(out);
  });

  it('caps the decimals at ten for vanishingly small amounts', () => {
    expect(usd(1e-12)).toBe('$0.0000000000');
    expect(usd(1e-300)).toBe('$0.0000000000');
  });

  it('never falls into scientific notation', () => {
    for (let exp = -1; exp >= -20; exp--) {
      const v = 3.7 * 10 ** exp;
      expect(usd(v)).not.toMatch(/e/i);
      expect(inr(-v)).not.toMatch(/e/i);
    }
    expect(usd(1e21)).not.toMatch(/e/i);
  });

  it('puts the sign before the currency symbol', () => {
    expect(usd(-0.5)).toBe('-$0.50');
    expect(usd(-1234.5)).toBe('-$1,234.50');
    expect(inr(-2.5e-7)).toBe('-₹0.00000025');
  });

  it('formats INR with the rupee sign and en-US grouping', () => {
    expect(inr(94.43)).toBe('₹94.43');
    expect(inr(123456.789)).toBe('₹123,456.79');
    expect(inr(0.0042)).toBe('₹0.0042');
  });
});

describe('num', () => {
  it.each([undefined, NaN, Infinity, -Infinity])('renders %s as an em dash', (v) => {
    expect(num(v)).toBe('—');
  });

  it('rounds to the requested decimals using the runtime locale', () => {
    expect(num(1234.567)).toBe((1235).toLocaleString());
    expect(num(1234.567, 2)).toBe((1234.57).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    expect(num(0)).toBe('0');
    expect(num(1.25, 1)).toBe((1.3).toLocaleString());
  });

  it('does not pad to the maximum decimals', () => {
    expect(num(2, 3)).toBe('2');
  });
});

describe('UNIT_LABEL', () => {
  it('names every usage unit', () => {
    expect(UNIT_LABEL).toEqual({ tokens: 'tokens', characters: 'chars', audio_seconds: 's audio' });
  });
});

const leg = (over: Partial<LegUsage>): LegUsage => ({
  leg: 'llm',
  providerId: 'p',
  modelId: 'm',
  unit: 'tokens',
  inputUnits: 0,
  outputUnits: 0,
  source: 'vendor',
  ...over,
});
const turn = (legs: LegUsage[]): TurnUsage => ({ turnId: 1, at: 0, legs, costUsd: 0, costInr: 0, unpriced: [] });

describe('legOf / isPipeline', () => {
  const stt = leg({ leg: 'stt', unit: 'audio_seconds' });
  const llm = leg({ leg: 'llm' });
  const llm2 = leg({ leg: 'llm', providerId: 'second' });
  const rt = leg({ leg: 'realtime' });

  it('finds the first leg of the requested kind', () => {
    expect(legOf(turn([stt, llm, llm2]), 'llm')).toBe(llm);
    expect(legOf(turn([stt]), 'stt')).toBe(stt);
  });

  it('returns undefined for an absent leg', () => {
    expect(legOf(turn([stt]), 'tts')).toBeUndefined();
    expect(legOf(turn([]), 'llm')).toBeUndefined();
  });

  it('calls a turn pipeline exactly when it has an LLM leg', () => {
    expect(isPipeline(turn([stt, llm]))).toBe(true);
    expect(isPipeline(turn([rt]))).toBe(false);
    expect(isPipeline(turn([]))).toBe(false);
  });
});

describe('duration', () => {
  it.each([
    [0, '0s'],
    [499, '0s'],
    [500, '1s'],
    [1_000, '1s'],
    [59_499, '59s'],
    [59_500, '1m 00s'],
    [60_000, '1m 00s'],
    [61_000, '1m 01s'],
    [125_000, '2m 05s'],
    [3_600_000, '60m 00s'],
    [3_661_000, '61m 01s'],
  ])('%s ms -> %s', (v, out) => {
    expect(duration(v)).toBe(out);
  });
});

describe('when', () => {
  it('formats an epoch as short month, day and 2-digit time in the local zone', () => {
    vi.stubEnv('TZ', 'UTC');
    const out = when(Date.UTC(2026, 9, 20, 14, 5));
    // Locale-dependent wording, but always the same instant as the runtime renders it.
    expect(out).toBe(
      new Date(Date.UTC(2026, 9, 20, 14, 5)).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    expect(out).toMatch(/20/);
    expect(out).toMatch(/05/);
  });
});

describe('ms', () => {
  it.each([undefined, NaN, Infinity])('renders %s as an em dash', (v) => {
    expect(ms(v)).toBe('—');
  });

  it.each([
    [0, '0'],
    [0.4, '0'],
    [287.9, '288'],
    [1234.5, '1,235'],
    [10_000_000, '10,000,000'],
  ])('%s -> %s', (v, out) => {
    expect(ms(v)).toBe(out);
  });
});

describe('secs', () => {
  it.each([undefined, NaN, -Infinity])('renders %s as an em dash', (v) => {
    expect(secs(v)).toBe('—');
  });

  it.each([
    [0, '0.0s'],
    [1500, '1.5s'],
    [1234, '1.2s'],
    [60_000, '60.0s'],
    [123_456_789, '123456.8s'],
  ])('%s ms -> %s', (v, out) => {
    expect(secs(v)).toBe(out);
  });
});

describe('pct', () => {
  it('is 0% when the whole is zero or not a number', () => {
    expect(pct(5, 0)).toBe('0%');
    expect(pct(0, 0)).toBe('0%');
    expect(pct(1, NaN)).toBe('0%');
  });

  it.each([
    [1, 3, '33%'],
    [2, 3, '67%'],
    [1, 2, '50%'],
    [1, 200, '1%'],
    [1, 201, '0%'],
    [3, 2, '150%'],
    [0, 7, '0%'],
  ])('%s of %s -> %s', (part, whole, out) => {
    expect(pct(part, whole)).toBe(out);
  });
});

describe('monthly', () => {
  it('projects per-turn cost over 30 days', () => {
    expect(monthly(0.001, 1000)).toBe('$30');
    expect(monthly(0.0001, 10)).toBe('$0.03');
    expect(monthly(1, 100)).toBe('$3,000');
    expect(monthly(0, 0)).toBe('$0.00');
  });

  it('switches format exactly at the $10 and $1,000 boundaries', () => {
    expect(monthly(9.994 / 30, 1)).toBe('$9.99');
    expect(monthly(10 / 30, 1)).toBe('$10');
    expect(monthly(999 / 30, 1)).toBe('$999');
    expect(monthly(1000 / 30, 1)).toBe('$1,000');
    expect(monthly(1_234_567 / 30, 1)).toBe('$1,234,567');
  });

  it('renders a non-finite projection as an em dash', () => {
    expect(monthly(NaN, 1)).toBe('—');
    expect(monthly(Infinity, 1)).toBe('—');
    expect(monthly(1, Infinity)).toBe('—');
  });

  // BUG (src/lib/format.ts:98): totals in [999.5, 1000) take the `toFixed(0)`
  // branch and round up to "1000" — printed without the separator that the
  // ">= 1000" branch one cent later gives "$1,000".
  it.fails('formats a total that rounds to 1000 the same way as 1000 itself', () => {
    expect(monthly(999.6 / 30, 1)).toBe('$1,000');
  });
});
