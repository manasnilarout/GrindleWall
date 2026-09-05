import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionIndexEntry, SessionSummary } from '../lib/protocol';
import { legMediansOf } from '../lib/legs';
import { normalizeSummary } from '../lib/session';
import { duration, ms, num, secs, usd, when } from '../lib/format';
import { downloadJson } from '../lib/download';
import { LegBars } from './Waterfall';
import { Recordings } from './Recordings';

/**
 * Comparing runs — the thing this bench is for, and the one thing its UI could
 * not do.
 *
 * Every conversation was already filed after every turn, and the history list
 * showed them as rows of cost. But answering "is Cartesia or Murf faster on
 * this prompt" meant opening two records and reading medians out of two tables.
 * This puts them on one axis.
 */

interface Metric {
  key: string;
  name: string;
  title: string;
  /** Undefined for a run that never measured this leg — a realtime run has no STT. */
  get: (s: SessionSummary) => number | undefined;
  format: (v: number) => string;
  /** Whiskers only make sense where the record kept a p95. */
  spread?: (s: SessionSummary) => number | undefined;
}

const METRICS: Metric[] = [
  {
    key: 'ttfa',
    name: 'TTFA',
    title: 'Time to first audio · server-side',
    get: (s) => s.latency.ttfaMedianMs,
    spread: (s) => s.latency.ttfaP95Ms,
    format: (v) => `${ms(v)} ms`,
  },
  { key: 'stt', name: 'STT', title: 'Speech-to-text latency', get: (s) => s.latency.sttMedianMs, format: (v) => `${ms(v)} ms` },
  { key: 'llm', name: 'LLM TTFT', title: 'LLM time to first token', get: (s) => s.latency.llmTtftMedianMs, format: (v) => `${ms(v)} ms` },
  { key: 'tts', name: 'TTS TTFB', title: 'TTS time to first byte', get: (s) => s.latency.ttsTtfbMedianMs, format: (v) => `${ms(v)} ms` },
  {
    key: 'cost',
    name: '$ / turn',
    title: 'Cost per turn',
    get: (s) => (s.turnCount ? s.costUsd / s.turnCount : undefined),
    format: (v) => usd(v),
  },
  {
    key: 'turn',
    name: 'Whole turn',
    title: 'Whole turn · t0 to the last audio byte',
    get: (s) => s.latency.totalTurnMedianMs,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${ms(v)} ms`),
  },
  { key: 'audio', name: 'Reply length', title: 'Rendered audio per turn', get: (s) => s.latency.audioMedianMs, format: (v) => secs(v) },
];

export function ComparePage({ onOpenReport }: { onOpenReport: (s: SessionSummary) => void }) {
  const [index, setIndex] = useState<SessionIndexEntry[]>([]);
  const [loaded, setLoaded] = useState<Record<string, SessionSummary>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [metricKey, setMetricKey] = useState('ttfa');
  const [error, setError] = useState<string>();
  /** A single record that would not load, kept apart from a failure to list them. */
  const [recordError, setRecordError] = useState<string>();

  /** Rapid refreshes resolve out of order, so only the newest request may write. */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    // Records are NOT immutable: SessionStore rewrites a conversation's file
    // after every turn, so a run that was live at the last fetch has newer
    // medians now. Dropping the cache is what makes `refresh` mean refresh —
    // it used to update the list on the left while the chart, the matrix and
    // the verdicts kept the numbers from the first fetch, with no marker to
    // say which panel was stale.
    setLoaded({});
    fetch('/api/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { sessions: SessionIndexEntry[] }) => {
        if (mine !== generation.current) return;
        setIndex(d.sessions);
        setError(undefined);
        // Preselect the newest few, so the page is useful before any clicking.
        setSelected((prev) => (prev.size ? prev : new Set(d.sessions.slice(0, 4).map((s) => s.recordId))));
      })
      .catch((err: Error) => {
        if (mine === generation.current) setError(err.message);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Ids with a request already out.
   *
   * This effect writes `loaded`, and `loaded` is one of its dependencies — so
   * every record that resolves re-runs it, and without this guard every OTHER
   * record still in flight is requested again. Four preselected records fetched
   * ten times. `loaded[id]` alone cannot prevent it: an in-flight record is not
   * loaded yet, which is exactly when the re-run happens.
   */
  const inFlight = useRef<Set<string>>(new Set());


  // Full records carry the medians; the index rows do not. Fetched once per
  // refresh — see `load`, which clears the cache because records are rewritten
  // after every turn.
  useEffect(() => {
    for (const id of selected) {
      if (loaded[id] || inFlight.current.has(id)) continue;
      inFlight.current.add(id);
      void fetch(`/api/sessions/${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((raw) => setLoaded((prev) => ({ ...prev, [id]: normalizeSummary(raw) })))
        // Its own message: one missing record file used to render as
        // "Cannot list sessions", beside a list that had plainly loaded.
        .catch((err: Error) => setRecordError(`Could not load ${id}: ${err.message}`))
        // Cleared on failure too, so deselecting and reselecting retries rather
        // than leaving the row permanently blank.
        .finally(() => inFlight.current.delete(id));
    }
  }, [selected, loaded]);

  const runs = useMemo(
    () => index.filter((r) => selected.has(r.recordId)).map((r) => loaded[r.recordId]).filter(Boolean),
    [index, selected, loaded],
  );

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const values = runs.map((r) => metric.get(r)).filter((v): v is number => v !== undefined);
  const best = values.length ? Math.min(...values) : undefined;
  const worst = values.length ? Math.max(...values) : undefined;
  const peak = Math.max(...values, ...runs.map((r) => metric.spread?.(r) ?? 0), 1);
  const scale = peak * 1.12;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fastest = pickBest(runs, (s) => s.latency.ttfaMedianMs);
  const cheapest = pickBest(runs, (s) => (s.turnCount ? s.costUsd / s.turnCount : undefined));

  return (
    <div className="compare">
      <div className="columns compare-cols">
        <div className="col">
          <section className="panel">
            <h2>
              Runs on disk
              <button type="button" className="ghost inline" onClick={load}>
                refresh
              </button>
            </h2>

            {error && <p className="muted small">Cannot list sessions: {error}</p>}
            {recordError && <p className="muted small est">{recordError}</p>}
            {!error && index.length === 0 && <p className="muted">Nothing recorded yet. Run a conversation first.</p>}

            <div className="run-list">
              {index.map((row) => (
                <button
                  key={row.recordId}
                  type="button"
                  className={`run ${selected.has(row.recordId) ? 'on' : ''}`}
                  onClick={() => toggle(row.recordId)}
                >
                  <span className="box" />
                  <span className="run-body">
                    <span className="run-name" title={row.label}>
                      {row.label}
                    </span>
                    <span className="run-meta">
                      {when(row.startedAt)} · {row.turnCount} {row.turnCount === 1 ? 'turn' : 'turns'} ·{' '}
                      {duration(row.endedAt - row.startedAt)}
                    </span>
                  </span>
                  <span className="run-num">
                    {usd(row.costUsd)}
                    {row.unpriced.length > 0 && (
                      <span className="warn-flag" title={`Unpriced: ${row.unpriced.join(', ')}`}>
                        {' '}
                        +
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>

            <p className="muted small foot">
              A record is written after every turn, not only at the end, so a conversation that was never formally
              ended is here too.
            </p>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <h2>
              {metric.title}
              <span className="right muted">bar = median{metric.spread ? ' · tick = p95' : ''}</span>
            </h2>

            <div className="seg">
              {METRICS.map((m) => (
                <button key={m.key} type="button" className={m.key === metricKey ? 'on' : ''} onClick={() => setMetricKey(m.key)}>
                  {m.name}
                </button>
              ))}
            </div>

            {runs.length === 0 ? (
              <p className="muted foot">Pick a run or two on the left.</p>
            ) : (
              <>
                <div className="chart">
                  {runs.map((run) => {
                    const v = metric.get(run);
                    const p95 = metric.spread?.(run);
                    return (
                      <div className="c-row" key={run.recordId}>
                        <span className="c-name" title={run.label}>
                          {run.label}
                        </span>
                        <span className="c-plot">
                          {[25, 50, 75].map((g) => (
                            <span className="grid-l" key={g} style={{ left: `${g}%` }} />
                          ))}
                          {v === undefined ? (
                            <span className="c-none">not measured — this run has no {metric.name} leg</span>
                          ) : (
                            <>
                              <span
                                className={`c-bar ${v === best ? 'lead' : v === worst && runs.length > 1 ? 'slow' : ''}`}
                                style={{ width: `${Math.min(100, (v / scale) * 100).toFixed(1)}%` }}
                                title={`${run.label} — ${metric.format(v)}`}
                              />
                              {p95 !== undefined && (
                                <span
                                  className="whisk"
                                  style={{ left: `${Math.min(100, (p95 / scale) * 100).toFixed(1)}%` }}
                                  title={`p95 ${metric.format(p95)}`}
                                />
                              )}
                              <span
                                className="c-val"
                                style={{ left: `calc(${Math.min((v / scale) * 100, 78).toFixed(1)}% + 10px)` }}
                              >
                                {metric.format(v)}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="c-scale">
                  <span>0</span>
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <span key={f}>{metric.format(scale * f)}</span>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <h2>
              Per-leg medians
              <span className="right muted">shared scale · legs overlap, they do not sum</span>
            </h2>
            {runs.length === 0 && <p className="muted">Nothing selected.</p>}
            {(() => {
              // One scale across every selected run, or the bars compare only
              // against themselves and a slow run looks identical to a fast one.
              const scale = Math.max(
                1,
                ...runs.flatMap((r) => legMediansOf(r.latency).map((l) => l.ms)),
                ...runs.map((r) => r.latency.ttfaMedianMs ?? 0),
              );
              return runs.map((run) => {
                const legs = legMediansOf(run.latency);
                return (
                  <div className="s-row" key={run.recordId}>
                    <span className="c-name" title={run.label}>
                      {run.label}
                    </span>
                    <span className="s-bar-wrap">
                      {legs.length > 0 ? (
                        <LegBars legs={legs} scaleMs={scale} showKeys={false} />
                      ) : (
                        <span className="s-opaque" title="no per-leg medians on this record" />
                      )}
                    </span>
                    <span className="s-total">{ms(run.latency.ttfaMedianMs)} ms</span>
                  </div>
                );
              });
            })()}
            <p className="muted small foot">
              A hatched bar means the record has no per-leg medians: either a speech-to-speech run, which has no
              STT/LLM/TTS split to take apart, or a record written before those medians were kept — re-run it to fill
              it in. Bars are drawn on one scale across every selected run.
            </p>
          </section>

          <section className="panel">
            <h2>
              Matrix
              <span className="right muted">green marks the best in its column</span>
            </h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Turns</th>
                    <th>TTFA</th>
                    <th>p95</th>
                    <th>STT</th>
                    <th>LLM</th>
                    <th>TTS</th>
                    <th>$ / turn</th>
                    <th>$ / 1k</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const perTurn = run.turnCount ? run.costUsd / run.turnCount : undefined;
                    return (
                      <tr key={run.recordId}>
                        <td className="pipeline-cell" title={run.label}>
                          {run.label}
                        </td>
                        <td className="muted">{run.turnCount}</td>
                        <td className={run.latency.ttfaMedianMs === fastest ? 'win' : 'strong'}>
                          {ms(run.latency.ttfaMedianMs)}
                        </td>
                        <td className="muted">{ms(run.latency.ttfaP95Ms)}</td>
                        <td>{ms(run.latency.sttMedianMs)}</td>
                        <td>{ms(run.latency.llmTtftMedianMs)}</td>
                        <td>{ms(run.latency.ttsTtfbMedianMs)}</td>
                        <td className={perTurn !== undefined && perTurn === cheapest ? 'win' : ''}>
                          {usd(perTurn)}
                          {run.unpriced.length > 0 && (
                            <span className="warn-flag" title={`A floor, not a total — no rate on file for ${run.unpriced.join(', ')}`}>
                              {' '}+
                            </span>
                          )}
                        </td>
                        <td className="muted">{perTurn === undefined ? '—' : usd(perTurn * 1000)}</td>
                        <td>
                          <button type="button" className="ghost inline" onClick={() => onOpenReport(run)}>
                            open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="col">
          <Verdicts runs={runs} fastest={fastest} cheapest={cheapest} />

          <Recordings runs={runs} />

          {runs.length > 0 && (
            <section className="panel">
              <h2>Export</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => downloadJson(runs, `compare-${runs.length}-runs-${Date.now()}.json`)}
              >
                Export {runs.length} selected {runs.length === 1 ? 'record' : 'records'} as JSON
              </button>
              <p className="muted small foot">
                The full records, medians and per-turn rows included — the same files the backend wrote.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The comparison spelled out.
 *
 * Deliberately arithmetic on the selected runs and nothing more: it says which
 * is fastest, which is cheapest, and what the gap between them costs. It does
 * not have an opinion about which to pick, because the third axis — whether the
 * voice sounds human — is not in any of these numbers.
 */
function Verdicts({
  runs,
  fastest,
  cheapest,
}: {
  runs: SessionSummary[];
  fastest?: number;
  cheapest?: number;
}) {
  if (runs.length < 2) {
    return (
      <section className="panel">
        <h2>What the numbers say</h2>
        <p className="muted">Select at least two runs to compare them.</p>
      </section>
    );
  }

  const fastRun = runs.find((r) => r.latency.ttfaMedianMs === fastest);
  const cheapRun = runs.find((r) => r.turnCount && r.costUsd / r.turnCount === cheapest);
  const slowest = Math.max(...runs.map((r) => r.latency.ttfaMedianMs ?? 0));
  const dearest = Math.max(...runs.map((r) => (r.turnCount ? r.costUsd / r.turnCount : 0)));

  const sameRun = fastRun && cheapRun && fastRun.recordId === cheapRun.recordId;
  const anyUnpriced = runs.some((r) => r.unpriced.length > 0);
  const costRatio = cheapest && cheapest > 0 ? dearest / cheapest : undefined;

  return (
    <section className="panel">
      <h2>What the numbers say</h2>

      {fastRun && (
        <div className="verdict-box win">
          <div className="verdict-head">Fastest</div>
          <strong>{fastRun.label}</strong> at {ms(fastest)} ms median — {ms(slowest - (fastest ?? 0))} ms ahead of the
          slowest selected.
        </div>
      )}

      {cheapRun && (
        <div className="verdict-box">
          <div className="verdict-head accent">Cheapest</div>
          <strong>{cheapRun.label}</strong> at {usd(cheapest)} a turn
          {costRatio && costRatio > 1.5 && <> — {num(costRatio, 1)}× cheaper than the dearest selected</>}.
          {sameRun && <> It is also the fastest, so there is no trade to make here.</>}
          {/* A run with an unpriced leg is cheap partly because part of it was never counted. */}
          {anyUnpriced && (
            <>
              {' '}
              <span className="est">
                Some selected runs have legs with no rate on file, so their totals are floors — this ranking is not a
                like-for-like comparison.
              </span>
            </>
          )}
        </div>
      )}

      <div className="verdict-box">
        <div className="verdict-head accent">Not measured</div>
        Audio quality and how human it sounds. Run the same prompt through both and listen — the bench will not tell
        you this one, on purpose.
      </div>
    </section>
  );
}

function pickBest(runs: SessionSummary[], get: (s: SessionSummary) => number | undefined): number | undefined {
  const values = runs.map(get).filter((v): v is number => v !== undefined);
  return values.length ? Math.min(...values) : undefined;
}
