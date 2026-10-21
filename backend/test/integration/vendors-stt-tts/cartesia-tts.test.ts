import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartesiaTtsProvider } from '../../../src/providers/tts/CartesiaTtsProvider.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * CartesiaTtsProvider hardcodes `wss://api.cartesia.ai/tts/websocket` with no
 * credential override; the `ws` mock redirects it to a local fake.
 */

let fake: FakeWsServer;
const provider = new CartesiaTtsProvider();

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'sonic-3.6',
  voice: 'voice-123',
  language: 'en-US',
  sampleRate: 24000,
  credentials: { CARTESIA_API_KEY: FAKE_KEY },
  ...o,
});

const chunk = (pcm: Buffer, contextId = 'ctx') => ({ type: 'chunk', data: pcm.toString('base64'), context_id: contextId, done: false });

/** Waits for the closing `continue:false` frame. */
const waitLast = (conn: FakeConn) => conn.waitForJson((m) => m.continue === false, 'continue:false');

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('CartesiaTtsProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'CARTESIA_API_KEY is not set',
    );
    expect(dials()).toHaveLength(0);
  });

  it('dials /tts/websocket with the version in the query, and the key only in X-API-Key', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url).toBe('wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14');
    expect(conn.path).toBe('/api.cartesia.ai/tts/websocket');
    expect(conn.headers['x-api-key']).toBe(FAKE_KEY);
    expect(conn.headers['cartesia-version']).toBe('2026-08-14');
    stream.close();
  });

  it('open() resolves immediately: the socket is still connecting and setup is inside the measured window', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    expect(dials()[0].socket.readyState).toBe(0); // CONNECTING
    stream.close();
  });

  it('every text frame carries model, voice, raw pcm_s16le@24k, one context_id, ISO-639-1 language and max_buffer_delay_ms=250', async () => {
    const stream = await provider.open(opts({ language: 'hi-IN' }), ttsRecorder().events);
    stream.pushText('Hello ');
    stream.pushText('world.');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitLast(conn);
    const msgs = conn.json;
    expect(msgs).toHaveLength(3);
    for (const m of msgs) {
      expect(m).toMatchObject({
        model_id: 'sonic-3.6',
        voice: { mode: 'id', id: 'voice-123' },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
        language: 'hi',
        max_buffer_delay_ms: 250,
      });
      expect(m.context_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(msgs.map((m) => m.context_id)).size).toBe(1);
    stream.close();
  });

  it('a fresh context_id per stream', async () => {
    const a = await provider.open(opts(), ttsRecorder().events);
    a.flush();
    const ca = await fake.nextConnection();
    const b = await provider.open(opts(), ttsRecorder().events);
    b.flush();
    const cb = await fake.nextConnection();
    const [ma, mb] = await Promise.all([waitLast(ca), waitLast(cb)]);
    expect(ma.context_id).not.toBe(mb.context_id);
    a.close();
    b.close();
  });

  it('defaults: sonic-3.6, the Skylar voice, language en', async () => {
    const stream = await provider.open(opts({ model: '', voice: undefined, language: undefined }), ttsRecorder().events);
    stream.flush();
    const conn = await fake.nextConnection();
    const m = await waitLast(conn);
    expect(m.model_id).toBe('sonic-3.6');
    expect(m.voice.id).toBe('db6b0ed5-d5d3-463d-ae85-518a07d3c2b4');
    expect(m.language).toBe('en');
    stream.close();
  });
});

describe('CartesiaTtsProvider: text queueing', () => {
  it('text pushed during the handshake is queued and flushed in order, continue:true until the empty closing frame', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('One ');
    stream.pushText('two ');
    stream.pushText('three.');
    stream.flush();
    const conn = await fake.nextConnection();
    await waitLast(conn);
    expect(conn.json.map((m) => [m.transcript, m.continue])).toEqual([
      ['One ', true],
      ['two ', true],
      ['three.', true],
      ['', false],
    ]);
    stream.close();
  });

  it('text pushed after the handshake goes straight out, interleaving correctly with what was queued', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    stream.pushText('queued ');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(1);
    stream.pushText('live');
    stream.flush();
    await waitLast(conn);
    expect(conn.json.map((m) => m.transcript)).toEqual(['queued ', 'live', '']);
    stream.close();
  });

  it('empty text, and text after flush, are not sent; flush twice sends one closing frame', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.pushText('');
    stream.pushText('a');
    stream.flush();
    stream.flush();
    stream.pushText('late');
    await waitLast(conn);
    await conn.sync();
    expect(conn.json.map((m) => m.transcript)).toEqual(['a', '']);
    stream.close();
  });
});

