import type { DerivedMetrics, MetricMark, MetricName } from '../shared/protocol.js';
import { pcm16DurationMs } from '../audio/pcm.js';

/**
 * One instance per conversational turn. Records monotonic marks and derives the
 * handful of numbers we actually compare providers on.
 */
export class TurnMetrics {
  readonly turnId: number;
  private readonly t0 = process.hrtime.bigint();
  private readonly marks: MetricMark[] = [];
  private audioBytes = 0;

  constructor(turnId: number) {
    this.turnId = turnId;
  }

  mark(name: MetricName): void {
    if (this.marks.some((m) => m.name === name)) return; // first occurrence wins
    this.marks.push({ name, atMs: this.elapsedMs() });
  }

  countAudio(bytes: number): void {
    this.audioBytes += bytes;
  }

  elapsedMs(): number {
    return Number(process.hrtime.bigint() - this.t0) / 1e6;
  }

  private at(name: MetricName): number | undefined {
    return this.marks.find((m) => m.name === name)?.atMs;
  }

  private delta(from: MetricName, to: MetricName): number | undefined {
    const a = this.at(from);
    const b = this.at(to);
    return a === undefined || b === undefined ? undefined : round(b - a);
  }

  snapshot(): { marks: MetricMark[]; derived: DerivedMetrics } {
    const speechEnd = this.at('user_speech_end') ?? 0;
    const firstAudio = this.at('first_audio_out');

    return {
      marks: this.marks.map((m) => ({ ...m, atMs: round(m.atMs) })),
      derived: {
        timeToFirstAudioMs: firstAudio === undefined ? undefined : round(firstAudio - speechEnd),
        sttLatencyMs: this.delta('user_speech_end', 'stt_final'),
        llmTtftMs: this.delta('llm_request_sent', 'llm_first_token'),
        ttsTtfbMs: this.delta('tts_request_sent', 'tts_first_audio'),
        totalTurnMs: round(this.elapsedMs() - speechEnd),
        audioDurationMs: this.audioBytes ? round(pcm16DurationMs(this.audioBytes)) : undefined,
      },
    };
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
