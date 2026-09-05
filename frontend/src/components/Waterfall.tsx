import type { Band, LegMedian } from '../lib/legs';
import { LEG_BANDS } from '../lib/legs';
import { ms, secs } from '../lib/format';

/**
 * One horizontal bar per turn, split into the legs that made it up.
 *
 * The table this replaces had every number in it and still made you do the
 * arithmetic: eight columns of milliseconds, and finding the slow leg meant
 * scanning across and subtracting. A bar answers that at a glance, which is the
 * whole reason the numbers are collected.
 *
 * Every row is drawn against **one** scale for the panel, never its own, so
 * turn 4 being twice as long as turn 3 looks twice as long.
 */
export interface WaterfallRow {
  turnId: number;
  bands: Band[];
  /**
   * t0 → first sample audible. Read off the turn's own measurement, NOT summed
   * from the bands: the legs overlap, so adding them up produces a longer turn
   * than the one that happened.
   */
  totalMs?: number;
  /** The reply playing out after that. Hatched, because it is not latency. */
  tailMs?: number;
}

export function Waterfall({ rows, scaleMs }: { rows: WaterfallRow[]; scaleMs: number }) {
  // Never divide by zero, and never let a single fast turn fill the panel.
  const scale = Math.max(scaleMs, 1);
  const pos = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100)).toFixed(3)}%`;
  // A band of 0 ms still gets a hairline, so "measured, instant" is visible and
  // distinguishable from "not measured", which draws nothing at all.
  const span = (v: number) => `${Math.max(0.4, Math.min(100, (v / scale) * 100)).toFixed(3)}%`;

  return (
    <div className="wf">
      {rows.map((row) => (
        <div className="wf-row" key={row.turnId}>
          <span className="wf-n">{row.turnId}</span>
          <span className="wf-track">
            {/*
              Absolutely positioned, not stacked. Each leg is drawn where it
              actually ran, so an overlap — TTS opening its socket while the LLM
              is still thinking — is visible as an overlap rather than silently
              inflating the turn.
            */}
            <span className="wf-bar">
              {row.tailMs !== undefined && row.tailMs > 0 && row.totalMs !== undefined && (
                <span
                  className="wf-tail"
                  style={{ left: pos(row.totalMs), width: span(row.tailMs) }}
                  title={`reply plays out — ${secs(row.tailMs)} of audio`}
                />
              )}
              {row.bands.map((band) => (
                <span
                  key={band.key}
                  className="wf-seg"
                  style={{ left: pos(band.startMs), width: span(band.ms), background: band.color }}
                  title={`${band.name} — ${ms(band.ms)} ms, starting ${ms(band.startMs)} ms after t0`}
                />
              ))}
              {row.totalMs !== undefined && (
                <span
                  className="wf-mark"
                  style={{ left: pos(row.totalMs) }}
                  title={`audible ${ms(row.totalMs)} ms after t0`}
                />
              )}
            </span>
          </span>
          <span className={`wf-total ${(row.totalMs ?? 0) > 900 ? 'slow' : ''}`}>{ms(row.totalMs)} ms</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Always rendered, even for a realtime session that only ever fills one band —
 * an absent key reads as "this chart has one colour", where a key with three
 * unused entries reads as "this architecture has nothing inside it to show",
 * which is the actual finding.
 */
export function WaterfallLegend() {
  return (
    <span className="legend">
      {LEG_BANDS.map((band) => (
        <span key={band.key}>
          <i style={{ background: band.color }} />
          {band.name}
        </span>
      ))}
    </span>
  );
}

/** Tick labels under the bars, derived from the same scale the bars used. */
export function WaterfallAxis({ scaleMs }: { scaleMs: number }) {
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => scaleMs * f);
  return (
    <div className="wf-axis">
      <span>t0 · you stopped speaking</span>
      {ticks.map((t) => (
        <span key={t}>{t >= 1000 ? `${(t / 1000).toFixed(1)} s` : `${Math.round(t)} ms`}</span>
      ))}
    </div>
  );
}

/**
 * Per-leg medians as separate bars against a shared scale.
 *
 * This replaced a 100%-stacked bar, which was wrong: the legs overlap, so the
 * stack's total was not the turn and each segment's "share" was a fraction of a
 * number that does not exist. Separate bars against the turn's own median make
 * the same comparison without inventing a denominator — and a leg longer than
 * the median turn (entirely possible, since TTS TTFB is measured from its own
 * request, not from t0) is then simply a long bar rather than an impossibility.
 */
export function LegBars({
  legs,
  scaleMs,
  showKeys = true,
}: {
  legs: LegMedian[];
  scaleMs?: number;
  showKeys?: boolean;
}) {
  if (legs.length === 0) return <p className="muted small">No per-leg timings recorded.</p>;
  const scale = Math.max(scaleMs ?? 0, ...legs.map((l) => l.ms), 1);

  return (
    <div className="leg-bars">
      {legs.map((leg) => (
        <div className="leg-bar-row" key={leg.key}>
          {showKeys && <span className="leg-bar-name">{leg.name}</span>}
          <span className="leg-bar-track">
            <span
              className="leg-bar-fill"
              style={{ width: `${Math.max(0.6, (leg.ms / scale) * 100).toFixed(1)}%`, background: leg.color }}
              title={`${leg.name} — ${ms(leg.ms)} ms median`}
            />
          </span>
          {showKeys && <span className="leg-bar-val">{ms(leg.ms)} ms</span>}
        </div>
      ))}
    </div>
  );
}
