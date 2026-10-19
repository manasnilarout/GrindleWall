import { useState } from 'react';
import type { SessionSummary } from '../lib/protocol';
import { PanelIcon } from './Icon';
import { sessionAudioUrl } from '../lib/auth';

/** A selected run's place in the comparison: its number, its colour, and a readable name. */
export interface SeriesTag {
  n: number;
  color: string;
  name: string;
}

/** The numbered square that ties a run's row, its bar and its player together. */
export function SeriesBadge({ tag, small = false }: { tag: SeriesTag; small?: boolean }) {
  return (
    <span className={`series-badge${small ? ' sm' : ''}`} style={{ background: tag.color }} aria-hidden="true">
      {tag.n}
    </span>
  );
}

/**
 * Why a player failed. A missing file (the route's 404) surfaces as
 * MEDIA_ERR_SRC_NOT_SUPPORTED — a WAV is playable everywhere, so that code
 * here means there was nothing to play. Any other code is a fetch that broke,
 * and saying "no recording" about it would claim an absence nobody checked.
 */
type Failure = 'absent' | 'failed';

/**
 * Playback for the conversations being compared. One stereo file per run:
 * **left channel the mic, right channel the assistant** — which is the only
 * place that layout is explained, hence the hint in the heading.
 *
 * Its own component rather than a block inside ComparePage so it can be
 * server-rendered directly with runs in hand. ComparePage fills `runs` from a
 * `useEffect` fetch, and `renderToString` never runs effects, so anything
 * nested inside it is unreachable from `render-check` in the state that
 * matters — the panel would ship with only its own absence verified.
 */
export function Recordings({ runs, series }: { runs: SessionSummary[]; series?: Record<string, SeriesTag> }) {
  /*
   * Recording is not retroactive and a conversation that was only ever typed
   * into never opens the mic, so plenty of records legitimately have no WAV.
   * Rather than probing every one up front, the player reports its own 404.
   */
  const [missing, setMissing] = useState<Record<string, Failure>>({});

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
   * pose. A player that failed for some other reason keeps the panel up, since
   * that is not a known absence.
   */
  if (!runs.some((run) => missing[run.recordId] !== 'absent')) return null;

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="headphones" />
        Recordings
        <span className="right muted">left: mic · right: assistant</span>
      </h2>
      <div className="recordings">
        {runs.map((run) => {
          const tag = series?.[run.recordId];
          const failure = missing[run.recordId];
          return (
            <div className="recording" key={run.recordId}>
              {tag && <SeriesBadge tag={tag} small />}
              <div className="recording-body">
                <span className="recording-name" title={run.label}>
                  {tag?.name ?? run.label}
                </span>
                {failure === 'absent' ? (
                  <span
                    className="muted small"
                    title="This conversation predates recording, or the mic was never opened."
                  >
                    No recording on disk for this run.
                  </span>
                ) : failure === 'failed' ? (
                  <span className="est small">Could not load the recording.</span>
                ) : (
                  <audio
                    controls
                    // Loads only the header, which is enough to discover the file is
                    // missing without pulling megabytes per row.
                    preload="metadata"
                    aria-label={`Recording of ${tag?.name ?? run.label}`}
                    src={sessionAudioUrl(run.recordId)}
                    onError={(e) => {
                      const code = e.currentTarget.error?.code;
                      const kind: Failure = code === 4 ? 'absent' : 'failed';
                      setMissing((prev) => ({ ...prev, [run.recordId]: kind }));
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
