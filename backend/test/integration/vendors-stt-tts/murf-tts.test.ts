import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MurfTtsProvider } from '../../../src/providers/tts/MurfTtsProvider.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder, wav } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * Murf's per-model hosts are constants; `MURF_WS_BASE` overrides them all at
 * once. Host selection is therefore tested through the `ws` mock's redirect
 * (no override set), and the override itself is tested separately.
 */

let fake: FakeWsServer;
const provider = new MurfTtsProvider();
const GLOBAL = 'wss://global.api.murf.ai/v1/speech/stream-input';
const US = 'wss://api.murf.ai/v1/speech/stream-input';

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'falcon-2',
  sampleRate: 24000,
  credentials: { MURF_API_KEY: FAKE_KEY },
  ...o,
});

const audio = (pcm: Buffer, final = false) => ({ audio: pcm.toString('base64'), final });
const voiceConfig = (conn: FakeConn) => conn.waitForJson((m) => m.voice_config, 'voice_config');
const waitEnd = (conn: FakeConn) => conn.waitForJson((m) => m.end === true, 'end:true');

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('MurfTtsProvider: hosts and query', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'MURF_API_KEY is not set',
    );
  });

  it.each([
    ['falcon-2', GLOBAL, 'falcon-2'],
    ['falcon', GLOBAL, 'falcon-2'],
    ['FALCON-2', GLOBAL, 'falcon-2'],
    ['  Falcon  ', GLOBAL, 'falcon-2'],
    ['gen2', US, 'gen2'],
    ['GEN2', US, 'gen2'],
    ['something-new', GLOBAL, 'falcon-2'],
    ['', GLOBAL, 'falcon-2'],
  ])('model %j dials %s with model=%s', async (model, host, wire) => {
    const stream = await provider.open(opts({ model }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith(`${host}?`)).toBe(true);
    expect(Object.fromEntries(conn.query)).toEqual({
      model: wire,
      sample_rate: '24000',
      channel_type: 'MONO',
      format: 'PCM',
    });
    stream.close();
  });

  it('the key travels in the api-key header and never in the URL', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.headers['api-key']).toBe(FAKE_KEY);
    expect(dials()[0].url).not.toContain(FAKE_KEY);
    stream.close();
  });

  it('MURF_WS_BASE overrides the host for every model (the seam the self-test uses)', async () => {
    const base = `${fake.base}/v1/speech/stream-input`;
    const stream = await provider.open(
      opts({ model: 'gen2', credentials: { MURF_API_KEY: FAKE_KEY, MURF_WS_BASE: base } }),
      ttsRecorder().events,
    );
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith(`${base}?`)).toBe(true);
    expect(conn.path).toBe('/v1/speech/stream-input');
    expect(conn.query.get('model')).toBe('gen2');
    stream.close();
  });

  it('open() resolves while the socket is still connecting', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    expect(dials()[0].socket.readyState).toBe(0);
    stream.close();
  });
});

