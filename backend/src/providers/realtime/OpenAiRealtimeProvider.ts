import WebSocket from 'ws';
import type { RealtimeProvider, SessionContext, VoiceSession } from '../types.js';
import { CANONICAL_SAMPLE_RATE, type LegUsage, type SessionMode } from '../../shared/protocol.js';
import { TurnMetrics } from '../../metrics/TurnMetrics.js';
import { pcm16DurationMs, resamplePcm16 } from '../../audio/pcm.js';

/**
 * OpenAI Realtime — native speech-to-speech over one WebSocket.
 *
 *   wss://api.openai.com/v1/realtime?model=<model-id>
 *   header: Authorization: Bearer <OPENAI_API_KEY>
 *
 * ---------------------------------------------------------------------------
 * VERIFIED LIVE 2026-09-05, both halves of a speech-to-speech turn:
 *
 *   · text in  — `node scripts/smoke.mjs realtime` on `gpt-realtime-2.1-mini`
 *   · SPEECH in — `npm run realtime:probe` on `gpt-realtime-2.1`, which streams
 *     real synthesised speech in at real time. First audio 955ms after commit;
 *     the vendor transcribed the input and reported 30 of 58 input tokens as
 *     audio and 76 of 120 output tokens as audio, which priced correctly.
 *
 * The audio-in path needs its own check because `smoke.mjs` sends a TEXT turn
 * and so never bills a single audio input token — a realtime leg billed
 * entirely at the text rate understates the turn ~8x while still looking like
 * a number. The nested GA `session.update` shape below is therefore confirmed
 * accepted, not merely documented.
 *
 * `npm run openai:realtime:selftest` still exercises this file against a fake
 * server written to agree with it, so it proves this module's event handling
 * and nothing about what OpenAI accepts.
 * ---------------------------------------------------------------------------
 *
 * Two things about the wire that cost other integrations a live error:
 *
 * 1. `session.update` is the NESTED GA shape. The flat beta form
 *    (`session.input_audio_format`, `session.voice`, `session.modalities`) was
 *    removed from the API on 2026-05-12. Audio config lives under
 *    `session.audio.input` / `session.audio.output`, and `session.type` is a
 *    required literal `"realtime"`. OpenAI's own conversations guide still
 *    documents the dead flat names for the INPUT leg two paragraphs above where
 *    it documents the GA names for the output leg; the schema wins.
 *
 * 2. `format` is an OBJECT, not the string `"pcm16"`:
 *    `{ type: 'audio/pcm', rate: 24000 }`. The schema's `rate` is an enum of
 *    exactly `[24000]` ("The sample rate of the audio. Always `24000`."), and
 *    the µ-law / A-law variants (`audio/pcmu`, `audio/pcma`) carry no `rate`
 *    property at all. So 24 kHz PCM is not a preference here, it is the only
 *    PCM option — which happens to be exactly this bench's boundary format.
 *
 * `OpenAI-Beta: realtime=v1` is NOT sent. Evidence: the migration guide says
 * verbatim "Remove the `OpenAI-Beta: realtime=v1` header when calling the GA
 * interface", and the deprecations page lists that header under "2025-09-15:
 * Realtime API Beta" with a shutdown date of 2026-05-12 and the statement that
 * the beta "was deprecated and removed from the API on May 12, 2026". No doc
 * says what the server does if you send it anyway, so the safe move is to omit
 * it rather than to find out.
 *
 * Barge-in deliberately does NOT send `output_audio_buffer.clear`: the API
 * reference flags that event, and its `output_audio_buffer.*` server replies,
 * as WebRTC/SIP only. Over a WebSocket there is no server-side output buffer —
 * the bytes are already in this process — so the pair that actually matters is
 * `response.cancel` (stop generating) plus `conversation.item.truncate` (tell
 * the model how much of its own answer the user actually heard). See interrupt().
 */

const PROVIDER_ID = 'openai-realtime';
const DEFAULT_WS_BASE = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-2.1';
/** Docs recommend marin/cedar over the eight older voices. */
const DEFAULT_VOICE = 'marin';

/** The only rate the `audio/pcm` format variant accepts, in both directions. */
const OPENAI_SAMPLE_RATE = 24000;

