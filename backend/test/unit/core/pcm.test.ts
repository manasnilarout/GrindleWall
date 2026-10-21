import { describe, expect, it } from 'vitest';
import { pcm16DurationMs, resamplePcm16, rms, silence, stripWavHeader, tone } from '../../../src/audio/pcm.js';
import { wavHeader } from '../../../src/audio/SessionRecorder.js';
import { CANONICAL_SAMPLE_RATE } from '../../../src/shared/protocol.js';
import { pcm, pcmOf, samplesOf } from './helpers.js';

const SR = CANONICAL_SAMPLE_RATE;

describe('resamplePcm16', () => {
  it('returns the very same buffer when the rates match (no copy, no work)', () => {
    const input = pcmOf([1, 2, 3]);
    expect(resamplePcm16(input, 24000, 24000)).toBe(input);
  });

  it('returns the same buffer for matching rates even when its length is odd', () => {
    const odd = Buffer.from([1, 2, 3]);
    expect(resamplePcm16(odd, 16000, 16000)).toBe(odd);
  });

  it('returns an empty buffer for empty input', () => {
    const out = resamplePcm16(Buffer.alloc(0), 24000, 16000);
    expect(out.length).toBe(0);
  });

  it('treats a single stray byte as zero samples', () => {
    expect(resamplePcm16(Buffer.from([0x7f]), 24000, 48000).length).toBe(0);
  });

  it('ignores a trailing odd byte rather than misreading it as a sample', () => {
    const input = Buffer.concat([pcmOf([0, 100, 200]), Buffer.from([0xff])]);
    expect(samplesOf(resamplePcm16(input, 24000, 48000))).toEqual([0, 50, 100, 150, 200, 200]);
  });

  it('upsamples 2x by linear interpolation, holding the last sample at the end', () => {
    expect(samplesOf(resamplePcm16(pcmOf([0, 100, 200]), 24000, 48000))).toEqual([0, 50, 100, 150, 200, 200]);
  });

  it('downsamples 2x by taking every other sample', () => {
    expect(samplesOf(resamplePcm16(pcmOf([0, 10, 20, 30, 40, 50]), 48000, 24000))).toEqual([0, 20, 40]);
  });

  it('downsamples 24k -> 16k (ratio 2/3) with interpolation between neighbours', () => {
    // out[1] sits at source position 1.5, halfway between 300 and 600.
    expect(samplesOf(resamplePcm16(pcmOf([0, 300, 600]), 24000, 16000))).toEqual([0, 450]);
  });

  it('upsamples 16k -> 24k (ratio 3/2)', () => {
    // positions 0, 2/3, 4/3, 2, 8/3, 10/3 over [0, 300, 600, 900]
    expect(samplesOf(resamplePcm16(pcmOf([0, 300, 600, 900]), 16000, 24000))).toEqual([0, 200, 400, 600, 800, 900]);
  });

  it('always emits at least one sample, even when the ratio floors to zero', () => {
    expect(samplesOf(resamplePcm16(pcmOf([1234]), 48000, 8000))).toEqual([1234]);
  });

  it('rounds interpolated values to the nearest integer', () => {
    expect(samplesOf(resamplePcm16(pcmOf([0, 1]), 24000, 48000))).toEqual([0, 1, 1, 1]);
    // Math.round(-0.5) is -0, which writes as 0.
    expect(samplesOf(resamplePcm16(pcmOf([0, -1]), 24000, 48000))).toEqual([0, 0, -1, -1]);
  });

  it('stays inside int16 range when interpolating between the extremes', () => {
    const out = samplesOf(resamplePcm16(pcmOf([-32768, 32767, -32768]), 8000, 48000));
    for (const s of out) {
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
    expect(out[0]).toBe(-32768);
    expect(out[6]).toBe(32767);
  });

  it('preserves duration across common vendor rates', () => {
    const oneSecond = pcm(SR, 500);
    for (const rate of [8000, 16000, 22050, 44100, 48000]) {
      const out = resamplePcm16(oneSecond, SR, rate);
      expect(out.length / 2).toBe(Math.floor(SR * (rate / SR)));
      expect(pcm16DurationMs(out.length, rate)).toBeCloseTo(1000, 0);
    }
  });

  it('keeps a constant signal constant in both directions', () => {
    const flat = pcm(480, -777);
    for (const s of samplesOf(resamplePcm16(flat, 24000, 16000))) expect(s).toBe(-777);
    for (const s of samplesOf(resamplePcm16(flat, 24000, 44100))) expect(s).toBe(-777);
  });

  it('does not mutate its input', () => {
    const input = pcmOf([1, 2, 3, 4]);
    const copy = Buffer.from(input);
    resamplePcm16(input, 24000, 16000);
    expect(input.equals(copy)).toBe(true);
  });

  it('is deterministic', () => {
    const input = tone(50);
    expect(resamplePcm16(input, 24000, 16000).equals(resamplePcm16(input, 24000, 16000))).toBe(true);
  });
});

describe('pcm16DurationMs', () => {
  it('defaults to the canonical 24 kHz: 48000 bytes is one second', () => {
    expect(pcm16DurationMs(48000)).toBe(1000);
    expect(pcm16DurationMs(SR * 2)).toBe(1000);
  });

  it('honours an explicit sample rate', () => {
    expect(pcm16DurationMs(32000, 16000)).toBe(1000);
    expect(pcm16DurationMs(960, 24000)).toBe(20);
  });

  it('is zero for zero bytes', () => {
    expect(pcm16DurationMs(0)).toBe(0);
  });

  it('counts a half sample as half a sample (no flooring)', () => {
    expect(pcm16DurationMs(1, 1000)).toBe(0.5);
  });
});

describe('rms', () => {
  it('is 0 for an empty buffer', () => {
    expect(rms(Buffer.alloc(0))).toBe(0);
  });

  it('is 0 for a single stray byte (no full sample)', () => {
    expect(rms(Buffer.from([0x7f]))).toBe(0);
  });

  it('is 0 for digital silence', () => {
    expect(rms(silence(100))).toBe(0);
  });

  it('is the absolute level of a constant signal, scaled to 0..1', () => {
    expect(rms(pcm(100, 16384))).toBe(0.5);
    expect(rms(pcm(100, -16384))).toBe(0.5);
  });

  it('is exactly 1 at negative full scale and just under 1 at positive', () => {
    expect(rms(pcm(10, -32768))).toBe(1);
    expect(rms(pcm(10, 32767))).toBeCloseTo(32767 / 32768, 10);
  });

  it('is the root of the mean square over mixed samples', () => {
    // samples 0.5 and 0 -> sqrt((0.25 + 0) / 2)
    expect(rms(pcmOf([16384, 0]))).toBeCloseTo(Math.sqrt(0.125), 12);
  });

  it('ignores a trailing odd byte', () => {
    expect(rms(Buffer.concat([pcm(4, 16384), Buffer.from([0x7f])]))).toBe(0.5);
  });

  it('is ~0.707 * peak for a sine', () => {
    // Full cycles of a 1 kHz sine at 24 kHz.
    const n = 2400;
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / SR) * 16384), i * 2);
    expect(rms(b)).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });
});

