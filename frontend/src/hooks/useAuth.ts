import { useCallback, useEffect, useState } from 'react';
import {
  AUTH_STORAGE_KEY,
  AUTH_USERNAME,
  clearSession,
  fetchAuthConfig,
  fetchAuthSession,
  login as postLogin,
  logout as postLogout,
  readSession,
  type AuthConfig,
  type AuthSession,
} from '../lib/auth';

export type AuthStatus = 'loading' | 'login' | 'ready';

/** `setTimeout` overflows (and fires immediately) above this. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => readSession());

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig()
      .then(async (cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        if (!cfg.required) {
          // A leftover token from a previous gated run would still render the
          // username in the topbar with no Sign out — drop it.
          clearSession();
          setSession(null);
          setStatus('ready');
          return;
        }
        const existing = await fetchAuthSession();
        if (cancelled) return;
        if (existing) {
          setSession(existing);
          setStatus('ready');
          return;
        }
        setSession(null);
        setStatus('login');
      })
      .catch(() => {
        // Backend down: do not lock the user on the login page. Bench already
        // surfaces a catalog error, and a gate we cannot reach cannot be required.
        if (!cancelled) setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const kick = () => {
      clearSession();
      setSession(null);
      setStatus((prev) => (prev === 'loading' ? prev : 'login'));
    };
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== AUTH_STORAGE_KEY) return;
      if (!ev.newValue) kick();
    };
    window.addEventListener('auth:expired', kick);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('auth:expired', kick);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const ms = session.expiresAt - Date.now();
    if (ms <= 0) {
      clearSession();
      setSession(null);
      setStatus('login');
      return;
    }
    const t = window.setTimeout(() => {
      clearSession();
      setSession(null);
      setStatus('login');
    }, Math.min(ms, MAX_TIMEOUT_MS));
    return () => window.clearTimeout(t);
  }, [session]);

  const signIn = useCallback(async (username: string, password: string) => {
    if (!config?.hmacSecret) throw new Error('HMAC secret is not available');
    const next = await postLogin(username, password, config.hmacSecret);
    setSession(next);
    setStatus('ready');
  }, [config]);

  const signOut = useCallback(async () => {
    await postLogout();
    setSession(null);
    setStatus(config?.required ? 'login' : 'ready');
  }, [config]);

  return {
    status,
    required: config?.required ?? false,
    username: config?.username ?? AUTH_USERNAME,
    sessionTtlMs: config?.sessionTtlMs ?? 3 * 60 * 60 * 1000,
    session,
    signIn,
    signOut,
  };
}
