/**
 * OpenAiLlmProvider against a local fake of `POST /v1/responses` (stream: true).
 *
 * Proves request building and SSE handling in this module. Says nothing about
 * what OpenAI accepts — the fake answers however these tests script it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { OpenAiLlmProvider } from '../../../src/providers/llm/OpenAiLlmProvider.js';
import type { LlmMessage, LlmOptions, LlmUsage } from '../../../src/providers/types.js';
import { byteSlices, deadPort, flushIo, startHttp, waitFor, writeEach, type FakeHttp } from './helpers.js';

const KEY = 'test-key-XYZ-openai';

let http: FakeHttp;
let base: string;

beforeEach(async () => {
  http = await startHttp();
  base = `http://127.0.0.1:${http.port}/v1`;
});
afterEach(async () => {
  await http.close();
});

const delta = (text: string) =>
  JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text });
const completed = (usage?: Record<string, unknown>) =>
  JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', ...(usage ? { usage } : {}) } });
/** Responses frames carry an `event:` line AND repeat the name in the payload's `type`. */
const sseBody = (frames: string[]) =>
  frames
    .map((f) => {
      let type: string | undefined;
      try {
        type = (JSON.parse(f) as { type?: string }).type;
      } catch {
        /* raw */
      }
      return `${type ? `event: ${type}\n` : ''}data: ${f}\n\n`;
    })
    .join('');

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
  model = 'gpt-5.6-luna@none',
  messages: LlmMessage[] = [{ role: 'user', content: 'hi' }],
  extra: Partial<LlmOptions> = {},
  credentials: Record<string, string | undefined> = { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: base },
): Promise<Run> {
  return new Promise((resolve) => {
    const r: Run = { deltas: [], full: '', errors: [], usage: [], order: [] };
    new OpenAiLlmProvider().stream({ model, credentials, ...extra }, messages, {
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

describe('OpenAiLlmProvider — request shape', () => {
  beforeEach(() => http.handle((_q, res) => sse(res, sseBody([delta('ok'), completed()]))));

  it('POSTs JSON to {base}/responses with a bearer header and the key nowhere else', async () => {
    await run();
    const req = http.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/responses');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.url).not.toContain(KEY);
    expect(req.raw).not.toContain(KEY);
  });

  it('streams, opts out of server-side storage, and carries the model without its variant', async () => {
    await run('gpt-5.4-nano@xhigh');
    const body = http.requests[0].body;
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.model).toBe('gpt-5.4-nano');
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('@%s goes out verbatim as reasoning.effort', async (effort) => {
    await run(`gpt-5.6-sol@${effort}`);
    expect(http.requests[0].body.reasoning).toEqual({ effort });
  });

  it('@off is the repo alias and is rewritten to none before the wire', async () => {
    await run('gpt-5.6-terra@off');
    expect(http.requests[0].body.reasoning).toEqual({ effort: 'none' });
    expect(http.requests[0].raw).not.toContain('"off"');
  });

  it('no suffix sends no reasoning key, so the model default stands', async () => {
    await run('gpt-5.6-luna');
    expect('reasoning' in http.requests[0].body).toBe(false);
    expect(http.requests[0].body.model).toBe('gpt-5.6-luna');
  });

  it('an empty suffix (`model@`) sends no reasoning key', async () => {
    await run('gpt-5.6-luna@');
    expect('reasoning' in http.requests[0].body).toBe(false);
    expect(http.requests[0].body.model).toBe('gpt-5.6-luna');
  });

  it.each(['gpt-4o-mini@medium', 'gpt-4.1-mini@low', 'gpt-4-turbo@high', 'gpt-3.5-turbo@low', 'chatgpt-4o-latest@none'])(
    'documented non-reasoning model %s never gets a reasoning key, but still loses the suffix',
    async (id) => {
      await run(id);
      const body = http.requests[0].body;
      expect('reasoning' in body).toBe(false);
      expect(body.model).toBe(id.split('@')[0]);
    },
  );

  it('hoists system messages into `instructions` and keeps the transcript in order', async () => {
    await run('gpt-5.6-luna@low', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'Use English.' },
      { role: 'user', content: 'second' },
    ]);
    const body = http.requests[0].body;
    expect(body.instructions).toBe('Be brief.\n\nUse English.');
    expect(body.input).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('omits instructions with no system message', async () => {
    await run();
    expect('instructions' in http.requests[0].body).toBe(false);
  });

  it('temperature and max_output_tokens only when asked, including 0', async () => {
    await run();
    expect('temperature' in http.requests[0].body).toBe(false);
    expect('max_output_tokens' in http.requests[0].body).toBe(false);
    await run('gpt-4.1-mini', undefined, { temperature: 0, maxTokens: 50 });
    expect(http.requests[1].body.temperature).toBe(0);
    expect(http.requests[1].body.max_output_tokens).toBe(50);
  });

  it('reads key and base from opts.credentials, never process.env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/never');
    const r = await run();
    expect(r.errors).toEqual([]);
    expect(http.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a missing key is reported asynchronously after the handle is returned, with no request', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key-must-not-be-used');
    const order: string[] = [];
    const err = await new Promise<Error>((resolve) => {
      new OpenAiLlmProvider().stream(
        { model: 'gpt-5.6-luna@none', credentials: { OPENAI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: () => {}, onDone: () => order.push('done'), onError: resolve },
      );
      order.push('handle');
    });
    expect(order).toEqual(['handle']);
    expect(err.message).toContain('OPENAI_API_KEY');
    await flushIo();
    expect(http.requests).toHaveLength(0);
  });
});

describe('OpenAiLlmProvider — streaming', () => {
  it('streams deltas in order and onDone gets the whole answer', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta('Hello'), delta(' world'), delta('!'), completed()])));
    const r = await run();
    expect(r.deltas).toEqual(['Hello', ' world', '!']);
    expect(r.full).toBe('Hello world!');
    expect(r.errors).toEqual([]);
  });

  it('emits the first delta before the response ends', async () => {
    let finish!: () => void;
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody([delta('early')]));
      finish = () => res.end(sseBody([delta(' late'), completed()]));
    });
    const deltas: string[] = [];
    const done = new Promise<string>((resolve) =>
      new OpenAiLlmProvider().stream(
        { model: 'gpt-5.6-luna@none', credentials: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: (t) => deltas.push(t), onDone: resolve, onError: () => {} },
      ),
    );
    await waitFor(() => deltas.length === 1, 'first delta');
    finish();
    expect(await done).toBe('early late');
  });

  it('reassembles frames split every 5 bytes across TCP writes, including mid-codepoint', async () => {
    const body = sseBody([delta('héllo '), delta('世界 '), delta('🎙️'), completed()]);
    http.handle(async (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      await writeEach(res, byteSlices(body, 5));
      res.end();
    });
    const r = await run();
    expect(r.full).toBe('héllo 世界 🎙️');
  });

  it('handles CRLF framing, comments, keep-alives, id/retry lines and bare data:', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        ': keep-alive\n\n' +
          `event: response.output_text.delta\r\nid: 7\r\ndata:${delta('a')}\r\n\r\n` +
          ':\n\n' +
          `retry: 5\ndata: ${delta('b')}\n\n` +
          `data: ${completed()}\n\n`,
      );
    });
    const r = await run();
    expect(r.deltas).toEqual(['a', 'b']);
    expect(r.errors).toEqual([]);
  });

  it('dispatches on the payload `type`, not on the `event:` line', async () => {
    http.handle((_q, res) => sse(res, `event: response.completed\ndata: ${delta('typed')}\n\ndata: ${completed()}\n\n`));
    const r = await run();
    expect(r.full).toBe('typed');
  });

  it('never speaks lifecycle events, reasoning summaries, refusal or done-echo events', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          JSON.stringify({ type: 'response.created', response: { id: 'r', status: 'in_progress' } }),
          JSON.stringify({ type: 'response.in_progress', response: { id: 'r' } }),
          JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'internal reasoning' }),
          JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } }),
          delta('spoken'),
          JSON.stringify({ type: 'response.output_text.done', text: 'spoken' }),
          JSON.stringify({ type: 'response.content_part.done', part: { type: 'output_text', text: 'spoken' } }),
          completed(),
        ]),
      ),
    );
    const r = await run('gpt-5.6-luna@high');
    expect(r.deltas).toEqual(['spoken']);
    expect(r.full).toBe('spoken');
  });

  it('an empty delta is not emitted', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta(''), delta('x'), completed()])));
    const r = await run();
    expect(r.deltas).toEqual(['x']);
  });

  it('skips a malformed JSON line and a [DONE] sentinel', async () => {
    http.handle((_q, res) => sse(res, `data: ${delta('a')}\n\ndata: {"type": oops\n\ndata: ${delta('b')}\n\ndata: [DONE]\n\n`));
    const r = await run();
    expect(r.full).toBe('ab');
    expect(r.errors).toEqual([]);
  });

  it('a stream that ends with no response.completed still closes the turn cleanly', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta('only')])));
    const r = await run();
    expect(r.full).toBe('only');
    expect(r.errors).toEqual([]);
    expect(r.usage).toEqual([]);
  });
});

