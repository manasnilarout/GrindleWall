import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootServer, filesIn, pipelineConfig, rawRequest, uniquePrompt, until, WsClient, type ServerHandle } from './helpers.js';
import type { SessionIndexEntry } from '../../../src/shared/protocol.js';

describe('SESSION_MAX_RECORDS, custom CORS_ORIGINS and USD_PER_INR', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer({
      env: {
        SESSION_MAX_RECORDS: '2',
        CORS_ORIGINS: 'http://a.test, https://b.test',
        USD_PER_INR: '0.0125', // ₹80/$1
      },
    });
  });
  afterAll(async () => {
    await server?.stop();
  });

  async function conversation(tag: string): Promise<string> {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt(tag)) });
    await ws.next('session_started');
    ws.send({ type: 'start_recording' });
    // Wait for the recorder to arm, so this conversation leaves a WAV.
    await until(() => filesIn(server.sessionDir).some((f) => f.includes('.bot.') && f.endsWith('.tmp')), 'recorder armed');
    ws.send({ type: 'user_text', text: tag });
    await ws.next('usage');
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();
    await until(() => !filesIn(server.sessionDir).some((f) => f.endsWith('.tmp')), 'temps cleaned');
    return summary.recordId;
  }

  it('keeps only the newest N records, and prunes each one\'s WAV along with its JSON', async () => {
    const first = await conversation('prune-1');
    expect(filesIn(server.sessionDir)).toContain(`${first}.wav`);
    const second = await conversation('prune-2');
    const third = await conversation('prune-3');

    const { sessions } = (await (await fetch(`${server.base}/api/sessions`)).json()) as { sessions: SessionIndexEntry[] };
    expect(sessions.map((s) => s.recordId)).toEqual([third, second]);
    const files = filesIn(server.sessionDir).sort();
    expect(files).toEqual([`${second}.json`, `${second}.wav`, `${third}.json`, `${third}.wav`].sort());
    expect((await fetch(`${server.base}/api/sessions/${first}`)).status).toBe(404);
    expect((await fetch(`${server.base}/api/sessions/${first}/audio`)).status).toBe(404);
  });

  it('allows each listed origin, trimmed, and no longer the default dev origin', async () => {
    for (const origin of ['http://a.test', 'https://b.test']) {
      const r = await fetch(`${server.base}/api/health`, { headers: { origin } });
      expect(r.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
    const dev = await fetch(`${server.base}/api/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(dev.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await rawRequest(server, '/api/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://b.test', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://b.test');
  });

  it('prices with the overridden FX rate and says so in every summary', async () => {
    const pricing = (await (await fetch(`${server.base}/api/pricing`)).json()) as { usdPerInr: number; inrPerUsd: number };
    expect(pricing.usdPerInr).toBe(0.0125);
    expect(pricing.inrPerUsd).toBe(80);
    // Its own conversation, so this does not depend on the prune test having run first.
    const recordId = await conversation('fx');
    const detail = (await (await fetch(`${server.base}/api/sessions/${recordId}`)).json()) as { usdPerInr: number };
    expect(detail.usdPerInr).toBe(0.0125);
  });
});
