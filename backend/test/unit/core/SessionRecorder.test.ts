import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRecorder, wavHeader } from '../../../src/audio/SessionRecorder.js';
import { CANONICAL_SAMPLE_RATE } from '../../../src/shared/protocol.js';
import { manualClock, parseWav, pcm, type ParsedWav } from './helpers.js';

/**
 * Real files in a real temp directory, read back byte for byte. The clock is
 * injected because the recorder's whole job is WHERE on the timeline audio
 * lands, and a wall clock cannot assert that.
 */
const SR = CANONICAL_SAMPLE_RATE;
/** Largest frame count whose stereo PCM16 data still fits a 32-bit RIFF size (mirrors the src constant). */
const MAX_TOTAL_SAMPLES = Math.floor((0xffffffff - 44) / 4);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rec-unit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tmpLeftovers = async (d = dir) => (await readdir(d)).filter((f) => f.endsWith('.tmp'));

function recorder(id: string, opts: { sampleRate?: number; maxMinutes?: number; clockStart?: number } = {}) {
  const clock = manualClock(opts.clockStart ?? 0);
  const rec = new SessionRecorder(id, { dir, now: clock.now, sampleRate: opts.sampleRate, maxMinutes: opts.maxMinutes });
  return { rec, clock };
}

async function finish(rec: SessionRecorder): Promise<{ wav: ParsedWav; bytes: Buffer; result: NonNullable<Awaited<ReturnType<SessionRecorder['stop']>>> }> {
  const result = await rec.stop();
  expect(result).toBeDefined();
  const bytes = await readFile(result!.path);
  return { wav: parseWav(bytes), bytes, result: result! };
}

/** Reads `count` samples of one channel starting at frame `from`. */
function channel(w: ParsedWav, side: 'left' | 'right', from: number, count: number): number[] {
  const out: number[] = [];
  for (let i = from; i < from + count; i++) out.push(w[side](i));
  return out;
}

/* -------------------------------------------------------------------------- */

