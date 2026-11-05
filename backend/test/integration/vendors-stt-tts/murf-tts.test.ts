import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import {
  MAX_SEGMENT_CHARS,
  MIN_SEGMENT_CHARS,
  MurfTtsProvider,
  segmentText,
} from '../../../src/providers/tts/MurfTtsProvider.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { WAIT_MS, startFakeWs, type FakeConn, type FakeWsServer } from './helpers/fake-ws.js';
import { dialClosed, dialOpen, dials, redirectTo } from './helpers/ws-redirect.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder, wav } from './helpers/recorders.js';

vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());

/*
 * Murf has two transports, chosen per model:
 *
 *   falcon  POST /v1/speech/stream on in.api.murf.ai — tested against a local
 *           node:http fake through `credentials.MURF_HTTP_URL`, and the default
 *           URL through a stubbed `fetch`.
 *   gen2    wss://api.murf.ai/v1/speech/stream-input — tested through the `ws`
 *           mock's redirect (no override set), and MURF_WS_BASE separately.
 *
 * None of this is vendor evidence. The HTTP shape in particular is doc-derived
 * and has never completed a live call; see the provider header.
 */

const provider = new MurfTtsProvider();
const IN_HTTP = 'https://in.api.murf.ai/v1/speech/stream';
const US = 'wss://api.murf.ai/v1/speech/stream-input';

// ---------------------------------------------------------------------------
// HTTP fake (Falcon)
// ---------------------------------------------------------------------------

interface Req {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  res: http.ServerResponse;
}

let server: http.Server;
let httpUrl: string;
let requests: Req[];
let handler: (r: Req) => void;
let reqWaiters: Array<() => void>;

const fopts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'falcon-2',
  sampleRate: 24000,
  credentials: { MURF_API_KEY: FAKE_KEY, MURF_HTTP_URL: httpUrl },
  ...o,
});

function nextRequest(n = requests.length + 1): Promise<Req> {
  return new Promise<Req>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${n} never arrived`)), WAIT_MS);
    const check = () => {
      if (requests.length >= n) {
        clearTimeout(timer);
        resolve(requests[n - 1]);
        return true;
      }
      return false;
    };
    if (!check()) reqWaiters.push(() => void check());
  });
}

const audioResponse = (r: Req, ...chunks: Buffer[]) => {
  r.res.writeHead(200, { 'content-type': 'application/octet-stream' });
  for (const c of chunks) r.res.write(c);
  r.res.end();
};

const tick = () => new Promise((res) => setTimeout(res, 30));

beforeEach(async () => {
  requests = [];
  reqWaiters = [];
  handler = (r) => audioResponse(r, constPcm(240, 7));
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = undefined;
      }
      const r = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, res };
      requests.push(r);
      for (const w of reqWaiters.splice(0)) w();
      handler(r);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  httpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/speech/stream`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('MurfTtsProvider (falcon, HTTP): routing and request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(fopts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'MURF_API_KEY is not set',
    );
  });

  it('POSTs to the India regional endpoint by default', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(constPcm(10, 1), { status: 200 });
    });
    const rec = ttsRecorder();
    const stream = await provider.open(fopts({ credentials: { MURF_API_KEY: FAKE_KEY } }), rec.events);
    stream.pushText('Hello.');
    stream.flush();
    await rec.waitDone();
    expect(calls.map((c) => c.url)).toEqual([IN_HTTP]);
    expect(calls[0].init.method).toBe('POST');
    expect(dials()).toHaveLength(0);
  });

  it.each(['falcon-2', 'falcon-2.1', 'falcon', 'FALCON-2', '  Falcon  ', 'something-new', ''])(
    'model %j goes over HTTP as model=falcon-2.1',
    async (model) => {
      const rec = ttsRecorder();
      const stream = await provider.open(fopts({ model }), rec.events);
      stream.pushText('Hi.');
      stream.flush();
      const r = await nextRequest();
      expect(r.method).toBe('POST');
      expect(r.url).toBe('/v1/speech/stream');
      expect(r.body.model).toBe('falcon-2.1');
      await rec.waitDone();
      expect(dials()).toHaveLength(0);
    },
  );

  it('the body is the documented shape; the key travels in the api-key header and never in the URL', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts({ voice: 'en-IN-aarav', language: 'en-IN' }), rec.events);
    stream.pushText('Hello there.');
    stream.flush();
    const r = await nextRequest();
    expect(r.headers['api-key']).toBe(FAKE_KEY);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.url).not.toContain(FAKE_KEY);
    expect(r.body).toEqual({
      text: 'Hello there.',
      voiceId: 'en-IN-aarav',
      model: 'falcon-2.1',
      format: 'PCM',
      sampleRate: 24000,
      channelType: 'MONO',
      rate: 0,
      pitch: 0,
      style: 'Conversational',
      locale: 'en-IN',
    });
    await rec.waitDone();
  });

  it('defaults to en-US-natalie; a whitespace-only voice falls back to it', async () => {
    for (const voice of [undefined, '   ']) {
      const rec = ttsRecorder();
      const stream = await provider.open(fopts({ voice }), rec.events);
      stream.pushText('Hi.');
      stream.flush();
      const r = await nextRequest();
      expect(r.body.voiceId).toBe('en-US-natalie');
      expect(r.body.style).toBe('Conversational');
      await rec.waitDone();
    }
  });

  it.each([
    ['Namrita', 'Namrita'],
    ['  ab12cd34-0000-4444-8888-ffffffffffff ', 'ab12cd34-0000-4444-8888-ffffffffffff'],
  ])('a non-library voice id %j is trimmed, forwarded, and gets no assumed style', async (voice, sent) => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts({ voice }), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    const r = await nextRequest();
    expect(r.body.voiceId).toBe(sent);
    expect(r.body).not.toHaveProperty('style');
    await rec.waitDone();
  });

  it.each([
    ['en-US', 'en-US'],
    ['en', 'en-US'],
    ['hi', 'hi-IN'],
    ['EN', 'en-US'],
    ['as-IN', 'as-IN'],
    ['fi', undefined], // Gen2-only language
    ['xx-YY', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('language %j -> locale %j (the deprecated multiNativeLocale is never sent)', async (language, locale) => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts({ language }), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    const r = await nextRequest();
    if (locale === undefined) expect(r.body).not.toHaveProperty('locale');
    else expect(r.body.locale).toBe(locale);
    expect(r.body).not.toHaveProperty('multiNativeLocale');
    await rec.waitDone();
  });
});

