/**
 * Boots the real backend (`src/index.ts`) as a child process and drives it over
 * real HTTP and a real WebSocket. `index.ts` listens on import, so it cannot be
 * loaded in-process; one child per configuration is also the only way to vary
 * the env that `config.ts` reads once at import.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import WebSocket from 'ws';
import { CATALOG } from '../../../src/providers/catalog.js';
import type { ClientMessage, ServerMessage, StartConfig } from '../../../src/shared/protocol.js';

export const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const AUTH_USERNAME = 'admin@magickvoice.com';

/** Every child ever spawned by this file's tests, killed after the file whatever happens. */
const children = new Set<ChildProcess>();
/** Session dirs this module created (never a caller's own), removed after the file. */
const ownDirs = new Set<string>();
/*
 * A file-level hook rather than `process.on('exit')`: Vitest tears its fork
 * workers down without emitting 'exit', so an exit handler never runs. Registered
 * at import, i.e. first, so with the default 'stack' hook order it runs after the
 * file's own afterAll(server.stop()) hooks.
 */
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of ownDirs) rmSync(d, { recursive: true, force: true });
});

function ownTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gw-int-server-'));
  ownDirs.add(d);
  return d;
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/**
 * Env the child starts from: every vendor key the catalog names is blanked (an
 * empty string, which dotenv will not override from a developer's `.env`), and
 * every knob `config.ts` and the providers read is pinned, so a suite sees only
 * what it sets itself.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const blank = new Set<string>([
    'AUTH_PASSWORD',
    'AUTH_HMAC_SECRET',
    'AUTH_SESSION_HOURS',
    'AWS_SESSION_TOKEN',
    'AWS_DEFAULT_REGION',
    'OPENAI_BASE_URL',
    'OPENAI_WS_BASE',
    'GEMINI_BASE_URL',
    'GEMINI_WS_BASE',
    'MURF_WS_BASE',
    'ELEVENLABS_WS_BASE',
    'USD_PER_INR',
    'CARTESIA_USD_PER_CREDIT',
    'STATIC_DIR',
    'SESSION_AUDIO',
    'SESSION_AUDIO_MAX_MINUTES',
    'SESSION_MAX_RECORDS',
    'LOG_AUDIO',
    'NODE_ENV',
  ]);
  for (const p of CATALOG) {
    for (const k of p.envKeys) blank.add(k);
    for (const aliases of Object.values(p.envAliases ?? {})) for (const a of aliases) blank.add(a);
  }
  for (const k of blank) env[k] = '';
  env.CORS_ORIGINS = 'http://localhost:5173';
  return env;
}

export interface ServerHandle {
  port: number;
  base: string;
  wsUrl: string;
  sessionDir: string;
  proc: ChildProcess;
  /** Everything the child printed so far. */
  output(): string;
  alive(): boolean;
  stop(): Promise<void>;
}

export interface BootOptions {
  /** Merged over the pinned base env. `undefined` deletes the variable. */
  env?: Record<string, string | undefined>;
  /** Defaults to a fresh temp dir. */
  sessionDir?: string;
}

