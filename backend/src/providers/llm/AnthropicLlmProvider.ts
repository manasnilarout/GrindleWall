import type { LlmEvents, LlmHandle, LlmMessage, LlmOptions, LlmProvider } from '../types.js';

/**
 * Anthropic Claude streaming LLM — wired for the Haiku tier.
 *
 *   POST https://api.anthropic.com/v1/messages   { "stream": true }
 *   headers: x-api-key: <ANTHROPIC_API_KEY>   (never a query param — keys don't belong in URLs)
 *            anthropic-version: 2023-06-01
 *
 * UNVERIFIED. Added 2026-10-25 with no ANTHROPIC_API_KEY in this repo, so this
 * provider has NEVER completed a live call. Every request field and event shape
 * below is read off Anthropic's own docs (streaming, pricing and the Haiku 5.5
 * migration guide, all read 2026-10-25), and `scripts/anthropic-llm-selftest.ts`
 * runs against a fake written from those same docs — it proves our parsing and
 * nothing about what Anthropic accepts. The live checks are `npm run models`
 * (model ids exist, free) and `scripts/smoke.mjs pipeline` with
 * LLM=anthropic-llm; run both before quoting anything here as measured.
 *
 * Raw fetch rather than `@anthropic-ai/sdk`, for the same reason as the OpenAI
 * and Gemini legs: the SDK retries 429/5xx on its own by default, which would
 * fold a hidden retry into the measured TTFT, and it reads ANTHROPIC_BASE_URL
 * from the process environment — which Claude Code itself sets — so a bench run
 * could silently route through a gateway. The base URL override here is
 * ANTHROPIC_LLM_BASE_URL for exactly that reason; it exists so the SSE handling
 * can be tested against a local fake.
 *
 * Reasoning depth rides in the model id as an `@variant` suffix, the same
 * convention as `gemini-3.8-flash@off` and `gpt-5.6-luna@none`:
 *
 *   claude-haiku-5-5@off      thinking: { type: "disabled" }   (effort left at its default)
 *   claude-haiku-5-5@low      output_config: { effort: "low" }   (adaptive thinking)
 *   claude-haiku-5-5@medium   output_config: { effort: "medium" } — the model's own default
 *   claude-haiku-4-5          no variant, nothing sent — effort is not a Haiku 4.5 parameter
 *
 * Per the Haiku 5.5 migration guide (docs only — UNVERIFIED here): thinking is ON
 * by default, `{type: "disabled"}` is accepted at effort low/medium/high and is a
 * 400 at xhigh/max, and effort defaults to `medium`. The provider never combines
 * `@off` with an effort, so it cannot produce the documented 400 pairing.
 *
 * Sampling parameters are NEVER sent, even when the caller passes a temperature.
 * Haiku 5.5 answers 400 to any non-default `temperature`/`top_p`/`top_k`, and on
 * API version 2026-10-21 every model does; a bench whose only job is comparing
 * vendors on equal terms is better served by the vendor default than by a
 * setting that works on one model and fails the turn on the next.
 */

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

/**
 * `max_tokens` is REQUIRED by the Messages API, unlike every other LLM here. A
 * spoken reply is a few dozen tokens, but on Haiku 5.5 adaptive thinking counts
 * toward the same cap and a response that spends it all on thinking stops with
 * no text at all — so the cap leaves generous room rather than sizing for the
 * answer. Barge-in aborts long before it matters.
 */
const DEFAULT_MAX_TOKENS = 16_000;

type Variant = 'off' | 'low' | 'medium' | 'high';

/** Models whose docs describe no `effort` parameter and thinking only by budget. */
const NO_EFFORT_PREFIXES = ['claude-haiku-4-5'];

/**
 * Anthropic's `usage`. Unlike OpenAI's, the cache counts are NOT inside
 * `input_tokens`: the three input fields are disjoint and sum to the prompt
 * (the pricing page: "A request's prompt length counts all of its input tokens,
 * including cache reads and cache writes"). Thinking is billed as output and is
 * already inside `output_tokens`; no separate thinking count is published.
 */
interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number;
}

