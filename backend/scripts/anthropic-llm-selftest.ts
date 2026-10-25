/**
 * Verifies AnthropicLlmProvider against a local fake that speaks the Messages
 * API's SSE dialect. Needs no API key and no network.
 *
 * WHAT THIS DOES NOT PROVE. The fake below was written from the same docs as the
 * provider and answers however this repo expects it to, so every check here is a
 * check on our parsing — not on what Anthropic accepts. As of 2026-10-25 the
 * provider has NEVER completed a live call (there is no ANTHROPIC_API_KEY in this
 * repo). A green run here is not evidence that a real request would succeed; the
 * live checks are `npm run models` and `scripts/smoke.mjs pipeline` with
 * LLM=anthropic-llm.
 *
 * It does cover the parts most likely to be wrong on our side: SSE framing
 * across chunk boundaries, keeping thinking deltas away from TTS, the `@variant`
 * suffix, translating Anthropic's disjoint cache counts into LlmUsage's
 * containment rule, stop reasons, error envelopes and abort.
 *
 *   npx tsx scripts/anthropic-llm-selftest.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { LlmMessage, LlmUsage } from '../src/providers/types.js';
import { AnthropicLlmProvider } from '../src/providers/llm/AnthropicLlmProvider.js';

type Scenario = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let scenario: Scenario = () => {};
const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: any }> = [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    requests.push({ url: req.url!, headers: req.headers, body: safeParse(raw) });
    scenario(req, res, raw);
  });
});
server.listen(0);
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/v1`;

/** Messages frames carry both an `event:` name and a `data:` payload repeating it in `type`. */
const sse = (res: ServerResponse, frames: string[], splitMidFrame = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = frames
    .map((f) => {
      const type = (safeParse(f) as { type?: string }).type;
      return `${type ? `event: ${type}\n` : ''}data: ${f}\n\n`;
    })
    .join('');
  if (splitMidFrame) {
    // Deliberately cut the stream at awkward offsets to exercise buffering.
    for (let i = 0; i < payload.length; i += 7) res.write(payload.slice(i, i + 7));
  } else {
    res.write(payload);
  }
  res.end();
};

const startFrame = (usage: Record<string, number> = { input_tokens: 25, output_tokens: 1 }) =>
  JSON.stringify({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', stop_reason: null, usage },
  });
const textFrame = (text: string, index = 0) =>
  JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const deltaFrame = (stop = 'end_turn', usage: Record<string, number> = { output_tokens: 15 }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage });
const STOP = '{"type":"message_stop"}';

const happy = (...texts: string[]) => [
  startFrame(),
  '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '{"type":"ping"}',
  ...texts.map((t) => textFrame(t)),
  '{"type":"content_block_stop","index":0}',
  deltaFrame(),
  STOP,
];

const run = (model: string, messages: LlmMessage[] = [{ role: 'user', content: 'hi' }], temperature?: number) =>
  new Promise<{ deltas: string[]; full: string; errors: string[]; usage?: LlmUsage; usageCalls: number }>((resolve) => {
    const deltas: string[] = [];
    const errors: string[] = [];
    let usage: LlmUsage | undefined;
    let usageCalls = 0;
    new AnthropicLlmProvider().stream(
      { model, temperature, credentials: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_LLM_BASE_URL: base } },
      messages,
      {
        onDelta: (t) => deltas.push(t),
        onUsage: (u) => {
          usage = u;
          usageCalls += 1;
        },
        onDone: (full) => resolve({ deltas, full, errors, usage, usageCalls }),
        onError: (e) => errors.push(e.message),
      },
    );
  });

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

/* 1. happy path, whole frames */
scenario = (_q, res) => sse(res, happy('Hello', ' world', '!'));
let r = await run('claude-haiku-5-5@off');
check('streams deltas in order', r.deltas.join('') === 'Hello world!', r.deltas.join(''));
check('onDone gets full text', r.full === 'Hello world!', r.full);
check('no spurious errors', r.errors.length === 0, r.errors.join('; '));
check('ping and lifecycle frames ignored', r.deltas.length === 3, String(r.deltas.length));

