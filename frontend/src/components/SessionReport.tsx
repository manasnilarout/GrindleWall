import { useState, type ReactNode } from 'react';
import type { SessionSummary } from '../lib/protocol';
import type { ProviderEntry } from '../lib/catalog';
import { legMediansOf } from '../lib/legs';
import { inr, monthly, ms, usd } from '../lib/format';
import { sessionAudioUrl } from '../lib/auth';
import { LegTotals, UsagePanel, billedCurrency } from './UsagePanel';
import { LegBars } from './Waterfall';
import { Icon, PanelIcon } from './Icon';

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
 *
 * It is the body of the Run detail page; the page header (title, export, back)
 * belongs to `RunDetailView`, so this renders no heading of its own and `title`
 * names the region instead.
 */
export function SessionReport({
  summary,
  title = 'Conversation report',
  providers = [],
  onDismiss,
}: {
  summary: SessionSummary;
  /** Reused for records loaded from disk, which did not just end. */
  title?: string;
  /** For provider display names. Without it the table falls back to ids. */
  providers?: ProviderEntry[];
  onDismiss?: () => void;
}) {
  const [volume, setVolume] = useState(10_000);

  const perTurnUsd = summary.turnCount ? summary.costUsd / summary.turnCount : 0;
  const perTurnInr = summary.turnCount ? summary.costInr / summary.turnCount : 0;
  const legs = legMediansOf(summary.latency);
  const localLegs = summary.totals.filter((l) => l.source === 'local');
  const floor = summary.unpriced.length > 0;
  const fx = (1 / summary.usdPerInr).toFixed(2);
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name;

  // The headline leads with the currency the vendors actually bill in. Where
  // they disagree the total is part quoted and part converted, and USD leads.
  const billed = billedCurrency(summary.totals);
  const money = (usdValue: number, inrValue: number) =>
    billed === 'INR'
      ? { value: inr(inrValue), sub: usd(usdValue) }
      : { value: usd(usdValue), sub: inr(inrValue) };
  const convertedHint = billed
    ? 'Converted at the assumed FX rate'
    : 'These vendors bill in different currencies, so this is part quoted and part converted';
  const total = money(summary.costUsd, summary.costInr);
  const perTurn = money(perTurnUsd, perTurnInr);

  return (
    <section className="report" aria-label={title}>
      {onDismiss && (
        <div className="report-dismiss">
          <button type="button" className="ghost inline" onClick={onDismiss}>
            <Icon name="close" size={12} />
            Dismiss
          </button>
        </div>
      )}

      <div className="report-cards" role="group" aria-label="Headline numbers">
        <Card
          label={
            <>
              Total, {summary.turnCount} {summary.turnCount === 1 ? 'turn' : 'turns'}
              {floor && <span className="pill floor" title="At least one leg has no rate on file">floor</span>}
            </>
          }
          value={total.value}
          sub={total.sub}
          subTitle={convertedHint}
        />
        <Card label="Per turn" value={perTurn.value} sub={perTurn.sub} subTitle={convertedHint} />
        <Card
          label="First audio, median"
          value={ms(summary.latency.ttfaMedianMs)}
          unit={summary.latency.ttfaMedianMs === undefined ? undefined : 'ms'}
          sub="from when you stopped"
        />
        <Card
          label="p95"
          value={ms(summary.latency.ttfaP95Ms)}
          unit={summary.latency.ttfaP95Ms === undefined ? undefined : 'ms'}
          sub={`min ${ms(summary.latency.ttfaMinMs)} · max ${ms(summary.latency.ttfaMaxMs)}`}
        />
        {summary.latency.audioMedianMs !== undefined && (
          <Card
            label="Reply length, median"
            value={(summary.latency.audioMedianMs / 1000).toFixed(1)}
            unit="s"
            sub="of assistant audio"
          />
        )}
      </div>

      {floor && (
        <p className="banner warn">
          No rate on file for {summary.unpriced.join(', ')} — every total here is a floor, not a bill.
        </p>
      )}

      {/* A conversation with no completed turn is never written to disk. */}
      {summary.turnCount > 0 && <RecordingCard recordId={summary.recordId} />}

      <div className="report-cols">
        <div className="report-main">
          <section className="panel report-card">
            <div className="report-card-head">
              <h2>
                <PanelIcon name="potion" />
                Cost by leg
              </h2>
              <span className="muted small">Each leg in the unit its vendor bills in</span>
            </div>
            <LegTotals
              legs={summary.totals}
              nameOf={nameOf}
              total={{ usd: summary.costUsd, inr: summary.costInr, floor }}
            />
            <p className="foot report-card-foot">
              <span className="est">~</span> counted here, not reported by the vendor.{' '}
              <span className="rate-flag">?</span> the vendor's sources disagree on this rate — hover it for which. Bold
              is the currency that vendor actually bills in; the dimmed figure went through{' '}
              <strong>₹{fx} per $1</strong>, an assumed rate rather than a live one (set <code>USD_PER_INR</code> to
              change it). Turn and session totals mix vendors, so each is part quoted and part converted.
            </p>
          </section>

          <section className="panel report-card">
            <div className="report-card-head">
              <h2>
                <PanelIcon name="hourglass" />
                Per turn
              </h2>
            </div>
            <UsagePanel usage={summary.turns} compact />
          </section>
        </div>

        <aside className="report-side" aria-label="Projection and setup">
          <section className="panel">
            <h2>
              <PanelIcon name="crystal" />
              At scale
            </h2>
            <span className="field-label" id="report-volume">
              Turns a day
            </span>
            <div className="seg wide report-volume" role="group" aria-labelledby="report-volume">
              {VOLUMES.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={v === volume ? 'on' : ''}
                  aria-pressed={v === volume}
                  onClick={() => setVolume(v)}
                >
                  {v >= 1_000_000 ? '1M' : `${v / 1000}k`}
                </button>
              ))}
            </div>
            <div className="report-projection">
              <span className="hero">
                <span className="hero-v small">{`≈ ${monthly(perTurnUsd, volume)}`}</span>
                <span className="hero-u">/ month</span>
                {floor && <span className="pill floor">floor</span>}
              </span>
              <span className="hero-sub">{`≈ ${inrScaled(perTurnInr * volume * 30)} / month`}</span>
            </div>
            <p className="foot">
              A projection, not a quote: it assumes every future turn looks like these {summary.turnCount}, and that no
              rate moves.
            </p>
          </section>

          <section className="panel">
            <h2>
              <PanelIcon name="lightning" />
              Median per leg
            </h2>
            <LegBars legs={legs} scaleMs={summary.latency.ttfaMedianMs} />
            {legs.length > 0 && (
              <p className="foot">
                Each leg is timed from its own start, so they overlap and do not add up to the turn
                {summary.latency.ttfaMedianMs !== undefined && <> ({ms(summary.latency.ttfaMedianMs)} ms median)</>} — a
                pipeline opens the TTS socket while the LLM is still thinking. t0 is when you stopped speaking: the
                vendor's own speech-end event where it publishes one, the local detector where it does not. Vendor
                connection setup is inside that window on purpose.
              </p>
            )}
          </section>

          <section className="panel">
            <h2>
              <PanelIcon name="scroll" />
              System prompt used
            </h2>
            {summary.config.systemPrompt ? (
              <p className="report-prompt">{summary.config.systemPrompt}</p>
            ) : (
              <p className="muted">No system prompt recorded.</p>
            )}
          </section>

          <details className="panel report-disclosure">
            <summary>
              <PanelIcon name="shield" />
              How much to trust each number
              <Icon name="chevronRight" size={14} className="report-chev" />
            </summary>
            <div className="table-scroll">
              <table className="report-trust">
                <tbody>
                  <tr>
                    <td>First audio, and every leg latency</td>
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
                      <span className="warn-flag">assumed</span> ₹{fx}
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
              <p className="foot">
                {localLegs.map((l) => l.leg.toUpperCase()).join(' and ')} {localLegs.length === 1 ? 'is' : 'are'}{' '}
                counted in this process. The unit is the one the invoice uses; the count is ours.
              </p>
            )}
          </details>

          <details className="panel report-disclosure">
            <summary>
              <PanelIcon name="book" />
              Record on disk
              <Icon name="chevronRight" size={14} className="report-chev" />
            </summary>
            <pre className="jsonbox">{JSON.stringify(summary, null, 2)}</pre>
            <p className="foot">
              The record as filed
              {summary.turnCount > 0 && (
                <>
                  , saved server-side as <code>{summary.recordId}.json</code>
                </>
              )}
              . No credentials — provider and model ids, the system prompt, usage and cost. The prompt is kept
              deliberately, since it is what produced these numbers, so treat <code>data/sessions/</code> as
              conversation content.
            </p>
          </details>
        </aside>
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  unit,
  sub,
  subTitle,
}: {
  label: ReactNode;
  value: string;
  unit?: string;
  sub?: string;
  subTitle?: string;
}) {
  return (
    <div className="report-stat">
      <span className="report-stat-label">{label}</span>
      <span className="report-stat-value">
        {value}
        {unit && <span className="report-stat-unit"> {unit}</span>}
      </span>
      {sub && (
        <span className="report-stat-sub" title={subTitle}>
          {sub}
        </span>
      )}
    </div>
  );
}