interface StreamEvent {
  type?: string;
  /** message_start */
  message?: { usage?: MessageUsage };
  /** content_block_start */
  content_block?: { type?: string };
  /** content_block_delta (`text_delta` | `thinking_delta` | `signature_delta` | …) and message_delta */
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
    stop_details?: { category?: string | null; explanation?: string | null } | null;
  };
  /** message_delta — CUMULATIVE counts, per the streaming docs. */
  usage?: MessageUsage;
  /** type: "error" — a mid-stream failure, e.g. overloaded_error. */
  error?: { type?: string; message?: string };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = 'anthropic-llm';
  readonly name = 'Anthropic Claude';

  stream(opts: LlmOptions, messages: LlmMessage[], events: LlmEvents): LlmHandle {
    const key = opts.credentials.ANTHROPIC_API_KEY;
    const controller = new AbortController();

    if (!key) {
      // Report asynchronously so the caller always gets a handle back first.
      queueMicrotask(() => events.onError(new Error('ANTHROPIC_API_KEY is not set')));
      return { abort: () => controller.abort() };
    }

    const [model, variant] = splitModel(opts.model);
    const base = opts.credentials.ANTHROPIC_LLM_BASE_URL || DEFAULT_BASE;

    // The system prompt is a top-level field, and `messages` must alternate
    // user/assistant starting with a user turn — which the pipeline's history
    // already does.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages: transcript,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...reasoningFor(model, variant),
    };
    if (system) body.system = system;

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
    let usage: MessageUsage | undefined;
    try {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${extractError(detail) || res.statusText}`);
      }

      for await (const payload of sseChunks(res.body, controller.signal)) {
        let event: StreamEvent;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // partial or malformed frame
        }

        switch (event.type) {
          case 'message_start':
            // Input counts land here and only here (unless message_delta repeats them).
            if (event.message?.usage) usage = mergeUsage(usage, event.message.usage);
            break;

          case 'content_block_delta': {
            // The only speakable stream. `thinking_delta` / `signature_delta`
            // belong to thinking blocks and must never reach TTS.
            if (event.delta?.type !== 'text_delta') break;
            const text = event.delta.text;
            if (!text) break;
            full += text;
            events.onDelta(text);
            break;
          }

          case 'message_delta': {
            // Counts here are cumulative, so they overwrite rather than add.
            if (event.usage) usage = mergeUsage(usage, event.usage);
            const stop = event.delta?.stop_reason;
            if (stop === 'max_tokens') {
              // Surface it, keep what we got — same posture as OpenAI's incomplete.
              events.onError(new Error('Anthropic stopped early: max_tokens'));
            } else if (stop === 'refusal') {
              const category = event.delta?.stop_details?.category;
              events.onError(new Error(`Anthropic declined the request${category ? ` (${category})` : ''}`));
            }
            break;
          }

          case 'error':
            throw new Error(`Anthropic: ${event.error?.message ?? event.error?.type ?? 'stream error'}`);

          // message_stop, content_block_start/stop and ping carry nothing we need.
        }
      }

      // An abort ends the loop like completion does; it must not report as one.
      if (controller.signal.aborted) return;
      report(events, usage);
      events.onDone(full);
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in, not a failure
      events.onError(err as Error);
      // Whatever Anthropic billed before the failure was still billed.
      report(events, usage);
      // The pipeline still needs to close out the turn.
      events.onDone(full);
    }
  }
}

/** Later frames win field by field; a missing or null field keeps the earlier value. */
function mergeUsage(prev: MessageUsage | undefined, next: MessageUsage): MessageUsage {
  const out: MessageUsage = { ...prev };
  for (const k of Object.keys(next) as Array<keyof MessageUsage>) {
    const v = next[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/**
 * Translates Anthropic's disjoint input fields into LlmUsage's containment rule
 * ("`inputTokens` INCLUDES `cachedInputTokens`"). Passing `input_tokens` through
 * unchanged — as the OpenAI leg rightly does with its own field — would leave
 * cache reads out of the total entirely, and pricing would then subtract them
 * from a number they were never in.
 *
 * Cache WRITES are folded into inputTokens at the plain input rate. Anthropic
 * bills them at 1.25x, which `Rate` has no slot for, so a write is understated
 * by a quarter. This provider never sends `cache_control`, so no write should
 * occur; if one ever shows up, the number is low, not missing.
 */
function report(events: LlmEvents, usage: MessageUsage | undefined): void {
  if (!usage || !events.onUsage) return;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens === undefined ? undefined : usage.input_tokens + read + write;
  events.onUsage({
    inputTokens: input,
    outputTokens: usage.output_tokens,
    cachedInputTokens: read || undefined,
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

      // Events are separated by a blank line; the `event:` line repeats the
      // payload's own `type`, so only `data:` is read.
      let sep: number;
      // Re-checked per event: abort() may be called from inside a callback,
      // and the rest of this buffer must not be delivered after it.
      while (!signal.aborted && (sep = indexOfBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data) yield data;
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

/** `claude-haiku-5-5@off` -> ['claude-haiku-5-5', 'off']; no suffix -> no variant. */
function splitModel(raw: string): [string, Variant | undefined] {
  const at = raw.lastIndexOf('@');
  if (at === -1) return [raw, undefined];
  const model = raw.slice(0, at) || raw;
  // `none` is OpenAI's spelling of this repo's `off`.
  const suffix = raw.slice(at + 1);
  return [model, (suffix === 'none' ? 'off' : suffix) as Variant];
}

/**
 * No variant means neither `thinking` nor `output_config`, so the model's own
 * defaults stand. A model documented with no effort parameter never gets one.
 */
function reasoningFor(model: string, variant: Variant | undefined): Record<string, unknown> {
  if (!variant) return {};
  if (NO_EFFORT_PREFIXES.some((p) => model.startsWith(p))) return {};
  if (variant === 'off') return { thinking: { type: 'disabled' } };
  return { output_config: { effort: variant } };
}

/** Pull a human-readable message out of Anthropic's `{type:"error", error:{type, message}}` envelope. */
function extractError(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { error?: { message?: string } };
    return parsed?.error?.message ?? '';
  } catch {
    return payload.slice(0, 200);
  }
}
