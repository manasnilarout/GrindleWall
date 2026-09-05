import type { SessionSummary } from '../lib/protocol';
import { duration, inr, num, usd, when } from '../lib/format';
import { downloadJson } from '../lib/download';
import { LegTotals, UsagePanel } from './UsagePanel';

/**
 * The end-of-conversation breakdown. Rendered both for the session that just
 * finished and for any past session loaded from disk, so there is one report
 * format rather than a live view and a divergent historical one.
 */
export function SessionReport({
  summary,
  title = 'Conversation ended',
  onDismiss,
}: {
  summary: SessionSummary;
  /** Reused for records loaded from disk, which did not just end. */
  title?: string;
  onDismiss?: () => void;
}) {
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
        </span>
      </div>

      <div className="summary">
        <Stat label="Estimated total cost" value={usd(summary.costUsd)} sub={inr(summary.costInr)} big />
        <Stat
          label="Per turn"
          value={summary.turnCount ? usd(summary.costUsd / summary.turnCount) : '—'}
          sub={summary.turnCount ? inr(summary.costInr / summary.turnCount) : undefined}
        />
        <Stat label="TTFA median" value={summary.latency.ttfaMedianMs === undefined ? '—' : `${num(summary.latency.ttfaMedianMs)} ms`} />
        <Stat label="TTFA p95" value={summary.latency.ttfaP95Ms === undefined ? '—' : `${num(summary.latency.ttfaP95Ms)} ms`} />
      </div>

      {summary.unpriced.length > 0 && (
        <p className="muted small">
          No rate on file for {summary.unpriced.join(', ')} — the total is a floor, not a bill.
        </p>
      )}

      <h3>Per leg</h3>
      <LegTotals legs={summary.totals} />
      <p className="muted small">
        <span className="est">~</span> counted locally rather than reported by the vendor. In the table
        above, bold marks the currency that vendor actually bills in; the dimmed figure is converted at{' '}
        <strong>₹{(1 / summary.usdPerInr).toFixed(2)} per $1</strong> — an assumed rate, not a live one
        (set <code>USD_PER_INR</code> to change it). Turn and session totals mix vendors, so each of
        those is part quoted and part converted.
      </p>

      <h3>Per turn</h3>
      <UsagePanel usage={summary.turns} compact />

      <div className="button-row">
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

function Stat({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div className={`stat ${big ? 'big' : ''}`}>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      <span className="stat-label">{label}</span>
    </div>
  );
}