/* 2. same stream, chopped mid-frame */
scenario = (_q, res) => sse(res, happy('Chunked', ' across', ' boundaries'), true);
r = await run('claude-haiku-5-5@off');
check('reassembles split SSE frames', r.full === 'Chunked across boundaries', r.full);

/* 3. thinking must never reach TTS — it would be spoken aloud */
scenario = (_q, res) =>
  sse(res, [
    startFrame(),
    '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal reasoning"}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAhIM"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    textFrame('spoken answer', 1),
    '{"type":"content_block_stop","index":1}',
    deltaFrame(),
    STOP,
  ]);
r = await run('claude-haiku-5-5@low');
check('only text_delta is spoken', r.full === 'spoken answer', r.full);
check('thinking never reaches TTS', !r.deltas.some((d) => d.includes('internal') || d.includes('EqQB')), r.deltas.join('|'));

/* 4. request shape */
requests.length = 0;
scenario = (_q, res) => sse(res, happy('ok'));
await run('claude-haiku-5-5@off', [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'second' },
], 0.2);
let req = requests[0];
check('posts to /v1/messages', req.url === '/v1/messages', req.url);
check('key sent as x-api-key, not in the URL', req.headers['x-api-key'] === 'test-key' && !req.url.includes('test-key'));
check('no bearer header', req.headers['authorization'] === undefined, String(req.headers['authorization']));
check('anthropic-version header sent', req.headers['anthropic-version'] === '2023-06-01', String(req.headers['anthropic-version']));
check('stream requested', req.body.stream === true);
check('max_tokens always present (required by the API)', typeof req.body.max_tokens === 'number' && req.body.max_tokens > 0, String(req.body.max_tokens));
check('variant stripped from the model sent', req.body.model === 'claude-haiku-5-5', req.body.model);
check('system prompt hoisted to top-level system', req.body.system === 'Be brief.', String(req.body.system));
check('system excluded from messages', req.body.messages.length === 3, JSON.stringify(req.body.messages));
check('transcript order and roles preserved',
  req.body.messages.map((m: any) => `${m.role}:${m.content}`).join(',') === 'user:first,assistant:reply,user:second',
  JSON.stringify(req.body.messages));
check('temperature never sent, even when asked', req.body.temperature === undefined, String(req.body.temperature));

/* 5. @variant mapping */
check('@off disables thinking', JSON.stringify(req.body.thinking) === '{"type":"disabled"}', JSON.stringify(req.body.thinking));
check('@off sends no effort', req.body.output_config === undefined, JSON.stringify(req.body.output_config));

requests.length = 0;
await run('claude-haiku-5-5@low');
req = requests[0];
check('@low maps to output_config.effort', req.body.output_config?.effort === 'low', JSON.stringify(req.body.output_config));
check('@low leaves thinking adaptive (no thinking key)', req.body.thinking === undefined, JSON.stringify(req.body.thinking));

requests.length = 0;
await run('claude-haiku-5-5@none');
check('@none is the OpenAI spelling of @off', JSON.stringify(requests[0].body.thinking) === '{"type":"disabled"}', JSON.stringify(requests[0].body.thinking));
check('the string "none" never reaches the wire', !JSON.stringify(requests[0].body).includes('"none"'));

requests.length = 0;
await run('claude-haiku-5-5');
check('bare id sends neither thinking nor effort',
  requests[0].body.thinking === undefined && requests[0].body.output_config === undefined, JSON.stringify(requests[0].body));

requests.length = 0;
await run('claude-haiku-4-5@low');
check('Haiku 4.5 never gets an effort', requests[0].body.output_config === undefined, JSON.stringify(requests[0].body.output_config));
check('Haiku 4.5 never gets a thinking key', requests[0].body.thinking === undefined, JSON.stringify(requests[0].body.thinking));
check('Haiku 4.5 still strips the variant', requests[0].body.model === 'claude-haiku-4-5', requests[0].body.model);

