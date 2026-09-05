import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';

/**
 * Murf Falcon 2 streaming TTS.
 *
 *   wss://global.api.murf.ai/v1/speech/stream-input
 *       ?model=falcon-2&sample_rate=24000&channel_type=MONO&format=PCM
 *   header: api-key
 *
 * Client sends {voice_config:{...}} first, then {text, end} messages.
 * Server sends {audio:<base64>, final:boolean} and an error object on failure.
 *
 * Murf is TTS only — there is no Murf STT to pair this with.
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED SHAPES
 * ---------------------------------------------------------------------------
 * This provider was written without an API key, and Murf's own docs disagree
 * with shipped third-party integrations on three details. The values below are
 * the ones from Murf's official WebSocket docs; the alternates are what other
 * clients send. `npm run murf:probe` tries every permutation against the live
 * API and prints which one works, so this is a one-line fix rather than a hunt.
 *
 *   voice_config key   voiceId          (alt: voice_id)
 *   model              falcon-2         (alt: FALCON, Falcon)
 *   auth               api-key header   (alt: api-key / api_key query param)
 */

const DEFAULT_WS_BASE = 'wss://global.api.murf.ai/v1/speech/stream-input';
const MURF_SAMPLE_RATE = 24000;
const DEFAULT_MODEL = 'falcon-2';
const DEFAULT_VOICE = 'en-US-natalie';
const DEFAULT_STYLE = 'Conversational';

/** Murf's voiceId already encodes the locale, so a UI language maps to a tag. */
const VOICE_CONFIG_KEY: 'voiceId' | 'voice_id' = 'voiceId';

/**
 * Murf exposes the same text-buffering controls as Cartesia, where setting the
 * delay to 0 made Sonic voice every token as its own utterance (2.6x too much
 * audio, mangled prosody). The same risk applies here, so the delay is left at
 * the server default and only a small word-count floor is set. Confirm with
 * `npm run murf:probe`, which reports rendered audio duration per setting.
 */
const MIN_BUFFER_SIZE = 5;

interface MurfMessage {
  audio?: string;
  final?: boolean;
  context_id?: string;
  error?: string | { message?: string; code?: string };
  message?: string;
  errorCode?: string;
}

export class MurfTtsProvider implements TtsProvider {
  readonly id = 'murf-tts';
  readonly name = 'Murf Falcon';

  /** Resolves immediately; the socket connects in the background and text queues. */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.MURF_API_KEY;
    if (!key) throw new Error('MURF_API_KEY is not set');

    const model = opts.model || DEFAULT_MODEL;
    const voice = opts.voice || DEFAULT_VOICE;
    const contextId = randomUUID();
    // Overridable so the message handling can be tested against a local fake.
    const wsBase = opts.credentials.MURF_WS_BASE ?? DEFAULT_WS_BASE;

    const params = new URLSearchParams({
      model,
      sample_rate: String(MURF_SAMPLE_RATE),
      channel_type: 'MONO',
      format: 'PCM',
    });

    // Key goes in the header, not the query string.
    const ws = new WebSocket(`${wsBase}?${params}`, { headers: { 'api-key': key } });

    let ready = false;
    let cancelled = false;
    let flushed = false;
    let done = false;
    const pending: Array<{ text: string; end: boolean }> = [];

    const finish = () => {
      if (done) return;
      done = true;
      events.onDone();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    const emit = (text: string, end: boolean) => {
      if (cancelled || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ text, end, context_id: contextId }));
    };

    ws.on('open', () => {
      if (cancelled) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          voice_config: {
            [VOICE_CONFIG_KEY]: voice,
            style: DEFAULT_STYLE,
            rate: 0,
            pitch: 0,
            variation: 1,
            ...(opts.language ? { multi_native_locale: opts.language } : {}),
          },
          context_id: contextId,
          min_buffer_size: MIN_BUFFER_SIZE,
        }),
      );
      ready = true;
      for (const item of pending) emit(item.text, item.end);
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (cancelled) return;
      let msg: MurfMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.error || msg.errorCode) {
        const detail =
          typeof msg.error === 'string' ? msg.error : msg.error?.message ?? msg.message ?? 'unknown';
        events.onError(new Error(`Murf TTS error: ${detail}`));
        finish();
        return;
      }

      if (msg.audio) {
        const pcm = stripWavHeader(Buffer.from(msg.audio, 'base64'));
        if (pcm.length > 0) {
          // No-op at 24 kHz; a guard in case the vendor ignores the request.
          events.onAudio(resamplePcm16(pcm, MURF_SAMPLE_RATE, opts.sampleRate));
        }
      }

      if (msg.final) finish();
    });

    ws.on('error', (err) => {
      if (cancelled) return;
      events.onError(new Error(`Murf TTS socket: ${err.message}`));
      finish();
    });

    ws.on('close', (code, reason) => {
      if (cancelled || done) return;
      if (!flushed) {
        events.onError(
          new Error(`Murf TTS closed early (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        );
      }
      finish();
    });

    return {
      pushText(text) {
        if (cancelled || flushed || !text) return;
        if (ready) emit(text, false);
        else pending.push({ text, end: false });
      },
      flush() {
        if (cancelled || flushed) return;
        flushed = true;
        // Empty text with end:true closes the context.
        if (ready) emit('', true);
        else pending.push({ text: '', end: true });
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
