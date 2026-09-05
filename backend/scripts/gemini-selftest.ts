/**
 * Verifies GeminiLlmProvider against a local fake that speaks Gemini's SSE
 * dialect. Needs no API key and no network — it covers the parts most likely
 * to be wrong: SSE framing across chunk boundaries, thought-part filtering,
 * the per-family thinking field, error envelopes and abort.
 *
 *   npx tsx scripts/gemini-selftest.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { LlmUsage } from '../src/providers/types.js';
import { GeminiLlmProvider } from '../src/providers/llm/GeminiLlmProvider.js';
import type { LlmMessage } from '../src/providers/types.js';

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
const base = `http://127.0.0.1:${port}/v1beta/models`;

const sse = (res: ServerResponse, frames: string[], splitMidFrame = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = frames.map((f) => `data: ${f}\n\n`).join('');
  if (splitMidFrame) {
    // Deliberately cut the stream at awkward offsets to exercise buffering.
    for (let i = 0; i < payload.length; i += 7) res.write(payload.slice(i, i + 7));
  } else {
    res.write(payload);
  }
  res.end();
};

const textFrame = (text: string, extra = '') =>
  `{"candidates":[{"content":{"role":"model","parts":[{"text":${JSON.stringify(text)}}]}${extra}}]}`;

const run = (model: string, messages: LlmMessage[] = [{ role: 'user', content: 'hi' }]) =>
  new Promise<{ deltas: string[]; full: string; errors: string[]; usage?: LlmUsage; usageCalls: number }>((resolve) => {
    const deltas: string[] = [];
    const errors: string[] = [];
    let usage: LlmUsage | undefined;
    let usageCalls = 0;
    new GeminiLlmProvider().stream(
      { model, credentials: { GOOGLE_API_KEY: 'test-key', GEMINI_BASE_URL: base } },
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
scenario = (_q, res) => sse(res, [textFrame('Hello'), textFrame(' world'), textFrame('!', ',"finishReason":"STOP"')]);
let r = await run('gemini-3.8-flash@off');
check('streams deltas in order', r.deltas.join('') === 'Hello world!', r.deltas.join(''));
check('onDone gets full text', r.full === 'Hello world!', r.full);
check('no spurious errors', r.errors.length === 0, r.errors.join('; '));

/* 2. same stream, chopped mid-frame */
scenario = (_q, res) => sse(res, [textFrame('Chunked'), textFrame(' across'), textFrame(' boundaries')], true);
r = await run('gemini-3.8-flash@off');
check('reassembles split SSE frames', r.full === 'Chunked across boundaries', r.full);

/* 3. reasoning parts must not reach TTS */
scenario = (_q, res) =>
  sse(res, [
    '{"candidates":[{"content":{"role":"model","parts":[{"text":"internal reasoning","thought":true}]}}]}',
    textFrame('spoken answer'),
  ]);
r = await run('gemini-3.8-flash@off');
check('filters thought parts', r.full === 'spoken answer', r.full);

/* 4. thinking field mapping — the two fields are mutually exclusive and both
      must sit under generationConfig.thinkingConfig (the live API rejects
      thinkingLevel anywhere else). */
requests.length = 0;
scenario = (_q, res) => sse(res, [textFrame('ok')]);
await run('gemini-3.6-flash@minimal');
let tc = requests[0].body.generationConfig.thinkingConfig;
check('level nests under thinkingConfig', tc?.thinkingLevel === 'minimal', JSON.stringify(requests[0].body.generationConfig));
check('no thinkingLevel at generationConfig root', requests[0].body.generationConfig.thinkingLevel === undefined);
check('level variant sends no budget', tc?.thinkingBudget === undefined);

requests.length = 0;
await run('gemini-3.8-flash@off');
tc = requests[0].body.generationConfig.thinkingConfig;
check('@off maps to thinkingBudget 0', tc?.thinkingBudget === 0, JSON.stringify(requests[0].body.generationConfig));
check('@off sends no thinkingLevel', tc?.thinkingLevel === undefined);

requests.length = 0;
await run('gemini-3.1-flash-lite@high');
tc = requests[0].body.generationConfig.thinkingConfig;
check('never sends both fields', !(tc?.thinkingLevel !== undefined && tc?.thinkingBudget !== undefined));
check('high level passed through', tc?.thinkingLevel === 'high');

requests.length = 0;
await run('gemini-3.5-flash-lite@minimal');
check('variant stripped from URL', requests[0].url.includes('gemini-3.5-flash-lite:streamGenerateContent'), requests[0].url);
check('alt=sse requested', requests[0].url.includes('alt=sse'));

/* 5. auth + message shaping */
requests.length = 0;
await run('gemini-3.8-flash@low', [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'second' },
]);
const body = requests[0].body;
check('key sent as header not URL', requests[0].headers['x-goog-api-key'] === 'test-key' && !requests[0].url.includes('test-key'));
check('system prompt hoisted to systemInstruction', body.systemInstruction?.parts?.[0]?.text === 'Be brief.');
check('system excluded from contents', body.contents.length === 3);
check('assistant mapped to role "model"', body.contents[1].role === 'model', JSON.stringify(body.contents[1]));
check('temperature omitted by default', body.generationConfig.temperature === undefined);

