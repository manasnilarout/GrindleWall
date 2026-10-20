import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartesiaSttProvider } from '../../../src/providers/stt/CartesiaSttProvider.js';
import type { SttOptions } from '../../../src/providers/types.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, sttRecorder } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * CartesiaSttProvider hardcodes `wss://api.cartesia.ai/stt/websocket` with no
 * credential override; the `ws` mock redirects it to a local fake.
 */

let fake: FakeWsServer;
const provider = new CartesiaSttProvider();

const opts = (o: Partial<SttOptions> = {}): SttOptions => ({
  model: 'ink-2',
  language: 'en-US',
  sampleRate: 24000,
  credentials: { CARTESIA_API_KEY: FAKE_KEY },
  vad: false,
  ...o,
});

/** `ms` of audio in 20 ms frames, so the VAD sees it the way a browser sends it. */
function frames(buf: Buffer, sampleRate = 24000): Buffer[] {
  const step = Math.floor(sampleRate * 0.02) * 2;
  const out: Buffer[] = [];
  for (let off = 0; off < buf.length; off += step) out.push(buf.subarray(off, off + step));
  return out;
}

/** Answer every `finalize` control frame the way Cartesia does. */
function ackFinalize(conn: FakeConn): void {
  conn.socket.on('message', (data, isBinary) => {
    if (!isBinary && data.toString() === 'finalize') conn.send({ type: 'flush_done' });
  });
}

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  redirectTo(null);
  await fake.close();
});

describe('CartesiaSttProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), sttRecorder().events)).rejects.toThrow(
      'CARTESIA_API_KEY is not set',
    );
    expect(dials()).toHaveLength(0);
  });

  it('dials /stt/websocket with model, pcm_s16le, the session rate, version and ISO-639-1 language', async () => {
    const stream = await provider.open(opts({ language: 'hi-IN' }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith('wss://api.cartesia.ai/stt/websocket?')).toBe(true);
    expect(conn.path).toBe('/api.cartesia.ai/stt/websocket');
    expect(Object.fromEntries(conn.query)).toEqual({
      model: 'ink-2',
      encoding: 'pcm_s16le',
      sample_rate: '24000',
      cartesia_version: '2026-08-14',
      language: 'hi',
    });
    stream.close();
  });

  it('authenticates with X-API-Key + Cartesia-Version headers, key never in the URL', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.headers['x-api-key']).toBe(FAKE_KEY);
    expect(conn.headers['cartesia-version']).toBe('2026-08-14');
    expect(dials()[0].url).not.toContain(FAKE_KEY);
    stream.close();
  });

  it('defaults model to ink-2 and language to en', async () => {
    const stream = await provider.open(opts({ model: '', language: undefined }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.query.get('model')).toBe('ink-2');
    expect(conn.query.get('language')).toBe('en');
    stream.close();
  });

  it('declares opts.sampleRate rather than the canonical constant', async () => {
    const stream = await provider.open(opts({ sampleRate: 16000 }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(conn.query.get('sample_rate')).toBe('16000');
    stream.close();
  });
});

describe('CartesiaSttProvider: audio up', () => {
  it('sends raw binary frames, byte-identical (no base64, no resampling)', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    const a = rampPcm(480, 1);
    stream.pushAudio(a);
    await conn.waitFor((f) => !!f.binary, 'binary');
    expect(conn.binaries[0].equals(a)).toBe(true);
    stream.close();
  });

  it('queues audio pushed during the handshake and flushes it in order', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const chunks = [rampPcm(100, 1), rampPcm(100, 2), rampPcm(100, 3)];
    for (const c of chunks) stream.pushAudio(c);
    const conn = await fake.nextConnection();
    await conn.waitForFrames(3);
    expect(conn.binaries.map((b, i) => b.equals(chunks[i]))).toEqual([true, true, true]);
    stream.close();
  });

  it('ignores empty chunks', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(Buffer.alloc(0));
    stream.pushAudio(constPcm(10, 1));
    await conn.waitForFrames(1);
    await conn.sync();
    expect(conn.frames).toHaveLength(1);
    stream.close();
  });
});

