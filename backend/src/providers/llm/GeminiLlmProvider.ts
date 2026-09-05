import type { LlmEvents, LlmHandle, LlmMessage, LlmOptions, LlmProvider } from '../types.js';

/**
 * Google Gemini streaming LLM.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
 *   header: x-goog-api-key      (never the ?key= query param — keys don't belong in URLs)
 *
 * Reasoning depth is the dominant TTFT factor for a voice loop, so it is part of
 * the selectable model id — `gemini-3.8-flash@off` — and maps to one of two
 * mutually exclusive fields under generationConfig.thinkingConfig:
 *
 *   @minimal|low|medium|high   thinkingConfig.thinkingLevel
 *   @off                       thinkingConfig.thinkingBudget = 0
 *
 * Support is per-MODEL, not per-family, and does not follow the docs. Measured
 * against the live API:
 *
 *   gemini-3.8-flash        thinkingLevel minimal REJECTED; budget 0 works (0 thought tokens)
 *   gemini-3.7-flash        thinkingLevel minimal REJECTED; budget 0 accepted but still thinks
 *   gemini-3.6-flash        minimal works; budget 0 REJECTED
 *   gemini-3.5-flash-lite   minimal works; budget 0 REJECTED
 *   gemini-3.5-flash        both work
 *   gemini-3.1-flash-lite   both work
 *
 * catalog.ts therefore offers only the combinations that actually exist, so an
 * invalid pairing cannot be selected in the UI.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

type ThinkingVariant = 'minimal' | 'low' | 'medium' | 'high' | 'off';

interface GeminiPart {
  text?: string;
  /** Present when the model returns reasoning rather than answer text. */
  thought?: boolean;
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  /**
   * Repeated on every SSE frame with running totals, so the last frame seen is
   * the authoritative count for the request. `candidatesTokenCount` excludes
   * thinking, which Google bills at the same output rate.
   */
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

export class GeminiLlmProvider implements LlmProvider {
  readonly id = 'google-llm';
  readonly name = 'Google Gemini';

  stream(opts: LlmOptions, messages: LlmMessage[], events: LlmEvents): LlmHandle {
    const key = opts.credentials.GOOGLE_API_KEY;
    const controller = new AbortController();

    if (!key) {
      // Report asynchronously so the caller always gets a handle back first.
      queueMicrotask(() => events.onError(new Error('GOOGLE_API_KEY is not set')));
      return { abort: () => controller.abort() };
    }

    const [model, variant] = splitModel(opts.model);
    // Overridable so the SSE handling can be tested against a local fake.
    const base = opts.credentials.GEMINI_BASE_URL ?? DEFAULT_BASE;

    // Gemini expects the system prompt out-of-band, and uses 'model' for assistant turns.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...thinkingFor(variant),
        // Gemini 3 explicitly warns that moving off the default temperature can
        // cause looping or degraded output, so it is only sent when asked for.
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    void this.run(base, model, key, body, controller, events);

    return { abort: () => controller.abort() };
  }

  private async run(
    base: string,
    model: string,
    key: string,
    body: unknown,
    controller: AbortController,
    events: LlmEvents,
  ): Promise<void> {
    let full = '';
    let usage: GeminiChunk['usageMetadata'];
    try {
      const res = await fetch(`${base}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${extractError(detail) || res.statusText}`);
      }

      for await (const payload of sseChunks(res.body, controller.signal)) {
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial frame
        }

        // Totals are cumulative, so later frames supersede earlier ones.
        if (chunk.usageMetadata) usage = chunk.usageMetadata;

        if (chunk.error?.message) throw new Error(`Gemini: ${chunk.error.message}`);
        if (chunk.promptFeedback?.blockReason) {
          throw new Error(`Gemini blocked the prompt (${chunk.promptFeedback.blockReason})`);
        }

        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // Reasoning parts are not speakable; only answer text goes to TTS.
          if (part.thought || !part.text) continue;
          full += part.text;
          events.onDelta(part.text);
        }

        const finish = candidate?.finishReason;
        if (finish && finish !== 'STOP') {
          // MAX_TOKENS / SAFETY / RECITATION — surface it, keep whatever we got.
          events.onError(new Error(`Gemini stopped early: ${finish}`));
        }
      }

      report(events, usage);
      events.onDone(full);
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in, not a failure
      events.onError(err as Error);
      // Whatever Google billed before the failure was still billed.
      report(events, usage);
      // The pipeline still needs to close out the turn.
      events.onDone(full);
    }
  }
}

/**
 * Google reports thinking tokens outside candidatesTokenCount but bills them at
 * the output rate, so they are folded into outputTokens and also surfaced on
 * their own — reasoning depth is the main cost dial on this pipeline.
 */
function report(events: LlmEvents, usage: GeminiChunk['usageMetadata']): void {
  if (!usage || !events.onUsage) return;
  const thinking = usage.thoughtsTokenCount ?? 0;
  events.onUsage({
    inputTokens: usage.promptTokenCount,
    outputTokens: (usage.candidatesTokenCount ?? 0) + thinking,
    thinkingTokens: thinking || undefined,
    cachedInputTokens: usage.cachedContentTokenCount || undefined,
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

      // Events are separated by a blank line; a single event may span lines.
      let sep: number;
      while ((sep = indexOfBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
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

/** `gemini-3.8-flash@off` -> ['gemini-3.8-flash', 'off']. */
function splitModel(raw: string): [string, ThinkingVariant] {
  const at = raw.lastIndexOf('@');
  const model = (at === -1 ? raw : raw.slice(0, at)) || 'gemini-3.8-flash';
  const variant = at === -1 ? 'off' : (raw.slice(at + 1) as ThinkingVariant);
  return [model, variant];
}

/**
 * The variant alone decides the field — the two are mutually exclusive and the
 * API rejects a request carrying both.
 */
function thinkingFor(variant: ThinkingVariant): Record<string, unknown> {
  if (variant === 'off') return { thinkingConfig: { thinkingBudget: 0 } };
  return { thinkingConfig: { thinkingLevel: variant } };
}

/** Pull a human-readable message out of Google's error envelope. */
function extractError(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as GeminiChunk | GeminiChunk[];
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    return one?.error?.message ?? '';
  } catch {
    return payload.slice(0, 200);
  }
}
