import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SarvamTtsProvider, defaultSpeakerFor } from '../../../src/providers/tts/SarvamTtsProvider.js';
import { SARVAM_V4_FLASH_DEFAULT_VOICE } from '../../../src/providers/sarvam-catalog.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder, wav } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * SarvamTtsProvider hardcodes `wss://api.sarvam.ai/text-to-speech/ws` with no
 * credential override; the `ws` mock redirects it to a local fake.
 */

let fake: FakeWsServer;
const provider = new SarvamTtsProvider();

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'bulbul:v3',
  voice: 'anand',
  language: 'hi-IN',
  sampleRate: 24000,
  credentials: { SARVAM_API_KEY: FAKE_KEY },
  ...o,
});

const audio = (pcm: Buffer) => ({ type: 'audio', data: { audio: pcm.toString('base64'), content_type: 'audio/pcm' } });
const finalEvt = { type: 'event', data: { event_type: 'final' } };
const waitFlush = (conn: FakeConn) => conn.waitForJson((m) => m.type === 'flush', 'flush');

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('SarvamTtsProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'SARVAM_API_KEY is not set',
    );
  });

  it('dials /text-to-speech/ws with the model and completion events; key in the api-subscription-key header only', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url).toBe('wss://api.sarvam.ai/text-to-speech/ws?model=bulbul%3Av3&send_completion_event=true');
    expect(conn.path).toBe('/api.sarvam.ai/text-to-speech/ws');
    expect(conn.query.get('model')).toBe('bulbul:v3');
    expect(conn.query.get('send_completion_event')).toBe('true');
    expect(conn.headers['api-subscription-key']).toBe(FAKE_KEY);
    expect(dials()[0].url).not.toContain(FAKE_KEY);
    stream.close();
  });

  it('open() resolves while the socket is still connecting', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    expect(dials()[0].socket.readyState).toBe(0);
    stream.close();
  });

  it('config goes first: both language field spellings, speaker, model, 24 kHz linear16, min_buffer_size 50, max_chunk_length 200', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('namaste');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    expect(conn.json[0]).toEqual({
      type: 'config',
      data: {
        language_code: 'hi-IN',
        target_language_code: 'hi-IN',
        speaker: 'anand',
        model: 'bulbul:v3',
        speech_sample_rate: '24000',
        output_audio_codec: 'linear16',
        min_buffer_size: 50,
        max_chunk_length: 200,
      },
    });
    // v2-only knobs are deliberately absent.
    for (const k of ['pitch', 'loudness', 'enable_preprocessing']) expect(conn.json[0].data).not.toHaveProperty(k);
    stream.close();
  });

  it.each([
    ['bulbul:v3', 'shubh'],
    ['bulbul:v4-flash', SARVAM_V4_FLASH_DEFAULT_VOICE],
    ['bulbul:v2', 'anushka'],
    ['bulbul:v9-unknown', 'shubh'],
  ])('model %s with no voice uses its own default speaker %s', async (model, speaker) => {
    expect(defaultSpeakerFor(model)).toBe(speaker);
    const stream = await provider.open(opts({ model, voice: undefined }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await conn.waitForJson((m) => m.type === 'config', 'config');
    expect(cfg.data.speaker).toBe(speaker);
    expect(cfg.data.model).toBe(model);
    expect(conn.query.get('model')).toBe(model);
    stream.close();
  });

  it('defaults: model bulbul:v3 and language en-IN', async () => {
    const stream = await provider.open(opts({ model: '', language: undefined }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await conn.waitForJson((m) => m.type === 'config', 'config');
    expect(cfg.data.model).toBe('bulbul:v3');
    expect(cfg.data.language_code).toBe('en-IN');
    expect(cfg.data.target_language_code).toBe('en-IN');
    stream.close();
  });
});

describe('SarvamTtsProvider: text queueing', () => {
  it('queues text and the flush marker during the handshake; sends config, texts, flush in order', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('ek ');
    stream.pushText('do ');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitFlush(conn);
    expect(conn.json).toEqual([
      expect.objectContaining({ type: 'config' }),
      { type: 'text', data: { text: 'ek ' } },
      { type: 'text', data: { text: 'do ' } },
      { type: 'flush' },
    ]);
    stream.close();
  });

  it('after open, text goes out live; empty text and text after flush are dropped; flush is sent once', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.pushText('');
    stream.pushText('teen');
    stream.flush();
    stream.flush();
    stream.pushText('late');
    await waitFlush(conn);
    await conn.sync();
    expect(conn.json.map((m) => m.type)).toEqual(['config', 'text', 'flush']);
    stream.close();
  });
});

