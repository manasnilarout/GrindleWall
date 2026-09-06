import { useCallback, useEffect, useRef, useState } from 'react';
import type { DerivedMetrics, MetricMark, ServerMessage, SessionSummary, StartConfig, TurnUsage } from '../lib/protocol';
import { MicRecorder } from '../audio/recorder';
import { AudioSink } from '../audio/player';
import { MARK_NOTE, sourceOfMark, sourceOfMessage, type LogSource } from '../lib/logsource';
import { clearSession, sessionWsUrl } from '../lib/auth';

/** 'ending' is the window between asking for the bill and the summary arriving. */
export type ConnState = 'idle' | 'connecting' | 'ready' | 'ending' | 'error' | 'closed' | 'ended';

export interface TurnRecord {
  turnId: number;
  marks: MetricMark[];
  derived: DerivedMetrics;
  /**
   * Measured in the browser: **final user transcript received here** → first
   * sample actually audible.
   *
   * NOT time-to-first-audio, and not comparable with `derived.timeToFirstAudioMs`.
   * The page cannot see t0 — `user_speech_end` is the server's mark and only
   * reaches the browser at turn end, inside the metrics frame — so the clock
   * starts at the last event the page can observe, which is already after STT
   * finished and after that frame crossed the network. It excludes STT latency
   * and includes both network hops.
   *
   * It is still the only number with a person's ear at the end of it, which is
   * why it is kept; it just is not the same measurement as TTFA, so nothing
   * subtracts one from the other.
   */
  clientTtfaMs?: number;
  label: string;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /**
   * Derived for ordinary log lines (see `sourceOfMessage`), read straight off
   * the name for marks. Only ever used to colour and filter — nothing depends
   * on it being right.
   */
  source: LogSource;
  /**
   * 'mark' lines are metric marks the server already sent in a `metrics` frame,
   * re-emitted into the console so a latency number can be read next to the
   * events that produced it. They are the same measurements, not a second
   * source of truth.
   */
  kind: 'log' | 'mark';
  turnId?: number;
  /** ms since this turn's t0. Marks only. */
  atMs?: number;
  /** Longer explanation, revealed when the line is expanded. */
  detail?: string;
}

