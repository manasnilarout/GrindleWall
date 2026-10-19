import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine } from '../hooks/useVoiceSession';
import { SOURCE_COLOR, type LogSource } from '../lib/logsource';
import { ms } from '../lib/format';
import { Icon } from './Icon';

type Level = LogLine['level'];

const LEVELS: Level[] = ['info', 'warn', 'error'];

/**
 * The log pane, promoted from a scrolling list of grey text to something you
 * can actually search.
 *
 * A pipeline turn produces a couple of dozen lines across four vendors; the
 * previous panel showed all of them, undifferentiated, and capped the buffer at
 * 200 so the interesting one had usually already scrolled away. What matters
 * here is being able to say "just the TTS leg, just warnings" and have the
 * answer left on screen.
 */
export function Console({
  logs,
  expanded,
  onToggleExpand,
}: {
  logs: LogLine[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [levels, setLevels] = useState<Record<Level, boolean>>({ info: true, warn: true, error: true });
  const [mutedSources, setMutedSources] = useState<Partial<Record<LogSource, boolean>>>({});
  const [query, setQuery] = useState('');
  const [relative, setRelative] = useState(false);
  const [follow, setFollow] = useState(true);
  /** Keyed by the line itself, not its position: a filter change reorders the list. */
  const [openLine, setOpenLine] = useState<string | null>(null);

  const counts = useMemo(() => {
    const byLevel: Record<Level, number> = { info: 0, warn: 0, error: 0 };
    const bySource = new Map<LogSource, number>();
    for (const line of logs) {
      byLevel[line.level] += 1;
      bySource.set(line.source, (bySource.get(line.source) ?? 0) + 1);
    }
    return { byLevel, bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]) };
  }, [logs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter(
      (line) =>
        levels[line.level] &&
        !mutedSources[line.source] &&
        (!q || line.message.toLowerCase().includes(q) || line.source.includes(q)),
    );
  }, [logs, levels, mutedSources, query]);

  const endRef = useRef<HTMLDivElement>(null);
  // Block body on purpose: a concise arrow would return scrollIntoView's result,
  // which React then treats as a cleanup function and tries to call.
  // `expanded` too: the stream is not mounted while collapsed, so opening it has
  // to land on the newest line rather than the oldest.
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, follow, expanded]);

  const toggleLevel = (level: Level) => setLevels((prev) => ({ ...prev, [level]: !prev[level] }));
  const toggleSource = (source: LogSource) => setMutedSources((prev) => ({ ...prev, [source]: !prev[source] }));

  const latest = logs[logs.length - 1];
  const toggle = (
    <button
      type="button"
      className="console-toggle"
      aria-expanded={expanded}
      // Only while the panel exists: pointing at an absent id is a broken reference.
      aria-controls={expanded ? 'console-panel' : undefined}
      onClick={onToggleExpand}
    >
      {expanded ? 'Close' : 'Open'}
      <Icon name="chevronRight" size={14} className={expanded ? 'chev-down' : 'chev-up'} />
    </button>
  );

  /*
   * Collapsed, the console is one line: enough to notice that something went
   * wrong without giving up a third of the page to grey text. The filters stay
   * in state while it is closed, so reopening it lands where you left off.
   */
  if (!expanded) {
    return (
      <section className="console bar" aria-label="Console">
        <Icon name="terminal" size={16} />
        <span className="console-title">Console</span>
        {counts.byLevel.warn > 0 && (
          <span className="console-pill warn">
            {`${counts.byLevel.warn} ${counts.byLevel.warn === 1 ? 'warning' : 'warnings'}`}
          </span>
        )}
        {counts.byLevel.error > 0 && (
          <span className="console-pill error">
            {`${counts.byLevel.error} ${counts.byLevel.error === 1 ? 'error' : 'errors'}`}
          </span>
        )}
        <span className={`console-latest mono ${latest?.level ?? ''}`} title={latest?.message}>
          {latest ? latestText(latest) : 'Quiet. Connect a session.'}
        </span>
        {toggle}
      </section>
    );
  }

  return (
    <section className="console expanded" aria-label="Console" id="console-panel">
      <div className="console-head">
        <Icon name="terminal" size={16} />
        <span className="console-title">Console</span>

        <div className="seg">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`${levels[level] ? `on ${level}` : ''}`}
              aria-pressed={levels[level]}
              onClick={() => toggleLevel(level)}
              title={`${levels[level] ? 'Hide' : 'Show'} ${level} lines`}
            >
              {`${level} ${counts.byLevel[level]}`}
            </button>
          ))}
        </div>

        <input
          className="console-search mono"
          value={query}
          spellCheck={false}
          aria-label="Filter console lines"
          placeholder="filter — try tts, or a mark name"
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="seg">
          <button type="button" className={relative ? '' : 'on'} onClick={() => setRelative(false)}>
            wall clock
          </button>
          <button
            type="button"
            className={relative ? 'on' : ''}
            onClick={() => setRelative(true)}
            title="Marks show ms since their turn's t0"
          >
            t+ from turn
          </button>
        </div>

        <button
          type="button"
          className={`chip ${follow ? 'on rec' : ''}`}
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
        >
          {follow ? '● following' : 'paused'}
        </button>

        <span className="spacer" />
        <span className="console-count">
          {shown.length} of {logs.length}
        </span>
        <button
          type="button"
          className="ghost inline"
          onClick={() => void navigator.clipboard?.writeText(shown.map(asText).join('\n'))}
          title="Copy the filtered lines"
        >
          <Icon name="copy" size={14} />
          Copy
        </button>
        {toggle}
      </div>

      <div className="console-body">
        <div className="console-stream">
          {logs.length === 0 && <p className="console-note">Quiet. Connect a session.</p>}
          {logs.length > 0 && shown.length === 0 && <p className="console-note">Nothing matches those filters.</p>}

          {shown.map((line, i) => {
            // Identity for the expansion, free of position: keyed by index, a
            // filter change moved the open detail pane under a different line.
            const id = `${line.at}-${line.source}-${line.kind}-${line.message}`;
            const isOpen = openLine === id;
            return (
              <div key={`${id}-${i}`}>
                {/* A button, not a div with onClick: every line is expandable,
                    so every line has to be reachable from the keyboard. */}
                <button
                  type="button"
                  className={`log-line ${line.level} ${line.kind === 'mark' ? 'mark' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpenLine(isOpen ? null : id)}
                >
                  <span className="log-time">{stamp(line, relative)}</span>
                  <span className="log-lv">{line.level === 'error' ? '✕' : line.level === 'warn' ? '▲' : '·'}</span>
                  {/* The source colour is a swatch, not the text colour: several
                      of the series hexes are too dark to read on midnight. */}
                  <span className="log-src">
                    <i style={{ background: SOURCE_COLOR[line.source] }} />
                    {line.source}
                  </span>
                  <span className="log-turn">{line.turnId ? `#${line.turnId}` : ''}</span>
                  <span className="log-msg">{line.message}</span>
                </button>
                {isOpen && (line.detail || line.message.length > 90) && (
                  <div className="log-detail">{line.detail ?? line.message}</div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        <aside className="console-rail">
          <h3>Sources</h3>
          {counts.bySource.map(([source, n]) => (
            <button
              key={source}
              type="button"
              className={`src-row ${mutedSources[source] ? 'off' : ''}`}
              aria-pressed={!mutedSources[source]}
              onClick={() => toggleSource(source)}
            >
              <i style={mutedSources[source] ? undefined : { background: SOURCE_COLOR[source] }} />
              {source}
              <span className="n">{n}</span>
            </button>
          ))}

          <p className="console-note">
            Sources are <strong>guessed</strong>, not reported: the log frame carries a level and free text and
            nothing else. A line is matched against the vendor names in this rig's slots first, then against
            keywords; an ambiguous one stays <code>session</code>. Filter by it, don't conclude from it. Highlighted
            lines are metric marks, which do carry their leg.
          </p>
          <p className="console-note">
            Lines from the server pass through <code>redactSecrets</code> before they are sent. Lines marked{' '}
            <code>mic</code> or <code>client</code> were produced in this page and never went through it — an error
            message from the browser's own audio or WebSocket stack is printed as-is.
          </p>
        </aside>
      </div>
    </section>
  );
}

/** The collapsed bar's one line: the newest entry, turn and source first so it scans like the full list. */
function latestText(line: LogLine): string {
  const at = line.atMs !== undefined ? `  t+${ms(line.atMs)} ms` : '';
  return `${line.turnId ? `#${line.turnId}  ` : ''}${line.source}  ${line.message}${at}`;
}

/** Wall clock, or ms since the turn's t0 for a mark that has one. */
function stamp(line: LogLine, relative: boolean): string {
  if (relative && line.atMs !== undefined) return `t+${ms(line.atMs)}`;
  if (relative) return '—';
  return new Date(line.at).toLocaleTimeString();
}

const asText = (line: LogLine): string =>
  `${new Date(line.at).toISOString()} ${line.level} ${line.source} ${line.turnId ? `#${line.turnId} ` : ''}${line.message}`;
