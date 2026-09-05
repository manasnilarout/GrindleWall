import { useCallback, useEffect, useRef, useState } from 'react';
import type { DerivedMetrics, MetricMark, ServerMessage, SessionSummary, StartConfig, TurnUsage } from '../lib/protocol';
import { MicRecorder } from '../audio/recorder';
import { AudioSink } from '../audio/player';

/** 'ending' is the window between asking for the bill and the summary arriving. */
export type ConnState = 'idle' | 'connecting' | 'ready' | 'ending' | 'error' | 'closed' | 'ended';

export interface TurnRecord {
  turnId: number;
  marks: MetricMark[];
  derived: DerivedMetrics;
  /** Measured in the browser: speech end -> first sample actually audible. */
  clientTtfaMs?: number;
  label: string;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Utterance {
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/session`;

/** How long to wait for a summary before letting the user move on. */
const END_TIMEOUT_MS = 8000;

/**
 * Closes a socket and silences it. Closing alone is not enough: the handlers
 * still fire afterwards and would report on a session that has been replaced.
 */
function detach(ws: WebSocket | null): void {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  ws.close();
}

export function useVoiceSession() {
  const [state, setState] = useState<ConnState>('idle');
  const [label, setLabel] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [usage, setUsage] = useState<TurnUsage[]>([]);
  /** Set once the conversation is formally ended, and kept so the report stays readable. */
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [micLevel, setMicLevel] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<MicRecorder | null>(null);
  const sinkRef = useRef<AudioSink | null>(null);
  const labelRef = useRef('');
  const pendingTtfaRef = useRef<number | null>(null);
  /** Client-measured TTFA for the in-flight turn, consumed by the next metrics frame. */
  const lastClientTtfa = useRef<number | null>(null);

  const log = useCallback((level: LogLine['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), { at: Date.now(), level, message }]);
  }, []);

  const pushUtterance = useCallback((role: 'user' | 'assistant', text: string, final: boolean) => {
    setUtterances((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && !last.final) {
        return [...prev.slice(0, -1), { role, text, final }];
      }
      return [...prev, { role, text, final }];
    });
  }, []);

  const stopMic = useCallback(async () => {
    await recRef.current?.stop();
    recRef.current = null;
    setMicOn(false);
    setMicLevel(0);
  }, []);

  const connect = useCallback(
    async (config: StartConfig) => {
      // Detach before closing: a stale socket's onclose would otherwise fire a
      // tick later and overwrite the state of the session replacing it.
      detach(wsRef.current);
      wsRef.current = null;
      setState('connecting');
      setUtterances([]);
      setTurns([]);
      setUsage([]);
      setSummary(null);
      setLogs([]);

      const sink = sinkRef.current ?? new AudioSink();
      sinkRef.current = sink;
      try {
        await sink.resume();
      } catch (err) {
        // Without this the state stays on 'connecting' forever with no socket,
        // no log line, and an unhandled rejection in the console.
        log('error', `audio output unavailable: ${(err as Error).message}`);
        setState('error');
        return;
      }
      // Metrics always arrive at turn end, i.e. after the first sample is audible,
      // so stashing here and consuming on the metrics frame is race-free.
      sink.onFirstAudible = () => {
        if (pendingTtfaRef.current === null) return;
        lastClientTtfa.current = Math.round(performance.now() - pendingTtfaRef.current);
        pendingTtfaRef.current = null;
      };

      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      /** Guards every state update: this socket may have been superseded. */
      const current = () => wsRef.current === ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', config }));

      ws.onmessage = (ev) => {
        if (!current()) return;
        if (ev.data instanceof ArrayBuffer) {
          sink.enqueue(ev.data);
          return;
        }
        const msg: ServerMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case 'session_started':
            setState('ready');
            setLabel(msg.label);
            labelRef.current = msg.label;
            log('info', `session ${msg.sessionId} · ${msg.mode} · ${msg.label}`);
            break;
          case 'transcript':
            pushUtterance(msg.role, msg.text, msg.final);
            if (msg.role === 'user' && msg.final) {
              pendingTtfaRef.current = performance.now();
              sink.expectTurn();
            }
            break;
          case 'turn_start':
            setAssistantSpeaking(true);
            break;
          case 'turn_end':
            setAssistantSpeaking(false);
            break;
          case 'metrics':
            setTurns((prev) => [
              ...prev,
              {
                turnId: msg.turnId,
                marks: msg.marks,
                derived: msg.derived,
                clientTtfaMs: lastClientTtfa.current ?? undefined,
                label: labelRef.current,
              },
            ]);
            lastClientTtfa.current = null;
            break;
          case 'usage':
            setUsage((prev) => [...prev, msg.usage]);
            break;
          case 'session_summary':
            setSummary(msg.summary);
            break;
          case 'log':
            log(msg.level, msg.message);
            break;
          case 'error':
            log('error', msg.message);
            setState('error');
            break;
          case 'session_closed':
            // The summary always precedes this frame, so the socket has served
            // its purpose and is closed here rather than left dangling.
            setState(msg.reason === 'ended' ? 'ended' : 'closed');
            detach(ws);
            if (wsRef.current === ws) wsRef.current = null;
            break;
        }
      };

      ws.onerror = () => {
        if (!current()) return;
        log('error', 'WebSocket error — is the backend running on :8787?');
        setState('error');
        // The session is gone; leaving the mic hot would keep the browser's
        // recording indicator lit with nowhere for the audio to go.
        void stopMic();
      };
      ws.onclose = () => {
        if (!current()) return;
        setState((prev) => (prev === 'error' || prev === 'ended' ? prev : 'closed'));
        void stopMic();
      };
    },
    [log, pushUtterance, stopMic],
  );

  const startMic = useCallback(async () => {
    if (recRef.current) return;
    const rec = new MicRecorder();
    recRef.current = rec;
    try {
      await rec.start({
        onFrame: (pcm) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        onLevel: setMicLevel,
      });
      setMicOn(true);
      log('info', `mic open @ ${rec.sampleRate}Hz`);
    } catch (err) {
      recRef.current = null;
      log('error', `mic denied: ${(err as Error).message}`);
    }
  }, [log]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendText = useCallback(
    (text: string) => {
      pendingTtfaRef.current = performance.now();
      sinkRef.current?.expectTurn();
      send({ type: 'user_text', text });
    },
    [send],
  );

  const commitAudio = useCallback(() => {
    pendingTtfaRef.current = performance.now();
    sinkRef.current?.expectTurn();
    send({ type: 'commit_audio' });
  }, [send]);

  const interrupt = useCallback(() => {
    sinkRef.current?.flush();
    setAssistantSpeaking(false);
    send({ type: 'interrupt' });
  }, [send]);

  /**
   * Ends the conversation and asks for the bill. The socket is deliberately left
   * open until the summary arrives — closing it first would mean the server had
   * nowhere to send the report it just computed.
   */
  const endConversation = useCallback(async () => {
    // 'ending' rather than 'ended': the bill has been asked for, not received.
    // It also keeps the button row from swapping Connect into the slot the user
    // is still clicking.
    setState((prev) => (prev === 'ready' ? 'ending' : prev));
    send({ type: 'end_conversation' });
    await stopMic();
    sinkRef.current?.flush();
    // Don't strand the user in 'ending' if the backend dies mid-report.
    window.setTimeout(() => {
      setState((prev) => {
        if (prev !== 'ending') return prev;
        log('warn', 'No summary came back — the conversation is still saved server-side.');
        return 'closed';
      });
    }, END_TIMEOUT_MS);
  }, [send, stopMic, log]);

  /** Hard drop: no summary requested, no report. */
  const disconnect = useCallback(async () => {
    send({ type: 'stop' });
    await stopMic();
    sinkRef.current?.flush();
    detach(wsRef.current);
    wsRef.current = null;
    setState('idle');
    setLabel('');
  }, [send, stopMic]);

  useEffect(
    () => () => {
      detach(wsRef.current);
      void recRef.current?.stop();
      void sinkRef.current?.close();
    },
    [],
  );

  return {
    state,
    label,
    micOn,
    micLevel,
    assistantSpeaking,
    utterances,
    turns,
    usage,
    summary,
    logs,
    connect,
    disconnect,
    endConversation,
    startMic,
    stopMic,
    sendText,
    commitAudio,
    interrupt,
  };
}