/**
 * Sent explicitly because the two official sources disagree: the schema
 * docstring says the default is 500ms, while a real `session.created` payload in
 * the server-events reference shows 200. Relying on either is relying on a coin
 * flip about how long t0 lags true speech-end.
 */
const SILENCE_DURATION_MS = 500;
const PREFIX_PADDING_MS = 300;
const VAD_THRESHOLD = 0.5;

/**
 * ASR for the user's own words. The speech-to-speech model consumes audio
 * natively and never produces a user transcript of its own, so without this the
 * bench shows only one side of the conversation.
 *
 * Two consequences worth knowing: it is a SEPARATE model on a SEPARATE rate card
 * (per minute of audio, not per token), which this provider does not meter —
 * only the realtime leg is billed below, so an OpenAI invoice will read slightly
 * higher than this bench's total. And OpenAI itself says the transcript "may
 * diverge somewhat from the model's interpretation, and should be treated as a
 * rough guide" — it is not ground truth for what the model heard.
 */
const TRANSCRIPTION_MODEL = 'gpt-transcribe';

/** Anything else in `config.voice` is treated as a custom `{id}` voice. */
const BUILT_IN_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);

const HANDSHAKE_TIMEOUT_MS = 15_000;

/** `response.done.response.usage`, exactly as the reference documents it. */
interface RealtimeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number; image_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

interface ServerEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  item_id?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    status_details?: { reason?: string };
    usage?: RealtimeUsage;
  };
  error?: { type?: string; code?: string; message?: string; param?: string | null };
}

/**
 * One conversational turn. It outlives `onTurnEnd` on purpose: a turn cut short
 * by barge-in still gets a `response.done` carrying its token counts a moment
 * later, and dropping the turn at end-of-turn would throw that bill away.
 */
interface Turn {
  turnId: number;
  metrics: TurnMetrics;
  /** Bound at `response.created`, so a late `response.done` finds its own turn. */
  responseId?: string;
  /** The assistant message item the audio belongs to; `conversation.item.truncate` needs it. */
  itemId?: string;
  audioBytes: number;
  ended: boolean;
  billed: boolean;
  /**
   * OpenAI streams transcripts as FRAGMENTS, but `SessionEvents` is a
   * cumulative channel — the browser replaces the current utterance with each
   * non-final it receives (see `pushUtterance` in useVoiceSession), so
   * forwarding raw deltas makes the caption flicker one word at a time instead
   * of growing. Every other session here sends the whole string so far;
   * these accumulate it so this one does too.
   */
  assistantText: string;
  userText: string;
}

class OpenAiRealtimeSession implements VoiceSession {
  readonly mode: SessionMode = 'realtime';
  readonly label: string;

  /**
   * The catalog's model id, `@variant` and all — that is what the UI picked and
   * what the usage row should say. `wireModel` is the same id with the variant
   * stripped, because the suffix is this repo's encoding for reasoning depth and
   * is not a model id OpenAI would accept.
   */
  private readonly modelId: string;
  private readonly wireModel: string;
  private readonly effort?: string;

  /**
   * Realtime providers get no per-session sample rate the way TtsOptions does,
   * so the boundary constant is read once here rather than assumed at each call
   * site. Everything that resamples goes through it, so the module stays correct
   * if the boundary is ever reconfigured away from 24 kHz.
   */
  private readonly sessionRate = CANONICAL_SAMPLE_RATE;

  private ws?: WebSocket;
  private ready?: { resolve: () => void; reject: (err: Error) => void };
  private turnCounter = 0;
  private active?: Turn;
  /** Ended-but-unbilled turns, oldest first. Drained by `response.done` or `close()`. */
  private readonly awaitingUsage: Turn[] = [];
  private closed = false;

  constructor(
    readonly id: string,
    private readonly ctx: SessionContext,
  ) {
    this.modelId = ctx.config.realtimeModelId || DEFAULT_MODEL;
    const [base, variant] = this.modelId.split('@');
    this.wireModel = base;
    this.effort = variant;
    this.label = `${PROVIDER_ID}:${this.modelId}`;
  }

