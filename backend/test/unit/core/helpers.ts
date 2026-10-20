/**
 * Shared helpers for the core unit tests. Nothing here talks to the network or
 * needs a key.
 */

/** PCM16 LE mono of `samples` frames, every sample set to `value`. */
export function pcm(samples: number, value: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

/** PCM16 LE mono from explicit sample values. */
export function pcmOf(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

/** Reads every sample of a PCM16 LE mono buffer (a trailing odd byte is ignored). */
export function samplesOf(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

/** A millisecond clock the test drives by hand, for injection as `now`. */
export function manualClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

export interface ParsedWav {
  riff: string;
  riffSize: number;
  wave: string;
  fmt: string;
  fmtSize: number;
  format: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
  dataId: string;
  dataBytes: number;
  frames: number;
  totalBytes: number;
  /** NaN when out of range, so a short file fails an equality check instead of throwing. */
  left: (i: number) => number;
  right: (i: number) => number;
}

export function parseWav(buf: Buffer): ParsedWav {
  const channels = buf.readUInt16LE(22);
  const dataBytes = buf.readUInt32LE(40);
  const sample = (i: number, ch: number) => {
    const at = 44 + i * channels * 2 + ch * 2;
    return i >= 0 && at + 2 <= buf.length ? buf.readInt16LE(at) : NaN;
  };
  return {
    riff: buf.toString('ascii', 0, 4),
    riffSize: buf.readUInt32LE(4),
    wave: buf.toString('ascii', 8, 12),
    fmt: buf.toString('ascii', 12, 16),
    fmtSize: buf.readUInt32LE(16),
    format: buf.readUInt16LE(20),
    channels,
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bits: buf.readUInt16LE(34),
    dataId: buf.toString('ascii', 36, 40),
    dataBytes,
    frames: dataBytes / (channels * 2),
    totalBytes: buf.length,
    left: (i) => sample(i, 0),
    right: (i) => sample(i, 1),
  };
}
