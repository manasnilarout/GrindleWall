import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionIndexEntry, SessionSummary } from '../lib/protocol';
import { duration, inr, usd, when } from '../lib/format';
import { normalizeSummary } from '../lib/session';
import { SessionReport } from './SessionReport';

/**
 * Conversations already on disk. The backend files a record after every turn,
 * so this lists sessions that were properly ended and ones that were merely
 * abandoned alike.
 */
export function PastSessions({ refreshKey }: { refreshKey: number }) {
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [open, setOpen] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string>();

  /** Rapid refreshes resolve out of order, so only the newest request may write. */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    fetch('/api/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { sessions: SessionIndexEntry[] }) => {
        if (mine !== generation.current) return;
        setSessions(d.sessions);
        setError(undefined);
      })
      .catch((err: Error) => {
        if (mine === generation.current) setError(err.message);
      });
  }, []);

  // Block body on purpose: passing `load` directly would make its return value
  // React's cleanup function the moment anyone gives it one.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (open) {
    return <SessionReport summary={open} title="Past conversation" onDismiss={() => setOpen(null)} />;
  }

  return (
    <section className="panel">
      <h2>
        Past conversations
        <button type="button" className="ghost inline" onClick={load}>
          refresh
        </button>
      </h2>

      {error && <p className="muted small">Cannot list sessions: {error}</p>}
      {!error && sessions.length === 0 && <p className="muted">Nothing recorded yet.</p>}

      {sessions.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Pipeline</th>
                <th>Turns</th>
                <th>Length</th>
                <th>USD</th>
                <th>INR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.recordId}>
                  <td>{when(s.startedAt)}</td>
                  <td className="pipeline-cell" title={s.label}>
                    {s.label}
                  </td>
                  <td>{s.turnCount}</td>
                  <td>{duration(s.endedAt - s.startedAt)}</td>
                  <td className="strong">{usd(s.costUsd)}</td>
                  <td className="strong">
                    {inr(s.costInr)}
                    {s.unpriced.length > 0 && <span className="warn-flag" title={`Unpriced: ${s.unpriced.join(', ')}`}> +</span>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost inline"
                      onClick={() => {
                        const mine = ++generation.current;
                        void fetch(`/api/sessions/${encodeURIComponent(s.recordId)}`)
                          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                          .then((raw) => {
                            if (mine === generation.current) setOpen(normalizeSummary(raw));
                          })
                          .catch((err: Error) => {
                            if (mine === generation.current) setError(err.message);
                          });
                      }}
                    >
                      open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