describe('CartesiaTtsProvider: audio down', () => {
  it('emits the first chunk as soon as it arrives, before the turn is done (stream, do not buffer)', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('Hello');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(1);
    const first = rampPcm(480);
    conn.send(chunk(first));
    await rec.waitAudio();
    expect(rec.audio[0].equals(first)).toBe(true);
    expect(rec.done).toBe(0);
    conn.send(chunk(rampPcm(480, 7)));
    await rec.waitAudio(2);
    stream.flush();
    await waitLast(conn);
    conn.send({ type: 'done', context_id: 'ctx', done: true });
    await rec.waitDone();
    expect(rec.audio).toHaveLength(2);
    expect(rec.done).toBe(1);
    expect(rec.errors).toEqual([]);
  });

  it('done ends the turn exactly once and closes the socket', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.flush();
    const conn = await fake.nextConnection();
    await waitLast(conn);
    conn.send({ type: 'done' });
    conn.send({ type: 'done' });
    await conn.closed;
    await dialClosed();
    expect(rec.done).toBe(1);
    expect(rec.errors).toEqual([]);
    stream.close();
    expect(rec.done).toBe(1);
  });

  it('resamples vendor 24 kHz to opts.sampleRate', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ sampleRate: 16000 }), rec.events);
    const conn = await fake.nextConnection();
    conn.send(chunk(constPcm(480, 4321)));
    await rec.waitAudio();
    expect(rec.audio[0].length).toBe(640);
    expect(rec.audio[0].readInt16LE(0)).toBe(4321);
    stream.close();
  });

  it('skips empty/missing chunk data and ignores flush_done, timestamps and non-JSON', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'chunk' });
    conn.send({ type: 'chunk', data: '' });
    conn.send({ type: 'flush_done' });
    conn.send({ type: 'timestamps', word_timestamps: {} });
    conn.send('}{');
    conn.send(chunk(constPcm(10, 1)));
    await rec.waitAudio();
    expect(rec.audio).toHaveLength(1);
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(0);
    stream.close();
  });
});

describe('CartesiaTtsProvider: failures', () => {
  it('an error frame is surfaced with its code and ends the turn', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'error', error_code: 'invalid_voice', message: 'voice not found', title: 'Bad' });
    await rec.waitDone();
    expect(rec.errors).toEqual(['Cartesia TTS invalid_voice: voice not found']);
    expect(rec.done).toBe(1);
  });

  it('an error frame with only a title still says something', async () => {
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'error', title: 'Rate limited' });
    await rec.waitDone();
    expect(rec.errors).toEqual(['Cartesia TTS error: Rate limited']);
  });

  it('a close before flush is an early close: error with code + reason, then done', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('hi');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(1);
    conn.socket.close(4003, 'credits exhausted');
    await rec.waitDone();
    expect(rec.errors).toEqual(['Cartesia TTS closed early (4003: credits exhausted)']);
    expect(rec.done).toBe(1);
  });

  it('a 1000 close after flush (no done frame) still ends the turn, quietly', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.flush();
    const conn = await fake.nextConnection();
    await waitLast(conn);
    conn.socket.close(1000);
    await rec.waitDone();
    expect(rec.errors).toEqual([]);
  });

  it('a 401 handshake rejection surfaces an error and ends the turn, without the key', async () => {
    fake.rejectWith = { status: 401, message: 'Unauthorized' };
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    await rec.waitDone();
    expect(rec.errors[0]).toBe('Cartesia TTS socket: Unexpected server response: 401');
    expect(rec.done).toBe(1);
    expect(leaksKey(rec.errors)).toBe(false);
  });

  it('an unreachable host ends the turn with an error that carries no key', async () => {
    await fake.close();
    const rec = ttsRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitDone();
    expect(rec.errors.length).toBeGreaterThan(0);
    expect(leaksKey(rec.errors)).toBe(false);
    fake = await startFakeWs();
  });
});

describe('CartesiaTtsProvider: barge-in and teardown', () => {
  it('cancel() inside an audio callback drops the frames already in flight', async () => {
    const rec = ttsRecorder();
    let stream!: Awaited<ReturnType<typeof provider.open>>;
    const events = { ...rec.events, onAudio: (c: Buffer) => { rec.events.onAudio(c); stream.cancel(); } };
    stream = await provider.open(opts(), events);
    stream.pushText('long reply');
    const conn = await fake.nextConnection();
    await conn.waitForFrames(1);
    // Three frames in one burst: the 2nd and 3rd are already on their way when cancel() runs.
    conn.send(chunk(constPcm(10, 1)));
    conn.send(chunk(constPcm(10, 2)));
    conn.send(chunk(constPcm(10, 3)));
    conn.send({ type: 'done' });
    await dialClosed();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0); // the pipeline has moved on; no onDone
    expect(rec.errors).toEqual([]);
  });

  it('cancel() drops queued text and nothing is sent', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('never');
    stream.flush();
    stream.cancel();
    stream.pushText('after');
    await dialClosed();
    for (const c of fake.connections) expect(c.frames).toHaveLength(0);
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(0);
  });

  it('cancel() then close() then close() is safe', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.cancel();
    stream.close();
    stream.close();
    await conn.closed;
    expect(rec.errors).toEqual([]);
    expect(rec.done).toBe(0);
  });
});
