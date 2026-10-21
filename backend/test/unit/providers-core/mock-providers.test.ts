/**
 * The mock providers are permanent reference implementations: they exercise
 * every callback, honour cancel/abort immediately, and emit PCM16 LE mono at the
 * rate they are asked for (the canonical 24 kHz at the session boundary).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSttProvider } from '../../../src/providers/stt/MockSttProvider.js';
import { MockLlmProvider } from '../../../src/providers/llm/MockLlmProvider.js';
import { MockTtsProvider } from '../../../src/providers/tts/MockTtsProvider.js';
import { MockRealtimeProvider } from '../../../src/providers/realtime/MockRealtimeProvider.js';
import { pcm16DurationMs, rms, silence, tone } from '../../../src/audio/pcm.js';
import type { LlmMessage, SttEvents, SttOptions, TtsEvents, TtsOptions, VoiceSession } from '../../../src/providers/types.js';
import type { StartConfig } from '../../../src/shared/protocol.js';
import { BYTES_PER_SECOND, Recorder, SR, loud, markAt, markNames, quiet, tick, useFakeClock } from './helpers.js';

const CANNED = [
  'What is the weather like today',
  'Tell me a short joke about latency',
  'Can you summarise that in one sentence',
  'How long does it take you to respond',
];

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

/** Push `ms` of audio in 40 ms frames. */
function frames(push: (b: Buffer) => void, ms: number, gen: (s: number, rate?: number) => Buffer, rate = SR) {
  for (let t = 0; t < ms; t += 40) push(gen(0.04, rate));
}

/* ================================== STT ================================== */

describe('MockSttProvider', () => {
  function sttEvents() {
    const log: string[] = [];
    const ev: SttEvents & { log: string[] } = {
      log,
      onPartial: (t) => void log.push(`partial:${t}`),
      onFinal: (t) => void log.push(`final:${t}`),
      onSpeechEnd: () => void log.push('speech_end'),
      onError: (e) => void log.push(`error:${e.message}`),
    };
    return ev;
  }
  const opts = (o: Partial<SttOptions> = {}): SttOptions => ({ model: 'mock-asr', sampleRate: SR, credentials: {}, vad: true, ...o });

  it('identifies itself as the catalog id', () => {
    const p = new MockSttProvider();
    expect(p.id).toBe('mock-stt');
    expect(p.name).toBeTruthy();
  });

  it.each(CANNED.map((t, i) => [i, t] as const))('picks canned transcript %i from Math.random', async (i, text) => {
    vi.spyOn(Math, 'random').mockReturnValue(i / CANNED.length + 0.01);
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts({ vad: false }), ev);
    s.pushAudio(loud(0.2));
    s.finalize();
    expect(ev.log).toEqual([`final:${text}`]);
  });

  it('server VAD: speech then >600 ms of silence -> speech_end, then the final, once', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.pushAudio(loud(0.5));
    frames((b) => s.pushAudio(b), 600, quiet); // exactly 600 ms: not yet (strictly greater)
    expect(ev.log).toEqual([]);
    s.pushAudio(quiet(0.04)); // 640 ms
    expect(ev.log).toEqual(['speech_end', `final:${CANNED[0]}`]);
    frames((b) => s.pushAudio(b), 2000, quiet); // more silence never re-fires
    expect(ev.log).toEqual(['speech_end', `final:${CANNED[0]}`]);
  });

  it('a partial (first three words) arrives 250 ms after speech starts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.pushAudio(loud(0.1));
    await vi.advanceTimersByTimeAsync(249);
    expect(ev.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.log).toEqual(['partial:What is the']);
    s.pushAudio(loud(0.1)); // continued speech does not re-arm the partial
    await vi.advanceTimersByTimeAsync(1000);
    expect(ev.log).toEqual(['partial:What is the']);
  });

  it('a final before the partial timer fires cancels the partial', async () => {
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.pushAudio(loud(0.1));
    frames((b) => s.pushAudio(b), 680, quiet);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ev.log.filter((l) => l.startsWith('partial'))).toEqual([]);
    expect(ev.log.filter((l) => l.startsWith('final'))).toHaveLength(1);
  });

  it('without VAD, silence never ends the utterance; finalize() does', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts({ vad: false }), ev);
    s.pushAudio(loud(0.3));
    frames((b) => s.pushAudio(b), 3000, quiet);
    expect(ev.log.filter((l) => !l.startsWith('partial'))).toEqual([]);
    s.finalize();
    expect(ev.log.at(-1)).toBe(`final:${CANNED[0]}`);
    expect(ev.log).not.toContain('speech_end');
  });

  it('finalize() with no audio at all yields an empty final (silence, not a turn)', async () => {
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.finalize();
    expect(ev.log).toEqual(['final:']);
  });

  it('a second utterance after a final is recognised again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    for (let i = 0; i < 2; i++) {
      s.pushAudio(loud(0.1));
      frames((b) => s.pushAudio(b), 680, quiet);
    }
    expect(ev.log.filter((l) => l === 'speech_end')).toHaveLength(2);
    expect(ev.log.filter((l) => l.startsWith('final:What'))).toHaveLength(2);
  });

  it('measures silence at the sample rate it was opened with', async () => {
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts({ sampleRate: 16000 }), ev);
    s.pushAudio(loud(0.1, 16000));
    s.pushAudio(quiet(0.59, 16000));
    expect(ev.log).toEqual([]);
    s.pushAudio(quiet(0.02, 16000)); // 610 ms at 16 kHz
    expect(ev.log).toContain('speech_end');
  });

  it('close() silences it: no partial, no final, no speech_end afterwards', async () => {
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.pushAudio(loud(0.1));
    s.close();
    frames((b) => s.pushAudio(b), 1000, quiet);
    s.pushAudio(loud(0.1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(ev.log).toEqual([]);
  });

  it('never reports an error on its own', async () => {
    const ev = sttEvents();
    const s = await new MockSttProvider().open(opts(), ev);
    s.pushAudio(loud(1));
    frames((b) => s.pushAudio(b), 1000, quiet);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ev.log.some((l) => l.startsWith('error'))).toBe(false);
  });
});

