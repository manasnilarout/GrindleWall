import type { LegUsage, TurnUsage, UsageUnit } from './protocol';

/**
 * Voice-turn costs land in the fractions-of-a-cent range, where two decimal
 * places would render every number as "$0.00". Small amounts therefore keep
 * enough significant digits to stay comparable between providers.
 */
export function usd(n: number | undefined): string {
  return currency('$', n);
}

export function inr(n: number | undefined): string {
  return currency('₹', n);
}

/**
 * Enough decimals to tell values apart, thousands separators when large, and
 * **never** scientific notation: one leg of a short turn can cost ~2.5e-7, and
 * `toPrecision` renders that as "2.5e-7", which reads as a broken cell rather
 * than as a price.
 */
function currency(symbol: string, n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return `${symbol}0`;

  const v = Math.abs(n);
  // Two decimals down to a cent, then enough places to keep two significant
  // digits, capped where the difference stops being meaningful.
  const digits = v >= 0.01 ? 2 : Math.min(10, 1 - Math.floor(Math.log10(v)));
  const body = v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? '-' : ''}${symbol}${body}`;
}

export function num(n: number | undefined, dp = 0): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export const UNIT_LABEL: Record<UsageUnit, string> = {
  tokens: 'tokens',
  characters: 'chars',
  audio_seconds: 's audio',
};

export function legOf(usage: TurnUsage, leg: LegUsage['leg']): LegUsage | undefined {
  return usage.legs.find((l) => l.leg === leg);
}

/** Realtime sessions have no LLM leg of their own — the model is the whole pipeline. */
export function isPipeline(usage: TurnUsage): boolean {
  return usage.legs.some((l) => l.leg === 'llm');
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Milliseconds, rounded, with a thousands separator. `—` when unmeasured. */
export function ms(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** Seconds, one decimal place, for audio durations. */
export function secs(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return `${(v / 1000).toFixed(1)}s`;
}

export function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * A turn cost projected to a monthly bill. Fractions of a cent are impossible
 * to reason about; the same number at production volume is the form the
 * decision actually gets made in.
 */
export function monthly(perTurn: number, turnsPerDay: number): string {
  const total = perTurn * turnsPerDay * 30;
  if (!Number.isFinite(total)) return '—';
  if (total >= 1000) return `$${Math.round(total).toLocaleString('en-US')}`;
  if (total >= 10) return `$${total.toFixed(0)}`;
  return `$${total.toFixed(2)}`;
}