/**
 * The conversation's stereo WAV, left the user and right the assistant. Same
 * URL scheme as `Recordings`, keyed by `recordId` — the socket id names nothing
 * on disk.
 *
 * Recording is not retroactive and a typed-only conversation never opens the
 * mic, so plenty of records have no WAV. The player reports its own 404 rather
 * than the page probing for it, and a just-ended conversation can 404 before
 * its file is closed, hence the retry rather than silently hiding the card.
 */
function RecordingCard({ recordId }: { recordId: string }) {
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState(recordId);
  if (seen !== recordId) {
    setSeen(recordId);
    setMissing(false);
  }
  const src = sessionAudioUrl(recordId);

  return (
    <section className="panel report-recording">
      <h2>
        <PanelIcon name="headphones" />
        Recording
        <span className="report-h2-note">
          Stereo WAV, left you, right the assistant. Timed by when audio reached the server, not what you heard.
        </span>
        {!missing && (
          <a className="btn sm right" href={src} download={`${recordId}.wav`}>
            <Icon name="download" size={13} />
            Download WAV
          </a>
        )}
      </h2>
      {missing ? (
        <p className="muted small report-recording-missing">
          No recording for this conversation — it predates recording, the mic was never opened, or recording is off.
          <button
            type="button"
            className="ghost inline"
            onClick={() => {
              setMissing(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : (
        <audio
          key={attempt}
          controls
          // Loads only the header, which is enough to discover the file is
          // missing without pulling megabytes.
          preload="metadata"
          aria-label="Recording of this conversation"
          src={src}
          onError={() => setMissing(true)}
        />
      )}
    </section>
  );
}

/**
 * A monthly rupee figure in the units it is talked about in: lakh and crore
 * rather than a seven-digit number with Western grouping. Local to the
 * projection, since every other rupee cell is a per-turn amount `inr()` handles.
 */
function inrScaled(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} lakh`;
  if (n >= 1000) return `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (n >= 10) return `₹${n.toFixed(0)}`;
  return `₹${n.toFixed(2)}`;
}