describe('OpenAiLlmProvider — usage', () => {
  const usage = (input: number, output: number, reasoning?: number, cached?: number) => ({
    input_tokens: input,
    ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
    output_tokens: output,
    ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
    total_tokens: input + output,
  });

  it('passes OpenAI counts straight through — reasoning is already inside output_tokens', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta('a'), completed(usage(75, 1186, 1024))])));
    const r = await run('gpt-5.6-luna@high');
    expect(r.usage).toEqual([{ inputTokens: 75, outputTokens: 1186, thinkingTokens: 1024, cachedInputTokens: undefined }]);
    expect(r.order).toEqual(['delta', 'usage', 'done']);
  });

  it('cached tokens stay inside inputTokens', async () => {
    http.handle((_q, res) => sse(res, sseBody([completed(usage(1000, 20, undefined, 800))])));
    const [u] = (await run()).usage;
    expect(u.inputTokens).toBe(1000);
    expect(u.cachedInputTokens).toBe(800);
  });

  it('zero reasoning / zero cached are absences', async () => {
    http.handle((_q, res) => sse(res, sseBody([completed(usage(10, 10, 0, 0))])));
    const [u] = (await run()).usage;
    expect(u.thinkingTokens).toBeUndefined();
    expect(u.cachedInputTokens).toBeUndefined();
  });

  it('usage before the terminal frame is ignored; only response.completed counts', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          JSON.stringify({ type: 'response.in_progress', response: { usage: usage(1, 1) } }),
          delta('a'),
          completed(usage(5, 3)),
        ]),
      ),
    );
    const r = await run();
    expect(r.usage).toEqual([expect.objectContaining({ inputTokens: 5, outputTokens: 3 })]);
  });

  it('no usage on the terminal frame means no usage call', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta('a'), completed()])));
    expect((await run()).usage).toEqual([]);
  });

  it('a response.incomplete is billed, reported, and keeps its text', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          delta('cut off'),
          JSON.stringify({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: usage(10, 40) },
          }),
        ]),
      ),
    );
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual(['OpenAI stopped early: max_output_tokens']);
    expect(r.full).toBe('cut off');
    expect(r.usage).toEqual([expect.objectContaining({ outputTokens: 40 })]);
    expect(r.order).toEqual(['delta', 'error', 'usage', 'done']);
  });

  it('a response.incomplete with no reason still says it was incomplete', async () => {
    http.handle((_q, res) => sse(res, sseBody([JSON.stringify({ type: 'response.incomplete', response: {} })])));
    const r = await run();
    expect(r.errors[0].message).toBe('OpenAI stopped early: incomplete');
  });

  it('a response.failed is surfaced AND its usage is still billed', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          delta('some'),
          JSON.stringify({
            type: 'response.failed',
            response: { status: 'failed', error: { code: 'server_error', message: 'slow down' }, usage: usage(12, 2) },
          }),
          delta('never'),
        ]),
      ),
    );
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual(['OpenAI: slow down']);
    expect(r.full).toBe('some');
    expect(r.usage).toEqual([expect.objectContaining({ inputTokens: 12, outputTokens: 2 })]);
    expect(r.order).toEqual(['delta', 'error', 'usage', 'done']);
  });

  it('a response.failed with no message has a generic one', async () => {
    http.handle((_q, res) => sse(res, sseBody([JSON.stringify({ type: 'response.failed', response: { error: null } })])));
    expect((await run()).errors[0].message).toBe('OpenAI: response failed');
  });
});