describe('CartesiaSttProvider: transcripts', () => {
  it('accumulates is_final segments as partials and emits ONE final on flush_done', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    ackFinalize(conn);
    conn.send({ type: 'transcript', text: 'Our', is_final: false });
    conn.send({ type: 'transcript', text: 'Our ', is_final: true });
    conn.send({ type: 'transcript', text: 'refu', is_final: false });
    conn.send({ type: 'transcript', text: 'refund ', is_final: true });
    conn.send({ type: 'transcript', text: '   ', is_final: true }); // ink-whisper's empty final
    conn.send({ type: 'transcript', text: 'window is', is_final: true });
    await rec.waitPartial(5);
    stream.finalize();
    await rec.waitFinal();
    expect(rec.partials).toEqual(['Our', 'Our', 'Our refu', 'Our refund', 'Our refund window is']);
    expect(rec.finals).toEqual(['Our refund window is']);
    // finalize() is the local speech end: t0 before the final.
    expect(rec.order.indexOf('speechEnd')).toBeLessThan(rec.order.indexOf('final'));
    expect(conn.frames.map((f) => f.text)).toContain('finalize');
    stream.close();
  });

  it('sends finalize as RAW text, not JSON', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.finalize();
    const f = await conn.waitFor((x) => x.text !== undefined, 'control');
    expect(f.text).toBe('finalize');
    expect(f.json).toBeUndefined();
    stream.close();
  });

  it('starts the next utterance clean after flush_done', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    ackFinalize(conn);
    conn.send({ type: 'transcript', text: 'first', is_final: true });
    await rec.waitPartial();
    stream.finalize();
    await rec.waitFinal();
    conn.send({ type: 'transcript', text: 'second', is_final: true });
    await rec.waitPartial(2);
    stream.finalize();
    await rec.waitFinal(2);
    expect(rec.finals).toEqual(['first', 'second']);
    expect(rec.speechEnds).toBe(2);
    stream.close();
  });

  it('a second finalize() while one is outstanding is not sent twice', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await dialOpen();
    stream.finalize();
    stream.finalize();
    await conn.waitFor((f) => f.text === 'finalize', 'finalize');
    await conn.sync();
    expect(conn.frames.filter((f) => f.text === 'finalize')).toHaveLength(1);
    expect(rec.speechEnds).toBe(1);
    stream.close();
  });

  it('a server-initiated flush_done emits a final even with no finalize outstanding', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send({ type: 'transcript', text: 'hello', is_final: true });
    conn.send({ type: 'flush_done' });
    await rec.waitFinal();
    expect(rec.finals).toEqual(['hello']);
    stream.close();
  });

  it('surfaces error frames with code and message (or title), and ignores done / non-JSON', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.send('garbage');
    conn.send({ type: 'done' });
    conn.send({ type: 'error', error_code: 'bad_audio', message: 'unsupported encoding' });
    conn.send({ type: 'error', title: 'Just a title' });
    await rec.waitError(2);
    expect(rec.errors).toEqual(['Cartesia STT bad_audio: unsupported encoding', 'Cartesia STT error: Just a title']);
    stream.close();
  });

  it('an abnormal close is surfaced with code and reason; a 1000 close is not', async () => {
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.socket.close(4001, 'unauthorized');
    await rec.waitError();
    expect(rec.errors).toEqual(['Cartesia STT closed (4001: unauthorized)']);

    const rec2 = sttRecorder();
    await provider.open(opts(), rec2.events);
    const conn2 = await fake.nextConnection();
    conn2.socket.close(1000);
    await dialClosed(1);
    expect(rec2.errors).toEqual([]);
  });
});

