import type { DerivedMetrics, MetricMark, MetricName, SessionSummary } from './protocol';

/**
 * The four bands a turn's latency is reported in, in fixed order.
 *
 * The colours are a validated categorical palette rather than the app's status
 * colours: `--ok` and `--warn` mean "ready" and "estimated" everywhere else in
 * this UI, and reusing them for a series would make a green TTS band read as a
 * verdict on the TTS leg. Measured on the old #1e222a shell — worst adjacent
 * pair 9.4 ΔE under deuteranopia, 26.5 with normal vision, all three above 3:1
 * contrast. The hexes did not change for the parchment restyle: they are
 * categorical fills, not chrome, and still read on `--panel`. Don't retint
 * them to match the theme.
 *
 * Order is the CVD-safety mechanism, not decoration: STT and TTS sit either
 * side of LLM precisely because blue↔aqua is the pair that would fail if they
 * were adjacent. Don't reorder these to taste.
 *
 * This module is the single source of truth for those hexes. They are consumed
 * as inline styles, so they cannot come from CSS custom properties.
 */
export const LEG_BANDS = [
  { key: 'stt', name: 'STT', color: '#3987e5' },
  { key: 'llm', name: 'LLM TTFT', color: '#d95926' },
  { key: 'tts', name: 'TTS TTFB', color: '#199e70' },
  /*
   * There is deliberately no "network" band.
   *
   * One was derived as `clientTtfaMs - timeToFirstAudioMs`, which looked like
   * the browser's share of the turn and was not: the two are measured from
   * different origins (see `TurnRecord.clientTtfaMs`), so their difference is
   * not a duration of anything. Subtracting them produced a plausible small
   * number — occasionally a negative one, which was then silently dropped.
   */
] as const;

export type LegBandKey = (typeof LEG_BANDS)[number]['key'];

const COLOR_OF = Object.fromEntries(LEG_BANDS.map((b) => [b.key, b])) as Record<
  LegBandKey,
  (typeof LEG_BANDS)[number]
>;

/**
 * One leg's interval within a turn: when it started relative to t0, and how
 * long it took.
 *
 * **`startMs` is the whole point.** These legs are NOT a partition of the turn
 * — they are overlapping intervals measured against different origins, and a
 * pipeline deliberately overlaps them: TTS opens its socket as soon as the turn
 * begins, so `tts_request_sent` routinely precedes `llm_first_token`. On this
 * repo's own smoke output, t0→first-audio was 287.9 ms while the three leg
 * durations summed to 468.5 ms. Laying them end to end would draw a turn 1.63×
 * longer than it was and report each leg's "share" of a total that never
 * existed. So every band carries its real offset and is drawn where it actually
 * happened.
 */
export interface Band {
  key: LegBandKey;
  name: string;
  color: string;
  /** ms after t0 at which this leg's interval opened. */
  startMs: number;
  /** Duration of the interval. */
  ms: number;
}

const at = (marks: MetricMark[], name: MetricName): number | undefined =>
  marks.find((m) => m.name === name)?.atMs;

/**
 * Splits one turn into positioned bands, using the marks the server already
 * sent for exactly this purpose.
 *
 * A band is emitted only when both its duration and its start are known. A leg
 * with no measurement is absent rather than drawn at zero — a realtime turn has
 * no STT or LLM mark at all, and a zero-width band there would read as a vendor
 * that answered instantly.
 *
 * A duration of exactly `0` IS kept: `TurnMetrics` quantises to 0.1 ms, so a
 * mock provider legitimately reports 0 ms, and dropping it would conflate
 * "instant" with "never measured".
 */
export function bandsOf(derived: DerivedMetrics, marks: MetricMark[] = []): Band[] {
  const t0 = at(marks, 'user_speech_end') ?? 0;
  const bands: Band[] = [];

  const push = (key: LegBandKey, startMs: number | undefined, ms: number | undefined) => {
    if (startMs === undefined || ms === undefined || !Number.isFinite(ms) || ms < 0) return;
    bands.push({ ...COLOR_OF[key], startMs: Math.max(0, startMs - t0), ms });
  };

  // STT runs from t0 by definition, so it needs no mark of its own.
  push('stt', derived.sttLatencyMs === undefined ? undefined : t0, derived.sttLatencyMs);
  push('llm', at(marks, 'llm_request_sent'), derived.llmTtftMs);
  push('tts', at(marks, 'tts_request_sent'), derived.ttsTtfbMs);

  return bands.sort((a, b) => a.startMs - b.startMs);
}

/**
 * A leg's median over a whole conversation, for comparing runs.
 *
 * Deliberately NOT a `Band`: a record on disk keeps medians, not marks, so
 * there is no honest way to position these against one another. They are
 * rendered as separate bars against a shared scale — never stacked, and never
 * as percentages of a total, because summing overlapping medians produces a
 * number that is not the turn.
 */
export interface LegMedian {
  key: LegBandKey;
  name: string;
  color: string;
  ms: number;
}

export function legMediansOf(latency: SessionSummary['latency']): LegMedian[] {
  const raw: Partial<Record<LegBandKey, number | undefined>> = {
    stt: latency.sttMedianMs,
    llm: latency.llmTtftMedianMs,
    tts: latency.ttsTtfbMedianMs,
  };
  return LEG_BANDS.filter((b) => raw[b.key] !== undefined).map((b) => ({
    key: b.key,
    name: b.name,
    color: b.color,
    ms: raw[b.key] as number,
  }));
}

/**
 * The leg that took longest, for the one-line verdict. A max, not a share,
 * which is why it stays meaningful even though the legs overlap.
 */
export function slowestLeg<T extends { ms: number }>(legs: T[]): T | undefined {
  if (legs.length === 0) return undefined;
  return legs.reduce((worst, b) => (b.ms > worst.ms ? b : worst));
}
