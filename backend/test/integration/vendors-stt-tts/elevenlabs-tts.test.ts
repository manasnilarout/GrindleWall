import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsProvider } from '../../../src/providers/tts/ElevenLabsTtsProvider.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder, wav } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/* ElevenLabs takes its base from `credentials.ELEVENLABS_WS_BASE`; the mock only records sockets. */

let fake: FakeWsServer;
const provider = new ElevenLabsTtsProvider();

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'eleven_flash_v2_5',
  voice: 'voiceABC',
  language: 'hi-IN',
  sampleRate: 24000,
  credentials: { ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_WS_BASE: fake.base },
  ...o,
});

const audio = (pcm: Buffer) => ({ audio: pcm.toString('base64'), alignment: null });
const waitEos = (conn: FakeConn) => conn.waitForJson((m) => m.text === '', 'end-of-stream');

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('ElevenLabsTtsProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'ELEVENLABS_API_KEY is not set',
    );
  });

  it('puts the voice in the path, model/pcm_24000/auto_mode=false/language_code in the query, key in xi-api-key', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.path).toBe('/v1/text-to-speech/voiceABC/stream-input');
    expect(Object.fromEntries(conn.query)).toEqual({
      model_id: 'eleven_flash_v2_5',
      output_format: 'pcm_24000',
      auto_mode: 'false',
      language_code: 'hi',
    });
    expect(conn.headers['xi-api-key']).toBe(FAKE_KEY);
    expect(dials()[0].url).not.toContain(FAKE_KEY);
    stream.close();
  });

  it('defaults to the production host, eleven_flash_v2_5 and the George voice', async () => {
    const stream = await provider.open(
      opts({ model: '', voice: undefined, credentials: { ELEVENLABS_API_KEY: FAKE_KEY } }),
      ttsRecorder().events,
    );
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith('wss://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input?')).toBe(true);
    expect(conn.query.get('model_id')).toBe('eleven_flash_v2_5');
    stream.close();
  });

  it('trims trailing slashes off the base and URL-encodes the voice', async () => {
    const stream = await provider.open(
      opts({ voice: ' a/b c ', credentials: { ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_WS_BASE: `${fake.base}///` } }),
      ttsRecorder().events,
    );
    const conn = await fake.nextConnection();
    expect(conn.path).toBe('/v1/text-to-speech/a%2Fb%20c/stream-input');
    stream.close();
  });

  it.each([
    ['eleven_flash_v2_5', 'en-IN', 'en'],
    ['eleven_turbo_v2_5', 'TA-in', 'ta'],
    ['eleven_multilingual_v2', 'hi-IN', null],
    ['eleven_flash_v2', 'en', null],
    ['eleven_flash_v2_5', undefined, null],
    ['eleven_flash_v2_5', '  ', null],
  ])('%s + %j -> language_code %j', async (model, language, code) => {
    const stream = await provider.open(opts({ model, language }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.query.get('language_code')).toBe(code);
    stream.close();
  });

  it('open() resolves while the socket is still connecting', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    expect(dials()[0].socket.readyState).toBe(0);
    stream.close();
  });
});

describe('ElevenLabsTtsProvider: messages up', () => {
  it('init frame first (single space, schema-default voice_settings, chunk_length_schedule [50,160,250,290])', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('Hello');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEos(conn);
    expect(conn.json[0]).toEqual({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      generation_config: { chunk_length_schedule: [50, 160, 250, 290] },
    });
    // generation_config is never resent.
    expect(conn.json.slice(1).every((m) => !('generation_config' in m) && !('generator_config' in m))).toBe(true);
    // The key is never put in a message body.
    expect(conn.frames.some((f) => f.text?.includes(FAKE_KEY))).toBe(false);
    stream.close();
  });

  it('queues text through the handshake; every chunk ends in exactly one space; close message is {text:""}', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('Hel');
    stream.pushText('lo ');
    stream.pushText('world.');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEos(conn);
    expect(conn.json.slice(1)).toEqual([{ text: 'Hel ' }, { text: 'lo ' }, { text: 'world. ' }, { text: '' }]);
    stream.close();
  });

  it('empty text and text after flush are dropped; flush twice sends one close message', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.pushText('');
    stream.pushText('a');
    stream.flush();
    stream.flush();
    stream.pushText('late');
    await waitEos(conn);
    await conn.sync();
    expect(conn.json.slice(1)).toEqual([{ text: 'a ' }, { text: '' }]);
    stream.close();
  });
});