describe('OpenAiLlmProvider — failures', () => {
  it('HTTP 400 surfaces OpenAI\'s message with the status, and closes the turn', async () => {
    http.handle((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Unsupported value: \'reasoning.effort\' does not support \'max\'","type":"invalid_request_error"}}');
    });
    const r = await run('gpt-5.4-nano@max');
    expect(r.errors[0].message).toBe("OpenAI 400: Unsupported value: 'reasoning.effort' does not support 'max'");
    expect(r.order).toEqual(['error', 'done']);
    expect(r.full).toBe('');
  });

  it('HTTP 401 produces an error that does not contain the key', async () => {
    http.handle((_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Incorrect API key provided: test-****-XYZ.","type":"invalid_request_error","code":"invalid_api_key"}}');
    });
    const r = await run();
    expect(r.errors[0].message).toContain('401');
    noSecret(r);
  });

  it('HTTP 500 with a non-JSON body quotes it, truncated to 200 characters', async () => {
    http.handle((_q, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream exploded ' + 'z'.repeat(500));
    });
    const r = await run();
    expect(r.errors[0].message.startsWith('OpenAI 500: upstream exploded')).toBe(true);
    expect(r.errors[0].message.length).toBeLessThanOrEqual('OpenAI 500: '.length + 200);
  });

  it('HTTP 502 with an empty body falls back to the status text', async () => {
    http.handle((_q, res) => {
      res.writeHead(502);
      res.end();
    });
    expect((await run()).errors[0].message).toBe('OpenAI 502: Bad Gateway');
  });

  it('a JSON error body with no message falls back to the status text', async () => {
    http.handle((_q, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{}}');
    });
    expect((await run()).errors[0].message).toBe('OpenAI 429: Too Many Requests');
  });

  it('a mid-stream `error` frame is surfaced and the text so far is kept', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([delta('partial'), JSON.stringify({ type: 'error', code: 'server_error', message: 'the server had an error' }), delta('x')])),
    );
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual(['OpenAI: the server had an error']);
    expect(r.full).toBe('partial');
  });

  it('an `error` frame with only a code uses the code', async () => {
    http.handle((_q, res) => sse(res, sseBody([JSON.stringify({ type: 'error', code: 'rate_limit_exceeded' })])));
    expect((await run()).errors[0].message).toBe('OpenAI: rate_limit_exceeded');
  });

  it('a connection dropped mid-stream reports one error and keeps the partial text', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody([delta('half')]), () => setImmediate(() => res.destroy()));
    });
    const r = await run();
    expect(r.full).toBe('half');
    expect(r.errors).toHaveLength(1);
    expect(r.order.at(-1)).toBe('done');
    noSecret(r);
  });

  it('a refused connection reports an error without the key', async () => {
    const port = await deadPort();
    const r = await run('gpt-5.6-luna@none', undefined, {}, { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` });
    expect(r.errors).toHaveLength(1);
    noSecret(r);
  });
});

describe('OpenAiLlmProvider — abort (barge-in)', () => {
  it('abort mid-stream stops deltas, raises nothing, fires no onDone and hangs up', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody([delta('starting')]));
      const timer = setInterval(() => res.write(sseBody([delta(' more')])), 5);
      res.on('close', () => clearInterval(timer));
    });
    const deltas: string[] = [];
    const calls: string[] = [];
    const handle = new OpenAiLlmProvider().stream(
      { model: 'gpt-5.6-luna@none', credentials: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: base } },
      [{ role: 'user', content: 'hi' }],
      {
        onDelta: (t) => deltas.push(t),
        onUsage: () => calls.push('usage'),
        onDone: () => calls.push('done'),
        onError: (e) => calls.push(`error:${e.message}`),
      },
    );
    await waitFor(() => deltas.length >= 3, 'a few deltas');
    handle.abort();
    const atAbort = deltas.length;
    await waitFor(() => http.closedResponses === 1, 'client hang-up');
    await flushIo();
    expect(deltas.length).toBe(atAbort);
    expect(calls).toEqual([]);
  });

  it('abort before headers is silent', async () => {
    let release!: () => void;
    http.handle((_q, res) => {
      release = () => sse(res, sseBody([delta('late'), completed()]));
    });
    const calls: string[] = [];
    const handle = new OpenAiLlmProvider().stream(
      { model: 'gpt-5.6-luna@none', credentials: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: base } },
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => calls.push('delta'), onDone: () => calls.push('done'), onError: () => calls.push('error') },
    );
    await waitFor(() => http.requests.length === 1, 'request');
    handle.abort();
    handle.abort();
    await waitFor(() => http.closedResponses === 1, 'client hang-up');
    release();
    await flushIo();
    expect(calls).toEqual([]);
  });

  /*
   * Was a bug (same as GeminiLlmProvider): an abort issued synchronously from a
   * callback kept delivering the buffered events and then fired onUsage +
   * onDone. sseChunks now re-checks the signal per event, and run() returns
   * without reporting when the loop ended because of an abort.
   */
  it('abort called from inside onDelta stops further deltas and fires no onDone', async () => {
    http.handle((_q, res) => sse(res, sseBody([delta('a'), delta('b'), completed({ input_tokens: 1, output_tokens: 1 })])));
    const calls: string[] = [];
    let handle!: { abort(): void };
    handle = new OpenAiLlmProvider().stream(
      { model: 'gpt-5.6-luna@none', credentials: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: base } },
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
