import { describe, expect, it } from 'vitest';
import { MARK_NOTE, SOURCE_COLOR, sourceOfMark, sourceOfMessage } from '../../src/lib/logsource';
import type { LogSource } from '../../src/lib/logsource';
import type { MetricName, StartConfig } from '../../src/lib/protocol';

const ALL_MARKS: MetricName[] = [
  'user_speech_end',
  'stt_first_partial',
  'stt_final',
  'llm_request_sent',
  'llm_first_token',
  'llm_last_token',
  'tts_request_sent',
  'tts_first_audio',
  'first_audio_out',
  'last_audio_out',
];

const pipeline = (over: Partial<StartConfig> = {}): StartConfig => ({
  mode: 'pipeline',
  realtimeProviderId: 'openai-realtime',
  sttProviderId: 'sarvam-stt',
  llmProviderId: 'google-llm',
  ttsProviderId: 'cartesia-tts',
  systemPrompt: '',
  turnDetection: 'server_vad',
  ...over,
});

describe('SOURCE_COLOR', () => {
  it('has a colour for every source', () => {
    const sources: LogSource[] = ['session', 'stt', 'llm', 'tts', 'realtime', 'mic', 'client'];
    for (const s of sources) expect(SOURCE_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(SOURCE_COLOR).sort()).toEqual([...sources].sort());
  });

  it('shares the leg hexes with legs.ts', () => {
    expect(SOURCE_COLOR.stt).toBe('#3987e5');
    expect(SOURCE_COLOR.llm).toBe('#d95926');
    expect(SOURCE_COLOR.tts).toBe('#199e70');
  });
});

describe('sourceOfMessage without a config (keyword heuristics)', () => {
  it('files a non-string message under session instead of throwing', () => {
    expect(sourceOfMessage(undefined as unknown as string)).toBe('session');
    expect(sourceOfMessage(42 as unknown as string)).toBe('session');
    expect(sourceOfMessage({ message: 'stt' } as unknown as string)).toBe('session');
  });

  it.each([
    ['Mic opened', 'mic'],
    ['microphone permission denied', 'mic'],
    ['mic: level 0.4', 'mic'],
    ['WebSocket closed 1006', 'client'],
    ['audio output device changed', 'client'],
    ['STT partial arrived', 'stt'],
    ['final transcript settled', 'stt'],
    ['vad speech_end at 120ms', 'stt'],
    ['LLM request sent', 'llm'],
    ['first token back', 'llm'],
    ['TTS opened', 'tts'],
    ['synthesising reply', 'tts'],
    ['voice changed', 'tts'],
    ['turn 3 started', 'session'],
    ['', 'session'],
  ])('%j -> %s', (msg, want) => {
    expect(sourceOfMessage(msg)).toBe(want);
  });

  it('anchors "mic" at word boundaries', () => {
    for (const msg of ['dynamic range ok', 'atomic commit', 'seismic event']) {
      expect(sourceOfMessage(msg)).toBe('session');
    }
  });

  it('anchors "token" and "voice" at word boundaries', () => {
    expect(sourceOfMessage('tokens used: 40')).toBe('session');
    expect(sourceOfMessage('invoice issued')).toBe('session');
  });

  it('prefers mic over client over stt over llm over tts', () => {
    expect(sourceOfMessage('mic websocket stt llm tts')).toBe('mic');
    expect(sourceOfMessage('websocket stt llm tts')).toBe('client');
    expect(sourceOfMessage('stt llm tts')).toBe('stt');
    expect(sourceOfMessage('llm tts')).toBe('llm');
  });
});

