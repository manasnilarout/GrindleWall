import WebSocket from 'ws';
import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { resamplePcm16, stripWavHeader } from '../../audio/pcm.js';

/**
 * ElevenLabs single-context streaming TTS.
 *
 *   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *       ?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=false
 *   header: xi-api-key
 *
 * The voice is a PATH parameter, so it is fixed for the life of the socket —
 * this provider opens one socket per turn, which is what the bench wants anyway
 * because vendor connection setup belongs inside the measured window.
 *
 * Client sends three message shapes, in this order:
 *   {text:" ", voice_settings:{...}, generation_config:{...}}   InitializeConnection
 *   {text:"Hello World "}                                       SendText, one per chunk
 *   {text:""}                                                   CloseConnection
 * Server sends {audio:<base64>, alignment?, normalizedAlignment?} and finally
 * {isFinal:true} with a null/absent `audio`.
 *
 * We request `output_format=pcm_24000` — raw PCM16 LE mono @ 24 kHz, already the
 * bench's canonical rate, so nothing is transcoded on this leg.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED LIVE 2026-09-05
 * ---------------------------------------------------------------------------
 * An `elevenlabs-tts -> cartesia-stt` round trip transcribed back at 91% word
 * overlap, so the request shape, the handshake auth, `pcm_24000` and the decode
 * path are all confirmed on the wire. Measured TTFB, median of three, warm
 * socket: `eleven_flash_v2_5` 426ms, `eleven_multilingual_v2` 717ms, one-shot
 * text. Rendered duration under token streaming was measured too — see the
 * buffering block below, which is where the interesting result is.
 *
 * Settled by contact with the API:
 *
 *   · `pcm_24000` IS served on this account tier. The gating clause naming only
 *     44.1 kHz turned out not to reach it.
 *   · `isFinal` is the casing actually sent. `is_final` is still accepted below;
 *     it is two lines and costs nothing to keep.
 *
 * Still NOT verified, and still may not be restated as measured:
 *
 *   · Whether `eleven_v3_conversational` is accepted on THIS endpoint. `eleven_v3`
 *     is documented as excluded; the conversational variant is named nowhere, and
 *     only the flash and multilingual models have actually been run.
 *   · Whether the trailing space the docs demand on every text chunk matters, and
 *     what it costs when a word is split across two LLM tokens (see SendText).
 *
 * `scripts/elevenlabs-selftest.ts` exercises the message handling against a fake
 * this repo wrote, which proves only that the handling is self-consistent — a
 * live round trip does not upgrade it.
 *
 * Two documented ambiguities are sidestepped rather than guessed at: the API key
 * goes in the handshake header (the docs spell the in-message field `xi-api-key`
 * in the schema and `xi_api_key` in both code examples), and `generation_config`
 * is sent ONLY in the init message (the SendText schema spells it
 * `generator_config`, and the field must not change after the first message
 * anyway, so never resending it makes the disagreement moot).
 */

/** Production host. Regional residency hosts exist; none is measured here. */
const DEFAULT_WS_BASE = 'wss://api.elevenlabs.io';

/**
 * Vendor's own guidance is "Low-latency → Use Flash models", and Flash v2.5 is
 * the only current Flash model that is not English-only (32 languages). Its
 * published ~75ms figure is the vendor's, excludes application and network
 * latency, and is NOT comparable to this bench's TTFB.
 */
const DEFAULT_MODEL = 'eleven_flash_v2_5';

/**
 * "George", the one voice id ElevenLabs names in its own code examples (the
 * quickstart annotates it, and the Create-speech request example reuses it).
 *
 * It is a Default voice, and ElevenLabs has published a hard sunset: Default
 * voices expire 2026-12-31, and are "only available for accounts that were
 * created before March 2026". So this default may already 400 on a new account.
 * The durable fix is to generate the voice list from `GET /v2/voices` against the
 * real account, the way murf-voices.ts and cartesia-voices.ts already do.
 */
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

