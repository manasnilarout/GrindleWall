import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { bootServer, login, pipelineConfig, realtimeConfig, uniquePrompt, WsClient, type ServerHandle } from './helpers.js';
import { findProvider } from '../../../src/providers/catalog.js';

/*
 * A real provider, a fake key, and a local stand-in for the vendor that does
 * what real vendors do on a bad key: quote it back. OpenAI's own 401 reads
 * "Incorrect API key provided: sk-...". Every byte the client receives is
 * checked for the key; nothing here touches the network beyond 127.0.0.1.
 */
const FAKE_KEY = `sk-test-${'9f3c'.repeat(10)}`;
// Under redactSecrets' 12-character floor, so only the explicit login-secret pass can catch it.
const PASSWORD = 'Zq7-pass';
const HMAC_SECRET = 'hmac-secret-for-redaction-suite';
const AWS_SECRET = 'aws-secret-access-key-fake-0123456789';

describe('secrets never reach the client', () => {
  let vendor: Server;
  let vendorWs: WebSocketServer;
  let vendorPort: number;
  const seenAuth: string[] = [];
  let server: ServerHandle;
  let token: string;

  beforeAll(async () => {
    vendor = createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization));
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${FAKE_KEY}. (debug: pw=${PASSWORD} hmac=${HMAC_SECRET} aws=${AWS_SECRET})`,
            },
          }),
        );
      });
    });
    vendorWs = new WebSocketServer({ server: vendor, path: '/v1/realtime' });
    vendorWs.on('connection', (sock, req) => {
      seenAuth.push(String(req.headers.authorization));
      // A close reason is capped at 123 bytes, which fits the key.
      sock.close(1008, `invalid_api_key ${FAKE_KEY}`);
    });
    await new Promise<void>((r) => vendor.listen(0, '127.0.0.1', () => r()));
    const addr = vendor.address();
    vendorPort = typeof addr === 'object' && addr ? addr.port : 0;

    server = await bootServer({
      env: {
        AUTH_PASSWORD: PASSWORD,
        AUTH_HMAC_SECRET: HMAC_SECRET,
        OPENAI_API_KEY: FAKE_KEY,
        OPENAI_BASE_URL: `http://127.0.0.1:${vendorPort}/v1`,
        OPENAI_WS_BASE: `ws://127.0.0.1:${vendorPort}/v1/realtime`,
        SARVAM_API_KEY: 'sarvam-fake-key-for-readiness',
        ELEVENLABS_API_KEY: 'eleven-fake-key-for-readiness',
        AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKE',
        AWS_SECRET_ACCESS_KEY: AWS_SECRET,
        AWS_DEFAULT_REGION: 'us-east-1',
      },
    });
    token = await login(server, PASSWORD, HMAC_SECRET);
  });

  afterAll(async () => {
    await server?.stop();
    vendorWs?.close();
    await new Promise<void>((r) => (vendor ? vendor.close(() => r()) : r()));
  });

  const SECRETS = () => [FAKE_KEY, PASSWORD, HMAC_SECRET, AWS_SECRET];
  function expectClean(ws: WsClient): void {
    for (const frame of ws.rawText) for (const s of SECRETS()) expect(frame).not.toContain(s);
  }

  it('readiness flips for exactly the providers whose keys are now set', async () => {
    const r = await fetch(`${server.base}/api/catalog`, { headers: { authorization: `Bearer ${token}` } });
    const { providers } = (await r.json()) as {
      providers: Array<{ id: string; ready: boolean; missingEnv: string[]; implemented: boolean }>;
    };
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    for (const id of ['openai-realtime', 'openai-llm', 'sarvam-stt', 'sarvam-tts', 'elevenlabs-tts']) {
      expect(by[id], id).toMatchObject({ ready: true, missingEnv: [] });
    }
    // AWS_DEFAULT_REGION satisfies AWS_REGION through envAliases.
    expect(by['aws-nova-sonic']).toMatchObject({ ready: true, missingEnv: [] });
    // Keys present but not implemented: still not ready.
    expect(by['openai-tts']).toMatchObject({ implemented: false, ready: false, missingEnv: [] });
    // One of two keys set: the other is reported missing.
    expect(by['elevenlabs-agents'].missingEnv).toEqual(['ELEVENLABS_AGENT_ID']);
    expect(by['cartesia-tts']).toMatchObject({ ready: false, missingEnv: ['CARTESIA_API_KEY'] });
    // The catalog reports which keys are present — never their values.
    const text = JSON.stringify(providers);
    for (const s of SECRETS()) expect(text).not.toContain(s);
  });

  it('a vendor 401 quoting the key reaches the client scrubbed (pipeline LLM leg)', async () => {
    const ws = await WsClient.connect(`${server.wsUrl}?token=${token}`);
    const prompt = uniquePrompt('redact-llm');
    ws.send({
      type: 'start',
      config: pipelineConfig(prompt, { llmProviderId: 'openai-llm', llmModelId: findProvider('openai-llm')!.models[0].id }),
    });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: 'trigger the vendor error' });
    const err = await ws.next('error');
    // The adapter really did send the key upstream, and the vendor really did echo it.
    expect(seenAuth).toContain(`Bearer ${FAKE_KEY}`);
    expect(err.message).toMatch(/^OpenAI 401: Incorrect API key provided: «OPENAI_API_KEY redacted»/);
    expect(err.message).toContain('pw=«AUTH_PASSWORD redacted»');
    expect(err.message).toContain('hmac=«AUTH_HMAC_SECRET redacted»');
    expect(err.message).toContain('aws=«AWS_SECRET_ACCESS_KEY redacted»');

    // The turn still closes out and is billed, so the record is written...
    await ws.next('usage');
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();
    expectClean(ws);

    // ...and neither it nor anything else in the session dir holds a secret.
    for (const f of readdirSync(server.sessionDir)) {
      const body = readFileSync(join(server.sessionDir, f), 'latin1');
      for (const s of [...SECRETS(), token]) expect(body, f).not.toContain(s);
    }
    const detail = await (await fetch(`${server.base}/api/sessions/${summary.recordId}?token=${token}`)).text();
    for (const s of SECRETS()) expect(detail).not.toContain(s);
    expect(detail).toContain(prompt); // the prompt is persisted, deliberately
  });

  it('a vendor that closes the handshake quoting the key is scrubbed (realtime start failure)', async () => {
    const ws = await WsClient.connect(`${server.wsUrl}?token=${token}`);
    ws.send({
      type: 'start',
      config: realtimeConfig('x', { realtimeProviderId: 'openai-realtime', realtimeModelId: findProvider('openai-realtime')!.models[0].id }),
    });
    const err = await ws.next('error');
    expect(err.message).toBe(
      'Failed to start session: OpenAI Realtime closed during handshake (1008: invalid_api_key «OPENAI_API_KEY redacted»)',
    );
    expect(ws.all('session_started')).toEqual([]);
    await ws.close();
    expectClean(ws);
  });

  it('the scrubbed values are still the ones in use — auth works with them', async () => {
    // Guards against a vacuous pass: the server really is configured with these.
    const cfg = (await (await fetch(`${server.base}/api/auth/config`)).json()) as { required: boolean; hmacSecret: string };
    expect(cfg).toMatchObject({ required: true, hmacSecret: HMAC_SECRET });
  });
});
