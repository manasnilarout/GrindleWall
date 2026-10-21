import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootServer,
  frames,
  loudPcm,
  pipelineConfig,
  sha256,
  silentPcm,
  uniquePrompt,
  until,
  WsClient,
  type ServerHandle,
} from './helpers.js';
import type { MetricName, SessionIndexEntry, SessionSummary } from '../../../src/shared/protocol.js';

const CANNED = [
  'What is the weather like today',
  'Tell me a short joke about latency',
  'Can you summarise that in one sentence',
  'How long does it take you to respond',
];

const ALL_MARKS: MetricName[] = [
  'user_speech_end',
  'stt_final',
  'tts_request_sent',
  'llm_request_sent',
  'llm_first_token',
  'tts_first_audio',
  'first_audio_out',
  'llm_last_token',
  'last_audio_out',
];

describe('pipeline mode over /ws/session (mock STT → LLM → TTS)', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('runs two typed turns end to end and files a record identical to the summary', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('pipeline-text');
    ws.send({ type: 'start', config: pipelineConfig(prompt, { voice: 'beep', language: 'en' }) });

    const started = await ws.next('session_started');
    expect(started.mode).toBe('pipeline');
    expect(started.sampleRate).toBe(24_000);
    expect(started.sessionId).toMatch(/^[0-9a-f]{8}$/);
    expect(started.label).toBe('mock-stt:mock-asr → mock-llm:mock-chat → mock-tts:mock-voice');
    // The ready log comes from the provider and is relayed (scrubbed) as a log frame.
    expect(ws.all('log').some((l) => l.level === 'info' && l.message.startsWith('pipeline ready:'))).toBe(true);

    // ---- turn 1 -------------------------------------------------------------
    ws.send({ type: 'user_text', text: 'first question' });
    const user1 = await ws.next('transcript', (t) => t.role === 'user');
    expect(user1).toMatchObject({ text: 'first question', final: true, turnId: 1 });
    await ws.next('turn_start', (t) => t.turnId === 1);
    const partial = await ws.next('transcript', (t) => t.role === 'assistant' && !t.final);
    expect(partial.turnId).toBe(1);
    const final1 = await ws.next('transcript', (t) => t.role === 'assistant' && t.final);
    expect(final1.text).toMatch(/^You said: first question\. This is the mock model/);
    await ws.next('turn_end', (t) => t.turnId === 1);
    const metrics1 = await ws.next('metrics', (m) => m.turnId === 1);
    const usage1 = await ws.next('usage', (u) => u.turnId === 1);
    const turn1Audio = ws.audioBytes();

    // Audio: binary PCM16 frames, all between turn_start and turn_end.
    expect(ws.audio.length).toBeGreaterThan(5);
    for (const f of ws.audio) expect(f.length % 2).toBe(0);
    const kinds = ws.timeline.map((e) => (e.kind === 'audio' ? 'audio' : e.msg.type));
    const firstAudio = kinds.indexOf('audio');
    expect(firstAudio).toBeGreaterThan(kinds.indexOf('turn_start'));
    expect(kinds.lastIndexOf('audio')).toBeLessThan(kinds.indexOf('turn_end'));
    // And it is audible PCM, not zeros.
    expect(turn1Audio.some((b) => b !== 0)).toBe(true);

    // Metrics: every mark, in time order, t0 at the user's speech end.
    const names = metrics1.marks.map((m) => m.name);
    expect([...names].sort()).toEqual([...ALL_MARKS].sort());
    // Marks are relative to the turn's start and rounded to 0.1 ms, so t0 is ~0.
    expect(metrics1.marks[0].name).toBe('user_speech_end');
    expect(metrics1.marks[0].atMs).toBeLessThan(5);
    for (let i = 1; i < metrics1.marks.length; i++) {
      expect(metrics1.marks[i].atMs).toBeGreaterThanOrEqual(metrics1.marks[i - 1].atMs);
    }
    const at = (n: MetricName) => metrics1.marks.find((m) => m.name === n)!.atMs;
    const d = metrics1.derived;
    // Derived values are rounded independently of the marks, hence closeTo.
    expect(d.timeToFirstAudioMs).toBeCloseTo(at('first_audio_out') - at('user_speech_end'), 0);
    expect(d.timeToFirstAudioMs!).toBeGreaterThan(50); // mock LLM TTFT 180 ms + TTS TTFB 90 ms
    expect(d.llmTtftMs).toBeCloseTo(at('llm_first_token') - at('llm_request_sent'), 0);
    expect(d.ttsTtfbMs).toBeCloseTo(at('tts_first_audio') - at('tts_request_sent'), 0);
    expect(d.totalTurnMs!).toBeGreaterThanOrEqual(at('last_audio_out') - 1);
    expect(d.audioDurationMs).toBeCloseTo(turn1Audio.length / 48, 0);

    // Usage: one leg per stage, each in the unit that vendor bills.
    expect(usage1.usage.turnId).toBe(1);
    const legs = Object.fromEntries(usage1.usage.legs.map((l) => [l.leg, l]));
    expect(Object.keys(legs).sort()).toEqual(['llm', 'stt', 'tts']);
    expect(legs.stt).toMatchObject({ providerId: 'mock-stt', modelId: 'mock-asr', unit: 'audio_seconds', inputUnits: 0, source: 'local' });
    expect(legs.llm).toMatchObject({ providerId: 'mock-llm', modelId: 'mock-chat', unit: 'tokens', source: 'local' });
    expect(legs.llm.inputUnits).toBe(Math.round((prompt.length + 'first question'.length) / 4));
    expect(legs.llm.outputUnits).toBe(Math.round(final1.text.length / 4));
    expect(legs.tts).toMatchObject({ providerId: 'mock-tts', modelId: 'mock-voice', unit: 'characters', source: 'local' });
    expect(legs.tts.outputUnits).toBe(final1.text.length);
    expect(legs.tts.audioSeconds).toBeCloseTo(turn1Audio.length / 48_000, 2);
    for (const l of usage1.usage.legs) {
      expect(l.cost).toMatchObject({ amount: 0, amountUsd: 0, amountInr: 0, currency: 'USD' });
      expect(l.unpricedReason).toBeUndefined();
    }
    expect(usage1.usage).toMatchObject({ costUsd: 0, costInr: 0, unpriced: [] });

    // ---- turn 2: history carries over ----------------------------------------
    ws.send({ type: 'user_text', text: 'second question' });
    expect((await ws.next('transcript', (t) => t.role === 'user')).turnId).toBe(2);
    const final2 = await ws.next('transcript', (t) => t.role === 'assistant' && t.final);
    expect(final2.text).toMatch(/^You said: second question\./);
    await ws.next('metrics', (m) => m.turnId === 2);
    const usage2 = await ws.next('usage', (u) => u.turnId === 2);
    const llm2 = usage2.usage.legs.find((l) => l.leg === 'llm')!;
    // The second request carries the system prompt, both user turns and the first answer.
    expect(llm2.inputUnits).toBe(
      Math.round((prompt.length + 'first question'.length + final1.text.length + 'second question'.length) / 4),
    );

    // ---- persisted after each turn, before the conversation ends -------------
    const listed = await until(async () => {
      const { sessions } = (await (await fetch(`${server.base}/api/sessions`)).json()) as { sessions: SessionIndexEntry[] };
      return sessions.find((s) => s.promptSha256 === sha256(prompt) && s.turnCount === 2);
    }, 'the in-flight record');
    expect(listed.mode).toBe('pipeline');

    // ---- end ------------------------------------------------------------------
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    const closed = await ws.next('session_closed');
    expect(closed.reason).toBe('ended');

    expect(summary.recordId).toBe(listed.recordId);
    expect(summary.sessionId).toBe(started.sessionId);
    expect(summary.label).toBe(started.label);
    expect(summary.mode).toBe('pipeline');
    expect(summary.turnCount).toBe(2);
    expect(summary.turns.map((t) => t.turnId)).toEqual([1, 2]);
    expect(summary.config).toEqual(pipelineConfig(prompt, { voice: 'beep', language: 'en' }));
    expect(summary.endedAt).toBeGreaterThanOrEqual(summary.startedAt);
    expect(summary.durationMs).toBe(summary.endedAt - summary.startedAt);
    expect(summary.usdPerInr).toBeCloseTo(1 / 94.43, 12);
    // Totals are summed from the per-turn rows, so they can never disagree.
    for (const leg of ['stt', 'llm', 'tts'] as const) {
      const total = summary.totals.find((l) => l.leg === leg)!;
      const sum = summary.turns.flatMap((t) => t.legs).filter((l) => l.leg === leg).reduce((n, l) => n + l.outputUnits, 0);
      expect(total.outputUnits).toBeCloseTo(sum, 6);
    }
    expect(summary.costUsd).toBe(summary.turns.reduce((n, t) => n + t.costUsd, 0));
    expect(summary.latency.ttfaMedianMs).toBeGreaterThan(0);

    // The file on disk is the summary, and the detail route serves it.
    const onDisk = JSON.parse(readFileSync(join(server.sessionDir, `${summary.recordId}.json`), 'utf8')) as SessionSummary;
    expect(onDisk).toEqual(summary);
    const detail = (await (await fetch(`${server.base}/api/sessions/${summary.recordId}`)).json()) as SessionSummary;
    expect(detail).toEqual(summary);

    // The listing row matches it and does not repeat the prompt.
    const { sessions } = (await (await fetch(`${server.base}/api/sessions`)).json()) as { sessions: SessionIndexEntry[] };
    const row = sessions.find((s) => s.recordId === summary.recordId)!;
    expect(row).toMatchObject({ turnCount: 2, label: started.label, durationMs: summary.durationMs });
    expect(row.config).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(row)).not.toContain(prompt);
    expect(row.speechSeconds).toBeGreaterThan(0);

    await ws.close();
  });

  it('runs a spoken turn: VAD endpointing, a canned transcript, STT billed in audio seconds, and a tail record', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('pipeline-voice');
    ws.send({ type: 'start', config: pipelineConfig(prompt) });
    await ws.next('session_started');

    // 600 ms of speech then 800 ms of silence, in 40 ms frames. The mock VAD
    // endpoints on the 16th silent frame (>600 ms), so the turn owns the speech
    // plus 15 silent frames = 1.2 s; the 5 frames from the trigger on bank for later.
    for (const f of frames(Buffer.concat([loudPcm(600), silentPcm(800)]))) ws.sendAudio(f);

    const user = await ws.next('transcript', (t) => t.role === 'user' && t.final);
    expect(CANNED).toContain(user.text);
    expect(user.turnId).toBe(1);
    const metrics = await ws.next('metrics');
    expect(metrics.marks[0].name).toBe('user_speech_end');
    const usage = await ws.next('usage', (u) => u.turnId === 1);
    expect(usage.usage.legs.find((l) => l.leg === 'stt')!.inputUnits).toBe(1.2);

    // 500 ms more silence: no speech, so no turn — but the vendor still metered it.
    for (const f of frames(silentPcm(500))) ws.sendAudio(f);
    ws.send({ type: 'end_conversation' });

    const tail = await ws.next('usage', (u) => u.turnId === 2);
    expect(tail.usage.legs).toHaveLength(1);
    expect(tail.usage.legs[0]).toMatchObject({ leg: 'stt', unit: 'audio_seconds', inputUnits: 0.7, outputUnits: 0 });
    expect(
      ws.all('log').some((l) => l.message === '0.7s of audio reached mock-stt after the last turn; billed separately.'),
    ).toBe(true);

    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(2);
    expect(summary.turns[1].legs.map((l) => l.leg)).toEqual(['stt']);
    expect(summary.totals.find((l) => l.leg === 'stt')!.inputUnits).toBeCloseTo(1.9, 6);
    await ws.next('session_closed');
    await ws.close();
  });

  it('manual turn detection: nothing happens until commit_audio', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('manual'), { turnDetection: 'manual' }) });
    await ws.next('session_started');
    for (const f of frames(Buffer.concat([loudPcm(400), silentPcm(1000)]))) ws.sendAudio(f);
    ws.send({ type: 'commit_audio' });
    const user = await ws.next('transcript', (t) => t.role === 'user' && t.final);
    // The commit is the only thing that could have ended this turn; VAD is off.
    expect(user.turnId).toBe(1);
    expect(CANNED).toContain(user.text);
    const usage = await ws.next('usage');
    expect(usage.usage.legs.find((l) => l.leg === 'stt')!.inputUnits).toBe(1.4);
    ws.send({ type: 'stop' });
    await ws.next('session_closed');
    await ws.close();
  });

  it('commit_audio over silence abandons the turn instead of billing one', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('silent-commit'), { turnDetection: 'manual' }) });
    await ws.next('session_started');
    ws.send({ type: 'commit_audio' });
    // The next real turn still gets id 1: the abandoned one did not burn it.
    ws.send({ type: 'user_text', text: 'after the false endpoint' });
    const user = await ws.next('transcript', (t) => t.role === 'user' && t.final);
    expect(user.turnId).toBe(1);
    const usage = await ws.next('usage');
    expect(usage.turnId).toBe(1);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(1);
    await ws.close();
  });

  it('an explicit interrupt ends the answer early and still bills what was produced', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('interrupt')) });
    await ws.next('session_started');
    // A long reply, so the cut lands while the model is still talking.
    ws.send({ type: 'user_text', text: Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') });
    await ws.audioFrames(1);
    ws.send({ type: 'interrupt' });
    await ws.next('turn_end', (t) => t.turnId === 1);
    const usage = await ws.next('usage', (u) => u.turnId === 1);
    const tts = usage.usage.legs.find((l) => l.leg === 'tts')!;
    expect(tts.outputUnits).toBeGreaterThan(0);
    // Cut off: far less was synthesised than the full ~1 KB reply.
    expect(tts.outputUnits).toBeLessThan(800);
    // No final assistant transcript: the answer never completed.
    expect(ws.all('transcript').some((t) => t.role === 'assistant' && t.final)).toBe(false);
    // The socket is still usable for the next turn.
    ws.send({ type: 'user_text', text: 'again' });
    expect((await ws.next('usage', (u) => u.turnId === 2)).turnId).toBe(2);
    ws.send({ type: 'end_conversation' });
    expect((await ws.next('session_summary')).summary.turnCount).toBe(2);
    await ws.close();
  });

  it('end_conversation with no turns files nothing and still reports a zero summary', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('empty');
    ws.send({ type: 'start', config: pipelineConfig(prompt) });
    await ws.next('session_started');
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(0);
    expect(summary.turns).toEqual([]);
    expect((await ws.next('session_closed')).reason).toBe('ended');
    expect(existsSync(join(server.sessionDir, `${summary.recordId}.json`))).toBe(false);
    expect((await fetch(`${server.base}/api/sessions/${summary.recordId}`)).status).toBe(404);
    await ws.close();
  });

  it('text and audio sent before start, or after stop, are ignored without an error', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.sendAudio(loudPcm(200));
    ws.send({ type: 'user_text', text: 'nobody is listening' });
    ws.send({ type: 'commit_audio' });
    ws.send({ type: 'interrupt' });
    ws.send({ type: 'start_recording' });
    ws.send({ type: 'end_conversation' });
    // No session, so no summary — only the closure.
    expect((await ws.next('session_closed')).reason).toBe('ended');
    expect(ws.all('error')).toEqual([]);
    expect(ws.all('session_summary')).toEqual([]);
    expect(ws.audio).toEqual([]);
    await ws.close();
  });

  it('serves many sockets at once, each with its own turn numbering', async () => {
    const clients = await Promise.all([0, 1, 2].map(() => WsClient.connect(server.wsUrl)));
    clients.forEach((c, i) => c.send({ type: 'start', config: pipelineConfig(uniquePrompt(`parallel-${i}`)) }));
    const ids = await Promise.all(clients.map(async (c) => (await c.next('session_started')).sessionId));
    expect(new Set(ids).size).toBe(3);
    clients.forEach((c, i) => c.send({ type: 'user_text', text: `client ${i}` }));
    const finals = await Promise.all(clients.map((c) => c.next('transcript', (t) => t.role === 'assistant' && t.final)));
    finals.forEach((f, i) => {
      expect(f.turnId).toBe(1);
      expect(f.text).toContain(`client ${i}`);
    });
    await Promise.all(clients.map((c) => c.next('usage')));
    clients.forEach((c) => c.send({ type: 'end_conversation' }));
    const summaries = await Promise.all(clients.map((c) => c.next('session_summary')));
    expect(new Set(summaries.map((s) => s.summary.recordId)).size).toBe(3);
    await Promise.all(clients.map((c) => c.close()));
  });
});
