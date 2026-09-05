/**
 * Verifies OpenAiLlmProvider against a local fake that speaks the Responses
 * API's SSE dialect. Needs no API key and no network.
 *
 * WHAT THIS DOES NOT PROVE. The fake below answers however this repo expects it
 * to, so every check here is a check on our parsing — not on what OpenAI
 * accepts. The provider HAS since streamed a live completion (2026-09-05,
 * `gpt-5.4-nano@none` through `scripts/smoke.mjs pipeline`), and every model id
 * is checked against `GET /v1/models` by `npm run models` — but only that one
 * model and that one reasoning effort have actually been exercised, so the
 * per-model effort table remains doc-derived. A green run here is not evidence
 * that a real request would succeed.
 *
 * It does cover the parts most likely to be wrong on our side: SSE framing
 * across chunk boundaries, event-type dispatch, the `@variant` suffix, the
 * usage containment invariants, error envelopes and abort.
 *
 *   npx tsx scripts/openai-llm-selftest.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { LlmMessage, LlmUsage } from '../src/providers/types.js';
import { OpenAiLlmProvider } from '../src/providers/llm/OpenAiLlmProvider.js';

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

/** Responses frames carry both an `event:` name and a `data:` payload repeating it in `type`. */
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

const textFrame = (text: string) =>
  `{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":${JSON.stringify(text)}}`;

const usageJson = (input: number, output: number, reasoning?: number, cached?: number) =>
  `{"input_tokens":${input}` +
  (cached === undefined ? '' : `,"input_tokens_details":{"cached_tokens":${cached}}`) +
  `,"output_tokens":${output}` +
  (reasoning === undefined ? '' : `,"output_tokens_details":{"reasoning_tokens":${reasoning}}`) +
  `,"total_tokens":${input + output}}`;

const completedFrame = (usage?: string) =>
  `{"type":"response.completed","response":{"id":"resp_1","status":"completed","error":null,"incomplete_details":null${usage ? `,"usage":${usage}` : ''}}}`;

