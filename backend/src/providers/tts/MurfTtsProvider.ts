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
 *     `pushText` accumulates and `segmentText()` decides what goes out: all text
 *     up to the last sentence end (Latin `.!?` followed by a space, CJK `。！？`
 *     and Devanagari `।` with or without one, or a line break), provided that is
 *     at least MIN_SEGMENT_CHARS — so "Dr.", "e.g.", "1." and a lone "Sure!" are
 *     never their own synthesis — and never more than MAX_SEGMENT_CHARS, under
 *     the 3,000 per request Murf's FAQ allows. Segments go one at a time, in
 *     order; `flush()` sends the rest. TTFB therefore includes the time the LLM
 *     takes to finish its first segment — read it as first-segment-ready → first
 *     audio, not as the vendor's own TTFB, and do not put it beside a
 *     token-streaming vendor's number without saying so. Rendered duration
 *     against a one-shot reference, and the silence at each segment boundary if
 *     Murf delivers at ~1x real time, are what `murf:http:probe` section 7
 *     measures; neither has been measured yet.
 *   · Murf also documents `wss://in.api.murf.ai/v1/speech/stream-input` — the same
 *     India region on the WebSocket this file used to send Falcon over, which
 *     takes text incrementally. The HTTP endpoint is used because it is the one
 *     asked for; switching back is a host change on FALCON's transport.
 *   · fetch keeps the connection to the host alive, so only the first request
 *     to it pays DNS+TCP+TLS; later segments, and turns that start while the
 *     connection is still alive, do not. The WebSocket providers handshake every
 *     turn. Gemini TTS has the same property. Compare first-turn numbers with
 *     first-turn numbers.
 *   · `format: "PCM"` is a documented value on this endpoint. The docs describe
 *     headerless little-endian 16-bit for PCM only on the WebSocket page; the
 *     HTTP guide's PCM example plays it as 16-bit mono at 24 kHz. A RIFF header
 *     is stripped if one arrives anyway, and an odd byte split across HTTP chunks
 *     is carried to the next chunk rather than dropped.
 *   · `locale` replaces the deprecated `multiNativeLocale`. `model` is sent as
 *     `falcon-2.1`, the one value the reference lists; it says the older
 *     `falcon-2` / `FALCON` spellings "are still accepted and use Falcon 2.1".
 *   · A refused request (non-2xx, or a 2xx carrying JSON) is surfaced with
 *     Murf's own text and `Retry-After`, ends the turn, and is not billed. It is
 *     not retried: a retry inside the measured window would hide the failure in
 *     the latency number.
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
 * Measured TTFB on the WebSocket: falcon-2 ~186ms cold (open + synthesise) and
 * ~86-99ms socket-warm on the global host; gen2 ~1.1-1.75s on the US one.
 */

/**
 * Falcon's endpoint: Murf's India region, HTTP streaming. Docs-derived; see header.
 * `credentials.MURF_HTTP_URL` overrides it (the self-test's seam, and the way to
 * pick another of Murf's regional hosts without a code change).
 */
const IN_HTTP_URL = 'https://in.api.murf.ai/v1/speech/stream';
/**
 * Where Gen2 lives. The global WebSocket host refuses it (1008). Murf's
 * stream-input reference (read 2026-11-05) now says the endpoint "serves the
 * Falcon model only" and that `api.murf.ai` is "a legacy alias that always
 * resolves to us-east" — not re-measured, so Gen2 may no longer work here at all.
 */
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
 * A segment is never cut shorter than this. "Dr.", "e.g." and a lone "Sure!"
 * would otherwise each go out as their own synthesis, with their own prosody —
 * word-sized requests, the per-token end of the buffering trap rather than the
 * sentence-sized end this path is meant to sit at. A short first sentence waits
 * for the next one instead; `flush()` sends anything shorter that is left.
 */
export const MIN_SEGMENT_CHARS = 20;

/** Han, kana and Hangul carry a word or more per character, so each counts double toward the minimum. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const weight = (s: string) => s.length + (s.match(WIDE)?.length ?? 0);

/**
 * Past this, a segment with no sentence end is cut at a clause or word boundary.
 * Murf's FAQ: "The API supports up to 3,000 characters per request. For longer
 * text, split it into multiple requests." (read 2026-11-05). Kept well under that
 * so one run-on reply cannot hold a request open for minutes of audio either.
 */
