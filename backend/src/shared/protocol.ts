/**
 * Wire protocol shared by backend and frontend.
 * Audio always travels as raw binary frames (PCM16 LE mono @ CANONICAL_SAMPLE_RATE).
 * Everything else travels as JSON text frames.
 */

export const CANONICAL_SAMPLE_RATE = 24000;

export type SessionMode = 'realtime' | 'pipeline';

/** Client -> Server */
export type ClientMessage =
  | { type: 'start'; config: StartConfig }
  | { type: 'user_text'; text: string }
  | { type: 'commit_audio' }
  | { type: 'interrupt' }
  /** Finish the conversation: close the providers, then bill and persist it. */
  | { type: 'end_conversation' }
  /** Drop the session without asking for a summary. */
  | { type: 'stop' };

export interface StartConfig {
  mode: SessionMode;
  /** realtime mode */
  realtimeProviderId?: string;
  realtimeModelId?: string;
  /** pipeline mode */
  sttProviderId?: string;
  sttModelId?: string;
  llmProviderId?: string;
  llmModelId?: string;
  ttsProviderId?: string;
  ttsModelId?: string;

  systemPrompt: string;
  voice?: string;
  temperature?: number;
  /** Realtime providers, and the fallback for either pipeline leg. */
  language?: string;
  /** Pipeline legs can differ, e.g. auto-detect in, Hindi out. */
  sttLanguage?: string;
  ttsLanguage?: string;
  turnDetection: 'server_vad' | 'manual';
}

/** Server -> Client */
export type ServerMessage =
  | { type: 'session_started'; sessionId: string; mode: SessionMode; sampleRate: number; label: string }
  /** `turnId` is 0 for speech heard before a turn has been opened. */
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; turnId: number }
  | { type: 'turn_start'; turnId: number }
  | { type: 'turn_end'; turnId: number }
  | { type: 'metrics'; turnId: number; marks: MetricMark[]; derived: DerivedMetrics }
  | { type: 'usage'; turnId: number; usage: TurnUsage }
  | { type: 'session_summary'; summary: SessionSummary }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'session_closed'; reason?: string };

export type MetricName =
  | 'user_speech_end'
  | 'stt_first_partial'
  | 'stt_final'
  | 'llm_request_sent'
  | 'llm_first_token'
  | 'llm_last_token'
  | 'tts_request_sent'
  | 'tts_first_audio'
  | 'first_audio_out'
  | 'last_audio_out';

export interface MetricMark {
  name: MetricName;
  /** ms since the turn started */
  atMs: number;
}

export interface DerivedMetrics {
  /** end of user speech -> first audio byte sent to client. The number that matters. */
  timeToFirstAudioMs?: number;
  sttLatencyMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
  totalTurnMs?: number;
  audioDurationMs?: number;
}

/* ------------------------------- usage & cost ------------------------------- */

export type LegName = 'stt' | 'llm' | 'tts' | 'realtime';

/**
 * The three vendors bill in three different units, so the unit travels with the
 * number. Only the LLM leg is denominated in tokens — reporting TTS characters
 * or STT audio seconds as "tokens" would be a fiction.
 */
export type UsageUnit = 'tokens' | 'characters' | 'audio_seconds';

export interface LegUsage {
  leg: LegName;
  providerId: string;
  modelId: string;
  unit: UsageUnit;
  /** Prompt tokens / seconds of audio sent. */
  inputUnits: number;
  /** Completion tokens / characters synthesised. */
  outputUnits: number;
  /** Reported separately by Gemini. Billed at the output rate and already counted in outputUnits. */
  thinkingTokens?: number;
  /** Billed at the (cheaper) cache rate, and already counted in inputUnits. */
  cachedInputTokens?: number;
  /** Seconds of audio the TTS leg produced. Not what it is billed on, but the quality/latency denominator. */
  audioSeconds?: number;
  /** 'vendor' — the API reported these counts. 'local' — this process counted them. */
  source: 'vendor' | 'local';
  cost?: LegCost;
  /** Set when no rate is on file, so the total is known to be an undercount. */
  unpricedReason?: string;
}

export interface LegCost {
  /** In `currency`, which is the currency the vendor actually publishes. */
  amount: number;
  currency: string;
  /**
   * The same cost in both comparison currencies. One of the two is `amount`
   * exactly; the other went through the assumed FX rate, and `currency` says
   * which is which so a converted figure is never mistaken for a quoted one.
   */
  amountUsd: number;
  amountInr: number;
  /** The arithmetic, spelled out: "₹30 / 10K chars". */
  rate: string;
  /** 'verified' — read off the vendor's own pricing page. 'ambiguous' — sources disagree. */
  confidence: 'verified' | 'ambiguous';
  note?: string;
}

export interface TurnUsage {
  turnId: number;
  /** Epoch ms at which the turn completed. */
  at: number;
  legs: LegUsage[];
  costUsd: number;
  costInr: number;
  /** Names of legs with no rate on file. Non-empty means the cost is a floor, not a total. */
  unpriced: string[];
}

export interface SessionSummary {
  /** Stable id of the persisted record, not the transient socket id. */
  recordId: string;
  sessionId: string;
  mode: SessionMode;
  label: string;
  config: StartConfig;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turnCount: number;
  /** One row per leg, summed over every turn. */
  totals: LegUsage[];
  costUsd: number;
  costInr: number;
  unpriced: string[];
  turns: TurnUsage[];
  latency: {
    ttfaMedianMs?: number;
    ttfaP95Ms?: number;
    ttfaMinMs?: number;
    ttfaMaxMs?: number;
  };
  /**
   * The FX rate every conversion above used, so a stale rate is visible rather
   * than baked invisibly into the numbers.
   */
  usdPerInr: number;
}

/** Row shape of GET /api/sessions. */
export interface SessionIndexEntry {
  recordId: string;
  label: string;
  mode: SessionMode;
  startedAt: number;
  endedAt: number;
  turnCount: number;
  costUsd: number;
  costInr: number;
  unpriced: string[];
}
