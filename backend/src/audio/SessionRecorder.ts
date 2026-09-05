import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CANONICAL_SAMPLE_RATE } from '../shared/protocol.js';

/**
 * Records both directions of one conversation to a single stereo WAV:
 * **left = the microphone, right = the assistant.**
 *
 * Why stereo rather than two files or a mono mix. A mix cannot be taken apart
 * again, and two files lose the thing that makes the recording worth having —
 * the timing BETWEEN the sides. In one stereo file a late first frame, or an
 * assistant still talking over the user, is audible and measurable, and either
 * channel still solos in any editor. Downmixing to mono is a one-liner for
 * whoever wants it; unmixing is not.
 *
 * ---------------------------------------------------------------------------
 * The timeline is the whole problem
 * ---------------------------------------------------------------------------
 * Concatenating chunks as they arrive would produce a file with the right audio
 * and the wrong conversation: every silence squeezed out, so a 40-second
 * exchange with two long pauses plays back as 12 seconds of back-to-back speech
 * and every latency in it is invisible.
 *
 * So a chunk is written AT A POSITION rather than appended: `max(head, now)`,
 * where `head` is how far that channel has been written and `now` is the wall
 * clock. Behind the clock, the gap becomes a hole in the file, which reads back
 * as the silence it represents. Ahead of it, the chunk lands at the head.
 *
 * That second case is the one that is easy to get wrong. TTS arrives FASTER
 * than real time — a 3.3s utterance can land in ~700ms — so an assistant chunk
 * is routinely "early". Those go at the head, never at the clock: an utterance
 * must be laid down contiguously or the silence gets cut into the middle of a
 * spoken word.
 *
 * Positions rather than an append-only stream buys three things at once. A gap
 * costs a seek instead of a multi-megabyte buffer of zeros; the sparse region
 * costs no disk on any filesystem that supports holes; and a head that has run
 * ahead can be CLAWED BACK, which is what `interrupt()` exists for.
 *
 * ---------------------------------------------------------------------------
 * Barge-in, and why it needs `interrupt()`
 * ---------------------------------------------------------------------------
 * A channel's lead is not harmless. TTS renders ~10x faster than real time, so
 * after one 5-second utterance the right channel is ~4.5s ahead of the clock.
 * If the user then cuts in and that utterance is cancelled, the tail was never
 * heard — but it has already been written, and every later assistant turn is
 * appended after it instead of landing at its own real time. One barge-in used
 * to turn a 2.7s conversation into a 7.00s file with turn two 2500ms late, and
 * the error never washed out.
 *
 * `interrupt()` clamps the assistant head back to the wall clock and truncates
 * the audio the user never heard, so the next turn lands where it belongs. It
 * is an approximation in one direction only: the browser plays from a jitter
 * buffer, so it had heard very slightly LESS than this cuts at.
 *
 * ---------------------------------------------------------------------------
 * What the file is, and is not
 * ---------------------------------------------------------------------------
 * A record of when each side's audio reached the SERVER. That is the same clock
 * the latency metrics use, which is what makes the file agree with the numbers.
 * It is NOT what the user heard — the browser buffers and plays at real time, so
 * true playback lags this by the jitter buffer. Do not read inter-channel gaps
 * here as perceived response time.
 */

/** 16-bit PCM, so one sample is two bytes on both channels. */
const BYTES_PER_SAMPLE = 2;
const CHANNELS = 2;
const WAV_HEADER_BYTES = 44;

/** Interleave block. 1s per channel keeps the finalize pass off the heap. */
const INTERLEAVE_SAMPLES = CANONICAL_SAMPLE_RATE;

/**
 * Stops a forgotten tab from filling the disk. Stereo PCM16 @ 24 kHz is
 * ~5.8 MB per minute, and this records for as long as a conversation is open,
 * so an unbounded default is a real hazard rather than a theoretical one. When
 * the cap is hit the recording is FINALIZED rather than discarded — a truncated
 * recording of a long call is worth much more than nothing.
 */
const DEFAULT_MAX_MINUTES = 60;