describe('MurfTtsProvider: voice_config', () => {
  it('goes first, with voiceId, the default style for a library voice, neutral prosody, context_id and min_buffer_size 5', async () => {
    const stream = await provider.open(opts({ voice: 'en-IN-aarav', language: 'en-IN' }), ttsRecorder().events);
    stream.pushText('hello ');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    const [first, second] = conn.json;
    expect(first).toEqual({
      voice_config: {
        voiceId: 'en-IN-aarav',
        style: 'Conversational',
        rate: 0,
        pitch: 0,
        variation: 1,
        multi_native_locale: 'en-IN',
      },
      context_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      min_buffer_size: 5,
    });
    // The buffer DELAY is left at the vendor default — see the provider header.
    expect(first).not.toHaveProperty('max_buffer_delay_in_ms');
    expect(second).toEqual({ text: 'hello ', end: false, context_id: first.context_id });
    stream.close();
  });

  it('defaults to en-US-natalie on both models', async () => {
    for (const model of ['falcon-2', 'gen2']) {
      const stream = await provider.open(opts({ model }), ttsRecorder().events);
      const conn = await fake.nextConnection();
      const cfg = await voiceConfig(conn);
      expect(cfg.voice_config.voiceId).toBe('en-US-natalie');
      expect(cfg.voice_config.style).toBe('Conversational');
      stream.close();
    }
  });

  it.each([
    ['Namrita', 'Namrita'],
    ['  ab12cd34-0000-4444-8888-ffffffffffff ', 'ab12cd34-0000-4444-8888-ffffffffffff'],
  ])('a non-library voice id %j is trimmed, forwarded, and gets no assumed style', async (voice, sent) => {
    const stream = await provider.open(opts({ voice }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await voiceConfig(conn);
    expect(cfg.voice_config.voiceId).toBe(sent);
    expect(cfg.voice_config).not.toHaveProperty('style');
    stream.close();
  });

  it('a whitespace-only voice falls back to the default', async () => {
    const stream = await provider.open(opts({ voice: '   ' }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect((await voiceConfig(conn)).voice_config.voiceId).toBe('en-US-natalie');
    stream.close();
  });

  it.each([
    // [model, language, expected multi_native_locale]
    ['falcon-2', 'en-US', 'en-US'],
    ['falcon-2', 'en', 'en-US'], // bare code widened to the model's first locale for it
    ['falcon-2', 'hi', 'hi-IN'],
    ['falcon-2', 'EN', 'en-US'],
    ['falcon-2', 'as-IN', 'as-IN'], // Falcon-only locale
    ['gen2', 'as-IN', undefined], // ...which Gen2 does not publish: dropped, not sent to be refused
    ['gen2', 'fi', 'fi-FI'], // Gen2-only language
    ['falcon-2', 'fi', undefined],
    ['falcon-2', 'xx-YY', undefined],
    ['falcon-2', '', undefined],
    ['falcon-2', undefined, undefined],
  ])('%s + language %j -> multi_native_locale %j', async (model, language, locale) => {
    const stream = await provider.open(opts({ model, language }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await voiceConfig(conn);
    if (locale === undefined) expect(cfg.voice_config).not.toHaveProperty('multi_native_locale');
    else expect(cfg.voice_config.multi_native_locale).toBe(locale);
    stream.close();
  });
});

describe('MurfTtsProvider: text queueing', () => {
  it('text and the closing end:true frame queued during the handshake go out after voice_config, in order, on one context', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('Hello ');
    stream.pushText('world ');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEnd(conn);
    const msgs = conn.json;
    expect(msgs[0].voice_config).toBeDefined();
    expect(msgs.slice(1).map((m) => [m.text, m.end])).toEqual([
      ['Hello ', false],
      ['world ', false],
      ['', true],
    ]);
    expect(new Set(msgs.map((m) => m.context_id)).size).toBe(1);
    stream.close();
  });

  it('empty text and text after flush are dropped; flush twice sends one end', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.pushText('');
    stream.pushText('a ');
    stream.flush();
    stream.flush();
    stream.pushText('late');
    await waitEnd(conn);
    await conn.sync();
    expect(conn.json.slice(1).map((m) => m.text)).toEqual(['a ', '']);
    stream.close();
  });
});

describe('MurfTtsProvider: audio down', () => {
  it('first frame is emitted before the turn ends; final:true (carrying audio) ends it once', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('Hi ');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    const a = rampPcm(240);
    conn.send(audio(a));
    await rec.waitAudio();
    expect(rec.audio[0].equals(a)).toBe(true);
    expect(rec.done).toBe(0);
    stream.flush();
    await waitEnd(conn);
    const b = rampPcm(240, 5);
    conn.send(audio(b, true));
    await rec.waitDone();
    expect(rec.audio.map((x) => x.equals(a) || x.equals(b))).toEqual([true, true]);
    expect(rec.done).toBe(1);
    await conn.closed;
  });

  it('strips a WAV header from the first chunk', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    const pcm = rampPcm(200);
    conn.send(audio(wav(pcm)));
    await rec.waitAudio();
    expect(rec.audio[0].equals(pcm)).toBe(true);
    stream.close();
  });

  it('resamples the requested 24 kHz to opts.sampleRate', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ sampleRate: 16000 }), rec.events);
    const conn = await fake.nextConnection();
    conn.send(audio(constPcm(480, 222)));
    await rec.waitAudio();
    expect(rec.audio[0].length).toBe(640);
    expect(rec.audio[0].readInt16LE(0)).toBe(222);
    stream.close();
  });

  it('ignores frames with no audio and non-JSON frames; final with no audio ends the turn', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send('not json');
    conn.send({ context_id: 'x' });
    conn.send({ audio: '' });
    conn.send({ final: true });
    await rec.waitDone();
    expect(rec.audio).toHaveLength(0);
    expect(rec.errors).toEqual([]);
    stream.close();
  });
});

