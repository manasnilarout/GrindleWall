import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, rawRequest, type ServerHandle } from './helpers.js';
import { CATALOG } from '../../../src/providers/catalog.js';
import type { SessionSummary } from '../../../src/shared/protocol.js';

/** The open bench: no login gate, no static UI, every vendor key blank. */
describe('HTTP routes with auth disabled', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    // Nested one level down, so a traversal target can sit beside it without
    // touching anything shared.
    const sessionDir = join(mkdtempSync(join(tmpdir(), 'gw-int-routes-')), 'sessions');
    mkdirSync(sessionDir);
    server = await bootServer({ sessionDir });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('GET /api/health reports the canonical rate and every registered provider', async () => {
    const r = await fetch(`${server.base}/api/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; sampleRate: number; registered: Record<string, string[]> };
    expect(body.ok).toBe(true);
    expect(body.sampleRate).toBe(24_000);
    expect(Object.keys(body.registered).sort()).toEqual(['llm', 'realtime', 'stt', 'tts']);
    // Mocks stay registered permanently — they are how a misbehaving leg is isolated.
    expect(body.registered.realtime).toContain('mock-realtime');
    expect(body.registered.stt).toContain('mock-stt');
    expect(body.registered.llm).toContain('mock-llm');
    expect(body.registered.tts).toContain('mock-tts');
  });

  it('GET /api/auth/config says no login is required and hands out no HMAC secret', async () => {
    const body = (await (await fetch(`${server.base}/api/auth/config`)).json()) as Record<string, unknown>;
    expect(body.required).toBe(false);
    expect(body.username).toBe('admin@magickvoice.com');
    expect(body.sessionTtlMs).toBe(3 * 3_600_000);
    expect(body).not.toHaveProperty('hmacSecret');
  });

  it('POST /api/auth/login is 503 when the gate is not configured', async () => {
    const r = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@magickvoice.com', hmac: 'ab' }),
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/AUTH_PASSWORD and AUTH_HMAC_SECRET/);
  });

  it('GET /api/auth/session reports no session and does not 401', async () => {
    const r = await fetch(`${server.base}/api/auth/session`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ required: false, session: null });
  });

  it('POST /api/auth/logout is a harmless no-op', async () => {
    const r = await fetch(`${server.base}/api/auth/logout`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('GET /api/catalog is open and serves every catalog entry with readiness', async () => {
    const r = await fetch(`${server.base}/api/catalog`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sampleRate: number;
      providers: Array<{
        id: string;
        kind: string;
        implemented: boolean;
        envKeys: string[];
        missingEnv: string[];
        ready: boolean;
        registered: boolean;
        models: Array<{ id: string }>;
      }>;
    };
    expect(body.sampleRate).toBe(24_000);
    expect(body.providers.map((p) => p.id)).toEqual(CATALOG.map((p) => p.id));
    expect(body.providers).toHaveLength(26);
    for (const p of body.providers) {
      expect(['realtime', 'stt', 'llm', 'tts']).toContain(p.kind);
      expect(p.models.length).toBeGreaterThan(0);
      // Every key is blank in this child, so every key is missing...
      expect(p.missingEnv).toEqual(p.envKeys);
      // ...and only a keyless, implemented provider can be ready.
      expect(p.ready).toBe(p.implemented && p.envKeys.length === 0);
      // An implemented provider must be wired up in the factory, or the UI offers a dead toggle.
      if (p.implemented) expect(p.registered).toBe(true);
    }
    const ready = body.providers.filter((p) => p.ready).map((p) => p.id).sort();
    expect(ready).toEqual(['mock-llm', 'mock-realtime', 'mock-stt', 'mock-tts']);
    const sarvam = body.providers.find((p) => p.id === 'sarvam-stt')!;
    expect(sarvam.missingEnv).toEqual(['SARVAM_API_KEY']);
    // Not-implemented entries are visible but never ready or registered.
    const deepgram = body.providers.find((p) => p.id === 'deepgram-stt')!;
    expect(deepgram.implemented).toBe(false);
    expect(deepgram.registered).toBe(false);
  });

  it('GET /api/pricing carries the FX rate both ways and a sourced row per rate', async () => {
    const r = await fetch(`${server.base}/api/pricing`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      usdPerInr: number;
      inrPerUsd: number;
      fxCheckedOn: string;
      rates: Array<Record<string, unknown>>;
    };
    expect(body.usdPerInr).toBeCloseTo(1 / 94.43, 12);
    expect(body.inrPerUsd).toBeCloseTo(94.43, 9);
    expect(body.usdPerInr * body.inrPerUsd).toBeCloseTo(1, 12);
    expect(body.fxCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.rates.length).toBeGreaterThan(10);
    for (const row of body.rates) {
      expect(typeof row.providerId).toBe('string');
      expect(typeof row.modelId).toBe('string');
      expect(['tokens', 'characters', 'audio_seconds']).toContain(row.unit);
      expect(['USD', 'INR']).toContain(row.currency);
      expect(typeof row.input).toBe('number');
      expect(typeof row.output).toBe('number');
      expect(typeof row.rate).toBe('string');
      expect(row.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['verified', 'ambiguous']).toContain(row.confidence);
      // Every real vendor rate is traceable to a page; only the mocks have none.
      if (!String(row.providerId).startsWith('mock-')) expect(String(row.source)).toMatch(/^https:\/\//);
    }
    for (const mock of ['mock-stt', 'mock-llm', 'mock-tts', 'mock-realtime']) {
      const row = body.rates.find((x) => x.providerId === mock);
      expect(row, mock).toMatchObject({ modelId: '*', input: 0, output: 0 });
    }
  });

  it('GET /api/sessions starts empty, and an unknown record is a JSON 404', async () => {
    const list = (await (await fetch(`${server.base}/api/sessions`)).json()) as { sessions: unknown[] };
    expect(Array.isArray(list.sessions)).toBe(true);
    const r = await fetch(`${server.base}/api/sessions/does-not-exist`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'No such session' });
    const a = await fetch(`${server.base}/api/sessions/does-not-exist/audio`);
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ error: 'No recording for this session' });
  });

  describe('path traversal on the session routes', () => {
    beforeAll(() => {
      // A JSON file OUTSIDE the session dir that a traversal would reach.
      writeFileSync(join(server.sessionDir, '..', 'gw-escape-target.json'), JSON.stringify({ leaked: true }));
    });

    const evil = [
      '..%2Fgw-escape-target',
      '..%2F..%2F..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2fgw-escape-target',
      '..%5Cgw-escape-target',
      'a.b',
      '%00',
      'x'.repeat(121),
    ];

    for (const id of evil) {
      it(`GET /api/sessions/${id.slice(0, 40)} is a 404 that reads nothing`, async () => {
        const r = await rawRequest(server, `/api/sessions/${id}`);
        expect(r.status).toBe(404);
        expect(r.body.toString()).not.toContain('leaked');
        expect(r.body.toString()).not.toContain('root:');
      });

      it(`GET /api/sessions/${id.slice(0, 40)}/audio is a 400`, async () => {
        const r = await rawRequest(server, `/api/sessions/${id}/audio`);
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body.toString())).toEqual({ error: 'Bad record id' });
      });
    }

    it('a literal ../ in the path never escapes the router', async () => {
      const r = await rawRequest(server, '/api/sessions/../../../etc/passwd');
      expect(r.body.toString()).not.toContain('root:');
      expect(r.status).toBe(404);
    });

    it('an id of the maximum length (120) is still accepted as an id', async () => {
      const r = await rawRequest(server, `/api/sessions/${'x'.repeat(120)}/audio`);
      expect(r.status).toBe(404); // safe id, simply no file
    });
  });

  it('a session record on disk is served back verbatim, minus nothing', async () => {
    const summary: Partial<SessionSummary> = {
      recordId: 'handmade-record-1',
      sessionId: 's',
      mode: 'pipeline',
      label: 'hand',
      config: { mode: 'pipeline', systemPrompt: 'hand prompt', turnDetection: 'manual' },
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      turnCount: 0,
      totals: [],
      costUsd: 0,
      costInr: 0,
      unpriced: [],
      turns: [],
      latency: {},
      usdPerInr: 1 / 94.43,
    };
    writeFileSync(join(server.sessionDir, 'handmade-record-1.json'), JSON.stringify(summary));
    const r = await fetch(`${server.base}/api/sessions/handmade-record-1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(summary);
    const list = (await (await fetch(`${server.base}/api/sessions`)).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    const row = list.sessions.find((s) => s.recordId === 'handmade-record-1')!;
    expect(row).toBeDefined();
    // The listing hashes the prompt instead of repeating it.
    expect(row.config).toEqual({ mode: 'pipeline', turnDetection: 'manual' });
    expect(row.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a damaged record is skipped by the listing rather than failing it', async () => {
    writeFileSync(join(server.sessionDir, 'broken-record.json'), '{ not json');
    const r = await fetch(`${server.base}/api/sessions`);
    expect(r.status).toBe(200);
    const { sessions } = (await r.json()) as { sessions: Array<{ recordId: string }> };
    expect(sessions.some((s) => s.recordId === 'broken-record')).toBe(false);
    expect((await fetch(`${server.base}/api/sessions/broken-record`)).status).toBe(404);
  });

  it('with no STATIC_DIR, unknown paths are plain 404s and no UI is served', async () => {
    expect((await fetch(`${server.base}/`)).status).toBe(404);
    expect((await fetch(`${server.base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${server.base}/some/spa/route`)).status).toBe(404);
  });

  describe('CORS (default origin list)', () => {
    it('reflects the default dev origin', async () => {
      const r = await fetch(`${server.base}/api/health`, { headers: { origin: 'http://localhost:5173' } });
      expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(r.headers.get('vary')).toMatch(/origin/i);
    });

    it('grants nothing to an origin that is not listed', async () => {
      const r = await fetch(`${server.base}/api/health`, { headers: { origin: 'http://evil.example' } });
      expect(r.status).toBe(200); // CORS is enforced by the browser, not by refusing
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('answers a preflight for an allowed origin', async () => {
      const r = await rawRequest(server, '/api/auth/login', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(r.status).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(String(r.headers['access-control-allow-methods'])).toContain('POST');
    });
  });

  it('a malformed JSON body is rejected with a 400 and does not take the server down', async () => {
    const r = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ nope',
    });
    expect(r.status).toBe(400);
    expect((await fetch(`${server.base}/api/health`)).status).toBe(200);
  });
});
