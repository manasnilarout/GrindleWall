import type { SttEvents, SttOptions, SttProvider, SttStream } from '../types.js';
import { pcm16DurationMs, rms } from '../../audio/pcm.js';

const CANNED = [
  'What is the weather like today',
  'Tell me a short joke about latency',
  'Can you summarise that in one sentence',
  'How long does it take you to respond',
];

/**
 * No network. Fakes endpointing off frame energy so the whole pipeline —
 * VAD, turn boundaries, barge-in — can be exercised without any API keys.
 */
export class MockSttProvider implements SttProvider {
  readonly id = 'mock-stt';
  readonly name = 'Mock (canned)';

  async open(opts: SttOptions, events: SttEvents): Promise<SttStream> {
    let bytes = 0;
    let silentMs = 0;
    let sawSpeech = false;
    let closed = false;
    let partialTimer: NodeJS.Timeout | undefined;
    const text = CANNED[Math.floor(Math.random() * CANNED.length)];

    const emitFinal = () => {
      if (closed) return;
      clearTimeout(partialTimer);
      events.onFinal(sawSpeech ? text : '');
      bytes = 0;
      silentMs = 0;
      sawSpeech = false;
    };

    return {
      pushAudio(chunk) {
        if (closed) return;
        bytes += chunk.length;
        const chunkMs = pcm16DurationMs(chunk.length, opts.sampleRate);

        if (rms(chunk) > 0.01) {
          if (!sawSpeech) {
            sawSpeech = true;
            // fake incremental recognition
            partialTimer = setTimeout(() => events.onPartial(text.split(' ').slice(0, 3).join(' ')), 250);
          }
          silentMs = 0;
        } else if (sawSpeech) {
          silentMs += chunkMs;
          if (opts.vad && silentMs > 600) {
            events.onSpeechEnd?.();
            emitFinal();
          }
        }
      },
      finalize() {
        if (bytes === 0 && !sawSpeech) {
          events.onFinal('');
          return;
        }
        sawSpeech = true;
        emitFinal();
      },
      close() {
        closed = true;
        clearTimeout(partialTimer);
      },
    };
  }
}
