import { useEffect, useRef, useState } from 'react';
import type { ProviderEntry } from '../lib/catalog';
import type { Rig } from '../lib/rigs';
import { envCommandOf } from '../lib/rigs';
import type { ConnState, useVoiceSession } from '../hooks/useVoiceSession';
import type { RigScore } from './Sidebar';
import { RigRail } from './RigRail';
import { PromptWidget } from './PromptWidget';
import { Transcript } from './Transcript';
import { TurnsPanel } from './TurnsPanel';
import { InsightsPanel, CostPanel } from './InsightsPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { PageHeader } from './PageHeader';
import { Icon } from './Icon';

export type VoiceSessionHandle = ReturnType<typeof useVoiceSession>;
export type TurnDetection = 'server_vad' | 'manual';

const STATE_WORDS: Record<ConnState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  ready: 'Live',
  ending: 'Filing report…',
  ended: 'Ended',
  error: 'Error',
  closed: 'Closed',
};

const TURN_DETECTION: { id: TurnDetection; label: string; hint: string }[] = [
  { id: 'server_vad', label: 'Server VAD', hint: 'The provider decides when you stopped speaking' },
  { id: 'manual', label: 'Push to talk', hint: 'You end each turn yourself' },
];

const LOCKED_TITLE = 'End the conversation to edit this rig';

/**
 * The bench: run the active rig and watch its numbers land.
 *
 * Everything here reads the live session; nothing here decides routing or owns
 * rig state. `App` passes the rig and the session in and is told about intent
 * (connect, edit, export) through callbacks.
 */