/**
 * A WAV's RIFF and data sizes are unsigned 32-bit. Past this many frames they
 * do not wrap, they THROW out of `writeUInt32LE` — inside `stop()`, whose catch
 * would then delete every byte captured. `SESSION_AUDIO_MAX_MINUTES=1440` is a
 * reasonable thing to set given the docs, and used to record 12.4 hours
 * perfectly and then destroy all of it. The cap is clamped here instead.
 */
const MAX_TOTAL_SAMPLES = Math.floor((0xffffffff - WAV_HEADER_BYTES) / (CHANNELS * BYTES_PER_SAMPLE));

export interface RecordingResult {
  path: string;
  bytes: number;
  durationMs: number;
  /** True when the cap ended the recording before the conversation did. */
  truncated: boolean;
}

interface Channel {
  file: FileHandle;
  path: string;
  /** Samples written so far — the channel's own position on the timeline. */
  head: number;
  /**
   * Serializes this channel's writes. `writeMic`/`writeAssistant` are called
   * from the socket's hot path and must not await, but the work still has to
   * complete in order (a truncate must not overtake a write) and its errors
   * still have to be caught. Chaining does both, and gives the write path
   * natural backpressure instead of an unbounded in-memory queue.
   */
  queue: Promise<void>;
}

export class SessionRecorder {
  private readonly dir: string;
  private readonly sampleRate: number;
  private readonly maxSamples: number;
  private readonly now: () => number;

  private mic?: Channel;
  private bot?: Channel;
  private t0 = 0;
  private started = false;
  private stopped = false;
  private truncated = false;
  private failed?: Error;

  constructor(
    private readonly recordId: string,
    opts: { dir?: string; sampleRate?: number; maxMinutes?: number; now?: () => number } = {},
  ) {
    // No `process.env` here. Process configuration is `config.ts`'s job, and the
    // directory in particular has to be the SAME one SessionStore uses or the
    // audio route 404s on a file that exists.
    this.dir = resolve(opts.dir ?? 'data/sessions');
    this.sampleRate = opts.sampleRate ?? CANONICAL_SAMPLE_RATE;
    const minutes = opts.maxMinutes ?? DEFAULT_MAX_MINUTES;
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_MINUTES;
    this.maxSamples = Math.min(Math.floor(safeMinutes * 60 * this.sampleRate), MAX_TOTAL_SAMPLES);
    this.now = opts.now ?? (() => performance.now());
  }

  get isRecording(): boolean {
    return this.started && !this.stopped;
  }

  /** Set when the recording could not be written. Surfaced by `stop()`. */
  get error(): Error | undefined {
    return this.failed;
  }