  /**
   * Opens the socket and waits for the server to acknowledge our configuration.
   *
   * A realtime session is one socket per CONVERSATION, not per turn, so unlike
   * the TTS providers there is no handshake sitting inside a turn's clock to
   * measure — and equally nothing to gain by pre-connecting. Resolving on
   * `session.updated` rather than `session.created` means a config the server
   * rejects fails `start()` loudly instead of silently falling back to the
   * server defaults (which are a different voice and a different VAD hangover).
   */
  async start(): Promise<void> {
    const key = this.ctx.credentials.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');

    const base = this.ctx.credentials.OPENAI_WS_BASE || DEFAULT_WS_BASE;
    const url = `${base}${base.includes('?') ? '&' : '?'}model=${encodeURIComponent(this.wireModel)}`;

    // The key travels in a header, never in the query string: URLs end up in
    // logs and in `redactSecrets`'s blind spot on the vendor's side too.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    this.ws = ws;

    ws.on('open', () => this.sendSessionUpdate());
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', (err) => {
      const e = new Error(`OpenAI Realtime socket: ${err.message}`);
      if (this.ready) this.settle(e);
      else if (!this.closed) this.ctx.events.onError(e);
    });
    ws.on('close', (code, reason) => {
      const detail = `${code}${reason.length ? `: ${reason.toString()}` : ''}`;
      if (this.ready) {
        this.settle(new Error(`OpenAI Realtime closed during handshake (${detail})`));
        return;
      }
      if (this.closed) return;
      this.ctx.events.onError(new Error(`OpenAI Realtime closed unexpectedly (${detail})`));
      // The socket is gone, so no `response.done` is coming for whatever was in
      // flight. Bill it from what we have rather than losing the turn.
      this.flushBilling('socket closed before the vendor reported usage');
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(new Error('OpenAI Realtime handshake timed out')),
        HANDSHAKE_TIMEOUT_MS,
      );
      // Must not hold the event loop open: a script that finishes while a
      // handshake is still pending would otherwise hang for the full timeout.
      // `PipelineSession` unrefs its drain timer for the same reason.
      timer.unref?.();
      this.ready = {
        resolve: () => {
          clearTimeout(timer);
          this.ready = undefined;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.ready = undefined;
          reject(err);
        },
      };
    });
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;

    // No-op at 24 kHz — the bench boundary and the only PCM rate OpenAI's format
    // variant accepts are the same number. It stays as a guard so that the rate
    // is read from the boundary rather than assumed, matching every other
    // adapter here; if the boundary ever moves, this converts instead of
    // shipping the wrong rate as if it were right.
    const pcm = resamplePcm16(chunk, this.sessionRate, OPENAI_SAMPLE_RATE);

    // Forwarded frame-for-frame with no aggregation. The server's VAD is what
    // sets t0 for every latency number in this bench, and OpenAI says smaller
    // appends let it react sooner; batching up to the 15 MiB event cap would buy
    // nothing and blunt the one measurement that matters.
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /**
   * Manual turn detection: the user released the mic.
   *
   * This is t0 in manual mode, and it is the same instant server VAD reports as
   * `speech_stopped` — the detector differs, the definition does not. With
   * `turn_detection: null` the server sends no speech events at all, so nothing
   * else in this file could supply it.
   */
  commitAudio(): void {
    if (this.closed) return;
    if (this.ctx.config.turnDetection === 'server_vad') {
      // The server commits and responds on its own; a second commit would either
      // error on an empty buffer or cut the user off mid-word.
      return;
    }
    this.beginTurn();
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
  }

  sendText(text: string): void {
    if (this.closed || !text.trim()) return;
    // Typed input has no speech to end, so the moment the text is handed over is
    // the honest t0 — the same event the user would otherwise have produced by
    // falling silent.
    const turn = this.beginTurn();
    this.ctx.events.onUserTranscript(text, true, turn.turnId);
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    // Needed even under server VAD: VAD only auto-responds to audio.
    this.send({ type: 'response.create' });
  }

  /**
   * Barge-in. Everything here is synchronous — the sink upstream has already
   * stopped, and any delta still arriving for this turn is dropped by the
   * `ended` flag rather than played late.
   */
  interrupt(): void {
    const turn = this.active;
    if (!turn || turn.ended) return;

    // Audio already forwarded to the client will not be heard past this point.
    if (turn.audioBytes > 0) this.ctx.events.onInterrupt?.();

    // Stops generation. Safe to fire blind: "It's safe to call `response.cancel`
    // even if no response is in progress, an error will be returned [and] the
    // session will remain unaffected."
    this.send({ type: 'response.cancel', ...(turn.responseId ? { response_id: turn.responseId } : {}) });

    // Reconciles the model's memory with what the user actually heard. Without
    // it the model believes it said the whole sentence and answers the next turn
    // accordingly. `audio_end_ms` is the audio we FORWARDED, which is an upper
    // bound on what was played — the sink's true playback position never travels
    // back to this process — but it is never more than the server generated, and
    // exceeding that is the one value the docs say is rejected.
    if (turn.itemId && turn.audioBytes > 0) {
      this.send({
        type: 'conversation.item.truncate',
        item_id: turn.itemId,
        content_index: 0, // "Set this to 0." — the docs are emphatic.
        audio_end_ms: Math.floor(pcm16DurationMs(turn.audioBytes, this.sessionRate)),
      });
    }

    // The turn is over for the user now. Billing is not: `response.done` is
    // "always emitted, no matter the final state", cancelled included, and it
    // carries the token counts this turn actually consumed. Ending without
    // waiting for it would report every barge-in as free.
    this.endTurn(turn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.active && !this.active.ended) this.endTurn(this.active);
    // Anything still waiting on a `response.done` will never get one.
    this.flushBilling('session closed before the vendor reported usage');
    const ws = this.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    this.ws = undefined;
  }

  /* ------------------------------- wire ------------------------------- */

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  /** The nested GA session shape. See the header for what the flat one cost. */
  private sendSessionUpdate(): void {
    const { config } = this.ctx;
    const voice = config.voice?.trim() || DEFAULT_VOICE;
    // ISO-639-1 only; the UI can hand out "en-IN".
    const language = config.language?.split('-')[0];

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime', // required literal, and the field the beta shape lacked
        model: this.wireModel,
        // "It is not possible to request both text and audio at the same time" —
        // audio already comes with a transcript, so asking for text loses speech.
        output_modalities: ['audio'],
        instructions: config.systemPrompt,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: OPENAI_SAMPLE_RATE },
            transcription: { model: TRANSCRIPTION_MODEL, ...(language ? { language } : {}) },
            turn_detection: this.turnDetectionConfig(),
          },
          output: {
            format: { type: 'audio/pcm', rate: OPENAI_SAMPLE_RATE },
            // A built-in name goes as a string; anything else is assumed to be a
            // custom voice id, which the schema takes as an object.
            voice: BUILT_IN_VOICES.has(voice) ? voice : { id: voice },
          },
        },
        // Only sent when the catalog id actually carried a `@variant`. Which
        // efforts each realtime model accepts is NOT documented per model, so no
        // variant should reach catalog.ts without a live probe behind it.
        ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
      },
    });
  }

  /**
   * `null` disables turn detection entirely, which is what 'manual' means here:
   * this process then owns commit and response.create. Under server VAD both
   * booleans stay true so the vendor drives the turn — including cancelling its
   * own in-flight response the instant the user speaks over it, which is faster
   * than any round trip we could make.
   */
  private turnDetectionConfig(): Record<string, unknown> | null {
    if (this.ctx.config.turnDetection !== 'server_vad') return null;
    return {
      type: 'server_vad',
      threshold: VAD_THRESHOLD,
      prefix_padding_ms: PREFIX_PADDING_MS,
      silence_duration_ms: SILENCE_DURATION_MS,
      create_response: true,
      interrupt_response: true,
    };
  }

  private onMessage(raw: string): void {
    let msg: ServerEvent;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'session.created':
        break; // configuration is acknowledged by session.updated, not this

      case 'session.updated':
        this.ready?.resolve();
        break;

      case 'input_audio_buffer.speech_started':
        // Under server VAD the vendor has already cancelled whatever it was
        // saying (`interrupt_response: true`), so this is a notification, not a
        // request: stop forwarding its audio, but do not send `response.cancel`
        // for a response the server has itself cancelled.
        if (this.active && !this.active.ended) this.endTurn(this.active);
        break;

      case 'input_audio_buffer.speech_stopped':
        // t0. The single most load-bearing line in this file: every latency
        // number the bench prints is measured from here. Vendor server-side VAD
        // supplies it, exactly as Sarvam's `vad.speech_end` does on the pipeline
        // side — same definition, different detector.
        //
        // Its `audio_end_ms` is deliberately ignored: it is session-relative and
        // inclusive of the VAD hangover, so it is not comparable with the
        // monotonic clock every other provider here is measured on.
        this.beginTurn();
        break;

      case 'response.created':
        this.bindResponse(msg.response?.id);
        break;

      case 'response.output_audio.delta':
        this.onAudioDelta(msg);
        break;

      case 'response.output_audio.done':
        // Carries no audio, only the fact that there is no more of it.
        if (this.active && !this.active.ended) this.active.metrics.mark('last_audio_out');
        break;

      case 'response.output_audio_transcript.delta': {
        const turn = this.ownerOf(msg);
        if (msg.delta && turn) {
          turn.assistantText += msg.delta;
          this.ctx.events.onAssistantTranscript(turn.assistantText, false, turn.turnId);
        }
        break;
      }

      case 'response.output_audio_transcript.done':
        if (msg.transcript !== undefined) {
          this.ctx.events.onAssistantTranscript(msg.transcript, true, this.turnIdFor(msg));
        }
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (msg.delta) {
          this.active?.metrics.mark('stt_first_partial');
          if (this.active) this.active.userText += msg.delta;
          this.ctx.events.onUserTranscript(this.active?.userText ?? msg.delta, false, this.active?.turnId ?? 0);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Marked so the ASR add-on's latency is visible next to the s2s number.
        // It may simply be absent: transcription "runs asynchronously with
        // Response creation", so it can land after the turn's snapshot is taken.
        this.active?.metrics.mark('stt_final');
        // The speech-to-speech model emits no user transcript of its own, so
        // this is the ONLY final the user side ever gets. Without it the
        // browser keeps rendering the last partial as provisional forever.
        if (msg.transcript !== undefined) {
          if (this.active) this.active.userText = msg.transcript;
          this.ctx.events.onUserTranscript(msg.transcript, true, this.active?.turnId ?? 0);
        }
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this.ctx.events.onLog('warn', `OpenAI Realtime input transcription failed: ${msg.error?.message ?? 'unknown'}`);
        break;

      case 'response.done':
        this.onResponseDone(msg);
        break;

      case 'error':
        // "Most errors are recoverable and the session will stay open" — surface
        // it and keep going rather than tearing the conversation down. The layer
        // above scrubs the message before it reaches the browser.
        this.ctx.events.onError(
          new Error(`OpenAI Realtime ${msg.error?.code ?? msg.error?.type ?? 'error'}: ${msg.error?.message ?? 'unknown'}`),
        );
        if (this.ready) this.settle(new Error(`OpenAI Realtime rejected the session: ${msg.error?.message ?? 'unknown'}`));
        break;

      default:
        break; // committed, cleared, item lifecycle, rate_limits.updated, ...
    }
  }

  private onAudioDelta(msg: ServerEvent): void {
    // Matched on response id, not just "whatever turn is open": a delta from a
    // superseded response must be dropped rather than played and attributed to
    // the turn that replaced it. See `ownerOf`.
    const turn = this.ownerOf(msg);
    // A delta for a turn the user already talked over is discarded, not played.
    if (!turn || turn.ended || !msg.delta) return;
    if (msg.item_id) turn.itemId = msg.item_id;

    const pcm = resamplePcm16(Buffer.from(msg.delta, 'base64'), OPENAI_SAMPLE_RATE, this.sessionRate);
    if (pcm.length === 0) return;

    turn.metrics.mark('first_audio_out');
    turn.metrics.countAudio(pcm.length);
    turn.audioBytes += pcm.length;
    this.ctx.events.onAudio(pcm);
  }

  private onResponseDone(msg: ServerEvent): void {
    const responseId = msg.response?.id ?? msg.response_id;
    const turn = this.turnFor(responseId);
    if (!turn) return;

    if (!turn.ended) this.endTurn(turn);
    this.bill(turn, msg.response?.usage);
  }

  /* ------------------------------ turns ------------------------------ */

  /** Opens a turn and stamps t0. Never called from anywhere but a speech-end. */
  private beginTurn(): Turn {
    // A turn already open means the previous one never saw its response finish;
    // close it out so its metrics are still reported rather than overwritten.
    if (this.active && !this.active.ended) this.endTurn(this.active);

    this.turnCounter += 1;
    const metrics = new TurnMetrics(this.turnCounter);
    metrics.mark('user_speech_end');
    const turn: Turn = {
      turnId: this.turnCounter,
      metrics,
      audioBytes: 0,
      ended: false,
      billed: false,
      assistantText: '',
      userText: '',
    };
    this.active = turn;
    this.ctx.events.onTurnStart(turn.turnId);
    return turn;
  }

  /**
   * `response.created` is the first sight of the response id, which is how a
   * `response.done` arriving after barge-in finds the turn it belongs to.
   *
   * If it arrives with no turn open, the server started talking on its own —
   * `idle_timeout_ms`, or a response nothing here asked for. Opening a turn now
   * keeps the audio and the bill attached to something, but t0 is then the
   * response start rather than a speech end, so the log says so instead of
   * quietly publishing a latency number measured from the wrong instant.
   */
  private bindResponse(responseId?: string): void {
    if (!this.active || this.active.ended) {
      this.ctx.events.onLog('warn', 'OpenAI Realtime started a response with no turn open; t0 is the response start, not a speech end');
      this.beginTurn();
    }
    if (this.active && responseId) this.active.responseId = responseId;
  }

  /** Emits the turn's metrics exactly once. Billing is separate and may lag. */
  private endTurn(turn: Turn): void {
    if (turn.ended) return;
    turn.ended = true;
    if (turn.audioBytes > 0) turn.metrics.mark('last_audio_out');
    const snap = turn.metrics.snapshot();
    if (this.active === turn) this.active = undefined;
    if (!turn.billed) this.awaitingUsage.push(turn);
    this.ctx.events.onTurnEnd(turn.turnId);
    this.ctx.events.onMetrics(turn.turnId, snap.marks, snap.derived);
  }

  /**
   * Emits the turn's usage exactly once, however the turn ended — completed,
   * cancelled by barge-in, or cut off by close(). One row, because a realtime
   * session has one leg; `unit: 'tokens'` because that is what OpenAI bills it
   * in, with the audio portion carried separately since audio tokens cost ~8x
   * text tokens in the same response.
   */
  private bill(turn: Turn, usage?: RealtimeUsage, missingReason?: string): void {
    if (turn.billed) return;
    turn.billed = true;
    const idx = this.awaitingUsage.indexOf(turn);
    if (idx >= 0) this.awaitingUsage.splice(idx, 1);

    const input = usage?.input_token_details;
    const output = usage?.output_token_details;

    const leg: LegUsage = {
      leg: 'realtime',
      providerId: PROVIDER_ID,
      modelId: this.modelId,
      unit: 'tokens',
      // The containment rules from LlmUsage hold here as they do everywhere: a
      // total INCLUDES its breakdown. `input_tokens` already contains the audio
      // and the cached portions, and `cached_tokens` is documented as "a SUBSET
      // of input tokens". Pricing subtracts, so adding them here would bill the
      // same tokens twice.
      inputUnits: usage?.input_tokens ?? 0,
      outputUnits: usage?.output_tokens ?? 0,
      cachedInputTokens: input?.cached_tokens,
      audioInputTokens: input?.audio_tokens,
      audioOutputTokens: output?.audio_tokens,
      cachedAudioInputTokens: input?.cached_tokens_details?.audio_tokens,
      audioSeconds: round(pcm16DurationMs(turn.audioBytes, this.sessionRate) / 1000, 3),
      source: usage ? 'vendor' : 'local',
    };

    /*
     * A turn that never ran is abandoned, not billed.
     *
     * The clearest way in is manual turn detection: `commitAudio()` opens the
     * turn before the commit is acknowledged, and a buffer holding under 100ms
     * of audio is refused with `input_audio_buffer_commit_empty` — no response
     * is ever created. A user tapping and releasing the mic without speaking
     * produces exactly that. The same shape appears if the socket dies between
     * opening a turn and the vendor doing anything with it.
     *
     * Emitting a row here would put a turn on the invoice that consumed
     * nothing, and `PipelineSession` makes the same distinction explicitly with
     * its `pending` phase and `abandonTurn()`. `onTurnEnd`/`onMetrics` still
     * fire so the transport's turn_start is balanced; only the billing row is
     * withheld.
     */
    const neverRan = !usage && turn.responseId === undefined && turn.audioBytes === 0;
    if (neverRan) {
      this.ctx.events.onLog('info', `turn ${turn.turnId} produced no response and was not billed`);
      return;
    }

    if (!usage) {
      // Ran, but the vendor never reported what it cost. Nothing was counted, so
      // nothing is claimed — a zero row without this would price the turn at
      // exactly zero and let the session total pass itself off as complete.
      leg.unpricedReason = missingReason ?? 'OpenAI Realtime reported no usage for this turn';
    }

    this.ctx.events.onUsage(turn.turnId, [leg]);
  }

  /** Bills every turn that will never see its `response.done`. */
  private flushBilling(reason: string): void {
    for (const turn of [...this.awaitingUsage]) this.bill(turn, undefined, reason);
  }

  private turnFor(responseId?: string): Turn | undefined {
    if (responseId) {
      if (this.active?.responseId === responseId) return this.active;
      const match = this.awaitingUsage.find((t) => t.responseId === responseId);
      if (match) return match;
      /*
       * A LABELLED event whose response we no longer hold. It belongs to a
       * response already billed and retired — a duplicate or late
       * `response.done` — and it is not this turn's business.
       *
       * Falling back to `this.active` here billed the CURRENTLY OPEN turn with
       * the retired response's token counts, and ended it early, so its metrics
       * snapshot was taken before its own audio had arrived. Two turns, one
       * set of numbers, and the live one corrupted. The one exception is a turn
       * whose `response.created` never landed, which therefore has nothing to
       * match on: that one can still legitimately claim a labelled event.
       */
      return this.active?.responseId === undefined ? this.active : undefined;
    }
    // Nothing to match on: the active turn if there is one, else the oldest
    // turn still waiting to be billed.
    return this.active ?? this.awaitingUsage[0];
  }

  /**
   * Strict owner lookup for STREAMED content — audio and transcript deltas.
   *
   * Unlike `turnFor`, this never falls back to the active turn. A response the
   * user has moved past keeps streaming for a while (`sendText()` mid-answer
   * opens a new turn without cancelling the old one, and barge-in leaves ~500ms
   * between `speech_started` and `speech_stopped`), and every one of its late
   * deltas would otherwise land on the NEW turn: `first_audio_out` would be
   * marked by the previous answer's audio, making the bench's headline
   * time-to-first-audio near-zero and measured against the wrong response;
   * `audioBytes` would be credited to the wrong usage row; `itemId` would be
   * overwritten so a later `interrupt()` truncates the wrong conversation item;
   * and the user would hear the tail of an answer they interrupted.
   */
  private ownerOf(msg: ServerEvent): Turn | undefined {
    const responseId = msg.response_id ?? msg.response?.id;
    const active = this.active;
    // Unlabelled event, or a turn whose `response.created` has not landed yet:
    // there is nothing to disambiguate on, so the active turn is the best guess.
    if (!responseId) return active;
    if (active && (active.responseId === undefined || active.responseId === responseId)) return active;
    // Belongs to a response already closed out. Its bill is still tracked in
    // `awaitingUsage`, but its content is no longer wanted.
    return undefined;
  }

  private turnIdFor(msg: ServerEvent): number {
    const responseId = msg.response_id ?? msg.response?.id;
    return this.turnFor(responseId)?.turnId ?? this.active?.turnId ?? 0;
  }

  /**
   * Fails the handshake AND tears the socket down.
   *
   * `session-socket` handles a rejected `start()` by dropping its reference to
   * the session; it never calls `close()`, because a session that failed to
   * start has nothing to close in any other provider here — the pipeline ones
   * build their socket inside `open()` and cannot reject once it exists.
   *
   * Without this, a rejected start left the vendor socket connected with every
   * handler still bound to `ctx.events`: the browser was told the session
   * failed and then went on receiving `turn_start` and assistant transcripts
   * from it, while OpenAI kept metering. Marking `closed` also stops the
   * `close` handler from firing a second, contradictory error at the client.
   */
  private settle(err: Error): void {
    const pending = this.ready;
    this.closed = true;
    this.ready = undefined;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    pending?.reject(err);
  }
}

export class OpenAiRealtimeProvider implements RealtimeProvider {
  readonly id = PROVIDER_ID;
  readonly name = 'OpenAI Realtime';

  createSession(ctx: SessionContext): VoiceSession {
    return new OpenAiRealtimeSession(ctx.sessionId, ctx);
  }
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));