export async function bootServer(opts: BootOptions = {}): Promise<ServerHandle> {
  const port = await freePort();
  const sessionDir = opts.sessionDir ?? ownTempDir();
  const env = baseEnv();
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  env.SESSION_DIR = sessionDir;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(proc);
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<void>((res) => proc.once('exit', () => res()));
  exited.then(() => children.delete(proc));

  const handle: ServerHandle = {
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/session`,
    sessionDir,
    proc,
    output: () => out,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    async stop() {
      if (!handle.alive()) return;
      proc.kill('SIGTERM');
      const killer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killer);
    },
  };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!handle.alive()) throw new Error(`server exited during boot (code ${proc.exitCode}):\n${out}`);
    try {
      const r = await fetch(`${handle.base}/api/health`);
      if (r.ok) return handle;
    } catch {
      /* not listening yet */
    }
    await delay(50);
  }
  await handle.stop();
  throw new Error(`server did not become healthy:\n${out}`);
}

/** Spawns the server expecting it to refuse to start; resolves with its exit code and output. */
export async function bootExpectingExit(
  opts: BootOptions = {},
  timeoutMs = 15_000,
): Promise<{ code: number | null; output: string }> {
  const port = await freePort();
  const env = baseEnv();
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  env.SESSION_DIR = opts.sessionDir ?? ownTempDir();
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(proc);
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rej(new Error(`server did not exit within ${timeoutMs}ms:\n${out}`));
    }, timeoutMs);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      children.delete(proc);
      res({ code, output: out });
    });
  });
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value. The only sleeping this suite does. */
export async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000, everyMs = 25): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(everyMs);
  }
}

/* ------------------------------------ auth ------------------------------------ */

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export async function login(server: ServerHandle, password: string, secret: string): Promise<string> {
  const r = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USERNAME, hmac: hmacHex(secret, password) }),
  });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  const body = (await r.json()) as { token: string };
  return body.token;
}

/* ------------------------------------ http ------------------------------------ */

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * A request whose path is sent byte-for-byte. `fetch` normalises `..` and
 * percent-encoding before it leaves, which is exactly what a traversal test
 * must not have happen.
 */
export function rawRequest(
  server: ServerHandle,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on('error', rej);
      },
    );
    req.on('error', rej);
    req.end();
  });
}

/* ------------------------------------- ws ------------------------------------- */

type MsgOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export class WsClient {
  readonly messages: ServerMessage[] = [];
  /** Every text frame exactly as it arrived, for leak checks. */
  readonly rawText: string[] = [];
  readonly audio: Buffer[] = [];
  /** Order of arrival across both kinds, so "audio before turn_end" can be asserted. */
  readonly timeline: Array<{ kind: 'text'; msg: ServerMessage } | { kind: 'audio'; bytes: number }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private closeInfo?: { code: number; reason: string };

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        this.audio.push(buf);
        this.timeline.push({ kind: 'audio', bytes: buf.length });
      } else {
        const text = buf.toString('utf8');
        this.rawText.push(text);
        const msg = JSON.parse(text) as ServerMessage;
        this.messages.push(msg);
        this.timeline.push({ kind: 'text', msg });
      }
      this.wake();
    });
    this.closed = new Promise((res) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        res(this.closeInfo);
        this.wake();
      });
    });
    ws.on('error', () => {
      /* surfaced through close */
    });
  }

  static connect(url: string, headers?: Record<string, string>): Promise<WsClient> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, { headers });
      const client = new WsClient(ws);
      ws.once('open', () => res(client));
      ws.once('error', rej);
      ws.once('unexpected-response', (_req, r) => rej(new Error(`upgrade refused: ${r.statusCode}`)));
    });
  }

  get isClosed(): boolean {
    return this.closeInfo !== undefined;
  }

  send(msg: ClientMessage | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  sendAudio(buf: Buffer): void {
    this.ws.send(buf, { binary: true });
  }

  /** All audio received so far, concatenated. */
  audioBytes(): Buffer {
    return Buffer.concat(this.audio);
  }

  all<T extends ServerMessage['type']>(type: T): MsgOf<T>[] {
    return this.messages.filter((m): m is MsgOf<T> => m.type === type);
  }

  /**
   * Next message of `type` (matching `pred`) after the previous one this method
   * returned — so sequential waits read the stream in order and never race.
   */
  async next<T extends ServerMessage['type']>(
    type: T,
    pred: (m: MsgOf<T>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<MsgOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.messages.length; i++) {
        const m = this.messages[i];
        if (m.type === type && pred(m as MsgOf<T>)) {
          this.cursor = i + 1;
          return m as MsgOf<T>;
        }
      }
      if (this.isClosed) {
        throw new Error(`socket closed (${this.closeInfo?.code}) before a "${type}" message arrived`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timed out waiting for "${type}"; saw: ${this.messages.map((m) => m.type).join(',')}`);
      }
      await this.waitAny(left);
    }
  }

  /**
   * Any message of `type` received at any point, regardless of the `next()`
   * cursor — for messages whose relative order the protocol does not fix.
   */
  async seen<T extends ServerMessage['type']>(
    type: T,
    pred: (m: MsgOf<T>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<MsgOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find((m) => m.type === type && pred(m as MsgOf<T>));
      if (hit) return hit as MsgOf<T>;
      if (this.isClosed) throw new Error(`socket closed before a "${type}" message arrived`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for "${type}"`);
      await this.waitAny(left);
    }
  }

  /** Waits until at least `n` audio frames have arrived. */
  async audioFrames(n: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.audio.length < n) {
      if (this.isClosed) throw new Error('socket closed before audio arrived');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${n} audio frames`);
      await this.waitAny(left);
    }
  }

  close(): Promise<{ code: number; reason: string }> {
    if (!this.isClosed) this.ws.close();
    return this.closed;
  }

  terminate(): Promise<{ code: number; reason: string }> {
    if (!this.isClosed) this.ws.terminate();
    return this.closed;
  }

  private waitAny(ms: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.waiters = self.waiters.filter((w) => w !== done);
        res();
      }
      this.waiters.push(done);
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/* ---------------------------------- fixtures ---------------------------------- */

