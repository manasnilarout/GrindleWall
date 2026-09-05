import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';

/**
 * Google Gemini TTS.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   POST .../{model}:streamGenerateContent?alt=sse     (gemini-3.1-flash-tts-preview only)
 *   header: x-goog-api-key
 *
 * ---------------------------------------------------------------------------
 * THE DEFINING CONSTRAINT: Gemini TTS cannot accept incremental text.
 * ---------------------------------------------------------------------------
 * Every other TTS adapter here opens a socket and feeds it LLM tokens as they
 * arrive, so the vendor starts synthesising the first words while the model is
 * still writing the last ones. Gemini has no such surface: the request carries
 * one complete text body, and `streamGenerateContent` streams audio *out*, never
 * text *in*. The TTS model page lists "Live API: Not supported", so there is no
 * bidi socket to feed either. (True incremental text→audio from Google exists
 * only on gemini-3.1-flash-live-preview, which belongs in the realtime slot.)
 *
 * So `pushText` only accumulates, and `flush()` issues the single request. The
 * consequence for this bench is that **this provider's TTFB is not comparable to
 * a streaming vendor's**: it includes the entire LLM generation, because nothing
 * can be sent until the LLM is done. Read it as end-of-LLM→first-audio, not as
 * the vendor's own synthesis latency, and do not put it in a table beside
 * Cartesia's or Murf's without saying so.
 *
 * `open()` still resolves immediately — there is nothing to connect — which
 * keeps `tts_request_sent` meaning the same thing it means everywhere else.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED LIVE 2026-09-05
 * ---------------------------------------------------------------------------
 * A `gemini-tts -> gemini-stt` round trip transcribed back correctly, and TTFB
 * was measured as the median of three, warm: `gemini-3.1-flash-tts-preview`
 * 1798ms over SSE, `gemini-2.5-flash-preview-tts` ~4871ms one-shot. Read the
 * second as whole-generation time, not TTFB — `:generateContent` returns one
 * complete body, so there is nothing to be first.
 *
 * Settled by contact with the API:
 *
 *   · `:streamGenerateContent` DOES serve gemini-3.1-flash-tts-preview: a
 *     58-character sentence came back as 101 SSE frames. ListModels never
 *     confirmed this and could not have — that field lists streamGenerateContent
 *     for no model at all.
 *   · The literal output mimeType is `audio/l16; rate=24000; channels=1` —
 *     lowercase `l16`, spaces after the semicolons, no `codec=pcm`, and a
 *     `channels` field. Every third-party capture showing
 *     `audio/L16;codec=pcm;rate=24000` is wrong about the punctuation. Parsing
 *     `rate=` out of whatever arrives, rather than matching the whole string,
 *     is what made that difference a non-event.
 *   · TitleCase voice names are accepted (`Kore`, `Zephyr`).
 *
 * A REAL failure mode, reproduced 2/2 rather than merely documented:
 * `gemini-2.5-flash-preview-tts` is prompt-sensitive. Given the bare text
 * "Hello there." it returns **HTTP 400** — "Model tried to generate text, but it
 * should only be used for TTS" — because it read the input as an instruction
 * rather than a transcript. A full sentence synthesises fine, and
 * gemini-3.1-flash-tts-preview took the same short input without complaint.
 * Note Google documents this as a random 500; on this model it is a
 * deterministic 400 on short inputs. A short assistant turn can therefore fail
 * on the 2.5 models where it would succeed on 3.1.
 *
 * Also documented, not observed here: a vague prompt can trip the
 * speech-synthesis classifier into PROHIBITED_CONTENT.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Kore';

/** Rate assumed when the response `mimeType` carries no `rate=` at all. */
const ASSUMED_SAMPLE_RATE = 24000;

/** Emitted frame size, so playback starts on the first slice rather than a wall of audio. */
const FRAME_MS = 40;

/**
 * Ceiling on a single synthesis request. Generous, because this provider is
 * one-shot and a long reply legitimately takes a while — it is a wedge-breaker,
 * not a latency budget. See the watchdog in `flush()`.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** The one model Google says streams audio out. Everything else is one-shot. */
