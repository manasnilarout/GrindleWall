import { CANONICAL_SAMPLE_RATE } from '../lib/protocol';

/**
 * Mic -> PCM16 LE mono @ CANONICAL_SAMPLE_RATE, in ~40ms frames.
 * The worklet is inlined so there is no extra file to serve.
 */
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(${(CANONICAL_SAMPLE_RATE * 40) / 1000});
    this.filled = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.frame[this.filled++] = ch[i];
      if (this.filled === this.frame.length) {
        const pcm = new Int16Array(this.filled);
        let peak = 0;
        for (let j = 0; j < this.filled; j++) {
          const s = Math.max(-1, Math.min(1, this.frame[j]));
          if (Math.abs(s) > peak) peak = Math.abs(s);
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
`;

export interface RecorderCallbacks {
  onFrame(pcm16: ArrayBuffer): void;
  onLevel?(peak: number): void;
}

export class MicRecorder {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? CANONICAL_SAMPLE_RATE;
  }

  async start(cb: RecorderCallbacks): Promise<void> {
    if (this.ctx) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Asking for the canonical rate avoids resampling in JS on most browsers.
    this.ctx = new AudioContext({ sampleRate: CANONICAL_SAMPLE_RATE, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture');
    this.node.port.onmessage = (e) => {
      cb.onFrame(e.data.pcm as ArrayBuffer);
      cb.onLevel?.(e.data.peak as number);
    };
    this.source.connect(this.node);
    // Keep the graph pulling without making the mic audible.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = undefined;
    this.node = undefined;
    this.source = undefined;
    this.stream = undefined;
  }
}