describe('sourceOfMessage with a config (vendor attribution)', () => {
  it('attributes a pipeline line by its vendor token, case-insensitively', () => {
    const cfg = pipeline();
    expect(sourceOfMessage('Sarvam: vad started', cfg)).toBe('stt');
    expect(sourceOfMessage('google 429 retry', cfg)).toBe('llm');
    expect(sourceOfMessage('CARTESIA context flushed', cfg)).toBe('tts');
  });

  it('puts the vendor ahead of the browser heuristic (Murf gen2 closes 1008)', () => {
    const cfg = pipeline({ ttsProviderId: 'murf-tts' });
    expect(sourceOfMessage('murf websocket closed 1008', cfg)).toBe('tts');
  });

  it('ignores slots the mode does not use', () => {
    // The realtime id is set on a pipeline config but was never opened.
    expect(sourceOfMessage('openai session.created', pipeline())).toBe('session');
    const realtime = pipeline({ mode: 'realtime' });
    expect(sourceOfMessage('openai session.created', realtime)).toBe('realtime');
    expect(sourceOfMessage('sarvam transcript', realtime)).toBe('stt'); // falls through to the keyword rule
    expect(sourceOfMessage('cartesia flushed', realtime)).toBe('session');
  });

  it('reports ambiguity as session when two slots share one vendor', () => {
    const allMock = pipeline({ sttProviderId: 'mock-stt', llmProviderId: 'mock-llm', ttsProviderId: 'mock-tts' });
    expect(sourceOfMessage('mock stt partial', allMock)).toBe('session');
    // Ambiguity is final: it does not fall through to the keyword heuristics.
    expect(sourceOfMessage('mock mic opened', allMock)).toBe('session');
  });

  it('prefers the longer vendor token when different vendors match', () => {
    const cfg = pipeline({ sttProviderId: 'sarvam-stt', llmProviderId: 'openai-llm', ttsProviderId: 'elevenlabs-tts' });
    expect(sourceOfMessage('elevenlabs fell back after openai timeout', cfg)).toBe('tts');
  });

  it('ignores vendor tokens shorter than three characters', () => {
    const cfg = pipeline({ ttsProviderId: 'ai-tts' });
    expect(sourceOfMessage('ai said hello', cfg)).toBe('session');
  });

  it('strips the -agents suffix as well as the leg suffixes', () => {
    const cfg = pipeline({ mode: 'realtime', realtimeProviderId: 'elevenlabs-agents' });
    expect(sourceOfMessage('elevenlabs agent connected', cfg)).toBe('realtime');
  });

  it('falls back to the keyword rules when no vendor matches', () => {
    const cfg = pipeline();
    expect(sourceOfMessage('microphone stopped', cfg)).toBe('mic');
    expect(sourceOfMessage('transcript empty', cfg)).toBe('stt');
  });

  it('tolerates a config with missing provider ids', () => {
    const cfg = { mode: 'pipeline', systemPrompt: '', turnDetection: 'manual' } as StartConfig;
    expect(sourceOfMessage('tts opened', cfg)).toBe('tts');
    expect(sourceOfMessage('anything', { ...cfg, mode: 'realtime' })).toBe('session');
  });
});

describe('sourceOfMark', () => {
  it.each(ALL_MARKS.map((name) => [name]))('%s', (name) => {
    const want = name.startsWith('stt_') ? 'stt' : name.startsWith('llm_') ? 'llm' : name.startsWith('tts_') ? 'tts' : 'session';
    expect(sourceOfMark(name)).toBe(want);
  });

  it('files the turn-level marks under session', () => {
    expect(sourceOfMark('user_speech_end')).toBe('session');
    expect(sourceOfMark('first_audio_out')).toBe('session');
    expect(sourceOfMark('last_audio_out')).toBe('session');
  });
});

describe('MARK_NOTE', () => {
  it('annotates every metric mark, and nothing else', () => {
    expect(Object.keys(MARK_NOTE).sort()).toEqual([...ALL_MARKS].sort());
    for (const name of ALL_MARKS) expect(MARK_NOTE[name].length).toBeGreaterThan(0);
  });

  it('flags t0 and the pre-open TTS mark', () => {
    expect(MARK_NOTE.user_speech_end).toMatch(/^t0/);
    expect(MARK_NOTE.tts_request_sent).toMatch(/before open\(\)/);
  });
});