/** What the vendor sends when `output_format` is a pcm_* value. */
const ELEVENLABS_SAMPLE_RATE = 24000;

/**
 * How much text must sit in ElevenLabs' buffer before it synthesises. This is an
 * audio QUALITY control, not just a latency one, and lowering it is a trap here
 * for exactly the reason it was on Cartesia.
 *
 * UNLIKE the Cartesia and Murf numbers in their providers, NOTHING below has been
 * measured. There is no ElevenLabs key in this environment. What follows is the
 * vendor's own claim plus this repo's structural argument, and neither is evidence.
 *
 * The vendor's claim, verbatim: the buffer exists "because our model provides
 * higher quality audio when the model has longer inputs, and can deduce more
 * context about how the text should be delivered", and shrinking the schedule
 * "can improve latency at the cost of quality by generating audio more frequently
 * with smaller text inputs". Of `auto_mode` — which "disabl[es] the chunk schedule
 * and all buffers" — it says it is "only recommended when sending full sentences"
 * and that "sending partial sentences will result in highly reduced quality".
 *
 * PipelineSession streams raw LLM tokens with no sentence aggregation upstream.
 * That IS the partial-sentence case the vendor warns against, and it is the same
 * condition under which Cartesia's equivalent knob at 0 rendered every token as
 * its own utterance — 2.6x too much audio with word-isolated prosody. So:
 *
 *   · `auto_mode` is sent explicitly as false — now for a MEASURED reason, below.
 *   · `chunk_length_schedule` opens at 50, the vendor's minimum, not their
 *     default 120. Also measured. The later steps stay at the vendor's values.
 *   · The tail is retrieved with the end-of-stream message instead, which forces
 *     generation of whatever is still buffered without weakening the schedule.
 *
 * ---------------------------------------------------------------------------
 * MEASURED 2026-09-05 — the experiment this comment used to merely ask for
 * ---------------------------------------------------------------------------
 * Method is the one used on Cartesia and Murf: synthesise a fixed 139-character
 * text one-shot for a reference, then stream the same text word by word at
 * ~40ms/word under each setting and compare RENDERED AUDIO DURATION — not TTFB.
 * One-shot reference: 7.71-7.99s. Three trials per setting.
 *
 *   auto_mode = true              TTFB  418ms   rendered 13.70s  = 178%
 *   [120,160,250,290] (default)   TTFB 1286ms   rendered 7.66-8.03s
 *   [50,160,250,290]              TTFB  839ms   rendered 7.66-7.85s
 *   [50,120,160,250]              TTFB  796ms   rendered 7.80-7.94s
 *   [20,50,120,160]               rejected: invalid_generation_config
 *
 * Two findings, both load-bearing:
 *
 *   1. `auto_mode: true` IS the Cartesia fault on this vendor — 178% of the
 *      reference duration, the signature of text fragmented into separately
 *      voiced utterances. The vendor's warning about partial sentences is
 *      accurate and this pipeline is exactly that case. Never turn it on here.
 *   2. Shortening the FIRST step does not reproduce that fault. Every schedule
 *      rendered within 7.66-8.03s — indistinguishable from the one-shot
 *      reference and from each other — while the first step alone moved TTFB by
 *      ~450ms. 50 is a floor: 20 is refused outright.
 *
 * So the first step is lowered and the rest left alone. What this does NOT
 * establish: rendered duration catches word-isolation, the gross fault, and
 * nothing subtler. The vendor still claims longer inputs read better, and no
 * one has listened to these samples side by side. If ElevenLabs prosody is ever
 * suspect, restore 120 as the first step before looking anywhere else.
 */
const CHUNK_LENGTH_SCHEDULE = [50, 160, 250, 290];
const AUTO_MODE = false;

