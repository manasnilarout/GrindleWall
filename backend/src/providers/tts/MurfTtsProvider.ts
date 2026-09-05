import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';
import { MURF_FALCON_LOCALES, MURF_GEN2_LOCALES } from '../murf-catalog.js';

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
 * MEASURED AGAINST THE LIVE API (2026-09-05)
 * ---------------------------------------------------------------------------
 * The docs' ambiguities are settled: the key goes in the `api-key` header, the
 * model goes in the query string as `falcon-2` / `gen2`, and voice_config takes
 * `voiceId`. Three things the docs get wrong or leave out, all of which produced
 * a live error before they were pinned down here:
 *
 *   · Falcon 2 and Gen2 have SEPARATE voice catalogues (137 / 163 voices, 100
 *     shared). The other model's voice is rejected outright, so the voice list
 *     lives on the model in catalog.ts, not on the provider.
 *   · Gen2 is not served by global.api.murf.ai at all — it closes with 1008 and
 *     says to use api.murf.ai. Each model therefore carries its own host.
 *   · A voice id has two accepted spellings: the qualified `hi-IN-namrita` the API
 *     publishes, and the bare display name the docs use, `Namrita`. Both resolve —
 *     and both are resolved against the selected model's catalogue, so neither
 *     spelling rescues a voice that belongs to the other model.
 *
 * Measured TTFB: falcon-2 ~86-99ms on the global host, gen2 ~1.1s on the US one.
 */

/** Falcon's host. Fastest by a wide margin, but it serves Falcon only. */
const GLOBAL_WS_BASE = 'wss://global.api.murf.ai/v1/speech/stream-input';
/** Where Gen2 lives. Falcon works here too, ~3x slower from India. */
const US_WS_BASE = 'wss://api.murf.ai/v1/speech/stream-input';
const DEFAULT_MODEL = 'falcon-2';

/**
 * Per-model request profile.
 *
 * Murf's model families do not take the same request — the wire name, the
 * voice_config key, the styles a voice answers to and the rate the model renders
 * at are all per-model. They live in one table rather than in the socket code, so
 * whatever `npm run murf:probe` reports is a one-line edit per model instead of a
 * hunt through the handler.
 */
interface MurfModelProfile {
  /** Value of the `model` query param. */
  wireModel: string;
  /** Host that serves this model. Gen2 is refused by the global one. */
  wsBase: string;
  /** Key the voice id travels under inside voice_config. */
  voiceKey: 'voiceId' | 'voice_id';
  /** Voice used when the session names none. */
  defaultVoice: string;
  /** Style sent for a catalog voice; `undefined` sends none at all. */
  defaultStyle?: string;
  /** Whether voice_config accepts multi_native_locale on this model. */
  multiNativeLocale: boolean;
  /** The locales this model knows, for resolving a bare language code. */
  locales: string[];
  /**
   * Rate asked of the vendor. Falcon renders 24 kHz natively — the bench's
   * canonical rate, so nothing is resampled. Gen2 renders 44.1 kHz and
   * downsamples server-side; asking for 24 kHz there keeps this leg
   * transcode-free too, at the vendor's discretion.
   */
  requestSampleRate: number;
}

const FALCON: MurfModelProfile = {
  wireModel: 'falcon-2',
  wsBase: GLOBAL_WS_BASE,
  voiceKey: 'voiceId',
  defaultVoice: 'en-US-natalie',
  defaultStyle: 'Conversational',
  multiNativeLocale: true,
  locales: MURF_FALCON_LOCALES.map((l) => l.id),
  requestSampleRate: 24000,
};

const GEN2: MurfModelProfile = {
  ...FALCON,
  wireModel: 'gen2',
  // 1008: "Gen2 Model is not available in global.api.murf.ai."
  wsBase: US_WS_BASE,
  locales: MURF_GEN2_LOCALES.map((l) => l.id),
};

/** Catalog model id -> profile. Unknown ids fall back to Falcon. */
const MURF_PROFILES: Record<string, MurfModelProfile> = {
  'falcon-2': FALCON,
  falcon: FALCON,
  gen2: GEN2,
};

function profileFor(model: string): MurfModelProfile {
  return MURF_PROFILES[model.trim().toLowerCase()] ?? FALCON;
}

/**
 * The ids in the generated catalogue are locale-prefixed — `en-US-natalie`. An id
 * in any other shape still works (Murf resolves bare display names, and cloned
 * voices have their own ids) but cannot be matched to a catalogue entry here, so
 * no style is assumed for it and Murf applies the voice's own. A style a voice
 * does not list is tolerated anyway — measured — so this costs nothing either way.
 */
const LIBRARY_VOICE_ID = /^[a-z]{2}-[a-z]{2,6}-[a-z0-9_.-]+$/i;

/**
 * Murf names locales, not languages: `en-US`, never `en`. The rest of the bench
 * speaks bare ISO codes on some legs (`TTS_LANG=en`, Cartesia's list), and Murf
 * answers a bare one with "Locale 'en' is not a recognized or supported locale" —
 * measured. So a bare code is widened to the first locale this model publishes
 * for that language, and anything still unrecognised is dropped rather than sent
 * to be refused: the voice's own locale is the right fallback.
 */
function resolveLocale(language: string | undefined, profile: MurfModelProfile): string | undefined {
  const want = language?.trim();
  if (!want) return undefined;
  if (profile.locales.includes(want)) return want;
  const lang = want.split('-')[0].toLowerCase();
  return profile.locales.find((l) => l.toLowerCase().startsWith(`${lang}-`));
}

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

    const profile = profileFor(opts.model || DEFAULT_MODEL);
    // Either a catalog voice or an id typed into the UI; the vendor validates it.
    const voice = opts.voice?.trim() || profile.defaultVoice;
    const style = LIBRARY_VOICE_ID.test(voice) ? profile.defaultStyle : undefined;
    const locale = profile.multiNativeLocale ? resolveLocale(opts.language, profile) : undefined;
    const contextId = randomUUID();
    // Overridable so the message handling can be tested against a local fake.
    const wsBase = opts.credentials.MURF_WS_BASE ?? profile.wsBase;

    const params = new URLSearchParams({
      model: profile.wireModel,
      sample_rate: String(profile.requestSampleRate),
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
            [profile.voiceKey]: voice,
            ...(style ? { style } : {}),
            rate: 0,
            pitch: 0,
            variation: 1,
            ...(locale ? { multi_native_locale: locale } : {}),
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
          events.onAudio(resamplePcm16(pcm, profile.requestSampleRate, opts.sampleRate));
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
