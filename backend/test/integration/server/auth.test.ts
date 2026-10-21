import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_USERNAME,
  bootServer,
  hmacHex,
  login,
  pipelineConfig,
  rawRequest,
  uniquePrompt,
  until,
  WsClient,
  type ServerHandle,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'login-page-hmac-key-0123456789';

const PROTECTED = ['/api/catalog', '/api/pricing', '/api/sessions', '/api/sessions/anything', '/api/sessions/anything/audio'];

async function post(server: ServerHandle, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('login gate enabled', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    // 100h is over the 24h cap, so this boot also proves the clamp.
    server = await bootServer({ env: { AUTH_PASSWORD: PASSWORD, AUTH_HMAC_SECRET: SECRET, AUTH_SESSION_HOURS: '100' } });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('GET /api/auth/config is public and hands out the HMAC key, never the password', async () => {
    const r = await fetch(`${server.base}/api/auth/config`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      required: true,
      username: AUTH_USERNAME,
      sessionTtlMs: 24 * 3_600_000, // AUTH_SESSION_HOURS=100 clamped to 24
      hmacSecret: SECRET,
    });
    expect(text).not.toContain(PASSWORD);
  });

  it('health stays public so a load balancer can probe it', async () => {
    expect((await fetch(`${server.base}/api/health`)).status).toBe(200);
  });

  for (const path of PROTECTED) {
    it(`${path} is 401 without a token`, async () => {
      const r = await fetch(`${server.base}${path}`);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'Unauthorized' });
    });
  }

  it('protected routes are 401 for a made-up token, in the header and the query', async () => {
    const fake = 'f'.repeat(64);
    expect((await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${fake}` } })).status).toBe(401);
    expect((await fetch(`${server.base}/api/catalog?token=${fake}`)).status).toBe(401);
  });

  it('GET /api/auth/session is 401 with no token', async () => {
    expect((await fetch(`${server.base}/api/auth/session`)).status).toBe(401);
  });

  describe('POST /api/auth/login', () => {
    it('accepts the right username and HMAC, issuing a token that expires in the clamped TTL', async () => {
      const before = Date.now();
      const r = await post(server, '/api/auth/login', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, PASSWORD) });
      expect(r.status).toBe(200);
      const text = await r.text();
      const body = JSON.parse(text) as { token: string; username: string; expiresAt: number };
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.username).toBe(AUTH_USERNAME);
      const ttl = body.expiresAt - before;
      expect(ttl).toBeGreaterThan(24 * 3_600_000 - 5_000);
      expect(ttl).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);
      expect(text).not.toContain(PASSWORD);
    });

    it('accepts an upper-case hex digest (hex is case-insensitive)', async () => {
      const r = await post(server, '/api/auth/login', {
        username: AUTH_USERNAME,
        hmac: hmacHex(SECRET, PASSWORD).toUpperCase(),
      });
      expect(r.status).toBe(200);
    });

    const bad: Array<[string, unknown]> = [
      ['a wrong password', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, 'wrong password') }],
      ['the right password HMACed with the wrong key', { username: AUTH_USERNAME, hmac: hmacHex('other key', PASSWORD) }],
      ['a wrong username', { username: 'someone@else.com', hmac: hmacHex(SECRET, PASSWORD) }],
      ['the username in a different case', { username: AUTH_USERNAME.toUpperCase(), hmac: hmacHex(SECRET, PASSWORD) }],
      ['the plaintext password in place of the HMAC', { username: AUTH_USERNAME, hmac: PASSWORD }],
      ['a truncated digest', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, PASSWORD).slice(0, 62) }],
      ['an odd-length digest', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, PASSWORD).slice(0, 63) }],
      ['non-hex characters', { username: AUTH_USERNAME, hmac: 'zz'.repeat(32) }],
      ['an empty body', {}],
      ['non-string fields', { username: 42, hmac: ['a'] }],
    ];
    for (const [what, body] of bad) {
      it(`rejects ${what} with a 401`, async () => {
        const r = await post(server, '/api/auth/login', body);
        expect(r.status).toBe(401);
        const text = await r.text();
        expect(JSON.parse(text)).toEqual({ error: 'Invalid credentials' });
        expect(text).not.toContain(PASSWORD);
      });
    }
  });

  describe('token transport', () => {
    let token: string;
    beforeAll(async () => {
      token = await login(server, PASSWORD, SECRET);
    });

    it('accepts a Bearer token in the Authorization header', async () => {
      const r = await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { providers: unknown[] }).providers.length).toBe(26);
    });

    it('accepts the scheme in any case', async () => {
      const r = await fetch(`${server.base}/api/pricing`, { headers: { authorization: `bearer ${token}` } });
      expect(r.status).toBe(200);
    });

    it('accepts ?token= — what an <audio> element has to use', async () => {
      expect((await fetch(`${server.base}/api/sessions?token=${token}`)).status).toBe(200);
      expect((await fetch(`${server.base}/api/sessions/nope/audio?token=${token}`)).status).toBe(404);
    });

    it('falls back to ?token= when the header is not a Bearer token', async () => {
      const r = await fetch(`${server.base}/api/sessions?token=${token}`, { headers: { authorization: `Basic ${token}` } });
      expect(r.status).toBe(200);
    });

    it('a valid header wins over a bad query token', async () => {
      const r = await fetch(`${server.base}/api/sessions?token=bad`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
    });

    it('does NOT read a cookie — tokenFromRequest only knows the header and the query', async () => {
      const r = await fetch(`${server.base}/api/sessions`, { headers: { cookie: `token=${token}` } });
      expect(r.status).toBe(401);
    });

    it('GET /api/auth/session returns the session for a valid token', async () => {
      const r = await fetch(`${server.base}/api/auth/session`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { required: boolean; session: { token: string; username: string } };
      expect(body.required).toBe(true);
      expect(body.session.username).toBe(AUTH_USERNAME);
      expect(body.session.token).toBe(token);
    });
  });

  describe('logout', () => {
    it('revokes the token for every route and the socket', async () => {
      const token = await login(server, PASSWORD, SECRET);
      const other = await login(server, PASSWORD, SECRET);
      const auth = { authorization: `Bearer ${token}` };
      expect((await fetch(`${server.base}/api/catalog`, { headers: auth })).status).toBe(200);

      const out = await post(server, '/api/auth/logout', {}, auth);
      expect(out.status).toBe(200);
      expect(await out.json()).toEqual({ ok: true });

      expect((await fetch(`${server.base}/api/catalog`, { headers: auth })).status).toBe(401);
      expect((await fetch(`${server.base}/api/auth/session`, { headers: auth })).status).toBe(401);
      const ws = await WsClient.connect(`${server.wsUrl}?token=${token}`);
      expect((await ws.closed).code).toBe(4401);
      // Only that token: a second login's session survives.
      expect((await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(200);
    });

    it('accepts the token in the query, too', async () => {
      const token = await login(server, PASSWORD, SECRET);
      expect((await post(server, `/api/auth/logout?token=${token}`, {})).status).toBe(200);
      expect((await fetch(`${server.base}/api/catalog?token=${token}`)).status).toBe(401);
    });

    it('is idempotent and harmless without a token', async () => {
      expect((await post(server, '/api/auth/logout', {})).status).toBe(200);
      expect((await post(server, '/api/auth/logout', {}, { authorization: 'Bearer nothing' })).status).toBe(200);
    });
  });

  describe('WebSocket gate', () => {
    it('closes an unauthenticated socket with 4401 before any message is handled', async () => {
      const ws = await WsClient.connect(server.wsUrl);
      ws.send({ type: 'start', config: pipelineConfig('x') });
      const { code, reason } = await ws.closed;
      expect(code).toBe(4401);
      expect(reason).toBe('unauthorized');
      expect(ws.messages).toEqual([]);
    });

    it('closes a socket presenting a forged token', async () => {
      const ws = await WsClient.connect(`${server.wsUrl}?token=${'0'.repeat(64)}`);
      expect((await ws.closed).code).toBe(4401);
    });

    it('accepts ?token= on the upgrade URL and runs a conversation', async () => {
      const token = await login(server, PASSWORD, SECRET);
      const ws = await WsClient.connect(`${server.wsUrl}?token=${encodeURIComponent(token)}`);
      const prompt = uniquePrompt('auth-ws');
      ws.send({ type: 'start', config: pipelineConfig(prompt) });
      await ws.next('session_started');
      ws.send({ type: 'user_text', text: 'hello behind the gate' });
      await ws.next('usage');
      ws.send({ type: 'end_conversation' });
      const { summary } = await ws.next('session_summary');
      await ws.close();

      // The record holds the prompt (deliberately) but none of the login secrets.
      const record = await until(() => {
        try {
          return readFileSync(join(server.sessionDir, `${summary.recordId}.json`), 'utf8');
        } catch {
          return undefined;
        }
      }, 'the record file');
      expect(record).toContain(prompt);
      for (const secret of [PASSWORD, SECRET, token, hmacHex(SECRET, PASSWORD)]) expect(record).not.toContain(secret);

      // ...and is readable back over the gated routes with the same token.
      const r = await fetch(`${server.base}/api/sessions/${summary.recordId}?token=${token}`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { recordId: string }).recordId).toBe(summary.recordId);
      expect((await fetch(`${server.base}/api/sessions/${summary.recordId}`)).status).toBe(401);
    });

    it('accepts a Bearer header on the upgrade request', async () => {
      const token = await login(server, PASSWORD, SECRET);
      const ws = await WsClient.connect(server.wsUrl, { authorization: `Bearer ${token}` });
      ws.send({ type: 'start', config: pipelineConfig('x') });
      expect((await ws.next('session_started')).mode).toBe('pipeline');
      ws.send({ type: 'stop' });
      await ws.next('session_closed');
      await ws.close();
    });
  });

  it('a raw request with a Bearer token and an encoded traversal is still refused as a bad id', async () => {
    const token = await login(server, PASSWORD, SECRET);
    const r = await rawRequest(server, '/api/sessions/..%2F..%2Fetc%2Fpasswd/audio', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(400);
  });
});

describe('session TTL (AUTH_SESSION_HOURS)', () => {
  let server: ServerHandle;
  // 0.0004 h = 1440 ms: long enough to use, short enough to watch expire.
  const TTL_MS = Math.round(0.0004 * 3_600_000);

  beforeAll(async () => {
    server = await bootServer({ env: { AUTH_PASSWORD: PASSWORD, AUTH_HMAC_SECRET: SECRET, AUTH_SESSION_HOURS: '0.0004' } });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('advertises the configured TTL', async () => {
    const body = (await (await fetch(`${server.base}/api/auth/config`)).json()) as { sessionTtlMs: number };
    expect(body.sessionTtlMs).toBe(TTL_MS);
  });

  it('a token works until expiresAt and is refused everywhere after it', async () => {
    const r = await post(server, '/api/auth/login', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, PASSWORD) });
    const { token, expiresAt } = (await r.json()) as { token: string; expiresAt: number };
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${server.base}/api/catalog`, { headers: auth })).status).toBe(200);

    await until(async () => (await fetch(`${server.base}/api/auth/session`, { headers: auth })).status === 401, 'expiry', 10_000, 100);
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt - 50);
    expect((await fetch(`${server.base}/api/catalog`, { headers: auth })).status).toBe(401);
    const ws = await WsClient.connect(`${server.wsUrl}?token=${token}`);
    expect((await ws.closed).code).toBe(4401);
  });
});

describe('half-configured gate', () => {
  for (const [name, env, warning] of [
    ['AUTH_PASSWORD alone', { AUTH_PASSWORD: PASSWORD }, 'AUTH_PASSWORD is set but AUTH_HMAC_SECRET is not'],
    ['AUTH_HMAC_SECRET alone', { AUTH_HMAC_SECRET: SECRET }, 'AUTH_HMAC_SECRET is set but AUTH_PASSWORD is not'],
  ] as const) {
    it(`${name} leaves the bench open, refuses logins, and says so at boot`, async () => {
      const server = await bootServer({ env });
      try {
        expect(((await (await fetch(`${server.base}/api/auth/config`)).json()) as { required: boolean }).required).toBe(false);
        expect((await fetch(`${server.base}/api/catalog`)).status).toBe(200);
        expect((await post(server, '/api/auth/login', { username: AUTH_USERNAME, hmac: hmacHex(SECRET, PASSWORD) })).status).toBe(503);
        await until(() => server.output().includes(warning), 'the boot warning');
        const ws = await WsClient.connect(server.wsUrl);
        ws.send({ type: 'start', config: pipelineConfig('x') });
        await ws.next('session_started');
        await ws.close();
      } finally {
        await server.stop();
      }
    });
  }
});
