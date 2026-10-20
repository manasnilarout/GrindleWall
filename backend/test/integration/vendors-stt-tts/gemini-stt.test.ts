import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiSttProvider } from '../../../src/providers/stt/GeminiSttProvider.js';
import type { SttOptions } from '../../../src/providers/types.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import { startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, sttRecorder } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * GeminiSttProvider takes its socket base from `credentials.GEMINI_WS_BASE`, so
 * it dials the fake directly; the `ws` mock only records the client sockets.
 */

let fake: FakeWsServer;
const provider = new GeminiSttProvider();
const PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const opts = (o: Partial<SttOptions> = {}): SttOptions => ({
  model: 'gemini-3.5-transcribe-live',
  language: 'en-US',
  sampleRate: 24000,
  credentials: { GOOGLE_API_KEY: FAKE_KEY, GEMINI_WS_BASE: `${fake.base}${PATH}` },
  vad: false,
  ...o,
});

function frames(buf: Buffer, sampleRate = 24000): Buffer[] {
  const step = Math.floor(sampleRate * 0.02) * 2;
  const out: Buffer[] = [];
  for (let off = 0; off < buf.length; off += step) out.push(buf.subarray(off, off + step));
  return out;
}

/** Opens a stream, waits for `setup`, and acks it. */
async function ready(o: Partial<SttOptions> = {}) {
  const rec = sttRecorder();
  const stream = await provider.open(opts(o), rec.events);
  const conn = await fake.nextConnection();
  await conn.waitForJson((m) => m.setup, 'setup');
  conn.send({ setupComplete: {} });
  return { rec, stream, conn };
}

const audioMsgs = (conn: FakeConn) => conn.json.filter((m) => m.realtimeInput?.audio);

beforeEach(async () => {
  fake = await startFakeWs();
  redirectTo(fake.port);
});

afterEach(async () => {
  vi.useRealTimers();
  redirectTo(null);
  await fake.close();
});

describe('GeminiSttProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), sttRecorder().events)).rejects.toThrow(
      'GOOGLE_API_KEY is not set',
    );
  });

  it('defaults to the production Live API host when no base is injected', async () => {
    const stream = await provider.open(opts({ credentials: { GOOGLE_API_KEY: FAKE_KEY } }), sttRecorder().events);
    const conn = await fake.nextConnection();
    expect(dials()[0].url.startsWith(`wss://generativelanguage.googleapis.com${PATH}?key=`)).toBe(true);
    expect(conn.path).toBe(`/generativelanguage.googleapis.com${PATH}`);
    stream.close();
  });

  it('carries the key as an encoded ?key= query parameter (the documented exception), not a header', async () => {
    const odd = `${FAKE_KEY}/+&=`;
    const stream = await provider.open(
      opts({ credentials: { GOOGLE_API_KEY: odd, GEMINI_WS_BASE: `${fake.base}${PATH}` } }),
      sttRecorder().events,
    );
    const conn = await fake.nextConnection();
    expect(conn.path).toBe(PATH);
    expect(conn.query.get('key')).toBe(odd);
    expect(dials()[0].url).toContain(`key=${encodeURIComponent(odd)}`);
    expect(conn.headers['x-goog-api-key']).toBeUndefined();
    stream.close();
  });

  it('sends setup first: models/<id>, TEXT modality, top-level inputAudioTranscription VERBATIM', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    const conn = await fake.nextConnection();
    const first = await conn.waitForJson(() => true, 'first frame');
    expect(first).toEqual({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: ['en-US'], mode: 'VERBATIM' },
      },
    });
    expect(first.setup.generationConfig.inputAudioTranscription).toBeUndefined();
    stream.close();
  });

  it('defaults the model when none is given', async () => {
    const stream = await provider.open(opts({ model: '' }), sttRecorder().events);
    const conn = await fake.nextConnection();
    const first = await conn.waitForJson((m) => m.setup, 'setup');
    expect(first.setup.model).toBe('models/gemini-3.5-transcribe-live');
    stream.close();
  });

  it.each([
    ['en-US', ['en-US']],
    ['hi-IN', ['hi-IN']],
    ['ceb', ['ceb']],
    ['es-419', ['es-419']],
    ['cmn-Hans-CN', ['cmn-Hans-CN']],
    ['yue-Hant-HK', ['yue-Hant-HK']],
    ['  en-IN  ', ['en-IN']],
    ['en', []],
    ['auto', []],
    ['', []],
    [undefined, []],
    ['not a locale!', []],
  ])('language %j -> languageCodes %j', async (language, codes) => {
    const stream = await provider.open(opts({ language }), sttRecorder().events);
    const conn = await fake.nextConnection();
    const m = await conn.waitForJson((x) => x.setup, 'setup');
    expect(m.setup.inputAudioTranscription.languageCodes).toEqual(codes);
    stream.close();
  });
});

