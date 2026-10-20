/**
 * Shared fakes and a recording SessionEvents for the providers-core suite.
 *
 * The fakes implement the slot interfaces in src/providers/types.ts and do
 * nothing on their own: every event is fired by the test, so a turn boundary
 * can be broken on purpose — something the mock providers, which run on their
 * own timers, cannot express.
 */
import { vi } from 'vitest';
import type {
  Credentials,
  LlmEvents,
  LlmMessage,
  LlmOptions,
  LlmProvider,
  LlmUsage,
  SessionEvents,
  SttEvents,
  SttOptions,
  SttProvider,
  TtsEvents,
  TtsOptions,
  TtsProvider,
} from '../../../src/providers/types.js';
import { PipelineSession } from '../../../src/pipeline/PipelineSession.js';
import {
  CANONICAL_SAMPLE_RATE,
  type DerivedMetrics,
  type LegUsage,
  type MetricMark,
  type StartConfig,
} from '../../../src/shared/protocol.js';

/* --------------------------------- audio --------------------------------- */

export const SR = CANONICAL_SAMPLE_RATE;
/** PCM16 mono bytes per second at the canonical rate. */
export const BYTES_PER_SECOND = SR * 2;

/** Digital silence of the given length at `rate`. */
export const quiet = (seconds: number, rate = SR) => Buffer.alloc(Math.round(seconds * rate) * 2);

/** A full-scale-ish square wave: comfortably above every energy threshold here. */
export function loud(seconds: number, rate = SR): Buffer {
  const buf = quiet(seconds, rate);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(i % 2 ? 12000 : -12000, i * 2);
  return buf;
}

/* --------------------------------- timers -------------------------------- */

export function useFakeClock() {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
      'hrtime',
      'performance',
    ],
  });
}

/** Drains pending microtasks (promise continuations) without moving the clock. */
export async function tick(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/* ------------------------------ event recorder ------------------------------ */

export type LoggedEvent =
  | { type: 'user'; text: string; final: boolean; turnId: number }
  | { type: 'assistant'; text: string; final: boolean; turnId: number }
  | { type: 'audio'; bytes: number }
  | { type: 'turn_start'; turnId: number }
  | { type: 'turn_end'; turnId: number }
  | { type: 'interrupt' }
  | { type: 'metrics'; turnId: number }
  | { type: 'usage'; turnId: number }
  | { type: 'log'; level: string; message: string }
  | { type: 'error'; message: string };

/** A SessionEvents that keeps everything, in order. */
export class Recorder implements SessionEvents {
  readonly log: LoggedEvent[] = [];
  readonly audio: Buffer[] = [];
  readonly metrics: Array<{ turnId: number; marks: MetricMark[]; derived: DerivedMetrics }> = [];
  readonly usage: Array<{ turnId: number; legs: LegUsage[] }> = [];
  readonly errors: Error[] = [];
  /** Hook run inside onInterrupt, to observe state at that exact moment. */
  onInterruptHook?: () => void;

  onUserTranscript = (text: string, final: boolean, turnId: number) => {
    this.log.push({ type: 'user', text, final, turnId });
  };
  onAssistantTranscript = (text: string, final: boolean, turnId: number) => {
    this.log.push({ type: 'assistant', text, final, turnId });
  };
  onAudio = (chunk: Buffer) => {
    this.audio.push(chunk);
    this.log.push({ type: 'audio', bytes: chunk.length });
  };
  onTurnStart = (turnId: number) => {
    this.log.push({ type: 'turn_start', turnId });
  };
  onTurnEnd = (turnId: number) => {
    this.log.push({ type: 'turn_end', turnId });
  };
  onInterrupt = () => {
    this.onInterruptHook?.();
    this.log.push({ type: 'interrupt' });
  };
  onMetrics = (turnId: number, marks: MetricMark[], derived: DerivedMetrics) => {
    this.metrics.push({ turnId, marks, derived });
    this.log.push({ type: 'metrics', turnId });
  };
  onUsage = (turnId: number, legs: LegUsage[]) => {
    this.usage.push({ turnId, legs });
    this.log.push({ type: 'usage', turnId });
  };
  onLog = (level: 'info' | 'warn' | 'error', message: string) => {
    this.log.push({ type: 'log', level, message });
  };
  onError = (err: Error) => {
    this.errors.push(err);
    this.log.push({ type: 'error', message: err.message });
  };

  of<T extends LoggedEvent['type']>(type: T): Array<Extract<LoggedEvent, { type: T }>> {
    return this.log.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);
  }
  /** Event types in order, minus the noisy ones. */
  sequence(skip: Array<LoggedEvent['type']> = ['audio', 'log', 'assistant', 'user']): string[] {
    return this.log.filter((e) => !skip.includes(e.type)).map((e) => ('turnId' in e ? `${e.type}:${e.turnId}` : e.type));
  }
  get interrupts() {
    return this.of('interrupt').length;
  }
  get turnStarts() {
    return this.of('turn_start').map((e) => e.turnId);
  }
  get turnEnds() {
    return this.of('turn_end').map((e) => e.turnId);
  }
}

