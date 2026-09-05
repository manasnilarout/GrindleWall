import WebSocket from 'ws';
import type { SttEvents, SttOptions, SttProvider, SttStream } from '../types.js';
import { resamplePcm16 } from '../../audio/pcm.js';
import { SpeechEndDetector } from '../../audio/vad.js';

/**
 * Google Gemini streaming STT, over the Live API's bidi socket.
 *
 *   wss://generativelanguage.googleapis.com/ws/
 *       google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=...
 *
 * **The key travels as a `?key=` query parameter here, not a header.** That
 * contradicts every other adapter in this repo — GeminiLlmProvider deliberately
 * uses `x-goog-api-key` on the REST surface precisely because keys do not belong
 * in URLs — but this path is the exception: Google's own raw-WebSocket sample
 * passes the key on the query string and publishes no header form for it. The
 * header-auth alternative (`Authorization: Token <tok>`) exists only for
 * ephemeral browser tokens minted by POST /v1beta/auth_tokens, against a
 * different endpoint (…BidiGenerateContentConstrained). So: query param, and the
 * URL must never reach a log or the browser — `redactSecrets` covers that.
 *
 * `gemini-3.5-transcribe-live` is bidiGenerateContent-only; there is no REST
 * streaming form of it.
 *
 * Wire shape, in order:
 *   up   {setup:{model:'models/…', generationConfig:{responseModalities:['TEXT']},
 *                inputAudioTranscription:{languageCodes, mode}}}
 *   down {setupComplete:{}}                       <- audio may not be sent before this
 *   up   {realtimeInput:{audio:{data:<base64>, mimeType:'audio/pcm;rate=N'}}}
 *   down {serverContent:{interimInputTranscription:{text}}}   speculative partial
 *   down {serverContent:{inputTranscription:{text}}}          finalized segment
 *   down {serverContent:{turnComplete:true}}                  the utterance boundary
 *
 * `inputAudioTranscription` sits at the TOP LEVEL of `setup`, NOT inside
 * `generationConfig`. The live-transcribe guide puts it top-level; the
 * live-translate guide puts it inside `generationConfig`, and a third-party
 * field report says the runtime rejects that with a 1007 close ("Unknown name …
 * at 'setup.generation_config'"). NOT observed here — no session has ever been
 * opened from this file, so that error string is someone else's evidence, not
 * ours. The docs likewise describe `modelTurn` as carrying model output rather
 * than input transcripts, so the conversational samples' read path should yield
 * nothing on a transcription-only stream; also unconfirmed.
 *
 * ---------------------------------------------------------------------------
 * SPEECH END — a local VAD, on purpose
 * ---------------------------------------------------------------------------
 * t0 for every latency number in this bench is `onSpeechEnd`, so which detector
 * supplies it matters more than anything else in this file.
 *
 * Gemini publishes **no speech-end event**. `speechState` is deprecated in
 * favour of a `VoiceActivity` message whose definition Google has not published,
 * and the only turn-boundary signal actually documented is the *arrival* of a
 * finalized transcript — which lands after the server's own silence timer has
 * expired, i.e. hundreds of milliseconds after the user actually stopped. Using
 * that as t0 would fold the vendor's endpointing delay into every measurement
 * and make Gemini look faster than it is.
 *
 * So this uses the same local `SpeechEndDetector` as Cartesia, gated on
 * `opts.vad`, in what Google's docs call the hybrid arrangement: server VAD
 * still detects speech *start* (with prefix padding, so leading words survive),
 * the local detector calls the end and immediately sends
 * `{realtimeInput:{audioStreamEnd:true}}`. The docs describe that as an
 * "immediate turn finalization prompt, bypassing the default server-side silence
 * wait time" — server VAD stays armed underneath as a fallback if the local one
 * misses. Same t0 definition as every other provider here, different detector.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED LIVE 2026-09-05 — and the observed wire is not quite the documented one
 * ---------------------------------------------------------------------------
 * Round trips from both `elevenlabs-tts` and `gemini-tts` transcribed correctly.
 * First partial ~1.0s; the final lands ~350-560ms after `audioStreamEnd`, which
 * is ~365ms after the local VAD stamps t0. What the live socket actually sends:
 *
 *   << {"setupComplete":{}}
 *   << {"serverContent":{},"voiceActivity":{"type":"ACTIVITY_START","audioOffset":"0.200s"}}
 *   << {"serverContent":{"interimInputTranscription":{"text":"Our refund window is"}}}
 *   >> {"realtimeInput":{"audioStreamEnd":true}}
 *   << {"serverContent":{"inputTranscription":{"text":"...date of purchase."}}}
 *   << {"serverContent":{"generationComplete":true}}
 *   << {"serverContent":{},"voiceActivity":{"type":"ACTIVITY_END","audioOffset":"3.297s"}}
 *
 *   · **`turnComplete` was never observed.** `generationComplete` is what ends
 *     the turn. This file accepts either, which is the only reason it worked on
 *     the first live run — anything keyed solely on `turnComplete` would hang.
 *   · `VoiceActivity`, undocumented when this was written, carries
 *     `{type: ACTIVITY_START|ACTIVITY_END, audioOffset}`. ACTIVITY_END arrives
 *     AFTER the final transcript, so it is still useless as t0 and the local
 *     detector above stands.
 *   · Audio sent after `audioStreamEnd` is accepted, and in a controlled A/B the
 *     run that kept streaming trailing silence got a complete final while the run
 *     that stopped dead got only a truncated interim. `pushAudio` deliberately
 *     does not stop at finalization; do not "fix" that.
 *   · 16 kHz input is what goes up (hence the resample below). Whether the model
 *     would accept another rate is still unverified — there was no reason to ask.
 *
 * The stall this file was written to defend against is real but rare, and it
 * showed up as an abnormal close rather than silence: the socket closed **1006
 * mid-turn, twice**, after several good partials. The old close handler dropped
 * the banked transcript and emitted only an error, which above this layer is not
 * an error but a HANG. The handler now salvages first (see `ws.on('close')`).
 * The 1006 itself did not reproduce on demand — 6/6 idle sessions survived 15s,
 * one survived 120s — so it is recorded as rare and unexplained, and the fix is
 * about not losing a turn when it happens rather than about knowing why.
 */

