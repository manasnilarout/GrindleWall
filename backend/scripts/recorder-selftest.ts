/**
 * SessionRecorder against a controllable clock and a real temp directory.
 *
 * Unlike the provider self-tests, this one has no vendor in it and no fake that
 * could agree with itself: it writes real files, reads them back, and checks the
 * bytes. The clock is injected because the whole point of the recorder is WHERE
 * on the timeline audio lands, and a wall clock cannot assert that.
 *
 *   npx tsx scripts/recorder-selftest.ts
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRecorder, wavHeader } from '../src/audio/SessionRecorder.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

const SR = CANONICAL_SAMPLE_RATE;
const dir = await mkdtemp(join(tmpdir(), 'rec-selftest-'));

/** A clock the test drives by hand. */
function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** PCM16 mono of `samples` frames, every sample set to `value`. */
function pcm(samples: number, value: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

interface Wav {
  channels: number;
  sampleRate: number;
  bits: number;
  dataBytes: number;
  frames: number;
  left: (i: number) => number;
  right: (i: number) => number;
  riffSize: number;
  totalBytes: number;
}

function parseWav(buf: Buffer): Wav {
  const channels = buf.readUInt16LE(22);
  const dataBytes = buf.readUInt32LE(40);
  const frames = dataBytes / (channels * 2);
  /*
   * Bounds-checked on purpose. A recorder bug that makes the file SHORTER than
   * it should be — dropping the silence padding is exactly that bug — otherwise
   * throws a RangeError out of the first check that reads past the end, which
   * aborts the run and hides every check after it. NaN fails an equality check
   * quietly and lets the rest of the suite report.
   */
  const sample = (i: number, ch: number) => {
    const at = 44 + i * channels * 2 + ch * 2;
    return at >= 0 && at + 2 <= buf.length ? buf.readInt16LE(at) : NaN;
  };
  return {
    channels,
    sampleRate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes,
    frames,
    left: (i) => sample(i, 0),
    right: (i) => sample(i, 1),
    riffSize: buf.readUInt32LE(4),
    totalBytes: buf.length,
  };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
}

/* ------------------------------------------------------------------ *
 * 1. A conversation with real gaps keeps its gaps.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-timeline', { dir, now: c.now });
  await r.start();

  // 0.5s of mic at t=0
  r.writeMic(pcm(SR / 2, 1000));
  c.advance(500);
  // ...then a full second of nothing at all...
  c.advance(1000);
  // ...then the assistant answers at t=1500ms.
  r.writeAssistant(pcm(SR / 2, -2000));
  c.advance(500);

  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));

  check('writes a stereo file', w.channels === 2, `${w.channels} channels`);
  check('at the canonical sample rate', w.sampleRate === SR, `${w.sampleRate}`);
  check('16-bit', w.bits === 16, `${w.bits}`);
  check('mic lands on the LEFT channel', w.left(10) === 1000, `${w.left(10)}`);
  check('...and not on the right', w.right(10) === 0, `${w.right(10)}`);

  // The assistant chunk must begin at 1.5s, not immediately after the mic audio.
  const botStart = SR * 1.5;
  check('a 1s silence between turns is preserved, not squeezed out',
    w.right(botStart + 10) === -2000 && w.right(botStart - 10) === 0,
    `at ${botStart - 10}: ${w.right(botStart - 10)}, at ${botStart + 10}: ${w.right(botStart + 10)}`);
  check('assistant audio lands on the RIGHT channel only',
    w.left(botStart + 10) === 0, `${w.left(botStart + 10)}`);
  check('total duration spans the whole conversation, gap included',
    w.frames === SR * 2, `${w.frames} frames, expected ${SR * 2}`);
  // Not `dataBytes === frames * 4` — that is how parseWav DERIVES frames, so it
  // is true of any file at all. The real claim is that the channel which ran
  // short reads as silence across the region the other one covers.
  check('the shorter channel is silence, not truncated or repeated',
    w.left(SR * 1.6) === 0 && w.left(SR * 1.9) === 0 && w.right(SR * 1.9) === -2000,
    `L@1.6s ${w.left(SR * 1.6)}, L@1.9s ${w.left(SR * 1.9)}, R@1.9s ${w.right(SR * 1.9)}`);
  check('RIFF size agrees with the file on disk',
    w.riffSize === w.totalBytes - 8, `riff ${w.riffSize}, file ${w.totalBytes}`);
  check('temp channel files are cleaned up', (await leftovers()).length === 0,
    (await leftovers()).join(', '));
}

/* ------------------------------------------------------------------ *
 * 2. The case that is easy to get backwards: TTS arrives FASTER than
 *    real time. Those chunks must concatenate, never be padded apart —
 *    padding mid-sentence would insert silence into a spoken word.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-burst', { dir, now: c.now });
  await r.start();

  // 3 seconds of audio delivered in 100ms of wall clock, as a TTS socket does.
  for (let i = 0; i < 6; i++) {
    r.writeAssistant(pcm(SR / 2, 5000));
    c.advance(16);
  }
  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));

  check('a fast burst is not stretched to wall-clock length',
    w.frames === SR * 3, `${w.frames} frames, expected ${SR * 3}`);
  let contiguous = true;
  for (let i = 0; i < SR * 3; i++) if (w.right(i) !== 5000) { contiguous = false; break; }
  check('...and contains no silence inserted mid-utterance', contiguous);
}

/* ------------------------------------------------------------------ *
 * 3. Both sides at once — barge-in is the reason for stereo.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-overlap', { dir, now: c.now });
  await r.start();
  r.writeAssistant(pcm(SR, 4000)); // assistant talking for 1s from t=0
  c.advance(400);
  r.writeMic(pcm(SR / 2, -4000)); // user cuts in at t=400ms
  c.advance(500);
  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));

  const at = Math.floor(SR * 0.5);
  check('overlapping speech is kept on both channels at once',
    w.right(at) === 4000 && w.left(at) === -4000, `L ${w.left(at)} R ${w.right(at)}`);
  check('the user channel is silent before the barge-in',
    w.left(Math.floor(SR * 0.2)) === 0, `${w.left(Math.floor(SR * 0.2))}`);
}

/* ------------------------------------------------------------------ *
 * 4. Alignment and lifecycle edges.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-odd', { dir, now: c.now });
  await r.start();
  /*
   * An odd byte count would shift every later sample by one byte and turn the
   * rest of the channel into noise. The second chunk is written with NO clock
   * advance on purpose: the write position is then driven by the head rather
   * than by the wall clock, which is the only arrangement in which a half-sample
   * head can actually misalign anything. Checking only the FIRST chunk's samples
   * — as this check used to — passes happily against a recorder with the guard
   * deleted, because the damage is all downstream of it.
   */
  r.writeMic(Buffer.concat([pcm(10, 777), Buffer.from([0x01])]));
  r.writeMic(pcm(10, -555));
  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));
  check('an odd-length chunk does not shift the channel out of alignment',
    w.left(0) === 777 && w.left(9) === 777 && w.left(10) === -555 && w.left(19) === -555,
    `first ${w.left(0)}/${w.left(9)}, second ${w.left(10)}/${w.left(19)}`);
}

