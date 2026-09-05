import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCatalog, type ProviderEntry } from './lib/catalog';
import type { StartConfig } from './lib/protocol';
import { useVoiceSession } from './hooks/useVoiceSession';
import { ProviderPicker, type Selection } from './components/ProviderPicker';
import { PromptWidget } from './components/PromptWidget';
import { Transcript } from './components/Transcript';
import { MetricsPanel } from './components/MetricsPanel';
import { UsagePanel } from './components/UsagePanel';
import { SessionReport } from './components/SessionReport';
import { PastSessions } from './components/PastSessions';
import { LogPanel } from './components/LogPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

const DEFAULT_PROMPT = 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.';

export default function App() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT);
  const [turnDetection, setTurnDetection] = useState<'server_vad' | 'manual'>('server_vad');
  const [selection, setSelection] = useState<Selection>({
    mode: 'pipeline',
    realtimeProviderId: '',
    realtimeModelId: '',
    sttProviderId: '',
    sttModelId: '',
    llmProviderId: '',
    llmModelId: '',
    ttsProviderId: '',
    ttsModelId: '',
    voice: '',
    language: '',
    sttLanguage: '',
    ttsLanguage: '',
  });

  const session = useVoiceSession();
  const connected = session.state === 'ready';
  /** Between asking for the bill and receiving it. */
  const ending = session.state === 'ending';
  /** Bumped whenever a conversation is filed, so the history list re-reads. */
  const [historyKey, setHistoryKey] = useState(0);
  const [showReport, setShowReport] = useState(true);

  useEffect(() => {
    fetchCatalog()
      .then(({ providers: list }) => {
        setProviders(list);
        // Default to the first wired-up provider of each kind.
        const first = (kind: ProviderEntry['kind']) => list.find((p) => p.kind === kind && p.registered);
        const rt = first('realtime');
        const stt = first('stt');
        const llm = first('llm');
        const tts = first('tts');
        setSelection((s) => ({
          ...s,
          realtimeProviderId: rt?.id ?? '',
          realtimeModelId: rt?.models[0]?.id ?? '',
          sttProviderId: stt?.id ?? '',
          sttModelId: stt?.models[0]?.id ?? '',
          llmProviderId: llm?.id ?? '',
          llmModelId: llm?.models[0]?.id ?? '',
          ttsProviderId: tts?.id ?? '',
          ttsModelId: tts?.models[0]?.id ?? '',
          voice: tts?.voices?.[0]?.id ?? '',
          language: rt?.languages?.[0]?.id ?? '',
          sttLanguage: stt?.languages?.[0]?.id ?? '',
          ttsLanguage: tts?.languages?.[0]?.id ?? '',
        }));
      })
      .catch((err: Error) => setCatalogError(err.message));
  }, []);

  const startConfig = useMemo<StartConfig>(
    () => ({
      mode: selection.mode,
      realtimeProviderId: selection.realtimeProviderId,
      realtimeModelId: selection.realtimeModelId,
      sttProviderId: selection.sttProviderId,
      sttModelId: selection.sttModelId,
      llmProviderId: selection.llmProviderId,
      llmModelId: selection.llmModelId,
      ttsProviderId: selection.ttsProviderId,
      ttsModelId: selection.ttsModelId,
      systemPrompt,
      voice: selection.voice,
      language: selection.language,
      sttLanguage: selection.sttLanguage,
      ttsLanguage: selection.ttsLanguage,
      turnDetection,
    }),
    [selection, systemPrompt, turnDetection],
  );

  const connect = useCallback(() => {
    setShowReport(true);
    void session.connect(startConfig);
  }, [session, startConfig]);

  // A finished conversation is on disk by the time its summary arrives.
  const { summary } = session;
  useEffect(() => {
    if (summary) setHistoryKey((k) => k + 1);
  }, [summary]);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Voice provider bench</h1>
          <p className="muted">
            Same wire protocol, same metrics, swappable providers. Compare latency, audio quality and how human it sounds.
          </p>
        </div>
        <div className="conn">
          <span className={`badge ${session.state}`}>{session.state}</span>
          {session.label && <code>{session.label}</code>}
        </div>
      </header>

      {catalogError && <div className="banner error">Cannot reach the backend: {catalogError}</div>}

      <div className="columns">
        <div className="col">
          <ProviderPicker providers={providers} value={selection} onChange={setSelection} disabled={connected} />

          <section className="panel">
            <h2>Session</h2>
            <div className="button-row">
              {/* The primary slot never swaps its action out from under a
                  second click: while the bill is being fetched it holds a
                  disabled placeholder rather than becoming Connect. */}
              {connected ? (
                <>
                  <button type="button" className="primary" onClick={() => void session.endConversation()}>
                    End conversation
                  </button>
                  <button type="button" onClick={() => void session.disconnect()} title="Drop the session without a report">
                    Disconnect
                  </button>
                </>
              ) : ending ? (
                <button type="button" className="primary" disabled>
                  Ending…
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={connect}
                  // A second click while connecting would open a second socket
                  // whose close handler tears down the first.
                  disabled={providers.length === 0 || session.state === 'connecting'}
                >
                  {session.state === 'connecting' ? 'Connecting…' : 'Connect'}
                </button>
              )}
              <button
                type="button"
                className={session.micOn ? 'active' : ''}
                // Stopping stays available after the socket drops, so a lost
                // connection cannot leave the microphone hot.
                disabled={!connected && !session.micOn}
                onClick={() => (session.micOn ? void session.stopMic() : void session.startMic())}
              >
                {session.micOn ? 'Stop mic' : 'Start mic'}
              </button>
              {turnDetection === 'manual' && (
                <button type="button" disabled={!connected || !session.micOn} onClick={session.commitAudio}>
                  End my turn
                </button>
              )}
              <button type="button" disabled={!connected} onClick={session.interrupt}>
                Interrupt
              </button>
            </div>
            <div className="meter" aria-label="mic level">
              <div className="meter-fill" style={{ width: `${Math.min(100, session.micLevel * 140)}%` }} />
            </div>
          </section>

          <PromptWidget
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            turnDetection={turnDetection}
            onTurnDetectionChange={setTurnDetection}
            onSend={session.sendText}
            canSend={connected}
            locked={connected}
          />
        </div>

        <div className="col">
          {session.summary && showReport && (
            <ErrorBoundary panel="Conversation ended">
              <SessionReport summary={session.summary} onDismiss={() => setShowReport(false)} />
            </ErrorBoundary>
          )}
          <Transcript utterances={session.utterances} speaking={session.assistantSpeaking} />
          <MetricsPanel turns={session.turns} />
          {/* Dismissing the report falls back to the live table rather than
              leaving the column with no cost data at all. */}
          {!(session.summary && showReport) && <UsagePanel usage={session.usage} />}
          <ErrorBoundary panel="Past conversations">
            <PastSessions refreshKey={historyKey} />
          </ErrorBoundary>
          <LogPanel logs={session.logs} />
        </div>
      </div>
    </div>
  );
}
