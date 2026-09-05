/**
 * The one place summary statistics are computed in the frontend.
 *
 * These definitions have to match `UsageLedger`'s exactly — true median (the
 * midpoint of the middle pair on an even count) and nearest-rank p95 — because
 * the live panel and the end-of-conversation report describe the same turns.
 * They used to live inline in `MetricsPanel`, which meant the Compare view
 * would have had to reimplement them and could have drifted.
 */
export interface Summary {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  /** Population standard deviation — how much a run wobbles turn to turn. */
  sigma: number;
}

export function summarize(values: number[]): Summary | null {
  // Negatives are rejected, not just non-finite ones — `UsageLedger.note` does
  // the same, and a negative latency is a bug upstream, not a fast turn.
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) return null;

  const sorted = [...clean].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sorted.length;

  return {
    n: sorted.length,
    median: median(sorted),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sigma: Math.sqrt(variance),
  };
}

/** Median of an unsorted sample, or undefined when there is nothing to take one of. */
export function medianOf(values: number[]): number | undefined {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) return undefined;
  return median([...clean].sort((a, b) => a - b));
}

/**
 * True median. The even-count midpoint is rounded to one decimal place because
 * `UsageLedger.median` on the backend does exactly that, and these two have to
 * agree digit for digit: the live panel and the filed record describe the same
 * turns, so `[100.1, 100.2]` printing 100.15 here and 100.2 there is a
 * discrepancy a reader has no way to explain.
 */
function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid];
  return Number((((sorted[mid - 1] + sorted[mid]) / 2)).toFixed(1));
}

/** Nearest-rank: the smallest observation at or above the given fraction. */
function percentile(sorted: number[], q: number): number {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