{
  const r = new SessionRecorder('rec-empty', { dir });
  await r.start();
  const out = await r.stop();
  check('a recording with no audio produces no file', out === undefined, JSON.stringify(out));
  check('...and leaves no temp files behind', (await leftovers()).length === 0);
}

{
  const c = clock();
  const r = new SessionRecorder('rec-idem', { dir, now: c.now });
  await r.start();
  r.writeMic(pcm(SR, 100));
  c.advance(1000);
  await r.start(); // "Start mic" clicked again mid-conversation
  check('start() is idempotent — the mic toggling does not split the recording',
    r.isRecording, 'not recording after a second start()');
  r.writeMic(pcm(SR, 100));
  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));
  check('...and the second start did not reset the timeline',
    w.frames === SR * 2, `${w.frames} frames, expected ${SR * 2}`);

  r.writeMic(pcm(SR, 100));
  check('writes after stop() are ignored', !r.isRecording);
}

/* ------------------------------------------------------------------ *
 * 5. The disk cap. A forgotten tab must not fill the volume, and what
 *    was captured before the cap must still be readable.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  // 1/60 of a minute = 1 second.
  const r = new SessionRecorder('rec-cap', { dir, now: c.now, maxMinutes: 1 / 60 });
  await r.start();
  r.writeMic(pcm(SR * 2, 900)); // two seconds against a one-second cap
  check('the cap stops the recording', !r.isRecording);
  const out = await r.stop();
  check('a capped recording is still finalized, not discarded', out !== undefined);
  check('...and is reported as truncated', out?.truncated === true);
  const w = parseWav(await readFile(out!.path));
  check('...and the audio captured before the cap is intact',
    w.left(0) === 900 && w.frames > 0, `${w.frames} frames`);
}

/* ------------------------------------------------------------------ *
 * 6. Barge-in. TTS renders ~10x faster than real time, so a cancelled
 *    utterance leaves the channel seconds ahead of the clock. Without
 *    interrupt() that lead is permanent and every later assistant turn
 *    is displaced by it — one barge-in used to turn a 2.7s conversation
 *    into a 7.00s file.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-barge', { dir, now: c.now });
  await r.start();

  // Assistant renders 5s of speech in 500ms of wall clock...
  r.writeAssistant(pcm(SR * 5, 1111));
  c.advance(600);
  // ...the user cuts in at t=600ms, so the rest was never heard.
  r.interrupt();
  c.advance(1900);
  // Turn two answers at t=2500ms.
  r.writeAssistant(pcm(SR / 2, 2222));
  c.advance(500);

  const out = await r.stop();
  const w = parseWav(await readFile(out!.path));

  const turn2 = Math.floor(SR * 2.5);
  check('a barge-in truncates assistant audio the user never heard',
    w.right(Math.floor(SR * 1.0)) === 0, `${w.right(Math.floor(SR * 1.0))}`);
  check('...but keeps what was heard before the cut',
    w.right(Math.floor(SR * 0.3)) === 1111, `${w.right(Math.floor(SR * 0.3))}`);
  check('...and the NEXT turn lands at its own wall-clock time',
    w.right(turn2 + 10) === 2222 && w.right(turn2 - 10) === 0,
    `before ${w.right(turn2 - 10)}, after ${w.right(turn2 + 10)}`);
  check('...so the file is as long as the conversation, not as long as the audio',
    Math.abs(w.frames - SR * 3) < SR * 0.05, `${(w.frames / SR).toFixed(2)}s, expected ~3.00s`);
}

/* ------------------------------------------------------------------ *
 * 7. The cap must bound the WRITE, not merely notice afterwards.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-gap', { dir, now: c.now, maxMinutes: 1 / 60 });
  await r.start();
  r.writeMic(pcm(SR / 20, 900)); // 50ms of audio
  c.advance(60 * 1000); // ...then a full minute of nothing
  r.writeMic(pcm(SR / 20, 900)); // one more frame, a minute later
  const out = await r.stop();
  check('a huge clock gap cannot blow past the cap', out !== undefined);
  check('...the file is bounded by the cap, not by the wall clock',
    out!.durationMs <= 1100, `${(out!.durationMs / 1000).toFixed(1)}s for a 1s cap`);
}

/* ------------------------------------------------------------------ *
 * 8. A cap past the 32-bit WAV size field used to record for hours and
 *    then throw inside stop(), whose catch deleted every byte.
 * ------------------------------------------------------------------ */
{
  const c = clock();
  const r = new SessionRecorder('rec-huge', { dir, now: c.now, maxMinutes: 1440 });
  await r.start();
  r.writeMic(pcm(10, 5));
  // 800 minutes is past the ~745 a 32-bit RIFF size can address. Unclamped, the
  // recorder accepts the position, and `wavHeader` then throws inside `stop()`
  // — whose catch deletes every byte captured.
  c.advance(800 * 60 * 1000);
  r.writeMic(pcm(10, 5));
  // `.catch` on purpose: unclamped, `stop()` REJECTS out of wavHeader, which
  // without this takes the whole run down on an unhandled rejection and hides
  // every check after it. A destroyed recording should read as one failed
  // check, not as a dead process.
  const out = await r.stop().catch(() => undefined);
  check('a cap beyond the WAV 32-bit size field is clamped, not fatal', out !== undefined,
    'stop() threw or produced nothing — the recording was destroyed');
  check('...and nothing is written past the ceiling',
    (out?.durationMs ?? 0) < 746 * 60 * 1000, `${((out?.durationMs ?? 0) / 60000).toFixed(0)} min`);
}
{
  let threw = false;
  try {
    wavHeader(0x7fffffff, SR);
  } catch {
    threw = true;
  }
  check('wavHeader refuses a size that does not fit rather than emitting a corrupt one', threw);
}