describe('MurfTtsProvider: failures', () => {
  it.each([
    [{ error: 'INVALID_VOICE: no such voice' }, 'Murf TTS error: INVALID_VOICE: no such voice'],
    [{ error: { message: 'Voice not available for model' } }, 'Murf TTS error: Voice not available for model'],
    [{ errorCode: 'E401', message: 'Invalid api key' }, 'Murf TTS error: Invalid api key'],
    [{ errorCode: 'E500' }, 'Murf TTS error: unknown'],
  ])('error frame %j is surfaced and ends the turn', async (frame, message) => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send(frame);
    await rec.waitDone();
    expect(rec.errors).toEqual([message]);
    expect(rec.done).toBe(1);
  });

  it('an error frame wins over audio in the same message', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ error: 'boom', audio: constPcm(4, 1).toString('base64') });
    await rec.waitDone();
    expect(rec.audio).toHaveLength(0);
  });

  it('Gen2 on the global host closes 1008 — surfaced with its reason when it lands before flush', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(
      opts({ model: 'gen2', credentials: { MURF_API_KEY: FAKE_KEY, MURF_WS_BASE: `${fake.base}/v1/speech/stream-input` } }),
      rec.events,
    );
    stream.pushText('hello ');
    const conn = await fake.nextConnection();
    await voiceConfig(conn);
    conn.socket.close(1008, 'Gen2 Model is not available in global.api.murf.ai.');
    await rec.waitDone();
    expect(rec.errors).toEqual(['Murf TTS closed early (1008: Gen2 Model is not available in global.api.murf.ai.)']);
    expect(rec.done).toBe(1);
  });

  it('a 1000 close after flush with no final ends the turn quietly', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.flush();
    const conn = await fake.nextConnection();
    await waitEnd(conn);
    conn.socket.close(1000);
    await rec.waitDone();
    expect(rec.errors).toEqual([]);
  });

  it('handshake rejection and unreachable host: error + done, never the key', async () => {
    fake.rejectWith = { status: 401, message: 'Unauthorized' };
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitDone();
    expect(rec.errors[0]).toBe('Murf TTS socket: Unexpected server response: 401');
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

describe('MurfTtsProvider: barge-in and teardown', () => {
  it('cancel() inside the first audio callback drops everything after it, with no done and no error', async () => {
    const rec = ttsRecorder();
    let stream!: Awaited<ReturnType<typeof provider.open>>;
    stream = await provider.open(opts(), {
      ...rec.events,
      onAudio: (c) => {
        rec.events.onAudio(c);
        stream.cancel();
      },
    });
    stream.pushText('long ');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(2);
    for (let i = 0; i < 5; i++) conn.send(audio(constPcm(4, i)));
    conn.send(audio(constPcm(4, 9), true));
    await dialClosed();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('cancel() before the handshake sends nothing', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x ');
    stream.flush();
    stream.cancel();
    await dialClosed();
    for (const c of fake.connections) expect(c.frames).toHaveLength(0);
    expect(rec.errors).toEqual([]);
  });

  it('close(), close(), cancel() is safe and silent', async () => {
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
