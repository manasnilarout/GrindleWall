import { useState } from 'react';
import type { TurnRecord } from '../hooks/useVoiceSession';
import type { TurnUsage } from '../lib/protocol';
import { bandsOf } from '../lib/legs';
import { MARK_NOTE } from '../lib/logsource';
import { ms, secs } from '../lib/format';
import { medianOf } from '../lib/stats';
import { downloadJson } from '../lib/download';
import { UsagePanel } from './UsagePanel';
import { Waterfall, WaterfallAxis, WaterfallLegend, type WaterfallRow } from './Waterfall';

type Tab = 'turns' | 'usage' | 'marks';

/**
 * The per-turn detail, three ways: as a waterfall, as the billing table, and as
 * the raw marks.
 *
 * They are tabs rather than three stacked panels because they answer the same
 * question at different resolutions, and only one of them is ever the one you
 * want. The waterfall leads because "which leg is slow" is the question this
 * bench exists to answer.
 */
export function TurnsPanel({ turns, usage }: { turns: TurnRecord[]; usage: TurnUsage[] }) {
  const [tab, setTab] = useState<Tab>('turns');

  const rows: WaterfallRow[] = turns.map((t) => ({
    turnId: t.turnId,
    bands: bandsOf(t.derived, t.marks),
    // The server's t0-based figure. Not the browser's: that one starts its clock
    // at the final transcript, so it is a different measurement on a different
    // origin and cannot share this axis. And never the sum of the bands — they
    // overlap, and on this repo's smoke output the sum is 1.63x the truth.
    totalMs: t.derived.timeToFirstAudioMs,
    tailMs: t.derived.audioDurationMs,
  }));

  /**
   * One scale for the panel, sized to the longest thing on it — including the
   * audio tails, or a long reply would run off the end of its own row. Falls
   * back to a second so an empty panel still draws an axis.
   */
  const scaleMs =
    Math.max(
      1000,
      ...rows.map((r) => (r.totalMs ?? 0) + (r.tailMs ?? 0)),
      // A leg can end after the first audio byte (TTS TTFB is measured from its
      // own request), so the scale has to cover the bands too or one runs off.
      ...rows.flatMap((r) => r.bands.map((b) => b.startMs + b.ms)),
    ) || 1000;

  /** Median browser-side reply latency, reported as its own number, never subtracted. */
  const browserSide = medianOf(turns.map((t) => t.clientTtfaMs).filter((v): v is number => v !== undefined));

  return (
    <section className="panel grow">
      <h2>
        <TabButton tab="turns" active={tab} onSelect={setTab}>
          Turns
        </TabButton>
        <TabButton tab="usage" active={tab} onSelect={setTab}>
          Tokens &amp; cost
        </TabButton>
        <TabButton tab="marks" active={tab} onSelect={setTab}>
          Marks
        </TabButton>
        {tab === 'turns' && <WaterfallLegend />}
      </h2>

      {turns.length === 0 && tab !== 'usage' && <p className="muted">Complete a turn to collect numbers.</p>}

      {tab === 'turns' && turns.length > 0 && (
        <div className="scroller">
          <Waterfall rows={rows} scaleMs={scaleMs} />
          <WaterfallAxis scaleMs={scaleMs} />
          <p className="muted small foot">
            Bars are drawn where each leg actually ran, so they overlap — a pipeline opens the TTS socket while the
            LLM is still thinking. They do <strong>not</strong> add up to the turn, and the tick is the moment the
            server sent its first audio byte. Hatched = the reply playing out after that.
            {browserSide !== undefined && (
              <>
                {' '}
                In the browser, the reply became audible a median of <strong>{ms(browserSide)} ms</strong> after the
                final transcript arrived here — a different clock on a different origin, so it is reported beside
                these numbers rather than subtracted from them.
              </>
            )}
          </p>
          <button type="button" className="ghost" onClick={() => downloadJson(turns, `turns-${Date.now()}.json`)}>
            Export turns as JSON
          </button>
        </div>
      )}

      {tab === 'usage' && (
        <div className="scroller">
          <UsagePanel usage={usage} compact />
        </div>
      )}

      {tab === 'marks' && turns.length > 0 && <MarksTable turns={turns} />}
    </section>
  );
}

/**
 * Every mark of the most recent turn, in the order they fired.
 *
 * This is the rawest view the UI offers, and the point of it is the deltas: a
 * turn that looks fine on TTFA but spent 400 ms between `llm_last_token` and
 * `tts_first_audio` has a problem the summary numbers do not name.
 */
function MarksTable({ turns }: { turns: TurnRecord[] }) {
  const turn = turns[turns.length - 1];
  const marks = [...turn.marks].sort((a, b) => a.atMs - b.atMs);

  return (
    <div className="scroller">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Mark</th>
              <th>t+ms</th>
              <th>Δ prev</th>
              <th>What it means</th>
            </tr>
          </thead>
          <tbody>
            {marks.map((mark, i) => (
              <tr key={mark.name}>
                <td className="mono">{mark.name}</td>
                <td className="strong">{ms(mark.atMs)}</td>
                <td className="muted">{i === 0 ? '—' : `+${ms(mark.atMs - marks[i - 1].atMs)}`}</td>
                <td className="muted note-cell">{MARK_NOTE[mark.name]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small foot">
        Turn {turn.turnId}, the most recent. Audio rendered: {secs(turn.derived.audioDurationMs)}. First occurrence of
        a mark wins, so a provider that reports a stage twice cannot move t0 out from under the other numbers.
      </p>
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  children,
}: {
  tab: Tab;
  active: Tab;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`tab ${tab === active ? 'on' : ''}`} onClick={() => onSelect(tab)}>
      {children}
    </button>
  );
}
