import type { DerivedMetrics, LegUsage, MetricMark, SessionMode, StartConfig } from '../shared/protocol.js';

/** Emitted by every session kind, so the transport layer never knows which provider it talks to. */
export interface SessionEvents {
  /** `turnId` is 0 when speech is heard before a turn has been opened. */
  onUserTranscript(text: string, final: boolean, turnId: number): void;
  onAssistantTranscript(text: string, final: boolean, turnId: number): void;
  /** PCM16 LE mono @ CANONICAL_SAMPLE_RATE */
  onAudio(chunk: Buffer): void;
  onTurnStart(turnId: number): void;
  onTurnEnd(turnId: number): void;
  /** Emitted once per completed turn. */
  onMetrics(turnId: number, marks: MetricMark[], derived: DerivedMetrics): void;
  /**
   * What the turn consumed, one row per pipeline leg, unpriced. Costing happens
   * above this layer so providers never need to know what anything is worth.
   */
  onUsage(turnId: number, legs: LegUsage[]): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
  onError(err: Error): void;
}

/** The single surface the WS layer drives. Realtime and pipeline both implement it. */
export interface VoiceSession {
  readonly id: string;
  readonly mode: SessionMode;
  /** Human-readable description of what is actually wired up, e.g. "deepgram:nova-3 -> openai:gpt-4o -> elevenlabs:eleven_flash_v2_5" */
  readonly label: string;
  start(): Promise<void>;
  pushAudio(chunk: Buffer): void;
  /** Manual turn detection: user released the mic. */
  commitAudio(): void;
  sendText(text: string): void;
  interrupt(): void;
  close(): Promise<void>;
}

export interface SessionContext {
  sessionId: string;
  config: StartConfig;
  events: SessionEvents;
  credentials: Credentials;
}

export type Credentials = Record<string, string | undefined>;

/* ---------------- realtime (speech-to-speech, single provider) ---------------- */

export interface RealtimeProvider {
  readonly id: string;
  readonly name: string;
  createSession(ctx: SessionContext): VoiceSession;
}

/* ---------------- pipeline pieces ---------------- */

export interface SttEvents {
  onPartial(text: string): void;
  onFinal(text: string): void;
  /** Server-side VAD reported the user stopped talking. */
  onSpeechEnd?(): void;
  onError(err: Error): void;
}

export interface SttStream {
  pushAudio(chunk: Buffer): void;
  /** Flush and force a final transcript. */
  finalize(): void;
  close(): void;
}

export interface SttProvider {
  readonly id: string;
  readonly name: string;
  open(opts: SttOptions, events: SttEvents): Promise<SttStream>;
}

export interface SttOptions {
  model: string;
  language?: string;
  sampleRate: number;
  credentials: Credentials;
  /** Ask the provider for endpointing/VAD rather than relying on client commits. */
  vad: boolean;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmEvents {
  onDelta(text: string): void;
  onDone(full: string): void;
  /**
   * Vendor-reported token counts. Optional because not every LLM API returns
   * them; when it is missing the pipeline falls back to a local estimate and
   * marks the row as such rather than quietly reporting a guess as fact.
   */
  onUsage?(usage: LlmUsage): void;
  onError(err: Error): void;
}

/**
 * Token counts exactly as the vendor reports them.
 *
 * Two invariants a provider MUST honour, because pricing depends on them and
 * nothing can detect a violation:
 *
 *   `outputTokens` INCLUDES `thinkingTokens`. Vendors that report reasoning
 *   separately (Gemini's `thoughtsTokenCount`) bill it at the output rate, so
 *   fold it in — `thinkingTokens` is a breakdown, not an addend. Reporting it
 *   only in `thinkingTokens` means it is never billed at all.
 *
 *   `inputTokens` INCLUDES `cachedInputTokens`. Pricing subtracts the cached
 *   portion and charges it at the cache rate; if it were not included, the
 *   cached tokens would be billed twice.
 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Reasoning tokens, where the vendor separates them. Already inside outputTokens. */
  thinkingTokens?: number;
  /** Portion served from cache, billed at the cache rate. Already inside inputTokens. */
  cachedInputTokens?: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  stream(opts: LlmOptions, messages: LlmMessage[], events: LlmEvents): LlmHandle;
}

export interface LlmOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  credentials: Credentials;
}

export interface LlmHandle {
  abort(): void;
}

export interface TtsEvents {
  /** PCM16 LE mono @ CANONICAL_SAMPLE_RATE */
  onAudio(chunk: Buffer): void;
  onDone(): void;
  onError(err: Error): void;
}

export interface TtsProvider {
  readonly id: string;
  readonly name: string;
  /** Should start emitting audio as early as possible; text may arrive incrementally. */
  open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream>;
}

export interface TtsOptions {
  model: string;
  voice?: string;
  /** BCP-47-ish tag, e.g. "en-IN". Required by some vendors (Sarvam), ignored by others. */
  language?: string;
  sampleRate: number;
  credentials: Credentials;
}

export interface TtsStream {
  /** Feed partial text as the LLM streams. */
  pushText(text: string): void;
  /** No more text for this turn. */
  flush(): void;
  /** Barge-in: drop everything queued. */
  cancel(): void;
  close(): void;
}
