/**
 * Stand-ins for the browser pieces `useVoiceSession` drives: the WebSocket, the
 * audio sink and the mic recorder. Each records what it was asked to do and
 * lets a test push events back, so the hook can be exercised end to end with
 * no audio hardware and no network.
 *
 * Registries are module-level and cleared by `resetFakes()` between tests.
 */
import type { ServerMessage } from '../../src/lib/protocol';
import type { RecorderCallbacks } from '../../src/audio/recorder';

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  /** Every frame sent, in order: JSON text frames parsed, binary frames as-is. */
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('send on a socket that is not open');
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /* --- driven by the test --- */

  /** Text frames only, already parsed. */
  get json(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.filter((f): f is { type: string } => typeof f === 'object' && f !== null && 'type' in f);
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverSend(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  serverBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf } as MessageEvent);
  }

  serverError(): void {
    this.onerror?.(new Event('error'));
  }

  serverClose(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

export class FakeAudioSink {
  static instances: FakeAudioSink[] = [];
  /** Set to make the next `resume()` reject, as a suspended AudioContext can. */
  static resumeError: Error | null = null;

  onFirstAudible?: (token: number) => void;
  token = 0;
  enqueued: ArrayBuffer[] = [];
  resumeCalls = 0;
  expectCalls = 0;
  flushCalls = 0;
  closeCalls = 0;

  constructor() {
    FakeAudioSink.instances.push(this);
  }

  get currentToken(): number {
    return this.token;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (FakeAudioSink.resumeError) throw FakeAudioSink.resumeError;
  }

  expectTurn(): void {
    this.expectCalls += 1;
    this.token += 1;
  }

  enqueue(buf: ArrayBuffer): void {
    this.enqueued.push(buf);
  }

  flush(): void {
    this.flushCalls += 1;
    this.token += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  /** What the real sink does from its jitter-buffer timer once audio is audible. */
  becomeAudible(): void {
    this.onFirstAudible?.(this.token);
  }
}

export class FakeMicRecorder {
  static instances: FakeMicRecorder[] = [];
  /** Set to make the next `start()` reject, as a denied permission does. */
  static startError: Error | null = null;

  cb?: RecorderCallbacks;
  startCalls = 0;
  stopCalls = 0;

  constructor() {
    FakeMicRecorder.instances.push(this);
  }

  get sampleRate(): number {
    return 24000;
  }

  async start(cb: RecorderCallbacks): Promise<void> {
    this.startCalls += 1;
    if (FakeMicRecorder.startError) throw FakeMicRecorder.startError;
    this.cb = cb;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

export function resetFakes(): void {
  FakeWebSocket.instances = [];
  FakeAudioSink.instances = [];
  FakeAudioSink.resumeError = null;
  FakeMicRecorder.instances = [];
  FakeMicRecorder.startError = null;
}

export const lastSocket = (): FakeWebSocket => {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('no socket was opened');
  return ws;
};