/**
 * `language_code` is documented as "not supported for `multilingual_v2` models",
 * and the v2 (non-.5) Flash/Turbo models are English-only so it buys nothing there.
 * Worse than a 400: on a model that does not take it the parameter is "ignored"
 * silently, which surfaces as audio in the wrong language rather than as an error.
 * So it is sent only where the docs say it is honoured, and dropped otherwise.
 * Behaviour on the v3 family is undocumented; `eleven_v3` is not served by this
 * endpoint at all, so the question does not arise here.
 */
const LANGUAGE_CODE_MODELS = new Set(['eleven_flash_v2_5', 'eleven_turbo_v2_5']);

/**
 * Response shape. Both casings of the terminator are read: the AsyncAPI schema
 * says `isFinal`, the reference page's own example block says `is_final`, and the
 * TTS-vs-TTD page implies camelCase by listing snake_case as a *difference* of the
 * other endpoint. Accepting both is cheaper than probing it.
 *
 * The error fields are NOT in the published schema — it declares only AudioOutput
 * and FinalOutput — so they are a defensive guess at what a rejection looks like.
 * An unrecognised failure still reaches the caller via the socket's own error or
 * an early close.
 */
interface ElevenLabsMessage {
  audio?: string | null;
  isFinal?: boolean | null;
  is_final?: boolean | null;
  error?: string | { message?: string; status?: string };
  message?: string;
  code?: number | string;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = 'elevenlabs-tts';
  readonly name = 'ElevenLabs';

  /** Resolves immediately; the socket connects in the background and text queues. */
  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    const key = opts.credentials.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

    const model = (opts.model || DEFAULT_MODEL).trim();
    // Either a catalog voice or an id typed into the UI; the vendor validates it.
    const voice = opts.voice?.trim() || DEFAULT_VOICE;
    // Overridable so the message handling can be tested against a local fake.
    const wsBase = opts.credentials.ELEVENLABS_WS_BASE ?? DEFAULT_WS_BASE;

    const params = new URLSearchParams({
      model_id: model,
      output_format: `pcm_${ELEVENLABS_SAMPLE_RATE}`,
      auto_mode: String(AUTO_MODE),
    });
    // ISO 639-1 only: `en-IN` is refused vocabulary, `en` is the code.
    const language = opts.language?.trim().split('-')[0].toLowerCase();
    if (language && LANGUAGE_CODE_MODELS.has(model)) params.set('language_code', language);

    // Key goes in the header, not the query string. The endpoint publishes no
    // `xi-api-key` query parameter at all — only `authorization` and
    // `single_use_token`, neither of which applies to a server-side session.
    const ws = new WebSocket(
      `${wsBase.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(voice)}/stream-input?${params}`,
      { headers: { 'xi-api-key': key } },
    );

    let ready = false;
    let cancelled = false;
    let flushed = false;
    let done = false;
    const pending: string[] = [];