/** Feeds `text` through segmentText a few characters at a time, the way LLM tokens arrive. */
function streamed(text: string, step = 3): string[] {
  let buf = '';
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    buf += text.slice(i, i + step);
    const r = segmentText(buf, false);
    out.push(...r.segments);
    buf = r.rest;
  }
  return [...out, ...segmentText(buf, true).segments];
}

describe('segmentText (what each HTTP request carries)', () => {
  it.each([
    ['decimals and domains stay whole', 'It costs 3.5 dollars on murf.ai and that is fine.', ['It costs 3.5 dollars on murf.ai and that is fine.']],
    [
      'titles and dotted abbreviations are not sentence ends',
      'Dr. Smith will see you at 3 p.m. today. Please arrive early.',
      ['Dr. Smith will see you at 3 p.m. today.', 'Please arrive early.'],
    ],
    [
      'U.S. and e.g. do not split; a short sentence waits for the next',
      'The U.S. economy grew. Analysts e.g. Goldman expected less. Sure! Okay.',
      ['The U.S. economy grew.', 'Analysts e.g. Goldman expected less.', 'Sure! Okay.'],
    ],
    [
      'a list number always starts its segment, never ends the one before',
      'Here are the steps you need:\n1. Open the app now\n2. Tap settings\n3. Choose voice',
      ['Here are the steps you need:', '1. Open the app now\n2. Tap settings', '3. Choose voice'],
    ],
    ['a short opener is not its own request', 'Sure! How can I help you today with your refund?', ['Sure! How can I help you today with your refund?']],
    ['closing quotes stay with their sentence', 'He said "yes, of course." She agreed with him.', ['He said "yes, of course."', 'She agreed with him.']],
    ['Chinese needs no space after 。', '你好。今天天气很好。我们去公园吧。明天见！', ['你好。今天天气很好。我们去公园吧。', '明天见！']],
    ['Devanagari danda ends a sentence', 'नमस्ते। आप कैसे हैं? मैं ठीक हूँ।', ['नमस्ते। आप कैसे हैं?', 'मैं ठीक हूँ।']],
  ])('%s', (_name, text, expected) => {
    expect(streamed(text)).toEqual(expected);
  });

  it('a run-on with no sentence end is cut at the cap, at a word boundary, before flush', () => {
    const text = 'word '.repeat(150);
    let buf = '';
    const sent: string[] = [];
    for (const w of text.match(/\S+\s*/g)!) {
      buf += w;
      const r = segmentText(buf, false);
      sent.push(...r.segments);
      buf = r.rest;
    }
    expect(sent.length).toBeGreaterThan(0); // something went out before flush
    expect(sent.every((s) => s.length <= MAX_SEGMENT_CHARS && !s.endsWith('wor'))).toBe(true);
  });

  it('prefers a clause end inside the cap', () => {
    const long = `${'a '.repeat(150)}then, ${'b '.repeat(200)}`;
    const { segments } = segmentText(long, true);
    expect(segments[0].endsWith('then,')).toBe(true);
    expect(segments.every((s) => s.length <= MAX_SEGMENT_CHARS)).toBe(true);
    expect(segments.join(' ').replace(/\s+/g, ' ')).toBe(long.trim().replace(/\s+/g, ' '));
  });

  it('flush sends everything, however short; nothing short goes before it', () => {
    expect(segmentText('Hi. ', false)).toEqual({ segments: [], rest: 'Hi. ' });
    expect(segmentText('Hi. ', true)).toEqual({ segments: ['Hi.'], rest: '' });
    expect(segmentText('   ', true).segments).toEqual([]);
    expect('Hi.'.length).toBeLessThan(MIN_SEGMENT_CHARS);
  });

  it('no text is lost or reordered across any segmentation', () => {
    const text = 'Dr. Who? Yes. 你好。今天很好。 Item one\n2. Item two, then more. Done';
    expect(streamed(text, 1).join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
});

describe('MurfTtsProvider (falcon, HTTP): request scheduling', () => {
  it('open() and pushText send nothing until a long-enough sentence is complete', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hello ');
    stream.pushText('there, my friend');
    await tick();
    expect(requests).toHaveLength(0);
    stream.pushText('. How');
    const r = await nextRequest();
    expect(r.body.text).toBe('Hello there, my friend.');
    stream.flush();
    expect((await nextRequest(2)).body.text).toBe('How');
    await rec.waitDone();
    expect(rec.done).toBe(1);
  });

  it('a request per completed segment, strictly one in flight, audio in order', async () => {
    const held: Req[] = [];
    handler = (r) => held.push(r);
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('The first sentence is here. ');
    await nextRequest(1);
    stream.pushText('The second sentence follows it. ');
    stream.pushText('Tail');
    stream.flush();
    await tick();
    expect(requests).toHaveLength(1); // the next waits for this one's audio to finish
    expect(requests[0].body.text).toBe('The first sentence is here.');
    audioResponse(held[0], constPcm(10, 1));
    expect((await nextRequest(2)).body.text).toBe('The second sentence follows it.');
    await tick();
    expect(requests).toHaveLength(2);
    audioResponse(held[1], constPcm(10, 2));
    expect((await nextRequest(3)).body.text).toBe('Tail');
    await tick();
    expect(rec.done).toBe(0);
    audioResponse(held[2], constPcm(10, 3));
    await rec.waitDone();
    expect(rec.audio.map((b) => b.readInt16LE(0))).toEqual([1, 2, 3]);
    expect(rec.done).toBe(1);
  });

  it('flush with no text ends the turn without a request; text after flush is dropped', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('   ');
    stream.flush();
    stream.flush();
    stream.pushText('A sentence that came too late. ');
    await rec.waitDone();
    await tick();
    expect(requests).toHaveLength(0);
    expect(rec.done).toBe(1);
    expect(stream.billableCharacters?.()).toBe(0);
  });
});

describe('MurfTtsProvider (falcon, HTTP): audio down', () => {
  it('emits the first chunk while the response is still streaming', async () => {
    let held!: Req;
    handler = (r) => {
      held = r;
      r.res.writeHead(200);
      r.res.write(rampPcm(240));
    };
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi. ');
    stream.flush();
    await rec.waitAudio();
    expect(rec.audio[0].equals(rampPcm(240))).toBe(true);
    expect(rec.done).toBe(0);
    held.res.end(rampPcm(10, 3));
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).equals(Buffer.concat([rampPcm(240), rampPcm(10, 3)]))).toBe(true);
  });

  it('a sample split across HTTP chunks is reassembled, not dropped or shifted', async () => {
    const pcm = rampPcm(100, 1000);
    handler = (r) => {
      r.res.writeHead(200);
      r.res.write(pcm.subarray(0, 51));
      setTimeout(() => r.res.end(pcm.subarray(51)), 20);
    };
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).equals(pcm)).toBe(true);
    expect(rec.audio.every((b) => b.length % 2 === 0)).toBe(true);
  });

  it('strips a RIFF header even when it arrives split across chunks', async () => {
    const pcm = rampPcm(200);
    const body = wav(pcm);
    handler = (r) => {
      r.res.writeHead(200);
      r.res.write(body.subarray(0, 20));
      setTimeout(() => r.res.end(body.subarray(20)), 20);
    };
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).equals(pcm)).toBe(true);
  });

  it('a response shorter than a WAV header is still emitted', async () => {
    handler = (r) => audioResponse(r, constPcm(5, 9));
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).equals(constPcm(5, 9))).toBe(true);
  });

  it('resamples the requested 24 kHz to opts.sampleRate', async () => {
    handler = (r) => audioResponse(r, constPcm(480, 222));
    const rec = ttsRecorder();
    const stream = await provider.open(fopts({ sampleRate: 16000 }), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(rec.bytes).toBe(640);
    expect(rec.audio[0].readInt16LE(0)).toBe(222);
  });
});