export function BenchView({
  rig,
  providers,
  session,
  systemPrompt,
  onSystemPromptChange,
  turnDetection,
  onTurnDetectionChange,
  locked,
  canDelete,
  score,
  onConnect,
  onEdit,
  onRename,
  onDelete,
  onCreateCode,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  session: VoiceSessionHandle;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  turnDetection: TurnDetection;
  onTurnDetectionChange: (v: TurnDetection) => void;
  /** A live session pins its rig and its prompt. */
  locked: boolean;
  canDelete: boolean;
  score?: RigScore;
  onConnect: () => void;
  onEdit: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Opens the voice-stack export. The dialog lives at the app root, like the rig editor. */
  onCreateCode: () => void;
}) {
  const connected = session.state === 'ready';
  /** Between asking for the bill and receiving it. */
  const ending = session.state === 'ending';

  const [renaming, setRenaming] = useState(false);
  /** The name before this rename began, so Escape can put it back. */
  const nameBefore = useRef(rig.name);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [commandOpen, setCommandOpen] = useState(false);

  // Locking mid-rename (Connect pressed elsewhere) must not leave a live input.
  useEffect(() => {
    if (locked) setRenaming(false);
  }, [locked]);

  // Cleared on unmount: switching to Runs inside the window would otherwise
  // set state on a component that is gone.
  const resetTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const flash = (result: 'copied' | 'failed') => {
    setCopy(result);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopy('idle'), 1800);
  };

  const copyCommand = () => {
    // `navigator.clipboard` is undefined on a non-secure origin. Saying "copied"
    // when nothing was copied is worse than saying nothing, so a failure opens
    // the command for copying by hand instead.
    const written = navigator.clipboard?.writeText(envCommandOf(rig, providers, systemPrompt));
    const failed = () => {
      setCommandOpen(true);
      flash('failed');
    };
    if (!written) return failed();
    written.then(() => flash('copied'), failed);
  };

  const startRename = () => {
    nameBefore.current = rig.name;
    setRenaming(true);
  };
  const finishRename = () => {
    // An empty name would leave the rig unlabelled in the sidebar and in Runs.
    if (!rig.name.trim()) onRename(nameBefore.current);
    setRenaming(false);
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Bench' }]}
        title={
          renaming ? (
            <input
              className="rig-name-input"
              value={rig.name}
              autoFocus
              spellCheck={false}
              aria-label="Rig name"
              onChange={(e) => onRename(e.target.value)}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') finishRename();
                if (e.key === 'Escape') {
                  onRename(nameBefore.current);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            rig.name
          )
        }
        badges={
          <>
            {!renaming && (
              <button
                type="button"
                className="ghost icon-btn"
                onClick={startRename}
                disabled={locked}
                aria-label="Rename rig"
                title={locked ? LOCKED_TITLE : 'Rename rig'}
              >
                <Icon name="pencil" size={16} />
              </button>
            )}
            <span className="tag">{rig.mode === 'realtime' ? 'Realtime · speech to speech' : 'Pipeline · STT → LLM → TTS'}</span>
          </>
        }
        actions={
          <>
            <button type="button" className="ghost" onClick={copyCommand} aria-live="polite">
              <Icon name={copy === 'copied' ? 'check' : 'copy'} size={16} />
              {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed, shown below' : 'Copy CLI command'}
            </button>
            <button type="button" className="ghost" onClick={onCreateCode}>
              <Icon name="code" size={16} />
              Export voice stack
            </button>
            {canDelete && (
              <button
                type="button"
                className="ghost danger"
                onClick={onDelete}
                disabled={locked}
                title={locked ? 'End the conversation to delete this rig' : undefined}
              >
                <Icon name="trash" size={16} />
                Delete rig
              </button>
            )}
            <button type="button" className="btn" onClick={onEdit} disabled={locked} title={locked ? LOCKED_TITLE : undefined}>
              <Icon name="pencil" size={16} />
              Edit rig
            </button>
          </>
        }
      />

      <div className="bench">
        <ErrorBoundary panel="Rig">
          <RigRail
            rig={rig}
            providers={providers}
            systemPrompt={systemPrompt}
            turns={session.turns}
            locked={locked}
            onEdit={onEdit}
            commandOpen={commandOpen}
            onCommandOpenChange={setCommandOpen}
          />
        </ErrorBoundary>

        <section className="panel session-bar" aria-label="Session controls">
          <span className={`badge ${session.state}`}>{STATE_WORDS[session.state]}</span>

          <button
            type="button"
            className={`btn ${session.micOn ? 'hot' : ''}`}
            aria-pressed={session.micOn}
            title={session.micOn ? 'Stop the mic' : undefined}
            // Stopping stays available after the socket drops, so a lost
            // connection cannot leave the microphone hot.
            disabled={!connected && !session.micOn}
            onClick={() => (session.micOn ? void session.stopMic() : void session.startMic())}
          >
            <Icon name="mic" size={16} />
            {session.micOn ? 'Mic on' : 'Start mic'}
          </button>
          {session.micOn && (
            // A bare span with aria-label is ignored; a meter needs a role and
            // a value for it to mean anything. Beside the button, not in it: a
            // button's children are presentational, so a role inside one is dropped.
            <span
              className="meter"
              role="progressbar"
              aria-label="Mic level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, session.micLevel * 140))}
            >
              <span className="meter-fill" style={{ width: `${Math.min(100, session.micLevel * 140)}%` }} />
            </span>
          )}

          {turnDetection === 'manual' && (
            <button type="button" className="btn" disabled={!connected || !session.micOn} onClick={session.commitAudio}>
              <Icon name="check" size={16} />
              End my turn
            </button>
          )}
          <button type="button" className="btn" disabled={!connected} onClick={session.interrupt}>
            <Icon name="stop" size={16} />
            Interrupt
          </button>

          <span className="spacer" />

          {locked ? (
            <span className="turn-detection-locked" title="Turn detection is fixed for the life of a session">
              <Icon name="lock" size={14} />
              {`Turn detection: ${TURN_DETECTION.find((t) => t.id === turnDetection)?.label}`}
            </span>
          ) : (
            <span className="turn-detection" role="group" aria-labelledby="turn-detection-label">
              <span className="field-label" id="turn-detection-label">
                Turn detection
              </span>
              <span className="seg">
                {TURN_DETECTION.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={turnDetection === t.id ? 'on' : ''}
                    aria-pressed={turnDetection === t.id}
                    title={t.hint}
                    onClick={() => onTurnDetectionChange(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </span>
            </span>
          )}

          {connected && (
            <button type="button" className="ghost" onClick={() => void session.disconnect()} title="Drop the session without a report">
              <Icon name="linkOff" size={16} />
              Disconnect
            </button>
          )}

          {/* The primary slot never swaps its action out from under a
              second click: while the bill is being fetched it holds a
              disabled placeholder rather than becoming Connect. */}
          {connected ? (
            <button type="button" className="btn primary" onClick={() => void session.endConversation()}>
              <Icon name="scroll" size={16} />
              End and file report
            </button>
          ) : ending ? (
            <button type="button" className="btn primary" disabled>
              <Icon name="hourglass" size={16} />
              Ending…
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={onConnect}
              // A second click while connecting would open a second socket
              // whose close handler tears down the first.
              disabled={providers.length === 0 || session.state === 'connecting'}
            >
              <Icon name={session.state === 'connecting' ? 'hourglass' : 'play'} size={16} />
              {session.state === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </section>

        <div className="bench-cols">
          <div className="bench-main">
            <Transcript
              utterances={session.utterances}
              speaking={session.assistantSpeaking}
              turnCount={session.turns.length}
              micOn={session.micOn}
              onSend={session.sendText}
              canSend={connected}
            />
            <ErrorBoundary panel="Turns">
              <TurnsPanel turns={session.turns} usage={session.usage} />
            </ErrorBoundary>
          </div>

          <aside className="bench-side">
            <ErrorBoundary panel="Insights">
              <InsightsPanel turns={session.turns} mode={session.mode} />
            </ErrorBoundary>
            <ErrorBoundary panel="Cost">
              <CostPanel usage={session.usage} />
            </ErrorBoundary>
            <PromptWidget systemPrompt={systemPrompt} onSystemPromptChange={onSystemPromptChange} locked={locked} />
            {score?.turns ? (
              <p className="muted small">
                {score.turns} turns run in this tab. Every one is already filed on disk; open Runs to put this rig beside
                another.
              </p>
            ) : null}
          </aside>
        </div>
      </div>
    </>
  );
}
