import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SarvamSttProvider } from '../../../src/providers/stt/SarvamSttProvider.js';
import type { SttOptions } from '../../../src/providers/types.js';
import { startFakeWs, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, sttRecorder } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * SarvamSttProvider hardcodes `wss://api.sarvam.ai/...` and has no credential
 * override, so these tests reach it through the `ws` module mock, which
 * redirects the dial to a local fake and keeps the vendor host as the first
 * path segment.
 */

let fake: FakeWsServer;
const provider = new SarvamSttProvider();

const opts = (o: Partial<SttOptions> = {}): SttOptions => ({
  model: 'saaras:v3-realtime@fast',
  language: 'hi-IN',
  sampleRate: 24000,
  credentials: { SARVAM_API_KEY: FAKE_KEY },
  vad: true,
  ...o,
});

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('SarvamSttProvider: request', () => {
  it('refuses to open without a key, and names the variable rather than any value', async () => {
    await expect(provider.open(opts({ credentials: {} }), sttRecorder().events)).rejects.toThrow(
      'SARVAM_API_KEY is not set',
    );
    expect(dials()).toHaveLength(0);
  });

  it('dials the Sarvam realtime host with model, stream_type, language, encoding and 16 kHz', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith('wss://api.sarvam.ai/speech-to-text-realtime/ws?')).toBe(true);
    expect(conn.path).toBe('/api.sarvam.ai/speech-to-text-realtime/ws');
    expect(Object.fromEntries(conn.query)).toEqual({
      model: 'saaras:v3-realtime',
      language_code: 'hi-IN',
      mode: 'transcribe',
      stream_type: 'fast',
      endpointing: 'vad',
      encoding: 'linear16',
      sample_rate: '16000',
    });
    stream.close();
  });

  it('sends the key as the API-SUBSCRIPTION-KEY header and never in the URL', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.headers['api-subscription-key']).toBe(FAKE_KEY);
    expect(dials()[0].url).not.toContain(FAKE_KEY);
    expect(conn.url.href).not.toContain(FAKE_KEY);
    stream.close();
  });

  it.each([
    ['saaras:v3-realtime@accurate', 'saaras:v3-realtime', 'accurate'],
    ['saaras:v3-realtime', 'saaras:v3-realtime', 'fast'],
    ['saaras:v3-realtime@', 'saaras:v3-realtime', 'fast'],
    ['@accurate', 'saaras:v3-realtime', 'accurate'],
    ['', 'saaras:v3-realtime', 'fast'],
    ['a@b@slow', 'a@b', 'slow'],
  ])('model id %j splits into model=%s stream_type=%s', async (model, wire, streamType) => {
    const stream = await provider.open(opts({ model }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.query.get('model')).toBe(wire);
    expect(conn.query.get('stream_type')).toBe(streamType);
    stream.close();
  });

  it('defaults the language to en-IN and asks for manual endpointing when vad is off', async () => {
    const stream = await provider.open(opts({ language: undefined, vad: false }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.query.get('language_code')).toBe('en-IN');
    expect(conn.query.get('endpointing')).toBe('manual');
    stream.close();
  });
});

describe('SarvamSttProvider: audio up', () => {
  it('queues audio pushed during the handshake and flushes it in order on open', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    // Synchronously, before the socket can possibly be open.
    stream.pushAudio(constPcm(480, 100));
    stream.pushAudio(constPcm(480, 200));
    stream.pushAudio(constPcm(480, 300));
    const conn = await fake.nextConnection();
    await conn.waitForFrames(3);
    const values = conn.json.map((m) => {
      expect(m.event).toBe('audio_input');
      return Buffer.from(m.audio, 'base64').readInt16LE(0);
    });
    expect(values).toEqual([100, 200, 300]);
    stream.close();
  });

  it('downsamples 24 kHz to the 16 kHz it declares, as base64 PCM16', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(480, 1234)); // 20 ms @ 24 kHz
    const m = await conn.waitForJson((j) => j.event === 'audio_input', 'audio');
    const pcm = Buffer.from(m.audio, 'base64');
    expect(pcm.length).toBe(320 * 2); // 20 ms @ 16 kHz
    for (let i = 0; i < 320; i++) expect(pcm.readInt16LE(i * 2)).toBe(1234);
    stream.close();
  });

  it('resamples against opts.sampleRate, not the canonical constant: 16 kHz input goes up untouched', async () => {
    const stream = await provider.open(opts({ sampleRate: 16000 }), sttRecorder().events);
    const conn = await fake.nextConnection();
    const input = rampPcm(320);
    stream.pushAudio(input);
    const m = await conn.waitForJson((j) => j.event === 'audio_input', 'audio');
    expect(Buffer.from(m.audio, 'base64').equals(input)).toBe(true);
    stream.close();
  });

  it('upsamples 8 kHz input to 16 kHz', async () => {
    const stream = await provider.open(opts({ sampleRate: 8000 }), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(160, -500));
    const m = await conn.waitForJson((j) => j.event === 'audio_input', 'audio');
    expect(Buffer.from(m.audio, 'base64').length).toBe(320 * 2);
    stream.close();
  });

  it('drops empty chunks rather than sending an empty audio_input', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(Buffer.alloc(0));
    stream.pushAudio(constPcm(48, 7));
    await conn.waitForFrames(1);
    await conn.sync();
    expect(conn.frames).toHaveLength(1);
    expect(Buffer.from(conn.json[0].audio, 'base64').readInt16LE(0)).toBe(7);
    stream.close();
  });

  it('finalize() sends speech_end then flush once the socket is open', async () => {
    const stream = await provider.open(opts({ vad: false }), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(48, 1));
    await conn.waitForFrames(1);
    stream.finalize();
    await conn.waitForFrames(3);
    expect(conn.json.map((m) => m.event)).toEqual(['audio_input', 'speech_end', 'flush']);
    stream.close();
  });
});