export const leg = (u: { legs: LegUsage[] } | undefined, name: LegUsage['leg']) => u?.legs.find((l) => l.leg === name);
export const sttSeconds = (u: { legs: LegUsage[] } | undefined) => leg(u, 'stt')?.inputUnits;
export const markNames = (m: { marks: MetricMark[] }) => m.marks.map((x) => x.name);
export const markAt = (m: { marks: MetricMark[] }, name: MetricMark['name']) => m.marks.find((x) => x.name === name)?.atMs;

/* ------------------------------- fake STT ------------------------------- */

export interface FakeSttControl {
  opens: number;
  opts?: SttOptions;
  pushed: Buffer[];
  finalizes: number;
  closes: number;
  /** The events PipelineSession handed to open(). Throws until opened. */
  readonly ev: SttEvents;
}

export function fakeStt(id = 'fake-stt'): { provider: SttProvider; ctl: FakeSttControl } {
  let events: SttEvents | undefined;
  const ctl: FakeSttControl = {
    opens: 0,
    pushed: [],
    finalizes: 0,
    closes: 0,
    get ev(): SttEvents {
      if (!events) throw new Error('fake STT was never opened');
      return events;
    },
  };
  const provider: SttProvider = {
    id,
    name: 'Fake STT',
    async open(opts, ev) {
      ctl.opens += 1;
      ctl.opts = opts;
      events = ev;
      return {
        pushAudio: (chunk) => void ctl.pushed.push(chunk),
        finalize: () => void (ctl.finalizes += 1),
        close: () => void (ctl.closes += 1),
      };
    },
  };
  return { provider, ctl };
}

/* ------------------------------- fake LLM ------------------------------- */

export interface LlmCall {
  opts: LlmOptions;
  /** A copy taken at call time — the live array is the session's own history. */
  messages: LlmMessage[];
  ev: LlmEvents;
  aborts: number;
  /** Convenience: stream `deltas`, optionally report usage, then finish. */
  reply(deltas: string[], usage?: LlmUsage, full?: string): void;
}

export interface FakeLlmOptions {
  /** Throw synchronously from stream(). */
  throwOnStream?: Error;
}

export function fakeLlm(id = 'fake-llm', o: FakeLlmOptions = {}): { provider: LlmProvider; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const provider: LlmProvider = {
    id,
    name: 'Fake LLM',
    stream(opts, messages, ev) {
      if (o.throwOnStream) throw o.throwOnStream;
      const call: LlmCall = {
        opts,
        messages: messages.map((m) => ({ ...m })),
        ev,
        aborts: 0,
        reply(deltas, usage, full) {
          for (const d of deltas) ev.onDelta(d);
          if (usage) ev.onUsage?.(usage);
          ev.onDone(full ?? deltas.join(''));
        },
      };
      calls.push(call);
      return { abort: () => void (call.aborts += 1) };
    },
  };
  return { provider, calls };
}