/* ------------------------------------------------------------------ *
 * 9. Failures are surfaced, not swallowed.
 * ------------------------------------------------------------------ */
{
  // A FILE where the directory should be: mkdir cannot succeed.
  const blocked = join(dir, 'not-a-dir');
  await writeFile(blocked, 'x');
  const r = new SessionRecorder('rec-blocked', { dir: blocked });
  let rejected = false;
  await r.start().catch(() => (rejected = true));
  check('start() rejects when its directory cannot be created', rejected,
    'start() resolved and the failure was invisible');
  check('...and the recorder reports itself as not recording', !r.isRecording);
}

/* ------------------------------------------------------------------ *
 * 10. `ws` does not serialize async message handlers, so a conversation
 *     can END while start()'s file opens are still in flight.
 * ------------------------------------------------------------------ */
{
  const r = new SessionRecorder('rec-race', { dir });
  const starting = r.start(); // deliberately NOT awaited
  const stopped = await r.stop();
  await starting;
  check('a stop() racing start() leaves no recording', stopped === undefined, JSON.stringify(stopped));
  check('...and no orphaned channel files', (await leftovers()).length === 0,
    (await leftovers()).join(', '));
  check('...and the recorder is not left recording', !r.isRecording);
}

check('no temp files survive the whole run', (await leftovers()).length === 0,
  (await leftovers()).join(', '));

await rm(dir, { recursive: true, force: true });

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
