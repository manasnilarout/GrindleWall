/**
 * GeminiLlmProvider against a local fake of `:streamGenerateContent?alt=sse`.
 *
 * Proves request building and SSE handling in this module. Says nothing about
 * what Google accepts — the fake answers however these tests script it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { GeminiLlmProvider } from '../../../src/providers/llm/GeminiLlmProvider.js';
import type { LlmMessage, LlmOptions, LlmUsage } from '../../../src/providers/types.js';
import { byteSlices, deadPort, flushIo, startHttp, waitFor, writeEach, type FakeHttp } from './helpers.js';

const KEY = 'test-key-XYZ-gemini';

let http: FakeHttp;
let base: string;

beforeEach(async () => {
  http = await startHttp();
  base = `http://127.0.0.1:${http.port}/v1beta/models`;
});
afterEach(async () => {
  await http.close();
});

const textFrame = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }] });
const usageFrame = (u: Record<string, number>) => JSON.stringify({ usageMetadata: u });
const sseBody = (frames: string[]) => frames.map((f) => `data: ${f}\n\n`).join('');

function sse(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

interface Run {
  deltas: string[];
  full: string;
  errors: Error[];
  usage: LlmUsage[];
  order: string[];
}

function run(
  model = 'gemini-3.8-flash@off',
  messages: LlmMessage[] = [{ role: 'user', content: 'hi' }],
  extra: Partial<LlmOptions> = {},
  credentials: Record<string, string | undefined> = { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base },
): Promise<Run> {
  return new Promise((resolve) => {
    const r: Run = { deltas: [], full: '', errors: [], usage: [], order: [] };
    new GeminiLlmProvider().stream({ model, credentials, ...extra }, messages, {
      onDelta: (t) => {
        r.deltas.push(t);
        r.order.push('delta');
      },
      onUsage: (u) => {
        r.usage.push(u);
        r.order.push('usage');
      },
      onError: (e) => {
        r.errors.push(e);
        r.order.push('error');
      },
      onDone: (full) => {
        r.full = full;
        r.order.push('done');
        resolve(r);
      },
    });
  });
}

const noSecret = (r: Run) => {
  for (const e of r.errors) {
    expect(e.message).not.toContain(KEY);
    expect(e.stack ?? '').not.toContain(KEY);
  }
};

describe('GeminiLlmProvider — request shape', () => {
  beforeEach(() => http.handle((_q, res) => sse(res, sseBody([textFrame('ok')]))));

  it('POSTs to {base}/{model}:streamGenerateContent?alt=sse with the variant stripped', async () => {
    await run('gemini-3.5-flash-lite@minimal');
    const req = http.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('sends the key ONLY as x-goog-api-key — never in the URL, never as a bearer token', async () => {
    await run();
    const req = http.requests[0];
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    expect(req.url).not.toContain('key=');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.raw).not.toContain(KEY);
  });

  it('URL-encodes the model id', async () => {
    await run('tuned/my model@off');
    expect(http.requests[0].url).toBe('/v1beta/models/tuned%2Fmy%20model:streamGenerateContent?alt=sse');
  });

  it.each([
    ['gemini-3.6-flash@minimal', { thinkingLevel: 'minimal' }],
    ['gemini-3.5-flash@low', { thinkingLevel: 'low' }],
    ['gemini-3.5-flash@medium', { thinkingLevel: 'medium' }],
    ['gemini-3.1-flash-lite@high', { thinkingLevel: 'high' }],
    ['gemini-3.8-flash@off', { thinkingBudget: 0 }],
  ])('%s maps to exactly one thinkingConfig field %j', async (model, expected) => {
    await run(model);
    const gc = http.requests[0].body.generationConfig;
    expect(gc.thinkingConfig).toEqual(expected);
    // Never at the generationConfig root, which the live API rejects.
    expect(gc.thinkingLevel).toBeUndefined();
    expect(gc.thinkingBudget).toBeUndefined();
  });

  it('a bare model id (no @variant) defaults to thinking off', async () => {
    await run('gemini-3.8-flash');
    expect(http.requests[0].url).toContain('/gemini-3.8-flash:streamGenerateContent');
    expect(http.requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('an empty model before the @ falls back to the default model', async () => {
    await run('@low');
    expect(http.requests[0].url).toContain('/gemini-3.8-flash:streamGenerateContent');
    expect(http.requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('splits on the LAST @, so an @ inside the model id survives', async () => {
    await run('a@b@high');
    expect(http.requests[0].url).toContain('/a%40b:streamGenerateContent');
    expect(http.requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
  });

  it('hoists every system message into systemInstruction, joined by a blank line', async () => {
    await run('gemini-3.8-flash@off', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'first' },
      { role: 'system', content: 'Speak Hindi.' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    const body = http.requests[0].body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.\n\nSpeak Hindi.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'reply' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
  });

  it('omits systemInstruction entirely when there is no system message', async () => {
    await run();
    expect('systemInstruction' in http.requests[0].body).toBe(false);
  });

  it('omits temperature and maxOutputTokens unless asked, and sends 0 when 0 is asked', async () => {
    await run();
    let gc = http.requests[0].body.generationConfig;
    expect('temperature' in gc).toBe(false);
    expect('maxOutputTokens' in gc).toBe(false);

    await run('gemini-3.8-flash@off', undefined, { temperature: 0, maxTokens: 64 });
    gc = http.requests[1].body.generationConfig;
    expect(gc.temperature).toBe(0);
    expect(gc.maxOutputTokens).toBe(64);
  });

  it('reads the key and base URL from opts.credentials, never process.env', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('GEMINI_BASE_URL', 'http://127.0.0.1:1/never');
    const r = await run('gemini-3.8-flash@off', undefined, {}, { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base });
    expect(r.errors).toEqual([]);
    expect(http.requests[0].headers['x-goog-api-key']).toBe(KEY);
  });

  it('with no key in credentials reports asynchronously, returns a handle first, and makes no request', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-key-must-not-be-used');
    const order: string[] = [];
    const err = await new Promise<Error>((resolve) => {
      const handle = new GeminiLlmProvider().stream(
        { model: 'gemini-3.8-flash@off', credentials: { GEMINI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: () => {}, onDone: () => order.push('done'), onError: (e) => resolve(e) },
      );
      order.push('handle');
      expect(typeof handle.abort).toBe('function');
    });
    expect(order[0]).toBe('handle');
    expect(err.message).toContain('GOOGLE_API_KEY');
    await flushIo();
    expect(http.requests).toHaveLength(0);
  });
});

describe('GeminiLlmProvider — streaming', () => {
  it('streams deltas in order and onDone carries the concatenation', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('Hello'), textFrame(' world'), textFrame('!', { finishReason: 'STOP' })])));
    const r = await run();
    expect(r.deltas).toEqual(['Hello', ' world', '!']);
    expect(r.full).toBe('Hello world!');
    expect(r.errors).toEqual([]);
  });

  it('emits the first delta before the response has finished (streams, does not buffer)', async () => {
    let finish!: () => void;
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${textFrame('early')}\n\n`);
      finish = () => res.end(`data: ${textFrame(' late')}\n\n`);
    });
    const deltas: string[] = [];
    const done = new Promise<string>((resolve) =>
      new GeminiLlmProvider().stream(
        { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: (t) => deltas.push(t), onDone: resolve, onError: () => {} },
      ),
    );
    await waitFor(() => deltas.length === 1, 'first delta');
    expect(deltas).toEqual(['early']);
    finish();
    expect(await done).toBe('early late');
  });

  it('reassembles frames split at every byte offset across TCP writes, including mid-UTF-8', async () => {
    const body = sseBody([textFrame('नमस्ते'), textFrame(' 🙂 '), textFrame('done')]);
    http.handle(async (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await writeEach(res, byteSlices(body, 3));
      res.end();
    });
    const r = await run();
    expect(r.full).toBe('नमस्ते 🙂 done');
    expect(r.errors).toEqual([]);
  });

  it('accepts CRLF framing, `data:` with no space, comments, event: and id: lines, and keep-alives', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        ': keep-alive\r\n\r\n' +
          `id: 1\r\nevent: message\r\ndata:${textFrame('a')}\r\n\r\n` +
          ':ping\n\n' +
          `data: ${textFrame('b')}\n\n` +
          '\n\n' +
          `retry: 1000\ndata: ${textFrame('c')}\n\n`,
      );
    });
    const r = await run();
    expect(r.deltas).toEqual(['a', 'b', 'c']);
    expect(r.errors).toEqual([]);
  });

  it('joins a JSON payload spread over several data: lines', async () => {
    const json = textFrame('multi-line');
    const half = Math.floor(json.length / 2);
    http.handle((_q, res) => sse(res, `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}\n\n`));
    const r = await run();
    expect(r.full).toBe('multi-line');
  });

  it('skips a malformed JSON line and keeps going', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('before'), '{"candidates": [ broken', textFrame(' after')])));
    const r = await run();
    expect(r.full).toBe('before after');
    expect(r.errors).toEqual([]);
  });

  it('ignores a stray [DONE] sentinel', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('x'), '[DONE]'])));
    const r = await run();
    expect(r.full).toBe('x');
    expect(r.errors).toEqual([]);
  });

  it('drops an unterminated trailing event at EOF, as the SSE spec requires', async () => {
    http.handle((_q, res) => sse(res, `data: ${textFrame('kept')}\n\ndata: ${textFrame(' dropped')}`));
    const r = await run();
    expect(r.full).toBe('kept');
  });

  it('never speaks thought parts, and skips text-less parts', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'internal reasoning', thought: true },
                    { functionCall: { name: 'f' } },
                    { text: '' },
                    { text: 'spoken' },
                  ],
                },
              },
            ],
          }),
        ]),
      ),
    );
    const r = await run('gemini-3.5-flash@high');
    expect(r.deltas).toEqual(['spoken']);
    expect(r.full).toBe('spoken');
  });

  it('a frame with no candidates (usage-only) produces no delta', async () => {
    http.handle((_q, res) => sse(res, sseBody([usageFrame({ promptTokenCount: 1, candidatesTokenCount: 1 }), textFrame('t')])));
    const r = await run();
    expect(r.deltas).toEqual(['t']);
  });
});

describe('GeminiLlmProvider — usage', () => {
  it('reports vendor counts once, after the last delta and before onDone', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([textFrame('a'), usageFrame({ promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 })])),
    );
    const r = await run();
    expect(r.usage).toEqual([{ inputTokens: 120, outputTokens: 30, thinkingTokens: undefined, cachedInputTokens: undefined }]);
    expect(r.order).toEqual(['delta', 'usage', 'done']);
  });

  it('folds thoughtsTokenCount into outputTokens and keeps it as a breakdown', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([textFrame('a'), usageFrame({ promptTokenCount: 13, candidatesTokenCount: 27, thoughtsTokenCount: 308 })])),
    );
    const [u] = (await run('gemini-3.5-flash-lite@high')).usage;
    expect(u.outputTokens).toBe(335);
    expect(u.thinkingTokens).toBe(308);
    expect(u.outputTokens!).toBeGreaterThanOrEqual(u.thinkingTokens!);
    expect(u.inputTokens).toBe(13);
  });

  it('keeps cached tokens inside inputTokens', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([usageFrame({ promptTokenCount: 1000, candidatesTokenCount: 20, cachedContentTokenCount: 800 })])),
    );
    const [u] = (await run()).usage;
    expect(u.inputTokens).toBe(1000);
    expect(u.cachedInputTokens).toBe(800);
  });

  it('takes the LAST cumulative usageMetadata, not a sum', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          usageFrame({ promptTokenCount: 10, candidatesTokenCount: 5 }),
          textFrame('more'),
          usageFrame({ promptTokenCount: 10, candidatesTokenCount: 40, thoughtsTokenCount: 2 }),
        ]),
      ),
    );
    const r = await run();
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0]).toMatchObject({ inputTokens: 10, outputTokens: 42, thinkingTokens: 2 });
  });

  it('zero thinking and zero cached are absences, not breakdowns', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([usageFrame({ promptTokenCount: 4, candidatesTokenCount: 4, thoughtsTokenCount: 0, cachedContentTokenCount: 0 })])),
    );
    const [u] = (await run()).usage;
    expect(u.thinkingTokens).toBeUndefined();
    expect(u.cachedInputTokens).toBeUndefined();
  });

  it('missing candidatesTokenCount is reported as 0 output, prompt passed through', async () => {
    http.handle((_q, res) => sse(res, sseBody([usageFrame({ promptTokenCount: 9 })])));
    const [u] = (await run()).usage;
    expect(u).toMatchObject({ inputTokens: 9, outputTokens: 0 });
  });

  it('no usageMetadata at all means no usage call (the pipeline then estimates)', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('a')])));
    const r = await run();
    expect(r.usage).toEqual([]);
  });

  it('an events object without onUsage is tolerated', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('a'), usageFrame({ promptTokenCount: 1, candidatesTokenCount: 1 })])));
    const full = await new Promise<string>((resolve, reject) =>
      new GeminiLlmProvider().stream(
        { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: () => {}, onDone: resolve, onError: reject },
      ),
    );
    expect(full).toBe('a');
  });
});

describe('GeminiLlmProvider — failures', () => {
  it('HTTP 400 with Google\'s error envelope surfaces the vendor message and status, then closes the turn', async () => {
    http.handle((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"code":400,"message":"thinking_level minimal is not supported","status":"INVALID_ARGUMENT"}}');
    });
    const r = await run('gemini-3.7-flash@minimal');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toBe('Gemini 400: thinking_level minimal is not supported');
    expect(r.full).toBe('');
    expect(r.order).toEqual(['error', 'done']);
    noSecret(r);
  });

  it('accepts the error envelope in its array form', async () => {
    http.handle((_q, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('[{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}]');
    });
    const r = await run();
    expect(r.errors[0].message).toBe('Gemini 429: Resource has been exhausted');
  });

  it('a 5xx with a non-JSON body quotes at most 200 characters of it', async () => {
    http.handle((_q, res) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<html>' + 'x'.repeat(1000) + '</html>');
    });
    const r = await run();
    expect(r.errors[0].message.startsWith('Gemini 503: <html>')).toBe(true);
    expect(r.errors[0].message.length).toBeLessThanOrEqual('Gemini 503: '.length + 200);
  });

  it('a 4xx with an empty body falls back to the status text', async () => {
    http.handle((_q, res) => {
      res.writeHead(404);
      res.end();
    });
    const r = await run();
    expect(r.errors[0].message).toBe('Gemini 404: Not Found');
  });

  it('a 401 whose body says nothing about the key yields an error free of the key', async () => {
    http.handle((_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"code":401,"message":"API key not valid. Please pass a valid API key.","status":"UNAUTHENTICATED"}}');
    });
    const r = await run();
    expect(r.errors[0].message).toContain('API key not valid');
    noSecret(r);
  });

  it('an in-band error frame on a 200 stream is surfaced and the text so far is kept', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([textFrame('partial'), JSON.stringify({ error: { code: 500, message: 'Internal error encountered.' } }), textFrame('never')])),
    );
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual(['Gemini: Internal error encountered.']);
    expect(r.full).toBe('partial');
    expect(r.deltas).toEqual(['partial']);
  });

  it('a usage count carried on the failing frame is still reported', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([JSON.stringify({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 }, error: { message: 'boom' } })])),
    );
    const r = await run();
    expect(r.usage).toEqual([expect.objectContaining({ inputTokens: 7, outputTokens: 1 })]);
    expect(r.order).toEqual(['error', 'usage', 'done']);
  });

  it('a blocked prompt is surfaced with its reason', async () => {
    http.handle((_q, res) => sse(res, sseBody([JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })])));
    const r = await run();
    expect(r.errors[0].message).toBe('Gemini blocked the prompt (SAFETY)');
    expect(r.full).toBe('');
  });

  it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION'])('finishReason %s is reported but the text is kept', async (reason) => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('cut off', { finishReason: reason })])));
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual([`Gemini stopped early: ${reason}`]);
    expect(r.full).toBe('cut off');
  });

  it('a connection dropped mid-stream reports an error, keeps the partial text, and bills what was seen', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${textFrame('half')}\n\ndata: ${usageFrame({ promptTokenCount: 50, candidatesTokenCount: 10 })}\n\n`, () =>
        setImmediate(() => res.destroy()),
      );
    });
    const r = await run();
    expect(r.full).toBe('half');
    expect(r.errors).toHaveLength(1);
    expect(r.usage).toEqual([expect.objectContaining({ inputTokens: 50, outputTokens: 10 })]);
    noSecret(r);
  });

  it('a refused connection is reported without the key, and the turn still closes', async () => {
    const port = await deadPort();
    const r = await run('gemini-3.8-flash@off', undefined, {}, {
      GOOGLE_API_KEY: KEY,
      GEMINI_BASE_URL: `http://127.0.0.1:${port}/v1beta/models`,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.full).toBe('');
    noSecret(r);
  });
});

describe('GeminiLlmProvider — abort (barge-in)', () => {
  it('abort while the stream is open raises nothing, fires no onDone, and hangs up the request', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${textFrame('starting')}\n\n`);
      const timer = setInterval(() => res.write(`data: ${textFrame(' more')}\n\n`), 5);
      res.on('close', () => clearInterval(timer));
    });
    const deltas: string[] = [];
    const calls: string[] = [];
    const handle = new GeminiLlmProvider().stream(
      { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
      [{ role: 'user', content: 'hi' }],
      {
        onDelta: (t) => deltas.push(t),
        onUsage: () => calls.push('usage'),
        onDone: () => calls.push('done'),
        onError: (e) => calls.push(`error:${e.message}`),
      },
    );
    await waitFor(() => deltas.length >= 2, 'a few deltas');
    handle.abort();
    const atAbort = deltas.length;
    await waitFor(() => http.closedResponses === 1, 'the client to hang up');
    await flushIo();
    expect(deltas.length).toBe(atAbort);
    expect(calls).toEqual([]);
  });

  it('abort before the response headers arrive is silent', async () => {
    let release!: () => void;
    http.handle((_q, res) => {
      release = () => sse(res, sseBody([textFrame('late')]));
    });
    const calls: string[] = [];
    const handle = new GeminiLlmProvider().stream(
      { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => calls.push('delta'), onDone: () => calls.push('done'), onError: () => calls.push('error') },
    );
    await waitFor(() => http.requests.length === 1, 'the request');
    handle.abort();
    await waitFor(() => http.closedResponses === 1, 'the client to hang up');
    release();
    await flushIo();
    expect(calls).toEqual([]);
  });

  it('abort is idempotent and safe after completion', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('x')])));
    let handle!: { abort(): void };
    const done = new Promise<string>((resolve) => {
      handle = new GeminiLlmProvider().stream(
        { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: () => {}, onDone: resolve, onError: () => {} },
      );
    });
    expect(await done).toBe('x');
    expect(() => {
      handle.abort();
      handle.abort();
    }).not.toThrow();
  });

  /*
   * BUG (GeminiLlmProvider.ts sseChunks, ~line 190, and run(), ~line 145): the
   * abort signal is only checked at the top of the outer read loop, and the
   * loop's normal exit is not distinguished from completion. So an abort issued
   * from inside a callback — e.g. onDelta -> TTS pushText -> sync TTS error ->
   * PipelineSession.finishTurn -> abortLlm — keeps delivering every remaining
   * event already in the buffer, then reports usage and fires onDone as if the
   * stream had completed. "abort() must be immediate."
   */
  it.fails('abort called from inside onDelta stops further deltas and fires no onDone', async () => {
    http.handle((_q, res) => sse(res, sseBody([textFrame('a'), textFrame('b'), usageFrame({ promptTokenCount: 1, candidatesTokenCount: 1 })])));
    const calls: string[] = [];
    let handle!: { abort(): void };
    handle = new GeminiLlmProvider().stream(
      { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: KEY, GEMINI_BASE_URL: base } },
      [{ role: 'user', content: 'hi' }],
      {
        onDelta: (t) => {
          calls.push(`delta:${t}`);
          handle.abort();
        },
        onUsage: () => calls.push('usage'),
        onDone: () => calls.push('done'),
        onError: () => calls.push('error'),
      },
    );
    await waitFor(() => http.closedResponses === 1, 'response closed');
    await flushIo();
    expect(calls).toEqual(['delta:a']);
  });
});
