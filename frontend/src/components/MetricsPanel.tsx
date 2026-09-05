import type { TurnRecord } from '../hooks/useVoiceSession';
import { downloadJson } from '../lib/download';

const ms = (v?: number) => (v === undefined ? '—' : `${Math.round(v)}`);

/**
 * Same definitions the backend uses for the session summary — true median, and
 * nearest-rank p95 — so the live panel and the end-of-conversation report never
 * disagree about the same turns.
 */
function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    n: values.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length))) - 1],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function MetricsPanel({ turns }: { turns: TurnRecord[] }) {
  const ttfa = stats(turns.map((t) => t.clientTtfaMs ?? t.derived.timeToFirstAudioMs).filter((v): v is number => v !== undefined));

  return (
    <section className="panel">
      <h2>Latency</h2>

      {ttfa ? (
        <div className="summary">
          <Stat label="Time to first audio (median)" value={`${ms(ttfa.median)} ms`} big />
          <Stat label="p95" value={`${ms(ttfa.p95)} ms`} />
          <Stat label="min / max" value={`${ms(ttfa.min)} / ${ms(ttfa.max)} ms`} />
          <Stat label="turns" value={String(ttfa.n)} />
        </div>
      ) : (
        <p className="muted">Complete a turn to collect numbers.</p>
      )}

      {turns.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>TTFA (client)</th>
                <th>TTFA (server)</th>
                <th>STT</th>
                <th>LLM TTFT</th>
                <th>TTS TTFB</th>
                <th>Turn</th>
                <th>Audio</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={t.turnId}>
                  <td>{t.turnId}</td>
                  <td className="strong">{ms(t.clientTtfaMs)}</td>
                  <td>{ms(t.derived.timeToFirstAudioMs)}</td>
                  <td>{ms(t.derived.sttLatencyMs)}</td>
                  <td>{ms(t.derived.llmTtftMs)}</td>
                  <td>{ms(t.derived.ttsTtfbMs)}</td>
                  <td>{ms(t.derived.totalTurnMs)}</td>
                  <td>{ms(t.derived.audioDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {turns.length > 0 && (
        <button
          type="button"
          className="ghost"
          onClick={() => downloadJson(turns, `turns-${Date.now()}.json`)}
        >
          Export turns as JSON
        </button>
      )}
    </section>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className={`stat ${big ? 'big' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