describe('SarvamSttProvider: events down', () => {
  it('forwards partials, finals and vad.speech_end, ignoring session/vad-start chatter', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ event: 'session.begin', request_id: 'r1' });
    conn.send({ event: 'vad.speech_start', utterance_idx: 0 });
    conn.send({ event: 'transcript.partial', text: 'namaste' });
    conn.send({ event: 'transcript.partial', text: '' }); // empty partial: not forwarded
    conn.send({ event: 'vad.speech_end', utterance_idx: 0 });
    conn.send({ event: 'transcript.final', text: 'namaste duniya', language: 'hi-IN' });
    conn.send('not json at all');
    conn.send({ event: 'something.new' });
    await rec.waitFinal();
    expect(rec.partials).toEqual(['namaste']);
    expect(rec.finals).toEqual(['namaste duniya']);
    expect(rec.speechEnds).toBe(1);
    expect(rec.order).toEqual(['partial', 'speechEnd', 'final']);
    expect(rec.errors).toEqual([]);
    stream.close();
  });

  it('passes an empty final through as "" (non-speech), and a text-less final as ""', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ event: 'transcript.final', text: '' });
    conn.send({ event: 'transcript.final' });
    await rec.waitFinal(2);
    expect(rec.finals).toEqual(['', '']);
    stream.close();
  });

  it('surfaces a non-fatal error frame and keeps the session open', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ event: 'error', code: 'rate_limited', message: 'slow down', is_fatal: false });
    await rec.waitError();
    expect(rec.errors).toEqual(['Sarvam STT rate_limited: slow down']);
    stream.pushAudio(constPcm(48, 9));
    await conn.waitForJson((m) => m.event === 'audio_input', 'audio after error');
    conn.send({ event: 'transcript.final', text: 'still alive' });
    await rec.waitFinal();
    stream.close();
  });

  it('a fatal error closes the socket and is reported exactly once', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ event: 'error', message: 'bad config', is_fatal: true });
    await rec.waitError();
    await conn.closed;
    await dialClosed();
    expect(rec.errors).toEqual(['Sarvam STT error: bad config']);
    // Nothing more goes up after a fatal error.
    stream.pushAudio(constPcm(48, 1));
    stream.finalize();
    stream.close();
    expect(conn.frames).toHaveLength(0);
  });

  it.each([
    [1003, 'quota', 'Sarvam STT closed (1003: quota)'],
    [1008, 'inactivity', 'Sarvam STT closed (1008: inactivity)'],
    [1011, '', 'Sarvam STT closed (1011)'],
    [4000, 'rejected', 'Sarvam STT closed (4000: rejected)'],
  ])('an abnormal server close %i is surfaced as an error', async (code, reason, message) => {
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.socket.close(code, reason);
    await rec.waitError();
    expect(rec.errors).toEqual([message]);
  });

  it('a normal 1000 close from the server is not an error', async () => {
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ event: 'session.end' });
    conn.socket.close(1000);
    await dialClosed();
    expect(rec.errors).toEqual([]);
  });

  it('a socket that dies without a close frame (1006) is surfaced', async () => {
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.socket.terminate();
    await rec.waitError();
    expect(rec.errors).toEqual(['Sarvam STT closed (1006)']);
  });
});

describe('SarvamSttProvider: teardown', () => {
  it('close() is idempotent and stops all further events and sends', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(48, 1));
    await conn.waitForFrames(1);
    stream.close();
    stream.close();
    stream.pushAudio(constPcm(48, 2));
    stream.finalize();
    await conn.closed;
    await dialClosed();
    expect(conn.binaries).toHaveLength(0);
    expect(conn.json.filter((m) => m.event === 'audio_input')).toHaveLength(1);
    expect(rec.errors).toEqual([]);
  });

  // BUG: close() sets `closed = true` and THEN calls `send({event:'end'})`,
  // whose first line is `if (closed || ...) return` — so the documented
  // graceful `end` message never reaches the wire (SarvamSttProvider.ts:153-157).
  it.fails('close() tells Sarvam {event:"end"} before closing the socket', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(48, 1));
    await conn.waitForFrames(1);
    stream.close();
    await conn.closed;
    expect(conn.json.map((m) => m.event)).toContain('end');
  });

  it('close() during the handshake aborts quietly and drops queued audio', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushAudio(constPcm(48, 1));
    stream.close();
    await dialClosed();
    expect(rec.errors).toEqual([]);
    for (const c of fake.connections) expect(c.frames).toHaveLength(0);
  });

  it('finalize() before the handshake sends nothing (it is dropped, not queued)', async () => {
    const stream = await provider.open(opts({ vad: false }), sttRecorder().events);
    stream.finalize();
    stream.pushAudio(constPcm(48, 5));
    const conn = await fake.nextConnection();
    await conn.waitForFrames(1);
    await conn.sync();
    expect(conn.json.map((m) => m.event)).toEqual(['audio_input']);
    stream.close();
  });
});

describe('SarvamSttProvider: secrets', () => {
  it('a rejected handshake does not put the key in any error', async () => {
    fake.rejectWith = { status: 403, message: 'Forbidden' };
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitError(2);
    expect(rec.errors.some((m) => m.includes('403'))).toBe(true);
    expect(leaksKey(rec.errors)).toBe(false);
  });

  it('an unreachable host does not put the key in any error', async () => {
    await fake.close();
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitError();
    expect(leaksKey(rec.errors)).toBe(false);
    fake = await startFakeWs(); // for afterEach
  });
});
