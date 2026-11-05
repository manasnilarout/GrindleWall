import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';
import { MURF_FALCON_LOCALES, MURF_GEN2_LOCALES } from '../murf-catalog.js';

/**
 * Murf TTS — two transports, one per model.
 *
 *   falcon-2   POST https://in.api.murf.ai/v1/speech/stream          (HTTP, India region)
 *              body {text, voiceId, model, format, sampleRate, channelType, ...}
 *              response: the audio itself, chunked over HTTP
 *   gen2       wss://api.murf.ai/v1/speech/stream-input              (WebSocket, US)
 *              ?model=gen2&sample_rate=24000&channel_type=MONO&format=PCM
 *              {voice_config} first, then {text, end}; server sends {audio:<b64>, final}
 *   both       header: api-key
 *
 * Murf is TTS only — there is no Murf STT to pair this with.
 *
 * ---------------------------------------------------------------------------
 * FALCON ON HTTP /v1/speech/stream — DOC-DERIVED, NEVER RUN LIVE (2026-11-05)
 * ---------------------------------------------------------------------------
 * Moved from `wss://global.api.murf.ai/v1/speech/stream-input` to the India
 * regional HTTP endpoint on request. Everything below is from Murf's docs as
 * read on 2026-11-05 (api-reference/text-to-speech/stream, text-to-speech/
 * streaming, text-to-speech/data-residency, resources/rate-limits), NOT from a
 * call: there was no MURF_API_KEY in the session that wrote it. The ~186ms TTFB
 * measured on 2026-09-05 belongs to the old WebSocket path and says nothing
 * about this one. Run `npm run murf:http:probe` and a `roundtrip` before
 * quoting a number for it.
 *
 *   · The docs list `in.api.murf.ai` among 11 regional hosts and say "Data
 *     residency is only available for the Falcon 2.1 TTS model", so only Falcon
 *     is sent there. Default concurrency on a regional host is 2 (US-East 5);
 *     "each in-flight request uses one slot until its audio finishes", so the
 *     segments below are sent strictly one at a time.
 *   · The request takes ONE complete `text`. There is no way to feed LLM tokens
 *     into a request already in flight, which is what the WebSocket did. So
 *     `pushText` accumulates and each complete SENTENCE goes out as its own
 *     request, in order; `flush()` sends whatever is left. TTFB therefore
 *     includes the time the LLM takes to finish its first sentence — read it as
 *     first-sentence-ready → first audio, not as the vendor's own TTFB, and do
 *     not put it beside a token-streaming vendor's number without saying so.
 *     Sentence-sized requests are the coarse end of the buffering trap described
 *     in CLAUDE.md, not the per-token end, but rendered duration against a
 *     one-shot reference has not been measured for this path.
 *   · `format: "PCM"` is a documented value on this endpoint. The docs describe
 *     headerless little-endian 16-bit for PCM only on the WebSocket page; the
 *     HTTP guide's PCM example plays it as 16-bit mono at 24 kHz. A RIFF header
 *     is stripped if one arrives anyway, and an odd byte split across HTTP chunks
 *     is carried to the next chunk rather than dropped.
 *   · `locale` replaces the deprecated `multiNativeLocale`. `model` is sent as
 *     `falcon-2.1`, the one value the reference lists; it says the older
 *     `falcon-2` / `FALCON` spellings "are still accepted and use Falcon 2.1".
 *
 * ---------------------------------------------------------------------------
 * GEN2 ON THE WEBSOCKET — MEASURED AGAINST THE LIVE API (2026-09-05)
 * ---------------------------------------------------------------------------
 * The key goes in the `api-key` header, the model in the query string, and
 * voice_config takes `voiceId`. Things the docs got wrong or left out, each of
 * which produced a live error before it was pinned down:
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
 * Murf's streaming guide (read 2026-11-05) now says "The Gen2 model has been
 * decommissioned for streaming". That has not been re-measured; Gen2 is left on
 * the transport it was verified on until `npm run murf:probe` says otherwise.
 *
 * Measured TTFB on the WebSocket: falcon-2 ~86-99ms on the global host, gen2
 * ~1.1s on the US one.
 */

/**
 * Falcon's endpoint: Murf's India region, HTTP streaming. Docs-derived; see header.
 * `credentials.MURF_HTTP_URL` overrides it (the self-test's seam, and the way to
 * pick another of Murf's regional hosts without a code change).
 */
const IN_HTTP_URL = 'https://in.api.murf.ai/v1/speech/stream';
/** Where Gen2 lives. The global WebSocket host refuses it (1008). */
const US_WS_BASE = 'wss://api.murf.ai/v1/speech/stream-input';
const DEFAULT_MODEL = 'falcon-2';