export const MAX_SEGMENT_CHARS = 500;

/** Latin terminators: a sentence ends only where whitespace follows. Keeps `3.5` and `murf.ai` whole. */
const LATIN_END = /([.!?…]+)["'”’)\]]*\s+/g;
/** CJK and Indic terminators end a sentence with or without a following space. */
const SCRIPT_END = /[。！？।॥]+["'”’)\]」』）]*\s*/g;
/** Line breaks end a segment: list items, headings. */
const LINE_END = /\n+/g;
/** Where to cut a run-on that has no sentence end. */
const CLAUSE_END = /[,;:—–，、；：]\s*/g;

/** A single `.` after one of these is an abbreviation, not a sentence end. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'no', 'fig', 'approx']);

function isAbbreviation(before: string, terminator: string): boolean {
  if (terminator !== '.') return false;
  const word = /([^\s("'“‘]+)$/.exec(before)?.[1] ?? '';
  return (
    /^[a-z](?:\.[a-z])*$/i.test(word) || // p.m, U.S, e.g, a single initial
    /^\d+$/.test(word) || // a list number, "1."
    TITLES.has(word.toLowerCase())
  );
}

/** Every index at which a segment may end, ascending. */
function boundaries(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(LATIN_END)) {
    if (!isAbbreviation(text.slice(0, m.index), m[1])) out.push(m.index! + m[0].length);
  }
  for (const m of text.matchAll(SCRIPT_END)) out.push(m.index! + m[0].length);
  for (const m of text.matchAll(LINE_END)) out.push(m.index! + m[0].length);
  return out.sort((a, b) => a - b);
}

/** Splits a piece longer than the cap at its last clause end, else its last space, else hard. */
function capLength(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_SEGMENT_CHARS) {
    const window = rest.slice(0, MAX_SEGMENT_CHARS);
    let cut = 0;
    for (const m of window.matchAll(CLAUSE_END)) cut = m.index! + m[0].length;
    if (cut < MIN_SEGMENT_CHARS) cut = window.lastIndexOf(' ') + 1;
    if (cut < MIN_SEGMENT_CHARS) cut = MAX_SEGMENT_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits buffered LLM text into the requests to send now, and the rest to keep.
 *
 * Not final: everything up to the LAST boundary goes, as one or more requests —
 * provided it is at least MIN_SEGMENT_CHARS. Text without a boundary is held
 * until it passes MAX_SEGMENT_CHARS. Final (`flush()`): everything goes.
 * Every returned segment is trimmed, non-empty and at most MAX_SEGMENT_CHARS.
 */
export function segmentText(buffer: string, final: boolean): { segments: string[]; rest: string } {
  let cut = final ? buffer.length : 0;
  if (!final) {
    const ends = boundaries(buffer).filter((i) => weight(buffer.slice(0, i).trim()) >= MIN_SEGMENT_CHARS);
    if (ends.length) cut = ends[ends.length - 1];
    else if (buffer.length > MAX_SEGMENT_CHARS) {
      // A run-on: send whole capped pieces, keep the tail to join what comes next.
      const pieces = capLength(buffer);
      const tail = pieces.pop()!;
      cut = buffer.length - tail.length;
    }
  }
  const segments = capLength(buffer.slice(0, cut))
    .map((s) => s.trim())
    .filter(Boolean);
  return { segments, rest: buffer.slice(cut) };
}

/**
 * Time allowed for the response HEADERS, and then between any two body chunks.
 * Wedge-breakers, not latency budgets. Neither bounds the whole response, which
 * legitimately lasts as long as Murf takes to stream a segment's audio; without
 * them a stalled request would hold the turn — and one of the region's two
 * concurrency slots — open forever.
 */
const HEADERS_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 10_000;

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

/**
 * Whether `head` holds a complete WAV header, or is clearly not WAV. The first
 * bytes are held until it does, so a header longer than 44 bytes (a LIST chunk)
 * that straddles two network chunks is still stripped rather than played.
 */
function headerSettled(head: Buffer): boolean {
  if (head.length < 12) return false;
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return true;
  let off = 12;
  while (off + 8 <= head.length) {
    if (head.toString('ascii', off, off + 4) === 'data') return true;
    off += 8 + head.readUInt32LE(off + 4) + (head.readUInt32LE(off + 4) % 2);
  }
  return head.length >= 4096; // malformed; stop holding audio back
}

class MurfHttpError extends Error {}

function openHttp(r: Resolved, defaultUrl: string, opts: TtsOptions, events: TtsEvents): TtsStream {
  // Overridable so the request/response handling can be tested against a local fake.
  const url = opts.credentials.MURF_HTTP_URL || defaultUrl;
  const controller = new AbortController();

  let buffered = '';
  let flushed = false;
  let cancelled = false;
  let done = false;
  /**
   * Characters in requests Murf accepted (2xx) or that were cut off by a barge-in
   * after being sent — what Murf was asked to synthesise. A refused request
   * (4xx/5xx/429) or one that never reached Murf is taken back out.
   */
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

  const request = async (text: string): Promise<void> => {
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

    // One controller per request: aborted by barge-in (via the stream's) or by a timer.
    const req = new AbortController();
    const onCancel = () => req.abort();
    controller.signal.addEventListener('abort', onCancel);
    let timedOut: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, what: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = `${what} within ${ms}ms`;
        req.abort();
      }, ms);
    };

    try {
      arm(HEADERS_TIMEOUT_MS, 'no response headers');
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          // Key goes in the header, never the URL.
          headers: { 'content-type': 'application/json', 'api-key': r.key },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        // Never reached Murf, or never answered. A barge-in that aborts a request
        // already on the wire is the exception: Murf had the text, so it stays billed.
        if (!controller.signal.aborted) sentCharacters -= text.length;
        throw err;
      }

      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || type.includes('json')) {
        sentCharacters -= text.length; // refused: nothing was synthesised
        const detail = errorDetail(await res.text().catch(() => ''));
        const retry = res.headers.get('retry-after');
        throw new MurfHttpError(
          `Murf TTS HTTP ${res.status}: ${detail || (res.ok ? 'response carried no audio' : res.statusText)}` +
            (retry ? ` (Retry-After: ${retry}s)` : ''),
        );
      }

      // A RIFF header, if one arrives despite format=PCM, must be whole before it
      // can be stripped; and a 16-bit sample can straddle two chunks.
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

      arm(IDLE_TIMEOUT_MS, 'no audio');
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (done || cancelled) return;
        arm(IDLE_TIMEOUT_MS, 'no further audio');
        const buf = Buffer.from(chunk);
        if (head) {
          head = Buffer.concat([head, buf]);
          if (!headerSettled(head)) continue;
          const pcm = stripWavHeader(head);
          head = null;
          emit(pcm);
        } else {
          emit(buf);
        }
      }
      if (head && head.length) emit(stripWavHeader(head));
      // A trailing odd byte belongs to no sample; it is dropped, never carried
      // into the next segment's audio.
    } catch (err) {
      if (timedOut) throw new MurfHttpError(`Murf TTS HTTP: ${timedOut}`);
      throw err;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onCancel);
    }
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
          const e = err as Error & { cause?: { code?: string; message?: string } };
          const cause = e.cause?.code ?? e.cause?.message;
          fail(
            e instanceof MurfHttpError
              ? e
              : new Error(`Murf TTS HTTP: ${e.message}${cause ? ` (${cause})` : ''}`),
          );
          return;
        }
      }
      if (flushed && !queue.length) finish();
    } finally {
      running = false;
    }
  };

  const take = (final: boolean) => {
    const { segments, rest } = segmentText(buffered, final);
    buffered = rest;
    if (!segments.length) return false;
    queue.push(...segments);
    return true;
  };

  return {
    pushText(text) {
      if (cancelled || flushed || done || !text) return;
      buffered += text;
      if (take(false)) void pump();
    },
    flush() {
      if (cancelled || flushed || done) return;
      flushed = true;
      take(true);
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
     * Only text Murf was actually asked to synthesise. Text still buffered or
     * queued when a barge-in lands was never sent; a request Murf refused
     * synthesised nothing.
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
