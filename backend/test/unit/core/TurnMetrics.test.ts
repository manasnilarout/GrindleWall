import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnMetrics } from '../../../src/metrics/TurnMetrics.js';
import type { MetricName } from '../../../src/shared/protocol.js';

/**
 * TurnMetrics reads `process.hrtime.bigint()`. It is replaced with a clock the
 * test drives, so every number below is exact rather than "about right".
 */
let ns = 0n;
const advance = (ms: number) => {
  ns += BigInt(Math.round(ms * 1e6));
};

beforeEach(() => {
  ns = 1_000_000_000_000n; // an arbitrary non-zero monotonic origin
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => ns);
});

const at = (m: TurnMetrics, name: MetricName) => m.snapshot().marks.find((x) => x.name === name)?.atMs;

describe('TurnMetrics', () => {
  it('keeps its turn id', () => {
    expect(new TurnMetrics(7).turnId).toBe(7);
    expect(new TurnMetrics(0).turnId).toBe(0);
  });

  it('measures elapsed time from construction, not from the clock origin', () => {
    const m = new TurnMetrics(1);
    expect(m.elapsedMs()).toBe(0);
    advance(12.5);
    expect(m.elapsedMs()).toBe(12.5);
  });

  it('records a mark at its offset from construction', () => {
    const m = new TurnMetrics(1);
    advance(40);
    m.mark('user_speech_end');
    expect(at(m, 'user_speech_end')).toBe(40);
  });

  it('first occurrence of a mark wins', () => {
    const m = new TurnMetrics(1);
    advance(10);
    m.mark('tts_first_audio');
    advance(90);
    m.mark('tts_first_audio');
    m.mark('tts_first_audio');
    const marks = m.snapshot().marks.filter((x) => x.name === 'tts_first_audio');
    expect(marks).toEqual([{ name: 'tts_first_audio', atMs: 10 }]);
  });

  it('keeps marks in the order they were first recorded', () => {
    const m = new TurnMetrics(1);
    const order: MetricName[] = ['llm_request_sent', 'user_speech_end', 'stt_final', 'llm_first_token'];
    for (const name of order) {
      advance(5);
      m.mark(name);
    }
    m.mark('user_speech_end'); // a repeat does not move it
    expect(m.snapshot().marks.map((x) => x.name)).toEqual(order);
  });

  it('starts with no marks', () => {
    expect(new TurnMetrics(1).snapshot().marks).toEqual([]);
  });

  describe('derived numbers', () => {
    it('TTFA is first_audio_out minus user_speech_end — pre-t0 dead air excluded', () => {
      const m = new TurnMetrics(1);
      advance(120); // a realtime clock starts at the socket, long before t0
      m.mark('user_speech_end');
      advance(80);
      m.mark('first_audio_out');
      expect(m.snapshot().derived.timeToFirstAudioMs).toBe(80);
    });

    it('TTFA counts from construction when no speech end was marked', () => {
      const m = new TurnMetrics(1);
      advance(55);
      m.mark('first_audio_out');
      expect(m.snapshot().derived.timeToFirstAudioMs).toBe(55);
    });

    it('TTFA is undefined until first audio goes out', () => {
      const m = new TurnMetrics(1);
      m.mark('user_speech_end');
      m.mark('tts_first_audio');
      expect(m.snapshot().derived.timeToFirstAudioMs).toBeUndefined();
    });

    it('TTFA uses the FIRST first_audio_out, not a later repeat', () => {
      const m = new TurnMetrics(1);
      m.mark('user_speech_end');
      advance(300);
      m.mark('first_audio_out');
      advance(500);
      m.mark('first_audio_out');
      expect(m.snapshot().derived.timeToFirstAudioMs).toBe(300);
    });

    it('each leg latency is the gap between its own pair of marks', () => {
      const m = new TurnMetrics(1);
      advance(10);
      m.mark('user_speech_end'); // 10
      advance(150);
      m.mark('stt_final'); // 160
      advance(5);
      m.mark('llm_request_sent'); // 165
      advance(220);
      m.mark('llm_first_token'); // 385
      advance(1);
      m.mark('tts_request_sent'); // 386
      advance(180);
      m.mark('tts_first_audio'); // 566
      advance(2);
      m.mark('first_audio_out'); // 568
      advance(400);
      m.mark('llm_last_token');
      m.mark('last_audio_out');
      advance(32);
      const { derived } = m.snapshot(); // at 1000
      expect(derived).toEqual({
        timeToFirstAudioMs: 558,
        sttLatencyMs: 150,
        llmTtftMs: 220,
        ttsTtfbMs: 180,
        totalTurnMs: 990,
        audioDurationMs: undefined,
      });
    });

    it('a leg latency is undefined when either end of the pair is missing', () => {
      const m = new TurnMetrics(1);
      m.mark('stt_final'); // no user_speech_end
      m.mark('llm_request_sent'); // no llm_first_token
      m.mark('tts_first_audio'); // no tts_request_sent
      const { derived } = m.snapshot();
      expect(derived.sttLatencyMs).toBeUndefined();
      expect(derived.llmTtftMs).toBeUndefined();
      expect(derived.ttsTtfbMs).toBeUndefined();
    });

    it('a leg latency of zero is reported as 0, not as missing', () => {
      const m = new TurnMetrics(1);
      m.mark('tts_request_sent');
      m.mark('tts_first_audio');
      expect(m.snapshot().derived.ttsTtfbMs).toBe(0);
    });

    it('totalTurnMs is measured at snapshot time, from the speech end', () => {
      const m = new TurnMetrics(1);
      advance(100);
      m.mark('user_speech_end');
      advance(250);
      expect(m.snapshot().derived.totalTurnMs).toBe(250);
      advance(250);
      expect(m.snapshot().derived.totalTurnMs).toBe(500);
    });

    it('totalTurnMs counts from construction when no speech end was marked', () => {
      const m = new TurnMetrics(1);
      advance(42);
      expect(m.snapshot().derived.totalTurnMs).toBe(42);
    });
  });

  describe('audio duration', () => {
    it('is undefined when no audio was counted', () => {
      expect(new TurnMetrics(1).snapshot().derived.audioDurationMs).toBeUndefined();
    });

    it('is undefined after counting zero bytes', () => {
      const m = new TurnMetrics(1);
      m.countAudio(0);
      expect(m.snapshot().derived.audioDurationMs).toBeUndefined();
    });

    it('converts canonical PCM16 @ 24 kHz bytes to ms', () => {
      const m = new TurnMetrics(1);
      m.countAudio(48_000);
      expect(m.snapshot().derived.audioDurationMs).toBe(1000);
    });

    it('accumulates across chunks', () => {
      const m = new TurnMetrics(1);
      for (let i = 0; i < 50; i++) m.countAudio(960); // 50 x 20 ms
      expect(m.snapshot().derived.audioDurationMs).toBe(1000);
    });

    it('rounds to 0.1 ms', () => {
      const m = new TurnMetrics(1);
      m.countAudio(1000); // 20.8333 ms
      expect(m.snapshot().derived.audioDurationMs).toBe(20.8);
    });
  });

  describe('rounding and snapshot isolation', () => {
    it('rounds mark offsets and derived numbers to 0.1 ms', () => {
      const m = new TurnMetrics(1);
      advance(10.04);
      m.mark('user_speech_end');
      advance(5.27);
      m.mark('first_audio_out');
      const { marks, derived } = m.snapshot();
      expect(marks).toEqual([
        { name: 'user_speech_end', atMs: 10 },
        { name: 'first_audio_out', atMs: 15.3 },
      ]);
      expect(derived.timeToFirstAudioMs).toBe(5.3);
    });

    it('derives from the unrounded marks, not from the rounded ones', () => {
      const m = new TurnMetrics(1);
      advance(10.04); // rounds to 10.0
      m.mark('tts_request_sent');
      advance(0.12); // 10.16 rounds to 10.2; rounded marks would say 0.2
      m.mark('tts_first_audio');
      const { marks, derived } = m.snapshot();
      expect(marks.map((x) => x.atMs)).toEqual([10, 10.2]);
      expect(derived.ttsTtfbMs).toBe(0.1); // the true 0.12 gap, rounded once
    });

    it('sub-0.05 ms gaps round to zero', () => {
      const m = new TurnMetrics(1);
      m.mark('llm_request_sent');
      advance(0.04);
      m.mark('llm_first_token');
      expect(m.snapshot().derived.llmTtftMs).toBe(0);
    });

    it('a snapshot is a copy: editing it cannot rewrite the turn', () => {
      const m = new TurnMetrics(1);
      advance(10);
      m.mark('user_speech_end');
      const snap = m.snapshot();
      snap.marks[0]!.atMs = 9999;
      snap.marks.push({ name: 'first_audio_out', atMs: 1 });
      expect(m.snapshot().marks).toEqual([{ name: 'user_speech_end', atMs: 10 }]);
    });

    it('snapshot() does not consume or reset anything', () => {
      const m = new TurnMetrics(1);
      m.mark('user_speech_end');
      m.countAudio(48_000);
      m.snapshot();
      m.mark('user_speech_end');
      const s = m.snapshot();
      expect(s.marks).toHaveLength(1);
      expect(s.derived.audioDurationMs).toBe(1000);
    });
  });

  it('instances are independent', () => {
    const a = new TurnMetrics(1);
    advance(100);
    const b = new TurnMetrics(2);
    advance(50);
    a.mark('user_speech_end');
    b.mark('user_speech_end');
    a.countAudio(48_000);
    expect(at(a, 'user_speech_end')).toBe(150);
    expect(at(b, 'user_speech_end')).toBe(50);
    expect(b.snapshot().derived.audioDurationMs).toBeUndefined();
  });

  it('works on the real monotonic clock too (no mock)', () => {
    vi.restoreAllMocks();
    const m = new TurnMetrics(1);
    m.mark('user_speech_end');
    m.mark('first_audio_out');
    const { derived } = m.snapshot();
    expect(derived.timeToFirstAudioMs).toBeGreaterThanOrEqual(0);
    expect(derived.totalTurnMs).toBeGreaterThanOrEqual(0);
  });
});