/* ================================== LLM ================================== */

describe('MockLlmProvider', () => {
  function run(messages: LlmMessage[]) {
    const deltas: Array<{ t: number; text: string }> = [];
    const done: string[] = [];
    const usage: unknown[] = [];
    const errors: Error[] = [];
    const start = Date.now();
    const h = new MockLlmProvider().stream({ model: 'mock-chat', credentials: {} }, messages, {
      onDelta: (text) => void deltas.push({ t: Date.now() - start, text }),
      onDone: (f) => void done.push(f),
      onUsage: (u) => void usage.push(u),
      onError: (e) => void errors.push(e),
    });
    return { h, deltas, done, usage, errors };
  }
  const reply = (said: string) =>
    `You said: ${said}. This is the mock model replying so you can measure the transport, not the model.`;

  it('identifies itself as the catalog id', () => {
    expect(new MockLlmProvider().id).toBe('mock-llm');
  });

  it('first token at 180 ms, then one word every 12 ms, then onDone with the full text', async () => {
    const r = run([{ role: 'user', content: 'hello' }]);
    await vi.advanceTimersByTimeAsync(179);
    expect(r.deltas).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.deltas).toEqual([{ t: 180, text: 'You' }]);
    await vi.advanceTimersByTimeAsync(5000);
    const full = reply('hello');
    const words = full.split(' ');
    expect(r.deltas.map((d) => d.text)).toEqual(words.map((w, i) => (i ? ` ${w}` : w)));
    expect(r.deltas.map((d) => d.t)).toEqual(words.map((_, i) => 180 + 12 * i));
    expect(r.deltas.map((d) => d.text).join('')).toBe(full);
    expect(r.done).toEqual([full]);
    expect(r.errors).toEqual([]);
  });

  it('answers the LAST user message, ignoring system and assistant turns', async () => {
    const r = run([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: '  second  ' },
      { role: 'assistant', content: 'b' },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.done).toEqual([reply('second')]);
  });

  it.each([
    ['no user message', [{ role: 'system', content: 's' }] as LlmMessage[]],
    ['a blank user message', [{ role: 'user', content: '   ' }] as LlmMessage[]],
    ['no messages', [] as LlmMessage[]],
  ])('says "(nothing)" for %s', async (_l, msgs) => {
    const r = run(msgs);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.done).toEqual([reply('(nothing)')]);
  });

  it('never reports usage, so the pipeline must estimate and flag it local', async () => {
    const r = run([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.usage).toEqual([]);
  });

  it('abort before the first token: nothing is ever emitted', async () => {
    const r = run([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(100);
    r.h.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.deltas).toEqual([]);
    expect(r.done).toEqual([]);
  });

  it('abort mid-stream stops immediately: no further delta, no onDone', async () => {
    const r = run([{ role: 'user', content: 'x' }]);
    await vi.advanceTimersByTimeAsync(180 + 12 * 3);
    const n = r.deltas.length;
    expect(n).toBe(4);
    r.h.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.deltas).toHaveLength(n);
    expect(r.done).toEqual([]);
    r.h.abort(); // idempotent
  });

  it('concurrent streams are independent', async () => {
    const a = run([{ role: 'user', content: 'a' }]);
    const b = run([{ role: 'user', content: 'b' }]);
    await vi.advanceTimersByTimeAsync(200);
    a.h.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.done).toEqual([]);
    expect(b.done).toEqual([reply('b')]);
  });
});