describe('ElevenLabsTtsProvider: audio down', () => {
  it('first frame emitted immediately; isFinal with null audio ends the turn without an empty chunk', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('Hi');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    const a = rampPcm(240);
    conn.send(audio(a));
    await rec.waitAudio();
    expect(rec.audio[0].equals(a)).toBe(true);
    expect(rec.done).toBe(0);
    stream.flush();
    await waitEos(conn);
    conn.send({ audio: null, isFinal: true });
    await rec.waitDone();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(1);
    expect(rec.errors).toEqual([]);
    await conn.closed;
  });

  it('accepts the snake_case is_final terminator too', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ is_final: true });
    await rec.waitDone();
    expect(rec.done).toBe(1);
  });

  it('isFinal:null / false does not end the turn', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ audio: constPcm(4, 1).toString('base64'), isFinal: null });
    conn.send({ audio: constPcm(4, 2).toString('base64'), isFinal: false });
    await rec.waitAudio(2);
    expect(rec.done).toBe(0);
    stream.close();
  });

  it('strips a WAV header and resamples 24 kHz to opts.sampleRate', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ sampleRate: 16000 }), rec.events);
    const conn = await fake.nextConnection();
    conn.send(audio(wav(constPcm(480, 300))));
    await rec.waitAudio();
    expect(rec.audio[0].length).toBe(640);
    expect(rec.audio[0].readInt16LE(0)).toBe(300);
    stream.close();
  });

  it('a frame carrying only a code (no error field) is not treated as an error', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ code: 200, message: 'ok' });
    conn.send(audio(constPcm(4, 1)));
    await rec.waitAudio();
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(0);
    stream.close();
  });

  it('non-JSON frames are ignored', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send('<<');
    conn.send(audio(constPcm(4, 1)));
    await rec.waitAudio();
    expect(rec.errors).toEqual([]);
    stream.close();
  });
});

describe('ElevenLabsTtsProvider: failures', () => {
  it.each([
    [{ error: 'voice_not_found' }, 'ElevenLabs TTS error: voice_not_found'],
    [{ error: { message: 'Invalid model' } }, 'ElevenLabs TTS error: Invalid model'],
    [{ error: {}, message: 'top-level msg' }, 'ElevenLabs TTS error: top-level msg'],
    [{ error: {}, code: 1008 }, 'ElevenLabs TTS error: 1008'],
  ])('error frame %j surfaces and ends the turn', async (frame, message) => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send(frame);
    await rec.waitDone();
    expect(rec.errors).toEqual([message]);
    expect(rec.done).toBe(1);
  });

  // LATENT BUG: the guard is `msg.error !== undefined` (ElevenLabsTtsProvider.ts:300),
  // so a frame carrying an explicit `"error": null` is treated as a fatal error:
  // its audio is dropped and the turn ends. The file's own rationale for keying on
  // `error` ("inventing [an error] is not [recoverable]") argues against exactly this.
  it.fails('a frame with "error": null is not an error, and its audio is kept', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ audio: constPcm(4, 1).toString('base64'), error: null });
    conn.send(audio(constPcm(4, 2)));
    await Promise.race([rec.waitAudio(2), rec.waitDone()]);
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(0);
    stream.close();
  });

  it('an early close (before flush) is an error', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    conn.socket.close(1011, 'internal');
    await rec.waitDone();
    expect(rec.errors).toEqual(['ElevenLabs TTS closed early (1011: internal)']);
  });

  it('an abnormal close AFTER flush is still an error (a quota failure must not read as a short answer)', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEos(conn);
    conn.socket.close(1008, 'quota_exceeded');
    await rec.waitDone();
    expect(rec.errors).toEqual(['ElevenLabs TTS closed early (1008: quota_exceeded)']);
  });

  it('a 1000 close after flush with no terminal frame ends the turn quietly', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEos(conn);
    conn.socket.close(1000);
    await rec.waitDone();
    expect(rec.errors).toEqual([]);
  });

  it('handshake rejection and unreachable host: error + done, never the key', async () => {
    fake.rejectWith = { status: 401, message: 'Unauthorized' };
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitDone();
    expect(rec.errors[0]).toBe('ElevenLabs TTS socket: Unexpected server response: 401');
    expect(leaksKey(rec.errors)).toBe(false);

    const base = fake.base;
    await fake.close();
    const rec2 = ttsRecorder();
    await provider.open(opts({ credentials: { ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_WS_BASE: base } }), rec2.events);
    await rec2.waitDone();
    expect(rec2.errors.length).toBeGreaterThan(0);
    expect(leaksKey(rec2.errors)).toBe(false);
    fake = await startFakeWs();
  });
});

describe('ElevenLabsTtsProvider: barge-in and teardown', () => {
  it('cancel() inside the first audio callback drops the rest, with no done and no error', async () => {
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
    for (let i = 0; i < 4; i++) conn.send(audio(constPcm(4, i)));
    conn.send({ isFinal: true });
    await dialClosed();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('cancel() before the handshake sends nothing, not even the init frame', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.cancel();
    await dialClosed();
    for (const c of fake.connections) expect(c.frames).toHaveLength(0);
    expect(rec.errors).toEqual([]);
  });

  it('close() is idempotent and silent', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.close();
    stream.close();
    stream.cancel();
    await conn.closed;
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });
});