/**
 * Per-model request profile.
 *
 * Murf's model families do not take the same request — the transport, the host,
 * the wire name, the styles a voice answers to and the rate the model renders at
 * are all per-model. They live in one table rather than in the request code, so
 * whatever a probe reports is a one-line edit per model instead of a hunt
 * through the handler.
 */
type MurfTransport =
  /** POST one complete text per request; audio comes back as the response body. */
  | { kind: 'http'; url: string }
  /** One socket per turn, fed text as it arrives. */
  | { kind: 'ws'; base: string };

interface MurfModelProfile {
  /** Value of the `model` field (HTTP body) or query param (WebSocket). */
  wireModel: string;
  /** Where and how this model is reached. Gen2 is refused by the global WS host. */
  transport: MurfTransport;
  /** Voice used when the session names none. */
  defaultVoice: string;
  /** Style sent for a catalog voice; `undefined` sends none at all. */
  defaultStyle?: string;
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
  wireModel: 'falcon-2.1',
  transport: { kind: 'http', url: IN_HTTP_URL },
  defaultVoice: 'en-US-natalie',
  defaultStyle: 'Conversational',
  locales: MURF_FALCON_LOCALES.map((l) => l.id),
  requestSampleRate: 24000,
};

const GEN2: MurfModelProfile = {
  ...FALCON,
  wireModel: 'gen2',
  // 1008: "Gen2 Model is not available in global.api.murf.ai."
  transport: { kind: 'ws', base: US_WS_BASE },
  locales: MURF_GEN2_LOCALES.map((l) => l.id),
};

/** Catalog model id -> profile. Unknown ids fall back to Falcon. */
const MURF_PROFILES: Record<string, MurfModelProfile> = {
  'falcon-2': FALCON,
  'falcon-2.1': FALCON,
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
 * measured on the WebSocket. So a bare code is widened to the first locale this
 * model publishes for that language, and anything still unrecognised is dropped
 * rather than sent to be refused: the voice's own locale is the right fallback.
 */
function resolveLocale(language: string | undefined, profile: MurfModelProfile): string | undefined {
  const want = language?.trim();
  if (!want) return undefined;
  if (profile.locales.includes(want)) return want;
  const lang = want.split('-')[0].toLowerCase();
  return profile.locales.find((l) => l.toLowerCase().startsWith(`${lang}-`));
}

/** What every request needs, resolved once per turn. */
interface Resolved {
  key: string;
  profile: MurfModelProfile;
  voice: string;
  style: string | undefined;
  locale: string | undefined;
}

export class MurfTtsProvider implements TtsProvider {
  readonly id = 'murf-tts';
  readonly name = 'Murf Falcon';

  /** Resolves immediately; nothing is connected or sent until there is text. */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.MURF_API_KEY;
    if (!key) throw new Error('MURF_API_KEY is not set');

    const profile = profileFor(opts.model || DEFAULT_MODEL);
    // Either a catalog voice or an id typed into the UI; the vendor validates it.
    const voice = opts.voice?.trim() || profile.defaultVoice;
    const r: Resolved = {
      key,
      profile,
      voice,
      style: LIBRARY_VOICE_ID.test(voice) ? profile.defaultStyle : undefined,
      locale: resolveLocale(opts.language, profile),
    };

    return profile.transport.kind === 'http'
      ? openHttp(r, profile.transport.url, opts, events)
      : openWs(r, profile.transport.base, opts, events);
  }
}

// ===========================================================================
// HTTP: POST /v1/speech/stream (Falcon)
// ===========================================================================

/**
 * A sentence ends at terminal punctuation followed by whitespace. Requiring the
 * whitespace keeps `3.5` and `murf.ai` whole; the LLM's next token supplies it,
 * and `flush()` sends whatever is left without one.
 */
const SENTENCE_END = /[.!?।॥。！？…]+["'”’)\]]*\s+/g;

/**
 * Ceiling on one request — a wedge-breaker, not a latency budget. A sentence
 * takes seconds to render, never this long; without it a stalled response would
 * hold the turn (and one of the region's concurrency slots) open forever.
 */
const HTTP_REQUEST_TIMEOUT_MS = 30_000;

/** The longest prefix of `buf` that ends on a sentence boundary, or 0. */
function sentencePrefixLength(buf: string): number {
  let end = 0;
  for (const m of buf.matchAll(SENTENCE_END)) end = m.index! + m[0].length;
  return end;
}

/** Murf's documented error bodies are `any`; the 429 one is `{error, message}`. */
function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    for (const k of ['message', 'error', 'errorMessage', 'detail']) {
      const v = j[k];
      if (typeof v === 'string' && v) return v;
    }
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300);
}

