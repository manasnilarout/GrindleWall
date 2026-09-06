import { useCallback, useEffect, useState } from 'react';
import {
  AUTH_USERNAME,
  clearSession,
  fetchAuthConfig,
  login as postLogin,
  logout as postLogout,
  readSession,
  type AuthConfig,
  type AuthSession,
} from '../lib/auth';

export type AuthStatus = 'loading' | 'login' | 'ready';

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => readSession());
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        if (!cfg.required) {
          setStatus('ready');
          return;
        }
        const existing = readSession();
        if (existing) {
          setSession(existing);
          setStatus('ready');
          return;
        }
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
    window.addEventListener('auth:expired', kick);
    return () => window.removeEventListener('auth:expired', kick);
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
    }, ms);
    return () => window.clearTimeout(t);
  }, [session]);

  const signIn = useCallback(async (username: string, password: string) => {
    if (!config?.hmacSecret) throw new Error('HMAC secret is not available');
    setError(undefined);
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
    error,
    setError,
    signIn,
    signOut,
  };
}