    const finish = () => {
      if (done) return;
      done = true;
      events.onDone();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    const emit = (text: string) => {
      if (cancelled || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ text }));
    };

    /** Text sent before the handshake finishes is held so the init frame stays first. */
    const emitOrQueue = (text: string) => {
      if (ready) emit(text);
      else pending.push(text);
    };

    ws.on('open', () => {
      if (cancelled) {
        ws.close();
        return;
      }
      // InitializeConnection. `text` is schema-constrained to the literal single
      // space; `voice_settings` and `generation_config` may only be set here and
      // must not change afterwards, so this is the only frame that carries them.
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            // The schema's own defaults. Both official code examples pass
            // similarity_boost 0.8, but 0.75 is the documented default — the
            // examples are not evidence of what the default is.
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
            // `style` and `use_speaker_boost` are documented as "available on V2+
            // models" only, so they are left off rather than sent to a model that
            // may not take them.
          },
          generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
        }),
      );
      ready = true;
      for (const text of pending) emit(text);
      pending.length = 0;
    });

    ws.on('message', (raw) => {
      if (cancelled) return;
      let msg: ElevenLabsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Keyed on `error` alone. ElevenLabs publishes no error frame in its
      // AsyncAPI schema, so this shape is a guess either way — but treating a
      // bare `code` as fatal means any future frame that happens to carry one
      // aborts a healthy turn and raises an error the vendor never sent.
      // Missing a real error is recoverable here (the socket close still ends
      // the turn); inventing one is not.
      if (msg.error !== undefined) {
        const detail =
          typeof msg.error === 'string'
            ? msg.error
            : msg.error?.message ?? msg.message ?? String(msg.code ?? 'unknown');
        events.onError(new Error(`ElevenLabs TTS error: ${detail}`));
        finish();
        return;
      }

      // `audio` is null on the terminal frame, so guard on truthiness rather than
      // on the key being present — decoding null would emit an empty chunk.
      if (msg.audio) {
        const pcm = stripWavHeader(Buffer.from(msg.audio, 'base64'));
        if (pcm.length > 0) {
          // No-op at 24 kHz; a guard in case the vendor ignores output_format
          // (its unset default is MP3, which would not survive this path).
          events.onAudio(resamplePcm16(pcm, ELEVENLABS_SAMPLE_RATE, opts.sampleRate));
        }
      }

      if (msg.isFinal || msg.is_final) finish();
    });

    ws.on('error', (err) => {
      if (cancelled) return;
      events.onError(new Error(`ElevenLabs TTS socket: ${err.message}`));
      finish();
    });

    ws.on('close', (code, reason) => {
      // A turn that already finished normally set `done` on its terminal frame,
      // so reaching here means the turn did NOT complete.
      if (cancelled || done) return;
      const detail = `${code}${reason.length ? `: ${reason.toString()}` : ''}`;
      /*
       * Two ways this is a failure, and the second one used to be silent.
       *
       * `!flushed` — the socket died mid-turn, before we asked for the tail.
       *
       * An ABNORMAL CLOSE CODE, flushed or not. ElevenLabs publishes no error
       * frame at all; a close code IS its failure channel. Guarding only on
       * `!flushed` meant a real rejection — `1008 quota_exceeded` is the obvious
       * one — arriving after the end-of-stream message produced no error, no
       * audio, and a turn that ended looking successful. And because this
       * provider flushes on the same tick it sends text, that is exactly the
       * window a mid-turn rejection lands in, so the common case was the silent
       * one. A quota failure must not read as a short answer.
       *
       * 1000 after a flush with no terminal frame stays quiet: that is a
       * graceful close, and `finish()` ends the turn either way.
       */
      if (!flushed || code !== 1000) {
        events.onError(new Error(`ElevenLabs TTS closed early (${detail})`));
      }
      finish();
    });

    return {
      pushText(text) {
        if (cancelled || flushed || !text) return;
        // SendText: "Should always end with a single space string." The vendor
        // states no consequence for omitting it, so it is honoured as written.
        //
        // The cost is real and unmeasured: this pipeline pushes raw LLM tokens,
        // so a word split across two tokens ("Hel" + "lo") gets a space wedged
        // into it. Whether that changes the rendered audio is exactly the kind of
        // thing only a probe can answer — do not "fix" it by dropping the space
        // on a hunch either way.
        emitOrQueue(text.endsWith(' ') ? text : `${text} `);
      },
      flush() {
        if (cancelled || flushed) return;
        flushed = true;
        // CloseConnection: `text` is schema-constrained to the literal empty
        // string, and "closing the websocket will automatically force generate
        // any buffered text" — which is what gets the tail out of a reply shorter
        // than the first chunk_length_schedule step without weakening the
        // schedule. (A socket held across turns would instead send
        // `{text:"…", flush:true}` per turn; this provider opens one per turn, so
        // the close message is both the flush and the teardown.)
        emitOrQueue('');
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
