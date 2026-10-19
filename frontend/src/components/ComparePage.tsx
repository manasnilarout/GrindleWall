import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionIndexEntry, SessionMode, SessionSummary } from '../lib/protocol';
import type { ProviderEntry } from '../lib/catalog';
import { legMediansOf } from '../lib/legs';
import { RIG_COLORS } from '../lib/rigs';
import { normalizeSummary } from '../lib/session';
import { ms, num, secs, usd, when } from '../lib/format';
import { downloadJson } from '../lib/download';
import { LegBars } from './Waterfall';
import { Recordings, SeriesBadge, type SeriesTag } from './Recordings';
import { Icon, PanelIcon } from './Icon';
import { PageHeader } from './PageHeader';
import { authFetch } from '../lib/auth';

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
  /** Undefined for a run that never measured this — a run with no completed turn. */
  get: (s: SessionSummary) => number | undefined;
  format: (v: number) => string;
  /** Whiskers only make sense where the record kept a p95. */
  spread?: (s: SessionSummary) => number | undefined;
  /** A second figure under the bar, where one number does not say enough. */
  detail?: (s: SessionSummary) => string | undefined;
  foot: string;
}

const perTurn = (s: SessionSummary) => (s.turnCount ? s.costUsd / s.turnCount : undefined);