describe('wavHeader', () => {
  it('writes a canonical 44-byte stereo PCM16 header', () => {
    const w = parseWav(wavHeader(1000, 24000));
    expect(wavHeader(1000, 24000).length).toBe(44);
    expect(w).toMatchObject({
      riff: 'RIFF',
      riffSize: 36 + 4000,
      wave: 'WAVE',
      fmt: 'fmt ',
      fmtSize: 16,
      format: 1,
      channels: 2,
      sampleRate: 24000,
      byteRate: 24000 * 4,
      blockAlign: 4,
      bits: 16,
      dataId: 'data',
      dataBytes: 4000,
    });
  });

  it('writes a mono header when asked', () => {
    const w = parseWav(wavHeader(1000, 16000, 1));
    expect(w).toMatchObject({ channels: 1, sampleRate: 16000, byteRate: 32000, blockAlign: 2, dataBytes: 2000, riffSize: 2036 });
  });

  it('allows an empty data chunk', () => {
    const w = parseWav(wavHeader(0, 24000));
    expect(w.dataBytes).toBe(0);
    expect(w.riffSize).toBe(36);
  });

  it('fits the recorder ceiling exactly', () => {
    expect(() => wavHeader(MAX_TOTAL_SAMPLES, SR)).not.toThrow();
  });

  it('accepts the largest stereo size that fits, and refuses one frame more', () => {
    const largest = Math.floor((0xffffffff - 36) / 4); // 1073741814
    expect(parseWav(wavHeader(largest, SR)).dataBytes).toBe(largest * 4);
    expect(() => wavHeader(largest + 1, SR)).toThrow(RangeError);
  });

  it('applies the 32-bit limit per channel count (mono boundary)', () => {
    const largest = Math.floor((0xffffffff - 36) / 2);
    expect(() => wavHeader(largest, SR, 1)).not.toThrow();
    expect(() => wavHeader(largest + 1, SR, 1)).toThrow(RangeError);
  });

  it.each([
    ['negative', -1],
    ['a fractional byte count', 0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['far too large', 0x7fffffff],
  ])('refuses %s rather than emitting a corrupt header', (_label, n) => {
    expect(() => wavHeader(n, SR)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */

describe('SessionRecorder lifecycle', () => {
  it('is not recording until started', () => {
    const { rec } = recorder('life-a');
    expect(rec.isRecording).toBe(false);
    expect(rec.error).toBeUndefined();
  });

  it('stop() before start() returns undefined and touches no disk', async () => {
    const nested = join(dir, 'never', 'made');
    const rec = new SessionRecorder('life-b', { dir: nested });
    expect(await rec.stop()).toBeUndefined();
    expect(existsSync(nested)).toBe(false);
  });

  it('writes and interrupts before start() are ignored without throwing', async () => {
    const { rec } = recorder('life-c');
    expect(() => {
      rec.writeMic(pcm(100, 1));
      rec.writeAssistant(pcm(100, 1));
      rec.interrupt();
    }).not.toThrow();
    await rec.start();
    expect(await rec.stop()).toBeUndefined();
  });

  it('start() creates the directory (recursively) and two temp channel files', async () => {
    const nested = join(dir, 'a', 'b');
    const rec = new SessionRecorder('life-d', { dir: nested, now: () => 0 });
    await rec.start();
    expect(rec.isRecording).toBe(true);
    const tmps = await tmpLeftovers(nested);
    expect(tmps).toHaveLength(2);
    expect(tmps.some((f) => f.startsWith('life-d.mic.'))).toBe(true);
    expect(tmps.some((f) => f.startsWith('life-d.bot.'))).toBe(true);
    await rec.stop();
    expect(await tmpLeftovers(nested)).toEqual([]);
  });

  it('a recording with no audio produces no file and leaves nothing behind', async () => {
    const { rec } = recorder('life-e');
    await rec.start();
    expect(await rec.stop()).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(rec.isRecording).toBe(false);
    expect(rec.error).toBeUndefined();
  });

  it('start() is idempotent: the mic toggling does not split the recording or reset t0', async () => {
    const { rec, clock } = recorder('life-f');
    await rec.start();
    rec.writeMic(pcm(SR, 100));
    clock.advance(1000);
    await rec.start();
    await rec.start();
    expect(rec.isRecording).toBe(true);
    expect(await tmpLeftovers()).toHaveLength(2); // no second pair of channels
    rec.writeMic(pcm(SR, 200));
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR * 2);
    expect(wav.left(SR - 1)).toBe(100);
    expect(wav.left(SR)).toBe(200);
  });

  it('stops recording on stop(), ignores later writes, and a second stop() is a quiet no-op', async () => {
    const { rec } = recorder('life-g');
    await rec.start();
    rec.writeMic(pcm(10, 5));
    const first = await rec.stop();
    expect(first).toBeDefined();
    expect(rec.isRecording).toBe(false);
    const before = await readFile(first!.path);
    rec.writeMic(pcm(1000, 9));
    rec.writeAssistant(pcm(1000, 9));
    rec.interrupt();
    expect(await rec.stop()).toBeUndefined();
    expect((await readFile(first!.path)).equals(before)).toBe(true);
  });

  it('start() after stop() does not re-arm the recorder', async () => {
    const { rec } = recorder('life-h');
    await rec.start();
    await rec.stop();
    await rec.start();
    expect(rec.isRecording).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports path, bytes, duration and truncation of the finished file', async () => {
    const { rec, clock } = recorder('life-i');
    await rec.start();
    rec.writeMic(pcm(SR / 2, 1));
    clock.advance(1000);
    rec.writeAssistant(pcm(SR / 4, 2));
    const { result, bytes } = await finish(rec);
    expect(result.path).toBe(join(dir, 'life-i.wav'));
    expect(result.bytes).toBe(bytes.length);
    expect((await stat(result.path)).size).toBe(result.bytes);
    expect(result.bytes).toBe(44 + SR * 1.25 * 4);
    expect(result.durationMs).toBe(1250);
    expect(result.truncated).toBe(false);
    expect(await tmpLeftovers()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('SessionRecorder timeline', () => {
  it('writes a stereo 16-bit file at the canonical rate, RIFF size consistent with the file', async () => {
    const { rec } = recorder('tl-fmt');
    await rec.start();
    rec.writeMic(pcm(100, 1));
    const { wav } = await finish(rec);
    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(SR);
    expect(wav.bits).toBe(16);
    expect(wav.riffSize).toBe(wav.totalBytes - 8);
    expect(wav.dataBytes).toBe(wav.totalBytes - 44);
  });

  it('mic goes LEFT, assistant goes RIGHT, and a pause survives as a hole of silence', async () => {
    const { rec, clock } = recorder('tl-gap');
    await rec.start();
    rec.writeMic(pcm(SR / 2, 1000)); // 0.0-0.5s
    clock.advance(1500); // a full second of nothing after it
    rec.writeAssistant(pcm(SR / 2, -2000)); // 1.5-2.0s
    clock.advance(500);
    const { wav } = await finish(rec);

    expect(wav.frames).toBe(SR * 2);
    expect(channel(wav, 'left', 0, 5)).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(wav.right(10)).toBe(0);
    expect(wav.left(SR / 2 - 1)).toBe(1000);
    expect(wav.left(SR / 2)).toBe(0); // mic ends exactly where it should
    const botStart = SR * 1.5;
    expect(wav.right(botStart - 1)).toBe(0);
    expect(wav.right(botStart)).toBe(-2000);
    expect(wav.left(botStart)).toBe(0);
    // the whole silent second reads as zeros on both channels
    expect(channel(wav, 'left', SR / 2, SR).every((s) => s === 0)).toBe(true);
    expect(channel(wav, 'right', 0, SR * 1.5).every((s) => s === 0)).toBe(true);
    // the shorter channel is silence where only the other one ran
    expect(wav.left(SR * 2 - 1)).toBe(0);
    expect(wav.right(SR * 2 - 1)).toBe(-2000);
  });

  it('early (faster-than-real-time) TTS chunks are laid end to end, never padded apart', async () => {
    const { rec, clock } = recorder('tl-burst');
    await rec.start();
    for (let i = 0; i < 6; i++) {
      rec.writeAssistant(pcm(SR / 2, 5000 + i));
      clock.advance(16);
    }
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR * 3);
    for (let i = 0; i < 6; i++) {
      const seg = channel(wav, 'right', (i * SR) / 2, SR / 2);
      expect(seg.every((s) => s === 5000 + i)).toBe(true);
    }
  });

  it('early mic chunks are contiguous too (head, not clock, decides)', async () => {
    const { rec } = recorder('tl-mic-burst');
    await rec.start();
    rec.writeMic(pcm(100, 1));
    rec.writeMic(pcm(100, 2));
    rec.writeMic(pcm(100, 3));
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(300);
    expect([wav.left(99), wav.left(100), wav.left(199), wav.left(200), wav.left(299)]).toEqual([1, 2, 2, 3, 3]);
  });

  it('a chunk that arrives after the head has caught up lands at the clock', async () => {
    const { rec, clock } = recorder('tl-late');
    await rec.start();
    rec.writeAssistant(pcm(SR / 10, 7)); // 100 ms, head at 0.1s
    clock.advance(50);
    rec.writeAssistant(pcm(SR / 10, 8)); // early: lands at the head, 0.1s
    clock.advance(450); // now 0.5s, head 0.2s
    rec.writeAssistant(pcm(SR / 10, 9)); // late: lands at 0.5s
    const { wav } = await finish(rec);
    expect(wav.right(SR / 10)).toBe(8);
    expect(wav.right((SR * 2) / 10)).toBe(0);
    expect(wav.right(SR / 2 - 1)).toBe(0);
    expect(wav.right(SR / 2)).toBe(9);
    expect(wav.frames).toBe(SR * 0.6);
  });

  it('overlapping speech (barge-in) is kept on both channels at once', async () => {
    const { rec, clock } = recorder('tl-overlap');
    await rec.start();
    rec.writeAssistant(pcm(SR, 4000));
    clock.advance(400);
    rec.writeMic(pcm(SR / 2, -4000));
    const { wav } = await finish(rec);
    const mid = Math.floor(SR * 0.5);
    expect([wav.left(mid), wav.right(mid)]).toEqual([-4000, 4000]);
    expect(wav.left(Math.floor(SR * 0.2))).toBe(0);
    expect(wav.left(Math.floor(SR * 0.4))).toBe(-4000);
  });

  it("one channel's lead never displaces the other channel", async () => {
    const { rec, clock } = recorder('tl-indep');
    await rec.start();
    rec.writeAssistant(pcm(SR * 3, 1)); // right is 3s ahead of the clock
    clock.advance(1000);
    rec.writeMic(pcm(SR / 10, 2)); // lands at 1.0s on the left, not at 3.0s
    const { wav } = await finish(rec);
    expect(wav.left(SR - 1)).toBe(0);
    expect(wav.left(SR)).toBe(2);
    expect(wav.frames).toBe(SR * 3);
  });

  it('interleaves sample-exactly across the 1-second block boundary', async () => {
    const n = Math.floor(SR * 1.3); // spans two interleave blocks
    const mic = Buffer.alloc(n * 2);
    const bot = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      mic.writeInt16LE((i % 30000) - 15000, i * 2);
      bot.writeInt16LE(15000 - (i % 29999), i * 2);
    }
    const { rec } = recorder('tl-interleave');
    await rec.start();
    rec.writeMic(mic);
    rec.writeAssistant(bot);
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(n);
    let mismatches = 0;
    for (let i = 0; i < n; i++) {
      if (wav.left(i) !== (i % 30000) - 15000 || wav.right(i) !== 15000 - (i % 29999)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('an odd-length chunk drops its stray byte so later samples stay aligned', async () => {
    const { rec } = recorder('tl-odd');
    await rec.start();
    rec.writeMic(Buffer.concat([pcm(10, 777), Buffer.from([0x01])]));
    rec.writeMic(pcm(10, -555)); // no clock advance: position is driven by the head
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(20);
    expect(channel(wav, 'left', 0, 20)).toEqual([...Array(10).fill(777), ...Array(10).fill(-555)]);
  });

  it('a lone byte and an empty chunk write nothing and move nothing', async () => {
    const { rec } = recorder('tl-tiny');
    await rec.start();
    rec.writeMic(Buffer.from([0x7f]));
    rec.writeMic(Buffer.alloc(0));
    rec.writeAssistant(Buffer.alloc(0));
    rec.writeAssistant(Buffer.from([0x01]));
    expect(rec.isRecording).toBe(true);
    expect(await rec.stop()).toBeUndefined();
  });

  it('a clock that goes backwards never yields a negative position', async () => {
    const { rec, clock } = recorder('tl-backwards', { clockStart: 10_000 });
    await rec.start(); // t0 = 10s
    clock.set(4_000); // 6s before t0
    rec.writeMic(pcm(SR / 10, 3)); // lands at 0
    rec.writeMic(pcm(SR / 10, 4)); // at the head
    clock.set(12_000); // 2s after t0
    rec.writeMic(pcm(SR / 10, 5));
    const { wav } = await finish(rec);
    expect(wav.left(0)).toBe(3);
    expect(wav.left(SR / 10)).toBe(4);
    expect(wav.left(SR * 2 - 1)).toBe(0);
    expect(wav.left(SR * 2)).toBe(5);
  });

  it('honours a custom sample rate in the header, the timeline and the duration', async () => {
    const { rec, clock } = recorder('tl-16k', { sampleRate: 16000 });
    await rec.start();
    clock.advance(500);
    rec.writeMic(pcm(8000, 6)); // 0.5s at 16 kHz, landing at 0.5s
    const { wav, result } = await finish(rec);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.byteRate).toBe(64000);
    expect(wav.left(7999)).toBe(0);
    expect(wav.left(8000)).toBe(6);
    expect(wav.frames).toBe(16000);
    expect(result.durationMs).toBe(1000);
  });

  it('audio written while start() is still opening the files is dropped, not mis-placed', async () => {
    const { rec, clock } = recorder('tl-starting');
    const starting = rec.start();
    expect(rec.isRecording).toBe(true);
    rec.writeMic(pcm(SR, 1)); // channels not open yet
    await starting;
    clock.advance(500);
    rec.writeMic(pcm(SR / 10, 2));
    const { wav } = await finish(rec);
    expect(wav.left(0)).toBe(0);
    expect(wav.left(SR / 2)).toBe(2);
    expect(wav.frames).toBe(SR * 0.6);
  });
});

/* -------------------------------------------------------------------------- */

describe('SessionRecorder barge-in (interrupt)', () => {
  it('truncates unheard assistant audio and lands the next turn at its own wall-clock time', async () => {
    const { rec, clock } = recorder('bi-main');
    await rec.start();
    rec.writeAssistant(pcm(SR * 5, 1111)); // 5s rendered in no time
    clock.advance(600);
    rec.interrupt(); // user cuts in at 0.6s
    clock.advance(1900);
    rec.writeAssistant(pcm(SR / 2, 2222)); // turn two at 2.5s
    clock.advance(500);
    const { wav, result } = await finish(rec);

    const cut = Math.round(SR * 0.6);
    expect(wav.right(cut - 1)).toBe(1111); // heard: kept
    expect(wav.right(cut)).toBe(0); // never heard: gone
    expect(wav.right(SR)).toBe(0);
    const turn2 = SR * 2.5;
    expect(wav.right(turn2 - 1)).toBe(0);
    expect(wav.right(turn2)).toBe(2222);
    expect(wav.frames).toBe(SR * 3); // as long as the conversation, not the audio
    expect(result.durationMs).toBe(3000);
  });

  it('the next chunk after an interrupt continues from the cut, contiguously', async () => {
    const { rec, clock } = recorder('bi-contig');
    await rec.start();
    rec.writeAssistant(pcm(SR * 2, 1));
    clock.advance(250);
    rec.interrupt();
    rec.writeAssistant(pcm(SR / 4, 2)); // same instant
    const { wav } = await finish(rec);
    const cut = SR / 4;
    expect([wav.right(cut - 1), wav.right(cut), wav.right(cut + SR / 4 - 1)]).toEqual([1, 2, 2]);
    expect(wav.frames).toBe(SR / 2);
  });

  it('is a no-op when the assistant is not ahead of the clock (heard audio is never cut)', async () => {
    const { rec, clock } = recorder('bi-behind');
    await rec.start();
    rec.writeAssistant(pcm(SR, 3));
    clock.advance(2000);
    rec.interrupt();
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR);
    expect(wav.right(SR - 1)).toBe(3);
  });

  it('is a no-op when the head sits exactly on the clock', async () => {
    const { rec, clock } = recorder('bi-exact');
    await rec.start();
    rec.writeAssistant(pcm(SR, 3));
    clock.advance(1000);
    rec.interrupt();
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR);
    expect(wav.right(SR - 1)).toBe(3);
  });

  it('an interrupt at t0 removes the whole unheard utterance', async () => {
    const { rec } = recorder('bi-zero');
    await rec.start();
    rec.writeAssistant(pcm(SR, 3));
    rec.interrupt();
    expect(await rec.stop()).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it('never touches the mic channel, even when the mic is ahead', async () => {
    const { rec, clock } = recorder('bi-mic');
    await rec.start();
    rec.writeMic(pcm(SR * 2, 9)); // mic 2s ahead
    rec.writeAssistant(pcm(SR * 2, 4));
    clock.advance(500);
    rec.interrupt();
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR * 2);
    expect(wav.left(SR * 2 - 1)).toBe(9);
    expect(wav.right(SR / 2 - 1)).toBe(4);
    expect(wav.right(SR / 2)).toBe(0);
  });

  it('several barge-ins in one conversation each give the lead back', async () => {
    const { rec, clock } = recorder('bi-multi');
    await rec.start();
    for (let turn = 0; turn < 3; turn++) {
      clock.set(turn * 1000);
      rec.writeAssistant(pcm(SR * 4, 10 + turn));
      clock.advance(300);
      rec.interrupt();
    }
    clock.set(3000);
    rec.writeAssistant(pcm(SR / 10, 99));
    const { wav } = await finish(rec);
    for (let turn = 0; turn < 3; turn++) {
      expect(wav.right(turn * SR)).toBe(10 + turn);
      expect(wav.right(turn * SR + Math.round(SR * 0.3) - 1)).toBe(10 + turn);
      expect(wav.right(turn * SR + Math.round(SR * 0.3))).toBe(0);
    }
    expect(wav.right(SR * 3)).toBe(99);
    expect(wav.frames).toBe(SR * 3.1);
  });

  it('interrupt() before start or after stop does not throw', async () => {
    const { rec } = recorder('bi-idle');
    expect(() => rec.interrupt()).not.toThrow();
    await rec.start();
    await rec.stop();
    expect(() => rec.interrupt()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('SessionRecorder disk cap', () => {
  it('a chunk crossing the cap is cut at the cap, finalized, and reported truncated', async () => {
    const { rec } = recorder('cap-cross', { maxMinutes: 1 / 60 }); // 1 second
    await rec.start();
    rec.writeMic(pcm(SR * 2, 900));
    expect(rec.isRecording).toBe(false);
    const { wav, result } = await finish(rec);
    expect(result.truncated).toBe(true);
    expect(wav.frames).toBe(SR);
    expect(wav.left(0)).toBe(900);
    expect(wav.left(SR - 1)).toBe(900);
    expect(result.durationMs).toBe(1000);
  });

  it('a chunk that exactly fills the cap ends the recording', async () => {
    const { rec } = recorder('cap-exact', { maxMinutes: 1 / 60 });
    await rec.start();
    rec.writeMic(pcm(SR, 1));
    expect(rec.isRecording).toBe(false);
    const { result } = await finish(rec);
    expect(result.truncated).toBe(true);
    expect(result.durationMs).toBe(1000);
  });

  it('just under the cap keeps recording and is not truncated', async () => {
    const { rec } = recorder('cap-under', { maxMinutes: 1 / 60 });
    await rec.start();
    rec.writeMic(pcm(SR - 1, 1));
    expect(rec.isRecording).toBe(true);
    const { result } = await finish(rec);
    expect(result.truncated).toBe(false);
  });

  it('once the cap is hit, the OTHER channel stops too', async () => {
    const { rec } = recorder('cap-both', { maxMinutes: 1 / 60 });
    await rec.start();
    rec.writeMic(pcm(SR, 1));
    rec.writeAssistant(pcm(SR / 2, 2));
    const { wav } = await finish(rec);
    expect(wav.right(0)).toBe(0);
  });

  it('a long stall cannot write a wall-clock-sized gap past the cap', async () => {
    const { rec, clock } = recorder('cap-gap', { maxMinutes: 1 / 60 });
    await rec.start();
    rec.writeMic(pcm(SR / 20, 900));
    clock.advance(60_000);
    rec.writeMic(pcm(SR / 20, 900));
    expect(rec.isRecording).toBe(false);
    const { result, bytes } = await finish(rec);
    expect(result.truncated).toBe(true);
    expect(result.durationMs).toBe(50); // only what came before the cap
    expect(bytes.length).toBeLessThan(44 + SR * 4);
  });

  it('honours a fractional cap', async () => {
    const { rec } = recorder('cap-frac', { maxMinutes: 0.25 / 60 }); // 250 ms
    await rec.start();
    rec.writeAssistant(pcm(SR, 1));
    const { wav } = await finish(rec);
    expect(wav.frames).toBe(SR / 4);
  });

  /*
   * The 60-minute default is checked at a 100 Hz sample rate so an hour of
   * timeline is 360000 frames (~1.4 MB) rather than ~345 MB.
   */
  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('a %s maxMinutes falls back to the 60-minute default', async (_label, maxMinutes) => {
    const { rec, clock } = recorder(`cap-default-${_label}`, { sampleRate: 100, maxMinutes });
    await rec.start();
    rec.writeMic(pcm(1, 1)); // a zero/negative cap would stop here
    expect(rec.isRecording).toBe(true);
    clock.set(3_599_000);
    rec.writeMic(pcm(1, 2)); // 59m59s: still inside the hour
    expect(rec.isRecording).toBe(true);
    clock.set(3_600_000);
    rec.writeMic(pcm(1, 3)); // 60m00s: at the cap, refused
    expect(rec.isRecording).toBe(false);
    const { wav, result } = await finish(rec);
    expect(result.truncated).toBe(true);
    expect(wav.frames).toBe(359_901);
    expect(wav.left(359_900)).toBe(2);
  });

  it('a cap past the 32-bit WAV size is clamped instead of destroying the recording at stop()', async () => {
    // 1440 min at 24 kHz is ~2x what a RIFF size can address (~745.6 min).
    const { rec, clock } = recorder('cap-huge', { maxMinutes: 1440 });
    await rec.start();
    rec.writeMic(pcm(10, 5));
    clock.set(750 * 60 * 1000); // inside the requested cap, past the WAV ceiling
    rec.writeMic(pcm(10, 5));
    expect(rec.isRecording).toBe(false);
    const { result, wav } = await finish(rec);
    expect(result.truncated).toBe(true);
    expect(wav.frames).toBe(10);
    expect(wav.left(9)).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */

describe('SessionRecorder failures are surfaced, not swallowed', () => {
  it('start() rejects when the directory cannot be created, and stop() re-throws it', async () => {
    const blocked = join(dir, 'not-a-dir');
    await writeFile(blocked, 'x');
    const rec = new SessionRecorder('fail-mkdir', { dir: join(blocked, 'sub') });
    const err = await rec.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(rec.isRecording).toBe(false);
    expect(rec.error).toBe(err);
    await expect(rec.stop()).rejects.toBe(err);
    // ...and it does not try again
    await rec.start();
    expect(rec.isRecording).toBe(false);
  });

  it('a failed write stops the recording, is reported by stop(), and leaves no files', async () => {
    const { rec } = recorder('fail-write');
    await rec.start();
    rec.writeMic(pcm(10, 1));
    // Close the mic channel's descriptor out from under it, so the next write fails.
    const internals = rec as unknown as { mic: { file: FileHandle; queue: Promise<void> } };
    await internals.mic.queue;
    await internals.mic.file.close();
    rec.writeMic(pcm(10, 2));
    await internals.mic.queue;
    expect(rec.isRecording).toBe(false);
    expect(rec.error).toBeInstanceOf(Error);
    await expect(rec.stop()).rejects.toBe(rec.error);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a failed finalize (rename) rejects and cleans every temp file up', async () => {
    const { rec } = recorder('fail-rename');
    await mkdir(join(dir, 'fail-rename.wav'));
    await writeFile(join(dir, 'fail-rename.wav', 'occupant'), 'x');
    await rec.start();
    rec.writeMic(pcm(100, 1));
    await expect(rec.stop()).rejects.toBeInstanceOf(Error);
    expect(await tmpLeftovers()).toEqual([]);
    expect(await readdir(dir)).toEqual(['fail-rename.wav']);
  });

  it('a stop() racing start() leaves no recording, no orphaned files, and no live recorder', async () => {
    const { rec } = recorder('race');
    const starting = rec.start(); // deliberately not awaited
    expect(await rec.stop()).toBeUndefined();
    await starting;
    expect(rec.isRecording).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    rec.writeMic(pcm(10, 1));
    expect(await rec.stop()).toBeUndefined();
  });

  it('two recorders with the same id in the same directory do not share temp files', async () => {
    const a = recorder('same-id');
    const b = new SessionRecorder('same-id', { dir, now: () => 0 });
    await a.rec.start();
    await b.start();
    expect(await tmpLeftovers()).toHaveLength(4);
    await b.stop();
    a.rec.writeMic(pcm(10, 1));
    const { wav } = await finish(a.rec);
    expect(wav.left(0)).toBe(1);
    expect(await tmpLeftovers()).toEqual([]);
  });
});
