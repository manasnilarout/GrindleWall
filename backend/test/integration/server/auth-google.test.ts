import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_USERNAME, bootServer, login, pipelineConfig, WsClient, type ServerHandle } from './helpers.js';
import { fakeIssuer, PROJECT, serveJwks, type FakeIssuer } from '../../firebase-fake.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'login-page-hmac-key-0123456789';
const API_KEY = 'AIzaSy-public-web-key-for-tests';

async function post(server: ServerHandle, path: string, body: unknown, token?: string, method = 'POST') {
  return fetch(`${server.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

interface Session {
  token: string;
  username: string;
  role: string;
  method: string;
}

describe('google sign-in alongside the password login', () => {
  let server: ServerHandle;
  let issuer: FakeIssuer;
  let jwks: Awaited<ReturnType<typeof serveJwks>>;

  const google = async (claims: Record<string, unknown> = {}) =>
    post(server, '/api/auth/google', { idToken: await issuer.mint(claims) });
  const googleToken = async (email: string) => {
    const r = await google({ email });
    expect(r.status).toBe(200);
    return ((await r.json()) as Session).token;
  };

  beforeAll(async () => {
    issuer = await fakeIssuer();
    jwks = await serveJwks([issuer.jwk]);
    server = await bootServer({
      env: {
        AUTH_PASSWORD: PASSWORD,
        AUTH_HMAC_SECRET: SECRET,
        FIREBASE_PROJECT_ID: PROJECT,
        FIREBASE_API_KEY: API_KEY,
        FIREBASE_JWKS_URL: jwks.url,
        AUTH_ADMIN_EMAILS: 'Boss@MagickVoice.com',
      },
    });
  });
  afterAll(async () => {
    await server?.stop();
    await jwks?.close();
  });

  it('GET /api/auth/config hands the browser the public Firebase web config', async () => {
    const r = await fetch(`${server.base}/api/auth/config`);
    expect(await r.json()).toEqual({
      required: true,
      username: AUTH_USERNAME,
      sessionTtlMs: 3 * 3_600_000,
      password: true,
      hmacSecret: SECRET,
      google: { apiKey: API_KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT },
    });
  });

  it('a @magickvoice.com Google account signs in as a member, with a token every route accepts', async () => {
    const r = await google({ email: 'Intern@magickvoice.com' });
    expect(r.status).toBe(200);
    const s = (await r.json()) as Session;
    expect(s).toMatchObject({ username: 'intern@magickvoice.com', role: 'member', method: 'google' });
    expect((await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(200);
    const me = await fetch(`${server.base}/api/auth/session`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(((await me.json()) as { session: Session }).session.role).toBe('member');
    const ws = await WsClient.connect(`${server.wsUrl}?token=${s.token}`);
    ws.send({ type: 'start', config: pipelineConfig('google member') });
    await ws.next('session_started');
    await ws.close();
  });

  it('refuses a domain that is not on the list with a 403 that names the address', async () => {
    const r = await google({ email: 'someone@gmail.com' });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/someone@gmail\.com is not allowed/);
  });

  it('refuses a forged, foreign or non-Google token with a 401', async () => {
    const forger = await fakeIssuer(issuer.kid);
    expect((await post(server, '/api/auth/google', { idToken: await forger.mint() })).status).toBe(401);
    expect((await post(server, '/api/auth/google', { idToken: await issuer.mint({}, { aud: 'other' }) })).status).toBe(401);
    expect((await google({ firebase: { sign_in_provider: 'password' } })).status).toBe(401);
    expect((await google({ email_verified: false })).status).toBe(401);
    expect((await post(server, '/api/auth/google', {})).status).toBe(401);
  });

  it('a member cannot read or edit the allowlist', async () => {
    const token = await googleToken('intern2@magickvoice.com');
    expect((await fetch(`${server.base}/api/auth/allowlist`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'gmail.com' }, token)).status).toBe(403);
    expect((await fetch(`${server.base}/api/auth/allowlist`)).status).toBe(401);
  });

  it('AUTH_ADMIN_EMAILS signs in as admin', async () => {
    const r = await google({ email: 'boss@magickvoice.com' });
    expect(((await r.json()) as Session).role).toBe('admin');
  });

  it('the password login is admin, can add a domain and an address, and they persist to the session volume', async () => {
    const admin = await login(server, PASSWORD, SECRET);
    const list = await fetch(`${server.base}/api/auth/allowlist`, { headers: { authorization: `Bearer ${admin}` } });
    expect(((await list.json()) as { entries: unknown[] }).entries).toEqual([
      { kind: 'domain', value: 'magickvoice.com', source: 'env' },
    ]);

    expect((await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'partner.io' }, admin)).status).toBe(200);
    expect((await post(server, '/api/auth/allowlist', { kind: 'email', value: 'Friend@gmail.com' }, admin)).status).toBe(200);
    const bad = await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'not a domain' }, admin);
    expect(bad.status).toBe(400);

    expect((await google({ email: 'a@partner.io' })).status).toBe(200);
    expect((await google({ email: 'friend@gmail.com' })).status).toBe(200);
    expect((await google({ email: 'stranger@gmail.com' })).status).toBe(403);

    const file = join(server.sessionDir, '.auth', 'allowlist.json');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('partner.io');
    // Not a *.json at the top of SESSION_DIR, so Runs does not list it as a conversation.
    const runs = await fetch(`${server.base}/api/sessions`, { headers: { authorization: `Bearer ${admin}` } });
    expect(((await runs.json()) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('removing a domain signs its people out immediately; the pinned domain cannot be removed', async () => {
    const admin = await login(server, PASSWORD, SECRET);
    await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'leaving.io' }, admin);
    const leaver = await googleToken('x@leaving.io');
    const stayer = await googleToken('y@magickvoice.com');

    const r = await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'leaving.io' }, admin, 'DELETE');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { revoked: number }).revoked).toBe(1);
    expect((await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${leaver}` } })).status).toBe(401);
    expect((await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${stayer}` } })).status).toBe(200);
    expect((await google({ email: 'x@leaving.io' })).status).toBe(403);

    const pinned = await post(server, '/api/auth/allowlist', { kind: 'domain', value: 'magickvoice.com' }, admin, 'DELETE');
    expect(pinned.status).toBe(400);
    expect(((await pinned.json()) as { error: string }).error).toMatch(/pinned/);
  });

  it('the JWKS is fetched once and cached, not per sign-in', () => {
    expect(jwks.hits()).toBe(1);
  });
});

describe('google sign-in only (no password)', () => {
  let server: ServerHandle;
  let jwks: Awaited<ReturnType<typeof serveJwks>>;

  beforeAll(async () => {
    const issuer = await fakeIssuer();
    jwks = await serveJwks([issuer.jwk]);
    server = await bootServer({
      env: {
        FIREBASE_PROJECT_ID: PROJECT,
        FIREBASE_API_KEY: API_KEY,
        FIREBASE_AUTH_DOMAIN: 'login.example.com',
        FIREBASE_JWKS_URL: jwks.url,
        AUTH_ALLOWED_DOMAINS: '@Example.com, other.org',
      },
    });
  });
  afterAll(async () => {
    await server?.stop();
    await jwks?.close();
  });

  it('turns the gate on and serves no HMAC key', async () => {
    const cfg = (await (await fetch(`${server.base}/api/auth/config`)).json()) as Record<string, unknown>;
    expect(cfg.required).toBe(true);
    expect(cfg.password).toBe(false);
    expect(cfg.hmacSecret).toBeUndefined();
    expect((cfg.google as { authDomain: string }).authDomain).toBe('login.example.com');
    expect((await fetch(`${server.base}/api/catalog`)).status).toBe(401);
  });

  it('the password route is 503, not a way in', async () => {
    const r = await post(server, '/api/auth/login', { username: AUTH_USERNAME, hmac: 'ab' });
    expect(r.status).toBe(503);
  });
});

describe('gate off', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('google sign-in is 503 and the allowlist is closed, not open', async () => {
    expect((await post(server, '/api/auth/google', { idToken: 'x' })).status).toBe(503);
    expect((await fetch(`${server.base}/api/auth/allowlist`)).status).toBe(403);
  });
});