function openHttp(r: Resolved, defaultUrl: string, opts: TtsOptions, events: TtsEvents): TtsStream {
  // Overridable so the request/response handling can be tested against a local fake.
  const url = opts.credentials.MURF_HTTP_URL || defaultUrl;
  const controller = new AbortController();

  let buffered = '';
  let flushed = false;
  let cancelled = false;
  let done = false;
  /** Characters actually put in a request — what Murf was asked to synthesise. */
  let sentCharacters = 0;
  const queue: string[] = [];
  let running = false;

  const finish = () => {
    if (done) return;
    done = true;
    events.onDone();
  };

  const fail = (err: Error) => {
    if (done || cancelled) return;
    events.onError(err);
    finish();
    controller.abort();
  };

  const request = async (text: string) => {
    const body: Record<string, unknown> = {
      text,
      voiceId: r.voice,
      model: r.profile.wireModel,
      format: 'PCM',
      sampleRate: r.profile.requestSampleRate,
      channelType: 'MONO',
      rate: 0,
      pitch: 0,
      ...(r.style ? { style: r.style } : {}),
      ...(r.locale ? { locale: r.locale } : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      // Key goes in the header, never the URL.
      headers: { 'content-type': 'application/json', 'api-key': r.key },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS)]),
    });

    if (!res.ok || !res.body) {
      const detail = errorDetail(await res.text().catch(() => ''));
      throw new Error(`Murf TTS HTTP ${res.status}: ${detail || res.statusText}`);
    }

    // A RIFF header, if one arrives despite format=PCM, needs its whole 44 bytes
    // before it can be recognised; and a 16-bit sample can straddle two chunks.
    let head: Buffer | null = Buffer.alloc(0);
    let carry = Buffer.alloc(0);
    const emit = (bytes: Buffer) => {
      const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      const even = joined.length - (joined.length % 2);
      carry = Buffer.from(joined.subarray(even));
      if (even === 0 || done || cancelled) return;
      // No-op at 24 kHz; a guard in case the vendor ignores the request.
      events.onAudio(resamplePcm16(joined.subarray(0, even), r.profile.requestSampleRate, opts.sampleRate));
    };

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (done || cancelled) return;
      const buf = Buffer.from(chunk);
      if (head) {
        head = Buffer.concat([head, buf]);
        if (head.length < 44) continue;
        const pcm = stripWavHeader(head);
        head = null;
        emit(pcm);
      } else {
        emit(buf);
      }
    }
    if (head && head.length) emit(stripWavHeader(head));
  };

  /** One request at a time: order is the transcript's order, and one concurrency slot is enough. */
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length && !done && !cancelled) {
        const text = queue.shift()!;
        sentCharacters += text.length;
        try {
          await request(text);
        } catch (err) {
          if (cancelled || done) return;
          const e = err as Error;
          fail(
            e.name === 'TimeoutError'
              ? new Error(`Murf TTS HTTP: no complete response within ${HTTP_REQUEST_TIMEOUT_MS}ms`)
              : e.message.startsWith('Murf TTS')
                ? e
                : new Error(`Murf TTS HTTP: ${e.message}`),
          );
          return;
        }
      }
      if (flushed && !queue.length) finish();
    } finally {
      running = false;
    }
  };

  const enqueue = (text: string) => {
    const t = text.trim();
    if (t) queue.push(t);
  };

  return {
    pushText(text) {
      if (cancelled || flushed || done || !text) return;
      buffered += text;
      const cut = sentencePrefixLength(buffered);
      if (cut === 0) return;
      enqueue(buffered.slice(0, cut));
      buffered = buffered.slice(cut);
      void pump();
    },
    flush() {
      if (cancelled || flushed || done) return;
      flushed = true;
      enqueue(buffered);
      buffered = '';
      void pump();
    },
    cancel() {
      cancelled = true;
      done = true;
      queue.length = 0;
      buffered = '';
      controller.abort();
    },
    close() {
      cancelled = true;
      done = true;
      queue.length = 0;
      buffered = '';
      controller.abort();
    },
    /**
     * Only text that went out in a request. Text still buffered or queued when a
     * barge-in lands was never sent, so Murf was never asked to synthesise it.
     */
    billableCharacters: () => sentCharacters,
  };
}

// ===========================================================================
// WebSocket: /v1/speech/stream-input (Gen2)
// ===========================================================================

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

/** The socket connects in the background and text queues until it is open. */
function openWs(r: Resolved, defaultBase: string, opts: TtsOptions, events: TtsEvents): TtsStream {
  const { profile, voice, style, locale } = r;
  const contextId = randomUUID();
  // Overridable so the message handling can be tested against a local fake.
  const wsBase = opts.credentials.MURF_WS_BASE ?? defaultBase;

  const params = new URLSearchParams({
    model: profile.wireModel,
    sample_rate: String(profile.requestSampleRate),
    channel_type: 'MONO',
    format: 'PCM',
  });

  // Key goes in the header, not the query string.
  const ws = new WebSocket(`${wsBase}?${params}`, { headers: { 'api-key': r.key } });

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
          voiceId: voice,
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
