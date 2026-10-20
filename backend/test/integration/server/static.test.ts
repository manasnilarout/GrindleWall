import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootExpectingExit, bootServer, rawRequest, type ServerHandle } from './helpers.js';

const INDEX = '<!doctype html><title>parchment shell</title><div id="root"></div>';
const APP_JS = 'console.log("hashed bundle");';

describe('STATIC_DIR: the all-in-one image serving the built UI', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gw-int-static-'));
    const dist = join(parent, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), INDEX);
    writeFileSync(join(dist, 'assets', 'app.3f9a.js'), APP_JS);
    writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');
    writeFileSync(join(dist, '.secret'), 'DOTFILE-SECRET');
    // Beside the build dir: what a traversal would be after.
    writeFileSync(join(parent, 'outside-secret.txt'), 'TOP-SECRET');
    // The gate is on, so this also shows the UI shell is public while the API is not.
    server = await bootServer({
      env: { STATIC_DIR: dist, AUTH_PASSWORD: 'static-suite-password', AUTH_HMAC_SECRET: 'static-suite-hmac' },
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('serves index.html at / with no-cache', async () => {
    const r = await fetch(`${server.base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(await r.text()).toBe(INDEX);
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const path of ['/bench', '/sessions/2026-10-20T10-00-00-000Z-abcd1234', '/a/b/c?x=1', '/apix', '/api-docs']) {
      const r = await fetch(`${server.base}${path}`);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toBe(INDEX);
    }
  });

  // index.ts:314 tests `req.path.startsWith('/ws')`, where the /api test beside
  // it is exact (`=== '/api' || startsWith('/api/')`). Any client route that
  // merely begins with the letters "ws" gets a JSON 404 instead of the shell.
  // Low severity — no current UI route starts with "ws".
  it.fails('a client route that only begins with "ws" still gets the shell', async () => {
    const r = await fetch(`${server.base}/wsx-is-not-ws`);
    expect(r.status).toBe(200);
  });

  it('serves index.html directly with no-cache too', async () => {
    const r = await fetch(`${server.base}/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves hashed assets as immutable for a year', async () => {
    const r = await fetch(`${server.base}/assets/app.3f9a.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await r.text()).toBe(APP_JS);
  });

  it('a missing asset is a real 404, not the HTML shell', async () => {
    const r = await fetch(`${server.base}/assets/app.gone.js`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('parchment shell');
  });

  it('serves other top-level files from the build', async () => {
    const r = await fetch(`${server.base}/robots.txt`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('User-agent: *');
  });

  it('API and WebSocket paths stay JSON 404s rather than the shell', async () => {
    for (const path of ['/api', '/api/', '/api/nope', '/api/sessions/x/y/z', '/ws', '/ws/session', '/ws/other']) {
      const r = await fetch(`${server.base}${path}`);
      expect(r.status, path).toBe(404);
      expect(await r.json(), path).toEqual({ error: 'Not found' });
    }
  });

  it('the shell is public while the API is still gated', async () => {
    expect((await fetch(`${server.base}/`)).status).toBe(200);
    expect((await fetch(`${server.base}/api/catalog`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${server.base}/api/auth/config`)).status).toBe(200);
  });

  it('non-GET requests to unknown paths do not get the shell', async () => {
    const r = await fetch(`${server.base}/bench`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('parchment shell');
  });

  it('dotfiles in the build are not served', async () => {
    const r = await fetch(`${server.base}/.secret`);
    expect(await r.text()).not.toContain('DOTFILE-SECRET');
  });

  for (const path of [
    '/../outside-secret.txt',
    '/%2e%2e/outside-secret.txt',
    '/%2e%2e%2foutside-secret.txt',
    '/assets/%2e%2e/%2e%2e/outside-secret.txt',
    '/assets/..%2f..%2foutside-secret.txt',
    '/..%5coutside-secret.txt',
  ]) {
    it(`does not escape the build directory via ${path}`, async () => {
      const r = await rawRequest(server, path);
      expect(r.body.toString()).not.toContain('TOP-SECRET');
    });
  }
});

describe('STATIC_DIR without an index.html', () => {
  it('refuses to start rather than serving a broken UI', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gw-int-static-empty-'));
    const { code, output } = await bootExpectingExit({ env: { STATIC_DIR: empty } });
    expect(code).not.toBe(0);
    expect(output).toContain('does not contain index.html');
  });
});