describe('GeminiSttProvider: audio up', () => {
  it('holds audio until setupComplete — not merely until the socket opens — then flushes in order', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await conn.waitForJson((m) => m.setup, 'setup');
    await dialOpen();
    stream.pushAudio(constPcm(480, 11));
    stream.pushAudio(constPcm(480, 22));
    await conn.sync(); // anything sent before the ping has arrived
    expect(conn.frames).toHaveLength(1); // just the setup
    conn.send({ setupComplete: {} });
    await conn.waitForFrames(3);
    expect(audioMsgs(conn).map((m) => Buffer.from(m.realtimeInput.audio.data, 'base64').readInt16LE(0))).toEqual([
      11, 22,
    ]);
    stream.close();
  });

  it('resamples 24 kHz to 16 kHz and declares audio/pcm;rate=16000', async () => {
    const { stream, conn } = await ready();
    stream.pushAudio(constPcm(480, 999));
    const m = await conn.waitForJson((x) => x.realtimeInput?.audio, 'audio');
    expect(m.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    const pcm = Buffer.from(m.realtimeInput.audio.data, 'base64');
    expect(pcm.length).toBe(640);
    expect(pcm.readInt16LE(0)).toBe(999);
    stream.close();
  });

  it('16 kHz input goes up byte-identical', async () => {
    const { stream, conn } = await ready({ sampleRate: 16000 });
    const input = rampPcm(320);
    stream.pushAudio(input);
    const m = await conn.waitForJson((x) => x.realtimeInput?.audio, 'audio');
    expect(Buffer.from(m.realtimeInput.audio.data, 'base64').equals(input)).toBe(true);
    stream.close();
  });

  it('bounds the pre-setupComplete queue to 200 chunks, keeping the most recent', async () => {
    const stream = await provider.open(opts(), sttRecorder().events);
    for (let i = 0; i < 205; i++) stream.pushAudio(constPcm(48, i));
    const conn = await fake.nextConnection();
    await conn.waitForJson((m) => m.setup, 'setup');
    conn.send({ setupComplete: {} });
    await conn.waitForFrames(201);
    await conn.sync();
    const values = audioMsgs(conn).map((m) => Buffer.from(m.realtimeInput.audio.data, 'base64').readInt16LE(0));
    expect(values).toHaveLength(200);
    expect(values[0]).toBe(5);
    expect(values[199]).toBe(204);
    stream.close();
  });

  it('ignores empty chunks', async () => {
    const { stream, conn } = await ready();
    stream.pushAudio(Buffer.alloc(0));
    stream.pushAudio(constPcm(48, 1));
    await conn.waitForFrames(2);
    await conn.sync();
    expect(audioMsgs(conn)).toHaveLength(1);
    stream.close();
  });
});

