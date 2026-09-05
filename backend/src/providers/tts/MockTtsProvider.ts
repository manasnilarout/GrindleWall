import type { TtsEvents, TtsOptions, TtsProvider, TtsStream } from '../types.js';
import { silence, tone } from '../../audio/pcm.js';

const FRAME_MS = 40;

/**
 * One short blip per word, emitted in 40ms frames on a real timer so the
 * client-side jitter buffer and barge-in behave like they will with a real vendor.
 */
export class MockTtsProvider implements TtsProvider {
  readonly id = 'mock-tts';
  readonly name = 'Mock (tone)';

  async open(opts: TtsOptions, events: TtsEvents): Promise<TtsStream> {
    let pending = '';
    let flushed = false;
    let cancelled = false;
    let draining = false;
    const queue: Buffer[] = [];
    let word = 0;

    const enqueueWords = (chunk: string) => {
      for (const w of chunk.split(/\s+/).filter(Boolean)) {
        const freq = 180 + ((word++ * 37) % 160);
        queue.push(tone(Math.min(240, 60 + w.length * 22), freq, opts.sampleRate));
        queue.push(silence(50, opts.sampleRate));
      }
    };

    const drain = () => {
      if (draining || cancelled) return;
      draining = true;
      const pump = () => {
        if (cancelled) {
          draining = false;
          return;
        }
        const next = queue.shift();
        if (!next) {
          draining = false;
          if (flushed) events.onDone();
          return;
        }
        // slice into frames so the client receives a steady stream
        for (let off = 0; off < next.length; off += FRAME_MS * (opts.sampleRate / 1000) * 2) {
          events.onAudio(next.subarray(off, Math.min(next.length, off + FRAME_MS * (opts.sampleRate / 1000) * 2)));
        }
        setTimeout(pump, FRAME_MS);
      };
      // simulate vendor TTFB
      setTimeout(pump, 90);
    };

    return {
      pushText(text) {
        if (cancelled) return;
        pending += text;
        // only synthesise on word boundaries, like a real streaming TTS socket
        const cut = pending.lastIndexOf(' ');
        if (cut > 0) {
          enqueueWords(pending.slice(0, cut));
          pending = pending.slice(cut);
          drain();
        }
      },
      flush() {
        if (cancelled) return;
        flushed = true;
        if (pending.trim()) enqueueWords(pending);
        pending = '';
        drain();
        if (!draining) events.onDone();
      },
      cancel() {
        cancelled = true;
        queue.length = 0;
      },
      close() {
        cancelled = true;
        queue.length = 0;
      },
    };
  }
}
