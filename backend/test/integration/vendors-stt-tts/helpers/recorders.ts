import type { SttEvents, TtsEvents } from '../../../../src/providers/types.js';
import { WAIT_MS } from './fake-ws.js';

/** A fake key distinctive enough that any leak of it is unmistakable. */
export const FAKE_KEY = 'sk-test-DO-NOT-LEAK-9f3a1c';

type Entry = { type: string; value?: unknown };

class Log {
  readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();

  push(type: string, value?: unknown): void {
    this.entries.push({ type, value });
    for (const l of [...this.listeners]) l();
  }

  of(type: string): unknown[] {
    return this.entries.filter((e) => e.type === type).map((e) => e.value);
  }

  /** Resolves once at least `n` entries of `type` have been recorded. */
  waitFor(type: string, n = 1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.of(type).length >= n) {
          this.listeners.delete(check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timed out waiting for ${n}x ${type}; log: ${JSON.stringify(this.entries.map((e) => e.type))}`));
      }, WAIT_MS);
      this.listeners.add(check);
      check();
    });
  }
}

export function ttsRecorder() {
  const log = new Log();
  const events: TtsEvents = {
    onAudio: (chunk) => log.push('audio', Buffer.from(chunk)),
    onDone: () => log.push('done'),
    onError: (err) => log.push('error', err),
  };
  return {
    events,
    log,
    get audio(): Buffer[] {
      return log.of('audio') as Buffer[];
    },
    get bytes(): number {
      return (log.of('audio') as Buffer[]).reduce((n, b) => n + b.length, 0);
    },
    get done(): number {
      return log.of('done').length;
    },
    get errors(): string[] {
      return (log.of('error') as Error[]).map((e) => e.message);
    },
    waitAudio: (n = 1) => log.waitFor('audio', n),
    waitDone: () => log.waitFor('done'),
    waitError: (n = 1) => log.waitFor('error', n),
  };
}

export function sttRecorder() {
  const log = new Log();
  const events: Required<SttEvents> = {
    onPartial: (t) => log.push('partial', t),
    onFinal: (t) => log.push('final', t),
    onSpeechEnd: () => log.push('speechEnd'),
    onError: (err) => log.push('error', err),
  };
  return {
    events,
    log,
    get partials(): string[] {
      return log.of('partial') as string[];
    },
    get finals(): string[] {
      return log.of('final') as string[];
    },
    get speechEnds(): number {
      return log.of('speechEnd').length;
    },
    get errors(): string[] {
      return (log.of('error') as Error[]).map((e) => e.message);
    },
    /** Event types in order, for asserting e.g. that speech end precedes the final. */
    get order(): string[] {
      return log.entries.map((e) => e.type);
    },
    waitPartial: (n = 1) => log.waitFor('partial', n),
    waitFinal: (n = 1) => log.waitFor('final', n),
    waitSpeechEnd: (n = 1) => log.waitFor('speechEnd', n),
    waitError: (n = 1) => log.waitFor('error', n),
  };
}

/** PCM16 LE where every sample is `value` — survives linear resampling unchanged. */
export function constPcm(samples: number, value: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

/** A PCM16 ramp, so byte-exact pass-through is distinguishable from any transform. */
export function rampPcm(samples: number, start = 0): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((start + i * 37) % 60000) - 30000, i * 2);
  return b;
}

/** Wraps PCM in a canonical 44-byte RIFF/WAVE header plus an extra LIST chunk. */
export function wav(pcm: Buffer, sampleRate = 24000, withList = false): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const list = withList ? Buffer.concat([Buffer.from('LIST'), u32(4), Buffer.from('INFO')]) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from('RIFF'),
    u32(36 + list.length + pcm.length),
    Buffer.from('WAVE'),
    Buffer.from('fmt '),
    u32(16),
    fmt,
    list,
    Buffer.from('data'),
    u32(pcm.length),
    pcm,
  ]);
}

/** Every error message a recorder saw, checked for the fake key. */
export function leaksKey(messages: string[]): boolean {
  return messages.some((m) => m.includes(FAKE_KEY) || m.includes(encodeURIComponent(FAKE_KEY)));
}