/* ------------------------------- fake TTS ------------------------------- */

export interface TtsCall {
  opts: TtsOptions;
  ev: TtsEvents;
  texts: string[];
  flushes: number;
  cancels: number;
  closes: number;
}

export interface FakeTtsOptions {
  /** Reject open() with this error. */
  openError?: Error;
  /** Provide billableCharacters(); called with the call record. */
  billable?: (call: TtsCall) => number;
  /** Call onDone automatically on flush(). */
  doneOnFlush?: boolean;
  /** Resolve open() only after this many ms (a vendor handshake). */
  openDelayMs?: number;
}

export function fakeTts(id = 'fake-tts', o: FakeTtsOptions = {}): { provider: TtsProvider; calls: TtsCall[] } {
  const calls: TtsCall[] = [];
  const provider: TtsProvider = {
    id,
    name: 'Fake TTS',
    async open(opts, ev) {
      if (o.openDelayMs) await new Promise((r) => setTimeout(r, o.openDelayMs));
      if (o.openError) throw o.openError;
      const call: TtsCall = { opts, ev, texts: [], flushes: 0, cancels: 0, closes: 0 };
      calls.push(call);
      return {
        pushText: (t) => void call.texts.push(t),
        flush: () => {
          call.flushes += 1;
          if (o.doneOnFlush) ev.onDone();
        },
        cancel: () => void (call.cancels += 1),
        close: () => void (call.closes += 1),
        ...(o.billable ? { billableCharacters: () => o.billable!(call) } : {}),
      };
    },
  };
  return { provider, calls };
}

/* ------------------------------ session builder ------------------------------ */

export interface Harness {
  session: PipelineSession;
  rec: Recorder;
  stt: FakeSttControl;
  llm: LlmCall[];
  tts: TtsCall[];
  credentials: Credentials;
}

export function pipeline(
  o: {
    config?: Partial<StartConfig>;
    llm?: FakeLlmOptions;
    tts?: FakeTtsOptions;
    models?: { stt?: string; llm?: string; tts?: string };
  } = {},
): Harness {
  const s = fakeStt();
  const l = fakeLlm('fake-llm', o.llm);
  const t = fakeTts('fake-tts', o.tts);
  const rec = new Recorder();
  const credentials: Credentials = { FAKE_KEY: 'secret' };
  const config: StartConfig = {
    mode: 'pipeline',
    systemPrompt: 'Be brief.',
    turnDetection: 'server_vad',
    ...o.config,
  };
  const session = new PipelineSession('sess-1', { sessionId: 'sess-1', config, events: rec, credentials }, {
    stt: s.provider,
    sttModel: o.models?.stt ?? 'stt-m',
    llm: l.provider,
    llmModel: o.models?.llm ?? 'llm-m',
    tts: t.provider,
    ttsModel: o.models?.tts ?? 'tts-m',
  });
  return { session, rec, stt: s.ctl, llm: l.calls, tts: t.calls, credentials };
}

/**
 * Starts a turn from text and waits for TTS open + LLM stream to be wired.
 * Returns that turn's LLM and TTS call records.
 */
export async function textTurn(h: Harness, text: string): Promise<{ llm: LlmCall; tts: TtsCall }> {
  const l0 = h.llm.length;
  const t0 = h.tts.length;
  h.session.sendText(text);
  await tick();
  return { llm: h.llm[l0], tts: h.tts[t0] };
}

/** Same, but driven by the STT leg's VAD: speech end, then a final transcript. */
export async function spokenTurn(h: Harness, text: string, seconds = 1): Promise<{ llm: LlmCall; tts: TtsCall }> {
  const l0 = h.llm.length;
  const t0 = h.tts.length;
  h.session.pushAudio(quiet(seconds));
  h.stt.ev.onSpeechEnd!();
  h.stt.ev.onFinal(text);
  await tick();
  return { llm: h.llm[l0], tts: h.tts[t0] };
}
