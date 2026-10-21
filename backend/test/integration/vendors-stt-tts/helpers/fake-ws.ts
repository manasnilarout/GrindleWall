import { once } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket as ServerSocket } from 'ws';

/** How long any single awaited condition may take before the test fails loudly. */
export const WAIT_MS = 5000;

export interface Frame {
  text?: string;
  binary?: Buffer;
  /** Parsed `text`, when it is JSON. */
  json?: any;
}

/** One client connection, as the fake vendor sees it. */
export class FakeConn {
  readonly frames: Frame[] = [];
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly socket: ServerSocket,
    req: IncomingMessage,
  ) {
    this.url = new URL(req.url ?? '/', 'http://fake');
    this.headers = req.headers;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (isBinary) this.frames.push({ binary: Buffer.from(buf) });
      else {
        const text = buf.toString();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        this.frames.push({ text, json });
      }
      this.notify();
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.notify();
      });
    });
  }

  /** Path with the redirected vendor host as its first segment. */
  get path(): string {
    return this.url.pathname;
  }

  get query(): URLSearchParams {
    return this.url.searchParams;
  }

  /** Parsed JSON text frames, in arrival order. */
  get json(): any[] {
    return this.frames.filter((f) => f.json !== undefined).map((f) => f.json);
  }

  get binaries(): Buffer[] {
    return this.frames.filter((f) => f.binary).map((f) => f.binary as Buffer);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Resolves once `cond` holds over the frames received so far. */
  until<T>(cond: () => T | undefined | false, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const v = cond();
        if (v !== undefined && v !== false) {
          this.listeners.delete(check);
          clearTimeout(timer);
          resolve(v as T);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`fake: timed out waiting for ${label}; got ${JSON.stringify(this.frames.map((f) => f.text ?? `<${f.binary?.length}b>`))}`));
      }, WAIT_MS);
      this.listeners.add(check);
      check();
    });
  }

  /** Waits for the n-th frame (1-based) matching `pred`. */
  waitFor(pred: (f: Frame) => boolean, label: string, n = 1): Promise<Frame> {
    return this.until(() => {
      const hits = this.frames.filter(pred);
      return hits.length >= n ? hits[n - 1] : undefined;
    }, label);
  }

  waitForJson(pred: (m: any) => boolean, label: string, n = 1): Promise<any> {
    return this.waitFor((f) => f.json !== undefined && pred(f.json), label, n).then((f) => f.json);
  }

  waitForFrames(n: number): Promise<Frame> {
    return this.waitFor(() => true, `${n} frames`, n);
  }

  /**
   * A ping round trip. When it resolves, every frame the client wrote before it
   * read the ping has been received here — the deterministic way to assert that
   * something was NOT sent, without sleeping.
   */
  async sync(): Promise<void> {
    const pong = once(this.socket, 'pong');
    this.socket.ping();
    await pong;
  }

  send(obj: unknown): void {
    this.socket.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  sendBinary(buf: Buffer): void {
    this.socket.send(buf, { binary: true });
  }
}

export interface FakeWsServer {
  port: number;
  /** `ws://127.0.0.1:<port>` — for providers that take a base URL in credentials. */
  base: string;
  connections: FakeConn[];
  /** Resolves with the next connection that has not yet been handed out. */
  nextConnection(): Promise<FakeConn>;
  /** Refuse the upgrade with this HTTP status, until cleared. */
  rejectWith: { status: number; message: string } | null;
  close(): Promise<void>;
}

export async function startFakeWs(): Promise<FakeWsServer> {
  const connections: FakeConn[] = [];
  let handedOut = 0;
  const waiters: Array<() => void> = [];

  const server: FakeWsServer = {
    port: 0,
    base: '',
    connections,
    rejectWith: null,
    nextConnection() {
      const idx = handedOut++;
      return new Promise<FakeConn>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fake: no connection arrived')), WAIT_MS);
        const check = () => {
          if (connections[idx]) {
            clearTimeout(timer);
            resolve(connections[idx]);
            return true;
          }
          return false;
        };
        if (!check()) waiters.push(() => void check());
      });
    },
    async close() {
      for (const c of connections) c.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, cb) => {
      if (server.rejectWith) cb(false, server.rejectWith.status, server.rejectWith.message);
      else cb(true);
    },
  });
  wss.on('connection', (socket, req) => {
    connections.push(new FakeConn(socket, req));
    for (const w of waiters.splice(0)) w();
  });
  await once(wss, 'listening');
  server.port = (wss.address() as { port: number }).port;
  server.base = `ws://127.0.0.1:${server.port}`;
  return server;
}
