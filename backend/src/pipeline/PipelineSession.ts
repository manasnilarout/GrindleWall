import type {
  LlmHandle,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  SessionContext,
  SttProvider,
  SttStream,
  TtsProvider,
  TtsStream,
  VoiceSession,
} from '../providers/types.js';
import { CANONICAL_SAMPLE_RATE, type LegUsage, type SessionMode } from '../shared/protocol.js';
import { TurnMetrics } from '../metrics/TurnMetrics.js';
import { pcm16DurationMs } from '../audio/pcm.js';

export interface PipelineParts {
  stt: SttProvider;
  sttModel: string;
  llm: LlmProvider;
  llmModel: string;
  tts: TtsProvider;
  ttsModel: string;
}

/**
 * Vendors report token counts a beat after the stream ends, so a turn that
 * finishes early (a TTS failure, say) waits briefly for the real numbers rather
 * than falling back to a character estimate that can be off by two orders of
 * magnitude.
 */
const LLM_SETTLE_GRACE_MS = 750;

/** Below this, trailing mic audio isn't worth a record of its own. */
const MIN_TAIL_SECONDS = 0.25;

/**
 * One conversational turn: its clock and everything it consumed.
 *
 * `pending` means t0 is marked and we are waiting to learn what the user said —
 * it may still be abandoned (silence, an interrupt) without ever being billed.
 * `running` means the LLM and TTS legs are in flight and the turn is real.
 *
 * The three legs bill in three different units, so each is counted in the unit
 * its vendor actually meters:
 *
 *   STT  seconds of audio streamed in  (silence included — vendors bill it)
 *   LLM  tokens, vendor-reported where the API returns them
 *   TTS  characters of text sent to be synthesised
 */
interface Turn {
  id: number;
  metrics: TurnMetrics;
  phase: 'pending' | 'running';
  sttBytes: number;
  ttsChars: number;
  llm?: LlmUsage;
  /** Character counts, used only to estimate tokens when the vendor reports none. */
  llmInChars: number;
  llmOutChars: number;
  /** The LLM leg has finished, so its usage (if any) has arrived. */
  llmSettled: boolean;
  drained: boolean;
  /** A drain that is waiting on the LLM leg to settle. */
  drainTimer?: NodeJS.Timeout;
  drainAudioMs?: number;
}

/**
 * STT -> LLM -> TTS wired into the same VoiceSession surface a native
 * speech-to-speech provider implements, so the frontend and the metrics are
 * identical across both architectures.
 */
export class PipelineSession implements VoiceSession {
  readonly mode: SessionMode = 'pipeline';
  readonly label: string;

  private sttStream?: SttStream;
  private ttsStream?: TtsStream;
  private llmHandle?: LlmHandle;

  private history: LlmMessage[] = [];
  private turnCounter = 0;
  private turn?: Turn;
  private assistantText = '';
  private speaking = false;
  private closed = false;

  /**
   * Mic audio arrives continuously and before a turn exists, so bytes bank here
   * and are attributed to whichever turn they precede. A turn that is abandoned
   * hands its bytes back, so nothing is billed twice and nothing is lost.
   */
  private sttBytesPending = 0;

  constructor(
    readonly id: string,
    private readonly ctx: SessionContext,
    private readonly parts: PipelineParts,
  ) {
    this.label = `${parts.stt.id}:${parts.sttModel} → ${parts.llm.id}:${parts.llmModel} → ${parts.tts.id}:${parts.ttsModel}`;
    if (ctx.config.systemPrompt.trim()) {
      this.history.push({ role: 'system', content: ctx.config.systemPrompt });
    }
  }