const METRICS: Metric[] = [
  {
    key: 'ttfa',
    name: 'First audio',
    title: 'Time to first audio · server-side, from the moment the user stopped speaking',
    get: (s) => s.latency.ttfaMedianMs,
    spread: (s) => s.latency.ttfaP95Ms,
    format: (v) => `${ms(v)} ms`,
    foot: 'Bar is the median, tick is p95.',
  },
  {
    key: 'cost',
    name: 'Cost',
    title: 'Cost per turn',
    get: perTurn,
    format: (v) => usd(v),
    detail: (s) => {
      const v = perTurn(s);
      return v === undefined ? undefined : `${usd(v * 1000)} per 1,000 turns`;
    },
    foot: 'Bar is the cost of an average turn. A run with an unpriced leg is a floor, not a bill.',
  },
  {
    key: 'turn',
    name: 'Whole turn',
    title: 'Whole turn · t0 to the last audio byte',
    get: (s) => s.latency.totalTurnMedianMs,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${ms(v)} ms`),
    foot: 'Bar is the median.',
  },
  {
    key: 'audio',
    name: 'Reply length',
    title: 'Rendered audio per turn',
    get: (s) => s.latency.audioMedianMs,
    format: (v) => secs(v),
    foot: 'Bar is the median. A longer reply is a slower whole turn without being a slower vendor.',
  },
];

/** The per-leg view is drawn differently enough that it is not a `Metric`. */
const LEGS_KEY = 'legs';
const TABS = [
  { key: 'ttfa', name: 'First audio' },
  { key: LEGS_KEY, name: 'Per leg' },
  { key: 'cost', name: 'Cost' },
  { key: 'turn', name: 'Whole turn' },
  { key: 'audio', name: 'Reply length' },
];

/* ------------------------------ labels -------------------------------- */

/**
 * A record's label is `providerId:modelId` per leg, joined by " → ". Split at
 * the FIRST colon only: model ids carry their own (`saaras:v3-realtime@fast`).
 */
function legsOfLabel(label: string): { providerId: string; modelId: string }[] {
  return label
    .split(' → ')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const at = seg.indexOf(':');
      return at < 0 ? { providerId: seg, modelId: '' } : { providerId: seg.slice(0, at), modelId: seg.slice(at + 1) };
    });
}

/** Provider display names joined into a chain, falling back to the id while the catalog is absent. */
export function chainName(label: string, providers: ProviderEntry[]): string {
  const legs = legsOfLabel(label);
  if (legs.length === 0) return label;
  return legs.map((l) => providers.find((p) => p.id === l.providerId)?.name ?? l.providerId).join(' → ');
}

/** Every leg a mock. A run with even one real vendor in it is a measurement. */
export function isMockRun(label: string): boolean {
  const legs = legsOfLabel(label);
  return legs.length > 0 && legs.every((l) => l.providerId.startsWith('mock-'));
}

export interface RunFilter {
  query: string;
  mode: 'all' | SessionMode;
  hideMock: boolean;
}

/** Client-side, over the index already fetched: provider ids and names, model ids, language. */
export function filterRuns(rows: SessionIndexEntry[], filter: RunFilter, providers: ProviderEntry[]): SessionIndexEntry[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filter.mode !== 'all' && row.mode !== filter.mode) return false;
    if (filter.hideMock && isMockRun(row.label)) return false;
    if (terms.length === 0) return true;
    const c = row.config;
    const haystack = [row.label, chainName(row.label, providers), c?.language, c?.sttLanguage, c?.ttsLanguage]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** Lowest series number not in use, so deselecting one run never recolours the others. */
function freeSlot(slots: Record<string, number>): number {
  const used = new Set(Object.values(slots));
  let n = 0;
  while (used.has(n)) n++;
  return n;
}

const tagOf = (slot: number, name: string): SeriesTag => ({
  n: slot + 1,
  color: RIG_COLORS[slot % RIG_COLORS.length],
  name,
});

const turnsWord = (n: number) => `${n} ${n === 1 ? 'turn' : 'turns'}`;

/* ------------------------------- page --------------------------------- */

/**
 * What the page hands back when it unmounts. Opening a run and coming back by
 * the crumb is the main path through Runs; without this, the selection, the
 * filter and the metric reset every time.
 */
export interface RunsMemory {
  slots?: Record<string, number>;
  metricKey?: string;
  filter?: RunFilter;
}

export function ComparePage({
  onOpenReport,
  providers = [],
  memory,
}: {
  onOpenReport: (s: SessionSummary) => void;
  /** For display names. Empty until the catalog loads; ids are shown meanwhile. */
  providers?: ProviderEntry[];
  /** Owned by the parent, which outlives this page. Read on mount, written as it changes. */
  memory?: RunsMemory;
}) {
  const [index, setIndex] = useState<SessionIndexEntry[]>([]);
  /** False until the first listing lands, so "nothing recorded" is never said before anyone looked. */
  const [listed, setListed] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, SessionSummary>>({});
  /** Selected record id → series slot (0-based). The slot fixes its badge number and colour. */
  const [slots, setSlots] = useState<Record<string, number>>(() => memory?.slots ?? {});
  const [metricKey, setMetricKey] = useState(() => memory?.metricKey ?? 'ttfa');
  const [filter, setFilter] = useState<RunFilter>(() => memory?.filter ?? { query: '', mode: 'all', hideMock: true });
  useEffect(() => {
    if (memory) Object.assign(memory, { slots, metricKey, filter });
  }, [memory, slots, metricKey, filter]);

  /** A record still loading when the user leaves must not navigate them back. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [opening, setOpening] = useState<string>();
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
    authFetch('/api/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { sessions: SessionIndexEntry[] }) => {
        if (mine !== generation.current) return;
        setIndex(d.sessions);
        setListed(true);
        setError(undefined);
        // Preselect the newest few, so the page is useful before any clicking.
        // Real runs only: the mock filter is on by default, and a preselected
        // run the table is hiding would be a comparison of rows nobody can see.
        setSlots((prev) =>
          Object.keys(prev).length
            ? prev
            : Object.fromEntries(
                d.sessions
                  .filter((s) => !isMockRun(s.label))
                  .slice(0, 4)
                  .map((s, i) => [s.recordId, i]),
              ),
        );
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

  const fetchRecord = useCallback(
    (id: string) =>
      authFetch(`/api/sessions/${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((raw) => normalizeSummary(raw)),
    [],
  );

  // Full records carry the medians the comparison draws. Fetched once per
  // refresh — see `load`, which clears the cache because records are rewritten
  // after every turn.
  useEffect(() => {
    for (const id of Object.keys(slots)) {
      if (loaded[id] || inFlight.current.has(id)) continue;
      inFlight.current.add(id);
      void fetchRecord(id)
        .then((s) => setLoaded((prev) => ({ ...prev, [id]: s })))
        // Its own message: one missing record file used to render as
        // "Cannot list sessions", beside a list that had plainly loaded.
        .catch((err: Error) => setRecordError(`Could not load ${id}: ${err.message}`))
        // Cleared on failure too, so deselecting and reselecting retries rather
        // than leaving the row permanently blank.
        .finally(() => inFlight.current.delete(id));
    }
  }, [slots, loaded, fetchRecord]);

  /** Opening a run needs its full record, which an unselected row has not fetched. */
  const open = (id: string) => {
    const have = loaded[id];
    if (have) return onOpenReport(have);
    setOpening(id);
    fetchRecord(id)
      .then((s) => {
        if (!mounted.current) return;
        setLoaded((prev) => ({ ...prev, [id]: s }));
        onOpenReport(s);
      })
      .catch((err: Error) => {
        if (mounted.current) setRecordError(`Could not open ${id}: ${err.message}`);
      })
      .finally(() => {
        if (mounted.current) setOpening(undefined);
      });
  };

  const toggle = (id: string) =>
    setSlots((prev) => {
      if (id in prev) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: freeSlot(prev) };
    });

  const listedIds = useMemo(() => new Set(index.map((r) => r.recordId)), [index]);

  /** Selected and loaded, in series order — the order of every chart and list on the right. */
  const series = useMemo(
    () =>
      Object.entries(slots)
        .filter(([id]) => listedIds.has(id) && loaded[id])
        .sort((a, b) => a[1] - b[1])
        .map(([id, slot]) => ({ run: loaded[id], tag: tagOf(slot, chainName(loaded[id].label, providers)) })),
    [slots, listedIds, loaded, providers],
  );
  const runs = useMemo(() => series.map((s) => s.run), [series]);
  const seriesTags = useMemo(() => Object.fromEntries(series.map((s) => [s.run.recordId, s.tag])), [series]);
  const selectedCount = Object.keys(slots).filter((id) => listedIds.has(id)).length;

  const rows = useMemo(() => filterRuns(index, filter, providers), [index, filter, providers]);
  const shown = new Set(rows.map((r) => r.recordId));
  const hiddenSelected = Object.keys(slots).filter((id) => listedIds.has(id) && !shown.has(id)).length;

  return (
    <div className="runs-page">
      <PageHeader
        title="Runs"
        sub={
          listed
            ? `${index.length} ${index.length === 1 ? 'conversation' : 'conversations'} on disk. Each is written after every turn, so unfinished runs are here too.`
            : 'Each conversation is written after every turn, so unfinished runs are here too.'
        }
        actions={
          <>
            <button type="button" className="ghost" onClick={load}>
              <Icon name="refresh" size={16} />
              Refresh
            </button>
            {runs.length > 0 && (
              <button
                type="button"
                className="btn"
                title="The full records, medians and per-turn rows included: the same files the backend wrote."
                onClick={() => downloadJson(runs, `compare-${runs.length}-runs-${Date.now()}.json`)}
              >
                <Icon name="download" size={16} />
                Export {runs.length} as JSON
              </button>
            )}
          </>
        }
      />

      {error && (
        <div className="banner error" role="alert">
          Cannot list sessions: {error}
        </div>
      )}
      {recordError && <div className="banner warn">{recordError}</div>}

      <div className="runs-filters">
        <label className="runs-search">
          <Icon name="search" size={16} />
          <span className="sr-only">Filter runs</span>
          <input
            type="search"
            placeholder="Filter by provider, model or language"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          />
        </label>
        <div className="seg" role="group" aria-label="Architecture">
          {(['all', 'pipeline', 'realtime'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={filter.mode === m ? 'on' : ''}
              aria-pressed={filter.mode === m}
              onClick={() => setFilter((f) => ({ ...f, mode: m }))}
            >
              {m === 'all' ? 'All' : m === 'pipeline' ? 'Pipeline' : 'Realtime'}
            </button>
          ))}
        </div>
        <label className="runs-check">
          <input
            type="checkbox"
            checked={filter.hideMock}
            onChange={(e) => setFilter((f) => ({ ...f, hideMock: e.target.checked }))}
          />
          Hide mock runs
        </label>
      </div>

      <div className="runs-layout">
        <div className="runs-main">
          <section className="panel runs-list" aria-label="All runs">
            {!listed && !error && <p className="muted runs-empty">Loading runs…</p>}
            {listed && index.length === 0 && <p className="muted runs-empty">Nothing recorded yet. Run a conversation first.</p>}
            {listed && index.length > 0 && rows.length === 0 && (
              <div className="runs-empty">
                <p className="muted">
                  No run matches these filters — {index.length} {index.length === 1 ? 'is' : 'are'} on disk.
                </p>
                <button type="button" className="btn sm" onClick={() => setFilter({ query: '', mode: 'all', hideMock: false })}>
                  Clear filters
                </button>
              </div>
            )}
            {rows.length > 0 && (
              <RunsTable rows={rows} slots={slots} providers={providers} opening={opening} onToggle={toggle} onOpen={open} />
            )}
            {hiddenSelected > 0 && (
              <p className="foot runs-foot">
                {hiddenSelected} selected {hiddenSelected === 1 ? 'run is' : 'runs are'} hidden by the filters and still
                in the comparison.
              </p>
            )}
          </section>

          {series.length >= 2 && <Matrix series={series} onOpen={onOpenReport} />}
        </div>

        <aside className="runs-compare" aria-label="Comparison">
          <CompareCard
            series={series}
            selectedCount={selectedCount}
            metricKey={metricKey}
            onMetric={setMetricKey}
            onClear={() => setSlots({})}
          />
          {runs.length > 0 && <Verdicts series={series} />}
          <Recordings runs={runs} series={seriesTags} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------- table -------------------------------- */

/**
 * Open and select are two controls on purpose: the name is a link to the
 * report, the box beside it adds the run to the comparison. One click that did
 * both would make it impossible to read a report without changing the chart.
 */
export function RunsTable({
  rows,
  slots,
  providers,
  opening,
  onToggle,
  onOpen,
}: {
  rows: SessionIndexEntry[];
  slots: Record<string, number>;
  providers: ProviderEntry[];
  opening?: string;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="runs-table">
        <thead>
          <tr>
            <th scope="col" className="sel-cell">
              <span className="sr-only">Compare</span>
            </th>
            <th scope="col" className="left">Run</th>
            <th scope="col" className="left">Started</th>
            <th scope="col">Turns</th>
            <th scope="col">TTFA median</th>
            <th scope="col">p95</th>
            <th scope="col">$ / turn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const slot = slots[row.recordId];
            const on = slot !== undefined;
            const name = chainName(row.label, providers);
            const cost = row.turnCount ? row.costUsd / row.turnCount : undefined;
            return (
              <tr key={row.recordId} className={on ? 'on' : ''}>
                <td className="sel-cell">
                  <label className="run-select">
                    <input
                      type="checkbox"
                      className={on ? 'sr-only' : ''}
                      checked={on}
                      onChange={() => onToggle(row.recordId)}
                      aria-label={on ? `Compare ${name} (series ${slot + 1})` : `Compare ${name}`}
                    />
                    {on && <SeriesBadge tag={tagOf(slot, name)} />}
                  </label>
                </td>
                <td className="left run-cell">
                  <button
                    type="button"
                    className="run-open"
                    onClick={() => onOpen(row.recordId)}
                    disabled={opening === row.recordId}
                    aria-busy={opening === row.recordId || undefined}
                  >
                    {name}
                  </button>
                  {row.mode === 'realtime' && <span className="tag">Realtime</span>}
                  <div className="run-chain mono">{row.label}</div>
                </td>
                <td className="left muted">{when(row.startedAt)}</td>
                <td>{row.turnCount}</td>
                <td className="strong">{ms(row.latency?.ttfaMedianMs)}</td>
                <td className="muted">{ms(row.latency?.ttfaP95Ms)}</td>
                <td>
                  {usd(cost)}
                  {row.unpriced.length > 0 && (
                    <span className="pill floor" title={`A floor, not a total: no rate on file for ${row.unpriced.join(', ')}`}>
                      floor
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ compare ------------------------------- */

export interface Series {
  run: SessionSummary;
  tag: SeriesTag;
}

/** A round number at or above `v`, so the axis reads 0 / 0.5 s / 1.0 s rather than 0 / 467 ms. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

function SampleWarn({ turns }: { turns: number }) {
  if (turns <= 0 || turns >= 3) return null;
  return (
    <span className="sample-warn">
      <Icon name="alert" size={14} />
      {`Based on ${turnsWord(turns)} — read it as a rough figure.`}
    </span>
  );
}

export function CompareCard({
  series,
  selectedCount,
  metricKey,
  onMetric,
  onClear,
}: {
  series: Series[];
  /** Selected, loaded or not: a record still in flight is counted, not drawn. */
  selectedCount: number;
  metricKey: string;
  onMetric: (key: string) => void;
  onClear: () => void;
}) {
  const pending = selectedCount - series.length;
  return (
    <section className="panel" aria-labelledby="cmp-h">
      <h2 id="cmp-h">
        <PanelIcon name="snitch" />
        {selectedCount === 0 ? 'Compare' : `Comparing ${selectedCount} ${selectedCount === 1 ? 'run' : 'runs'}`}
        {selectedCount > 0 && (
          <button type="button" className="ghost inline" onClick={onClear}>
            Clear
          </button>
        )}
      </h2>

      {selectedCount === 0 ? (
        <p className="muted cmp-empty">Tick a run or two to compare them.</p>
      ) : (
        <>
          <div className="tabs wide cmp-tabs" role="group" aria-label="Metric">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={t.key === metricKey ? 'on' : ''}
                aria-pressed={t.key === metricKey}
                onClick={() => onMetric(t.key)}
              >
                {t.name}
              </button>
            ))}
          </div>
          {pending > 0 && <p className="muted small cmp-pending">Loading {pending} more…</p>}
          {metricKey === LEGS_KEY ? <LegsView series={series} /> : <MetricView series={series} metricKey={metricKey} />}
        </>
      )}
    </section>
  );
}

function MetricView({ series, metricKey }: { series: Series[]; metricKey: string }) {
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const peak = Math.max(
    ...series.map(({ run }) => metric.get(run) ?? 0),
    ...series.map(({ run }) => metric.spread?.(run) ?? 0),
    0,
  );
  const scale = niceCeil(peak);
  const pctOf = (v: number) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;

  return (
    <div className="cmp-view">
      <p className="muted small cmp-title">{metric.title}</p>
      <div className="cmp-rows">
        {series.map(({ run, tag }) => {
          const v = metric.get(run);
          const p95 = metric.spread?.(run);
          const sub = metric.detail?.(run);
          return (
            <div className="cmp-row" key={run.recordId}>
              <div className="cmp-head">
                <SeriesBadge tag={tag} small />
                <span className="cmp-name" title={run.label}>
                  {tag.name}
                </span>
                <span className="cmp-val">
                  {v === undefined ? '—' : metric.format(v)}
                  {metric.key === 'cost' && run.unpriced.length > 0 && (
                    <span className="pill floor" title={`A floor, not a total: no rate on file for ${run.unpriced.join(', ')}`}>
                      floor
                    </span>
                  )}
                </span>
              </div>
              {v === undefined ? (
                <span className="cmp-none">Not measured: this run has no completed turn with a {metric.name.toLowerCase()} figure.</span>
              ) : (
                <span className="cmp-track">
                  <span className="cmp-fill" style={{ width: pctOf(v), background: tag.color }} />
                  {p95 !== undefined && (
                    <span className="cmp-tick" style={{ left: pctOf(p95) }} title={`p95 ${metric.format(p95)}`} />
                  )}
                </span>
              )}
              {sub && <span className="muted small">{sub}</span>}
              <SampleWarn turns={run.turnCount} />
            </div>
          );
        })}
      </div>
      <div className="cmp-axis" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f}>{f === 0 ? '0' : metric.format(scale * f)}</span>
        ))}
      </div>
      <p className="foot">{metric.foot}</p>
    </div>
  );
}

