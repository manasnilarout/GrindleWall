import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_STORAGE_KEY,
  AUTH_USERNAME,
  authFetch,
  clearSession,
  fetchAuthConfig,
  fetchAuthSession,
  hmacHex,
  login,
  logout,
  readSession,
  sessionAudioUrl,
  sessionWsUrl,
  writeSession,
} from '../../src/lib/auth';
import type { AuthSession } from '../../src/lib/auth';
import { MemoryStorage } from './fixtures';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

const session = (over: Partial<AuthSession> = {}): AuthSession => ({
  token: 'tok-123',
  username: AUTH_USERNAME,
  expiresAt: NOW + 60_000,
  ...over,
});

type FetchArgs = [input: string, init?: RequestInit];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let storage: MemoryStorage;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('constants', () => {
  it('pins the one accepted username and the storage key', () => {
    expect(AUTH_USERNAME).toBe('admin@magickvoice.com');
    expect(AUTH_STORAGE_KEY).toBe('voice-bench.auth');
  });
});

describe('session storage', () => {
  it('writes, reads and clears a session', () => {
    writeSession(session());
    expect(JSON.parse(storage.getItem(AUTH_STORAGE_KEY)!)).toEqual(session());
    expect(readSession()).toEqual(session());
    clearSession();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(readSession()).toBeNull();
  });

  it('reads nothing from an empty store', () => {
    expect(readSession()).toBeNull();
  });

  it.each([
    ['not json', '{oops'],
    ['an empty string', ''],
    ['a non-object', '"tok"'],
    ['null', 'null'],
    ['a numeric token', JSON.stringify({ token: 5, expiresAt: NOW + 1 })],
    ['a string expiry', JSON.stringify({ token: 't', expiresAt: String(NOW + 1000) })],
    ['a missing expiry', JSON.stringify({ token: 't' })],
  ])('rejects %s', (_label, raw) => {
    storage.setItem(AUTH_STORAGE_KEY, raw);
    expect(readSession()).toBeNull();
  });

  it('treats a session as expired at exactly its expiry, and drops it', () => {
    writeSession(session({ expiresAt: NOW }));
    expect(readSession()).toBeNull();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('expires a live session once the clock passes it', () => {
    writeSession(session({ expiresAt: NOW + 1000 }));
    expect(readSession()?.token).toBe('tok-123');
    vi.advanceTimersByTime(999);
    expect(readSession()?.token).toBe('tok-123');
    vi.advanceTimersByTime(1);
    expect(readSession()).toBeNull();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('survives a store whose accessor throws', () => {
    vi.stubGlobal('localStorage', new MemoryStorage({ get: true }));
    expect(readSession()).toBeNull();
  });

  it('is a no-op where there is no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readSession()).toBeNull();
    expect(() => writeSession(session())).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });
});

describe('fetchAuthConfig', () => {
  it('returns the server config', async () => {
    const cfg = { required: true, username: AUTH_USERNAME, sessionTtlMs: 3_600_000, hmacSecret: 's' };
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json(cfg));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAuthConfig()).resolves.toEqual(cfg);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/config');
  });

  it('throws with the status on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    await expect(fetchAuthConfig()).rejects.toThrow('Auth config failed: 500');
  });
});

describe('fetchAuthSession', () => {
  it('asks nothing of the server when no session is stored', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAuthSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing of the server for a locally expired session', async () => {
    writeSession(session({ expiresAt: NOW - 1 }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAuthSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the server's view of the session, sending the bearer token", async () => {
    writeSession(session());
    const fresh = session({ expiresAt: NOW + 120_000 });
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json({ session: fresh }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAuthSession()).resolves.toEqual(fresh);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/session');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('falls back to the stored session when the server omits one', async () => {
    writeSession(session());
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    await expect(fetchAuthSession()).resolves.toEqual(session());
  });

  it('drops the token on a 401 (a backend restart)', async () => {
    writeSession(session());
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'expired' }, 401)));
    await expect(fetchAuthSession()).resolves.toBeNull();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('keeps the token and throws on any other failure', async () => {
    writeSession(session());
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 502)));
    await expect(fetchAuthSession()).rejects.toThrow('Auth session failed: 502');
    expect(readSession()).toEqual(session());
  });
});

