import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCatalog, type ProviderEntry } from './lib/catalog';
import type { SessionSummary } from './lib/protocol';
import {
  blankRig,
  chainOf,
  loadRigs,
  rigColor,
  saveRigs,
  seedRigs,
  startConfigOf,
  withDefaults,
  type Rig,
} from './lib/rigs';
import { summarize } from './lib/stats';
import { useVoiceSession } from './hooks/useVoiceSession';
import { RigTabs, type RigScore } from './components/RigTabs';
import { RigRail } from './components/RigRail';
import { RigBuilder } from './components/RigBuilder';
import { PromptWidget } from './components/PromptWidget';
import { Transcript } from './components/Transcript';
import { TurnsPanel } from './components/TurnsPanel';
import { InsightsPanel, CostPanel } from './components/InsightsPanel';
import { SessionReport } from './components/SessionReport';
import { ComparePage } from './components/ComparePage';
import { Console } from './components/Console';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon, PanelIcon } from './components/Icon';
import { LoginPage } from './components/LoginPage';
import { useAuth } from './hooks/useAuth';

const DEFAULT_PROMPT = 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.';

type View = 'bench' | 'compare';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="app login-app">
        <header className="topbar">
          <span className="brand">
            <img className="brand-logo" src="/magickvoice-logo.png" alt="MagickVoice" />
            <span className="brand-copy">
              <span className="brand-name">Grindelwald</span>
              <span className="brand-byline">powered by MagickVoice</span>
            </span>
          </span>
        </header>
      </div>
    );
  }

  if (auth.status === 'login') {
    return (
      <LoginPage
        username={auth.username}
        sessionTtlMs={auth.sessionTtlMs}
        onSubmit={auth.signIn}
      />
    );
  }

  return <Bench onLogout={auth.required ? auth.signOut : undefined} username={auth.session?.username} />;
}