function LegsView({ series }: { series: Series[] }) {
  // One scale across every selected run, or the bars compare only against
  // themselves and a slow run looks identical to a fast one.
  const scale = Math.max(
    1,
    ...series.flatMap(({ run }) => legMediansOf(run.latency).map((l) => l.ms)),
    ...series.map(({ run }) => run.latency.ttfaMedianMs ?? 0),
  );

  return (
    <div className="cmp-view">
      <p className="muted small cmp-title">Per-leg medians · one scale across every selected run</p>
      <div className="cmp-rows">
        {series.map(({ run, tag }) => {
          const legs = legMediansOf(run.latency);
          const ttfa = run.latency.ttfaMedianMs;
          return (
            <div className="cmp-row" key={run.recordId}>
              <div className="cmp-head">
                <SeriesBadge tag={tag} small />
                <span className="cmp-name" title={run.label}>
                  {tag.name}
                </span>
                <span className="cmp-val muted">TTFA {ms(ttfa)} ms</span>
              </div>
              {run.mode === 'realtime' ? (
                // A speech-to-speech model has no STT/LLM/TTS split to take
                // apart. One band, its whole first-audio time, is the finding.
                // It can still carry an STT median — the transcript of your
                // speech the vendor sends alongside — but the reply is not
                // made from it, so drawn alone it would read as the run's
                // whole latency. It goes under the band, named for what it is.
                <>
                  <span className="cmp-opaque-track" title={`One model — ${ms(ttfa)} ms to first audio`}>
                    {ttfa !== undefined && <span className="cmp-opaque" style={{ width: `${Math.max(0.6, (ttfa / scale) * 100).toFixed(1)}%` }} />}
                  </span>
                  <span className="cmp-none">
                    {run.latency.sttMedianMs !== undefined
                      ? `One model — no legs to split. Its transcript of your speech arrived at ${ms(run.latency.sttMedianMs)} ms (median).`
                      : 'One model — no legs to split.'}
                  </span>
                </>
              ) : legs.length > 0 ? (
                <LegBars legs={legs} scaleMs={scale} />
              ) : (
                <span className="cmp-none">
                  No per-leg medians on this record: it was written before they were kept. Re-run it to fill them in.
                </span>
              )}
              <SampleWarn turns={run.turnCount} />
            </div>
          );
        })}
      </div>
      <p className="foot">Legs overlap, so they do not add up to TTFA. Each is its own median.</p>
    </div>
  );
}

