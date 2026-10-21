import { describe, expect, it } from 'vitest';
import { medianOf, summarize } from '../../src/lib/stats';

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('summarize', () => {
  it('returns null for an empty sample', () => {
    expect(summarize([])).toBeNull();
  });

  it('returns null when nothing survives the filter', () => {
    expect(summarize([NaN, Infinity, -Infinity, -1, -0.001])).toBeNull();
  });

  it('describes a single value', () => {
    expect(summarize([42])).toEqual({ n: 1, median: 42, p95: 42, min: 42, max: 42, sigma: 0 });
  });

  it('keeps zero (an instant mock turn) but drops negatives and non-finite values', () => {
    const s = summarize([0, -5, NaN, 10, Infinity])!;
    expect(s.n).toBe(2);
    expect(s.min).toBe(0);
    expect(s.max).toBe(10);
    expect(s.median).toBe(5);
  });

  it('sorts numerically, not lexically', () => {
    const s = summarize([100, 9, 20, 3])!;
    expect(s.min).toBe(3);
    expect(s.max).toBe(100);
    expect(s.median).toBe(14.5);
  });

  it('does not mutate its input', () => {
    const input = [5, 1, 4, 2, 3];
    summarize(input);
    expect(input).toEqual([5, 1, 4, 2, 3]);
  });

  it('takes the middle value on an odd count, unrounded', () => {
    expect(summarize([3.14159, 1, 9])!.median).toBe(3.14159);
  });

  it('takes the midpoint of the middle pair on an even count, rounded to 0.1 like the backend', () => {
    expect(summarize([100.1, 100.2])!.median).toBe(100.2);
    expect(summarize([1, 2])!.median).toBe(1.5);
    expect(summarize([1, 2, 3, 4])!.median).toBe(2.5);
    expect(summarize([10.01, 10.02])!.median).toBe(10);
    // 0.15 is 0.1499999… in binary, and toFixed rounds the binary value — the
    // backend's `round(_, 1)` does the same, so the two still agree.
    expect(summarize([0, 0.3])!.median).toBe(0.1);
  });

  it('computes a nearest-rank p95', () => {
    expect(summarize([1, 2])!.p95).toBe(2);
    expect(summarize(range(19))!.p95).toBe(19); // ceil(18.05) = 19
    expect(summarize(range(20))!.p95).toBe(19); // ceil(19) = 19: exactly at the rank
    expect(summarize(range(21))!.p95).toBe(20); // ceil(19.95) = 20
    expect(summarize(range(100))!.p95).toBe(95);
    expect(summarize(range(101))!.p95).toBe(96);
  });

  it('never indexes out of range for a nearest-rank p95', () => {
    for (let n = 1; n <= 500; n++) {
      const values = range(n);
      const p95 = summarize(values)!.p95;
      expect(p95).toBe(Math.ceil(0.95 * n));
      expect(p95).toBeGreaterThanOrEqual(1);
      expect(p95).toBeLessThanOrEqual(n);
    }
  });

  it('reports the population standard deviation', () => {
    expect(summarize([2, 4, 4, 4, 5, 5, 7, 9])!.sigma).toBe(2);
    expect(summarize([7, 7, 7])!.sigma).toBe(0);
    expect(summarize([0, 10])!.sigma).toBe(5);
  });

  it('handles huge values without overflow', () => {
    const s = summarize([1e300, 1e300])!;
    expect(s.median).toBe(1e300);
    expect(s.sigma).toBe(0);
  });
});

describe('medianOf', () => {
  it('is undefined when there is nothing to take a median of', () => {
    expect(medianOf([])).toBeUndefined();
    expect(medianOf([-1, NaN, Infinity])).toBeUndefined();
  });

  it('agrees with summarize', () => {
    for (const sample of [[1], [3, 1, 2], [4, 1, 3, 2], [100.1, 100.2], [0, 0, 1]]) {
      expect(medianOf(sample)).toBe(summarize(sample)!.median);
    }
  });

  it('keeps a zero median', () => {
    expect(medianOf([0])).toBe(0);
    expect(medianOf([0, 0, 5])).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    medianOf(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