describe('tone', () => {
  it('has floor(duration * rate) samples at the canonical rate by default', () => {
    expect(tone(1000).length).toBe(SR * 2);
    expect(tone(20).length).toBe(480 * 2);
    expect(tone(0.99).length).toBe(Math.floor(0.00099 * SR) * 2);
  });

  it('honours an explicit sample rate', () => {
    expect(tone(1000, 220, 16000).length).toBe(32000);
  });

  it('is empty for a zero duration', () => {
    expect(tone(0).length).toBe(0);
  });

  it('starts at zero (attack envelope) and ends near zero (release envelope)', () => {
    const t = samplesOf(tone(500));
    expect(t[0]).toBe(0);
    expect(Math.abs(t[t.length - 1]!)).toBeLessThan(50);
  });

  it('never exceeds gain * full scale', () => {
    for (const gain of [0.1, 0.25, 1]) {
      const peak = Math.max(...samplesOf(tone(200, 220, SR, gain)).map(Math.abs));
      expect(peak).toBeLessThanOrEqual(Math.round(gain * 32767));
      expect(peak).toBeGreaterThan(0);
    }
  });

  it('is silent at gain 0', () => {
    for (const s of samplesOf(tone(100, 220, SR, 0))) expect(s).toBe(0);
  });

  it('matches its two-partial formula in the sustain region', () => {
    const freq = 300;
    const gain = 0.5;
    const t = tone(1000, freq, SR, gain);
    // Well past the 15% attack and before the 30% release; offsets avoid zero crossings.
    for (const i of [SR / 2 + 7, SR / 2 + 13, SR / 2 + 31]) {
      const v = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8 + Math.sin((2 * Math.PI * freq * 2 * i) / SR) * 0.2;
      const expected = Math.round(v * gain * 32767);
      expect(Math.abs(expected)).toBeGreaterThan(100);
      expect(t.readInt16LE(i * 2)).toBe(expected);
    }
  });

  it('is loud enough to clear the default VAD threshold', () => {
    expect(rms(tone(200))).toBeGreaterThan(0.012);
  });

  it('survives buffers too short for an attack or release ramp', () => {
    for (const ms of [0.05, 0.1, 0.2, 0.3]) expect(() => tone(ms)).not.toThrow();
    for (const s of samplesOf(tone(0.2))) expect(Number.isFinite(s)).toBe(true);
  });

  it('is deterministic', () => {
    expect(tone(123, 440).equals(tone(123, 440))).toBe(true);
  });
});