/* ================================== TTS ================================== */

describe('MockTtsProvider', () => {
  function events() {
    const audio: Array<{ t: number; buf: Buffer }> = [];
    let done = 0;
    const errors: Error[] = [];
    const start = Date.now();
    const ev: TtsEvents = {
      onAudio: (buf) => void audio.push({ t: Date.now() - start, buf }),
      onDone: () => void (done += 1),
      onError: (e) => void errors.push(e),
    };
    return { ev, audio, errors, get done() { return done; } };
  }
  const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({ model: 'mock-voice', sampleRate: SR, credentials: {}, ...o });
  /** Exactly what the mock synthesises for these words, in order. */
  const expected = (words: string[], rate = SR) =>
    Buffer.concat(words.flatMap((w, i) => [tone(Math.min(240, 60 + w.length * 22), 180 + ((i * 37) % 160), rate), silence(50, rate)]));

  it('identifies itself as the catalog id', () => {
    expect(new MockTtsProvider().id).toBe('mock-tts');
  });

  it('synthesises one blip per word, PCM16 at 24 kHz in <=40 ms frames, then onDone once', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('hello there ');
    s.pushText('general kenobi');
    s.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const all = Buffer.concat(e.audio.map((a) => a.buf));
    expect(all.equals(expected(['hello', 'there', 'general', 'kenobi']))).toBe(true);
    for (const { buf } of e.audio) {
      expect(buf.length % 2).toBe(0);
      expect(buf.length).toBeLessThanOrEqual((40 * SR * 2) / 1000);
      expect(buf.length).toBeGreaterThan(0);
    }
    expect(rms(all)).toBeGreaterThan(0.01);
    expect(e.done).toBe(1);
    expect(e.errors).toEqual([]);
  });

  it('first audio after a simulated 90 ms TTFB', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('one two ');
    await vi.advanceTimersByTimeAsync(89);
    expect(e.audio).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.audio[0].t).toBe(90);
  });

  it('streams before flush: text on a word boundary is synthesised immediately', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('streaming words ');
    await vi.advanceTimersByTimeAsync(500);
    expect(e.audio.length).toBeGreaterThan(0);
    expect(e.done).toBe(0); // not flushed, so not done
  });

  it('holds a partial word until a boundary or flush', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('unfinish');
    await vi.advanceTimersByTimeAsync(500);
    expect(e.audio).toEqual([]);
    s.pushText('ed');
    s.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(Buffer.concat(e.audio.map((a) => a.buf)).equals(expected(['unfinished']))).toBe(true);
    expect(e.done).toBe(1);
  });

  it('flush with no text still finishes (onDone, no audio)', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(e.audio).toEqual([]);
    expect(e.done).toBe(1);
  });

  it.each([16000, 22050, 48000])('honours sampleRate %i (frames sized for that rate)', async (rate) => {
    const e = events();
    const s = await new MockTtsProvider().open(opts({ sampleRate: rate }), e.ev);
    s.pushText('alpha beta');
    s.flush();
    await vi.advanceTimersByTimeAsync(5000);
    const all = Buffer.concat(e.audio.map((a) => a.buf));
    expect(all.equals(expected(['alpha', 'beta'], rate))).toBe(true);
    for (const { buf } of e.audio) expect(buf.length).toBeLessThanOrEqual((40 * rate * 2) / 1000);
  });

  it('cancel() is immediate: no audio and no onDone afterwards, further text ignored', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('one two three four five six seven eight ');
    await vi.advanceTimersByTimeAsync(150);
    const n = e.audio.length;
    expect(n).toBeGreaterThan(0);
    s.cancel();
    s.pushText('more words ');
    s.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.audio).toHaveLength(n);
    expect(e.done).toBe(0);
  });

  it('cancel() before the TTFB elapses emits nothing at all', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('one two ');
    s.flush();
    s.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.audio).toEqual([]);
    expect(e.done).toBe(0);
  });

  it('close() behaves like cancel()', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    s.pushText('one two three ');
    s.flush();
    await vi.advanceTimersByTimeAsync(100);
    const n = e.audio.length;
    s.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.audio).toHaveLength(n);
    expect(e.done).toBe(0);
  });

  it('total audio duration is the sum of the per-word blips', async () => {
    const e = events();
    const s = await new MockTtsProvider().open(opts(), e.ev);
    const words = ['a', 'bb', 'supercalifragilistic'];
    s.pushText(words.join(' '));
    s.flush();
    await vi.advanceTimersByTimeAsync(5000);
    const bytes = e.audio.reduce((n, a) => n + a.buf.length, 0);
    const ms = words.reduce((n, w) => n + Math.min(240, 60 + w.length * 22) + 50, 0);
    expect(pcm16DurationMs(bytes)).toBeCloseTo(ms, 0);
  });
});

