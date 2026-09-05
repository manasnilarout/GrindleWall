import WebSocket from 'ws';
import type { SttEvents, SttOptions, SttProvider, SttStream } from '../types.js';
import { resamplePcm16 } from '../../audio/pcm.js';

/**
 * Sarvam Saaras realtime STT over WebSocket.
 *
 *   wss://api.sarvam.ai/speech-to-text-realtime/ws?model=saaras:v3-realtime&...
 *   header: API-SUBSCRIPTION-KEY
 *
 * Client sends: {event:'audio_input', audio:<base64 pcm>}
 *               {event:'speech_end'} / {event:'flush'}  (manual endpointing only)
 *               {event:'end'}
 * Server sends: {event:'vad.speech_start'|'vad.speech_end', utterance_idx, confidence}
 *               {event:'transcript.partial'|'transcript.final', text, language?}
 *               {event:'session.begin'|'session.end'} / {event:'error', message, is_fatal}
 *
 * Saaras only accepts 16 kHz or 8 kHz, so canonical 24 kHz audio is downsampled
 * on the way in. Its server-side VAD is what marks the end of the user's turn,
 * which is t0 for every latency number in the bench.
 *
 * The model id may carry a stream_type suffix — `saaras:v3-realtime@fast` — so
 * the latency/accuracy tradeoff is selectable straight from the UI.
 */

const WS_BASE = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';
const SARVAM_SAMPLE_RATE = 16000;
const DEFAULT_LANGUAGE = 'en-IN';
const DEFAULT_MODEL = 'saaras:v3-realtime';
const DEFAULT_STREAM_TYPE = 'fast';

type SarvamSttEvent =
  | { event: 'session.begin'; request_id?: string; config?: Record<string, unknown> }
  | { event: 'vad.speech_start'; utterance_idx?: number }
  | { event: 'vad.speech_end'; utterance_idx?: number }
  | { event: 'transcript.partial'; text?: string; language?: string }
  | { event: 'transcript.final'; text?: string; language?: string }
  | { event: 'session.end' }
  | { event: 'error'; message?: string; code?: string; is_fatal?: boolean }
  | { event: string };

export class SarvamSttProvider implements SttProvider {
  readonly id = 'sarvam-stt';
  readonly name = 'Sarvam Saaras';

  async open(opts: SttOptions, events: SttEvents): Promise<SttStream> {
    const key = opts.credentials.SARVAM_API_KEY;
    if (!key) throw new Error('SARVAM_API_KEY is not set');

    const [model, streamType] = splitModel(opts.model);

    const params = new URLSearchParams({
      model,
      language_code: opts.language || DEFAULT_LANGUAGE,
      mode: 'transcribe',
      stream_type: streamType,
      endpointing: opts.vad ? 'vad' : 'manual',
      encoding: 'linear16',
      sample_rate: String(SARVAM_SAMPLE_RATE),
    });

    const ws = new WebSocket(`${WS_BASE}?${params}`, {
      headers: { 'API-SUBSCRIPTION-KEY': key },
    });

    let ready = false;
    let closed = false;
    /** Audio captured during the handshake, so no leading speech is lost. */
    const pending: string[] = [];

    const send = (msg: unknown) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    };

    ws.on('open', () => {
      if (closed) {
        ws.close();
        return;
      }
      ready = true;
      for (const audio of pending) send({ event: 'audio_input', audio });
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (closed) return;
      let msg: SarvamSttEvent;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // non-JSON frame; nothing actionable
      }

      switch (msg.event) {
        case 'transcript.partial': {
          const text = (msg as { text?: string }).text;
          if (text) events.onPartial(text);
          break;
        }
        case 'transcript.final': {
          const text = (msg as { text?: string }).text;
          // Sarvam emits an empty final for non-speech; PipelineSession ignores those.
          events.onFinal(text ?? '');
          break;
        }
        case 'vad.speech_end':
          // Vendor VAD decided the user stopped talking — this is the latency t0.
          events.onSpeechEnd?.();
          break;
        case 'error': {
          const e = msg as { message?: string; code?: string; is_fatal?: boolean };
          events.onError(new Error(`Sarvam STT ${e.code ?? 'error'}: ${e.message ?? 'unknown'}`));
          if (e.is_fatal) {
            closed = true;
            ws.close();
          }
          break;
        }
        default:
          break; // session.begin / session.end / vad.speech_start / pong
      }
    });

    ws.on('error', (err) => {
      if (closed) return;
      events.onError(new Error(`Sarvam STT socket: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      // 1003 quota, 1008 inactivity, 1011 server, 4000 rejected — worth surfacing.
      if (code !== 1000) {
        events.onError(
          new Error(`Sarvam STT closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        );
      }
    });

    return {
      pushAudio(chunk) {
        if (closed || chunk.length === 0) return;
        const audio = resamplePcm16(chunk, opts.sampleRate, SARVAM_SAMPLE_RATE).toString('base64');
        if (ready) send({ event: 'audio_input', audio });
        else pending.push(audio);
      },
      finalize() {
        if (closed || !ready) return;
        // Only meaningful under manual endpointing; harmless under vad.
        send({ event: 'speech_end' });
        send({ event: 'flush' });
      },
      close() {
        if (closed) return;
        closed = true;
        pending.length = 0;
        if (ws.readyState === WebSocket.OPEN) {
          send({ event: 'end' });
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };
  }
}

/** `saaras:v3-realtime@fast` -> ['saaras:v3-realtime', 'fast'] */
function splitModel(raw: string): [string, string] {
  const at = raw.lastIndexOf('@');
  if (at === -1) return [raw || DEFAULT_MODEL, DEFAULT_STREAM_TYPE];
  return [raw.slice(0, at) || DEFAULT_MODEL, raw.slice(at + 1) || DEFAULT_STREAM_TYPE];
}
