import type { LlmEvents, LlmHandle, LlmMessage, LlmOptions, LlmProvider } from '../types.js';

/**
 * OpenAI streaming LLM.
 *
 *   POST https://api.openai.com/v1/responses   { "stream": true }
 *   header: authorization: Bearer <OPENAI_API_KEY>   (never a query param — keys don't belong in URLs)
 *
 * VERIFIED LIVE 2026-09-05. A `cartesia-stt -> openai-llm -> elevenlabs-tts`
 * turn ran through the full WS protocol on `gpt-5.4-nano@none`: the Responses
 * SSE stream decoded, and the vendor reported its own token counts (24 in /
 * 23 out), so this leg is billed `source: 'vendor'` rather than estimated.
 * Every catalog model id was checked against `GET /v1/models` by `npm run
 * models`. What that does NOT cover: `scripts/openai-llm-selftest.ts` still
 * runs against a fake that answers however this file expects, so it proves the
 * parsing and not the contract, and only the `@none` reasoning variant has
 * actually been exercised.
 *
 * Responses, not Chat Completions. OpenAI calls Responses "our new API
 * primitive, an evolution of Chat Completions" and the text guide says "we
 * recommend using the Responses API over the older Chat Completions API"; the
 * migration guide names a concrete capability gap rather than a stylistic
 * preference — "Starting with GPT-5.4, Chat Completions does not support tool
 * calling with `reasoning_effort` values other than `none`". Reasoning depth is
 * the dial this bench exists to compare, so the endpoint that carries it fully
 * is the one to be on.
 *   https://developers.openai.com/api/docs/guides/migrate-to-responses (read 2026-09-05)
 *
 * Reasoning depth rides in the model id as an `@variant` suffix —
 * `gpt-5.6-luna@none` — the same convention as `gemini-3.8-flash@off`, and maps
 * to `reasoning.effort`. The variant names ARE OpenAI's own effort values, so
 * nothing is invented in translation; `@off` is accepted as a repo-side alias
 * for `none` (Gemini spells it that way) and is rewritten before the request, so
 * the wire only ever carries a value OpenAI documents.
 *
 * Documented effort values, per model page (docs only — UNVERIFIED here):
 *
 *   gpt-5.6-terra / -luna / -sol   none, low, medium (default), high, xhigh, max
 *   gpt-5.4-mini / -nano          none (default), low, medium, high, xhigh
 *   gpt-4.1-mini, gpt-4o-mini     no reasoning parameter at all
 *
 * OpenAI is explicit that support is per-model — "Some models support only a
 * subset of these values, so check the relevant model page" — and that `none` is
 * the effort meant for voice. catalog.ts should therefore list only the
 * combinations a model page actually publishes, the same way it does for Gemini.
 *
 * A model documented as taking no reasoning parameter never gets one sent, even
 * if a variant is supplied. Any other model gets the effort verbatim: this
 * table is unverified, so it is not allowed to silently downgrade a request the
 * caller asked for — if the pairing is wrong OpenAI answers with a 400 and its
 * own message, which is better evidence than anything written here.
 */

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** OpenAI's documented `reasoning.effort` values; which subset a model takes is per-model. */
type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Model families the docs describe with no reasoning capability at all, matched
 * by prefix. For these a variant is dropped rather than sent — the parameter is
 * not merely unused, it is not part of the request these models accept.
 */
const NO_REASONING_PREFIXES = ['gpt-4o', 'gpt-4.1', 'gpt-4-', 'gpt-3.5', 'chatgpt-'];

/**
 * The `usage` object on a completed Response. Both containment relationships
 * below are OpenAI's, not ours — the reasoning guide's worked example is
 * input 75, output 1186 of which 1024 reasoning, total 1261 — so the repo's two
 * LlmUsage invariants are satisfied by passing the numbers straight through.
 */
interface ResponseUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

/**
 * Responses streams semantic events: each SSE frame carries an `event:` line and
 * a `data:` JSON payload that repeats the name in `type`. Only `type` is read,
 * so the `event:` line can be ignored entirely.
 */
interface ResponseEvent {
  type?: string;
  /** response.output_text.delta */
  delta?: string;
  /** type: "error" — a mid-stream failure frame. */
  message?: string;
  code?: string | null;
  /** response.completed / .incomplete / .failed all carry the whole Response. */
  response?: {
    status?: string;
    usage?: ResponseUsage;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly id = 'openai-llm';
  readonly name = 'OpenAI';

  stream(opts: LlmOptions, messages: LlmMessage[], events: LlmEvents): LlmHandle {
    const key = opts.credentials.OPENAI_API_KEY;
    const controller = new AbortController();

    if (!key) {
      // Report asynchronously so the caller always gets a handle back first.
      queueMicrotask(() => events.onError(new Error('OPENAI_API_KEY is not set')));
      return { abort: () => controller.abort() };
    }

    const [model, variant] = splitModel(opts.model);
    // Overridable so the SSE handling can be tested against a local fake.
    const base = opts.credentials.OPENAI_BASE_URL || DEFAULT_BASE;

    // Responses takes system-level guidance out-of-band in `instructions`, and
    // `input` as the plain user/assistant transcript.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const input = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      // Responses stores the conversation server-side by default. This bench
      // already persists every turn locally and treats it as conversation
      // content; opting out keeps the vendor copy from being a silent side
      // effect of running a measurement.
      store: false,
      ...reasoningFor(model, variant),
      // Reasoning models reject a temperature, so it is only sent when the
      // caller explicitly asked for one — same posture as Gemini.
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
    };
    if (system) body.instructions = system;

    void this.run(base, key, body, controller, events);

    return { abort: () => controller.abort() };
  }

