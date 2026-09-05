import type { LogLine } from '../hooks/useVoiceSession';

export function LogPanel({ logs }: { logs: LogLine[] }) {
  return (
    <section className="panel">
      <h2>Log</h2>
      <div className="log">
        {logs.length === 0 && <p className="muted">Quiet.</p>}
        {logs.map((l, i) => (
          <div key={i} className={`log-line ${l.level}`}>
            <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>
            <span>{l.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
