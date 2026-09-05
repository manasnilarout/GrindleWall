import { pcm16DurationMs, rms } from './pcm.js';

/**
 * Energy-based speech-end detector.
 *
 * Some vendors (Sarvam Saaras) publish their own `speech_end` event, which is
 * the best possible t0 for a latency measurement. Others (Cartesia) publish
 * none. This gives those providers an equivalent signal so that "the moment the
 * user stopped talking" means the same thing across the bench.
 */
export interface VadOptions {
  /** RMS above which a frame counts as speech (0..1). */
  threshold?: number;
  /** Trailing silence that ends a turn. */
  silenceMs?: number;
  /** Ignore blips shorter than this so a cough is not a turn. */
  minSpeechMs?: number;
}

export type VadState = 'idle' | 'speech' | 'end';

export class SpeechEndDetector {
  private readonly threshold: number;
  private readonly silenceLimit: number;
  private readonly minSpeech: number;

  private speechMs = 0;
  private silenceMs = 0;
  private inSpeech = false;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? 0.012;
    this.silenceLimit = opts.silenceMs ?? 600;
    this.minSpeech = opts.minSpeechMs ?? 250;
  }

  /** Returns 'end' exactly once per utterance, on the speech -> silence edge. */
  push(chunk: Buffer, sampleRate: number): VadState {
    const ms = pcm16DurationMs(chunk.length, sampleRate);

    if (rms(chunk) > this.threshold) {
      this.inSpeech = true;
      this.speechMs += ms;
      this.silenceMs = 0;
      return 'speech';
    }

    if (!this.inSpeech) return 'idle';

    this.silenceMs += ms;
    if (this.silenceMs >= this.silenceLimit) {
      const real = this.speechMs >= this.minSpeech;
      this.reset();
      return real ? 'end' : 'idle';
    }
    return 'speech';
  }

  /** True while the detector believes the user is mid-utterance. */
  get speaking(): boolean {
    return this.inSpeech;
  }

  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
  }
}
