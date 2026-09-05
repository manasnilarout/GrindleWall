import { useState } from 'react';
import type { SessionSummary } from '../lib/protocol';
import { legMediansOf } from '../lib/legs';
import { duration, inr, monthly, ms, secs, usd, when } from '../lib/format';
import { downloadJson } from '../lib/download';
import { LegTotals, UsagePanel } from './UsagePanel';
import { LegBars } from './Waterfall';

type Tab = 'legs' | 'turns' | 'record';

const VOLUMES = [1_000, 10_000, 100_000, 1_000_000];

/**
 * The end-of-conversation breakdown, rendered the same way for the session that
 * just finished and for any record loaded from disk — one report format rather
 * than a live view and a divergent historical one.
 *
 * What is new here is context. The old report was correct and unreadable: four
 * stats, two tables, and a paragraph of caveats. Every rule the backend already
 * enforces is now attached to the number it governs, and the total appears at a
 * volume someone can actually reason about.
 */
export function SessionReport({
  summary,
  title = 'Conversation report',
  onDismiss,
}: {
  summary: SessionSummary;
  /** Reused for records loaded from disk, which did not just end. */
  title?: string;
  onDismiss?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('legs');
  const [volume, setVolume] = useState(10_000);

  const perTurnUsd = summary.turnCount ? summary.costUsd / summary.turnCount : 0;
  const perTurnInr = summary.turnCount ? summary.costInr / summary.turnCount : 0;
  const legs = legMediansOf(summary.latency);
  const localLegs = summary.totals.filter((l) => l.source === 'local');

  return (
    <section className="panel report">
      <h2>
        {title}
        {onDismiss && (
          <button type="button" className="ghost inline" onClick={onDismiss}>
            dismiss
          </button>
        )}
      </h2>

      <div className="report-head">
        <code>{summary.label}</code>
        <span className="muted">
          {when(summary.startedAt)} · {duration(summary.durationMs)} · {summary.turnCount}{' '}
          {summary.turnCount === 1 ? 'turn' : 'turns'}
          {summary.config.language && <> · {summary.config.language}</>}
          {summary.config.voice && <> · voice {summary.config.voice}</>}
        </span>
      </div>

      <div className="hero-row">
        <div className="h">
          <div className="hv big">{usd(summary.costUsd)}</div>
          <div className="hs">{inr(summary.costInr)}</div>
          <div className="hl">Total, {summary.turnCount} turns</div>
        </div>
        <div className="h">
          <div className="hv">{usd(perTurnUsd)}</div>
          <div className="hs">{inr(perTurnInr)}</div>
          <div className="hl">Per turn</div>
        </div>
        <div className="h">
          <div className="hv">
            {ms(summary.latency.ttfaMedianMs)} <span className="hs">ms</span>
          </div>
          <div className="hl">TTFA median</div>
        </div>
        <div className="h">
          <div className="hv">
            {ms(summary.latency.ttfaP95Ms)} <span className="hs">ms</span>
          </div>
          <div className="hl">TTFA p95</div>
        </div>
        <div className="h">
          <div className="hv">
            {ms(summary.latency.ttfaMinMs)} / {ms(summary.latency.ttfaMaxMs)}
          </div>
          <div className="hl">min / max</div>
        </div>
        {summary.latency.audioMedianMs !== undefined && (
          <div className="h">
            <div className="hv">{secs(summary.latency.audioMedianMs)}</div>
            <div className="hl">Reply length, median</div>
          </div>
        )}
      </div>

      {summary.unpriced.length > 0 && (
        <p className="banner warn inline-banner">
          No rate on file for {summary.unpriced.join(', ')} — every total here is a floor, not a bill.
        </p>
      )}

      <div className="columns report-cols">
        <div className="col">
          <div className="seg">
            <button type="button" className={tab === 'legs' ? 'on' : ''} onClick={() => setTab('legs')}>
              Per leg
            </button>
            <button type="button" className={tab === 'turns' ? 'on' : ''} onClick={() => setTab('turns')}>
              Per turn
            </button>
            <button type="button" className={tab === 'record' ? 'on' : ''} onClick={() => setTab('record')}>
              Record on disk
            </button>
          </div>

          {tab === 'legs' && (
            <>
              <LegTotals legs={summary.totals} />
              <p className="muted small foot">
                <span className="est">~</span> counted here rather than reported by the vendor. In the table above,
                bold marks the currency that vendor actually bills in; the dimmed figure went through{' '}
                <strong>₹{(1 / summary.usdPerInr).toFixed(2)} per $1</strong> — an assumed rate, not a live one (set{' '}
                <code>USD_PER_INR</code> to change it). Turn and session totals mix vendors, so each is part quoted and
                part converted.
              </p>
            </>
          )}

          {tab === 'turns' && <UsagePanel usage={summary.turns} compact />}

          {tab === 'record' && (
            <>
              <pre className="jsonbox">{JSON.stringify(summary, null, 2)}</pre>
              <p className="muted small foot">
                The record as filed. No credentials — provider and model ids, the system prompt, usage and cost. The
                prompt is kept deliberately, since it is what produced these numbers, so treat{' '}
                <code>data/sessions/</code> as conversation content.
              </p>
            </>
          )}
        </div>

        <div className="col">
          {legs.length > 0 && (
            <section className="panel inner">
              <h2>Median per leg</h2>
              <LegBars legs={legs} scaleMs={summary.latency.ttfaMedianMs} />
              <p className="muted small foot">
                Each leg is timed from its own start mark, so these overlap and do not add up to the turn — a pipeline
                opens the TTS socket while the LLM is still thinking. t0 is the moment the user stopped speaking: the
                vendor's own speech-end event where it publishes one, the local detector where it does not. Vendor
                connection setup is inside that window on purpose.
              </p>
            </section>
          )}

          <section className="panel inner">
            <h2>
              At production volume
              <span className="right muted">same numbers, bigger</span>
            </h2>
            <div className="seg">
              {VOLUMES.map((v) => (
                <button key={v} type="button" className={v === volume ? 'on' : ''} onClick={() => setVolume(v)}>
                  {v >= 1_000_000 ? '1M' : `${v / 1000}k`} / day
                </button>
              ))}
            </div>
            <div className="hero">
              <span className="hero-v small">{monthly(perTurnUsd, volume)}</span>
              <span className="hero-u">/ month</span>
            </div>
            <p className="muted small foot">
              A projection, not a quote: it assumes every future turn looks like the {summary.turnCount} measured here,
              and that no rate moves.
            </p>
          </section>

          <section className="panel inner">
            <h2>How much to trust each number</h2>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr>
                    <td>TTFA, and every leg latency</td>
                    <td className="muted">measured on the bench</td>
                  </tr>
                  <tr>
                    <td>t0</td>
                    <td className="muted">vendor speech-end, or the local detector</td>
                  </tr>
                  {summary.totals.map((leg) => (
                    <tr key={`${leg.leg}-${leg.providerId}-${leg.modelId}`}>
                      <td className="upper">{leg.leg} units</td>
                      <td>
                        <span className={`pill ${leg.source}`}>{leg.source === 'vendor' ? 'vendor' : 'counted here'}</span>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Every rate</td>
                    <td className="muted">vendor page + the date it was read</td>
                  </tr>
                  <tr>
                    <td>INR ↔ USD</td>
                    <td className="muted">
                      <span className="warn-flag">assumed</span> ₹{(1 / summary.usdPerInr).toFixed(2)}
                    </td>
                  </tr>
                  <tr>
                    <td>Audio quality</td>
                    <td className="muted">not measured — listen</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {localLegs.length > 0 && (
              <p className="muted small foot">
                {localLegs.map((l) => l.leg).join(' and ')} {localLegs.length === 1 ? 'is' : 'are'} counted in this
                process. The unit is the one the invoice uses; the count is ours.
              </p>
            )}
          </section>
        </div>
      </div>

      <div className="button-row report-foot">
        <button
          type="button"
          className="ghost"
          onClick={() => downloadJson(summary, `session-${summary.recordId}.json`)}
        >
          Export session as JSON
        </button>
        {/* A conversation with no completed turn is never written to disk. */}
        {summary.turnCount > 0 && (
          <span className="muted small">Also saved server-side as {summary.recordId}.json</span>
        )}
      </div>
    </section>
  );
}
