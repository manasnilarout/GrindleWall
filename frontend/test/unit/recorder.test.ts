import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MicRecorder } from '../../src/audio/recorder';

/* ------------------------------ Web Audio fake ------------------------------ */

const calls: string[] = [];

class FakeTrack {
  stop = vi.fn(() => calls.push('track.stop'));
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeNode {
  connect = vi.fn(<T>(next: T) => next);
  disconnect = vi.fn();
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  port = { onmessage: null as ((e: { data: unknown }) => void) | null, close: vi.fn() };
  constructor(
    readonly context: FakeAudioContext,
    readonly name: string,
  ) {
    super();
    FakeWorkletNode.instances.push(this);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static addModule = vi.fn(async (_url: string) => {
    calls.push('addModule');
  });
  sampleRate = 24_000;
  destination = new FakeNode();
  source = new FakeNode();
  gain = Object.assign(new FakeNode(), { gain: { value: 1 } });
  audioWorklet = { addModule: (url: string) => FakeAudioContext.addModule(url) };
  close = vi.fn(async () => {
    calls.push('ctx.close');
  });
  streamSeen: unknown;
  constructor(readonly options: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(stream: unknown) {
    this.streamSeen = stream;
    return this.source;
  }
  createGain() {
    return this.gain;
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let blobs: Blob[];
let revoked: string[];

beforeEach(() => {
  calls.length = 0;
  FakeAudioContext.instances = [];
  FakeWorkletNode.instances = [];
  FakeAudioContext.addModule.mockReset().mockImplementation(async () => {
    calls.push('addModule');
  });
  blobs = [];
  revoked = [];
  getUserMedia = vi.fn(async () => new FakeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return `blob:worklet/${blobs.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
    calls.push('revoke');
  });
});

const ctx = () => FakeAudioContext.instances.at(-1)!;
const node = () => FakeWorkletNode.instances.at(-1)!;

describe('MicRecorder.start', () => {
  it('asks for one processed mic channel', async () => {
    await new MicRecorder().start({ onFrame: () => {} });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  });

  it('opens a 24 kHz interactive context and loads the inline worklet', async () => {
    await new MicRecorder().start({ onFrame: () => {} });
    expect(ctx().options).toEqual({ sampleRate: 24_000, latencyHint: 'interactive' });
    expect(FakeAudioContext.addModule).toHaveBeenCalledWith('blob:worklet/1');
    expect(blobs[0].type).toBe('application/javascript');
    expect(await blobs[0].text()).toContain("registerProcessor('capture', CaptureProcessor)");
    expect(revoked).toEqual(['blob:worklet/1']);
    expect(calls).toEqual(['addModule', 'revoke']);
  });

  it('wires mic -> capture node -> muted gain -> destination', async () => {
    await new MicRecorder().start({ onFrame: () => {} });
    expect(ctx().streamSeen).toBeInstanceOf(FakeStream);
    expect(node().name).toBe('capture');
    expect(node().context).toBe(ctx());
    expect(ctx().source.connect).toHaveBeenCalledWith(node());
    expect(node().connect).toHaveBeenCalledWith(ctx().gain);
    expect(ctx().gain.connect).toHaveBeenCalledWith(ctx().destination);
    expect(ctx().gain.gain.value).toBe(0);
  });

  it('forwards worklet frames and levels', async () => {
    const onFrame = vi.fn();
    const onLevel = vi.fn();
    await new MicRecorder().start({ onFrame, onLevel });
    const buf = new Int16Array([1, 2, 3]).buffer;
    node().port.onmessage!({ data: { pcm: buf, peak: 0.42 } });
    expect(onFrame).toHaveBeenCalledWith(buf);
    expect(onLevel).toHaveBeenCalledWith(0.42);
  });

  it('does not need a level callback', async () => {
    const onFrame = vi.fn();
    await new MicRecorder().start({ onFrame });
    expect(() => node().port.onmessage!({ data: { pcm: new ArrayBuffer(2), peak: 0 } })).not.toThrow();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('is idempotent while running', async () => {
    const rec = new MicRecorder();
    await rec.start({ onFrame: () => {} });
    await rec.start({ onFrame: () => {} });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('revokes the worklet URL even when loading it fails', async () => {
    FakeAudioContext.addModule.mockRejectedValueOnce(new Error('AbortError'));
    await expect(new MicRecorder().start({ onFrame: () => {} })).rejects.toThrow('AbortError');
    expect(revoked).toEqual(['blob:worklet/1']);
    expect(FakeWorkletNode.instances).toHaveLength(0);
  });

  it('propagates a refused mic permission without opening a context', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    await expect(new MicRecorder().start({ onFrame: () => {} })).rejects.toThrow('NotAllowedError');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe('MicRecorder.sampleRate', () => {
  it('is the canonical rate until a context exists, then the context rate', async () => {
    const rec = new MicRecorder();
    expect(rec.sampleRate).toBe(24_000);
    const origCtor = FakeAudioContext;
    vi.stubGlobal(
      'AudioContext',
      class extends origCtor {
        sampleRate = 48_000; // a browser that ignored the requested rate
      },
    );
    await rec.start({ onFrame: () => {} });
    expect(rec.sampleRate).toBe(48_000);
    await rec.stop();
    expect(rec.sampleRate).toBe(24_000);
  });
});

describe('MicRecorder.stop', () => {
  it('tears down the graph, the tracks and the context', async () => {
    const rec = new MicRecorder();
    await rec.start({ onFrame: () => {} });
    const n = node();
    const c = ctx();
    const stream = c.streamSeen as FakeStream;
    await rec.stop();
    expect(n.port.close).toHaveBeenCalled();
    expect(n.disconnect).toHaveBeenCalled();
    expect(c.source.disconnect).toHaveBeenCalled();
    for (const t of stream.tracks) expect(t.stop).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
  });

  it('can start again after stopping', async () => {
    const rec = new MicRecorder();
    await rec.start({ onFrame: () => {} });
    await rec.stop();
    await rec.start({ onFrame: () => {} });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeAudioContext.instances).toHaveLength(2);
  });

  it('is safe before start and when called twice', async () => {
    const rec = new MicRecorder();
    await expect(rec.stop()).resolves.toBeUndefined();
    await rec.start({ onFrame: () => {} });
    await rec.stop();
    await expect(rec.stop()).resolves.toBeUndefined();
    expect(ctx().close).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------ the worklet itself ------------------------------ */

interface Processor {
  port: { postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][]): boolean;
}

/** Evaluates the inlined worklet source in a fake AudioWorkletGlobalScope. */
async function loadProcessor(): Promise<{ name: string; make: () => Processor }> {
  await new MicRecorder().start({ onFrame: () => {} });
  const src = await blobs[0].text();
  class AudioWorkletProcessor {
    port = { postMessage: vi.fn() };
  }
  let registered: { name: string; cls: new () => Processor } | undefined;
  const registerProcessor = (name: string, cls: new () => Processor) => {
    registered = { name, cls };
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', src)(AudioWorkletProcessor, registerProcessor);
  if (!registered) throw new Error('worklet did not register');
  const { name, cls } = registered;
  return { name, make: () => new cls() };
}

const quantum = (values: number[] | number, length = 128) =>
  typeof values === 'number' ? new Float32Array(length).fill(values) : Float32Array.from(values);

describe('capture worklet', () => {
  it("registers as 'capture'", async () => {
    expect((await loadProcessor()).name).toBe('capture');
  });

  it('emits one 40 ms frame (960 samples at 24 kHz) per 960 samples in, across render quanta', async () => {
    const p = (await loadProcessor()).make();
    for (let i = 0; i < 7; i++) expect(p.process([[quantum(0.1)]])).toBe(true); // 896 samples
    expect(p.port.postMessage).not.toHaveBeenCalled();
    p.process([[quantum(0.1)]]); // 1024
    expect(p.port.postMessage).toHaveBeenCalledTimes(1);
    const [msg, transfer] = p.port.postMessage.mock.calls[0] as [{ pcm: ArrayBuffer; peak: number }, ArrayBuffer[]];
    expect(msg.pcm.byteLength).toBe(960 * 2);
    expect(transfer).toEqual([msg.pcm]);
    // 64 samples carried over: 7 more quanta complete the next frame (64 + 7*128 = 960).
    for (let i = 0; i < 6; i++) p.process([[quantum(0.1)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(1);
    p.process([[quantum(0.1)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it('converts to PCM16 with asymmetric scaling and clamps out-of-range input', async () => {
    const p = (await loadProcessor()).make();
    const head = [0, 1, -1, 0.5, -0.5, 2, -3, 1e-6];
    p.process([[Float32Array.from([...head, ...new Array(960 - head.length).fill(0)])]]);
    const { pcm, peak } = p.port.postMessage.mock.calls[0][0] as { pcm: ArrayBuffer; peak: number };
    expect([...new Int16Array(pcm).slice(0, head.length)]).toEqual([0, 32767, -32768, 16383, -16384, 32767, -32768, 0]);
    expect(peak).toBe(1);
  });

  it('reports the peak of the clamped frame', async () => {
    const p = (await loadProcessor()).make();
    const samples = new Float32Array(960).fill(0.25);
    samples[500] = -0.75;
    p.process([[samples]]);
    expect((p.port.postMessage.mock.calls[0][0] as { peak: number }).peak).toBe(0.75);
  });

  it('keeps running when a quantum has no input', async () => {
    const p = (await loadProcessor()).make();
    expect(p.process([])).toBe(true);
    expect(p.process([[]])).toBe(true);
    expect(p.port.postMessage).not.toHaveBeenCalled();
  });

  it('starts a fresh frame after each emit', async () => {
    const p = (await loadProcessor()).make();
    p.process([[quantum(0.5, 960)]]);
    p.process([[quantum(-0.5, 960)]]);
    const second = new Int16Array((p.port.postMessage.mock.calls[1][0] as { pcm: ArrayBuffer }).pcm);
    expect(second.every((v) => v === -16384)).toBe(true);
  });
});