/* 6. error envelope on non-2xx */
scenario = (_q, res) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"type":"error","error":{"type":"invalid_request_error","message":"temperature: not supported for this model"}}');
};
r = await run('claude-haiku-5-5@off');
check('surfaces API error message', r.errors.some((e) => e.includes('temperature: not supported')), r.errors.join('; '));
check('reports the status code', r.errors.some((e) => e.includes('400')), r.errors.join('; '));
check('still closes the turn on error', r.full === '');

/* 7. a mid-stream `error` frame */
scenario = (_q, res) =>
  sse(res, [startFrame(), textFrame('partial'), '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']);
r = await run('claude-haiku-5-5@off');
check('surfaces an SSE error frame', r.errors.some((e) => e.includes('Overloaded')), r.errors.join('; '));
check('keeps text streamed before the error', r.full === 'partial', r.full);
check('bills the input seen before the error', r.usage?.inputTokens === 25, JSON.stringify(r.usage));

/* 8. stop reasons that are not a clean finish */
scenario = (_q, res) => sse(res, [startFrame(), textFrame('cut off'), deltaFrame('max_tokens', { output_tokens: 40 }), STOP]);
r = await run('claude-haiku-5-5@medium');
check('reports a max_tokens stop', r.errors.some((e) => e.includes('max_tokens')), r.errors.join('; '));
check('keeps partial text after an early stop', r.full === 'cut off', r.full);
check('bills a truncated response', r.usage?.outputTokens === 40, JSON.stringify(r.usage));

scenario = (_q, res) =>
  sse(res, [startFrame(), deltaFrame('refusal', { output_tokens: 3 }, { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }), STOP]);
r = await run('claude-haiku-5-5@off');
check('reports a refusal with its category', r.errors.some((e) => e.includes('declined') && e.includes('cyber')), r.errors.join('; '));

/* 9. abort (barge-in) must stop deltas immediately and stay silent */
scenario = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`event: message_start\ndata: ${startFrame()}\n\n`);
  res.write(`event: content_block_delta\ndata: ${textFrame('starting')}\n\n`);
  // Keep dripping until the caller aborts; anything after the abort is a leak.
  const timer = setInterval(() => res.write(`data: ${textFrame(' more')}\n\n`), 30);
  res.on('close', () => clearInterval(timer));
};
const abortErrors: string[] = [];
const abortDeltas: string[] = [];
let doneCalled = false;
const handle = new AnthropicLlmProvider().stream(
  { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_LLM_BASE_URL: base } },
  [{ role: 'user', content: 'hi' }],
  {
    onDelta: (t) => abortDeltas.push(t),
    onDone: () => (doneCalled = true),
    onError: (e) => abortErrors.push(e.message),
  },
);
await new Promise((r2) => setTimeout(r2, 250));
handle.abort();
const seenAtAbort = abortDeltas.length;
await new Promise((r2) => setTimeout(r2, 250));
check('abort stops deltas immediately', abortDeltas.length === seenAtAbort, `${seenAtAbort} -> ${abortDeltas.length}`);
check('abort raises no error', abortErrors.length === 0, abortErrors.join('; '));
check('abort does not fire onDone', !doneCalled);

/* ---- usage: Anthropic's cache counts are OUTSIDE input_tokens ---- */

scenario = (_q, res) => sse(res, [startFrame({ input_tokens: 120, output_tokens: 1 }), textFrame('answer'), deltaFrame('end_turn', { output_tokens: 30 }), STOP]);
r = await run('claude-haiku-4-5');
check('reports vendor token counts', r.usage?.inputTokens === 120 && r.usage?.outputTokens === 30, JSON.stringify(r.usage));
check('message_delta output count wins over message_start', r.usage?.outputTokens === 30, String(r.usage?.outputTokens));
check('reports usage exactly once', r.usageCalls === 1, String(r.usageCalls));
check('no thinking key — Anthropic publishes none', r.usage?.thinkingTokens === undefined, String(r.usage?.thinkingTokens));

