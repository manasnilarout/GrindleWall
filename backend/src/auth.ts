import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** The only account this naive layer accepts. */
export const AUTH_USERNAME = 'admin@magickvoice.com';

export const DEFAULT_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

export function authEnabled(): boolean {
  return Boolean(config.authPassword && config.authHmacSecret);
}

/**
 * HMAC-SHA256 hex of `value` keyed by `secret`.
 *
 * Same construction the login page uses (Web Crypto HMAC-SHA256, UTF-8 key
 * and message, hex digest). The backend never "decrypts" this — it recomputes
 * the digest of AUTH_PASSWORD and compares.
 */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * Timing-safe compare of a presented hex HMAC against HMAC(secret, value).
 * A malformed or wrong-length digest is a miss, not a throw.
 */
export function hmacEquals(secret: string, value: string, presented: string): boolean {
  if (!/^[0-9a-f]+$/i.test(presented) || presented.length % 2 !== 0) return false;
  const expected = Buffer.from(hmacHex(secret, value), 'hex');
  const got = Buffer.from(presented, 'hex');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export function verifyLogin(
  presented: { username: string; hmac: string },
  expected: { username: string; password: string; hmacSecret: string },
): boolean {
  if (presented.username !== expected.username) return false;
  return hmacEquals(expected.hmacSecret, expected.password, presented.hmac);
}

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
}

/** In-memory sessions. A process restart logs everyone out — first iteration. */
export class SessionBook {
  private readonly sessions = new Map<string, AuthSession>();

  constructor(private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS) {}

  create(username: string, now = Date.now()): AuthSession {
    const session: AuthSession = {
      token: randomBytes(32).toString('hex'),
      username,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined, now = Date.now()): AuthSession | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }
}

export function tokenFromAuthorization(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  return m?.[1];
}

export function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://localhost').searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

export function tokenFromRequest(req: {
  headers: { authorization?: string | string[] };
  url?: string;
  query?: Record<string, unknown>;
}): string | undefined {
  const fromHeader = tokenFromAuthorization(req.headers.authorization);
  if (fromHeader) return fromHeader;
  const q = req.query?.token;
  if (typeof q === 'string' && q) return q;
  return tokenFromUrl(req.url);
}
