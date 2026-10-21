import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootServer,
  filesIn,
  findRecordByPrompt,
  frames,
  loudPcm,
  pipelineConfig,
  realtimeConfig,
  silentPcm,
  uniquePrompt,
  until,
  WsClient,
  type ServerHandle,
} from './helpers.js';
import type { SessionSummary } from '../../../src/shared/protocol.js';

describe('realtime mode over /ws/session (mock speech-to-speech)', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('runs a typed turn through the same protocol as the pipeline', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('realtime-text');
    ws.send({ type: 'start', config: realtimeConfig(prompt) });
    const started = await ws.next('session_started');
    expect(started).toMatchObject({ mode: 'realtime', sampleRate: 24_000, label: 'mock-realtime:mock-s2s' });

    ws.send({ type: 'user_text', text: 'ping' });
    expect(await ws.next('transcript', (t) => t.role === 'user')).toMatchObject({ text: 'ping', final: true, turnId: 1 });
    await ws.next('turn_start', (t) => t.turnId === 1);
    const final = await ws.next('transcript', (t) => t.role === 'assistant' && t.final);
    expect(final.text).toBe('You typed: ping. The mock realtime provider replies with a synthetic voice.');
    // Partials grow word by word before the final.
    const partials = ws.all('transcript').filter((t) => t.role === 'assistant' && !t.final);
    expect(partials.length).toBeGreaterThan(1);
    expect(final.text.startsWith(partials[0].text)).toBe(true);
    await ws.next('turn_end', (t) => t.turnId === 1);
    const metrics = await ws.next('metrics', (m) => m.turnId === 1);
    const usage = await ws.next('usage', (u) => u.turnId === 1);
    const audio = ws.audioBytes();

    // 40 ms PCM16 frames = 1920 bytes each, except possibly the last.
    expect(ws.audio.slice(0, -1).every((f) => f.length === 1920)).toBe(true);
    expect(metrics.marks.map((m) => m.name)).toEqual(['user_speech_end', 'first_audio_out', 'last_audio_out']);
    expect(metrics.derived.timeToFirstAudioMs).toBeGreaterThanOrEqual(250); // the mock's ~300 ms first-audio delay
    expect(metrics.derived.audioDurationMs).toBeCloseTo(audio.length / 48, 0);

    // Speech-to-speech is one leg, billed on audio in both directions.
    expect(usage.usage.legs).toHaveLength(1);
    expect(usage.usage.legs[0]).toMatchObject({
      leg: 'realtime',
      providerId: 'mock-realtime',
      modelId: 'mock-s2s',
      unit: 'audio_seconds',
      inputUnits: 0,
      source: 'local',
    });
    expect(usage.usage.legs[0].outputUnits).toBeCloseTo(audio.length / 48_000, 3);

    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary).toMatchObject({ mode: 'realtime', turnCount: 1, label: 'mock-realtime:mock-s2s' });
    expect(summary.totals.map((l) => l.leg)).toEqual(['realtime']);
    expect((await ws.next('session_closed')).reason).toBe('ended');
    const onDisk = JSON.parse(readFileSync(join(server.sessionDir, `${summary.recordId}.json`), 'utf8'));
    expect(onDisk).toEqual(summary);
    await ws.close();
  });

  it('runs a spoken turn on the provider VAD and bills the audio that preceded it', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: realtimeConfig(uniquePrompt('realtime-voice')) });
    await ws.next('session_started');
    // The mock commits on the 16th silent 40 ms frame; everything up to and
    // including it belongs to the turn: 600 ms + 640 ms.
    for (const f of frames(Buffer.concat([loudPcm(600), silentPcm(640)]))) ws.sendAudio(f);
    const user = await ws.next('transcript', (t) => t.role === 'user');
    expect(user).toMatchObject({ text: '(mock heard you speak)', final: true, turnId: 1 });

    // Barge-in: speech over the answer cuts it off, and the partial turn is still billed.
    await ws.audioFrames(3);
    ws.sendAudio(loudPcm(40));
    // The mock bills before it closes the turn; the order is not part of the protocol.
    await ws.seen('turn_end', (t) => t.turnId === 1);
    const usage = await ws.seen('usage', (u) => u.turnId === 1);
    const leg = usage.usage.legs[0];
    expect(leg.inputUnits).toBe(1.24);
    expect(leg.outputUnits).toBeGreaterThan(0);
    // The full answer is ~5 s; the cut came after a handful of 40 ms frames.
    expect(leg.outputUnits).toBeLessThan(2);
    // An interrupted answer never reaches its final transcript or metrics.
    expect(ws.all('transcript').some((t) => t.role === 'assistant' && t.final)).toBe(false);
    expect(ws.all('metrics')).toEqual([]);

    ws.send({ type: 'end_conversation' });
    expect((await ws.next('session_summary')).summary.turnCount).toBe(1);
    await ws.close();
  });

  it('a client that vanishes mid-answer still gets its turn billed, filed and recorded', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('realtime-vanish');
    ws.send({ type: 'start', config: realtimeConfig(prompt) });
    await ws.next('session_started');
    ws.send({ type: 'start_recording' });
    ws.send({ type: 'user_text', text: 'then I close the tab' });
    await ws.audioFrames(2);
    await ws.terminate(); // no close handshake, like a killed tab

    const row = await findRecordByPrompt(server, prompt);
    expect(row.turnCount).toBe(1);
    const record = (await (await fetch(`${server.base}/api/sessions/${row.recordId}`)).json()) as SessionSummary;
    const leg = record.turns[0].legs[0];
    expect(leg.leg).toBe('realtime');
    expect(leg.outputUnits).toBeGreaterThan(0);
    expect(leg.outputUnits).toBeLessThan(3);

    // The recording is finalised too, and no channel temp files are left behind.
    await until(() => filesIn(server.sessionDir).includes(`${row.recordId}.wav`), 'the WAV');
    await until(() => !filesIn(server.sessionDir).some((f) => f.startsWith(row.recordId) && f.endsWith('.tmp')), 'temp cleanup');
    const audio = await fetch(`${server.base}/api/sessions/${row.recordId}/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/wav');
    await audio.arrayBuffer();

    expect((await fetch(`${server.base}/api/health`)).status).toBe(200);
  });

  it('a second start ends the first conversation with a summary but no closure', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const first = uniquePrompt('replace-first');
    ws.send({ type: 'start', config: realtimeConfig(first) });
    const s1 = await ws.next('session_started');
    ws.send({ type: 'user_text', text: 'one' });
    await ws.next('usage');

    const second = uniquePrompt('replace-second');
    ws.send({ type: 'start', config: pipelineConfig(second) });
    const { summary } = await ws.next('session_summary');
    expect(summary.sessionId).toBe(s1.sessionId);
    expect(summary.config.systemPrompt).toBe(first);
    expect(summary.turnCount).toBe(1);
    const s2 = await ws.next('session_started');
    expect(s2.mode).toBe('pipeline');
    // Replaced, not closed: the client asked for a new session, not an ending.
    expect(ws.all('session_closed')).toEqual([]);

    // The first record is filed with its final endedAt; the new one is separate.
    const row = await findRecordByPrompt(server, first);
    expect(row.recordId).toBe(summary.recordId);
    const filed = (await (await fetch(`${server.base}/api/sessions/${row.recordId}`)).json()) as SessionSummary;
    expect(filed.endedAt).toBe(summary.endedAt);

    ws.send({ type: 'user_text', text: 'two' });
    const usage = await ws.next('usage');
    expect(usage.turnId).toBe(1); // turn numbering restarts with the conversation
    ws.send({ type: 'end_conversation' });
    const end = await ws.next('session_summary');
    expect(end.summary.recordId).not.toBe(summary.recordId);
    expect(end.summary.config.systemPrompt).toBe(second);
    await ws.close();
  });

  it('stop drops the session without a summary, but what ran is still on disk', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('stop');
    ws.send({ type: 'start', config: realtimeConfig(prompt) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: 'stop after this' });
    await ws.next('usage');
    ws.send({ type: 'stop' });
    const closed = await ws.next('session_closed');
    expect(closed.reason).toBeUndefined();
    expect(ws.all('session_summary')).toEqual([]);
    // The socket stays open after stop.
    expect(ws.isClosed).toBe(false);
    const row = await findRecordByPrompt(server, prompt);
    expect(row.turnCount).toBe(1);
    // Text after stop goes nowhere.
    ws.send({ type: 'user_text', text: 'into the void' });
    ws.send({ type: 'end_conversation' });
    await ws.next('session_closed', (m) => m.reason === 'ended');
    expect(ws.all('transcript').filter((t) => t.text === 'into the void')).toEqual([]);
    await ws.close();
  });
});