const DEFAULT_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-3.5-transcribe-live';

/**
 * Rate asked of the vendor. "Input audio is natively 16kHz" and the docs claim
 * the Live API resamples anything else — but that is unconfirmed for this model
 * specifically, so the documented native format is what goes on the wire, and
 * the resample happens here where it can be seen. The mimeType string is built
 * from this same constant so the declared rate and the bytes can never disagree.
 */
const GEMINI_INPUT_SAMPLE_RATE = 16000;

/**
 * How long to wait for `turnComplete` after asking for finalization before
 * emitting whatever text has accumulated.
 *
 * Not a timeout on the vendor's endpointing — t0 was already marked by the local
 * VAD, so this costs no measured latency. It exists because a turn that never
 * receives its boundary would strand the pipeline waiting forever, which is the
 * exact shape of the known stall bug above.
 */
const FINALIZE_FALLBACK_MS = 1500;

/**
 * Cap on audio queued before `setupComplete`. At 16 kHz PCM16 a browser frame
 * is ~20-40ms, so this is a few seconds of speech — enough to cover a normal
 * handshake, bounded if the ack never comes.
 */
const MAX_PENDING_CHUNKS = 200;

interface GeminiTranscription {
  text?: string;
}

interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    interimInputTranscription?: GeminiTranscription;
    inputTranscription?: GeminiTranscription;
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
  };
  goAway?: { timeLeft?: string };
  error?: { message?: string; status?: string; code?: number };
}

export class GeminiSttProvider implements SttProvider {
  readonly id = 'gemini-stt';
  readonly name = 'Google Gemini Transcribe';

