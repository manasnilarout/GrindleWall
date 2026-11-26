import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_USERNAME,
  bootExpectingExit,
  bootServer,
  call,
  freePort,
  login,
  ownTempDir,
  pipelineConfig,
  WsClient,
  type ServerHandle,
} from './helpers.js';
import { fakeIssuer, PROJECT, serveJwks, type FakeIssuer } from '../../firebase-fake.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'login-page-hmac-key-0123456789';
const API_KEY = 'AIzaSy-public-web-key-for-tests';

interface Session {
  token: string;
  username: string;
  role: string;
  method: string;
}
type Entries = { entries: Array<{ kind: string; value: string; source: string }> };

describe('google sign-in alongside the password login', () => {
  let server: ServerHandle;
  let issuer: FakeIssuer;
  let jwks: Awaited<ReturnType<typeof serveJwks>>;

  const google = async (claims: Record<string, unknown> = {}) =>
    call(server, 'POST', '/api/auth/google', { body: { idToken: await issuer.mint(claims) } });
  const googleToken = async (email: string) => {
    const r = await google({ email });
    expect(r.status).toBe(200);
    return ((await r.json()) as Session).token;
  };
  const status = async (method: 'GET' | 'POST' | 'DELETE', path: string, opts?: { token?: string; body?: unknown }) =>
    (await call(server, method, path, opts)).status;

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
    expect(await (await call(server, 'GET', '/api/auth/config')).json()).toEqual({
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
    expect(await status('GET', '/api/catalog', { token: s.token })).toBe(200);
    const me = await call(server, 'GET', '/api/auth/session', { token: s.token });
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

  it('refuses a forged, foreign or non-Google token with a 401, telling the user no jose detail', async () => {
    const forger = await fakeIssuer(issuer.kid);
    const forged = await call(server, 'POST', '/api/auth/google', { body: { idToken: await forger.mint() } });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'Invalid sign-in token' });
    const foreign = await issuer.mint({}, { aud: 'other' });
    expect(await status('POST', '/api/auth/google', { body: { idToken: foreign } })).toBe(401);
    expect((await google({ firebase: { sign_in_provider: 'password' } })).status).toBe(401);
    expect((await google({ email_verified: false })).status).toBe(401);
    expect(await status('POST', '/api/auth/google', { body: {} })).toBe(401);
  });

  it('a member cannot read or edit the allowlist', async () => {
    const token = await googleToken('intern2@magickvoice.com');
    expect(await status('GET', '/api/auth/allowlist', { token })).toBe(403);
    expect(await status('POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'gmail.com' } })).toBe(403);
    expect(await status('GET', '/api/auth/allowlist')).toBe(401);
  });

  it('AUTH_ADMIN_EMAILS signs in as admin', async () => {
    const r = await google({ email: 'boss@magickvoice.com' });
    expect(((await r.json()) as Session).role).toBe('admin');
  });

  it('the password login is admin, can add a domain and an address, and they persist to the session volume', async () => {
    const token = await login(server, PASSWORD, SECRET);
    const list = await call(server, 'GET', '/api/auth/allowlist', { token });
    expect(((await list.json()) as Entries).entries).toEqual([{ kind: 'domain', value: 'magickvoice.com', source: 'env' }]);

    expect(await status('POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'partner.io' } })).toBe(200);
    expect(await status('POST', '/api/auth/allowlist', { token, body: { kind: 'email', value: 'Friend@gmail.com' } })).toBe(200);
    expect(await status('POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'not a domain' } })).toBe(400);

    expect((await google({ email: 'a@partner.io' })).status).toBe(200);
    expect((await google({ email: 'friend@gmail.com' })).status).toBe(200);
    expect((await google({ email: 'stranger@gmail.com' })).status).toBe(403);

    const file = join(server.sessionDir, '.auth', 'allowlist.json');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('partner.io');
    // Not a *.json at the top of SESSION_DIR, so Runs does not list it as a conversation.
    const runs = await call(server, 'GET', '/api/sessions', { token });
    expect(((await runs.json()) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('removing a domain signs its people out immediately; the pinned domain cannot be removed', async () => {
    const token = await login(server, PASSWORD, SECRET);
    await call(server, 'POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'leaving.io' } });
    const leaver = await googleToken('x@leaving.io');
    const stayer = await googleToken('y@magickvoice.com');

    const r = await call(server, 'DELETE', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'leaving.io' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { revoked: number }).revoked).toBe(1);
    expect(await status('GET', '/api/catalog', { token: leaver })).toBe(401);
    expect(await status('GET', '/api/catalog', { token: stayer })).toBe(200);
    expect((await google({ email: 'x@leaving.io' })).status).toBe(403);

    const pinned = await call(server, 'DELETE', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'magickvoice.com' } });
    expect(pinned.status).toBe(400);
    expect(((await pinned.json()) as { error: string }).error).toMatch(/pinned/);
  });

  it("removing an entry also closes the removed user's OPEN socket — it was only checked on upgrade", async () => {
    const token = await login(server, PASSWORD, SECRET);
    await call(server, 'POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'socket.io' } });
    const leaver = await googleToken('x@socket.io');
    const ws = await WsClient.connect(`${server.wsUrl}?token=${leaver}`);
    ws.send({ type: 'start', config: pipelineConfig('open socket before removal') });
    await ws.next('session_started');

    await call(server, 'DELETE', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'socket.io' } });
    expect(await ws.closed).toEqual({ code: 4401, reason: 'signed out' });
  });

  it("logout closes that token's open socket and leaves another session's alone", async () => {
    const mine = await googleToken('a@magickvoice.com');
    const theirs = await googleToken('b@magickvoice.com');
    const ws = await WsClient.connect(`${server.wsUrl}?token=${mine}`);
    const other = await WsClient.connect(`${server.wsUrl}?token=${theirs}`);
    await call(server, 'POST', '/api/auth/logout', { token: mine });
    expect((await ws.closed).code).toBe(4401);
    other.send({ type: 'start', config: pipelineConfig('still signed in') });
    await other.next('session_started');
    await other.close();
  });

  it('the JWKS is fetched once and cached, not per sign-in', () => {
    expect(jwks.hits()).toBe(1);
  });
});

describe('google sign-in only: no password, no admin, keys unreachable, a junk pinned domain', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    const closed = await freePort(); // nothing listens here
    server = await bootServer({
      env: {
        FIREBASE_PROJECT_ID: PROJECT,
        FIREBASE_API_KEY: API_KEY,
        FIREBASE_AUTH_DOMAIN: 'login.example.com',
        FIREBASE_JWKS_URL: `http://127.0.0.1:${closed}/jwks`,
        AUTH_ALLOWED_DOMAINS: '*.magickvoice.com,partner.io',
      },
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('turns the gate on and serves no HMAC key', async () => {
    const cfg = (await (await call(server, 'GET', '/api/auth/config')).json()) as Record<string, unknown>;
    expect(cfg.required).toBe(true);
    expect(cfg.password).toBe(false);
    expect(cfg.hmacSecret).toBeUndefined();
    expect((cfg.google as { authDomain: string }).authDomain).toBe('login.example.com');
    expect((await call(server, 'GET', '/api/catalog')).status).toBe(401);
  });

  it('the password route is 503, not a way in', async () => {
    const r = await call(server, 'POST', '/api/auth/login', { body: { username: AUTH_USERNAME, hmac: 'ab' } });
    expect(r.status).toBe(503);
  });

  it('unreachable Google keys are a 503 "try again", not a 401 "bad token" — and admit nobody', async () => {
    const issuer = await fakeIssuer();
    const r = await call(server, 'POST', '/api/auth/google', { body: { idToken: await issuer.mint() } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/temporarily unavailable/);
  });

  it('drops the pinned domain that is not a domain, loudly, and warns that nobody can be admin', () => {
    expect(server.output()).toMatch(/"\*\.magickvoice\.com" is not a domain/);
    expect(server.output()).toMatch(/domains partner\.io\)/);
    expect(server.output()).toMatch(/no admin/);
  });
});

describe('a corrupt allowlist file', () => {
  let server: ServerHandle;
  let file: string;
  const corrupt = '{"version":1,"entries":[{"kind":"domain","value":"partner.io"},]}';
  beforeAll(async () => {
    const sessionDir = ownTempDir();
    file = join(sessionDir, '.auth', 'allowlist.json');
    mkdirSync(join(sessionDir, '.auth'), { recursive: true });
    writeFileSync(file, corrupt);
    server = await bootServer({ sessionDir, env: { AUTH_PASSWORD: PASSWORD, AUTH_HMAC_SECRET: SECRET } });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('refuses edits with a 503 and leaves the file exactly as it was', async () => {
    const token = await login(server, PASSWORD, SECRET);
    const r = await call(server, 'POST', '/api/auth/allowlist', { token, body: { kind: 'domain', value: 'new.io' } });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/unreadable/);
    expect(readFileSync(file, 'utf8')).toBe(corrupt);
    // Reads still work, from the pinned domains alone.
    const list = await call(server, 'GET', '/api/auth/allowlist', { token });
    expect(((await list.json()) as Entries).entries.map((e) => e.value)).toEqual(['magickvoice.com']);
  });
});

describe('boot-time auth configuration', () => {
  it('refuses to start with FIREBASE_JWKS_URL pointing anywhere but loopback', async () => {
    const { code, output } = await bootExpectingExit({
      env: { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_API_KEY: API_KEY, FIREBASE_JWKS_URL: 'https://keys.example.com/jwks' },
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/FIREBASE_JWKS_URL=https:\/\/keys\.example\.com\/jwks is not allowed/);
  });
});