export function Bench({
  onLogout,
  username,
}: {
  onLogout?: () => void;
  username?: string;
}) {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT);
  const [turnDetection, setTurnDetection] = useState<'server_vad' | 'manual'>('server_vad');

  const [rigs, setRigs] = useState<Rig[]>([]);
  const [activeRigId, setActiveRigId] = useState('');
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<View>('bench');
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [showReport, setShowReport] = useState(true);
  /** A past record opened from the compare view, shown instead of the live one. */
  const [openRecord, setOpenRecord] = useState<SessionSummary | null>(null);

  /**
   * Per-rig headline numbers from runs made in this tab. They are a convenience
   * on the tabs, not a record: the durable numbers are the ones the backend
   * files after every turn, and the compare view reads those.
   */
  const [scores, setScores] = useState<Record<string, RigScore>>({});
  /** Which rig the live session belongs to, so its numbers land on the right tab. */
  const [runningRigId, setRunningRigId] = useState('');

  const session = useVoiceSession();
  const connected = session.state === 'ready';
  /** Between asking for the bill and receiving it. */
  const ending = session.state === 'ending';
  /** A live session pins its rig: swapping config under an open socket would
      attribute the numbers to a combination that never produced them. */
  const locked = connected || ending || session.state === 'connecting';

  useEffect(() => {
    fetchCatalog()
      .then(({ providers: list }) => {
        setProviders(list);
        const saved = loadRigs();
        // Restored rigs are re-validated against the catalog: a provider that
        // has since been removed would otherwise sit in a slot the factory
        // refuses, with no clue as to why the session will not start.
        const next = saved ? saved.rigs.map((r) => withDefaults(r, list)) : seedRigs(list);
        setRigs(next);
        setActiveRigId(saved?.activeId && next.some((r) => r.id === saved.activeId) ? saved.activeId : next[0].id);
      })
      .catch((err: Error) => setCatalogError(err.message));
  }, []);

  useEffect(() => {
    if (rigs.length) saveRigs(rigs, activeRigId);
  }, [rigs, activeRigId]);

  const activeRig = rigs.find((r) => r.id === activeRigId);

  const updateRig = useCallback(
    (next: Rig) => setRigs((prev) => prev.map((r) => (r.id === next.id ? next : r))),
    [],
  );

  /*
   * Both of these build the next state OUTSIDE the updater.
   *
   * A `setState` updater must be pure and may be invoked more than once —
   * StrictMode double-invokes every one. `blankRig` calls `Math.random()` for
   * the id, so running it inside the updater minted two different rigs per
   * click and survived only because React keeps the last invocation; and
   * calling `setActiveRigId` from inside `setRigs` is a sibling update fired
   * during render.
   */
  const addRig = useCallback(() => {
    // colorIndex is the high-water mark, not the length: reusing a deleted
    // rig's colour would repaint a chart someone is mid-comparison on.
    const nextIndex = rigs.reduce((max, r) => Math.max(max, r.colorIndex), -1) + 1;
    const rig = withDefaults(blankRig(`Rig ${String.fromCharCode(65 + nextIndex)}`, nextIndex), providers);
    setRigs((prev) => [...prev, rig]);
    setActiveRigId(rig.id);
  }, [providers, rigs]);

  const deleteRig = useCallback(
    (id: string) => {
      if (rigs.length <= 1) return;
      const next = rigs.filter((r) => r.id !== id);
      setRigs(next);
      if (activeRigId === id) setActiveRigId(next[0].id);
    },
    [rigs, activeRigId],
  );

  const startConfig = useMemo(
    () => (activeRig ? startConfigOf(activeRig, providers, systemPrompt, turnDetection) : undefined),
    [activeRig, providers, systemPrompt, turnDetection],
  );

  const connect = useCallback(() => {
    if (!startConfig || !activeRig) return;
    setShowReport(true);
    setOpenRecord(null);
    setRunningRigId(activeRig.id);
    setView('bench');
    void session.connect(startConfig);
  }, [session, startConfig, activeRig]);

  // Keep the running rig's tab score current as its turns land.
  const { turns } = session;
  useEffect(() => {
    if (!runningRigId || turns.length === 0) return;
    const ttfa = summarize(
      turns.map((t) => t.clientTtfaMs ?? t.derived.timeToFirstAudioMs).filter((v): v is number => v !== undefined),
    );
    setScores((prev) => ({
      ...prev,
      [runningRigId]: { ttfaMedianMs: ttfa?.median, turns: turns.length },
    }));
  }, [turns, runningRigId]);

  const chain = activeRig ? chainOf(activeRig, providers) : [];
  const report = openRecord ?? (showReport ? session.summary : null);

  return (
    <div className={`app ${consoleExpanded ? 'console-open' : ''}`}>
      <div className="enchantment" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <i key={i} className="spark" />
        ))}
      </div>
      <header className="topbar">
        <span className="brand">
          <img
            className="brand-logo"
            src="/magickvoice-logo.png"
            alt="MagickVoice"
          />
          <span className="brand-copy">
            <span className="brand-name">Grindelwald</span>
            <span className="brand-byline">powered by MagickVoice</span>
          </span>
        </span>

        {activeRig && (
          <span className="chain" title={session.label || 'not connected'}>
            {chain.map((name, i) => (
              <span key={`${name}-${i}`}>
                {i > 0 && <span className="arrow">›</span>}
                <b>{name}</b>
              </span>
            ))}
            <span className="arrow">·</span>
            {(activeRig.mode === 'realtime' ? activeRig.language : activeRig.ttsLanguage) || 'default'}
          </span>
        )}

        <span className="spacer" />

        <div className="seg">
          <button type="button" className={view === 'bench' ? 'on' : ''} onClick={() => setView('bench')}>
            <Icon name="wand" size={12} />
            Bench
          </button>
          <button type="button" className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>
            <Icon name="snitch" size={12} />
            Compare
          </button>
        </div>

        <span className="muted small">24 kHz PCM16</span>
        <span className={`badge ${session.state}`}>{session.state}</span>
        {session.sessionId && <code className="mono muted small">{session.sessionId.slice(0, 12)}</code>}
        {username && <span className="muted small">{username}</span>}
        {onLogout && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              void session.disconnect();
              void onLogout();
            }}
          >
            Sign out
          </button>
        )}
      </header>

      {catalogError && <div className="banner error">Cannot reach the backend: {catalogError}</div>}

      {view === 'bench' && activeRig && (
        <>
          <RigTabs
            rigs={rigs}
            activeId={activeRigId}
            scores={scores}
            locked={locked}
            onSelect={setActiveRigId}
            onAdd={addRig}
            onCompare={() => setView('compare')}
          />

          <div className="columns bench-cols">
            <div className="col">
              <ErrorBoundary panel="Rig">
                <RigRail
                  rig={activeRig}
                  providers={providers}
                  systemPrompt={systemPrompt}
                  turns={session.turns}
                  locked={locked}
                  canDelete={rigs.length > 1}
                  onEdit={() => setEditing(true)}
                  onRename={(name) => updateRig({ ...activeRig, name })}
                  onDelete={() => deleteRig(activeRig.id)}
                />
              </ErrorBoundary>

              <PromptWidget
                systemPrompt={systemPrompt}
                onSystemPromptChange={setSystemPrompt}
                turnDetection={turnDetection}
                onTurnDetectionChange={setTurnDetection}
                onSend={session.sendText}
                canSend={connected}
                locked={locked}
              />
            </div>

            <div className="col">
              <section className="runbar">
                {/* The primary slot never swaps its action out from under a
                    second click: while the bill is being fetched it holds a
                    disabled placeholder rather than becoming Connect. */}
                {connected ? (
                  <>
                    <button type="button" className="btn primary" onClick={() => void session.endConversation()}>
                      <Icon name="scroll" size={13} />
                      End conversation
                    </button>
                    <button type="button" className="btn" onClick={() => void session.disconnect()} title="Drop the session without a report">
                      <Icon name="linkOff" size={13} />
                      Disconnect
                    </button>
                  </>
                ) : ending ? (
                  <button type="button" className="btn primary" disabled>
                    <Icon name="hourglass" size={13} />
                    Ending…
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={connect}
                    // A second click while connecting would open a second socket
                    // whose close handler tears down the first.
                    disabled={providers.length === 0 || session.state === 'connecting'}
                  >
                    <Icon name={session.state === 'connecting' ? 'hourglass' : 'key'} size={13} />
                    {session.state === 'connecting' ? 'Connecting…' : 'Connect'}
                  </button>
                )}

                <button
                  type="button"
                  className={`btn ${session.micOn ? 'hot' : ''}`}
                  // Stopping stays available after the socket drops, so a lost
                  // connection cannot leave the microphone hot.
                  disabled={!connected && !session.micOn}
                  onClick={() => (session.micOn ? void session.stopMic() : void session.startMic())}
                >
                  <Icon name={session.micOn ? 'micOff' : 'mic'} size={13} />
                  {session.micOn ? 'Stop mic' : 'Start mic'}
                </button>

                {turnDetection === 'manual' && (
                  <button type="button" className="btn" disabled={!connected || !session.micOn} onClick={session.commitAudio}>
                    <Icon name="hourglass" size={13} />
                    End my turn
                  </button>
                )}
                <button type="button" className="btn" disabled={!connected} onClick={session.interrupt}>
                  <Icon name="lightning" size={13} />
                  Interrupt
                </button>

                <span className="field-label" id="mic-level-label">
                  mic
                </span>
                {/* A bare span with aria-label is ignored; a meter needs a role
                    and a value for it to mean anything. */}
                <span
                  className="meter"
                  role="progressbar"
                  aria-labelledby="mic-level-label"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(Math.min(100, session.micLevel * 140))}
                >
                  <span className="meter-fill" style={{ width: `${Math.min(100, session.micLevel * 140)}%` }} />
                </span>
              </section>

              {report && (
                <ErrorBoundary panel="Conversation report">
                  <SessionReport
                    summary={report}
                    title={openRecord ? 'Past conversation' : 'Conversation report'}
                    onDismiss={() => (openRecord ? setOpenRecord(null) : setShowReport(false))}
                  />
                </ErrorBoundary>
              )}

              <Transcript utterances={session.utterances} speaking={session.assistantSpeaking} />

              <ErrorBoundary panel="Turns">
                <TurnsPanel turns={session.turns} usage={session.usage} />
              </ErrorBoundary>
            </div>

            <div className="col">
              <ErrorBoundary panel="Insights">
                <InsightsPanel turns={session.turns} />
              </ErrorBoundary>
              <ErrorBoundary panel="Cost">
                <CostPanel usage={session.usage} />
              </ErrorBoundary>
              <section className="panel">
                <h2>
                  <PanelIcon name="castle" />
                  This rig
                  <span className="right" style={{ color: rigColor(activeRig) }}>
                    ●
                  </span>
                </h2>
                <p className="muted small">
                  {scores[activeRig.id]?.turns
                    ? `${scores[activeRig.id].turns} turns run in this tab. Every one is already filed on disk — open Compare to put this rig beside another.`
                    : 'No turns yet in this tab. Connect, speak or type a turn, then end the conversation to file it.'}
                </p>
              </section>
            </div>
          </div>
        </>
      )}

      {view === 'compare' && (
        <ErrorBoundary panel="Compare">
          <ComparePage
            onOpenReport={(s) => {
              setOpenRecord(s);
              setView('bench');
            }}
          />
        </ErrorBoundary>
      )}

      <ErrorBoundary panel="Console">
        <Console logs={session.logs} expanded={consoleExpanded} onToggleExpand={() => setConsoleExpanded((v) => !v)} />
      </ErrorBoundary>

      {editing && activeRig && (
        <RigBuilder
          rig={activeRig}
          providers={providers}
          disabled={locked}
          onChange={updateRig}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
