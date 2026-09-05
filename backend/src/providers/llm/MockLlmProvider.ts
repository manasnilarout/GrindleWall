import type { LlmEvents, LlmHandle, LlmMessage, LlmOptions, LlmProvider } from '../types.js';

/** Streams a deterministic reply token-by-token with a plausible TTFT. */
export class MockLlmProvider implements LlmProvider {
  readonly id = 'mock-llm';
  readonly name = 'Mock (echo)';

  stream(_opts: LlmOptions, messages: LlmMessage[], events: LlmEvents): LlmHandle {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const reply = `You said: ${lastUser.trim() || '(nothing)'}. This is the mock model replying so you can measure the transport, not the model.`;
    const tokens = reply.split(' ').map((w, i) => (i === 0 ? w : ` ${w}`));

    let i = 0;
    let aborted = false;
    let acc = '';

    const ttft = setTimeout(function next() {
      if (aborted) return;
      if (i >= tokens.length) {
        events.onDone(acc);
        return;
      }
      acc += tokens[i++];
      events.onDelta(tokens[i - 1]);
      setTimeout(next, 12);
    }, 180);

    return {
      abort() {
        aborted = true;
        clearTimeout(ttft);
      },
    };
  }
}