const run = (model: string, messages: LlmMessage[] = [{ role: 'user', content: 'hi' }]) =>
  new Promise<{ deltas: string[]; full: string; errors: string[]; usage?: LlmUsage; usageCalls: number }>((resolve) => {
    const deltas: string[] = [];
    const errors: string[] = [];
    let usage: LlmUsage | undefined;
    let usageCalls = 0;
    new OpenAiLlmProvider().stream(
      { model, credentials: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: base } },
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
scenario = (_q, res) => sse(res, [textFrame('Hello'), textFrame(' world'), textFrame('!'), completedFrame()]);
let r = await run('gpt-5.6-luna@none');
check('streams deltas in order', r.deltas.join('') === 'Hello world!', r.deltas.join(''));
check('onDone gets full text', r.full === 'Hello world!', r.full);
check('no spurious errors', r.errors.length === 0, r.errors.join('; '));

/* 2. same stream, chopped mid-frame */
scenario = (_q, res) =>
  sse(res, [textFrame('Chunked'), textFrame(' across'), textFrame(' boundaries'), completedFrame()], true);
r = await run('gpt-5.6-luna@none');
check('reassembles split SSE frames', r.full === 'Chunked across boundaries', r.full);

/* 3. non-answer event types must not reach TTS. Reasoning summaries are the one
      that would actually be spoken aloud if it leaked. */
scenario = (_q, res) =>
  sse(res, [
    '{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
    '{"type":"response.in_progress","response":{"id":"resp_1","status":"in_progress"}}',
    '{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message"}}',
    '{"type":"response.reasoning_summary_text.delta","delta":"internal reasoning"}',
    textFrame('spoken answer'),
    '{"type":"response.output_text.done","text":"spoken answer"}',
    completedFrame(),
  ]);
r = await run('gpt-5.6-luna@none');
check('ignores lifecycle events', r.full === 'spoken answer', r.full);
check('reasoning summary never reaches TTS', !r.deltas.some((d) => d.includes('internal')), r.deltas.join('|'));

/* 4. `[DONE]`: the Chat Completions sentinel. Undocumented for Responses, but a
      stray one must not be parsed as an event or appended to the text. */
scenario = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`event: response.output_text.delta\ndata: ${textFrame('done sentinel')}\n\n`);
  res.write(`data: ${completedFrame(usageJson(5, 3))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
r = await run('gpt-5.6-luna@none');
check('[DONE] sentinel is skipped', r.full === 'done sentinel', r.full);
check('[DONE] raises no error', r.errors.length === 0, r.errors.join('; '));

/* 5. the @variant suffix: stripped from the wire, mapped to reasoning.effort */
requests.length = 0;
scenario = (_q, res) => sse(res, [textFrame('ok'), completedFrame()]);
await run('gpt-5.6-luna@none');
check('variant stripped from the model sent', requests[0].body.model === 'gpt-5.6-luna', requests[0].body.model);
check('@none maps to reasoning.effort none', requests[0].body.reasoning?.effort === 'none', JSON.stringify(requests[0].body.reasoning));
check('stream requested', requests[0].body.stream === true);
check('posts to /v1/responses', requests[0].url === '/v1/responses', requests[0].url);

requests.length = 0;
await run('gpt-5.4-nano@xhigh');
check('@xhigh passed through verbatim', requests[0].body.reasoning?.effort === 'xhigh', JSON.stringify(requests[0].body.reasoning));
check('model id keeps its dots', requests[0].body.model === 'gpt-5.4-nano', requests[0].body.model);

/* `off` is this repo's spelling; OpenAI's word is `none`, so it must not go out as-is. */
requests.length = 0;
await run('gpt-5.6-terra@off');
check('@off is rewritten to none', requests[0].body.reasoning?.effort === 'none', JSON.stringify(requests[0].body.reasoning));
check('the string "off" never reaches the wire', !JSON.stringify(requests[0].body).includes('"off"'));

/* No suffix at all: send no reasoning key, so the model's own default stands. */
requests.length = 0;
await run('gpt-5.6-luna');
check('bare model id sends no reasoning key', requests[0].body.reasoning === undefined, JSON.stringify(requests[0].body.reasoning));
check('bare model id is sent unchanged', requests[0].body.model === 'gpt-5.6-luna', requests[0].body.model);

/* 6. a model documented to take no reasoning parameter must never be sent one,
      even when a variant is supplied. */
requests.length = 0;
await run('gpt-4.1-mini@low');
check('non-reasoning model sends no reasoning key', requests[0].body.reasoning === undefined, JSON.stringify(requests[0].body.reasoning));
check('non-reasoning model still strips the variant', requests[0].body.model === 'gpt-4.1-mini', requests[0].body.model);

requests.length = 0;
await run('gpt-4o-mini@medium');
check('gpt-4o-mini sends no reasoning key', requests[0].body.reasoning === undefined, JSON.stringify(requests[0].body.reasoning));

/* 7. auth + message shaping */
requests.length = 0;
await run('gpt-5.6-luna@low', [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'second' },
]);
const body = requests[0].body;
check(
  'key sent as a bearer header, not in the URL',
  requests[0].headers['authorization'] === 'Bearer test-key' && !requests[0].url.includes('test-key'),
  String(requests[0].headers['authorization']),
);
check('system prompt hoisted to instructions', body.instructions === 'Be brief.', String(body.instructions));
check('system excluded from input', body.input.length === 3, JSON.stringify(body.input));
check('assistant role preserved in input', body.input[1].role === 'assistant', JSON.stringify(body.input[1]));
check('transcript order preserved', body.input.map((m: any) => m.content).join(',') === 'first,reply,second', JSON.stringify(body.input));
check('temperature omitted by default', body.temperature === undefined);
/* Responses stores conversations server-side unless told not to. */
check('does not opt into server-side storage', body.store === false, String(body.store));

/* 8. error envelope on non-2xx */
scenario = (_q, res) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"Unsupported value: \'reasoning.effort\' does not support \'max\'","type":"invalid_request_error"}}');
};
r = await run('gpt-5.4-nano@max');
check('surfaces API error message', r.errors.some((e) => e.includes("does not support 'max'")), r.errors.join('; '));
check('reports the status code', r.errors.some((e) => e.includes('400')), r.errors.join('; '));
check('still closes the turn on error', r.full === '');

/* 9. a mid-stream `error` frame */
scenario = (_q, res) =>
  sse(res, [textFrame('partial'), '{"type":"error","code":"server_error","message":"the server had an error"}']);
r = await run('gpt-5.6-luna@none');
check('surfaces an SSE error frame', r.errors.some((e) => e.includes('the server had an error')), r.errors.join('; '));
check('keeps text streamed before the error', r.full === 'partial', r.full);

/* 10. response.failed carries the message inside the Response */
scenario = (_q, res) =>
  sse(res, ['{"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}']);
r = await run('gpt-5.6-luna@none');
check('surfaces response.failed', r.errors.some((e) => e.includes('slow down')), r.errors.join('; '));

/* 11. an incomplete response is reported but its text is kept */
scenario = (_q, res) =>
  sse(res, [
    textFrame('cut off'),
    '{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":' + usageJson(10, 40) + '}}',
  ]);
r = await run('gpt-5.6-luna@none');
check('reports an early stop', r.errors.some((e) => e.includes('max_output_tokens')), r.errors.join('; '));
check('keeps partial text after an early stop', r.full === 'cut off', r.full);
check('bills an incomplete response', r.usage?.outputTokens === 40, JSON.stringify(r.usage));

/* 12. abort (barge-in) must stop deltas immediately and stay silent */
scenario = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`event: response.output_text.delta\ndata: ${textFrame('starting')}\n\n`);
  // Keep dripping until the caller aborts; anything after the abort is a leak.
  const timer = setInterval(() => res.write(`data: ${textFrame(' more')}\n\n`), 30);
  res.on('close', () => clearInterval(timer));
};
const abortErrors: string[] = [];
const abortDeltas: string[] = [];
let doneCalled = false;
const handle = new OpenAiLlmProvider().stream(
  { model: 'gpt-5.6-luna@none', credentials: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: base } },
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

/* ---- usage: the containment invariants pricing depends on ---- */

scenario = (_q, res) => sse(res, [textFrame('answer'), completedFrame(usageJson(120, 30))]);
r = await run('gpt-4.1-mini');
check('reports vendor token counts', r.usage?.inputTokens === 120 && r.usage?.outputTokens === 30, JSON.stringify(r.usage));
check('reports usage exactly once', r.usageCalls === 1, String(r.usageCalls));
check('no thinking key when the vendor sends none', r.usage?.thinkingTokens === undefined, String(r.usage?.thinkingTokens));

/* OpenAI already counts reasoning inside output_tokens (reasoning guide: input
   75, output 1186 of which 1024 reasoning, total 1261), so outputTokens must
   pass through untouched — adding them here would double-bill. */
scenario = (_q, res) => sse(res, [textFrame('answer'), completedFrame(usageJson(75, 1186, 1024))]);
r = await run('gpt-5.6-luna@high');
check('outputTokens is not double-counted', r.usage?.outputTokens === 1186, String(r.usage?.outputTokens));
check('reasoning still broken out for display', r.usage?.thinkingTokens === 1024, String(r.usage?.thinkingTokens));
check(
  'outputTokens >= thinkingTokens (LlmUsage invariant)',
  (r.usage?.outputTokens ?? 0) >= (r.usage?.thinkingTokens ?? 0),
  JSON.stringify(r.usage),
);
check('input is untouched by reasoning', r.usage?.inputTokens === 75, String(r.usage?.inputTokens));

/* cached_tokens is a subset of input_tokens; pricing subtracts it. */
scenario = (_q, res) => sse(res, [textFrame('answer'), completedFrame(usageJson(1000, 20, undefined, 800))]);
r = await run('gpt-5.6-luna@none');
check('cached tokens surfaced', r.usage?.cachedInputTokens === 800, String(r.usage?.cachedInputTokens));
check('cached tokens stay inside inputTokens', r.usage?.inputTokens === 1000, String(r.usage?.inputTokens));
check(
  'inputTokens >= cachedInputTokens (LlmUsage invariant)',
  (r.usage?.inputTokens ?? 0) >= (r.usage?.cachedInputTokens ?? 0),
  JSON.stringify(r.usage),
);

/* Zero counts are absences, not breakdowns. */
scenario = (_q, res) => sse(res, [textFrame('answer'), completedFrame(usageJson(10, 10, 0, 0))]);
r = await run('gpt-5.6-luna@none');
check('zero reasoning is reported as absent', r.usage?.thinkingTokens === undefined, String(r.usage?.thinkingTokens));
check('zero cached is reported as absent', r.usage?.cachedInputTokens === undefined, String(r.usage?.cachedInputTokens));

/* No usage at all: report nothing rather than zeros. */
scenario = (_q, res) => sse(res, [textFrame('answer'), completedFrame()]);
r = await run('gpt-5.6-luna@none');
check('a silent vendor produces no usage call', r.usageCalls === 0, String(r.usageCalls));

/* A missing key must be reported, not thrown, and must never reach the network. */
requests.length = 0;
const keyless = await new Promise<string[]>((resolve) => {
  const errs: string[] = [];
  new OpenAiLlmProvider().stream({ model: 'gpt-5.6-luna@none', credentials: { OPENAI_BASE_URL: base } }, [{ role: 'user', content: 'hi' }], {
    onDelta: () => {},
    onDone: () => {},
    onError: (e) => {
      errs.push(e.message);
      resolve(errs);
    },
  });
});
check('missing key is reported', keyless.some((e) => e.includes('OPENAI_API_KEY')), keyless.join('; '));
check('missing key makes no request', requests.length === 0, String(requests.length));

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