/* ================================ realtime ================================ */

describe('MockRealtimeProvider', () => {
  const REPLY_PREFIX = 'You typed: ';
  function session(config: Partial<StartConfig> = {}) {
    const rec = new Recorder();
    const cfg: StartConfig = { mode: 'realtime', realtimeModelId: 'mock-s2s', systemPrompt: '', turnDetection: 'server_vad', ...config };
    const s: VoiceSession = new MockRealtimeProvider().createSession({ sessionId: 'rt-1', config: cfg, events: rec, credentials: {} });
    return { s, rec };
  }
  /** Bytes the mock will speak for `text`. */
  const replyBytes = (text: string) =>
    text.split(' ').reduce((n, w, i) => n + tone(Math.min(240, 60 + w.length * 22), 190 + ((i * 41) % 150)).length + silence(50).length, 0);

  it('identifies itself and its session', async () => {
    const p = new MockRealtimeProvider();
    expect(p.id).toBe('mock-realtime');
    const { s, rec } = session();
    expect(s.id).toBe('rt-1');
    expect(s.mode).toBe('realtime');
    expect(s.label).toBe('mock-realtime:mock-s2s');
    await s.start();
    expect(rec.of('log').map((l) => l.level)).toEqual(['info']);
  });

  it('sendText: transcript, turn start, audio after ~300 ms in 40 ms PCM16 frames, then turn end + metrics + usage', async () => {
    const { s, rec } = session();
    await s.start();
    s.pushAudio(loud(1.5)); // billable input that precedes the turn
    // pushAudio of loud audio flags speech; commit is not what we test here.
    s.sendText('hello');
    expect(rec.of('user')).toEqual([{ type: 'user', text: 'hello', final: true, turnId: 1 }]);
    expect(rec.turnStarts).toEqual([1]);

    await vi.advanceTimersByTimeAsync(299);
    expect(rec.audio).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.audio).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    const text = `${REPLY_PREFIX}hello. The mock realtime provider replies with a synthetic voice.`;
    const total = rec.audio.reduce((n, b) => n + b.length, 0);
    expect(total).toBe(replyBytes(text));
    for (const b of rec.audio) {
      expect(b.length % 2).toBe(0);
      expect(b.length).toBeLessThanOrEqual(1920); // 40 ms @ 24 kHz
    }
    expect(rms(Buffer.concat(rec.audio))).toBeGreaterThan(0.01);

    const asst = rec.of('assistant');
    expect(asst.at(-1)).toEqual({ type: 'assistant', text, final: true, turnId: 1 });
    const partials = asst.filter((a) => !a.final).map((a) => a.text);
    expect(partials.length).toBeGreaterThan(1);
    for (let i = 1; i < partials.length; i++) expect(partials[i].startsWith(partials[i - 1])).toBe(true);

    expect(rec.sequence()).toEqual(['turn_start:1', 'turn_end:1', 'metrics:1', 'usage:1']);
    const m = rec.metrics[0];
    expect(markNames(m)).toEqual(['user_speech_end', 'first_audio_out', 'last_audio_out']);
    expect(markAt(m, 'user_speech_end')).toBe(0);
    expect(m.derived.timeToFirstAudioMs).toBe(300);
    expect(m.derived.audioDurationMs).toBeCloseTo(pcm16DurationMs(total), 0);

    expect(rec.usage).toEqual([
      {
        turnId: 1,
        legs: [
          {
            leg: 'realtime',
            providerId: 'mock-realtime',
            modelId: 'mock-s2s',
            unit: 'audio_seconds',
            inputUnits: 1.5,
            outputUnits: Number((total / BYTES_PER_SECOND).toFixed(3)),
            source: 'local',
          },
        ],
      },
    ]);
  });

  it('blank text is ignored', async () => {
    const { s, rec } = session();
    s.sendText('   ');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.log).toEqual([]);
  });

  it('server_vad: speech then >600 ms silence commits a turn on its own', async () => {
    const { s, rec } = session();
    s.pushAudio(loud(0.4));
    frames((b) => s.pushAudio(b), 600, quiet);
    expect(rec.turnStarts).toEqual([]);
    s.pushAudio(quiet(0.04));
    expect(rec.of('user')).toEqual([{ type: 'user', text: '(mock heard you speak)', final: true, turnId: 1 }]);
    expect(rec.turnStarts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage[0].legs[0].inputUnits).toBeCloseTo(1.04, 3);
  });

  it('manual: silence never commits; commitAudio does, and only after speech', async () => {
    const { s, rec } = session({ turnDetection: 'manual' });
    s.commitAudio(); // nothing heard yet
    expect(rec.log).toEqual([]);
    s.pushAudio(loud(0.4));
    frames((b) => s.pushAudio(b), 3000, quiet);
    expect(rec.turnStarts).toEqual([]);
    s.commitAudio();
    expect(rec.turnStarts).toEqual([1]);
    s.commitAudio(); // a second commit with no new speech is a no-op
    expect(rec.turnStarts).toEqual([1]);
  });

  it('turn ids increase per turn and starts/ends stay balanced', async () => {
    const { s, rec } = session();
    for (const t of ['a', 'b', 'c']) {
      s.sendText(t);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(rec.turnStarts).toEqual([1, 2, 3]);
    expect(rec.turnEnds).toEqual([1, 2, 3]);
    expect(rec.usage.map((u) => u.turnId)).toEqual([1, 2, 3]);
  });

  it('barge-in (loud audio while speaking): audio stops at once, turn ends, billed once with what was spoken', async () => {
    const { s, rec } = session();
    s.sendText('hello');
    await vi.advanceTimersByTimeAsync(300 + 40 * 4);
    const spoken = rec.audio.reduce((n, b) => n + b.length, 0);
    expect(spoken).toBe(1920 * 5);
    s.pushAudio(loud(0.1));
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0].outputUnits).toBe(Number((spoken / BYTES_PER_SECOND).toFixed(3)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rec.audio.reduce((n, b) => n + b.length, 0)).toBe(spoken);
    expect(rec.metrics).toEqual([]); // cut off: no completed-turn metrics
    expect(rec.usage).toHaveLength(1);
  });

  // CLAUDE.md: "both session kinds raise [onInterrupt] when audio already
  // emitted is cut off", and the mocks are the reference implementations, so
  // the recorder can drop the never-heard tail of a barged-in mock reply.
  it('barge-in after audio was emitted raises onInterrupt', async () => {
    const { s, rec } = session();
    s.sendText('hello');
    await vi.advanceTimersByTimeAsync(300 + 40 * 4);
    expect(rec.audio.length).toBeGreaterThan(0);
    s.pushAudio(loud(0.1));
    expect(rec.interrupts).toBe(1);
  });

  it('explicit interrupt() mid-reply ends and bills the turn; a second interrupt is a no-op', async () => {
    const { s, rec } = session();
    s.sendText('hello');
    await vi.advanceTimersByTimeAsync(400);
    s.interrupt();
    s.interrupt();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
  });

  it('interrupt() while idle emits nothing', async () => {
    const { s, rec } = session();
    s.interrupt();
    expect(rec.log).toEqual([]);
  });

  it('interrupt() before the first frame still ends the turn and bills zero output', async () => {
    const { s, rec } = session();
    s.sendText('hello');
    await vi.advanceTimersByTimeAsync(100);
    s.interrupt();
    expect(rec.audio).toEqual([]);
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage[0].legs[0].outputUnits).toBe(0);
  });

  it('close() mid-reply bills the turn once; everything after close is ignored', async () => {
    const { s, rec } = session();
    s.pushAudio(loud(1));
    s.sendText('hello');
    await vi.advanceTimersByTimeAsync(400);
    await s.close();
    await s.close();
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0].inputUnits).toBe(1);
    expect(rec.turnStarts).toEqual(rec.turnEnds);
    const n = rec.log.length;
    s.pushAudio(loud(1));
    frames((b) => s.pushAudio(b), 1000, quiet);
    s.sendText('again');
    s.commitAudio();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rec.log).toHaveLength(n);
  });

  it('input audio is attributed to the turn it precedes, not carried over', async () => {
    const { s, rec } = session({ turnDetection: 'manual' });
    s.pushAudio(loud(2));
    s.sendText('one');
    await vi.advanceTimersByTimeAsync(20_000);
    s.pushAudio(quiet(0.5));
    s.sendText('two');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.usage.map((u) => u.legs[0].inputUnits)).toEqual([2, 0.5]);
  });

  it('uses the configured model id on its usage row', async () => {
    const { s, rec } = session({ realtimeModelId: 'some-model' });
    s.sendText('x');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.usage[0].legs[0].modelId).toBe('some-model');
  });

  it('never reports an error', async () => {
    const { s, rec } = session();
    s.sendText('x');
    await tick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.errors).toEqual([]);
  });
});