/* 6. error envelope on non-200 */
scenario = (_q, res) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"error":{"code":400,"message":"thinking_level minimal is not supported","status":"INVALID_ARGUMENT"}}');
};
r = await run('gemini-3.7-flash@minimal');
check('surfaces API error message', r.errors.some((e) => e.includes('minimal is not supported')), r.errors.join('; '));
check('still closes the turn on error', r.full === '');

/* 7. early finishReason is reported but text kept */
scenario = (_q, res) => sse(res, [textFrame('cut off', ',"finishReason":"MAX_TOKENS"')]);
r = await run('gemini-3.8-flash@off');
check('reports early finishReason', r.errors.some((e) => e.includes('MAX_TOKENS')), r.errors.join('; '));
check('keeps partial text after early finish', r.full === 'cut off', r.full);

/* 8. abort (barge-in) must stay silent */
scenario = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${textFrame('starting')}\n\n`);
  // never ends — caller aborts
};
const abortErrors: string[] = [];
let doneCalled = false;
const handle = new GeminiLlmProvider().stream(
  { model: 'gemini-3.8-flash@off', credentials: { GOOGLE_API_KEY: 'k', GEMINI_BASE_URL: base } },
  [{ role: 'user', content: 'hi' }],
  { onDelta: () => {}, onDone: () => (doneCalled = true), onError: (e) => abortErrors.push(e.message) },
);
await new Promise((r2) => setTimeout(r2, 250));
handle.abort();
await new Promise((r2) => setTimeout(r2, 250));
check('abort raises no error', abortErrors.length === 0, abortErrors.join('; '));
check('abort does not fire onDone', !doneCalled);


/* ---- usageMetadata: the fold-in invariants that pricing depends on ---- */

const usageFrame = (prompt: number, candidates: number, thoughts?: number, cached?: number) =>
  `{"usageMetadata":{"promptTokenCount":${prompt},"candidatesTokenCount":${candidates}` +
  (thoughts === undefined ? '' : `,"thoughtsTokenCount":${thoughts}`) +
  (cached === undefined ? '' : `,"cachedContentTokenCount":${cached}`) +
  `,"totalTokenCount":${prompt + candidates + (thoughts ?? 0)}}}`;

scenario = (_q, res) => sse(res, [textFrame('answer'), usageFrame(120, 30)]);
r = await run('gemini-3.8-flash@off');
check('reports vendor token counts', r.usage?.inputTokens === 120 && r.usage?.outputTokens === 30, JSON.stringify(r.usage));
check('reports usage exactly once', r.usageCalls === 1, String(r.usageCalls));
check('no thinking key when the vendor sends none', r.usage?.thinkingTokens === undefined, String(r.usage?.thinkingTokens));

/* Thinking is billed at the output rate, so it MUST be folded into outputTokens. */
scenario = (_q, res) => sse(res, [textFrame('answer'), usageFrame(13, 27, 308)]);
r = await run('gemini-3.5-flash-lite@high');
check('thinking is folded into outputTokens', r.usage?.outputTokens === 335, String(r.usage?.outputTokens));
check('and still broken out for display', r.usage?.thinkingTokens === 308, String(r.usage?.thinkingTokens));
check('input is untouched by thinking', r.usage?.inputTokens === 13, String(r.usage?.inputTokens));

/* Cached input is a subset of promptTokenCount; pricing subtracts it. */
scenario = (_q, res) => sse(res, [textFrame('answer'), usageFrame(1000, 20, undefined, 800)]);
r = await run('gemini-3.8-flash@off');
check('cached tokens surfaced', r.usage?.cachedInputTokens === 800, String(r.usage?.cachedInputTokens));
check('cached tokens stay inside inputTokens', r.usage?.inputTokens === 1000, String(r.usage?.inputTokens));

/* Totals are cumulative across frames, so the last one wins. */
scenario = (_q, res) => sse(res, [usageFrame(10, 5), textFrame('more'), usageFrame(10, 40)]);
r = await run('gemini-3.8-flash@off');
check('the final cumulative total wins', r.usage?.outputTokens === 40, String(r.usage?.outputTokens));

/* A zero thinking count must not be reported as a thinking breakdown. */
scenario = (_q, res) => sse(res, [textFrame('answer'), usageFrame(10, 10, 0)]);
r = await run('gemini-3.8-flash@off');
check('zero thinking is reported as absent', r.usage?.thinkingTokens === undefined, String(r.usage?.thinkingTokens));

/* Whatever the vendor billed before a mid-stream failure was still billed. */
scenario = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Destroying in the same tick discards the buffered write, so the frame has
  // to actually reach the client before the connection dies.
  res.write(`data: ${usageFrame(50, 10)}\n\n`, () => setTimeout(() => res.destroy(), 10));
};
r = await run('gemini-3.8-flash@off');
check('usage survives a mid-stream failure', r.usage?.inputTokens === 50, JSON.stringify(r.usage));

/* No usageMetadata at all: report nothing rather than zeros. */
scenario = (_q, res) => sse(res, [textFrame('answer')]);
r = await run('gemini-3.8-flash@off');
check('a silent vendor produces no usage call', r.usageCalls === 0, String(r.usageCalls));

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
