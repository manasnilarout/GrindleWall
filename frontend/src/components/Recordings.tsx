import { useState } from 'react';
import type { SessionSummary } from '../lib/protocol';
import { PanelIcon } from './Icon';

/**
 * Playback for the conversations being compared. One stereo file per run:
 * **left channel the user, right channel the assistant** — which is the only
 * place that layout is explained, hence the hint in the heading.
 *
 * Its own component rather than a block inside ComparePage so it can be
 * server-rendered directly with runs in hand. ComparePage fills `runs` from a
 * `useEffect` fetch, and `renderToString` never runs effects, so anything
 * nested inside it is unreachable from `render-check` in the state that
 * matters — the panel would ship with only its own absence verified.
 */
export function Recordings({ runs }: { runs: SessionSummary[] }) {
  /*
   * Recording is not retroactive and a conversation that was only ever typed
   * into never opens the mic, so plenty of records legitimately have no WAV.
   * Rather than probing every one up front, the player reports its own 404.
   */
  const [missing, setMissing] = useState<Record<string, true>>({});

  /*
   * Reset when the selection changes. Without this the map is write-only: a
   * record whose recording had not landed yet — the compare view left open on a
   * live conversation — would 404 once and stay marked for the lifetime of the
   * page, invisible even after its WAV appeared and even after being
   * deselected and picked again. Adjusting state during render on a changed key
   * is the sanctioned pattern for exactly this.
   */
  const key = runs.map((r) => r.recordId).join('\n');
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setMissing({});
  }

  /*
   * Hidden entirely when nothing in the selection has audio — otherwise every
   * comparison of pre-recording records would carry a panel of empty rows. But
   * once ANY run has a recording, every run gets a row: a run silently missing
   * from a list of players is indistinguishable from a broken one, and "which
   * of these has no audio" is a question the panel should answer rather than
   * pose.
   */
  if (!runs.some((run) => !missing[run.recordId])) return null;

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="owl" />
        Recordings
        <span className="right muted">left: you · right: the assistant</span>
      </h2>
      <div className="recordings">
        {runs.map((run) => (
          <div className="recording" key={run.recordId}>
            <div className="pipeline-cell" title={run.label}>
              {run.label}
            </div>
            {missing[run.recordId] ? (
              <span className="muted">no recording — this conversation predates recording, or the mic was never opened</span>
            ) : (
              <audio
                controls
                // Loads only the header, which is enough to discover the file is
                // missing without pulling megabytes per row.
                preload="metadata"
                aria-label={`Recording of ${run.label}`}
                src={`/api/sessions/${encodeURIComponent(run.recordId)}/audio`}
                onError={() => setMissing((prev) => ({ ...prev, [run.recordId]: true }))}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