  async open(opts: SttOptions, events: SttEvents): Promise<SttStream> {
    const key = opts.credentials.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY is not set');

    const model = opts.model || DEFAULT_MODEL;
    // Overridable so the wire handling can be tested against a local fake.
    const wsBase = opts.credentials.GEMINI_WS_BASE || DEFAULT_WS_BASE;
    const mimeType = `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`;

    const ws = new WebSocket(`${wsBase}?key=${encodeURIComponent(key)}`);

    const vad = new SpeechEndDetector();
    /** True only after `setupComplete`; audio sent before that is rejected. */
    let ready = false;
    let closed = false;
    let awaitingFinal = false;
    let fallback: NodeJS.Timeout | undefined;
    /** Finalized inputTranscription segments accumulated for the current utterance. */
    let segments = '';
    const pending: Buffer[] = [];

    const send = (msg: unknown) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    };

    const sendAudio = (pcm: Buffer) => {
      send({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType } } });
    };

    /**
     * The real utterance boundary: one final per turn, not one per segment.
     *
     * Fires whichever detector got there first — our local VAD via `endTurn`,
     * or Gemini's own endpointing via `turnComplete`. Honouring only OUR
     * detector (an early return on `!awaitingFinal`) dropped every
     * server-called turn on the floor: the accumulated text was never handed
     * on and never cleared, so it was prepended to the NEXT utterance and the
     * LLM leg saw two turns concatenated. The turn then sat until the 1.5s
     * fallback expired — 1.5s of invented latency inside the measured window.
     * `CartesiaSttProvider` emits on `flush_done` unconditionally for the same
     * reason.
     */
    const emitFinal = () => {
      if (fallback) {
        clearTimeout(fallback);
        fallback = undefined;
      }
      const full = segments.trim();
      // Nothing accumulated and no turn of ours outstanding: a bare
      // `turnComplete` between utterances, which is not a boundary at all.
      if (!awaitingFinal && !full) return;
      segments = '';
      vad.reset();
      // The server beat the local detector to it. t0 is stamped here rather
      // than left to fall out of `onFinal`, so the turn opens at the same
      // instant the transcript is handed on. It is a worse t0 than the local
      // VAD's — Gemini's silence timer is folded into it — which is exactly
      // why the local detector is still preferred when it fires first.
      if (!awaitingFinal) events.onSpeechEnd?.();
      awaitingFinal = false;
      events.onFinal(full);
    };

    const endTurn = () => {
      if (closed || awaitingFinal) return;
      awaitingFinal = true;
      // Mark t0 before asking for finalization, never after — the two are
      // separated by a socket write and a vendor round trip.
      events.onSpeechEnd?.();
      send({ realtimeInput: { audioStreamEnd: true } });
      fallback = setTimeout(emitFinal, FINALIZE_FALLBACK_MS);
      fallback.unref?.();
    };

    ws.on('open', () => {
      if (closed) {
        ws.close();
        return;
      }
      // Setup must be the first message on the socket, and audio must wait for
      // its ack — so this goes out here, not in the constructor path.
      send({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            languageCodes: languageCodesFor(opts.language),
            // VERBATIM is the default; SMART rewrites disfluencies, which would
            // change what the LLM leg is handed and is not what a bench wants.
            mode: 'VERBATIM',
          },
        },
      });
    });

    ws.on('message', (raw) => {
      if (closed) return;
      let msg: GeminiServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.error?.message) {
        events.onError(new Error(`Gemini STT: ${msg.error.message}`));
        return;
      }

      if (msg.setupComplete !== undefined) {
        ready = true;
        for (const buf of pending) sendAudio(buf);
        pending.length = 0;
        return;
      }

      const content = msg.serverContent;
      if (!content) return; // goAway, sessionResumptionUpdate, toolCall — none apply here

      const interim = content.interimInputTranscription?.text;
      if (interim) {
        // Speculative and frequently rewritten — shown, never accumulated.
        events.onPartial(`${segments}${interim}`.trim());
      }

      const finalized = content.inputTranscription?.text;
      if (finalized) {
        // A finalized SEGMENT, not a finished turn: Gemini emits one whenever the
        // speaker pauses, so forwarding each as a final would fire an LLM call per
        // pause. Accumulate, and surface progress as a partial instead.
        segments += finalized;
        events.onPartial(segments.trim());
      }

      if (content.turnComplete || content.generationComplete) emitFinal();
    });

    ws.on('error', (err) => {
      if (closed) return;
      events.onError(new Error(`Gemini STT socket: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      /*
       * Salvage before reporting. A turn that is mid-flight when the socket
       * dies has real transcript banked in `segments`, and the pipeline above
       * is blocked on `onFinal` — dropping it here strands that turn forever,
       * which shows up as a hang rather than an error. Observed live: a
       * `gemini-tts -> gemini-stt` round trip closed 1006 after six good
       * partials and the whole utterance was lost. `emitFinal` clears the
       * fallback and is idempotent, so a turn already finalized emits nothing.
       * `close()` sets `closed` first and so never reaches this path — only a
       * server-initiated close salvages.
       */
      if (awaitingFinal || segments.trim()) emitFinal();
      else if (fallback) clearTimeout(fallback);
      if (code !== 1000) {
        events.onError(
          new Error(`Gemini STT closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        );
      }
    });

    return {
      pushAudio(chunk) {
        if (closed || chunk.length === 0) return;
        const wire = resamplePcm16(chunk, opts.sampleRate, GEMINI_INPUT_SAMPLE_RATE);
        // Queued until setupComplete, not merely until the socket opens — audio
        // sent between those two points is dropped by the server.
        if (ready) sendAudio(wire);
        else {
          /*
           * Bounded, unlike the siblings' pre-handshake queues. Those drain on
           * the TCP handshake, which either completes or errors within seconds.
           * This one drains on `setupComplete`, an APPLICATION-level ack that
           * this file's own header documents as sometimes never arriving —
           * the session stays ESTABLISHED and silent. Left unbounded, that
           * stall quietly accumulates ~32 KB/s for the length of the
           * conversation. Dropping the oldest audio keeps the most recent
           * speech, which is what a late `setupComplete` would want anyway.
           */
          pending.push(wire);
          while (pending.length > MAX_PENDING_CHUNKS) pending.shift();
        }

        // VAD runs on the session-boundary audio, at the rate it actually is.
        if (opts.vad && vad.push(chunk, opts.sampleRate) === 'end') endTurn();
      },
      finalize() {
        endTurn();
      },
      close() {
        if (closed) return;
        closed = true;
        if (fallback) clearTimeout(fallback);
        pending.length = 0;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  }
}