describe('SarvamTtsProvider: audio down', () => {
  it('emits each audio frame the moment it lands, then ends on the final event', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('hello');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    const first = rampPcm(240);
    conn.send(audio(first));
    await rec.waitAudio();
    expect(rec.audio[0].equals(first)).toBe(true);
    expect(rec.done).toBe(0);
    stream.flush();
    await waitFlush(conn);
    conn.send(audio(rampPcm(240, 3)));
    conn.send(finalEvt);
    await rec.waitDone();
    expect(rec.audio).toHaveLength(2);
    expect(rec.done).toBe(1);
    await conn.closed; // the utterance is over; the socket is not reused
  });

  it('strips a RIFF/WAVE header (including one with an extra LIST chunk) from an audio frame', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    const pcm = rampPcm(200);
    conn.send(audio(wav(pcm)));
    conn.send(audio(wav(pcm, 24000, true)));
    await rec.waitAudio(2);
    expect(rec.audio[0].equals(pcm)).toBe(true);
    expect(rec.audio[1].equals(pcm)).toBe(true);
    stream.close();
  });

  it('a header-only WAV frame emits nothing', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send(audio(wav(Buffer.alloc(0))));
    conn.send(audio(constPcm(4, 9)));
    await rec.waitAudio();
    expect(rec.audio).toHaveLength(1);
    expect(rec.audio[0].readInt16LE(0)).toBe(9);
    stream.close();
  });

  it('resamples 24 kHz vendor audio to opts.sampleRate', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ sampleRate: 16000 }), rec.events);
    const conn = await fake.nextConnection();
    conn.send(audio(constPcm(480, -77)));
    await rec.waitAudio();
    expect(rec.audio[0].length).toBe(640);
    expect(rec.audio[0].readInt16LE(0)).toBe(-77);
    stream.close();
  });

  it('ignores audio frames with no payload, non-final events and unknown types', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'audio', data: {} });
    conn.send({ type: 'event', data: { event_type: 'started' } });
    conn.send({ type: 'pong' });
    conn.send(audio(constPcm(4, 1)));
    await rec.waitAudio();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
    stream.close();
  });
});

describe('SarvamTtsProvider: failures', () => {
  it('an error frame surfaces with its code and ends the turn', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'error', data: { message: 'Invalid speaker', code: 422 } });
    await rec.waitDone();
    expect(rec.errors).toEqual(['Sarvam TTS error 422: Invalid speaker']);
    expect(rec.done).toBe(1);
  });

  it('an error frame with no code or message still ends the turn', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'error' });
    await rec.waitDone();
    expect(rec.errors).toEqual(['Sarvam TTS error: unknown']);
  });

  it('a non-JSON frame is reported but does not end the turn', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send('<html>502</html>');
    await rec.waitError();
    expect(rec.errors).toEqual(['Sarvam sent a non-JSON frame']);
    conn.send(audio(constPcm(4, 1)));
    await rec.waitAudio();
    expect(rec.done).toBe(0);
    stream.close();
  });

  it('a close before flush is an early close (code + reason) and ends the turn', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    conn.socket.close(1008, 'Policy Violation');
    await rec.waitDone();
    expect(rec.errors).toEqual(['Sarvam TTS closed early (1008: Policy Violation)']);
  });

  it('a close after flush with no final event still ends the turn, quietly', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.flush();
    const conn = await fake.nextConnection();
    await waitFlush(conn);
    conn.socket.close(1000);
    await rec.waitDone();
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(1);
  });

  it('handshake rejection and unreachable host: errors, done, and no key in any message', async () => {
    fake.rejectWith = { status: 403, message: 'Forbidden' };
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitDone();
    expect(rec.errors[0]).toContain('403');
    expect(leaksKey(rec.errors)).toBe(false);

    await fake.close();
    const rec2 = ttsRecorder();
    await provider.open(opts(), rec2.events);
    await rec2.waitDone();
    expect(rec2.errors.length).toBeGreaterThan(0);
    expect(leaksKey(rec2.errors)).toBe(false);
    fake = await startFakeWs();
  });
});

describe('SarvamTtsProvider: barge-in and teardown', () => {
  it('cancel() mid-stream stops further audio immediately and raises nothing', async () => {
    const rec = ttsRecorder();
    let stream!: Awaited<ReturnType<typeof provider.open>>;
    stream = await provider.open(opts(), {
      ...rec.events,
      onAudio: (c) => {
        rec.events.onAudio(c);
        stream.cancel();
      },
    });
    stream.pushText('long');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    conn.send(audio(constPcm(4, 1)));
    conn.send(audio(constPcm(4, 2)));
    conn.send(finalEvt);
    await dialClosed();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('cancel() during the handshake sends nothing at all — not even config', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('never');
    stream.cancel();
    await dialClosed();
    for (const c of fake.connections) expect(c.frames).toHaveLength(0);
    expect(rec.errors).toEqual([]);
  });

  it('close() is idempotent and silences everything', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.close();
    stream.close();
    stream.cancel();
    stream.pushText('x');
    stream.flush();
    await conn.closed;
    expect(conn.json.map((m) => m.type)).toEqual(['config']);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });
});
