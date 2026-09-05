import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { CANONICAL_SAMPLE_RATE, type ClientMessage, type ServerMessage } from '../shared/protocol.js';
import { createSession, ProviderError } from '../providers/factory.js';
import type { SessionEvents, VoiceSession } from '../providers/types.js';
import { credentials, config, redactSecrets } from '../config.js';
import { UsageLedger } from '../pricing/UsageLedger.js';
import { sessionStore } from '../store/SessionStore.js';

/**
 * One WebSocket == one voice session. Text frames are JSON control messages,
 * binary frames are raw PCM16 in both directions.
 */
export function handleSocket(ws: WebSocket): void {
  const socketId = randomUUID().slice(0, 8);
  let session: VoiceSession | undefined;
  let ledger: UsageLedger | undefined;
  let audioBytesIn = 0;

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendAudio = (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  };

  /**
   * Persisted after every turn, not just at the end, so a conversation that is
   * never formally ended — closed tab, lost connection, crash — still leaves its
   * token counts on disk.
   */
  const persist = () => {
    if (!ledger || ledger.turnCount === 0) return;
    void sessionStore.save(ledger.summary()).catch((err) => {
      console.error(`[${socketId}] failed to persist session:`, err);
    });
  };

  const events: SessionEvents = {
    onUserTranscript: (text, final, turnId) => send({ type: 'transcript', role: 'user', text, final, turnId }),
    onAssistantTranscript: (text, final, turnId) =>
      send({ type: 'transcript', role: 'assistant', text, final, turnId }),
    onAudio: (chunk) => sendAudio(chunk),
    onTurnStart: (turnId) => send({ type: 'turn_start', turnId }),
    onTurnEnd: (turnId) => send({ type: 'turn_end', turnId }),
    onMetrics: (turnId, marks, derived) => {
      // Banks the whole breakdown, TTFA included — not just TTFA, so a record
      // read back later can still say which leg was slow.
      ledger?.noteLatency(derived);
      send({ type: 'metrics', turnId, marks, derived });
    },
    onUsage: (turnId, legs) => {
      if (!ledger) {
        // A provider that drains asynchronously can report after the ledger is
        // gone. Nothing can be billed at that point, but it must not vanish.
        console.warn(`[${socketId}] usage for turn ${turnId} arrived after the conversation was closed out`);
        return;
      }
      send({ type: 'usage', turnId, usage: ledger.record(turnId, legs) });
      persist();
    },
    onLog: (level, message) => {
      console.log(`[${socketId}] ${level}: ${message}`);
      send({ type: 'log', level, message: redactSecrets(message) });
    },
    onError: (err) => {
      console.error(`[${socketId}] session error:`, err);
      send({ type: 'error', message: redactSecrets(err.message) });
    },
  };

  /**
   * Closes the providers, bills the conversation, files it, and reports back.
   * `notifyClosed` is false when another session is about to take its place —
   * the client still gets the report, but not a closure it did not ask for.
   */
  const finalize = async (reason: string, notifyClosed: boolean) => {
    await session?.close();
    session = undefined;
    if (ledger) {
      const summary = ledger.summary();
      if (summary.turnCount > 0) {
        await sessionStore.save(summary).catch((err: Error) => {
          console.error(`[${socketId}] could not file the conversation:`, err.message);
          send({ type: 'log', level: 'warn', message: `Conversation was not saved: ${err.message}` });
        });
      }
      send({ type: 'session_summary', summary });
      ledger = undefined;
    }
    if (notifyClosed) send({ type: 'session_closed', reason });
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      audioBytesIn += buf.length;
      if (config.logAudio && audioBytesIn % (CANONICAL_SAMPLE_RATE * 2) < buf.length) {
        console.log(`[${socketId}] mic ${(audioBytesIn / 2 / CANONICAL_SAMPLE_RATE).toFixed(1)}s`);
      }
      session?.pushAudio(buf);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send({ type: 'error', message: 'Malformed control message' });
      return;
    }

    switch (msg.type) {
      case 'start': {
        // Starting again over a live session ends the old conversation properly
        // rather than abandoning it: it is already on disk, but without this the
        // client never receives its report and its endedAt stays at the last turn.
        if (session || ledger) await finalize('replaced', false);
        try {
          session = createSession({
            sessionId: socketId,
            config: msg.config,
            events,
            credentials: credentials(),
          });
          ledger = new UsageLedger(socketId, session.mode, session.label, msg.config);
          await session.start();
          send({
            type: 'session_started',
            sessionId: session.id,
            mode: session.mode,
            sampleRate: CANONICAL_SAMPLE_RATE,
            label: session.label,
          });
        } catch (err) {
          session = undefined;
          ledger = undefined;
          const message = err instanceof ProviderError ? err.message : `Failed to start session: ${(err as Error).message}`;
          console.error(`[${socketId}] start failed:`, err);
          send({ type: 'error', message: redactSecrets(message) });
        }
        break;
      }
      case 'user_text':
        session?.sendText(msg.text);
        break;
      case 'commit_audio':
        session?.commitAudio();
        break;
      case 'interrupt':
        session?.interrupt();
        break;
      case 'end_conversation':
        await finalize('ended', true);
        break;
      case 'stop':
        await session?.close();
        session = undefined;
        persist();
        ledger = undefined;
        send({ type: 'session_closed' });
        break;
    }
  });

  ws.on('close', async () => {
    await session?.close();
    session = undefined;
    // The socket is gone, so the summary cannot be delivered — but it is still filed.
    persist();
    ledger = undefined;
    console.log(`[${socketId}] socket closed`);
  });

  ws.on('error', (err) => console.error(`[${socketId}] socket error:`, err));
}
