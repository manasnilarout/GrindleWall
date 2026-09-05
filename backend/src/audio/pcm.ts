import { CANONICAL_SAMPLE_RATE } from '../shared/protocol.js';

/**
 * Every provider wants a different sample rate. The session boundary is always
 * PCM16 LE mono @ CANONICAL_SAMPLE_RATE; adapters resample on the way in/out.
 *
 * Adapters resample against the `sampleRate` they are handed in their options
 * rather than against the constant directly, so a provider stays correct if the
 * session boundary is ever reconfigured.
 */

/** Linear-interpolation resampler. Good enough for latency/quality A-B testing. */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inSamples = input.length >>> 1;
  if (inSamples === 0) return Buffer.alloc(0);

  const ratio = toRate / fromRate;
  const outSamples = Math.max(1, Math.floor(inSamples * ratio));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = srcPos - i0;
    const s0 = input.readInt16LE(i0 * 2);
    const s1 = input.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

export function pcm16DurationMs(bytes: number, sampleRate = CANONICAL_SAMPLE_RATE): number {
  return (bytes / 2 / sampleRate) * 1000;
}

/** RMS in 0..1, for a cheap client-independent VAD / level meter. */
export function rms(buf: Buffer): number {
  const n = buf.length >>> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Synthesised speech-shaped blip, used by the mock providers. */
export function tone(durationMs: number, freq = 220, sampleRate = CANONICAL_SAMPLE_RATE, gain = 0.25): Buffer {
  const n = Math.floor((durationMs / 1000) * sampleRate);
  const out = Buffer.alloc(n * 2);
  const attack = Math.floor(n * 0.15);
  const release = Math.floor(n * 0.3);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > n - release) env = Math.max(0, (n - i) / release);
    // two partials so it does not sound like a pure sine
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.8 + Math.sin((2 * Math.PI * freq * 2 * i) / sampleRate) * 0.2;
    out.writeInt16LE(Math.round(v * env * gain * 32767), i * 2);
  }
  return out;
}

export function silence(durationMs: number, sampleRate = CANONICAL_SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.floor((durationMs / 1000) * sampleRate) * 2);
}

/**
 * Vendors that advertise raw PCM sometimes prefix the first chunk with a RIFF
 * header anyway. Dropping it costs nothing and avoids an audible click.
 */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, size ? Math.min(buf.length, off + 8 + size) : buf.length);
    off += 8 + size + (size % 2);
  }
  return buf.subarray(44); // malformed header; assume the canonical 44-byte one
}