describe('hmacHex', () => {
  const ref = (secret: string, value: string) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(value, 'utf8').digest('hex');

  it.each([
    ['secret', 'password'],
    ['k', ''],
    ['ключ', 'пароль ✓ 🎙️'],
    ['a'.repeat(200), 'longer than one block '.repeat(10)],
  ])('matches node:crypto for (%j, %j)', async (secret, value) => {
    const out = await hmacHex(secret, value);
    expect(out).toBe(ref(secret, value));
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches RFC 4231 test case 2', async () => {
    await expect(hmacHex('Jefe', 'what do ya want for nothing?')).resolves.toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('refuses a zero-length key (WebCrypto rule; the backend only enables auth with a secret set)', async () => {
    await expect(hmacHex('', 'x')).rejects.toThrow();
  });
});

describe('login', () => {
  it('posts the HMAC, never the password, and stores the session', async () => {
    const issued = session();
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json(issued));
    vi.stubGlobal('fetch', fetchMock);
    await expect(login(AUTH_USERNAME, 'hunter2', 'sekrit')).resolves.toEqual(issued);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({
      username: AUTH_USERNAME,
      hmac: createHmac('sha256', 'sekrit').update('hunter2').digest('hex'),
    });
    expect(init!.body as string).not.toContain('hunter2');
    expect(readSession()).toEqual(issued);
  });

  it("surfaces the server's error message", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Wrong password' }, 401)));
    await expect(login(AUTH_USERNAME, 'x', 's')).rejects.toThrow('Wrong password');
    expect(readSession()).toBeNull();
  });

  it('falls back to the status when the error body is not JSON or has no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 429 })));
    await expect(login(AUTH_USERNAME, 'x', 's')).rejects.toThrow('Login failed: 429');
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 403)));
    await expect(login(AUTH_USERNAME, 'x', 's')).rejects.toThrow('Login failed: 403');
  });
});

describe('logout', () => {
  it('clears locally and tells the server', async () => {
    writeSession(session());
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await logout();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('does not call the server without a session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await logout();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a network failure after clearing', async () => {
    writeSession(session());
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(logout()).resolves.toBeUndefined();
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

describe('authFetch', () => {
  it('attaches the bearer token and keeps the caller headers and init', async () => {
    writeSession(session());
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await authFetch('/api/x', { method: 'DELETE', headers: { 'X-Trace': '1' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/x');
    expect(init!.method).toBe('DELETE');
    const headers = init!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-123');
    expect(headers.get('X-Trace')).toBe('1');
  });

  it('overrides a caller-supplied Authorization with the session one', async () => {
    writeSession(session());
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await authFetch('/api/x', { headers: { Authorization: 'Bearer stale' } });
    expect((fetchMock.mock.calls[0][1]!.headers as Headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('sends no Authorization header without a session', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await authFetch('/api/x');
    expect((fetchMock.mock.calls[0][1]!.headers as Headers).has('Authorization')).toBe(false);
  });

  it('kicks the session out on a 401 and announces it', async () => {
    writeSession(session());
    const win = new EventTarget();
    const expired = vi.fn();
    win.addEventListener('auth:expired', expired);
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)));
    const res = await authFetch('/api/x');
    expect(res.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('leaves the session alone on other errors', async () => {
    writeSession(session());
    const win = new EventTarget();
    const expired = vi.fn();
    win.addEventListener('auth:expired', expired);
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 403)));
    await authFetch('/api/x');
    expect(expired).not.toHaveBeenCalled();
    expect(readSession()).toEqual(session());
  });
});

describe('sessionAudioUrl', () => {
  it('encodes the record id and appends the token', () => {
    writeSession(session({ token: 'a b&c=d' }));
    expect(sessionAudioUrl('rec/1 x')).toBe('/api/sessions/rec%2F1%20x/audio?token=a%20b%26c%3Dd');
  });

  it('has no query without a session', () => {
    expect(sessionAudioUrl('rec-1')).toBe('/api/sessions/rec-1/audio');
  });
});

describe('sessionWsUrl', () => {
  it('uses ws on http and appends the token', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    writeSession(session({ token: 't+1' }));
    expect(sessionWsUrl()).toBe('ws://localhost:5173/ws/session?token=t%2B1');
  });

  it('uses wss on https', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'bench.example' });
    expect(sessionWsUrl()).toBe('wss://bench.example/ws/session');
  });
});