const FIRST = 'The first sentence is here.';
const SECOND = 'The second sentence follows it.';

describe('MurfTtsProvider (falcon, HTTP): failures', () => {
  it.each([
    [400, '{"message":"Invalid voice_id: en-US-imani"}', {}, 'Murf TTS HTTP 400: Invalid voice_id: en-US-imani'],
    [
      429,
      '{"error_code":429,"error":"concurrency_limit_exceeded","region":"ap-south-1","limit":2,"message":"Too many"}',
      { 'retry-after': '1' },
      'Murf TTS HTTP 429: Too many (Retry-After: 1s)',
    ],
    [403, '{"error":"Invalid or expired api-key"}', {}, 'Murf TTS HTTP 403: Invalid or expired api-key'],
    [500, 'upstream exploded', {}, 'Murf TTS HTTP 500: upstream exploded'],
    [503, '', {}, 'Murf TTS HTTP 503: Service Unavailable'],
  ])('HTTP %i: surfaced with the vendor text, ends the turn once, stops the queued segment, bills nothing', async (status, body, headers, message) => {
    const held: Req[] = [];
    handler = (r) => held.push(r);
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText(`${FIRST} `);
    await nextRequest(1);
    stream.pushText(`${SECOND} `);
    stream.flush(); // SECOND is now queued behind FIRST
    held[0].res.writeHead(status, headers);
    held[0].res.end(body);
    await rec.waitDone();
    await tick();
    expect(rec.errors).toEqual([message]);
    expect(rec.done).toBe(1);
    expect(requests).toHaveLength(1);
    expect(stream.billableCharacters?.()).toBe(0);
    expect(leaksKey(rec.errors)).toBe(false);
  });

  it('a 200 carrying a JSON body is an error, not audio', async () => {
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'application/json' });
      r.res.end('{"message":"Locale not supported"}');
    };
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio).toHaveLength(0);
    expect(rec.errors).toEqual(['Murf TTS HTTP 200: Locale not supported']);
  });

  it('a 200 with an empty body ends the turn quietly', async () => {
    handler = (r) => audioResponse(r);
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio).toHaveLength(0);
    expect(rec.errors).toEqual([]);
  });

  it('an unreachable host: error naming the cause + done, never the key, nothing billed', async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors[0]).toMatch(/^Murf TTS HTTP: .*\(ECONNREFUSED\)$/);
    expect(leaksKey(rec.errors)).toBe(false);
    expect(stream.billableCharacters?.()).toBe(0);
    server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  it('times out when no headers arrive, and when audio stops mid-body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      handler = () => {}; // never answers
      const rec = ttsRecorder();
      const stream = await provider.open(fopts(), rec.events);
      stream.pushText('Hi.');
      stream.flush();
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(rec.errors).toEqual(['Murf TTS HTTP: no response headers within 15000ms']));
      expect(stream.billableCharacters?.()).toBe(0);

      handler = (r) => {
        r.res.writeHead(200);
        r.res.write(constPcm(240, 1)); // ...and then nothing
      };
      const rec2 = ttsRecorder();
      const stream2 = await provider.open(fopts(), rec2.events);
      stream2.pushText('Hi.');
      stream2.flush();
      await vi.waitFor(() => expect(rec2.audio).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(rec2.errors).toEqual([]); // the idle timer restarted on the chunk
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(rec2.errors).toEqual(['Murf TTS HTTP: no further audio within 10000ms']));
      expect(rec2.done).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MurfTtsProvider (falcon, HTTP): barge-in and billing', () => {
  it('cancel() mid-response stops audio, sends nothing queued, raises no done or error', async () => {
    let held!: Req;
    handler = (r) => {
      held = r;
      r.res.writeHead(200);
      r.res.write(constPcm(240, 1));
    };
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText(`${FIRST} `);
    await rec.waitAudio();
    stream.pushText(`${SECOND} `); // queued behind FIRST
    stream.pushText('A buffered tail');
    stream.cancel();
    held.res.write(constPcm(240, 2));
    await tick();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
    expect(requests).toHaveLength(1);
    // Billed for the request that went out, not for what was queued or buffered.
    expect(stream.billableCharacters?.()).toBe(FIRST.length);
  });

  it('cancel() before the response headers still bills the text Murf received', async () => {
    handler = () => {}; // never answers
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText(`${FIRST} `);
    await nextRequest(1);
    stream.cancel();
    await tick();
    expect(rec.errors).toEqual([]);
    expect(stream.billableCharacters?.()).toBe(FIRST.length);
  });

  it('cancel() inside the first audio callback drops everything after it', async () => {
    handler = (r) => {
      r.res.writeHead(200);
      r.res.write(constPcm(240, 1));
      setTimeout(() => r.res.end(constPcm(240, 2)), 20);
    };
    const rec = ttsRecorder();
    let stream!: Awaited<ReturnType<typeof provider.open>>;
    stream = await provider.open(fopts(), {
      ...rec.events,
      onAudio: (c) => {
        rec.events.onAudio(c);
        stream.cancel();
      },
    });
    stream.pushText('Hi.');
    stream.flush();
    await rec.waitAudio();
    await tick();
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('cancel() before any sentence completes sends nothing and bills nothing', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.pushText('Short. Half a sente');
    stream.cancel();
    stream.flush();
    await tick();
    expect(requests).toHaveLength(0);
    expect(stream.billableCharacters?.()).toBe(0);
    expect(rec.done).toBe(0);
  });

  it('close(), close(), cancel() is safe and silent', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(fopts(), rec.events);
    stream.close();
    stream.close();
    stream.cancel();
    await tick();
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WebSocket fake (Gen2)
// ---------------------------------------------------------------------------

let fake: FakeWsServer;

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: 'gen2',
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

describe('MurfTtsProvider (gen2, WebSocket): host and query', () => {
  it.each([
    ['gen2', US, 'gen2'],
    ['GEN2', US, 'gen2'],
    ['  Gen2 ', US, 'gen2'],
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

  it('MURF_WS_BASE overrides the WebSocket host (the seam the self-test uses)', async () => {
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

describe('MurfTtsProvider (gen2, WebSocket): voice_config', () => {
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

  it('defaults to en-US-natalie', async () => {
    const stream = await provider.open(opts(), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await voiceConfig(conn);
    expect(cfg.voice_config.voiceId).toBe('en-US-natalie');
    expect(cfg.voice_config.style).toBe('Conversational');
    stream.close();
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
    // [language, expected multi_native_locale]
    ['en-US', 'en-US'],
    ['en', 'en-US'], // bare code widened to the model's first locale for it
    ['as-IN', undefined], // Falcon-only locale Gen2 does not publish: dropped, not sent to be refused
    ['fi', 'fi-FI'], // Gen2-only language
    ['xx-YY', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('gen2 + language %j -> multi_native_locale %j', async (language, locale) => {
    const stream = await provider.open(opts({ language }), ttsRecorder().events);
    const conn = await fake.nextConnection();
    const cfg = await voiceConfig(conn);
    if (locale === undefined) expect(cfg.voice_config).not.toHaveProperty('multi_native_locale');
    else expect(cfg.voice_config.multi_native_locale).toBe(locale);
    stream.close();
  });
});

describe('MurfTtsProvider (gen2, WebSocket): text queueing', () => {
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

describe('MurfTtsProvider (gen2, WebSocket): audio down', () => {
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

describe('MurfTtsProvider (gen2, WebSocket): failures', () => {
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

describe('MurfTtsProvider (gen2, WebSocket): barge-in and teardown', () => {
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