/**
 * `inputAudioTranscription.languageCodes` takes BCP-47 **locales**; an empty
 * array means auto-detect with code-switching, which is the documented default.
 *
 * A bare `en` is not a locale, so rather than guess a region — `en-US` and
 * `en-IN` are different models' worth of difference on Indian English — an
 * unqualified tag is dropped and auto-detect does the work.
 */
function languageCodesFor(language: string | undefined): string[] {
  const tag = language?.trim();
  if (!tag || tag === 'auto') return [];
  /*
   * Every shape Google's own transcribe table publishes, which is wider than a
   * two-letter-plus-region tag:
   *
   *   en-US        the common case
   *   ceb          Cebuano — no region subtag at all
   *   es-419       Latin American Spanish — a numeric UN M.49 region
   *   cmn-Hans-CN  script and region
   *   yue-Hant-HK  likewise
   *
   * The earlier pattern required at least one letters-only hyphenated part, so
   * `ceb` and `es-419` failed it and fell through to auto-detect — the user's
   * explicit language choice silently ignored, with no error to explain it.
   * Anything the catalog offers has to be forwarded, or the two disagree.
   */
  // A tag carrying a region is always forwarded. A BARE tag is forwarded only
  // when it is 3+ letters: Google's table lists `ceb` with no region at all,
  // while a bare 2-letter code like `en` is the ambiguous case the original
  // rule existed to reject — `en-US` and `en-IN` are worlds apart on Indian
  // English, and the catalog offers only the qualified forms. So `ceb` and
  // `es-419` now reach the vendor; `en` still falls through to auto-detect.
  return /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,8}(-[A-Za-z0-9]{2,8})*$|^[A-Za-z]{3}$/.test(tag) ? [tag] : [];
}
