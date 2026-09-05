import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16 } from '../../audio/pcm.js';

/**
 * Cartesia Sonic streaming TTS.
 *
 *   wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14
 *   header: X-API-Key
 *
 * Client sends one JSON message per text chunk, all sharing a context_id:
 *   {model_id, transcript, voice:{mode:'id',id}, output_format, context_id,
 *    language, continue, max_buffer_delay_ms}
 * `continue: true` keeps the context open for more text; a final message with
 * `continue: false` closes it and tells Sonic to stop waiting for more.
 *
 * Server sends {type:'chunk', data:<base64>}, then {type:'done'};
 * also {type:'flush_done'} and {type:'error', title, message, error_code}.
 *
 * We request raw pcm_s16le @ 24 kHz — already the bench's canonical format, so
 * there is no transcoding or resampling.
 */

const VERSION = '2026-08-14';
const CARTESIA_SAMPLE_RATE = 24000;
const DEFAULT_MODEL = 'sonic-3.6';
const DEFAULT_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'; // Skylar

/**
 * How long Sonic may wait for more text before synthesising. This is an audio
 * QUALITY control, not just a latency one, and 0 is a trap here.
 *
 * Measured on one sentence fed word by word (reference: the whole sentence in a
 * single request renders 3.44s of audio):
 *
 *     max_buffer_delay_ms=0     ttfb  88ms   audio 9.20s   <- each word voiced alone
 *     max_buffer_delay_ms=100   ttfb 118ms   audio 3.60s
 *     max_buffer_delay_ms=250   ttfb 110ms   audio 3.52s
 *     default (3000)            ttfb 105ms   audio 3.60s
 *
 * With 0, Sonic renders every token as its own utterance: 2.6x too much audio,
 * word-isolated prosody, and dropped words when transcribed back. Pipecat can
 * afford 0 because it aggregates text into sentences upstream; this pipeline
 * streams raw LLM tokens, so Sonic has to do the aggregating. 250ms buys correct
 * prosody for roughly 20ms of TTFB.
 */
const MAX_BUFFER_DELAY_MS = 250;

interface CartesiaMessage {
  type: 'chunk' | 'done' | 'error' | 'flush_done' | 'timestamps' | string;
  data?: string;
  done?: boolean;
  title?: string;
  message?: string;
  error_code?: string;
}

export class CartesiaTtsProvider implements TtsProvider {
  readonly id = 'cartesia-tts';
  readonly name = 'Cartesia Sonic';

  /** Resolves immediately; the socket connects in the background and text queues. */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.CARTESIA_API_KEY;
    if (!key) throw new Error('CARTESIA_API_KEY is not set');

    const model = opts.model || DEFAULT_MODEL;
    const voice = opts.voice || DEFAULT_VOICE;
    const language = (opts.language || 'en').split('-')[0]; // Cartesia wants ISO-639-1
    const contextId = randomUUID();

    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, {
      headers: { 'X-API-Key': key, 'Cartesia-Version': VERSION },
    });

    let ready = false;
    let cancelled = false;
    let flushed = false;
    let done = false;
    const pending: Array<{ text: string; last: boolean }> = [];

    const finish = () => {
      if (done) return;
      done = true;
      events.onDone();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    const emit = (text: string, last: boolean) => {
      if (cancelled || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          model_id: model,
          transcript: text,
          voice: { mode: 'id', id: voice },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: CARTESIA_SAMPLE_RATE },
          context_id: contextId,
          language,
          max_buffer_delay_ms: MAX_BUFFER_DELAY_MS,
          continue: !last,
        }),
      );
    };

    ws.on('open', () => {
      if (cancelled) {
        ws.close();
        return;
      }
      ready = true;
      for (const item of pending) emit(item.text, item.last);
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (cancelled) return;
      let msg: CartesiaMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'chunk': {
          if (!msg.data) return;
          const pcm = Buffer.from(msg.data, 'base64');
          if (pcm.length === 0) return;
          // No-op at 24 kHz; a guard in case the vendor ignores the request.
          events.onAudio(resamplePcm16(pcm, CARTESIA_SAMPLE_RATE, opts.sampleRate));
          break;
        }
        case 'done':
          finish();
          break;
        case 'error':
          events.onError(
            new Error(`Cartesia TTS ${msg.error_code ?? 'error'}: ${msg.message ?? msg.title ?? 'unknown'}`),
          );
          finish();
          break;
        default:
          break; // flush_done, timestamps
      }
    });

    ws.on('error', (err) => {
      if (cancelled) return;
      events.onError(new Error(`Cartesia TTS socket: ${err.message}`));
      finish();
    });

    ws.on('close', (code, reason) => {
      if (cancelled || done) return;
      if (!flushed) {
        events.onError(
          new Error(`Cartesia TTS closed early (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        );
      }
      finish();
    });

    return {
      pushText(text) {
        if (cancelled || flushed || !text) return;
        if (ready) emit(text, false);
        else pending.push({ text, last: false });
      },
      flush() {
        if (cancelled || flushed) return;
        flushed = true;
        // Empty transcript with continue:false closes the context.
        if (ready) emit('', true);
        else pending.push({ text: '', last: true });
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