export interface Utterance {
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

/**
 * Resolved on connect rather than at module load. A browser global read while
 * the module is being evaluated makes the whole file unimportable outside a
 * browser, which takes `render-check` — the only thing in this project that
 * actually proves a component renders — down with it. The session token is
 * appended here so a gated backend can authorize the upgrade.
 */
const wsUrl = (): string => sessionWsUrl();

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

/**
 * Whether a stashed client-measured TTFA belongs to the turn now reporting.
 *
 * Exported because it is the rule that keeps one turn's measurement off another
 * turn's row, and a rule that cannot be called from a test is a rule nothing
 * checks. The stash is tagged when it is written; `currentToken` is whatever
 * turn the audio sink is awaiting at the moment metrics arrive. They match only
 * for a turn whose audio actually became audible before its metrics landed —
 * which is exactly the condition under which the number means anything.
 */
export function claimTtfa(stash: { token: number; ms: number } | null, currentToken: number): number | undefined {
  return stash && stash.token === currentToken ? stash.ms : undefined;
}

export function useVoiceSession() {
  const [state, setState] = useState<ConnState>('idle');
  const [label, setLabel] = useState('');
  const [sessionId, setSessionId] = useState('');
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
  /**
   * Client-measured TTFA waiting for its metrics frame, tagged with the turn it
   * was measured for. The tag is checked on consumption: an untagged stash used
   * to be handed to whichever turn reported next, so a turn whose audio was
   * interrupted — or whose metrics simply beat the jitter-buffer timer — could
   * donate its number to the following turn, which then rendered a client TTFA
   * and a derived network band for a measurement that was not its own.
   */
  const lastClientTtfa = useRef<{ token: number; ms: number } | null>(null);

  /** The config this session was started with, so log lines can be attributed. */
  const configRef = useRef<StartConfig | undefined>(undefined);

  const push = useCallback((lines: LogLine[]) => {
    // The cap is on the buffer, not the view: 600 lines is a couple of minutes
    // of a chatty pipeline, and dropping older ones keeps a long session from
    // growing without bound.
    setLogs((prev) => [...prev, ...lines].slice(-600));
  }, []);

  const log = useCallback(
    (level: LogLine['level'], message: string) => {
      push([
        {
          at: Date.now(),
          level,
          message,
          kind: 'log',
          source: sourceOfMessage(message, configRef.current),
        },
      ]);
    },
    [push],
  );

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
      configRef.current = config;
      // Left over from a previous session these would be credited to turn 1.
      pendingTtfaRef.current = null;
      lastClientTtfa.current = null;

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
      sink.onFirstAudible = (token) => {
        if (pendingTtfaRef.current === null) return;
        lastClientTtfa.current = { token, ms: Math.round(performance.now() - pendingTtfaRef.current) };
        pendingTtfaRef.current = null;
      };

      const ws = new WebSocket(wsUrl());
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
            setSessionId(msg.sessionId);
            setLabel(msg.label);
            labelRef.current = msg.label;
            /*
             * Re-arm recording if the mic is ALREADY open. `startMic` sends this
             * too, but it is not the only way a session begins with a hot mic: a
             * server `error` frame leaves the socket up and the mic running while
             * the UI offers Connect again, so the next conversation would stream
             * to a recorder that was never armed and be lost in silence. Each
             * session gets a fresh recorder server-side, so arming is per session,
             * not per mic click. `recRef` rather than `micOn` — this closure
             * captures state from the render that created it. `start()` is
             * idempotent, so an extra one costs nothing.
             */
            if (recRef.current && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'start_recording' }));
            }
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
            // The marks were already measured and already on this frame. Fanning
            // them into the console costs nothing and turns "612 ms" into
            // something you can read the derivation of.
            push(
              [...msg.marks]
                .sort((a, b) => a.atMs - b.atMs)
                .map((mark) => ({
                  at: Date.now(),
                  level: 'info' as const,
                  message: mark.name,
                  kind: 'mark' as const,
                  source: sourceOfMark(mark.name),
                  turnId: msg.turnId,
                  atMs: mark.atMs,
                  detail: MARK_NOTE[mark.name],
                })),
            );
            setTurns((prev) => [
              ...prev,
              {
                turnId: msg.turnId,
                marks: msg.marks,
                derived: msg.derived,
                // Only the turn still being awaited may claim the stash.
                clientTtfaMs: claimTtfa(lastClientTtfa.current, sink.currentToken),
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
      ws.onclose = (ev) => {
        if (!current()) return;
        if (ev.code === 4401) {
          // The upgrade was rejected (or the in-memory book was wiped by a
          // restart). Kick the UI rather than leaving a "is the backend up?"
          // error on a socket that is working and just unauthorized.
          clearSession();
          window.dispatchEvent(new Event('auth:expired'));
          log('error', 'session expired — sign in again');
        }
        setState((prev) => (prev === 'error' || prev === 'ended' ? prev : 'closed'));
        void stopMic();
      };
    },
    [log, push, pushUtterance, stopMic],
  );

  const startMic = useCallback(async () => {
    if (recRef.current) return;
    const rec = new MicRecorder();
    recRef.current = rec;
    try {
      /*
       * Armed BEFORE the mic opens, not after. Frames start flowing the moment
       * `rec.start()` resolves, and the socket delivers in order — so sending
       * this afterwards means the first frames reach a server that is not yet
       * recording, and the opening word of the conversation is missing from the
       * file. Arming early costs nothing if the mic is then denied: a recorder
       * that never receives audio writes no file.
       *
       * Sent inline rather than through `send`, which is declared below this
       * hook. There is no matching stop on "Stop mic" — recording spans the
       * whole conversation and ends with it.
       */
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_recording' }));
      // Not silent: the mic is about to go hot either way, and audio that is
      // streamed but not recorded is exactly the failure worth naming.
      else log('warn', 'mic opened before the session was up — this turn is not being recorded');
      await rec.start({
        onFrame: (pcm) => {
          const sock = wsRef.current;
          if (sock?.readyState === WebSocket.OPEN) sock.send(pcm);
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
    sessionId,
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
