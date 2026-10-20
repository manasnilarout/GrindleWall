import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { GeminiTtsProvider } from '../../../src/providers/tts/GeminiTtsProvider.js';
import type { TtsOptions } from '../../../src/providers/types.js';
import { WAIT_MS } from './helpers/fake-ws.js';
import { FAKE_KEY, constPcm, leaksKey, rampPcm, ttsRecorder, wav } from './helpers/recorders.js';

/*
 * GeminiTtsProvider is plain `fetch`; `credentials.GEMINI_BASE_URL` points it
 * at a local node:http fake speaking generateContent / SSE.
 */

interface Req {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  res: http.ServerResponse;
}

let server: http.Server;
let base: string;
let requests: Req[];
let handler: (r: Req) => void;
let reqWaiters: Array<() => void>;
const provider = new GeminiTtsProvider();
const STREAMING = 'gemini-3.1-flash-tts-preview';
const ONESHOT = 'gemini-2.5-flash-preview-tts';

const opts = (o: Partial<TtsOptions> = {}): TtsOptions => ({
  model: STREAMING,
  voice: 'Zephyr',
  language: 'en-US',
  sampleRate: 24000,
  credentials: { GOOGLE_API_KEY: FAKE_KEY, GEMINI_BASE_URL: base },
  ...o,
});

const part = (pcm: Buffer, mimeType = 'audio/l16; rate=24000; channels=1') => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }],
});

const sse = (res: http.ServerResponse, obj: unknown, sep = '\n\n') => res.write(`data: ${JSON.stringify(obj)}${sep}`);