  /**
   * Idempotent: "Start mic" can be clicked again mid-conversation, and a session
   * that begins with the mic already hot arms this a second time.
   *
   * Rejects if the directory cannot be created. A silent failure here used to
   * mean the operator learned nothing at all — `start()` resolved, `stop()`
   * returned undefined, and the audio simply never existed.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.t0 = this.now();
    try {
      await mkdir(this.dir, { recursive: true });
      const nonce = randomUUID().slice(0, 8);
      const [mic, bot] = await Promise.all([
        this.openChannel(`${this.recordId}.mic.${nonce}.tmp`),
        this.openChannel(`${this.recordId}.bot.${nonce}.tmp`),
      ]);
      this.mic = mic;
      this.bot = bot;
      /*
       * The conversation may have ended while those opens were in flight — the
       * `ws` library does NOT serialize async message handlers, so an
       * `end_conversation` can be processed between this `start()`'s first await
       * and its last. `stop()` would have found no channels and returned, and
       * these two would then belong to a recorder nobody will ever close: two
       * descriptors and two temp files, leaked per occurrence.
       */
      if (this.stopped) {
        this.mic = undefined;
        this.bot = undefined;
        await this.discard(mic, bot);
      }
    } catch (err) {
      this.failed = err as Error;
      this.stopped = true;
      await this.closeChannels();
      throw err;
    }
  }

  private async openChannel(name: string): Promise<Channel> {
    const path = join(this.dir, name);
    // 'w+' because a hole is written by seeking past the end, and `interrupt()`
    // truncates — neither is possible on an append-only stream.
    const file = await open(path, 'w+');
    return { file, path, head: 0, queue: Promise.resolve() };
  }

  /** PCM16 LE mono @ sampleRate, exactly as it arrived from the browser. */
  writeMic(chunk: Buffer): void {
    this.write(this.mic, chunk);
  }

  /** PCM16 LE mono @ sampleRate, exactly as it went out to the browser. */
  writeAssistant(chunk: Buffer): void {
    this.write(this.bot, chunk);
  }

  /**
   * The user cut in: drop assistant audio that was generated but never heard,
   * and put the head back on the wall clock so the next turn lands at its own
   * real time. Without this one barge-in displaces every later assistant event
   * for the rest of the conversation.
   */
  interrupt(): void {
    const ch = this.bot;
    if (!ch || !this.isRecording) return;
    const now = this.elapsed();
    if (ch.head <= now) return;
    ch.head = now;
    this.enqueue(ch, (file) => file.truncate(now * BYTES_PER_SAMPLE));
  }

  private elapsed(): number {
    // A clock that has gone backwards must not produce a negative position.
    return Math.max(0, Math.round(((this.now() - this.t0) / 1000) * this.sampleRate));
  }

  private write(ch: Channel | undefined, chunk: Buffer): void {
    if (!ch || !this.isRecording || chunk.length === 0) return;

    // An odd byte count would shift every following sample by one byte and turn
    // the rest of the channel into noise. Drop the stray byte instead.
    const body = chunk.length % BYTES_PER_SAMPLE === 0 ? chunk : chunk.subarray(0, chunk.length - 1);
    if (body.length === 0) return;

    // Behind the clock: seek, and the gap becomes silence. Ahead of it: stay at
    // the head, so an utterance is never cut into.
    const at = Math.max(ch.head, this.elapsed());
    if (at >= this.maxSamples) {
      this.truncated = true;
      this.stopped = true;
      return;
    }

    /*
     * Clamped BEFORE anything is written. The cap used to be checked after the
     * fact, which meant a single frame arriving after a long stall wrote a gap
     * sized by the wall clock rather than by the cap — one probe produced 345 MB
     * from a recorder configured for 5.8 MB, allocated in one shot on the
     * socket's own hot path.
     */
    // `Math.max(0, ...)` so a negative room can never turn into a negative
    // length and a corrupt head. Unreachable while the guard above stands, which
    // is exactly why it is worth the one call: it keeps a future edit to that
    // guard producing a failed check rather than a crashed process.
    const room = Math.max(0, this.maxSamples - at);
    const samples = Math.min(body.length / BYTES_PER_SAMPLE, room);
    const slice = samples * BYTES_PER_SAMPLE === body.length ? body : body.subarray(0, samples * BYTES_PER_SAMPLE);

    ch.head = at + samples;
    this.enqueue(ch, (file) => file.write(slice, 0, slice.length, at * BYTES_PER_SAMPLE).then(() => {}));

    if (ch.head >= this.maxSamples) {
      this.truncated = true;
      this.stopped = true;
    }
  }

  /** Chains onto this channel's queue, capturing the first error rather than rejecting. */
  private enqueue(ch: Channel, work: (file: FileHandle) => Promise<void>): void {
    ch.queue = ch.queue.then(
      () => work(ch.file),
      () => undefined,
    ).catch((err: Error) => {
      this.failed ??= err;
      this.stopped = true;
    });
  }

  /**
   * Closes both channels and interleaves them into `<recordId>.wav`.
   *
   * Returns undefined when there was nothing to record. THROWS when the
   * recording was started but could not be written — the caller is expected to
   * log that and carry on, because losing the audio must not also cost the
   * conversation its bill.
   */
  async stop(): Promise<RecordingResult | undefined> {
    if (!this.started) return undefined;
    this.stopped = true;
    const mic = this.mic;
    const bot = this.bot;
    this.mic = undefined;
    this.bot = undefined;
    if (!mic || !bot) {
      if (this.failed) throw this.failed;
      return undefined;
    }

    // Every queued write and truncate has to land before the bytes are read back.
    await Promise.all([mic.queue, bot.queue]);

    const totalSamples = Math.max(mic.head, bot.head);
    if (this.failed || totalSamples === 0) {
      await this.discard(mic, bot);
      if (this.failed) throw this.failed;
      return undefined;
    }

    const target = join(this.dir, `${this.recordId}.wav`);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await this.interleave(mic, bot, totalSamples, tmp);
      // Renamed into place so a reader never sees a half-written WAV, the same
      // guarantee SessionStore gives the JSON beside it.
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    } finally {
      await this.discard(mic, bot);
    }

    return {
      path: target,
      bytes: WAV_HEADER_BYTES + totalSamples * CHANNELS * BYTES_PER_SAMPLE,
      durationMs: (totalSamples / this.sampleRate) * 1000,
      truncated: this.truncated,
    };
  }

  private async closeChannels(): Promise<void> {
    for (const ch of [this.mic, this.bot]) {
      if (ch) await ch.file.close().catch(() => {});
    }
    this.mic = undefined;
    this.bot = undefined;
  }

  private async discard(...channels: Channel[]): Promise<void> {
    for (const ch of channels) {
      await ch.file.close().catch(() => {});
      await unlink(ch.path).catch(() => {});
    }
  }

  private async interleave(mic: Channel, bot: Channel, totalSamples: number, out: string): Promise<void> {
    /*
     * Opened one at a time, each recorded before the next is attempted. A
     * `Promise.all` of three `open()`s rejects on the first failure while the
     * others still resolve to real handles that nothing then holds or closes —
     * measured at exactly two leaked descriptors per failure, on a process that
     * is meant to run for days.
     */
    const opened: FileHandle[] = [];
    try {
      const micFile = await open(mic.path, 'r');
      opened.push(micFile);
      const botFile = await open(bot.path, 'r');
      opened.push(botFile);
      const outFile = await open(out, 'w');
      opened.push(outFile);

      await outFile.write(wavHeader(totalSamples, this.sampleRate));
      const left = Buffer.alloc(INTERLEAVE_SAMPLES * BYTES_PER_SAMPLE);
      const right = Buffer.alloc(INTERLEAVE_SAMPLES * BYTES_PER_SAMPLE);
      const frame = Buffer.alloc(INTERLEAVE_SAMPLES * CHANNELS * BYTES_PER_SAMPLE);

      for (let done = 0; done < totalSamples; done += INTERLEAVE_SAMPLES) {
        const count = Math.min(INTERLEAVE_SAMPLES, totalSamples - done);
        const bytes = count * BYTES_PER_SAMPLE;
        // A channel that ran short — or a hole where nothing was ever written —
        // reads zero bytes, and the pre-zeroed buffer is exactly the silence
        // that channel should carry there.
        left.fill(0, 0, bytes);
        right.fill(0, 0, bytes);
        await readFully(micFile, left, bytes, done * BYTES_PER_SAMPLE);
        await readFully(botFile, right, bytes, done * BYTES_PER_SAMPLE);
        for (let i = 0; i < count; i++) {
          frame.writeInt16LE(left.readInt16LE(i * 2), i * 4);
          frame.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2);
        }
        await outFile.write(frame, 0, count * CHANNELS * BYTES_PER_SAMPLE);
      }
    } finally {
      for (const file of opened) await file.close().catch(() => {});
    }
  }
}

/**
 * `read()` is permitted to return fewer bytes than asked for. On a local file
 * that is rare, but a short read would silently substitute silence for audio
 * rather than failing, which is the worst of both outcomes.
 */
async function readFully(file: FileHandle, into: Buffer, bytes: number, position: number): Promise<void> {
  let got = 0;
  while (got < bytes) {
    const { bytesRead } = await file.read(into, got, bytes - got, position + got);
    if (bytesRead === 0) return; // genuine EOF: the rest stays silence
    got += bytesRead;
  }
}

/** Canonical 44-byte PCM WAV header. */
export function wavHeader(totalSamples: number, sampleRate: number, channels = CHANNELS): Buffer {
  const dataBytes = totalSamples * channels * BYTES_PER_SAMPLE;
  if (!Number.isInteger(dataBytes) || dataBytes < 0 || dataBytes + 36 > 0xffffffff) {
    throw new RangeError(`WAV data size ${dataBytes} does not fit a 32-bit RIFF header`);
  }
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // PCM fmt chunk size
  h.writeUInt16LE(1, 20); // format = PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
