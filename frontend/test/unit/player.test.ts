import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioSink } from '../../src/audio/player';

/* ------------------------------ Web Audio fake ------------------------------ */

class FakeBuffer {
  readonly data: Float32Array;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAnalyser {
  fftSize = 2048;
  frequencyBinCount = 4;
  timeDomain = new Uint8Array([128, 128, 128, 128]);
  connect = vi.fn();
  getByteTimeDomainData(out: Uint8Array) {
    out.set(this.timeDomain);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  destination = { kind: 'destination' };
  analyser = new FakeAnalyser();
  sources: FakeSource[] = [];
  buffers: FakeBuffer[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor(readonly options: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser() {
    return this.analyser;
  }
  createBuffer(channels: number, length: number, rate: number) {
    const b = new FakeBuffer(channels, length, rate);
    this.buffers.push(b);
    return b;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const pcm = (...samples: number[]) => new Int16Array(samples).buffer;
/** `n` samples at 24 kHz. */
const frames = (n: number) => new Int16Array(n).buffer;

let sink: AudioSink;
let ctx: () => FakeAudioContext;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  sink = new AudioSink();
  ctx = () => FakeAudioContext.instances.at(-1)!;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AudioSink.resume', () => {
  it('creates one 24 kHz interactive context with an analyser on the output', async () => {
    await sink.resume();
    await sink.resume();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx().options).toEqual({ sampleRate: 24_000, latencyHint: 'interactive' });
    expect(ctx().analyser.fftSize).toBe(256);
    expect(ctx().analyser.connect).toHaveBeenCalledWith(ctx().destination);
    expect(ctx().resume).toHaveBeenCalledTimes(2);
  });
});

describe('AudioSink.enqueue', () => {
  it('does nothing before resume', () => {
    expect(() => sink.enqueue(pcm(1, 2, 3))).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('ignores an empty frame', async () => {
    await sink.resume();
    sink.enqueue(new ArrayBuffer(0));
    expect(ctx().buffers).toHaveLength(0);
    expect(ctx().sources).toHaveLength(0);
  });

  it('converts PCM16 to floats in [-1, 1) at the canonical rate', async () => {
    await sink.resume();
    sink.enqueue(pcm(0, 16384, -32768, 32767, -1));
    const [buffer] = ctx().buffers;
    expect(buffer.sampleRate).toBe(24_000);
    expect(buffer.numberOfChannels).toBe(1);
    expect([...buffer.data]).toEqual([0, 0.5, -1, 32767 / 32768, -1 / 32768].map((v) => Math.fround(v)));
  });

  it('routes each source through the analyser', async () => {
    await sink.resume();
    sink.enqueue(frames(10));
    expect(ctx().sources[0].connect).toHaveBeenCalledWith(ctx().analyser);
    expect(ctx().sources[0].buffer).toBe(ctx().buffers[0]);
  });

  it('starts the first chunk one jitter buffer ahead, then plays gaplessly', async () => {
    await sink.resume();
    ctx().currentTime = 10;
    sink.enqueue(frames(2400)); // 100 ms
    sink.enqueue(frames(1200)); // 50 ms
    const [a, b] = ctx().sources;
    expect(a.start.mock.calls[0][0]).toBeCloseTo(10.08, 9);
    expect(b.start.mock.calls[0][0]).toBeCloseTo(10.18, 9);
    expect(sink.queuedSeconds).toBeCloseTo(0.23, 9);
  });

  it('re-anchors after an underrun instead of scheduling in the past', async () => {
    await sink.resume();
    sink.enqueue(frames(240)); // plays 0.08 -> 0.09
    ctx().currentTime = 5;
    sink.enqueue(frames(240));
    expect(ctx().sources[1].start.mock.calls[0][0]).toBeCloseTo(5.08, 9);
  });

  it('keeps the schedule while the lead is at least half the jitter buffer', async () => {
    await sink.resume();
    sink.enqueue(frames(2400)); // 0.08 -> 0.18
    ctx().currentTime = 0.135; // lead 0.045: above half the jitter buffer
    sink.enqueue(frames(240));
    expect(ctx().sources[1].start.mock.calls[0][0]).toBeCloseTo(0.18, 9);
    ctx().currentTime = 0.1801; // lead now below half
    sink.enqueue(frames(240));
    expect(ctx().sources[2].start.mock.calls[0][0]).toBeCloseTo(0.2601, 9);
  });

  it('never reports a negative queue', async () => {
    expect(sink.queuedSeconds).toBe(0);
    await sink.resume();
    sink.enqueue(frames(240));
    ctx().currentTime = 100;
    expect(sink.queuedSeconds).toBe(0);
  });
});

describe('AudioSink first-audible reporting', () => {
  it('reports once per turn, when the first sample is due, tagged with the turn', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.expectTurn();
    expect(sink.currentToken).toBe(1);
    sink.enqueue(frames(2400));
    sink.enqueue(frames(2400));
    vi.advanceTimersByTime(79);
    expect(heard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(10_000);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('does not report without expectTurn', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.enqueue(frames(240));
    vi.runAllTimers();
    expect(heard).not.toHaveBeenCalled();
  });

  it('delays by the real lead when audio is already queued', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.enqueue(frames(24_000)); // one second already queued
    sink.expectTurn();
    sink.enqueue(frames(240));
    vi.advanceTimersByTime(1079);
    expect(heard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledWith(1);
  });

  it('a report that lands after a flush carries a stale token', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.expectTurn();
    sink.enqueue(frames(240));
    sink.flush();
    expect(sink.currentToken).toBe(2);
    vi.runAllTimers();
    expect(heard).toHaveBeenCalledWith(1);
    expect(heard.mock.calls[0][0]).not.toBe(sink.currentToken);
  });

  it('a new turn invalidates the previous turn\'s pending report', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.expectTurn();
    sink.enqueue(frames(240));
    sink.expectTurn();
    sink.enqueue(frames(240));
    vi.runAllTimers();
    expect(heard.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(sink.currentToken).toBe(2);
  });

  it('flush cancels the wait for a first frame', async () => {
    const heard = vi.fn();
    sink.onFirstAudible = heard;
    await sink.resume();
    sink.expectTurn();
    sink.flush();
    sink.enqueue(frames(240));
    vi.runAllTimers();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('AudioSink.flush', () => {
  it('stops everything scheduled and rewinds the play head', async () => {
    await sink.resume();
    sink.enqueue(frames(2400));
    sink.enqueue(frames(2400));
    ctx().currentTime = 0.1;
    sink.flush();
    for (const s of ctx().sources) expect(s.stop).toHaveBeenCalledTimes(1);
    expect(sink.queuedSeconds).toBe(0);
    sink.enqueue(frames(240));
    expect(ctx().sources[2].start.mock.calls[0][0]).toBeCloseTo(0.18, 9);
  });

  it('tolerates a source that is already stopped', async () => {
    await sink.resume();
    sink.enqueue(frames(240));
    sink.enqueue(frames(240));
    ctx().sources[0].stop.mockImplementation(() => {
      throw new Error('InvalidStateError');
    });
    expect(() => sink.flush()).not.toThrow();
    expect(ctx().sources[1].stop).toHaveBeenCalled();
  });

  it('does not stop a source that already ended', async () => {
    await sink.resume();
    sink.enqueue(frames(240));
    const [s] = ctx().sources;
    s.onended?.();
    sink.flush();
    expect(s.stop).not.toHaveBeenCalled();
  });

  it('is safe before resume', () => {
    expect(() => sink.flush()).not.toThrow();
    expect(sink.currentToken).toBe(1);
  });
});

describe('AudioSink.level', () => {
  it('is 0 before resume', () => {
    expect(sink.level()).toBe(0);
  });

  it('reports the peak deviation from the 128 midpoint', async () => {
    await sink.resume();
    expect(sink.level()).toBe(0);
    ctx().analyser.timeDomain = new Uint8Array([128, 160, 96, 128]);
    expect(sink.level()).toBe(0.25);
    ctx().analyser.timeDomain = new Uint8Array([0, 128, 128, 255]);
    expect(sink.level()).toBe(1);
  });
});

describe('AudioSink.close', () => {
  it('flushes, closes the context, and starts afresh on the next resume', async () => {
    await sink.resume();
    sink.enqueue(frames(240));
    const first = ctx();
    await sink.close();
    expect(first.sources[0].stop).toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledTimes(1);
    sink.enqueue(frames(240));
    expect(first.sources).toHaveLength(1);
    await sink.resume();
    expect(FakeAudioContext.instances).toHaveLength(2);
  });

  it('is safe before resume', async () => {
    await expect(sink.close()).resolves.toBeUndefined();
  });
});