const STREAMING_MODELS = new Set(['gemini-3.1-flash-tts-preview']);

/**
 * `SpeechConfig.languageCode` takes LOCALES, and only these 30 — a much smaller
 * set than the ~80 bare BCP-47 codes the TTS guide lists as *supported
 * languages*, which are what the model auto-detects from the input text and are
 * NOT accepted here. A bare `en`, or a locale outside this list, is dropped
 * rather than forwarded: the models detect language from the text anyway, so
 * omitting the field costs nothing, while sending an unlisted value risks a 400.
 */
const SPEECH_LANGUAGE_CODES = new Set([
  'de-DE', 'en-AU', 'en-GB', 'en-IN', 'en-US', 'es-US', 'fr-FR', 'hi-IN', 'pt-BR', 'ar-XA',
  'es-ES', 'fr-CA', 'id-ID', 'it-IT', 'ja-JP', 'tr-TR', 'vi-VN', 'bn-IN', 'gu-IN', 'kn-IN',
  'ml-IN', 'mr-IN', 'ta-IN', 'te-IN', 'nl-NL', 'ko-KR', 'cmn-CN', 'pl-PL', 'ru-RU', 'th-TH',
]);

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

export class GeminiTtsProvider implements TtsProvider {
  readonly id = 'gemini-tts';
  readonly name = 'Google Gemini TTS';

  /** Resolves immediately: there is no connection, and no text to send yet either. */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY is not set');

    const model = opts.model || DEFAULT_MODEL;
    const voice = opts.voice?.trim() || DEFAULT_VOICE;
    // Overridable so the request/response handling can be tested against a local fake.
    const base = opts.credentials.GEMINI_BASE_URL || DEFAULT_BASE;
    const controller = new AbortController();

    /** Everything pushed so far. One request is built from all of it. */
    let buffered = '';
    let flushed = false;
    let done = false;
    /** Characters actually put in a request. Zero until `flush()` fires. */
    let sentCharacters = 0;

    const finish = () => {
      if (done) return;
      done = true;
      events.onDone();
    };

    const fail = (err: Error) => {
      if (done) return;
      events.onError(err);
      finish();
    };

    /**
     * PCM16 straight out of `inlineData`, at whatever rate the mimeType claims.
     * The rate is read per part rather than once per response: a streamed
     * response is free to change it mid-flight, and assuming otherwise would
     * silently alter the pitch of everything after the change.
     */
    const emitAudio = (mimeType: string | undefined, b64: string) => {
      if (done || !b64) return;
      // Documented as headerless; stripping costs nothing and avoids a click if not.
      const raw = stripWavHeader(Buffer.from(b64, 'base64'));
      if (raw.length === 0) return;
      const pcm = resamplePcm16(raw, parseRate(mimeType), opts.sampleRate);

      // Slice rather than hand over one giant buffer: the sink plays what it is
      // given, and a single 20-second chunk defeats the point of streaming.
      const frame = Math.max(2, Math.floor((opts.sampleRate * FRAME_MS) / 1000) * 2);
      for (let off = 0; off < pcm.length && !done; off += frame) {
        events.onAudio(pcm.subarray(off, Math.min(off + frame, pcm.length)));
      }
    };