describe('GeminiSttProvider: transcripts and turn boundaries', () => {
  it('interim transcripts are shown on top of banked segments but never accumulated', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { interimInputTranscription: { text: 'Our ref' } } });
    conn.send({ serverContent: { interimInputTranscription: { text: 'Our refund' } } });
    conn.send({ serverContent: { inputTranscription: { text: 'Our refund window ' } } });
    conn.send({ serverContent: { interimInputTranscription: { text: 'is thirty' } } });
    conn.send({ serverContent: { inputTranscription: { text: 'is thirty days.' } } });
    conn.send({ serverContent: { generationComplete: true } });
    await rec.waitFinal();
    expect(rec.partials).toEqual([
      'Our ref',
      'Our refund',
      'Our refund window',
      'Our refund window is thirty',
      'Our refund window is thirty days.',
    ]);
    expect(rec.finals).toEqual(['Our refund window is thirty days.']);
    stream.close();
  });

  it('local finalize: t0 is marked BEFORE audioStreamEnd goes out, and the server boundary does not re-mark it', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'hello' } } });
    await rec.waitPartial();
    stream.finalize();
    expect(rec.speechEnds).toBe(1); // synchronous, before any round trip
    await conn.waitForJson((m) => m.realtimeInput?.audioStreamEnd === true, 'audioStreamEnd');
    conn.send({ serverContent: { inputTranscription: { text: ' world' } } });
    conn.send({ serverContent: { generationComplete: true } });
    await rec.waitFinal();
    expect(rec.finals).toEqual(['hello world']);
    expect(rec.speechEnds).toBe(1);
    stream.close();
  });

  it('a server-called turn (turnComplete, no local finalize) stamps t0 itself and does not bleed into the next turn', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'first turn' } } });
    conn.send({ serverContent: { turnComplete: true } });
    await rec.waitFinal();
    conn.send({ serverContent: { inputTranscription: { text: 'second turn' } } });
    conn.send({ serverContent: { turnComplete: true } });
    await rec.waitFinal(2);
    expect(rec.finals).toEqual(['first turn', 'second turn']);
    expect(rec.speechEnds).toBe(2);
    expect(rec.order.filter((t) => t !== 'partial')).toEqual(['speechEnd', 'final', 'speechEnd', 'final']);
    stream.close();
  });

  it('a bare boundary between utterances is not a turn', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { generationComplete: true } });
    conn.send({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_END', audioOffset: '1.0s' } });
    conn.send({ serverContent: { inputTranscription: { text: 'real' } } });
    conn.send({ serverContent: { turnComplete: true } });
    await rec.waitFinal();
    expect(rec.finals).toEqual(['real']);
    expect(rec.speechEnds).toBe(1);
    stream.close();
  });

  it('finalize with no boundary from the server falls back after 1.5 s with what it has', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'stranded' } } });
    await rec.waitPartial();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stream.finalize();
    vi.advanceTimersByTime(1499);
    expect(rec.finals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rec.finals).toEqual(['stranded']);
    vi.useRealTimers();
    stream.close();
  });

  it('the boundary arriving in time cancels the fallback (no second final)', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'quick' } } });
    await rec.waitPartial();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stream.finalize();
    conn.send({ serverContent: { generationComplete: true } });
    await rec.waitFinal();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    expect(rec.finals).toEqual(['quick']);
    stream.close();
  });

  it('a second finalize() while one is outstanding is not sent twice', async () => {
    const { rec, stream, conn } = await ready();
    stream.finalize();
    stream.finalize();
    await conn.waitForJson((m) => m.realtimeInput?.audioStreamEnd, 'audioStreamEnd');
    await conn.sync();
    expect(conn.json.filter((m) => m.realtimeInput?.audioStreamEnd)).toHaveLength(1);
    expect(rec.speechEnds).toBe(1);
    stream.close();
  });

  it('local VAD (vad:true) ends the turn on speech -> silence and sends audioStreamEnd', async () => {
    const { rec, stream, conn } = await ready({ vad: true });
    for (const f of frames(tone(400))) stream.pushAudio(f);
    expect(rec.speechEnds).toBe(0);
    for (const f of frames(silence(700))) stream.pushAudio(f);
    expect(rec.speechEnds).toBe(1);
    await conn.waitForJson((m) => m.realtimeInput?.audioStreamEnd, 'audioStreamEnd');
    // Audio keeps streaming past finalization (see the provider header).
    stream.pushAudio(constPcm(480, 3));
    await conn.waitForJson((m) => m.realtimeInput?.audio?.data && Buffer.from(m.realtimeInput.audio.data, 'base64').readInt16LE(0) === 3, 'trailing audio');
    stream.close();
  });

  it('surfaces {error:{message}} frames and ignores goAway / non-JSON', async () => {
    const { rec, stream, conn } = await ready();
    conn.send('not json');
    conn.send({ goAway: { timeLeft: '10s' } });
    conn.send({ error: { message: 'Invalid argument', status: 'INVALID_ARGUMENT', code: 400 } });
    await rec.waitError();
    expect(rec.errors).toEqual(['Gemini STT: Invalid argument']);
    stream.close();
  });
});

