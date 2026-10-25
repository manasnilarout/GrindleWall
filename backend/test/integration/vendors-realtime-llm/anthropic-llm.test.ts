/**
 * AnthropicLlmProvider against a local fake of `POST /v1/messages` (stream: true).
 *
 * Proves request building and SSE handling in this module. Says nothing about
 * what Anthropic accepts — the fake answers however these tests script it, and
 * the provider has never completed a live call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { AnthropicLlmProvider } from '../../../src/providers/llm/AnthropicLlmProvider.js';
import type { LlmMessage, LlmOptions, LlmUsage } from '../../../src/providers/types.js';
import { priceLeg } from '../../../src/pricing/rates.js';
import type { LegUsage } from '../../../src/shared/protocol.js';
import { byteSlices, deadPort, flushIo, startHttp, waitFor, writeEach, type FakeHttp } from './helpers.js';

const KEY = 'test-key-XYZ-anthropic';

let http: FakeHttp;
let base: string;

beforeEach(async () => {
  http = await startHttp();
  base = `http://127.0.0.1:${http.port}/v1`;
});
afterEach(async () => {
  await http.close();
});

const start = (usage: Record<string, unknown> = { input_tokens: 25, output_tokens: 1 }) =>
  JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage } });
const text = (t: string, index = 0) => JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
const msgDelta = (stop_reason = 'end_turn', usage: Record<string, unknown> = { output_tokens: 15 }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message_delta', delta: { stop_reason, stop_sequence: null, ...extra }, usage });
const STOP = JSON.stringify({ type: 'message_stop' });

/** Messages frames carry an `event:` line AND repeat the name in the payload's `type`. */
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
  model = 'claude-haiku-5-5@off',
  messages: LlmMessage[] = [{ role: 'user', content: 'hi' }],
  extra: Partial<LlmOptions> = {},
  credentials: Record<string, string | undefined> = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_LLM_BASE_URL: base },
): Promise<Run> {
  return new Promise((resolve) => {
    const r: Run = { deltas: [], full: '', errors: [], usage: [], order: [] };
    new AnthropicLlmProvider().stream({ model, credentials, ...extra }, messages, {
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

describe('AnthropicLlmProvider — request shape', () => {
  beforeEach(() => http.handle((_q, res) => sse(res, sseBody([start(), text('ok'), msgDelta(), STOP]))));

  it('POSTs JSON to {base}/messages with x-api-key + anthropic-version, and the key nowhere else', async () => {
    await run();
    const req = http.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.raw).not.toContain(KEY);
  });

  it('streams, always sends max_tokens, and carries the model without its variant', async () => {
    await run('claude-haiku-5-5@low');
    const body = http.requests[0].body;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('a caller-supplied maxTokens wins', async () => {
    await run(undefined, undefined, { maxTokens: 321 });
    expect(http.requests[0].body.max_tokens).toBe(321);
  });

  it('@off disables thinking and sends no effort', async () => {
    await run('claude-haiku-5-5@off');
    const body = http.requests[0].body;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect('output_config' in body).toBe(false);
  });

  it.each(['low', 'medium', 'high'])('@%s goes out as output_config.effort with thinking left adaptive', async (effort) => {
    await run(`claude-haiku-5-5@${effort}`);
    const body = http.requests[0].body;
    expect(body.output_config).toEqual({ effort });
    expect('thinking' in body).toBe(false);
  });

  it('@none is accepted as an alias of @off and never reaches the wire', async () => {
    await run('claude-haiku-5-5@none');
    expect(http.requests[0].body.thinking).toEqual({ type: 'disabled' });
    expect(http.requests[0].raw).not.toContain('"none"');
  });

  it('no suffix sends neither thinking nor output_config', async () => {
    await run('claude-haiku-5-5');
    const body = http.requests[0].body;
    expect('thinking' in body).toBe(false);
    expect('output_config' in body).toBe(false);
  });

  it('Haiku 4.5 never gets an effort or a thinking key, even with a variant', async () => {
    await run('claude-haiku-4-5@medium');
    const body = http.requests[0].body;
    expect(body.model).toBe('claude-haiku-4-5');
    expect('thinking' in body).toBe(false);
    expect('output_config' in body).toBe(false);
  });

  it('system is hoisted to the top level; the transcript keeps roles and order', async () => {
    await run(undefined, [
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Speak English.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    const body = http.requests[0].body;
    expect(body.system).toBe('Be brief.\n\nSpeak English.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('no system prompt sends no system key', async () => {
    await run();
    expect('system' in http.requests[0].body).toBe(false);
  });

  it('temperature is never sent, even when the caller asks', async () => {
    await run(undefined, undefined, { temperature: 0.2 });
    const body = http.requests[0].body;
    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
    expect('top_k' in body).toBe(false);
  });

  it("ANTHROPIC_BASE_URL (Claude Code's own variable) does not reroute the call", async () => {
    const port = await deadPort();
    const r = await run(undefined, undefined, {}, {
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_LLM_BASE_URL: base,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    });
    expect(r.errors).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });

  it('a missing key is reported asynchronously and makes no request', async () => {
    const r = await new Promise<string>((resolve) => {
      new AnthropicLlmProvider().stream(
        { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_LLM_BASE_URL: base } },
        [{ role: 'user', content: 'hi' }],
        { onDelta: () => {}, onDone: () => {}, onError: (e) => resolve(e.message) },
      );
    });
    expect(r).toBe('ANTHROPIC_API_KEY is not set');
    await flushIo();
    expect(http.requests).toHaveLength(0);
  });
});

describe('AnthropicLlmProvider — streaming', () => {
  it('delivers text deltas in order and finishes with usage then done', async () => {
    http.handle((_q, res) => sse(res, sseBody([start(), '{"type":"ping"}', text('Hello'), text(' world'), msgDelta(), STOP])));
    const r = await run();
    expect(r.deltas).toEqual(['Hello', ' world']);
    expect(r.full).toBe('Hello world');
    expect(r.order).toEqual(['delta', 'delta', 'usage', 'done']);
  });

  it('reassembles frames split at arbitrary byte offsets, including inside a multi-byte character', async () => {
    const body = sseBody([start(), text('नमस्ते'), text(' — done'), msgDelta(), STOP]);
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      void writeEach(res, byteSlices(body, 5)).then(() => res.end());
    });
    expect((await run()).full).toBe('नमस्ते — done');
  });

  it('accepts CRLF framing', async () => {
    const body = sseBody([start(), text('crlf'), msgDelta(), STOP]).replace(/\n/g, '\r\n');
    http.handle((_q, res) => sse(res, body));
    expect((await run()).full).toBe('crlf');
  });

  it('thinking and signature deltas never reach TTS', async () => {
    http.handle((_q, res) =>
      sse(
        res,
        sseBody([
          start(),
          '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret plan"}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBsig"}}',
          '{"type":"content_block_stop","index":0}',
          text('spoken', 1),
          msgDelta(),
          STOP,
        ]),
      ),
    );
    const r = await run('claude-haiku-5-5@low');
    expect(r.deltas).toEqual(['spoken']);
  });

  it('skips malformed data lines and empty text deltas', async () => {
    http.handle((_q, res) => sse(res, `data: {not json\n\n${sseBody([start(), text(''), text('ok'), msgDelta(), STOP])}`));
    const r = await run();
    expect(r.deltas).toEqual(['ok']);
    expect(r.errors).toEqual([]);
  });
});

describe('AnthropicLlmProvider — usage', () => {
  const usageFrom = async (startUsage: Record<string, unknown>, deltaUsage?: Record<string, unknown>) => {
    http.handle((_q, res) => sse(res, sseBody([start(startUsage), text('a'), msgDelta('end_turn', deltaUsage), STOP])));
    const r = await run();
    expect(r.usage).toHaveLength(1);
    return r.usage[0];
  };

  it('input from message_start, output from the cumulative message_delta', async () => {
    expect(await usageFrom({ input_tokens: 120, output_tokens: 1 }, { output_tokens: 30 })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: undefined,
    });
  });

  it('cache reads, which Anthropic reports OUTSIDE input_tokens, are folded into inputTokens', async () => {
    const u = await usageFrom({ input_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 1 }, { output_tokens: 20 });
    expect(u.inputTokens).toBe(1000);
    expect(u.cachedInputTokens).toBe(800);
  });

  it('cache writes are input too, but not cached input', async () => {
    const u = await usageFrom({ input_tokens: 10, cache_creation_input_tokens: 90, output_tokens: 1 });
    expect(u.inputTokens).toBe(100);
    expect(u.cachedInputTokens).toBeUndefined();
  });

  it('a later message_delta input count wins; null keeps the earlier value', async () => {
    const u = await usageFrom(
      { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
      { input_tokens: 12, cache_read_input_tokens: null, output_tokens: 7 },
    );
    expect(u).toEqual({ inputTokens: 17, outputTokens: 7, cachedInputTokens: 5 });
  });

  it('no usage anywhere means no onUsage call, not zeros', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([JSON.stringify({ type: 'message_start', message: { id: 'm' } }), text('a'), JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), STOP])),
    );
    expect((await run()).usage).toEqual([]);
  });

  it('prices end to end: 800 cached of 1000 in, 20 out on Haiku 5.5 short-prompt rates', async () => {
    const u = await usageFrom({ input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 1 }, { output_tokens: 20 });
    const leg: LegUsage = {
      leg: 'llm',
      providerId: 'anthropic-llm',
      modelId: 'claude-haiku-5-5@off',
      unit: 'tokens',
      inputUnits: u.inputTokens!,
      outputUnits: u.outputTokens!,
      cachedInputTokens: u.cachedInputTokens,
      source: 'vendor',
    } as LegUsage;
    const priced = priceLeg(leg);
    expect(priced.unpricedReason).toBeUndefined();
    // 200 x $0.10/M + 800 x $0.01/M + 20 x $0.50/M
    expect(priced.cost!.amountUsd).toBeCloseTo(200 * 0.1e-6 + 800 * 0.01e-6 + 20 * 0.5e-6, 12);
    expect(priced.cost!.currency).toBe('USD');
  });

  it('Haiku 4.5 prices at its own, 10x, rate', async () => {
    const leg = { leg: 'llm', providerId: 'anthropic-llm', modelId: 'claude-haiku-4-5', unit: 'tokens', inputUnits: 1_000_000, outputUnits: 0, source: 'vendor' } as LegUsage;
    expect(priceLeg(leg).cost!.amountUsd).toBeCloseTo(1, 8);
  });
});

describe('AnthropicLlmProvider — failures', () => {
  it("HTTP 400 surfaces Anthropic's message with the status, and closes the turn", async () => {
    http.handle((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: field required"}}');
    });
    const r = await run();
    expect(r.errors[0].message).toBe('Anthropic 400: max_tokens: field required');
    expect(r.order).toEqual(['error', 'done']);
    expect(r.full).toBe('');
  });

  it('HTTP 401 produces an error that does not contain the key', async () => {
    http.handle((_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    });
    const r = await run();
    expect(r.errors[0].message).toContain('401');
    noSecret(r);
  });

  it('HTTP 502 with an empty body falls back to the status text', async () => {
    http.handle((_q, res) => {
      res.writeHead(502);
      res.end();
    });
    expect((await run()).errors[0].message).toBe('Anthropic 502: Bad Gateway');
  });

  it('a mid-stream overloaded_error is surfaced; text and input usage so far are kept', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([start(), text('partial'), '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', text('x')])),
    );
    const r = await run();
    expect(r.errors.map((e) => e.message)).toEqual(['Anthropic: Overloaded']);
    expect(r.full).toBe('partial');
    expect(r.usage[0].inputTokens).toBe(25);
    expect(r.order.at(-1)).toBe('done');
  });

  it('a max_tokens stop is reported, and its text and usage are kept', async () => {
    http.handle((_q, res) => sse(res, sseBody([start(), text('cut'), msgDelta('max_tokens', { output_tokens: 40 }), STOP])));
    const r = await run();
    expect(r.errors[0].message).toBe('Anthropic stopped early: max_tokens');
    expect(r.full).toBe('cut');
    expect(r.usage[0].outputTokens).toBe(40);
  });

  it('a refusal is reported with its category', async () => {
    http.handle((_q, res) =>
      sse(res, sseBody([start(), msgDelta('refusal', { output_tokens: 2 }, { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }), STOP])),
    );
    expect((await run()).errors[0].message).toBe('Anthropic declined the request (cyber)');
  });

  it('a connection dropped mid-stream reports one error and keeps the partial text', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody([start(), text('half')]), () => setImmediate(() => res.destroy()));
    });
    const r = await run();
    expect(r.full).toBe('half');
    expect(r.errors).toHaveLength(1);
    expect(r.order.at(-1)).toBe('done');
    noSecret(r);
  });

  it('a refused connection reports an error without the key', async () => {
    const port = await deadPort();
    const r = await run(undefined, undefined, {}, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_LLM_BASE_URL: `http://127.0.0.1:${port}/v1` });
    expect(r.errors).toHaveLength(1);
    noSecret(r);
  });
});

describe('AnthropicLlmProvider — abort (barge-in)', () => {
  it('abort mid-stream stops deltas, raises nothing, fires no onDone and hangs up', async () => {
    http.handle((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody([start(), text('starting')]));
      const timer = setInterval(() => res.write(sseBody([text(' more')])), 5);
      res.on('close', () => clearInterval(timer));
    });
    const deltas: string[] = [];
    const calls: string[] = [];
    const handle = new AnthropicLlmProvider().stream(
      { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_LLM_BASE_URL: base } },
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

  it('abort called from inside onDelta stops further deltas and fires no onDone', async () => {
    http.handle((_q, res) => sse(res, sseBody([start(), text('a'), text('b'), msgDelta(), STOP])));
    const calls: string[] = [];
    let handle!: { abort(): void };
    handle = new AnthropicLlmProvider().stream(
      { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_LLM_BASE_URL: base } },
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
