import WebSocket from 'ws';
import type { SttEvents, SttOptions, SttProvider, SttStream } from '../types.js';
import { SpeechEndDetector } from '../../audio/vad.js';

/**
 * Cartesia Ink streaming STT.
 *
 *   wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_s16le
 *       &sample_rate=24000&cartesia_version=2026-08-14&language=en
 *   header: X-API-Key
 *
 * Audio goes up as raw BINARY frames (no base64), at 24 kHz — the bench's
 * canonical rate — so nothing is resampled on this leg either.
 *
 * Two protocol details this adapter exists to paper over:
 *
 * 1. Cartesia emits MANY `is_final: true` messages per utterance — one per word
 *    or phrase, meant to be concatenated ("Our" / "refund" / "window is" ...).
 *    Sarvam, by contrast, sends one final per whole turn. Forwarding each of
 *    Cartesia's as a finished turn would fire one LLM call per word, so
 *    segments are accumulated and surfaced as partials instead.
 *
 * 2. There is no server-side speech-end event. A local energy VAD supplies one,
 *    which both marks t0 for the latency metrics and triggers `finalize` —
 *    rather than waiting on Cartesia's own silence timer.
 *
 * Control frames are RAW TEXT, not JSON: `finalize` flushes and is acked with
 * `flush_done`; `close` ends the session and is acked with `done`.
 */

const VERSION = '2026-08-14';
const DEFAULT_MODEL = 'ink-2';

interface CartesiaSttMessage {
  type: 'transcript' | 'flush_done' | 'done' | 'error' | string;
  text?: string;
  is_final?: boolean;
  message?: string;
  title?: string;
  error_code?: string;
}

export class CartesiaSttProvider implements SttProvider {
  readonly id = 'cartesia-stt';
  readonly name = 'Cartesia Ink';

  async open(opts: SttOptions, events: SttEvents): Promise<SttStream> {
    const key = opts.credentials.CARTESIA_API_KEY;
    if (!key) throw new Error('CARTESIA_API_KEY is not set');

    const model = opts.model || DEFAULT_MODEL;
    const params = new URLSearchParams({
      model,
      encoding: 'pcm_s16le',
      sample_rate: String(opts.sampleRate),
      cartesia_version: VERSION,
      language: (opts.language || 'en').split('-')[0],
    });

    const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${params}`, {
      headers: { 'X-API-Key': key, 'Cartesia-Version': VERSION },
    });

    const vad = new SpeechEndDetector();
    let ready = false;
    let closed = false;
    let awaitingFlush = false;
    /** Accumulated is_final segments for the current utterance. */
    let segments = '';
    const pending: Buffer[] = [];

    const sendControl = (cmd: 'finalize' | 'close') => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(cmd); // raw text, deliberately not JSON
    };

    const endTurn = () => {
      if (closed || awaitingFlush) return;
      awaitingFlush = true;
      events.onSpeechEnd?.();
      sendControl('finalize');
    };

    ws.on('open', () => {
      if (closed) {
        ws.close();
        return;
      }
      ready = true;
      for (const buf of pending) ws.send(buf, { binary: true });
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (closed) return;
      let msg: CartesiaSttMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'transcript': {
          const text = msg.text ?? '';
          if (!text.trim()) return; // ink-whisper emits empty finals
          if (msg.is_final) {
            segments += text;
            // A finished segment, not a finished turn — show it as it lands.
            events.onPartial(segments.trim());
          } else {
            events.onPartial(`${segments}${text}`.trim());
          }
          break;
        }
        case 'flush_done': {
          // The real utterance boundary.
          const full = segments.trim();
          segments = '';
          awaitingFlush = false;
          vad.reset();
          events.onFinal(full);
          break;
        }
        case 'error':
          events.onError(
            new Error(`Cartesia STT ${msg.error_code ?? 'error'}: ${msg.message ?? msg.title ?? 'unknown'}`),
          );
          break;
        default:
          break; // done
      }
    });

    ws.on('error', (err) => {
      if (closed) return;
      events.onError(new Error(`Cartesia STT socket: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      if (code !== 1000) {
        events.onError(
          new Error(`Cartesia STT closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        );
      }
    });

    return {
      pushAudio(chunk) {
        if (closed || chunk.length === 0) return;
        if (ready) ws.send(chunk, { binary: true });
        else pending.push(chunk);

        // Local VAD stands in for the speech-end event Cartesia does not send.
        if (opts.vad && vad.push(chunk, opts.sampleRate) === 'end') endTurn();
      },
      finalize() {
        endTurn();
      },
      close() {
        if (closed) return;
        closed = true;
        pending.length = 0;
        if (ws.readyState === WebSocket.OPEN) {
          sendControl('close');
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };
  }
}
