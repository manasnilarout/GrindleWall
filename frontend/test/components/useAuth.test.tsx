// @vitest-environment jsdom
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAuth } from '../../src/hooks/useAuth';
import { AUTH_STORAGE_KEY, AUTH_USERNAME, type AuthSession } from '../../src/lib/auth';
import { routedFetch, type FakeResponseInit } from './fixtures';

const SECRET = 'shared-hmac-secret';
const gated = { required: true, username: 'admin@magickvoice.com', sessionTtlMs: 3_600_000, hmacSecret: SECRET };
const open = { required: false, username: AUTH_USERNAME, sessionTtlMs: 10_800_000 };

const store = (s: AuthSession) => localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(s));
const stored = () => {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as AuthSession) : null;
};

interface Routes {
  config?: () => FakeResponseInit | Promise<FakeResponseInit>;
  session?: (init?: RequestInit) => FakeResponseInit;
  login?: (init?: RequestInit) => FakeResponseInit;
  logout?: (init?: RequestInit) => FakeResponseInit;
}
function serve(routes: Routes) {
  const fetch = routedFetch(async (url, init) => {
    if (url === '/api/auth/config') return routes.config ? routes.config() : { body: gated };
    if (url === '/api/auth/session') return routes.session?.(init);
    if (url === '/api/auth/login') return routes.login?.(init);
    if (url === '/api/auth/logout') return routes.logout ? routes.logout(init) : { body: {} };
    return undefined;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const callsTo = (fetch: ReturnType<typeof serve>, url: string) => fetch.mock.calls.filter((c) => c[0] === url);

/**
 * Runs an action that is expected to reject, catching inside `act` — a
 * rejecting `act` scope leaks into the next test's renders.
 */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  let error: unknown;
  await act(async () => {
    await run().catch((err: unknown) => {
      error = err;
    });
  });
  if (!(error instanceof Error)) throw new Error('expected the action to reject');
  return error;
}

/** Flush resolved promises under fake timers without advancing the clock. */
const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe('useAuth', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('starts loading with the defaults', () => {
    serve({ config: () => new Promise(() => {}) });
    const { result } = renderHook(() => useAuth());
    expect(result.current.status).toBe('loading');
    expect(result.current.required).toBe(false);
    expect(result.current.username).toBe(AUTH_USERNAME);
    expect(result.current.sessionTtlMs).toBe(3 * 60 * 60 * 1000);
    expect(result.current.session).toBeNull();
  });

  it('an ungated backend goes straight to ready, and drops a leftover token', async () => {
    store({ token: 'old', username: 'someone', expiresAt: Date.now() + 60_000 });
    serve({ config: () => ({ body: open }) });
    const { result } = renderHook(() => useAuth());
    expect(result.current.session?.token).toBe('old');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.required).toBe(false);
    expect(result.current.session).toBeNull();
    expect(stored()).toBeNull();
  });

  it('a backend it cannot reach does not lock the user out', async () => {
    serve({ config: () => ({ status: 502 }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.required).toBe(false);
  });

  it('a gated backend with no stored token asks for a sign-in, with its own username and TTL', async () => {
    const fetch = serve({});
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('login'));
    expect(result.current.required).toBe(true);
    expect(result.current.username).toBe('admin@magickvoice.com');
    expect(result.current.sessionTtlMs).toBe(3_600_000);
    expect(callsTo(fetch, '/api/auth/session')).toHaveLength(0);
  });

  it('a stored token is checked with the server and kept when it is still live', async () => {
    const mine = { token: 'tok-1', username: 'admin@magickvoice.com', expiresAt: Date.now() + 600_000 };
    store(mine);
    const fresh = { ...mine, expiresAt: Date.now() + 900_000 };
    const fetch = serve({ session: () => ({ body: { session: fresh } }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session).toEqual(fresh);
    const [, init] = callsTo(fetch, '/api/auth/session')[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('a session body without a session falls back to the stored one', async () => {
    const mine = { token: 'tok-1', username: 'u', expiresAt: Date.now() + 600_000 };
    store(mine);
    serve({ session: () => ({ body: {} }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session).toEqual(mine);
  });

  it('a stored token the server has forgotten (401) is dropped and sends the user to sign in', async () => {
    store({ token: 'stale', username: 'u', expiresAt: Date.now() + 600_000 });
    serve({ session: () => ({ status: 401 }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('login'));
    expect(result.current.session).toBeNull();
    expect(stored()).toBeNull();
  });

  it('an expired stored token is never sent to the server', async () => {
    store({ token: 'gone', username: 'u', expiresAt: Date.now() - 1 });
    const fetch = serve({});
    const { result } = renderHook(() => useAuth());
    expect(result.current.session).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('login'));
    expect(callsTo(fetch, '/api/auth/session')).toHaveLength(0);
  });

  it('a session check that errors (not 401) is treated as an unreachable gate', async () => {
    store({ token: 'tok', username: 'u', expiresAt: Date.now() + 600_000 });
    serve({ session: () => ({ status: 500 }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.required).toBe(true);
  });

  describe('signIn', () => {
    it('posts the username and the HMAC-SHA256 of the password — never the password — and stores the session', async () => {
      const session = { token: 'new-tok', username: 'admin@magickvoice.com', expiresAt: Date.now() + 3_600_000 };
      const fetch = serve({ login: () => ({ body: session }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('login'));
      await act(async () => result.current.signIn('admin@magickvoice.com', 'correct horse'));

      const [, init] = callsTo(fetch, '/api/auth/login')[0];
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      // The backend's digest, computed independently with node:crypto.
      expect(body).toEqual({
        username: 'admin@magickvoice.com',
        hmac: createHmac('sha256', SECRET).update('correct horse', 'utf8').digest('hex'),
      });
      expect(String(init?.body)).not.toContain('correct horse');
      expect(result.current.status).toBe('ready');
      expect(result.current.session).toEqual(session);
      expect(stored()).toEqual(session);
    });

    it('HMACs a non-ASCII password as UTF-8, as the backend does', async () => {
      const fetch = serve({ login: () => ({ body: { token: 't', username: 'u', expiresAt: Date.now() + 1000 } }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('login'));
      await act(async () => result.current.signIn('u', 'pässwörd 🔑'));
      const body = JSON.parse(String(callsTo(fetch, '/api/auth/login')[0][1]?.body));
      expect(body.hmac).toBe(createHmac('sha256', SECRET).update('pässwörd 🔑', 'utf8').digest('hex'));
    });

    it('rejects with the server\'s own error and stays on the login page', async () => {
      serve({ login: () => ({ status: 401, body: { error: 'Wrong password.' } }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('login'));
      expect((await rejection(() => result.current.signIn('u', 'bad'))).message).toBe('Wrong password.');
      expect(result.current.status).toBe('login');
      expect(stored()).toBeNull();
    });

    it('falls back to the status when the error body is not JSON', async () => {
      serve({ login: () => ({ status: 503, badJson: true }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('login'));
      expect((await rejection(() => result.current.signIn('u', 'p'))).message).toBe('Login failed: 503');
    });

    it('refuses to sign in without the HMAC secret', async () => {
      const fetch = serve({ config: () => ({ body: { ...gated, hmacSecret: undefined } }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('login'));
      expect((await rejection(() => result.current.signIn('u', 'p'))).message).toBe('HMAC secret is not available');
      expect(callsTo(fetch, '/api/auth/login')).toHaveLength(0);
    });
  });

  describe('signOut', () => {
    it('revokes the token server-side, clears it, and returns to the login page', async () => {
      store({ token: 'tok-9', username: 'u', expiresAt: Date.now() + 600_000 });
      const fetch = serve({ session: () => ({ body: {} }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => result.current.signOut());
      const [, init] = callsTo(fetch, '/api/auth/logout')[0];
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-9');
      expect(stored()).toBeNull();
      expect(result.current.session).toBeNull();
      expect(result.current.status).toBe('login');
    });

    it('still signs out locally when the logout request fails', async () => {
      store({ token: 'tok', username: 'u', expiresAt: Date.now() + 600_000 });
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/auth/logout') throw new TypeError('network down');
        if (url === '/api/auth/config') return { ok: true, status: 200, json: async () => gated };
        return { ok: true, status: 200, json: async () => ({}) };
      }));
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => result.current.signOut());
      expect(result.current.status).toBe('login');
      expect(stored()).toBeNull();
    });

    it('on an ungated backend it stays ready and sends nothing without a token', async () => {
      const fetch = serve({ config: () => ({ body: open }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => result.current.signOut());
      expect(result.current.status).toBe('ready');
      expect(callsTo(fetch, '/api/auth/logout')).toHaveLength(0);
    });
  });

  describe('expiry and kick-outs', () => {
    it('signs the user out the moment the token expires', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      store({ token: 'tok', username: 'u', expiresAt: Date.now() + 5_000 });
      serve({ session: () => ({ body: {} }) });
      const { result } = renderHook(() => useAuth());
      await flush();
      expect(result.current.status).toBe('ready');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(result.current.status).toBe('ready');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.status).toBe('login');
      expect(result.current.session).toBeNull();
      expect(stored()).toBeNull();
    });

    it('re-arms the timer for a fresh session after signing in', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      serve({ login: () => ({ body: { token: 't', username: 'u', expiresAt: Date.now() + 60_000 } }) });
      const { result } = renderHook(() => useAuth());
      await flush();
      expect(result.current.status).toBe('login');
      await act(async () => {
        await result.current.signIn('u', 'p');
      });
      expect(result.current.status).toBe('ready');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(result.current.status).toBe('login');
    });

    it('a far-off expiry beyond setTimeout\'s range does not fire immediately', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      store({ token: 'tok', username: 'u', expiresAt: Date.now() + 30 * 86_400_000 });
      serve({ session: () => ({ body: {} }) });
      const { result } = renderHook(() => useAuth());
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(result.current.status).toBe('ready');
    });

    it('an auth:expired event (a 401 elsewhere) kicks to the login page', async () => {
      store({ token: 'tok', username: 'u', expiresAt: Date.now() + 600_000 });
      serve({ session: () => ({ body: {} }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        window.dispatchEvent(new Event('auth:expired'));
      });
      expect(result.current.status).toBe('login');
      expect(result.current.session).toBeNull();
      expect(stored()).toBeNull();
    });

    it('a kick while still loading leaves it loading rather than flashing the login page', async () => {
      serve({ config: () => new Promise(() => {}) });
      const { result } = renderHook(() => useAuth());
      act(() => {
        window.dispatchEvent(new Event('auth:expired'));
      });
      expect(result.current.status).toBe('loading');
    });

    it('signing out in another tab signs this one out too; other keys are ignored', async () => {
      store({ token: 'tok', username: 'u', expiresAt: Date.now() + 600_000 });
      serve({ session: () => ({ body: {} }) });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'bench.rigs.v1', newValue: null }));
        window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY, newValue: '{"token":"other"}' }));
      });
      expect(result.current.status).toBe('ready');
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY, newValue: null }));
      });
      expect(result.current.status).toBe('login');
    });

    it('stops listening once unmounted, and ignores a config that lands after', async () => {
      let release!: (v: FakeResponseInit) => void;
      serve({ config: () => new Promise((r) => (release = r)) });
      const { result, unmount } = renderHook(() => useAuth());
      unmount();
      await act(async () => release({ body: gated }));
      expect(result.current.status).toBe('loading');
      expect(() => window.dispatchEvent(new Event('auth:expired'))).not.toThrow();
    });
  });
});