  async start(): Promise<void> {
    const { events, config, credentials } = this.ctx;

    this.sttStream = await this.parts.stt.open(
      {
        model: this.parts.sttModel,
        language: config.sttLanguage ?? config.language,
        sampleRate: CANONICAL_SAMPLE_RATE,
        credentials,
        vad: config.turnDetection === 'server_vad',
      },
      {
        onPartial: (text) => {
          // Barge-in: the user started talking over the answer, so drop it.
          if (this.speaking) this.interrupt();
          this.turn?.metrics.mark('stt_first_partial');
          events.onUserTranscript(text, false, this.turn?.id ?? 0);
        },
        onFinal: (text) => {
          if (!text.trim()) {
            // Silence, or a false endpoint. Give the audio back to the next
            // turn instead of stranding a turn that will never run — otherwise
            // every later turn is billed the previous utterance's seconds and
            // its clock starts at the wrong moment.
            this.abandonTurn();
            return;
          }
          this.beginTurn();
          this.turn!.metrics.mark('stt_final');
          events.onUserTranscript(text, true, this.turn!.id);
          void this.runTurn(text);
        },
        onSpeechEnd: () => {
          this.beginTurn();
        },
        onError: (err) => events.onError(err),
      },
    );

    events.onLog('info', `pipeline ready: ${this.label}`);
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed) return;
    // Counted only once it is actually handed to the vendor: the socket accepts
    // audio from the moment it opens, which is before start() has resolved.
    if (!this.sttStream) return;
    this.sttStream.pushAudio(chunk);
    this.sttBytesPending += chunk.length;
  }

  commitAudio(): void {
    if (this.closed) return;
    this.beginTurn();
    this.sttStream?.finalize();
  }

  sendText(text: string): void {
    if (this.closed || !text.trim()) return;
    this.beginTurn();
    this.turn!.metrics.mark('stt_final');
    this.ctx.events.onUserTranscript(text, true, this.turn!.id);
    void this.runTurn(text);
  }

  interrupt(): void {
    this.abortLlm();
    this.ttsStream?.cancel();
    this.ttsStream = undefined;

    const turn = this.turn;
    if (turn?.phase === 'running') {
      // It was cut off, but the vendors were still paid for what they produced.
      this.requestDrain(turn.id);
    } else if (turn) {
      // Never ran, so billing it would invent a turn out of an interrupt.
      this.abandonTurn();
    }

    if (this.speaking) {
      this.speaking = false;
      this.ctx.events.onTurnEnd(turn?.id ?? 0);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.interrupt();
    this.flushTail();
    this.sttStream?.close();
    this.sttStream = undefined;
  }

  /** Called the moment the user stops talking — t0 for every latency number. */
  private beginTurn(): void {
    // New input arriving over a live answer is barge-in, whatever the transport.
    if (this.turn?.phase === 'running') this.interrupt();
    if (this.turn) return; // already pending — same turn, second signal

    this.turnCounter += 1;
    const metrics = new TurnMetrics(this.turnCounter);
    metrics.mark('user_speech_end');
    this.turn = {
      id: this.turnCounter,
      metrics,
      phase: 'pending',
      sttBytes: this.sttBytesPending,
      ttsChars: 0,
      llmInChars: 0,
      llmOutChars: 0,
      llmSettled: false,
      drained: false,
    };
    this.sttBytesPending = 0;
  }

  /** Drops a turn that never ran, returning its audio to the next one. */
  private abandonTurn(): void {
    const turn = this.turn;
    if (!turn || turn.phase === 'running') return;
    clearTimeout(turn.drainTimer);
    this.sttBytesPending += turn.sttBytes;
    this.turnCounter -= 1; // the id was never used, so don't burn it
    this.turn = undefined;
  }

  private async runTurn(userText: string): Promise<void> {
    const { events, config, credentials } = this.ctx;
    const turn = this.turn!;
    turn.phase = 'running';
    const turnId = turn.id;
    const { metrics } = turn;

    this.history.push({ role: 'user', content: userText });
    this.assistantText = '';
    this.speaking = true;
    events.onTurnStart(turnId);

    try {
      // Marked before open() so that vendor connection setup is counted in the
      // TTS number instead of silently inflating time-to-first-audio.
      metrics.mark('tts_request_sent');
      this.ttsStream = await this.parts.tts.open(
        {
          model: this.parts.ttsModel,
          voice: config.voice,
          language: config.ttsLanguage ?? config.language,
          sampleRate: CANONICAL_SAMPLE_RATE,
          credentials,
        },
        {
          onAudio: (chunk) => {
            metrics.mark('tts_first_audio');
            metrics.mark('first_audio_out');
            metrics.countAudio(chunk.length);
            events.onAudio(chunk);
          },
          onDone: () => this.finishTurn(turnId),
          onError: (err) => {
            events.onError(err);
            this.finishTurn(turnId);
          },
        },
      );

      turn.llmInChars = this.history.reduce((n, m) => n + m.content.length, 0);

      metrics.mark('llm_request_sent');
      this.llmHandle = this.parts.llm.stream(
        { model: this.parts.llmModel, temperature: config.temperature, credentials },
        this.history,
        {
          onDelta: (text) => {
            if (this.turn?.id !== turnId) return;
            metrics.mark('llm_first_token');
            this.assistantText += text;
            events.onAssistantTranscript(this.assistantText, false, turnId);
            // Counted here rather than inside the TTS provider: this is the text
            // the vendor is billed for, whatever it then does with buffering.
            turn.ttsChars += text.length;
            // Tracked per delta so a turn cut short still reports what it made.
            turn.llmOutChars += text.length;
            this.ttsStream?.pushText(text);
          },
          onUsage: (usage) => {
            if (this.turn?.id === turnId) turn.llm = usage;
          },
          onDone: (full) => {
            if (this.turn?.id !== turnId) {
              // The turn was already closed out; don't corrupt the history.
              this.settleLlm(turnId);
              return;
            }
            metrics.mark('llm_last_token');
            this.assistantText = full || this.assistantText;
            events.onAssistantTranscript(this.assistantText, true, turnId);
            this.history.push({ role: 'assistant', content: this.assistantText });
            turn.llmOutChars = this.assistantText.length;
            this.settleLlm(turnId);
            this.ttsStream?.flush();
          },
          onError: (err) => {
            events.onError(err);
            this.settleLlm(turnId);
            this.ttsStream?.flush();
          },
        },
      );
    } catch (err) {
      events.onError(err as Error);
      this.finishTurn(turnId);
    }
  }

  private finishTurn(turnId: number): void {
    if (!this.speaking || this.turn?.id !== turnId) return;
    const { metrics } = this.turn;
    metrics.mark('last_audio_out');
    const { marks, derived } = metrics.snapshot();
    this.speaking = false;
    // The answer is over, so anything still generating is pure waste — and its
    // late onDone would otherwise push a second assistant message into history.
    this.abortLlm();
    this.ctx.events.onTurnEnd(turnId);
    this.ctx.events.onMetrics(turnId, marks, derived);
    this.requestDrain(turnId, derived.audioDurationMs);
    this.ttsStream?.close();
    this.ttsStream = undefined;
  }

  private abortLlm(): void {
    this.llmHandle?.abort();
    this.llmHandle = undefined;
  }

  /** The LLM leg is done, so any vendor usage it was going to report has arrived. */
  private settleLlm(turnId: number): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.llmSettled) return;
    turn.llmSettled = true;
    if (turn.drainTimer) {
      clearTimeout(turn.drainTimer);
      turn.drainTimer = undefined;
      this.emitUsage(turn, turn.drainAudioMs);
    }
  }

  /**
   * Bills the turn, waiting briefly for the LLM leg to report real token counts.
   * Without the wait, a turn that ends before the model does falls back to a
   * character estimate and undercounts the leg that dominates cost.
   */
  private requestDrain(turnId: number, audioMs?: number): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.drained) return;

    if (!turn.llmSettled && !turn.drainTimer) {
      turn.drainAudioMs = audioMs;
      turn.drainTimer = setTimeout(() => {
        turn.drainTimer = undefined;
        this.emitUsage(turn, audioMs);
      }, LLM_SETTLE_GRACE_MS);
      // Don't hold the process open for a turn nobody is waiting on.
      turn.drainTimer.unref?.();
      return;
    }
    this.emitUsage(turn, audioMs);
  }

  /** Emits a turn's consumption exactly once. */
  private emitUsage(turn: Turn, audioMs?: number): void {
    if (turn.drained) return;
    turn.drained = true;
    clearTimeout(turn.drainTimer);
    turn.drainTimer = undefined;
    if (this.turn === turn) this.turn = undefined;

    const vendor = turn.llm;
    const llm: LegUsage = vendor
      ? {
          leg: 'llm',
          providerId: this.parts.llm.id,
          modelId: this.parts.llmModel,
          unit: 'tokens',
          inputUnits: vendor.inputTokens ?? 0,
          outputUnits: vendor.outputTokens ?? 0,
          thinkingTokens: vendor.thinkingTokens,
          cachedInputTokens: vendor.cachedInputTokens,
          source: 'vendor',
        }
      : {
          leg: 'llm',
          providerId: this.parts.llm.id,
          modelId: this.parts.llmModel,
          unit: 'tokens',
          // ~4 characters per token. Only reached when the vendor reports nothing
          // (mock providers, or a turn aborted before the model finished);
          // flagged 'local' so a guess is never displayed as a measurement.
          inputUnits: Math.round(turn.llmInChars / 4),
          outputUnits: Math.round(turn.llmOutChars / 4),
          source: 'local',
        };

    this.ctx.events.onUsage(turn.id, [
      this.sttLeg(turn.sttBytes),
      llm,
      {
        leg: 'tts',
        providerId: this.parts.tts.id,
        modelId: this.parts.ttsModel,
        unit: 'characters',
        inputUnits: 0,
        outputUnits: turn.ttsChars,
        audioSeconds: audioMs === undefined ? undefined : round(audioMs / 1000, 3),
        source: 'local',
      },
    ]);
  }

  /**
   * Audio streamed after the last turn is still metered by the STT vendor, so
   * it is reported rather than quietly dropped. It carries only an STT leg,
   * which is what marks it as a tail rather than a turn.
   */
  private flushTail(): void {
    const seconds = pcm16DurationMs(this.sttBytesPending) / 1000;
    if (seconds < MIN_TAIL_SECONDS) return;
    const bytes = this.sttBytesPending;
    this.sttBytesPending = 0;
    this.turnCounter += 1;
    this.ctx.events.onLog(
      'info',
      `${seconds.toFixed(1)}s of audio reached ${this.parts.stt.id} after the last turn; billed separately.`,
    );
    this.ctx.events.onUsage(this.turnCounter, [this.sttLeg(bytes)]);
  }

  private sttLeg(bytes: number): LegUsage {
    return {
      leg: 'stt',
      providerId: this.parts.stt.id,
      modelId: this.parts.sttModel,
      unit: 'audio_seconds',
      inputUnits: round(pcm16DurationMs(bytes) / 1000, 3),
      outputUnits: 0,
      source: 'local',
    };
  }
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));