describe('CartesiaSttProvider: local VAD', () => {
  it('with vad on, speech then 600 ms of silence fires onSpeechEnd and sends finalize', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts({ vad: true }), rec.events);
    const conn = await fake.nextConnection();
    ackFinalize(conn);
    conn.send({ type: 'transcript', text: 'hi there', is_final: true });
    await rec.waitPartial();
    for (const f of frames(tone(400))) stream.pushAudio(f);
    expect(rec.speechEnds).toBe(0);
    for (const f of frames(silence(700))) stream.pushAudio(f);
    expect(rec.speechEnds).toBe(1);
    await rec.waitFinal();
    expect(rec.finals).toEqual(['hi there']);
    stream.close();
  });

  it('with vad off, the same audio never ends a turn on its own', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts({ vad: false }), rec.events);
    const conn = await fake.nextConnection();
    const all = [...frames(tone(400)), ...frames(silence(700))];
    for (const f of all) stream.pushAudio(f);
    await conn.waitForFrames(all.length);
    await conn.sync();
    expect(rec.speechEnds).toBe(0);
    expect(conn.frames.some((f) => f.text === 'finalize')).toBe(false);
    stream.close();
  });

  it('a blip shorter than the VAD minimum is not a turn', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts({ vad: true }), rec.events);
    for (const f of [...frames(tone(100)), ...frames(silence(700))]) stream.pushAudio(f);
    expect(rec.speechEnds).toBe(0);
    stream.close();
  });

  // BUG: endTurn() sets `awaitingFlush = true` and then sendControl('finalize'),
  // which is a no-op while the socket is CONNECTING (CartesiaSttProvider.ts:85-90).
  // The finalize is neither sent nor queued, and because only `flush_done` clears
  // `awaitingFlush`, every later finalize()/VAD end is swallowed too: the turn
  // never gets its final. Repro: finalize() (or a VAD end on a burst of buffered
  // audio) before the handshake completes.
  it.fails('a finalize() requested during the handshake still reaches Cartesia once open', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushAudio(constPcm(10, 1));
    stream.finalize(); // before open
    const conn = await fake.nextConnection();
    ackFinalize(conn);
    await conn.waitForFrames(1); // the queued audio arrived, so the socket is open
    stream.finalize(); // a retry, too
    stream.pushAudio(constPcm(10, 2)); // sentinel: anything sent before it has arrived once it has
    await conn.waitForFrames(2);
    await conn.sync();
    expect(conn.frames.some((f) => f.text === 'finalize')).toBe(true);
  });
});

describe('CartesiaSttProvider: teardown', () => {
  it('close() is idempotent; pushAudio/finalize after it send nothing and raise nothing', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    stream.close();
    stream.close();
    stream.pushAudio(constPcm(10, 1));
    stream.finalize();
    await conn.closed;
    await dialClosed();
    expect(conn.binaries).toHaveLength(0);
    expect(rec.errors).toEqual([]);
    expect(rec.speechEnds).toBe(0);
  });

  // BUG: same shape as Sarvam: close() sets `closed = true` before
  // sendControl('close'), which returns early on `closed`
  // (CartesiaSttProvider.ts:160-164), so the documented `close` control frame
  // that asks Cartesia to finish and ack with `done` is never sent.
  it.fails('close() sends the raw "close" control frame before closing', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    stream.pushAudio(constPcm(10, 1));
    await conn.waitForFrames(1);
    stream.close();
    await conn.closed;
    expect(conn.frames.map((f) => f.text)).toContain('close');
  });

  it('close() during the handshake aborts quietly', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushAudio(constPcm(10, 1));
    stream.close();
    await dialClosed();
    expect(rec.errors).toEqual([]);
  });

  it('messages after close() are ignored', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    conn.socket.on('message', () => {});
    stream.close();
    // The server may still have frames in flight when the client closes.
    conn.send({ type: 'transcript', text: 'late', is_final: true });
    conn.send({ type: 'flush_done' });
    await dialClosed();
    expect(rec.partials).toEqual([]);
    expect(rec.finals).toEqual([]);
  });
});

describe('CartesiaSttProvider: secrets', () => {
  it('a 401 handshake rejection names the status but not the key', async () => {
    fake.rejectWith = { status: 401, message: 'Unauthorized' };
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitError(2);
    expect(rec.errors.join(' ')).toContain('401');
    expect(leaksKey(rec.errors)).toBe(false);
  });
});
