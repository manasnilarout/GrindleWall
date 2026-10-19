import type { TurnRecord } from '../hooks/useVoiceSession';
import type { SessionMode, TurnUsage } from '../lib/protocol';
import { bandsOf, slowestLeg, type LegBandKey, type LegMedian } from '../lib/legs';
import { medianOf, summarize } from '../lib/stats';
import { inr, ms, monthly, num, usd } from '../lib/format';
import { LegBars } from './Waterfall';
import { Icon, PanelIcon } from './Icon';

/**
 * The right-hand rail: the two numbers a run is judged on, and one sentence
 * saying what to do about them.
 *
 * The old UI put the median at the top of a table and left the reader to work
 * out what it meant. A median with no verdict beside it is a number you have to
 * interpret every single time.
 */
export function InsightsPanel({ turns, mode }: { turns: TurnRecord[]; mode?: SessionMode }) {
  /**
   * Time to first audio, from t0 — the server's figure, because it is the only
   * one measured from t0.
   *
   * The browser's number used to stand in here whenever it existed. It should
   * not have: it starts its clock at the final transcript, so it excludes STT
   * and includes two network hops. Mixing the two produced a "median" over two
   * different measurements, and on a slow-STT rig the headline silently got
   * faster the worse the STT leg was.
   */
  const ttfa = summarize(
    turns.map((t) => t.derived.timeToFirstAudioMs).filter((v): v is number => v !== undefined),
  );
  /** Reported separately, never merged: different origin, different meaning. */
  const browserSide = summarize(turns.map((t) => t.clientTtfaMs).filter((v): v is number => v !== undefined));

  if (!ttfa) {
    return (
      <section className="panel">
        <h2>
          <PanelIcon name="lightning" />
          Time to first audio
        </h2>
        <p className="muted">Complete a turn to collect numbers.</p>
      </section>
    );
  }

  // Each leg's median taken across every turn, rather than the split of
  // whichever single turn landed on the median: one unlucky turn should not
  // decide what the whole run looks like.
  const legs: LegMedian[] = (['stt', 'llm', 'tts'] as const)
    .map((key: LegBandKey) => {
      const sample = turns.map((t) => bandsOf(t.derived, t.marks).find((b) => b.key === key)).find(Boolean);
      const value = medianOf(
        turns
          .map((t) => bandsOf(t.derived, t.marks).find((b) => b.key === key)?.ms)
          .filter((v): v is number => v !== undefined),
      );
      return sample && value !== undefined
        ? { key: sample.key, name: sample.name, color: sample.color, ms: value }
        : undefined;
    })
    .filter((b): b is LegMedian => b !== undefined);

  // A realtime model answers from your audio, not from a transcript. The STT
  // band it can carry is when that transcript arrived — a by-product, not a
  // leg the reply waited on — so it is reported, never split out or ranked.
  const transcriptMs = mode === 'realtime' ? legs.find((l) => l.key === 'stt')?.ms : undefined;
  const split = mode === 'realtime' ? [] : legs;
  const worst = slowestLeg(split);

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="lightning" />
        Time to first audio
        <span className="right">median of {ttfa.n}</span>
      </h2>

      <div className="hero">
        <span className="hero-v">{ms(ttfa.median)}</span>
        <span className="hero-u">ms</span>
      </div>

      <div className="stat-row">
        <Stat label="p95" value={ms(ttfa.p95)} />
        <Stat label="min / max" value={`${ms(ttfa.min)} / ${ms(ttfa.max)}`} />
        <Stat label="jitter σ" value={`± ${ms(ttfa.sigma)}`} />
      </div>

      {browserSide && (
        <p className="foot">
          In the browser, audible a median of <strong>{ms(browserSide.median)} ms</strong> after the final transcript
          arrived — measured from a different origin than the figure above, so the two are not differenced.
        </p>
      )}

      {split.length === 0 && (
        <p className="foot">
          {mode === 'realtime'
            ? 'No leg was timed on its own, so there is nothing to split: a realtime model answers straight from your audio.'
            : 'No leg was timed on its own, so there is nothing to split.'}
          {transcriptMs !== undefined && ` Its transcript of your speech arrived at ${ms(transcriptMs)} ms (median).`}
        </p>
      )}

      {split.length > 0 && (
        <div className="leg-medians">
          <h3>Median per leg</h3>
          <LegBars legs={split} scaleMs={ttfa.median} />
          <p className="foot">Measured against their own start marks, so they overlap and do not add up to the turn.</p>
        </div>
      )}

      {worst && (
        <p className="verdict">
          <Icon name="crystal" size={16} />
          {split.length > 1 ? (
            <span>
              <strong>{worst.name}</strong> is the slowest leg at {ms(worst.ms)} ms median. Swap it first.
            </span>
          ) : (
            <span>
              Only <strong>{worst.name}</strong> was measured ({ms(worst.ms)} ms median), so there is no slower leg to
              single out.
            </span>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Live cost, and the same figure at a volume anyone can reason about.
 *
 * A voice turn costs a fraction of a cent, which is a number nobody has
 * intuition for. The monthly projection is the same arithmetic in the unit the
 * decision is actually made in — and it is labelled a projection, because it
 * assumes every future turn looks like the ones measured here.
 */
export function CostPanel({ usage }: { usage: TurnUsage[] }) {
  if (usage.length === 0) {
    return (
      <section className="panel">
        <h2>
          <PanelIcon name="potion" />
          Cost
        </h2>
        <p className="muted">No turn completed, so nothing was consumed.</p>
      </section>
    );
  }

  const totalUsd = usage.reduce((sum, t) => sum + t.costUsd, 0);
  const totalInr = usage.reduce((sum, t) => sum + t.costInr, 0);
  const perTurn = totalUsd / usage.length;
  const unpriced = [...new Set(usage.flatMap((t) => t.unpriced))];
  const tokens = usage.reduce((sum, t) => {
    const llm = t.legs.find((l) => l.leg === 'llm');
    return sum + (llm ? llm.inputUnits + llm.outputUnits : 0);
  }, 0);
  // A locally counted figure is never shown as a measurement, here or anywhere.
  const estimated = usage.some((t) => t.legs.some((l) => l.source === 'local'));
  const tokensEstimated = usage.some((t) => t.legs.some((l) => l.leg === 'llm' && l.source === 'local'));

  /**
   * The FX rate the server actually used, recovered from the figures it sent.
   *
   * Both totals are the same legs converted with the same rate, so their ratio
   * IS `usdPerInr` — no second source, and nothing to go stale. This used to be
   * a hardcoded default that `App` never overrode, so the panel printed a fixed
   * "₹94.43 / $1" regardless of what the backend was using: exactly the baked-in
   * rate the project's own invariant exists to prevent. When there is no INR
   * figure to divide by, the line is omitted rather than guessed.
   */
  const inrPerUsd = totalInr > 0 && totalUsd > 0 ? totalInr / totalUsd : undefined;

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="potion" />
        Cost
        {inrPerUsd !== undefined && <span className="right">₹{inrPerUsd.toFixed(2)} / $1, assumed</span>}
      </h2>

      <div className="hero">
        <span className="hero-v small">{usd(perTurn)}</span>
        <span className="hero-sub">per turn · {inr(totalInr / usage.length)}</span>
      </div>

      <dl className="cost-list">
        <dt>This conversation</dt>
        <dd>
          {usd(totalUsd)} · {usage.length} {usage.length === 1 ? 'turn' : 'turns'}
        </dd>
        <dt>At 10k turns a day</dt>
        <dd title="Assumes every future turn costs what the ones measured here did">
          ≈ {monthly(perTurn, 10_000)} per month
        </dd>
        {tokens > 0 && (
          <>
            <dt>LLM tokens</dt>
            <dd className={tokensEstimated ? 'est' : ''} title={tokensEstimated ? 'Some counted locally' : undefined}>
              {`${tokensEstimated ? '~' : ''}${num(tokens)}`}
            </dd>
          </>
        )}
      </dl>

      {estimated && <p className="foot">Some counts are estimated locally, marked ~ in the usage table.</p>}

      {unpriced.length > 0 && (
        <p className="foot">No rate on file for {unpriced.join(', ')} — every figure above is a floor, not a bill.</p>
      )}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      <span className="stat-label">{label}</span>
    </div>
  );
}