/* input_tokens 200 + cache read 800 + cache write 0 is a 1000-token prompt. */
scenario = (_q, res) =>
  sse(res, [
    startFrame({ input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 800, output_tokens: 1 }),
    textFrame('answer'),
    deltaFrame('end_turn', { output_tokens: 20 }),
    STOP,
  ]);
r = await run('claude-haiku-5-5@off');
check('cache reads surfaced', r.usage?.cachedInputTokens === 800, String(r.usage?.cachedInputTokens));
check('cache reads folded INTO inputTokens', r.usage?.inputTokens === 1000, String(r.usage?.inputTokens));
check(
  'inputTokens >= cachedInputTokens (LlmUsage invariant)',
  (r.usage?.inputTokens ?? 0) >= (r.usage?.cachedInputTokens ?? 0),
  JSON.stringify(r.usage),
);

/* A cache write is still prompt — it must be billed, not dropped. */
scenario = (_q, res) =>
  sse(res, [startFrame({ input_tokens: 10, cache_creation_input_tokens: 90, output_tokens: 1 }), textFrame('a'), deltaFrame(), STOP]);
r = await run('claude-haiku-5-5@off');
check('cache writes counted as input', r.usage?.inputTokens === 100, String(r.usage?.inputTokens));
check('a cache write is not a cache read', r.usage?.cachedInputTokens === undefined, String(r.usage?.cachedInputTokens));

/* message_delta may repeat the input fields, cumulatively — later wins, null keeps. */
scenario = (_q, res) =>
  sse(res, [
    startFrame({ input_tokens: 10, output_tokens: 1 }),
    textFrame('a'),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 12, cache_read_input_tokens: null, output_tokens: 5 } }),
    STOP,
  ]);
r = await run('claude-haiku-5-5@off');
check('cumulative message_delta input wins', r.usage?.inputTokens === 12, JSON.stringify(r.usage));
check('a null count is an absence', r.usage?.cachedInputTokens === undefined, JSON.stringify(r.usage));

/* No usage at all: report nothing rather than zeros. */
scenario = (_q, res) =>
  sse(res, [JSON.stringify({ type: 'message_start', message: { id: 'm', content: [] } }), textFrame('a'),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), STOP]);
r = await run('claude-haiku-5-5@off');
check('a silent vendor produces no usage call', r.usageCalls === 0, String(r.usageCalls));

/* A missing key must be reported, not thrown, and must never reach the network. */
requests.length = 0;
const keyless = await new Promise<string[]>((resolve) => {
  const errs: string[] = [];
  new AnthropicLlmProvider().stream(
    { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_LLM_BASE_URL: base } },
    [{ role: 'user', content: 'hi' }],
    {
      onDelta: () => {},
      onDone: () => {},
      onError: (e) => {
        errs.push(e.message);
        resolve(errs);
      },
    },
  );
});
check('missing key is reported', keyless.some((e) => e.includes('ANTHROPIC_API_KEY')), keyless.join('; '));
check('missing key makes no request', requests.length === 0, String(requests.length));

/* ANTHROPIC_BASE_URL is Claude Code's own variable; it must not reroute a bench call. */
requests.length = 0;
scenario = (_q, res) => sse(res, happy('ok'));
await new Promise<void>((resolve) =>
  new AnthropicLlmProvider().stream(
    { model: 'claude-haiku-5-5@off', credentials: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_LLM_BASE_URL: base, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } },
    [{ role: 'user', content: 'hi' }],
    { onDelta: () => {}, onDone: () => resolve(), onError: () => {} },
  ),
);
check('ANTHROPIC_BASE_URL is ignored', requests.length === 1, String(requests.length));

/* ------------------------------- report ------------------------------- */
let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
server.close();
process.exit(failed ? 1 : 0);

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