    const request = async (text: string) => {
      const streaming = STREAMING_MODELS.has(model);
      const verb = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
      const url = `${base}/${encodeURIComponent(model)}:${verb}`;

      const speechConfig: Record<string, unknown> = {
        // Mutually exclusive with multiSpeakerVoiceConfig, which this bench does
        // not use — one voice per turn — so only ever one of the two is sent.
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      };
      const languageCode = opts.language?.trim();
      if (languageCode && SPEECH_LANGUAGE_CODES.has(languageCode)) {
        speechConfig.languageCode = languageCode;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig },
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini TTS ${res.status}: ${extractError(detail) || res.statusText}`);
      }

      if (streaming) {
        for await (const payload of sseChunks(res.body, controller.signal)) {
          let chunk: GeminiTtsResponse;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // keep-alive or partial frame
          }
          consume(chunk, emitAudio);
        }
        return;
      }

      consume((await res.json()) as GeminiTtsResponse, emitAudio);
    };

    return {
      pushText(text) {
        // Nothing goes on the wire here — see the header. Text only accumulates.
        if (done || flushed || !text) return;
        buffered += text;
      },
      flush() {
        if (done || flushed) return;
        flushed = true;
        const text = buffered.trim();
        // An empty turn is not a request; close it out rather than 400-ing.
        if (!text) return finish();

        /*
         * A watchdog, because this is the ONLY path to `onDone`/`onError`.
         *
         * The socket-based TTS providers get a free liveness signal from the
         * socket's own `close` event; a bare `fetch` has neither a timeout nor
         * a keep-alive contract. If the response body stalls with the
         * connection held open, this promise never settles, `finishTurn` is
         * never reached, and `PipelineSession.speaking` stays true — so the
         * turn never ends AND every later STT partial reads as a barge-in. The
         * conversation wedges rather than failing. The STT twin already carries
         * a fallback timer for exactly this class of stall.
         */
        const watchdog = setTimeout(() => {
          if (done) return;
          controller.abort();
          fail(new Error(`Gemini TTS produced no response within ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        watchdog.unref?.();

        sentCharacters = text.length;
        request(text)
          .then(finish, (err: Error) => {
            if (controller.signal.aborted) return; // barge-in, not a failure
            fail(err);
          })
          .finally(() => clearTimeout(watchdog));
      },
      /**
       * Only counted once the request has actually gone out. Until `flush()`
       * fires, `buffered` is text sitting in this process that Google has never
       * seen — billing it would charge for a turn that never ran.
       */
      billableCharacters() {
        return sentCharacters;
      },
      cancel() {
        // Barge-in. Abort mid-response so nothing further is decoded or emitted;
        // the turn is being abandoned, so no onDone — the pipeline has moved on.
        done = true;
        controller.abort();
      },
      close() {
        done = true;
        controller.abort();
      },
    };
  }
}

/** Pull every audio part out of one response, and turn Google's error shapes into throws. */
function consume(
  chunk: GeminiTtsResponse,
  emit: (mimeType: string | undefined, data: string) => void,
): void {
  if (chunk.error?.message) throw new Error(`Gemini TTS: ${chunk.error.message}`);
  if (chunk.promptFeedback?.blockReason) {
    // A vague prompt can trip the speech-synthesis classifier; say which one did.
    throw new Error(`Gemini TTS blocked the prompt (${chunk.promptFeedback.blockReason})`);
  }
  for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) emit(part.inlineData.mimeType, part.inlineData.data);
  }
}

/**
 * `audio/L16;codec=pcm;rate=24000` -> 24000.
 *
 * Parsed rather than assumed. 24 kHz is what every source says Gemini returns
 * and it happens to be this bench's canonical rate, but the literal mimeType
 * string is not published by Google, so a hardcoded 24000 would be a guess that
 * fails inaudibly — wrong-rate PCM plays at the wrong pitch, it does not error.
 */
function parseRate(mimeType: string | undefined): number {
  const m = /rate=(\d+)/i.exec(mimeType ?? '');
  const rate = m ? Number(m[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : ASSUMED_SAMPLE_RATE;
}

/**
 * Yields the payload of each `data:` event from an SSE body.
 *
 * A near-twin of the reader in GeminiLlmProvider. Kept local rather than shared
 * because the two legs stream different things and one is far more likely to
 * change than the other; if a third Gemini surface needs it, lift it then.
 */
async function* sseChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a single event may span lines.
      let sep: number;
      while ((sep = indexOfBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data && data !== '[DONE]') yield data;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function indexOfBoundary(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** Pull a human-readable message out of Google's error envelope. */
function extractError(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as GeminiTtsResponse | GeminiTtsResponse[];
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    return one?.error?.message ?? '';
  } catch {
    return payload.slice(0, 200);
  }
}