describe('GeminiSttProvider: close handling', () => {
  it('a 1006 mid-turn salvages the banked transcript BEFORE reporting the error', async () => {
    const { rec, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'six good partials' } } });
    await rec.waitPartial();
    conn.socket.terminate();
    await rec.waitError();
    expect(rec.finals).toEqual(['six good partials']);
    expect(rec.errors).toEqual(['Gemini STT closed (1006)']);
    expect(rec.order.indexOf('final')).toBeLessThan(rec.order.indexOf('error'));
  });

  it('a close while a local finalize is outstanding still yields a (possibly empty) final', async () => {
    const { rec, stream, conn } = await ready();
    await dialOpen();
    stream.finalize();
    await conn.waitForJson((m) => m.realtimeInput?.audioStreamEnd, 'audioStreamEnd');
    conn.socket.close(1011, 'internal');
    await rec.waitError();
    expect(rec.finals).toEqual(['']);
    expect(rec.errors).toEqual(['Gemini STT closed (1011: internal)']);
  });

  it('a close between turns emits no final, and 1000 emits no error', async () => {
    const { rec, conn } = await ready();
    conn.socket.close(1000);
    await dialClosed();
    expect(rec.finals).toEqual([]);
    expect(rec.errors).toEqual([]);
  });

  it('a 1007 setup rejection (e.g. misplaced field) is surfaced with its reason', async () => {
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    const conn = await fake.nextConnection();
    await conn.waitForJson((m) => m.setup, 'setup');
    conn.socket.close(1007, "Unknown name at 'setup.generation_config'");
    await rec.waitError();
    expect(rec.errors).toEqual(["Gemini STT closed (1007: Unknown name at 'setup.generation_config')"]);
  });

  it('client close() is idempotent, salvages nothing and reports nothing', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ serverContent: { inputTranscription: { text: 'abandoned' } } });
    await rec.waitPartial();
    stream.close();
    stream.close();
    stream.pushAudio(constPcm(48, 1));
    stream.finalize();
    await conn.closed;
    await dialClosed();
    expect(rec.finals).toEqual([]);
    expect(rec.errors).toEqual([]);
    expect(rec.speechEnds).toBe(0);
  });

  it('close() before setupComplete drops queued audio and never sends it', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushAudio(constPcm(48, 1));
    const conn = await fake.nextConnection();
    await conn.waitForJson((m) => m.setup, 'setup');
    stream.close();
    conn.send({ setupComplete: {} });
    await conn.closed;
    expect(audioMsgs(conn)).toHaveLength(0);
    expect(rec.errors).toEqual([]);
  });

  it('close() during the TCP/WS handshake aborts quietly', async () => {
    const rec = sttRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.close();
    await dialClosed();
    expect(rec.errors).toEqual([]);
  });
});

describe('GeminiSttProvider: secrets (the key is in the URL here, so this matters most)', () => {
  it('a rejected handshake does not echo the URL or key into any error', async () => {
    fake.rejectWith = { status: 400, message: 'Bad Request' };
    const rec = sttRecorder();
    await provider.open(opts(), rec.events);
    await rec.waitError(2);
    expect(rec.errors.join(' ')).toContain('400');
    expect(leaksKey(rec.errors)).toBe(false);
  });

  it('an unreachable host does not echo the key into any error', async () => {
    const port = fake.port;
    await fake.close();
    const rec = sttRecorder();
    await provider.open(
      opts({ credentials: { GOOGLE_API_KEY: FAKE_KEY, GEMINI_WS_BASE: `ws://127.0.0.1:${port}${PATH}` } }),
      rec.events,
    );
    await rec.waitError();
    expect(leaksKey(rec.errors)).toBe(false);
    fake = await startFakeWs();
  });

  it('a server error frame is reported as the vendor wrote it, without adding the key', async () => {
    const { rec, stream, conn } = await ready();
    conn.send({ error: { message: 'API key not valid' } });
    await rec.waitError();
    expect(leaksKey(rec.errors)).toBe(false);
    stream.close();
  });
});