function nextRequest(n = requests.length + 1): Promise<Req> {
  return new Promise<Req>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no request arrived')), WAIT_MS);
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

beforeEach(async () => {
  requests = [];
  reqWaiters = [];
  handler = (r) => r.res.end('{}');
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
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta/models`;
});

afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('GeminiTtsProvider: request', () => {
  it('refuses to open without a key', async () => {
    await expect(provider.open(opts({ credentials: {} }), ttsRecorder().events)).rejects.toThrow(
      'GOOGLE_API_KEY is not set',
    );
  });

  it('pushText sends nothing; flush issues ONE request with all the text, trimmed', async () => {
    const rec = ttsRecorder();
    handler = (r) => r.res.end(JSON.stringify(part(constPcm(10, 1))));
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('  Hello ');
    stream.pushText('there, ');
    stream.pushText('friend.  ');
    expect(requests).toHaveLength(0);
    stream.flush();
    const r = await nextRequest();
    expect(r.body.contents).toEqual([{ parts: [{ text: 'Hello there, friend.' }] }]);
    await rec.waitDone();
    expect(requests).toHaveLength(1);
  });

  it('streaming model: POST :streamGenerateContent?alt=sse, key in x-goog-api-key, never in the URL', async () => {
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      r.res.end();
    };
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('Hi.');
    stream.flush();
    const r = await nextRequest();
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`/v1beta/models/${STREAMING}:streamGenerateContent?alt=sse`);
    expect(r.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.url).not.toContain(FAKE_KEY);
    await rec.waitDone();
  });

  it('one-shot models: POST :generateContent', async () => {
    handler = (r) => r.res.end('{}');
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('A full sentence.');
    stream.flush();
    const r = await nextRequest();
    expect(r.url).toBe(`/v1beta/models/${ONESHOT}:generateContent`);
    await rec.waitDone();
  });

  it('body: AUDIO modality, the prebuilt voice, and a listed languageCode', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ model: ONESHOT, voice: '  Kore ', language: 'hi-IN' }), rec.events);
    stream.pushText('Namaste.');
    stream.flush();
    const r = await nextRequest();
    expect(r.body).toEqual({
      contents: [{ parts: [{ text: 'Namaste.' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, languageCode: 'hi-IN' },
      },
    });
    await rec.waitDone();
  });

  it.each([['en'], ['en-ZA'], ['xx-YY'], [''], [undefined]])('language %j is dropped rather than risk a 400', async (language) => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ model: ONESHOT, language }), rec.events);
    stream.pushText('Text.');
    stream.flush();
    const r = await nextRequest();
    expect(r.body.generationConfig.speechConfig).not.toHaveProperty('languageCode');
    await rec.waitDone();
  });

  it('defaults: the streaming 3.1 model and the Kore voice', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ model: '', voice: undefined }), rec.events);
    stream.pushText('x');
    stream.flush();
    const r = await nextRequest();
    expect(r.url).toBe(`/v1beta/models/${STREAMING}:streamGenerateContent?alt=sse`);
    expect(r.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    await rec.waitDone();
  });

  it('an empty / whitespace-only turn is not a request: done immediately', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('   ');
    stream.flush();
    expect(rec.done).toBe(1);
    expect(requests).toHaveLength(0);
    expect(stream.billableCharacters?.()).toBe(0);
  });

  it('billableCharacters is 0 until the request goes out, then the trimmed length; text after flush is ignored', async () => {
    handler = (r) => r.res.end('{}');
    const rec = ttsRecorder();
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText(' twelve chars ');
    expect(stream.billableCharacters?.()).toBe(0);
    stream.flush();
    stream.pushText('more');
    expect(stream.billableCharacters?.()).toBe(12);
    await rec.waitDone();
    expect(requests[0].body.contents[0].parts[0].text).toBe('twelve chars');
  });

  it('barge-in before flush: nothing was sent, so nothing is billable', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('A whole reply that never ran.');
    stream.cancel();
    stream.flush();
    expect(stream.billableCharacters?.()).toBe(0);
    expect(requests).toHaveLength(0);
    expect(rec.done).toBe(0);
  });
});

describe('GeminiTtsProvider: SSE streaming', () => {
  it('emits the first audio frame before the response has finished', async () => {
    const rec = ttsRecorder();
    let res!: http.ServerResponse;
    handler = (r) => {
      res = r.res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, part(constPcm(480, 5)));
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('Hello.');
    stream.flush();
    await rec.waitAudio();
    expect(rec.done).toBe(0);
    sse(res, part(constPcm(480, 6)));
    res.end();
    await rec.waitDone();
    expect(rec.audio.map((a) => a.readInt16LE(0))).toEqual([5, 6]);
    expect(rec.errors).toEqual([]);
  });

  it('slices audio into 40 ms frames at opts.sampleRate', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(r.res, part(rampPcm(2400))); // 100 ms @ 24 kHz
      r.res.end();
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio.map((a) => a.length)).toEqual([1920, 1920, 960]);
    expect(Buffer.concat(rec.audio).equals(rampPcm(2400))).toBe(true);
  });

  it('parses the rate out of each part mimeType and resamples to 24 kHz (16 kHz part -> 1.5x samples)', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(r.res, part(constPcm(320, 77), 'audio/L16;codec=pcm;rate=16000'));
      sse(r.res, part(constPcm(480, 88), 'audio/l16; rate=24000; channels=1'));
      sse(r.res, part(constPcm(480, 99), 'audio/pcm')); // no rate: assumed 24 kHz
      r.res.end();
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio.map((a) => [a.length, a.readInt16LE(0)])).toEqual([
      [960, 77],
      [960, 88],
      [960, 99],
    ]);
  });

  it('resamples against opts.sampleRate: 24 kHz part at a 16 kHz boundary', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(r.res, part(constPcm(480, 12)));
      r.res.end();
    };
    const stream = await provider.open(opts({ sampleRate: 16000 }), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).length).toBe(640);
  });

  it('strips a WAV header from inlineData', async () => {
    const rec = ttsRecorder();
    const pcm = rampPcm(300);
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(r.res, part(wav(pcm)));
      r.res.end();
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(Buffer.concat(rec.audio).equals(pcm)).toBe(true);
  });

  it('copes with CRLF separators, events split across TCP writes, multi-line data, keep-alives and [DONE]', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      const json = JSON.stringify(part(constPcm(480, 1)));
      r.res.write(`data: ${json.slice(0, 20)}`);
      setImmediate(() => {
        r.res.write(`${json.slice(20)}\r\n\r\n`);
        r.res.write(': keep-alive\n\n');
        r.res.write('data: not-json\n\n');
        const j2 = JSON.stringify(part(constPcm(480, 2)));
        r.res.write(`data: ${j2.slice(0, 30)}\ndata: ${j2.slice(30)}\n\n`);
        r.res.write('data: [DONE]\n\n');
        r.res.end();
      });
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio.map((a) => a.readInt16LE(0))).toEqual([1, 2]);
    expect(rec.errors).toEqual([]);
  });

  it('an error object inside the stream fails the turn once', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(r.res, part(constPcm(10, 1)));
      sse(r.res, { error: { message: 'Internal error encountered.', code: 500 } });
      sse(r.res, part(constPcm(10, 2)));
      r.res.end();
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors).toEqual(['Gemini TTS: Internal error encountered.']);
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(1);
  });
});

describe('GeminiTtsProvider: one-shot', () => {
  it('decodes every audio part of the single body', async () => {
    const rec = ttsRecorder();
    handler = (r) =>
      r.res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'ignored' },
                  { inlineData: { mimeType: 'audio/l16; rate=24000', data: constPcm(10, 3).toString('base64') } },
                  { inlineData: { mimeType: 'audio/l16; rate=24000', data: constPcm(10, 4).toString('base64') } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      );
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('A full sentence.');
    stream.flush();
    await rec.waitDone();
    expect(rec.audio.map((a) => a.readInt16LE(0))).toEqual([3, 4]);
  });

  it('a blocked prompt names the block reason', async () => {
    const rec = ttsRecorder();
    handler = (r) => r.res.end(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors).toEqual(['Gemini TTS blocked the prompt (PROHIBITED_CONTENT)']);
  });

  it('HTTP 400 surfaces Google\'s error message and status, then done', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(400, { 'content-type': 'application/json' });
      r.res.end(JSON.stringify({ error: { code: 400, message: 'Model tried to generate text, but it should only be used for TTS', status: 'INVALID_ARGUMENT' } }));
    };
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('Hello there.');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors).toEqual(['Gemini TTS 400: Model tried to generate text, but it should only be used for TTS']);
    expect(rec.done).toBe(1);
  });

  it('an array-wrapped error envelope (streaming endpoints) is read too', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(429);
      r.res.end(JSON.stringify([{ error: { message: 'Resource exhausted' } }]));
    };
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors).toEqual(['Gemini TTS 429: Resource exhausted']);
  });

  it('a non-JSON error body is truncated to 200 chars; an empty one falls back to the status text', async () => {
    const rec = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(502);
      r.res.end('x'.repeat(500));
    };
    let stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors[0]).toBe(`Gemini TTS 502: ${'x'.repeat(200)}`);

    const rec2 = ttsRecorder();
    handler = (r) => {
      r.res.writeHead(503);
      r.res.end();
    };
    stream = await provider.open(opts(), rec2.events);
    stream.pushText('x');
    stream.flush();
    await rec2.waitDone();
    expect(rec2.errors[0]).toBe('Gemini TTS 503: Service Unavailable');
  });

  it('no error message carries the key — 401, 403 and an unreachable host', async () => {
    for (const status of [401, 403]) {
      const rec = ttsRecorder();
      handler = (r) => {
        r.res.writeHead(status);
        r.res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }));
      };
      const stream = await provider.open(opts(), rec.events);
      stream.pushText('x');
      stream.flush();
      await rec.waitDone();
      expect(rec.errors[0]).toContain(String(status));
      expect(leaksKey(rec.errors)).toBe(false);
    }
    const rec = ttsRecorder();
    const stream = await provider.open(
      opts({ credentials: { GOOGLE_API_KEY: FAKE_KEY, GEMINI_BASE_URL: 'http://127.0.0.1:1/v1beta/models' } }),
      rec.events,
    );
    stream.pushText('x');
    stream.flush();
    await rec.waitDone();
    expect(rec.errors.length).toBe(1);
    expect(leaksKey(rec.errors)).toBe(false);
  });
});

describe('GeminiTtsProvider: barge-in, teardown, watchdog', () => {
  it('cancel() mid-SSE stops audio at once, without done or error', async () => {
    const rec = ttsRecorder();
    let stream!: Awaited<ReturnType<typeof provider.open>>;
    let res!: http.ServerResponse;
    handler = (r) => {
      res = r.res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, part(rampPcm(2400))); // 3 frames
    };
    stream = await provider.open(opts(), {
      ...rec.events,
      onAudio: (c) => {
        rec.events.onAudio(c);
        stream.cancel();
      },
    });
    stream.pushText('x');
    stream.flush();
    await rec.waitAudio();
    // The rest of the same part is not emitted, and the connection is torn down.
    await once(res, 'close');
    expect(rec.audio).toHaveLength(1);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('cancel() while waiting on the response aborts the request and stays silent', async () => {
    const rec = ttsRecorder();
    let res!: http.ServerResponse;
    handler = (r) => {
      res = r.res; // never answers
    };
    const stream = await provider.open(opts({ model: ONESHOT }), rec.events);
    stream.pushText('x');
    stream.flush();
    await nextRequest();
    stream.cancel();
    await once(res, 'close');
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
    stream.close();
    stream.cancel();
  });

  it('close() is idempotent and silent before and after flush', async () => {
    const rec = ttsRecorder();
    const stream = await provider.open(opts(), rec.events);
    stream.close();
    stream.close();
    stream.pushText('x');
    stream.flush();
    expect(requests).toHaveLength(0);
    expect(rec.done).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  it('a stalled response is broken by the 30 s watchdog: error + done, and the request is aborted', async () => {
    const rec = ttsRecorder();
    let res!: http.ServerResponse;
    handler = (r) => {
      res = r.res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n'); // headers out, then the body stalls with the connection held
    };
    // Only the timer functions are faked; sockets and the HTTP exchange stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stream = await provider.open(opts(), rec.events);
    stream.pushText('x');
    stream.flush();
    await nextRequest();
    expect(rec.done).toBe(0);
    vi.advanceTimersByTime(29_999);
    expect(rec.done).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rec.errors).toEqual(['Gemini TTS produced no response within 30000ms']);
    expect(rec.done).toBe(1);
    vi.useRealTimers();
    await once(res, 'close'); // the abort reached the wire
    expect(rec.errors).toHaveLength(1);
    expect(rec.done).toBe(1);
  });
});
