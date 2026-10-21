/**
 * Shared local fakes for the realtime + LLM vendor adapter tests.
 *
 * Everything binds 127.0.0.1 on an ephemeral port. These fakes are written from
 * the same docs as the providers, so a green run proves this repo's request
 * building and event handling — never what a vendor accepts.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';
import { WebSocketServer, type ServerOptions, type WebSocket as ServerSocket } from 'ws';
import type { SessionEvents } from '../../../src/providers/types.js';
import type { DerivedMetrics, LegUsage, MetricMark } from '../../../src/shared/protocol.js';

export type Json = Record<string, any>;

/* ------------------------------------------------------------------ waiting */

/**
 * Resolves once `pred` holds. Polls on a short timer rather than sleeping a
 * fixed interval, so a test waits exactly as long as the condition takes.
 */
export async function waitFor(pred: () => boolean, what = 'condition', timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Lets every already-queued I/O callback and microtask run. */
export const flushIo = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

/* ---------------------------------------------------------------- HTTP / SSE */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export interface FakeHttp {
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** Responses currently open, so a test can wait for the client to hang up. */
  readonly closedResponses: number;
  handle(fn: HttpHandler): void;
  close(): Promise<void>;
}

export async function startHttp(): Promise<FakeHttp> {
  let handler: HttpHandler = (_q, res) => {
    res.writeHead(500);
    res.end();
  };
  const requests: RecordedRequest[] = [];
  let closedResponses = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      let body: any = undefined;
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave undefined */
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw, body });
      res.on('close', () => (closedResponses += 1));
      handler(req, res, raw);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    get closedResponses() {
      return closedResponses;
    },
    handle(fn) {
      handler = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Writes `chunks` as separate TCP writes, each waiting for the previous to flush. */
export async function writeEach(res: ServerResponse, chunks: Array<string | Buffer>): Promise<void> {
  for (const c of chunks) {
    await new Promise<void>((resolve, reject) => res.write(c, (err) => (err ? reject(err) : resolve())));
    // A separate macrotask between writes keeps Nagle-free loopback from
    // coalescing them into a single read on the client side.
    await new Promise((r) => setImmediate(r));
  }
}

/** Splits a string into pieces of at most `n` BYTES — deliberately mid-codepoint. */
export function byteSlices(s: string, n: number): Buffer[] {
  const b = Buffer.from(s, 'utf8');
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
  return out;
}

/* --------------------------------------------------------------- WebSocket */

export interface FakeWs {
  readonly url: string;
  readonly received: Json[];
  readonly rawReceived: string[];
  readonly connections: Array<{ url: string; headers: IncomingHttpHeaders }>;
  /** The most recent server-side socket. */
  socket(): ServerSocket;
  push(event: Json): void;
  pushRaw(frame: string): void;
  /** Called for every parsed client message; return value ignored. */
  onMessage(fn: (msg: Json, ws: ServerSocket) => void): void;
  readonly closedSockets: number;
  close(): Promise<void>;
}

export async function startWs(opts: { path?: string; verifyClient?: ServerOptions['verifyClient'] } = {}): Promise<FakeWs> {
  const received: Json[] = [];
  const rawReceived: string[] = [];
  const connections: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  let current: ServerSocket | undefined;
  let listener: (msg: Json, ws: ServerSocket) => void = () => {};
  let closedSockets = 0;

  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(opts.verifyClient ? { verifyClient: opts.verifyClient } : {}),
  });
  wss.on('connection', (ws, req) => {
    current = ws;
    connections.push({ url: req.url ?? '', headers: req.headers });
    ws.on('close', () => (closedSockets += 1));
    ws.on('message', (raw) => {
      const text = raw.toString();
      rawReceived.push(text);
      let msg: Json = {};
      try {
        msg = JSON.parse(text);
      } catch {
        /* keep empty */
      }
      received.push(msg);
      listener(msg, ws);
    });
  });
  await once(wss, 'listening');
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}${opts.path ?? ''}`,
    received,
    rawReceived,
    connections,
    socket() {
      if (!current) throw new Error('no client connected');
      return current;
    },
    push(event) {
      current?.send(JSON.stringify(event));
    },
    pushRaw(frame) {
      current?.send(frame);
    },
    onMessage(fn) {
      listener = fn;
    },
    get closedSockets() {
      return closedSockets;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

/** A port nothing is listening on (bound, read, released). */
export async function deadPort(): Promise<number> {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/* ------------------------------------------------------- session recorder */

export interface Recorder {
  events: SessionEvents;
  audio: Buffer[];
  user: Array<{ text: string; final: boolean; turnId: number }>;
  assistant: Array<{ text: string; final: boolean; turnId: number }>;
  turnStarts: number[];
  turnEnds: number[];
  interrupts: number;
  metrics: Array<{ turnId: number; marks: MetricMark[]; derived: DerivedMetrics }>;
  usage: Array<{ turnId: number; legs: LegUsage[] }>;
  logs: string[];
  errors: Error[];
  /** Every string this session handed upward — for secret scanning. */
  everything(): string;
  audioBytes(): number;
}

export function recorder(): Recorder {
  const rec: Recorder = {
    audio: [],
    user: [],
    assistant: [],
    turnStarts: [],
    turnEnds: [],
    interrupts: 0,
    metrics: [],
    usage: [],
    logs: [],
    errors: [],
    events: undefined as unknown as SessionEvents,
    everything() {
      return JSON.stringify({
        user: rec.user,
        assistant: rec.assistant,
        logs: rec.logs,
        usage: rec.usage,
        errors: rec.errors.map((e) => `${e.name}: ${e.message}\n${e.stack ?? ''}`),
      });
    },
    audioBytes() {
      return rec.audio.reduce((n, b) => n + b.length, 0);
    },
  };
  rec.events = {
    onUserTranscript: (text, final, turnId) => rec.user.push({ text, final, turnId }),
    onAssistantTranscript: (text, final, turnId) => rec.assistant.push({ text, final, turnId }),
    onAudio: (chunk) => rec.audio.push(chunk),
    onTurnStart: (turnId) => rec.turnStarts.push(turnId),
    onTurnEnd: (turnId) => rec.turnEnds.push(turnId),
    onInterrupt: () => (rec.interrupts += 1),
    onMetrics: (turnId, marks, derived) => rec.metrics.push({ turnId, marks, derived }),
    onUsage: (turnId, legs) => rec.usage.push({ turnId, legs }),
    onLog: (level, message) => rec.logs.push(`${level}: ${message}`),
    onError: (err) => rec.errors.push(err),
  };
  return rec;
}

export const markOf = (marks: MetricMark[] | undefined, name: MetricMark['name']) =>
  marks?.find((m) => m.name === name)?.atMs;

/* ------------------------------------------------- PCM fixtures */

/** A ramp, so a resample is checkable by value as well as by length. */
export function ramp(samples: number, step = 7): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((i * step) % 30000) - 15000, i * 2);
  return b;
}

/* ------------------------------------------- AWS event-stream codec (spec) */

/*
 * A minimal, independent implementation of the `application/vnd.amazon.eventstream`
 * binary framing — prelude (total length, headers length, prelude CRC32),
 * headers, payload, message CRC32. Written from the format spec rather than
 * borrowed from the SDK, so a test that round-trips through the real SDK is not
 * the SDK agreeing with itself.
 */
export type HeaderValue = string | Buffer | number | boolean | bigint;

export function encodeEventStream(headers: Record<string, string>, payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = Buffer.from(k, 'utf8');
    const val = Buffer.from(v, 'utf8');
    const h = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
    h.writeUInt8(name.length, 0);
    name.copy(h, 1);
    h.writeUInt8(7, 1 + name.length); // string
    h.writeUInt16BE(val.length, 2 + name.length);
    val.copy(h, 4 + name.length);
    parts.push(h);
  }
  const hb = Buffer.concat(parts);
  const total = 12 + hb.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(hb.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  hb.copy(out, 12);
  payload.copy(out, 12 + hb.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

export interface EventStreamMessage {
  headers: Record<string, HeaderValue>;
  payload: Buffer;
}

/** Decodes every complete message in `buf`, returning the unconsumed tail. */
export function decodeEventStream(buf: Buffer): { messages: EventStreamMessage[]; rest: Buffer } {
  const messages: EventStreamMessage[] = [];
  let off = 0;
  while (buf.length - off >= 12) {
    const total = buf.readUInt32BE(off);
    if (buf.length - off < total) break;
    const hlen = buf.readUInt32BE(off + 4);
    if (crc32(buf.subarray(off, off + 8)) !== buf.readUInt32BE(off + 8)) throw new Error('prelude CRC mismatch');
    if (crc32(buf.subarray(off, off + total - 4)) !== buf.readUInt32BE(off + total - 4)) throw new Error('message CRC mismatch');
    const headers: Record<string, HeaderValue> = {};
    let p = off + 12;
    const hend = p + hlen;
    while (p < hend) {
      const nl = buf.readUInt8(p);
      const name = buf.subarray(p + 1, p + 1 + nl).toString('utf8');
      p += 1 + nl;
      const t = buf.readUInt8(p);
      p += 1;
      switch (t) {
        case 0: headers[name] = true; break;
        case 1: headers[name] = false; break;
        case 2: headers[name] = buf.readInt8(p); p += 1; break;
        case 3: headers[name] = buf.readInt16BE(p); p += 2; break;
        case 4: headers[name] = buf.readInt32BE(p); p += 4; break;
        case 5:
        case 8: headers[name] = buf.readBigInt64BE(p); p += 8; break;
        case 6:
        case 7: {
          const l = buf.readUInt16BE(p);
          const v = buf.subarray(p + 2, p + 2 + l);
          headers[name] = t === 7 ? v.toString('utf8') : Buffer.from(v);
          p += 2 + l;
          break;
        }
        case 9: headers[name] = Buffer.from(buf.subarray(p, p + 16)); p += 16; break;
        default: throw new Error(`unknown header type ${t}`);
      }
    }
    messages.push({ headers, payload: Buffer.from(buf.subarray(hend, off + total - 4)) });
    off += total;
  }
  return { messages, rest: Buffer.from(buf.subarray(off)) };
}

/* ---------------------------------------------- fake Bedrock (HTTP/2, h2c) */

export interface BedrockRequest {
  headers: http2.IncomingHttpHeaders;
  /** Every Nova input event the client sent, in order, as parsed JSON. */
  events: Json[];
  /** The raw inner event-stream headers of each chunk. */
  chunkHeaders: Array<Record<string, HeaderValue>>;
  /** Outer (signed envelope) header names, per message. */
  envelopeHeaders: string[][];
  ended: boolean;
  stream: http2.ServerHttp2Stream;
}

export interface FakeBedrock {
  readonly endpoint: string;
  readonly requests: BedrockRequest[];
  /** How to answer a new request. Default: 200 event stream plus one inert event. */
  onRequest(fn: (r: BedrockRequest) => void): void;
  close(): Promise<void>;
}

/** One Nova output event wrapped the way the SDK expects a `chunk` member. */
export function bedrockChunk(event: Json): Buffer {
  const inner = Buffer.from(JSON.stringify({ event }), 'utf8').toString('base64');
  return encodeEventStream(
    { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ bytes: inner }), 'utf8'),
  );
}

/** A modeled exception frame, e.g. `throttlingException`. */
export function bedrockException(type: string, message: string): Buffer {
  return encodeEventStream(
    { ':message-type': 'exception', ':exception-type': type, ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ message }), 'utf8'),
  );
}

export async function startBedrock(): Promise<FakeBedrock> {
  const requests: BedrockRequest[] = [];
  /*
   * Default: 200, then one inert output event. The inert event matters: with
   * the SDK version installed here, `client.send()` does not resolve on the
   * response HEADERS but only once the first output event arrives (measured
   * against this fake), so a fake that answers 200 and stays silent hangs
   * `start()` until its 20s handshake timeout.
   */
  let handler: (r: BedrockRequest) => void = (r) => {
    r.stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
    r.stream.write(bedrockChunk({}));
  };
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream, headers) => {
    const r: BedrockRequest = { headers, events: [], chunkHeaders: [], envelopeHeaders: [], ended: false, stream };
    requests.push(r);
    let buf: Buffer = Buffer.alloc(0);
    stream.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const { messages, rest } = decodeEventStream(buf);
      buf = rest;
      for (const m of messages) {
        r.envelopeHeaders.push(Object.keys(m.headers));
        // Each signed envelope's payload is itself one event-stream message.
        for (const inner of decodeEventStream(m.payload).messages) {
          r.chunkHeaders.push(inner.headers);
          try {
            const part = JSON.parse(inner.payload.toString('utf8')) as { bytes?: string };
            r.events.push(JSON.parse(Buffer.from(part.bytes ?? '', 'base64').toString('utf8')));
          } catch {
            r.events.push({});
          }
        }
      }
    });
    stream.on('end', () => (r.ended = true));
    stream.on('error', () => {});
    handler(r);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    onRequest(fn) {
      handler = fn;
    },
    async close() {
      for (const s of sessions) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