  private async run(
    base: string,
    key: string,
    body: unknown,
    controller: AbortController,
    events: LlmEvents,
  ): Promise<void> {
    let full = '';
    let usage: ResponseUsage | undefined;
    try {
      const res = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${extractError(detail) || res.statusText}`);
      }

      for await (const payload of sseChunks(res.body, controller.signal)) {
        let event: ResponseEvent;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial frame
        }

        switch (event.type) {
          case 'response.output_text.delta': {
            // The only speakable stream. Reasoning summaries arrive as
            // response.reasoning_summary_text.delta and are deliberately not
            // handled: they are not the answer, and must never reach TTS.
            const text = event.delta;
            if (!text) break;
            full += text;
            events.onDelta(text);
            break;
          }

          case 'response.completed':
            // Usage lands once, on the terminal frame, inside the whole Response.
            if (event.response?.usage) usage = event.response.usage;
            break;

          case 'response.incomplete':
            if (event.response?.usage) usage = event.response.usage;
            // max_output_tokens / content filter — surface it, keep what we got.
            events.onError(
              new Error(`OpenAI stopped early: ${event.response?.incomplete_details?.reason ?? 'incomplete'}`),
            );
            break;

          case 'response.failed':
            if (event.response?.usage) usage = event.response.usage;
            throw new Error(`OpenAI: ${event.response?.error?.message ?? 'response failed'}`);

          case 'error':
            throw new Error(`OpenAI: ${event.message ?? event.code ?? 'stream error'}`);
        }
      }

      report(events, usage);
      events.onDone(full);
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in, not a failure
      events.onError(err as Error);
      // Whatever OpenAI billed before the failure was still billed.
      report(events, usage);
      // The pipeline still needs to close out the turn.
      events.onDone(full);
    }
  }
}

/**
 * Straight pass-through, because OpenAI already reports the counts the way
 * LlmUsage requires them:
 *
 *   "`outputTokens` INCLUDES `thinkingTokens` ... fold it in — `thinkingTokens`
 *   is a breakdown, not an addend."  `output_tokens_details.reasoning_tokens`
 *   is already inside `output_tokens` (reasoning is billed at the output rate),
 *   so adding it here would double-bill rather than fix anything.
 *
 *   "`inputTokens` INCLUDES `cachedInputTokens`."  `input_tokens_details
 *   .cached_tokens` is likewise already inside `input_tokens`.
 */
function report(events: LlmEvents, usage: ResponseUsage | undefined): void {
  if (!usage || !events.onUsage) return;
  events.onUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.reasoning_tokens || undefined,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens || undefined,
  });
}

/** Yields the payload of each `data:` event from an SSE body. */
async function* sseChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a single event may span lines and
      // carries an `event:` line the payload's own `type` makes redundant.
      let sep: number;
      while ((sep = indexOfBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        // `[DONE]` is the Chat Completions sentinel and is not documented for
        // Responses; skipping it costs nothing and stops a stray one being
        // parsed as an event.
        if (data && data !== '[DONE]') yield data;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function indexOfBoundary(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** `gpt-5.6-luna@none` -> ['gpt-5.6-luna', 'none']; no suffix -> no variant. */
function splitModel(raw: string): [string, Effort | undefined] {
  const at = raw.lastIndexOf('@');
  if (at === -1) return [raw, undefined];
  const model = raw.slice(0, at) || raw;
  // `off` is this repo's spelling (Gemini uses it); OpenAI's word is `none`.
  const suffix = raw.slice(at + 1);
  return [model, (suffix === 'off' ? 'none' : suffix) as Effort];
}

/**
 * No variant means no `reasoning` key at all, so the model's own default stands.
 * A model whose docs describe no reasoning parameter never gets one — the
 * request shape those models accept simply has no such field.
 */
function reasoningFor(model: string, variant: Effort | undefined): Record<string, unknown> {
  if (!variant) return {};
  if (NO_REASONING_PREFIXES.some((p) => model.startsWith(p))) return {};
  return { reasoning: { effort: variant } };
}

/** Pull a human-readable message out of OpenAI's error envelope. */
function extractError(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { error?: { message?: string } };
    return parsed?.error?.message ?? '';
  } catch {
    return payload.slice(0, 200);
  }
}
