import { vi } from 'vitest';
import type * as WsModule from 'ws';

/**
 * A stand-in for the `ws` module that sends every `wss://<vendor-host>/...`
 * dial to a local fake instead, WITHOUT touching the provider sources.
 *
 * Sarvam (STT and TTS), Cartesia (STT and TTS) and Murf's per-model hosts are
 * hardcoded constants with no credential override, so this is the only seam
 * that reaches their socket code. The rewrite keeps the original host as the
 * first path segment — `wss://api.sarvam.ai/x?y` dials
 * `ws://127.0.0.1:<port>/api.sarvam.ai/x?y` — so a test can still assert which
 * host the provider picked. `ws://` URLs (the credential-injected bases the
 * Gemini/ElevenLabs/Murf providers accept) are dialled unchanged.
 *
 * Every client socket is recorded so a test can await its `close`.
 *
 * Usage, at the top of a test file:
 *   vi.mock('ws', async () => (await import('./helpers/ws-redirect.js')).redirectingWsModule());
 */
export interface Dial {
  /** The URL the provider asked for. */
  url: string;
  /** The URL actually dialled. */
  target: string;
  socket: WsModule.WebSocket;
}

interface RedirectState {
  port: number | null;
  dials: Dial[];
}

const KEY = Symbol.for('grindelwald.test.wsRedirect');

/** Shared through globalThis so the mock factory and the test see one instance. */
export function redirectState(): RedirectState {
  const g = globalThis as unknown as Record<symbol, RedirectState | undefined>;
  return (g[KEY] ??= { port: null, dials: [] });
}

export function redirectTo(port: number | null): void {
  const s = redirectState();
  s.port = port;
  s.dials.length = 0;
}

export function dials(): Dial[] {
  return redirectState().dials;
}

export async function redirectingWsModule(): Promise<typeof WsModule> {
  const actual = await vi.importActual<typeof WsModule>('ws');
  const Base = actual.WebSocket;

  class RedirectingWebSocket extends Base {
    constructor(address: string | URL, protocols?: unknown, options?: unknown) {
      const original = String(address);
      const state = redirectState();
      let target = original;
      const m = /^wss:\/\/([^/?#]+)(.*)$/.exec(original);
      if (m) {
        if (state.port === null) throw new Error(`test: no fake server registered for ${m[1]}`);
        const rest = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
        target = `ws://127.0.0.1:${state.port}/${m[1]}${rest}`;
      }
      super(target, protocols as string[], options as WsModule.ClientOptions);
      state.dials.push({ url: original, target, socket: this });
    }
  }

  return { ...actual, default: RedirectingWebSocket, WebSocket: RedirectingWebSocket } as typeof WsModule;
}

/**
 * Resolves when a client socket has emitted `close`. Not `events.once`, which
 * rejects on the `error` a handshake abort emits first.
 */
export function clientClosed(socket: WsModule.WebSocket): Promise<void> {
  if (socket.readyState === 3) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

/** The n-th recorded client socket's close (0-based). */
export function dialClosed(n = 0): Promise<void> {
  const d = dials()[n];
  if (!d) throw new Error(`test: no dial #${n}`);
  return clientClosed(d.socket);
}

/** Resolves when the n-th recorded client socket is OPEN (the server sees a connection first). */
export function dialOpen(n = 0): Promise<void> {
  const d = dials()[n];
  if (!d) throw new Error(`test: no dial #${n}`);
  if (d.socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve) => d.socket.once('open', () => resolve()));
}
