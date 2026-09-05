import { CANONICAL_SAMPLE_RATE } from '../lib/protocol';

/**
 * Gapless PCM16 playback with a small jitter buffer. Also reports the wall-clock
 * moment the first sample is actually audible, which is the honest end of the
 * latency measurement.
 */
export class AudioSink {
  private ctx?: AudioContext;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private analyser?: AnalyserNode;
  private levelData?: Uint8Array<ArrayBuffer>;

  /** Seconds of lead time; keeps playback from stuttering on jittery sockets. */
  private readonly jitterBuffer = 0.08;

  /**
   * Reports the wall-clock moment the first sample of a turn became audible,
   * tagged with the turn it belongs to.
   *
   * The tag is not decoration. This fires from a `setTimeout` scheduled for the
   * jitter-buffer lead, so it is always late relative to the frame that
   * triggered it — late enough that a short turn's metrics can arrive first, and
   * a barge-in can cancel the audio entirely before it lands. Without a tag the
   * caller cannot tell "the number for this turn" from "a number left over from
   * the last one", and a leftover reads as a measurement.
   */
  onFirstAudible?: (token: number) => void;
  private awaitingFirst = false;
  /** Bumped whenever the turn being awaited changes, invalidating pending timers. */
  private turnToken = 0;

  /** The turn currently being awaited. A report tagged otherwise is stale. */
  get currentToken(): number {
    return this.turnToken;
  }

  async resume(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: CANONICAL_SAMPLE_RATE, latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
      this.levelData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    }
    await this.ctx.resume();
  }

  /** Call at the start of each assistant turn so onFirstAudible fires once per turn. */
  expectTurn(): void {
    this.awaitingFirst = true;
    this.turnToken += 1;
  }

  enqueue(pcm16: ArrayBuffer): void {
    if (!this.ctx || !this.analyser) return;
    const view = new Int16Array(pcm16);
    if (view.length === 0) return;

    const buffer = this.ctx.createBuffer(1, view.length, CANONICAL_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < view.length; i++) channel[i] = view[i] / 0x8000;

    const now = this.ctx.currentTime;
    if (this.playHead < now + this.jitterBuffer / 2) this.playHead = now + this.jitterBuffer;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);

    if (this.awaitingFirst) {
      this.awaitingFirst = false;
      const delayMs = Math.max(0, (this.playHead - now) * 1000);
      // Captured now, read later: if the turn moves on before this fires, the
      // token no longer matches and the report is dropped rather than credited
      // to whichever turn happens to be open.
      const token = this.turnToken;
      window.setTimeout(() => this.onFirstAudible?.(token), delayMs);
    }

    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    src.start(this.playHead);
    this.playHead += buffer.duration;
  }

  /** Barge-in / interrupt: drop everything scheduled but not yet played. */
  flush(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.playHead = this.ctx?.currentTime ?? 0;
    this.awaitingFirst = false;
    // A barge-in cancels the audio but not the timer already scheduled for it.
    // Bumping the token is what stops that timer reporting a time-to-audible
    // for a reply that was cut off before anyone heard it.
    this.turnToken += 1;
  }

  /** 0..1 output level, for a speaking indicator. */
  level(): number {
    if (!this.analyser || !this.levelData) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let peak = 0;
    for (const v of this.levelData) peak = Math.max(peak, Math.abs(v - 128) / 128);
    return peak;
  }

  get queuedSeconds(): number {
    return Math.max(0, this.playHead - (this.ctx?.currentTime ?? 0));
  }

  async close(): Promise<void> {
    this.flush();
    await this.ctx?.close();
    this.ctx = undefined;
  }
}
