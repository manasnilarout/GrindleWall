import { describe, expect, it } from 'vitest';
import { LEG_BANDS, bandsOf, legMediansOf, slowestLeg } from '../../src/lib/legs';
import type { MetricMark } from '../../src/lib/protocol';

describe('LEG_BANDS', () => {
  it('is the fixed STT, LLM, TTS order with its validated hexes', () => {
    expect(LEG_BANDS.map((b) => b.key)).toEqual(['stt', 'llm', 'tts']);
    expect(LEG_BANDS.map((b) => b.color)).toEqual(['#3987e5', '#d95926', '#199e70']);
    expect(LEG_BANDS.map((b) => b.name)).toEqual(['STT', 'LLM TTFT', 'TTS TTFB']);
  });

  it('has no network band', () => {
    expect(LEG_BANDS.some((b) => (b.key as string) === 'network')).toBe(false);
  });
});

describe('bandsOf', () => {
  // The smoke turn quoted in legs.ts: legs overlap, so they do not sum to TTFA.
  const marks: MetricMark[] = [
    { name: 'user_speech_end', atMs: 0 },
    { name: 'tts_request_sent', atMs: 5 },
    { name: 'llm_request_sent', atMs: 80 },
    { name: 'llm_first_token', atMs: 180 },
  ];

  it('positions every leg at its own start, sorted by start', () => {
    const bands = bandsOf({ sttLatencyMs: 80, llmTtftMs: 100, ttsTtfbMs: 280 }, marks);
    expect(bands.map((b) => [b.key, b.startMs, b.ms])).toEqual([
      ['stt', 0, 80],
      ['tts', 5, 280],
      ['llm', 80, 100],
    ]);
    expect(bands[0]).toMatchObject({ name: 'STT', color: '#3987e5' });
  });

  it('measures starts relative to t0 when t0 is not zero', () => {
    const shifted: MetricMark[] = [
      { name: 'user_speech_end', atMs: 1000 },
      { name: 'llm_request_sent', atMs: 1250 },
      { name: 'tts_request_sent', atMs: 1300 },
    ];
    const bands = bandsOf({ sttLatencyMs: 250, llmTtftMs: 90, ttsTtfbMs: 120 }, shifted);
    expect(bands.map((b) => [b.key, b.startMs])).toEqual([
      ['stt', 0],
      ['llm', 250],
      ['tts', 300],
    ]);
  });

  it('clamps a mark that precedes t0 to zero', () => {
    const bands = bandsOf({ ttsTtfbMs: 50 }, [
      { name: 'user_speech_end', atMs: 100 },
      { name: 'tts_request_sent', atMs: 40 },
    ]);
    expect(bands).toEqual([expect.objectContaining({ key: 'tts', startMs: 0, ms: 50 })]);
  });

  it('defaults t0 to zero when no speech-end mark exists', () => {
    const bands = bandsOf({ sttLatencyMs: 10, llmTtftMs: 20 }, [{ name: 'llm_request_sent', atMs: 15 }]);
    expect(bands.map((b) => [b.key, b.startMs])).toEqual([
      ['stt', 0],
      ['llm', 15],
    ]);
  });

  it('omits a leg whose start mark is missing even when its duration is known', () => {
    expect(bandsOf({ llmTtftMs: 100, ttsTtfbMs: 200 }, [])).toEqual([]);
  });

  it('omits a leg whose duration is unmeasured', () => {
    expect(bandsOf({}, marks)).toEqual([]);
  });

  it('keeps an exact 0 ms duration but drops negative and non-finite ones', () => {
    const keep = bandsOf({ sttLatencyMs: 0 }, marks);
    expect(keep).toEqual([expect.objectContaining({ key: 'stt', ms: 0 })]);
    expect(bandsOf({ sttLatencyMs: -1, llmTtftMs: NaN, ttsTtfbMs: Infinity }, marks)).toEqual([]);
  });

  it('draws a realtime turn as its single TTS band', () => {
    const bands = bandsOf({ timeToFirstAudioMs: 441, ttsTtfbMs: 441 }, [{ name: 'tts_request_sent', atMs: 0 }]);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ key: 'tts', startMs: 0, ms: 441 });
  });

  it('works with the default (absent) marks argument', () => {
    expect(bandsOf({ sttLatencyMs: 12 })).toEqual([expect.objectContaining({ key: 'stt', startMs: 0, ms: 12 })]);
  });

  it('uses the first occurrence of a repeated mark', () => {
    const bands = bandsOf({ llmTtftMs: 1 }, [
      { name: 'llm_request_sent', atMs: 30 },
      { name: 'llm_request_sent', atMs: 90 },
    ]);
    expect(bands[0].startMs).toBe(30);
  });

  it('keeps insertion order (STT, LLM, TTS) when starts tie', () => {
    const tie: MetricMark[] = [
      { name: 'llm_request_sent', atMs: 0 },
      { name: 'tts_request_sent', atMs: 0 },
    ];
    expect(bandsOf({ sttLatencyMs: 1, llmTtftMs: 1, ttsTtfbMs: 1 }, tie).map((b) => b.key)).toEqual(['stt', 'llm', 'tts']);
  });

  it('returns fresh band objects that do not alias LEG_BANDS', () => {
    const [band] = bandsOf({ sttLatencyMs: 5 });
    band.color = '#000000';
    expect(LEG_BANDS[0].color).toBe('#3987e5');
  });
});

describe('legMediansOf', () => {
  it('lists the legs that have a median, in band order', () => {
    expect(legMediansOf({ ttsTtfbMedianMs: 300, sttMedianMs: 100, llmTtftMedianMs: 200 })).toEqual([
      { key: 'stt', name: 'STT', color: '#3987e5', ms: 100 },
      { key: 'llm', name: 'LLM TTFT', color: '#d95926', ms: 200 },
      { key: 'tts', name: 'TTS TTFB', color: '#199e70', ms: 300 },
    ]);
  });

  it('omits absent legs and keeps a zero median', () => {
    expect(legMediansOf({ ttsTtfbMedianMs: 0 })).toEqual([{ key: 'tts', name: 'TTS TTFB', color: '#199e70', ms: 0 }]);
  });

  it('is empty for a record that kept only TTFA', () => {
    expect(legMediansOf({ ttfaMedianMs: 900, ttfaP95Ms: 1200 })).toEqual([]);
    expect(legMediansOf({})).toEqual([]);
  });
});

describe('slowestLeg', () => {
  it('is undefined for no legs', () => {
    expect(slowestLeg([])).toBeUndefined();
  });

  it('returns the maximum', () => {
    const legs = [{ ms: 10 }, { ms: 30 }, { ms: 20 }];
    expect(slowestLeg(legs)).toBe(legs[1]);
  });

  it('keeps the first of tied maxima', () => {
    const legs = [{ ms: 30, id: 'a' }, { ms: 30, id: 'b' }];
    expect(slowestLeg(legs)?.id).toBe('a');
  });

  it('accepts any shape with ms', () => {
    const bands = bandsOf({ sttLatencyMs: 80, llmTtftMs: 300 }, [{ name: 'llm_request_sent', atMs: 80 }]);
    expect(slowestLeg(bands)?.key).toBe('llm');
  });
});
