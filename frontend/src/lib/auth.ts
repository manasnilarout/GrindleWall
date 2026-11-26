/** The only account the password login accepts. Mirrored on the backend. */
export const AUTH_USERNAME = 'admin@magickvoice.com';

export const AUTH_STORAGE_KEY = 'voice-bench.auth';

/** Firebase's public web config — what `initializeApp` takes. Served by the backend. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
}

export interface AuthConfig {
  required: boolean;
  username: string;
  sessionTtlMs: number;
  /** Whether the admin password login is configured (`hmacSecret` is sent only then). */
  password: boolean;
  hmacSecret?: string;
  /** Present when Google sign-in is configured. */
  google?: FirebaseWebConfig;
}

export type AuthRole = 'admin' | 'member';

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
  /** `admin` may edit the sign-in allowlist. */
  role: AuthRole;
  method: 'password' | 'google';
}

/** What an admin names when adding or removing: a whole domain or one address. */
export interface AllowTarget {
  kind: 'domain' | 'email';
  value: string;
}

export interface AllowEntry extends AllowTarget {
  /** `env` entries are pinned by AUTH_ALLOWED_DOMAINS and cannot be removed from the UI. */
  source: 'env' | 'admin';
  addedBy?: string;
  addedAt?: number;
}

export interface AllowlistState {
  entries: AllowEntry[];
  /** AUTH_ADMIN_EMAILS — Google accounts that sign in as admin. */
  adminEmails: string[];
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config');
  if (!res.ok) throw new Error(`Auth config failed: ${res.status}`);
  return res.json();
}

/**
 * Ask the server whether a stored token is still live. Sessions live in the
 * backend process, so a `tsx watch` restart (or any restart) invalidates them
 * while localStorage still looks fine. A 401 here is a real miss, not a
 * network blip — the token is dropped.
 */
export async function fetchAuthSession(): Promise<AuthSession | null> {
  const stored = readSession();
  if (!stored) return null;
  const res = await fetch('/api/auth/session', {
    headers: { Authorization: `Bearer ${stored.token}` },
  });
  if (res.status === 401) {
    clearSession();
    return null;
  }
  if (!res.ok) throw new Error(`Auth session failed: ${res.status}`);
  const body = (await res.json()) as { session?: AuthSession };
  return body.session ?? stored;
}

/**
 * HMAC-SHA256 hex of `value` keyed by `secret`.
 *
 * Must match `hmacHex` in `backend/src/auth.ts` (UTF-8 key and message).
 * The login page sends this instead of the password; the backend recomputes
 * the same digest of AUTH_PASSWORD and compares.
 */
export async function hmacHex(secret: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The JSON body of a successful response; otherwise throws the server's `{ error }` (or `fallback: <status>`). */
async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${fallback}: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** POSTs a sign-in and stores the session it returns. */
async function signInWith(url: string, body: unknown, fallback: string): Promise<AuthSession> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const session = await jsonOrThrow<AuthSession>(res, fallback);
  writeSession(session);
  return session;
}

export async function login(username: string, password: string, hmacSecret: string): Promise<AuthSession> {
  return signInWith('/api/auth/login', { username, hmac: await hmacHex(hmacSecret, password) }, 'Login failed');
}

/** Trades a Firebase ID token from the Google popup for one of our own sessions. */
export function loginWithGoogle(idToken: string): Promise<AuthSession> {
  return signInWith('/api/auth/google', { idToken }, 'Sign-in failed');
}

async function allowlistCall(method: 'GET' | 'POST' | 'DELETE', target?: AllowTarget): Promise<AllowlistState> {
  const res = await authFetch('/api/auth/allowlist', {
    method,
    ...(target ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(target) } : {}),
  });
  return jsonOrThrow<AllowlistState>(res, 'Allowlist request failed');
}

export const fetchAllowlist = () => allowlistCall('GET');
export const addAllowEntry = (target: AllowTarget) => allowlistCall('POST', target);
export const removeAllowEntry = (target: AllowTarget) => allowlistCall('DELETE', target);

export async function logout(): Promise<void> {
  const session = readSession();
  clearSession();
  if (!session) return;
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
  }).catch(() => undefined);
}

export function readSession(): AuthSession | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeSession(session: AuthSession): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

/** fetch that attaches the session token and treats 401 as a kick-out. */
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const session = readSession();
  if (session) headers.set('Authorization', `Bearer ${session.token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && typeof window !== 'undefined') {
    clearSession();
    window.dispatchEvent(new Event('auth:expired'));
  }
  return res;
}

export function sessionAudioUrl(recordId: string): string {
  const session = readSession();
  const q = session ? `?token=${encodeURIComponent(session.token)}` : '';
  return `/api/sessions/${encodeURIComponent(recordId)}/audio${q}`;
}

export function sessionWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const session = readSession();
  const q = session ? `?token=${encodeURIComponent(session.token)}` : '';
  return `${proto}://${location.host}/ws/session${q}`;
}