/* ------------------------------- matrix ------------------------------- */

/** A cell that is the lowest of its column among the selected runs. Colour plus a mark, never colour alone. */
function Best({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <span className="best" title="Best of the selected runs">
      {children}
      <Icon name="check" size={12} />
      <span className="sr-only"> (best)</span>
    </span>
  );
}

/**
 * Every number for the selected runs side by side. The chart shows one metric
 * at a time; this is the only place a run's STT, LLM and TTS medians sit next
 * to its TTFA and its cost, so a trade between them can be read in one row.
 */
export function Matrix({ series, onOpen }: { series: Series[]; onOpen: (s: SessionSummary) => void }) {
  if (series.length < 2) return null;
  const runs = series.map((s) => s.run);
  const cols: { key: string; get: (s: SessionSummary) => number | undefined }[] = [
    { key: 'ttfa', get: (s) => s.latency.ttfaMedianMs },
    { key: 'p95', get: (s) => s.latency.ttfaP95Ms },
    // A realtime run's STT median is when its transcript arrived, not a leg
    // its reply waited on — ranking it against a pipeline's STT would crown
    // a by-product.
    { key: 'stt', get: (s) => (s.mode === 'realtime' ? undefined : s.latency.sttMedianMs) },
    { key: 'llm', get: (s) => s.latency.llmTtftMedianMs },
    { key: 'tts', get: (s) => s.latency.ttsTtfbMedianMs },
    { key: 'cost', get: perTurn },
  ];
  const best = Object.fromEntries(cols.map((c) => [c.key, pickBest(runs, c.get)]));
  const isBest = (key: string, v: number | undefined) => v !== undefined && v === best[key];

  return (
    <section className="panel runs-matrix" aria-labelledby="matrix-h">
      <h2 id="matrix-h">
        <PanelIcon name="compare" />
        All numbers
        <span className="right muted">medians · green and a tick mark the best in each column</span>
      </h2>
      <div className="table-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Turns</th>
              <th scope="col">TTFA</th>
              <th scope="col">p95</th>
              <th scope="col">STT</th>
              <th scope="col">LLM</th>
              <th scope="col">TTS</th>
              <th scope="col">$ / turn</th>
              <th scope="col">$ / 1k</th>
            </tr>
          </thead>
          <tbody>
            {series.map(({ run, tag }) => {
              const cost = perTurn(run);
              const l = run.latency;
              const cell = (key: string, v: number | undefined, base = '') => (
                <td className={isBest(key, v) ? 'win' : base}>
                  <Best on={isBest(key, v)}>{ms(v)}</Best>
                </td>
              );
              return (
                <tr key={run.recordId}>
                  <td>
                    <span className="matrix-run">
                      <SeriesBadge tag={tag} small />
                      <button type="button" className="run-open" title={run.label} onClick={() => onOpen(run)}>
                        {tag.name}
                      </button>
                    </span>
                  </td>
                  <td className="muted">{run.turnCount}</td>
                  {cell('ttfa', l.ttfaMedianMs, 'strong')}
                  {cell('p95', l.ttfaP95Ms, 'muted')}
                  {run.mode === 'realtime' ? (
                    <td className="muted" title="When the transcript of your speech arrived. Not ranked: the reply is not made from it.">
                      {ms(l.sttMedianMs)}
                    </td>
                  ) : (
                    cell('stt', l.sttMedianMs)
                  )}
                  {cell('llm', l.llmTtftMedianMs)}
                  {cell('tts', l.ttsTtfbMedianMs)}
                  <td className={isBest('cost', cost) ? 'win' : ''}>
                    <Best on={isBest('cost', cost)}>{usd(cost)}</Best>
                    {run.unpriced.length > 0 && (
                      <span className="pill floor" title={`A floor, not a total: no rate on file for ${run.unpriced.join(', ')}`}>
                        floor
                      </span>
                    )}
                  </td>
                  <td className="muted">{cost === undefined ? '—' : usd(cost * 1000)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="foot">
        A dash is a leg the run never measured: a realtime run has no LLM or TTS split, and its STT figure is only when
        its transcript arrived, so it is shown dimmed and never ranked. Legs overlap, so they do
        not add up to TTFA. A floor-flagged cost has a leg with no rate on file, so its &ldquo;cheapest&rdquo; may only
        be uncounted.
      </p>
    </section>
  );
}

/* ------------------------------ verdicts ------------------------------ */

function pickBest(runs: SessionSummary[], get: (s: SessionSummary) => number | undefined): number | undefined {
  const values = runs.map(get).filter((v): v is number => v !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

/**
 * The comparison spelled out.
 *
 * Deliberately arithmetic on the selected runs and nothing more: it says which
 * is fastest, which is cheapest, and what the gap between them costs. It does
 * not have an opinion about which to pick, because the third axis — whether the
 * voice sounds human — is not in any of these numbers.
 */
export function Verdicts({ series }: { series: Series[] }) {
  const runs = series.map((s) => s.run);
  const nameOf = (r: SessionSummary) => series.find((s) => s.run === r)?.tag.name ?? r.label;

  if (runs.length < 2) {
    return (
      <section className="panel">
        <h2>
          <PanelIcon name="crystal" />
          What the crystal ball says
        </h2>
        <p className="muted">Select at least two runs to compare them.</p>
      </section>
    );
  }

  const fastest = pickBest(runs, (s) => s.latency.ttfaMedianMs);
  const cheapest = pickBest(runs, perTurn);
  const fastRun = runs.find((r) => r.latency.ttfaMedianMs === fastest);
  const cheapRun = runs.find((r) => r.turnCount && r.costUsd / r.turnCount === cheapest);
  const slowest = Math.max(...runs.map((r) => r.latency.ttfaMedianMs ?? 0));
  const dearest = Math.max(...runs.map((r) => perTurn(r) ?? 0));

  const sameRun = fastRun && cheapRun && fastRun.recordId === cheapRun.recordId;
  const anyUnpriced = runs.some((r) => r.unpriced.length > 0);
  const costRatio = cheapest && cheapest > 0 ? dearest / cheapest : undefined;

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="crystal" />
        What the crystal ball says
      </h2>
      <div className="verdicts">
        {fastRun && (
          <div className="verdict-box">
            <span className="verdict-head fast">Fastest</span>
            <span>
              <strong>{nameOf(fastRun)}</strong> at {ms(fastest)} ms median, {ms(slowest - (fastest ?? 0))} ms ahead of
              the slowest selected.
            </span>
            <SampleWarn turns={fastRun.turnCount} />
          </div>
        )}

        {cheapRun && (
          <div className="verdict-box">
            <span className="verdict-head cheap">Cheapest</span>
            <span>
              <strong>{nameOf(cheapRun)}</strong> at {usd(cheapest)} a turn
              {costRatio && costRatio > 1.5 && <>, {num(costRatio, 1)}× cheaper than the dearest selected</>}.
              {sameRun && <> It is also the fastest, so there is no trade-off here.</>}
            </span>
            {/* A run with an unpriced leg is cheap partly because part of it was never counted. */}
            {anyUnpriced && (
              <span className="est small">
                Some selected runs have legs with no rate on file, so their totals are floors. This ranking is not a
                like-for-like comparison.
              </span>
            )}
            {!sameRun && <SampleWarn turns={cheapRun.turnCount} />}
          </div>
        )}

        <div className="verdict-box quiet">
          <span className="verdict-head">Not measured</span>
          <span>
            How it sounds. Listen to the recordings before you choose: the bench does not score this, on purpose.
          </span>
        </div>
      </div>
    </section>
  );
}
