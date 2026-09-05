import WebSocket from 'ws';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';

/**
 * Sarvam Bulbul streaming TTS over WebSocket.
 *
 *   wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true
 *   header: api-subscription-key
 *
 * Client sends:  {type:'config', data:{...}} then {type:'text', data:{text}}* then {type:'flush'}
 * Server sends:  {type:'audio', data:{audio:<base64>, content_type}}
 *                {type:'event', data:{event_type:'final'}}
 *                {type:'error', data:{message, code}}
 *
 * We ask for `linear16` @ 24 kHz, which is already our canonical format, so in
 * the normal case there is no transcoding or resampling at all.
 */

const WS_BASE = 'wss://api.sarvam.ai/text-to-speech/ws';
const SARVAM_SAMPLE_RATE = 24000;
const DEFAULT_LANGUAGE = 'en-IN';
const DEFAULT_SPEAKER = 'shubh';

/** Lower = lower time-to-first-byte, at the cost of slightly choppier prosody. */
const MIN_BUFFER_SIZE = 50;
const MAX_CHUNK_LENGTH = 200;

interface SarvamAudioMessage {
  type: 'audio';
  data: { audio: string; content_type?: string; request_id?: string };
}
interface SarvamEventMessage {
  type: 'event';
  data: { event_type: string; message?: string };
}
interface SarvamErrorMessage {
  type: 'error';
  data: { message: string; code?: number };
}
type SarvamMessage = SarvamAudioMessage | SarvamEventMessage | SarvamErrorMessage | { type: string; data?: unknown };

export class SarvamTtsProvider implements TtsProvider {
  readonly id = 'sarvam-tts';
  readonly name = 'Sarvam Bulbul';

  /**
   * Resolves immediately — the socket connects in the background and text is
   * queued until the handshake completes. This keeps connection setup inside
   * the measured TTS latency instead of hiding it before the clock starts.
   */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.SARVAM_API_KEY;
    if (!key) throw new Error('SARVAM_API_KEY is not set');

    const model = opts.model || 'bulbul:v3';
    const url = `${WS_BASE}?model=${encodeURIComponent(model)}&send_completion_event=true`;

    const ws = new WebSocket(url, { headers: { 'api-subscription-key': key } });

    let ready = false;
    let cancelled = false;
    let flushed = false;
    let done = false;
    /** Text (and the flush marker) buffered until the socket is open. */
    const pending: Array<{ kind: 'text'; text: string } | { kind: 'flush' }> = [];

    const finish = () => {
      if (done) return;
      done = true;
      events.onDone();
      // The utterance is over; nothing is reused across turns.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    const send = (msg: unknown) => {
      if (cancelled || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    };

    ws.on('open', () => {
      if (cancelled) {
        ws.close();
        return;
      }
      // v2-only knobs (pitch/loudness/enable_preprocessing) are deliberately
      // omitted; v3 rejects some of them and defaults are fine for a bench.
      send({
        type: 'config',
        data: {
          // The API reference calls this `language_code`; Sarvam's own SDK and
          // Pipecat send `target_language_code`. Sending both is harmless and
          // works against either revision of the endpoint.
          language_code: opts.language || DEFAULT_LANGUAGE,
          target_language_code: opts.language || DEFAULT_LANGUAGE,
          speaker: opts.voice || DEFAULT_SPEAKER,
          model,
          speech_sample_rate: String(SARVAM_SAMPLE_RATE),
          output_audio_codec: 'linear16',
          min_buffer_size: MIN_BUFFER_SIZE,
          max_chunk_length: MAX_CHUNK_LENGTH,
        },
      });

      ready = true;
      for (const item of pending) {
        if (item.kind === 'text') send({ type: 'text', data: { text: item.text } });
        else send({ type: 'flush' });
      }
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (cancelled) return;
      let msg: SarvamMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        events.onError(new Error('Sarvam sent a non-JSON frame'));
        return;
      }

      switch (msg.type) {
        case 'audio': {
          const b64 = (msg as SarvamAudioMessage).data?.audio;
          if (!b64) return;
          let pcm: Buffer = Buffer.from(b64, 'base64');
          pcm = stripWavHeader(pcm);
          if (pcm.length === 0) return;
          // No-op when the vendor honours our 24 kHz request; a guard, not a cost.
          events.onAudio(resamplePcm16(pcm, SARVAM_SAMPLE_RATE, opts.sampleRate));
          break;
        }
        case 'event': {
          const evt = (msg as SarvamEventMessage).data?.event_type;
          if (evt === 'final') finish();
          break;
        }
        case 'error': {
          const data = (msg as SarvamErrorMessage).data;
          events.onError(new Error(`Sarvam TTS error${data?.code ? ` ${data.code}` : ''}: ${data?.message ?? 'unknown'}`));
          finish();
          break;
        }
        default:
          break; // pong and anything newer than this integration
      }
    });

    ws.on('error', (err) => {
      if (cancelled) return;
      events.onError(new Error(`Sarvam TTS socket: ${err.message}`));
      finish();
    });

    ws.on('close', (code, reason) => {
      if (cancelled || done) return;
      // Closing after a flush without a `final` event still ends the utterance.
      if (!flushed) {
        events.onError(new Error(`Sarvam TTS closed early (${code}${reason.length ? `: ${reason.toString()}` : ''})`));
      }
      finish();
    });

    return {
      pushText(text) {
        if (cancelled || flushed || !text) return;
        if (ready) send({ type: 'text', data: { text } });
        else pending.push({ kind: 'text', text });
      },
      flush() {
        if (cancelled || flushed) return;
        flushed = true;
        if (ready) send({ type: 'flush' });
        else pending.push({ kind: 'flush' });
      },
      cancel() {
        cancelled = true;
        done = true;
        pending.length = 0;
        ws.close();
      },
      close() {
        cancelled = true;
        done = true;
        pending.length = 0;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  }
}