describe('silence', () => {
  it('is all zeros of floor(duration * rate) samples', () => {
    const s = silence(1000);
    expect(s.length).toBe(SR * 2);
    expect(s.every((b) => b === 0)).toBe(true);
  });

  it('honours an explicit sample rate', () => {
    expect(silence(500, 16000).length).toBe(16000);
  });

  it('floors partial samples', () => {
    expect(silence(0.05).length).toBe(Math.floor(0.00005 * SR) * 2);
  });

  it('is empty for a zero duration', () => {
    expect(silence(0).length).toBe(0);
  });
});

describe('stripWavHeader', () => {
  const body = pcmOf([1, -2, 3, -4, 5]);

  /** A WAV with arbitrary chunks before the data chunk. */
  function riff(chunks: Array<{ id: string; data: Buffer; size?: number }>): Buffer {
    const parts: Buffer[] = [Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')];
    for (const c of chunks) {
      const hdr = Buffer.alloc(8);
      hdr.write(c.id, 0, 'ascii');
      hdr.writeUInt32LE(c.size ?? c.data.length, 4);
      parts.push(hdr, c.data);
    }
    const out = Buffer.concat(parts);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  }

  const fmt = () => wavHeader(0, 24000, 1).subarray(20, 36); // the 16-byte fmt body

  it('passes raw PCM through untouched (same instance)', () => {
    expect(stripWavHeader(body)).toBe(body);
  });

  it('passes through anything shorter than 12 bytes, even if it starts with RIFF', () => {
    const short = Buffer.from('RIFF\0\0\0\0WAV');
    expect(stripWavHeader(short)).toBe(short);
  });

  it('passes through a RIFF container that is not WAVE', () => {
    const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), body]);
    expect(stripWavHeader(avi)).toBe(avi);
  });

  it('strips the canonical 44-byte header', () => {
    const wav = Buffer.concat([wavHeader(body.length / 2, 24000, 1), body]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('returns an empty body for a header with no samples', () => {
    expect(stripWavHeader(wavHeader(0, 24000, 1)).length).toBe(0);
  });

  it('walks past extra chunks (LIST) before the data chunk', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'LIST', data: Buffer.from('INFOISFT\x04\0\0\0abcd') },
      { id: 'data', data: body },
    ]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('honours the RIFF pad byte after an odd-sized chunk', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'junk', data: Buffer.from([9, 9, 9, 0]), size: 3 }, // 3 bytes + 1 pad byte
      { id: 'data', data: body },
    ]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('stops at the declared data size, dropping trailing chunks', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'data', data: body },
      { id: 'LIST', data: Buffer.from('trailer!') },
    ]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('treats a data size of 0 as "until the end" (streaming WAVs)', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'data', data: body, size: 0 },
    ]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('clamps a data size larger than the buffer (0xFFFFFFFF placeholder) to what is there', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'data', data: body, size: 0xffffffff },
    ]);
    expect(stripWavHeader(wav).equals(body)).toBe(true);
  });

  it('falls back to dropping 44 bytes when no data chunk can be found', () => {
    const wav = riff([
      { id: 'fmt ', data: fmt() },
      { id: 'LIST', data: Buffer.alloc(40, 7) },
    ]);
    expect(stripWavHeader(wav).equals(wav.subarray(44))).toBe(true);
  });

  it('falls back to 44 bytes when a chunk size runs past the end', () => {
    const wav = riff([{ id: 'fmt ', data: Buffer.alloc(40, 1), size: 1_000_000 }]);
    expect(stripWavHeader(wav).equals(wav.subarray(44))).toBe(true);
  });

  it('returns an empty buffer for a bare RIFF/WAVE preamble', () => {
    expect(stripWavHeader(Buffer.from('RIFF\0\0\0\0WAVE')).length).toBe(0);
  });

  it('returns a view, not a copy', () => {
    const wav = Buffer.concat([wavHeader(body.length / 2, 24000, 1), body]);
    const out = stripWavHeader(wav);
    out.writeInt16LE(999, 0);
    expect(wav.readInt16LE(44)).toBe(999);
  });
});