export function pipelineConfig(systemPrompt: string, extra: Partial<StartConfig> = {}): StartConfig {
  return {
    mode: 'pipeline',
    sttProviderId: 'mock-stt',
    sttModelId: 'mock-asr',
    llmProviderId: 'mock-llm',
    llmModelId: 'mock-chat',
    ttsProviderId: 'mock-tts',
    ttsModelId: 'mock-voice',
    systemPrompt,
    turnDetection: 'server_vad',
    ...extra,
  };
}

export function realtimeConfig(systemPrompt: string, extra: Partial<StartConfig> = {}): StartConfig {
  return {
    mode: 'realtime',
    realtimeProviderId: 'mock-realtime',
    realtimeModelId: 'mock-s2s',
    systemPrompt,
    turnDetection: 'server_vad',
    ...extra,
  };
}

/** A prompt no other test uses, so a record can be found by it. */
export function uniquePrompt(tag: string): string {
  return `${tag} ${Math.random().toString(36).slice(2)} — be brief.`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Loud, speech-shaped PCM16 @ 24 kHz: a deterministic sine burst. */
export function loudPcm(ms: number, freq = 300): Buffer {
  const n = Math.floor((ms / 1000) * 24_000);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 24_000) * 0.3 * 32767), i * 2);
  }
  return out;
}

export function silentPcm(ms: number): Buffer {
  return Buffer.alloc(Math.floor((ms / 1000) * 24_000) * 2);
}

/** Splits PCM into 40 ms frames, like the browser's recorder. */
export function frames(pcm: Buffer, frameMs = 40): Buffer[] {
  const size = (frameMs * 24_000 * 2) / 1000;
  const out: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += size) out.push(pcm.subarray(off, Math.min(pcm.length, off + size)));
  return out;
}

/** Polls the listing until the record started with `prompt` appears. */
export async function findRecordByPrompt(
  server: ServerHandle,
  prompt: string,
  headers: Record<string, string> = {},
  pred: (row: { recordId: string; turnCount: number }) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<{ recordId: string; turnCount: number; [k: string]: unknown }> {
  const hash = sha256(prompt);
  return until(
    async () => {
      const r = await fetch(`${server.base}/api/sessions`, { headers });
      const { sessions } = (await r.json()) as {
        sessions: Array<{ recordId: string; turnCount: number; promptSha256?: string }>;
      };
      return sessions.find((s) => s.promptSha256 === hash && pred(s));
    },
    `a record for prompt "${prompt}"`,
    timeoutMs,
  );
}

export function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export interface ParsedWav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  riffSize: number;
  left: Buffer;
  right: Buffer;
}

/** Reads a canonical 44-byte-header PCM16 WAV and de-interleaves it. */
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataBytes = buf.readUInt32LE(40);
  const frameCount = dataBytes / (channels * 2);
  const left = Buffer.alloc(frameCount * 2);
  const right = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i++) {
    left.writeInt16LE(buf.readInt16LE(44 + i * channels * 2), i * 2);
    if (channels > 1) right.writeInt16LE(buf.readInt16LE(44 + i * channels * 2 + 2), i * 2);
  }
  return { channels, sampleRate, bitsPerSample, dataBytes, riffSize: buf.readUInt32LE(4), left, right };
}

export function readRecord(server: ServerHandle, recordId: string): string {
  return readFileSync(join(server.sessionDir, `${recordId}.json`), 'utf8');
}
