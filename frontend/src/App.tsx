import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCatalog, type ProviderEntry } from './lib/catalog';
import type { SessionSummary } from './lib/protocol';
import {
  blankRig,
  loadRigs,
  rigLetter,
  saveRigs,
  seedRigs,
  startConfigOf,
  withDefaults,
  type Rig,
} from './lib/rigs';
import { summarize } from './lib/stats';
import { useVoiceSession } from './hooks/useVoiceSession';
import { Sidebar, type BackendStatus, type NavView, type RigScore } from './components/Sidebar';
import { BenchView, type TurnDetection } from './components/BenchView';
import { RunDetailView } from './components/RunDetailView';
import { RigBuilder } from './components/RigBuilder';
import { CreateCodeDialog } from './components/CreateCodeDialog';
import { ComparePage, type RunsMemory } from './components/ComparePage';
import { Console } from './components/Console';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginPage } from './components/LoginPage';
import { useAuth } from './hooks/useAuth';

const DEFAULT_PROMPT = 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.';

/** `run` is one filed conversation: the report you land on, or a record opened from Runs. */
type View = NavView | 'run';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="splash">
        <span className="brand">
          <img className="brand-logo" src="/magickvoice-logo.png" alt="MagickVoice" />
          <span className="brand-copy">
            <span className="brand-name">Grindelwald</span>
            <span className="brand-byline">powered by MagickVoice</span>
          </span>
        </span>
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
  const [turnDetection, setTurnDetection] = useState<TurnDetection>('server_vad');

  const [rigs, setRigs] = useState<Rig[]>([]);
  const [activeRigId, setActiveRigId] = useState('');
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<View>('bench');
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  /** The record the run page shows. Null until one is opened or a conversation ends. */
  const [runRecord, setRunRecord] = useState<SessionSummary | null>(null);
  /** Whether `runRecord` is the conversation that just ended here, rather than one off disk. */
  const [runIsLive, setRunIsLive] = useState(false);
  /** Set on connect: the next summary that arrives is this conversation's bill, and opens its report. */
  const [awaitingReport, setAwaitingReport] = useState(false);

  /**
   * Per-rig headline numbers from runs made in this tab. They are a convenience
   * on the sidebar, not a record: the durable numbers are the ones the backend
   * files after every turn, and the Runs view reads those.
   */
  const [scores, setScores] = useState<Record<string, RigScore>>({});
  /** Which rig the live session belongs to, so its numbers land on the right rig. */
  const [runningRigId, setRunningRigId] = useState('');

  const session = useVoiceSession();
  /** A live session pins its rig: swapping config under an open socket would
      attribute the numbers to a combination that never produced them. */
  const locked = session.state === 'ready' || session.state === 'ending' || session.state === 'connecting';

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

  /** Highest colorIndex any rig has held this session, deleted rigs included. */
  const colorHighWater = useRef(-1);
  useEffect(() => {
    colorHighWater.current = rigs.reduce((max, r) => Math.max(max, r.colorIndex), colorHighWater.current);
  }, [rigs]);

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
    // colorIndex is the session's high-water mark, not the length and not the
    // max of the rigs left: reusing a deleted rig's colour would repaint a
    // chart someone is mid-comparison on.
    const nextIndex = rigs.reduce((max, r) => Math.max(max, r.colorIndex), colorHighWater.current) + 1;
    const rig = withDefaults(blankRig(`Rig ${rigLetter({ colorIndex: nextIndex })}`, nextIndex), providers);
    setRigs((prev) => [...prev, rig]);
    setActiveRigId(rig.id);
    setView('bench');
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
    setAwaitingReport(true);
    setRunningRigId(activeRig.id);
    setView('bench');
    void session.connect(startConfig);
  }, [session, startConfig, activeRig]);

  // The conversation's bill arrived: file it as the run page and go there —
  // but only from the bench. A bill that lands after the end timeout, once the
  // user has moved on to Runs, must not yank them out of what they are reading.
  const { summary } = session;
  useEffect(() => {
    if (!summary || !awaitingReport) return;
    setAwaitingReport(false);
    if (view !== 'bench') return;
    setRunRecord(summary);
    setRunIsLive(true);
    setView('run');
  }, [summary, awaitingReport, view]);

  // Keep the running rig's sidebar score current as its turns land.
  const { turns } = session;
  useEffect(() => {
    if (!runningRigId || turns.length === 0) return;
    const ttfa = summarize(
      // The server's figure only, as everywhere a TTFA is headlined: the
      // browser's starts at the final transcript, a different clock.
      turns.map((t) => t.derived.timeToFirstAudioMs).filter((v): v is number => v !== undefined),
    );
    setScores((prev) => ({
      ...prev,
      [runningRigId]: { ttfaMedianMs: ttfa?.median, turns: turns.length },
    }));
  }, [turns, runningRigId]);

  const openRun = useCallback((record: SessionSummary) => {
    setRunRecord(record);
    setRunIsLive(false);
    setView('run');
  }, []);

  const selectRig = useCallback((id: string) => {
    setActiveRigId(id);
    setView('bench');
  }, []);

  const backend: BackendStatus = catalogError ? 'unreachable' : providers.length ? 'ready' : 'loading';

  /** Survives leaving Runs for a run's page and coming back by the crumb. */
  const runsMemory = useRef<RunsMemory>({});

  return (
    <div className={`shell ${consoleExpanded ? 'console-open' : ''}`}>
      <Sidebar
        view={view === 'run' ? 'runs' : view}
        onNavigate={setView}
        rigs={rigs}
        activeRigId={activeRigId}
        providers={providers}
        scores={scores}
        locked={locked}
        onSelectRig={selectRig}
        onAddRig={addRig}
        backend={backend}
        username={username}
        onLogout={
          onLogout &&
          (() => {
            void session.disconnect();
            void onLogout();
          })
        }
      />

      <main className="main has-console">
        {catalogError && (
          <div className="banner error page-banner" role="alert">
            Cannot reach the backend: {catalogError}
          </div>
        )}

        {view === 'bench' && activeRig && (
          <BenchView
            rig={activeRig}
            providers={providers}
            session={session}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            turnDetection={turnDetection}
            onTurnDetectionChange={setTurnDetection}
            locked={locked}
            canDelete={rigs.length > 1}
            score={scores[activeRig.id]}
            onConnect={connect}
            onEdit={() => setEditing(true)}
            onRename={(name) => updateRig({ ...activeRig, name })}
            onDelete={() => deleteRig(activeRig.id)}
            onCreateCode={() => setExporting(true)}
          />
        )}

        {view === 'runs' && (
          <ErrorBoundary panel="Runs">
            <ComparePage onOpenReport={openRun} providers={providers} memory={runsMemory.current} />
          </ErrorBoundary>
        )}

        {view === 'run' && runRecord && (
          <RunDetailView
            summary={runRecord}
            justEnded={runIsLive}
            providers={providers}
            onBackToRuns={() => setView('runs')}
            onBackToBench={() => setView('bench')}
          />
        )}
      </main>

      {/* At the shell rather than in BenchView, and on every view: it must be
          there before the catalog arrives, which is exactly when a connection
          error is logged, and a session can still be live while you read Runs. */}
      <ErrorBoundary panel="Console">
        <Console logs={session.logs} expanded={consoleExpanded} onToggleExpand={() => setConsoleExpanded((v) => !v)} />
      </ErrorBoundary>

      {editing && activeRig && (
        <RigBuilder
          rig={activeRig}
          providers={providers}
          // The sheet shows the rig as a script command; without the prompt
          // that command would measure smoke's default prompt instead.
          systemPrompt={systemPrompt}
          disabled={locked}
          onChange={updateRig}
          onClose={() => setEditing(false)}
        />
      )}

      {exporting && activeRig && (
        <CreateCodeDialog
          rig={activeRig}
          providers={providers}
          systemPrompt={systemPrompt}
          turnDetection={turnDetection}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
