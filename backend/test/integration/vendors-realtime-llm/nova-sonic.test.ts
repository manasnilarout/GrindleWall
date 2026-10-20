/**
 * NovaSonicProvider's event handling, driven through its NovaTransport seam by
 * a local WebSocket standing in for Bedrock's HTTP/2 stream
 * (`NOVA_SONIC_WS_BASE`). See nova-bedrock.test.ts for the real SDK path.
 *
 * NOT VENDOR EVIDENCE: Nova Sonic has never completed a live call in this repo,
 * and this fake was written from the same docs as the provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventQueue, NovaSonicProvider } from '../../../src/providers/realtime/NovaSonicProvider.js';
import type { VoiceSession } from '../../../src/providers/types.js';
import type { StartConfig } from '../../../src/shared/protocol.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import { deadPort, flushIo, markOf, ramp, recorder, startWs, waitFor, type FakeWs, type Json, type Recorder } from './helpers.js';

const AWS_SECRET = 'test-secret-XYZ-nova';
const AWS_ID = 'AKIATESTXYZNOVA';

let fake: FakeWs;
const sessions: VoiceSession[] = [];

beforeEach(async () => {
  fake = await startWs();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await fake.close();
});

function create(
  config: Partial<StartConfig> = {},
  credentials: Record<string, string | undefined> = { NOVA_SONIC_WS_BASE: fake.url },
): { session: VoiceSession; rec: Recorder } {
  const rec = recorder();
  const session = new NovaSonicProvider().createSession({
    sessionId: 'nova-test',
    config: {
      mode: 'realtime',
      realtimeProviderId: 'aws-nova-sonic',
      realtimeModelId: 'amazon.nova-2-sonic-v1:0',
      systemPrompt: 'Speak clearly and briefly.',
      language: 'en-US',
      voice: 'tiffany',
      turnDetection: 'server_vad',
      ...config,
    },
    events: rec.events,
    credentials,
  });
  sessions.push(session);
  return { session, rec };
}

const PREAMBLE = ['sessionStart', 'promptStart', 'contentStart', 'textInput', 'contentEnd', 'contentStart'];

async function open(config: Partial<StartConfig> = {}, credentials?: Record<string, string | undefined>) {
  const made = create(config, credentials);
  await made.session.start();
  await waitFor(() => fake.received.length >= PREAMBLE.length, 'preamble');
  return made;
}

const nameOf = (m: Json) => Object.keys(m.event ?? {})[0] ?? '?';
const order = () => fake.received.map(nameOf);
const sentOf = (name: string): Json[] => fake.received.filter((m) => nameOf(m) === name).map((m) => m.event[name]);
const push = (body: Json) => fake.push({ event: body });

/**
 * Client -> server ordering barrier: a silent mic frame of a length no other
 * frame in these tests has. Returns its index in `fake.received`, so everything
 * before that index was sent before the barrier.
 */
let clientSeq = 0;
async function clientBarrier(session: VoiceSession): Promise<number> {
  const ms = 101 + (++clientSeq % 50); // 101..150ms -> ms*16 samples at Nova's 16 kHz
  const expected = ms * 16 * 2;
  session.pushAudio(silence(ms));
  const find = () =>
    fake.received.findIndex(
      (m) => nameOf(m) === 'audioInput' && Buffer.from(m.event.audioInput.content, 'base64').length === expected,
    );
  await waitFor(() => find() !== -1, 'client barrier');
  return find();
}

/** Server -> client ordering barrier: an unserved toolUse is logged, and is otherwise inert. */
let seq = 0;
async function serverBarrier(rec: Recorder): Promise<void> {
  const tag = `__barrier_${++seq}__`;
  push({ toolUse: { toolName: tag } });
  await waitFor(() => rec.logs.some((l) => l.includes(tag)), 'server barrier');
}

/** 360ms of speech then 720ms of silence: the local detector ends the utterance. */
function speakThenPause(session: VoiceSession, rate = 24000): void {
  for (let i = 0; i < 6; i++) session.pushAudio(tone(60, 220, rate));
  for (let i = 0; i < 12; i++) session.pushAudio(silence(60, rate));
}

/** A usageEvent with an incremental delta and a SESSION-CUMULATIVE total that must be ignored. */
const usage = (completionId: string, sIn: number, tIn: number, sOut: number, tOut: number) => ({
  usageEvent: {
    completionId,
    details: {
      delta: { input: { speechTokens: sIn, textTokens: tIn }, output: { speechTokens: sOut, textTokens: tOut } },
      total: { input: { speechTokens: 9e5, textTokens: 9e5 }, output: { speechTokens: 9e5, textTokens: 9e5 } },
    },
    totalInputTokens: 999_999,
    totalOutputTokens: 999_999,
    totalTokens: 1_999_998,
  },
});

const stage = (s: 'FINAL' | 'SPECULATIVE') => JSON.stringify({ generationStage: s });

/** Completion `cid` with one assistant audio block carrying `audio`. */
async function answer(rec: Recorder, cid: string, audio: Buffer = tone(60), expectBytes = audio.length): Promise<void> {
  const before = rec.audioBytes();
  push({ completionStart: { completionId: cid } });
  push({ contentStart: { completionId: cid, contentId: `${cid}-a`, type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: cid, contentId: `${cid}-a`, content: audio.toString('base64') } });
  await waitFor(() => rec.audioBytes() === before + expectBytes, 'answer audio');
}

/* ======================================================================== */

describe('Nova Sonic — preamble and request shape', () => {
  it('queues the preamble in the documented order, with the documented shapes (doc-derived, not measured)', async () => {
    await open();
    expect(order()).toEqual(PREAMBLE);

    expect(sentOf('sessionStart')[0]).toEqual({
      inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' },
    });

    const promptStart = sentOf('promptStart')[0];
    const promptName = promptStart.promptName;
    expect(promptName).toMatch(/^[0-9a-f-]{36}$/);
    expect(promptStart).toEqual({
      promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        mediaType: 'audio/lpcm',
        sampleRateHertz: 24000,
        sampleSizeBits: 16,
        channelCount: 1,
        voiceId: 'tiffany',
        encoding: 'base64',
        audioType: 'SPEECH',
      },
      toolUseOutputConfiguration: { mediaType: 'application/json' },
    });

    const [sys, audio] = sentOf('contentStart');
    expect(sys).toEqual({
      promptName,
      contentName: expect.any(String),
      type: 'TEXT',
      interactive: false,
      role: 'SYSTEM',
      textInputConfiguration: { mediaType: 'text/plain' },
    });
    expect(sentOf('textInput')[0]).toEqual({ promptName, contentName: sys.contentName, content: 'Speak clearly and briefly.' });
    expect(sentOf('contentEnd')[0]).toEqual({ promptName, contentName: sys.contentName });
    expect(audio).toEqual({
      promptName,
      contentName: expect.any(String),
      type: 'AUDIO',
      interactive: true,
      role: 'USER',
      audioInputConfiguration: {
        mediaType: 'audio/lpcm',
        sampleRateHertz: 16000,
        sampleSizeBits: 16,
        channelCount: 1,
        audioType: 'SPEECH',
        encoding: 'base64',
      },
    });
    expect(audio.contentName).not.toBe(sys.contentName);
  });

  it('every session invents its own promptName', async () => {
    await open();
    const first = sentOf('promptStart')[0].promptName;
    const { session } = create();
    await session.start();
    await waitFor(() => sentOf('promptStart').length === 2, 'second preamble');
    expect(sentOf('promptStart')[1].promptName).not.toBe(first);
  });

  it('drops config.language entirely — Nova has no field for one, under any spelling', async () => {
    await open({ language: 'hi-IN', sttLanguage: 'ta-IN', ttsLanguage: 'bn-IN' });
    const blob = fake.rawReceived.join('\n');
    expect(blob).not.toMatch(/"language\w*"|"locale"|"languageCode"/i);
    expect(blob).not.toMatch(/hi-IN|ta-IN|bn-IN/);
  });

  it('uses config.temperature when set, including 0', async () => {
    await open({ temperature: 0 });
    expect(sentOf('sessionStart')[0].inferenceConfiguration.temperature).toBe(0);
  });

  it('defaults the voice to tiffany and passes any other voice verbatim (not case-folded)', async () => {
    await open({ voice: '  ' });
    expect(sentOf('promptStart')[0].audioOutputConfiguration.voiceId).toBe('tiffany');
    const { session } = create({ voice: 'Matthew' });
    await session.start();
    await waitFor(() => sentOf('promptStart').length === 2, 'second preamble');
    expect(sentOf('promptStart')[1].audioOutputConfiguration.voiceId).toBe('Matthew');
  });

  it.each([
    ['low', 'LOW'],
    ['HIGH', 'HIGH'],
    ['bogus', 'MEDIUM'],
    [undefined, 'MEDIUM'],
  ])('NOVA_SONIC_ENDPOINTING=%s in credentials -> %s', async (value, expected) => {
    await open({}, { NOVA_SONIC_WS_BASE: fake.url, NOVA_SONIC_ENDPOINTING: value });
    expect(sentOf('sessionStart')[0].turnDetectionConfiguration).toEqual({ endpointingSensitivity: expected });
  });

  it('reads endpointing from credentials, not process.env', async () => {
    vi.stubEnv('NOVA_SONIC_ENDPOINTING', 'HIGH');
    await open();
    expect(sentOf('sessionStart')[0].turnDetectionConfiguration.endpointingSensitivity).toBe('MEDIUM');
  });

  it.each(['amazon.nova-sonic-v1:0', 'amazon.some-future-sonic'])(
    'model %s gets no turnDetectionConfiguration (v1 rejects the field; unknown ids get the safe profile)',
    async (model) => {
      const { session } = await open({ realtimeModelId: model });
      expect('turnDetectionConfiguration' in sentOf('sessionStart')[0]).toBe(false);
      expect(session.label).toBe(`aws-nova-sonic:${model}`);
    },
  );

  it('defaults the model id when the config has none', async () => {
    const { session } = await open({ realtimeModelId: undefined });
    expect(session.label).toBe('aws-nova-sonic:amazon.nova-2-sonic-v1:0');
  });
});

describe('Nova Sonic — credentials and failures to start', () => {
  it('refuses to start without AWS keys in ctx.credentials even when process.env has them', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'env-id-must-not-be-used');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret-must-not-be-used');
    vi.stubEnv('NOVA_SONIC_WS_BASE', fake.url);
    const { session } = create({}, {});
    await expect(session.start()).rejects.toThrow('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set');
    expect(fake.connections).toHaveLength(0);
  });

  it('only one AWS key is still refused', async () => {
    const { session } = create({}, { AWS_ACCESS_KEY_ID: AWS_ID });
    await expect(session.start()).rejects.toThrow('AWS_SECRET_ACCESS_KEY');
  });

  it('a transport that cannot connect rejects start() without leaking any key', async () => {
    const port = await deadPort();
    const { session, rec } = create({}, {
      NOVA_SONIC_WS_BASE: `ws://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: AWS_ID,
      AWS_SECRET_ACCESS_KEY: AWS_SECRET,
    });
    const err = await session.start().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(`${err?.message}${err?.stack}`).not.toContain(AWS_SECRET);
    await flushIo();
    expect(rec.everything()).not.toContain(AWS_SECRET);
    // The session is dead: nothing it is handed afterwards goes anywhere.
    expect(() => session.pushAudio(tone(20))).not.toThrow();
  });

  it('no key material ever reaches the wire or the session events', async () => {
    const { session, rec } = await open({}, {
      NOVA_SONIC_WS_BASE: fake.url,
      AWS_ACCESS_KEY_ID: AWS_ID,
      AWS_SECRET_ACCESS_KEY: AWS_SECRET,
    });
    speakThenPause(session);
    await answer(rec, 'c1');
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    await session.close();
    expect(fake.rawReceived.join('')).not.toContain(AWS_SECRET);
    expect(fake.rawReceived.join('')).not.toContain(AWS_ID);
    expect(rec.everything()).not.toContain(AWS_SECRET);
  });
});

describe('Nova Sonic — audio at the boundary', () => {
  it('converts 24 kHz mic audio to Nova\'s 16 kHz, frame for frame, into the ONE audio block', async () => {
    const { session } = await open();
    const audioBlock = sentOf('contentStart')[1].contentName;
    const promptName = sentOf('promptStart')[0].promptName;
    session.pushAudio(ramp(1440)); // 60ms @ 24k
    session.pushAudio(ramp(480, 5)); // 20ms @ 24k
    await waitFor(() => sentOf('audioInput').length === 2, 'audioInput');
    const [a, b] = sentOf('audioInput');
    expect(a.promptName).toBe(promptName);
    expect(a.contentName).toBe(audioBlock);
    expect(Buffer.from(a.content, 'base64').length).toBe(960 * 2);
    expect(Buffer.from(b.content, 'base64').length).toBe(320 * 2);
    expect(sentOf('contentStart')).toHaveLength(2); // no per-turn block was opened
  });

  it('drops empty mic frames, and mic frames pushed before start()', async () => {
    const { session } = create();
    session.pushAudio(tone(20));
    await session.start();
    session.pushAudio(Buffer.alloc(0));
    const n = await clientBarrier(session);
    expect(fake.received.slice(0, n).map(nameOf)).toEqual(PREAMBLE);
  });

  it('emits vendor audio at 24 kHz byte-for-byte, per audioOutput, as it arrives', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    const first = ramp(2400);
    await answer(rec, 'c1', first);
    expect(rec.audio[0].equals(first)).toBe(true);
    const second = ramp(1200, 13);
    push({ audioOutput: { completionId: 'c1', contentId: 'c1-a', content: second.toString('base64') } });
    await waitFor(() => rec.audio.length === 2, 'second chunk');
    expect(rec.audio[1].equals(second)).toBe(true);
  });

  it('resamples against the session rate: 16 kHz boundary -> mic untouched, vendor 24 kHz -> 16 kHz', async () => {
    const { session, rec } = create();
    (session as unknown as { sessionRate: number }).sessionRate = 16000;
    await session.start();
    const mic = ramp(960);
    session.pushAudio(mic);
    await waitFor(() => sentOf('audioInput').length === 1, 'audioInput');
    expect(Buffer.from(sentOf('audioInput')[0].content, 'base64').equals(mic)).toBe(true);

    session.commitAudio(); // server_vad: no-op; open the turn from the completion instead
    await answer(rec, 'c1', ramp(1440), 960 * 2);
    push(usage('c1', 1, 1, 1, 1));
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    // 1440 samples at 24k is 60ms, and stays 60ms at 16k.
    expect(rec.usage[0].legs[0].audioSeconds).toBe(0.06);
  });

  it('an empty audioOutput emits nothing', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    push({ completionStart: { completionId: 'c1' } });
    push({ audioOutput: { completionId: 'c1', content: '' } });
    await serverBarrier(rec);
    expect(rec.audio).toEqual([]);
  });
});

describe('Nova Sonic — turns and t0', () => {
  it('t0 comes from the LOCAL detector, before Nova says anything; first audio is measured from it', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    expect(rec.turnStarts).toEqual([1]); // synchronous, no server event involved
    await answer(rec, 'c1');
    push({ contentEnd: { completionId: 'c1', contentId: 'c1-a', stopReason: 'END_TURN' } });
    push(usage('c1', 30, 12, 60, 20));
    push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.turnEnds).toEqual([1]);
    const { marks, derived } = rec.metrics[0];
    expect(markOf(marks, 'user_speech_end')).toBeLessThan(5);
    expect(markOf(marks, 'first_audio_out')).toBeDefined();
    expect(markOf(marks, 'last_audio_out')).toBeDefined();
    expect(derived.timeToFirstAudioMs).toBeGreaterThan(0);
    expect(rec.logs.some((l) => l.includes('no turn open'))).toBe(false);
  });

  it('a second speech-end on a still-pending turn restamps t0 instead of opening another turn', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    speakThenPause(session);
    expect(rec.turnStarts).toEqual([1]);
    expect(rec.turnEnds).toEqual([]);
  });

  it('manual mode: the detector opens nothing, commitAudio opens the turn', async () => {
    const { session, rec } = await open({ turnDetection: 'manual' });
    speakThenPause(session);
    expect(rec.turnStarts).toEqual([]);
    session.commitAudio();
    expect(rec.turnStarts).toEqual([1]);
    // Nova has no commit event: nothing extra goes upstream.
    const n = await clientBarrier(session);
    expect(fake.received.slice(0, n).every((m) => nameOf(m) === 'audioInput' || PREAMBLE.includes(nameOf(m)))).toBe(true);
  });

  it('server-VAD mode: commitAudio is a no-op', async () => {
    const { session, rec } = await open();
    session.commitAudio();
    expect(rec.turnStarts).toEqual([]);
  });

  it('a completion with no turn open opens one and logs that t0 is the completion start', async () => {
    const { rec } = await open();
    push({ completionStart: { completionId: 'c1' } });
    await waitFor(() => rec.turnStarts.length === 1, 'turn');
    expect(rec.logs.some((l) => l.startsWith('warn:') && l.includes('no turn open'))).toBe(true);
  });

  it('a cough (turn with no completion and no audio) is not billed, only logged', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await session.close();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toEqual([]);
    expect(rec.logs.some((l) => l.includes('turn 1 produced no completion and was not billed'))).toBe(true);
  });
});

describe('Nova Sonic — transcripts', () => {
  it('routes USER/ASSISTANT blocks by contentId; SPECULATIVE is a draft the FINAL replaces', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    push({ completionStart: { completionId: 'c1' } });
    push({ contentStart: { completionId: 'c1', contentId: 'u1', type: 'TEXT', role: 'USER', additionalModelFields: stage('FINAL') } });
    push({ contentStart: { completionId: 'c1', contentId: 's1', type: 'TEXT', role: 'ASSISTANT', additionalModelFields: stage('SPECULATIVE') } });
    push({ textOutput: { completionId: 'c1', contentId: 'u1', content: 'what time is it' } });
    push({ textOutput: { completionId: 'c1', contentId: 's1', content: 'It is noon.' } });
    push({ contentEnd: { completionId: 'c1', contentId: 's1', stopReason: 'PARTIAL_TURN' } });
    push({ contentStart: { completionId: 'c1', contentId: 'f1', type: 'TEXT', role: 'ASSISTANT', additionalModelFields: stage('FINAL') } });
    push({ textOutput: { completionId: 'c1', contentId: 'f1', content: 'It is noon.' } });
    push({ contentStart: { completionId: 'c1', contentId: 's2', type: 'TEXT', role: 'ASSISTANT', additionalModelFields: stage('SPECULATIVE') } });
    push({ textOutput: { completionId: 'c1', contentId: 's2', content: 'Anything else?' } });
    await waitFor(() => rec.assistant.length === 3, 'assistant lines');

    expect(rec.user).toEqual([{ text: 'what time is it', final: true, turnId: 1 }]);
    expect(rec.assistant).toEqual([
      { text: 'It is noon.', final: false, turnId: 1 },
      { text: 'It is noon.', final: true, turnId: 1 }, // replaced, not "It is noon. It is noon."
      { text: 'It is noon. Anything else?', final: false, turnId: 1 },
    ]);
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.metrics.length === 1, 'metrics');
    const { marks, derived } = rec.metrics[0];
    expect(markOf(marks, 'stt_first_partial')).toBeDefined();
    expect(markOf(marks, 'stt_final')).toBeDefined();
    expect(derived.sttLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a malformed additionalModelFields is treated as FINAL rather than hiding the text', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    push({ completionStart: { completionId: 'c1' } });
    push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'TEXT', role: 'ASSISTANT', additionalModelFields: '{not json' } });
    push({ textOutput: { completionId: 'c1', contentId: 'b1', content: 'shown' } });
    await waitFor(() => rec.assistant.length === 1, 'line');
    expect(rec.assistant[0]).toEqual({ text: 'shown', final: true, turnId: 1 });
    expect(rec.errors).toEqual([]);
  });

  it('text on a closed or unknown contentId is not re-routed to whichever block is open', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    push({ completionStart: { completionId: 'c1' } });
    push({ contentStart: { completionId: 'c1', contentId: 'u1', type: 'TEXT', role: 'USER', additionalModelFields: stage('FINAL') } });
    push({ contentEnd: { completionId: 'c1', contentId: 'u1' } });
    push({ contentStart: { completionId: 'c1', contentId: 'a1', type: 'TEXT', role: 'ASSISTANT', additionalModelFields: stage('FINAL') } });
    push({ textOutput: { completionId: 'c1', contentId: 'u1', content: 'straggler' } });
    push({ textOutput: { completionId: 'c1', contentId: 'zz', content: 'unknown' } });
    await serverBarrier(rec);
    // An unknown block carries no USER role, so it is published as assistant text; never as the user's words.
    expect(rec.user).toEqual([]);
  });
});

describe('Nova Sonic — barge-in', () => {
  it('interrupt() sends NOTHING upstream, keeps the audio block open, raises onInterrupt once, drops later audio', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    const before = (await clientBarrier(session)) + 1;

    session.interrupt();
    session.interrupt();
    expect(rec.interrupts).toBe(1);
    expect(rec.turnEnds).toEqual([1]);

    const n = await clientBarrier(session);
    // The only thing between the interrupt and the barrier is the barrier itself.
    expect(fake.received.slice(before, n).map(nameOf)).toEqual([]);
    expect(sentOf('contentEnd')).toHaveLength(1); // only the system block's, from the preamble

    push({ audioOutput: { completionId: 'c1', contentId: 'c1-a', content: tone(60).toString('base64') } });
    push(usage('c1', 5, 5, 5, 5));
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage after barge-in');
    expect(rec.audio).toHaveLength(1);
    expect(rec.usage[0].legs[0]).toMatchObject({ source: 'vendor', inputUnits: 10, outputUnits: 10 });

    // The conversation goes on: a new turn can open.
    speakThenPause(session);
    expect(rec.turnStarts).toEqual([1, 2]);
  });

  it('interrupt() on a turn with no audio raises no onInterrupt', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    session.interrupt();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.interrupts).toBe(0);
  });

  it('Nova\'s INTERRUPTED stopReason and the text marker together truncate once, and the marker is never shown', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    push({ contentStart: { completionId: 'c1', contentId: 't1', type: 'TEXT', role: 'ASSISTANT' } });
    push({ textOutput: { completionId: 'c1', contentId: 't1', content: '{"interrupted":true}' } });
    push({ textOutput: { completionId: 'c1', contentId: 't1', content: '{ "interrupted" : true }' } });
    push({ contentEnd: { completionId: 'c1', contentId: 't1', stopReason: 'INTERRUPTED' } });
    await serverBarrier(rec);
    expect(rec.interrupts).toBe(1);
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.assistant.some((a) => a.text.includes('interrupted'))).toBe(false);
    expect(rec.user.some((u) => u.text.includes('interrupted'))).toBe(false);
  });

  it('a lowercase stopReason "interrupted" still counts', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    push({ contentEnd: { completionId: 'c1', contentId: 'c1-a', stopReason: 'interrupted' } });
    await waitFor(() => rec.interrupts === 1, 'interrupt');
  });

  it('the local detector hearing the user over a RUNNING turn is a barge-in too', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    speakThenPause(session);
    expect(rec.interrupts).toBe(1);
    expect(rec.turnStarts).toEqual([1, 2]);
    // ...and Nova's own marker arriving afterwards for c1 does not truncate again.
    push({ contentEnd: { completionId: 'c1', contentId: 'c1-a', stopReason: 'INTERRUPTED' } });
    await serverBarrier(rec);
    expect(rec.interrupts).toBe(1);
    expect(rec.turnEnds).toEqual([1]);
  });
});

describe('Nova Sonic — usage', () => {
  it('sums the incremental deltas (never the cumulative totals) into one realtime row', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1', tone(250));
    push(usage('c1', 30, 12, 60, 20));
    push(usage('c1', 10, 3, 40, 5));
    push({ usageEvent: { completionId: 'c1', details: {} } }); // no delta: ignored
    push({ usageEvent: { completionId: 'c1', details: { delta: { input: { speechTokens: 'x' }, output: { textTokens: NaN } } } } });
    push({ completionEnd: { completionId: 'c1' } });
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    await serverBarrier(rec);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0]).toEqual({
      turnId: 1,
      legs: [
        {
          leg: 'realtime',
          providerId: 'aws-nova-sonic',
          modelId: 'amazon.nova-2-sonic-v1:0',
          unit: 'tokens',
          inputUnits: 55,
          outputUnits: 125,
          audioInputTokens: 40,
          audioOutputTokens: 100,
          audioSeconds: 0.25,
          source: 'vendor',
        },
      ],
    });
  });

  it('a turn that ran without any usage event is billed once as unpriced/local, inventing nothing', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.usage[0].legs[0]).toMatchObject({ source: 'local', inputUnits: 0, outputUnits: 0 });
    expect(rec.usage[0].legs[0].unpricedReason).toBe('Nova Sonic reported no usage for this turn');
  });

  it('a late usage event for a retired completion is not billed to the next turn', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    push(usage('c1', 1, 1, 1, 1));
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'turn 1 usage');
    speakThenPause(session);
    push(usage('c1', 500, 500, 500, 500)); // straggler
    push({ audioOutput: { completionId: 'c1', content: tone(20).toString('base64') } }); // straggler
    await serverBarrier(rec);
    await answer(rec, 'c2');
    push(usage('c2', 2, 2, 2, 2));
    push({ completionEnd: { completionId: 'c2' } });
    await waitFor(() => rec.usage.length === 2, 'turn 2 usage');
    expect(rec.usage[1]).toMatchObject({ turnId: 2, legs: [{ inputUnits: 4, outputUnits: 4 }] });
  });
});

describe('Nova Sonic — typed text', () => {
  it('sendText opens a USER TEXT block (interactive) with its own contentName, and a final user line', async () => {
    const { session, rec } = await open();
    const audioBlock = sentOf('contentStart')[1].contentName;
    session.sendText('hello there');
    await waitFor(() => sentOf('contentStart').length === 3, 'text block');
    const start = sentOf('contentStart')[2];
    expect(start).toMatchObject({ type: 'TEXT', interactive: true, role: 'USER', textInputConfiguration: { mediaType: 'text/plain' } });
    expect(start.contentName).not.toBe(audioBlock);
    await waitFor(() => sentOf('contentEnd').length === 2, 'text block end');
    expect(order().slice(-3)).toEqual(['contentStart', 'textInput', 'contentEnd']);
    expect(sentOf('textInput')[1]).toMatchObject({ contentName: start.contentName, content: 'hello there' });
    expect(sentOf('contentEnd')[1].contentName).toBe(start.contentName);
    expect(rec.user).toEqual([{ text: 'hello there', final: true, turnId: 1 }]);
  });

  it('whitespace-only text sends nothing', async () => {
    const { session, rec } = await open();
    session.sendText(' \n ');
    const n = await clientBarrier(session);
    expect(fake.received.slice(0, n).map(nameOf)).toEqual(PREAMBLE);
    expect(rec.turnStarts).toEqual([]);
  });
});

describe('Nova Sonic — teardown and stream loss', () => {
  it('close() sends contentEnd(audio) -> promptEnd -> sessionEnd, bills, closes the socket; a second close is a no-op', async () => {
    const { session, rec } = await open();
    const audioBlock = sentOf('contentStart')[1].contentName;
    const promptName = sentOf('promptStart')[0].promptName;
    speakThenPause(session);
    await answer(rec, 'c1');
    push(usage('c1', 3, 3, 3, 3));
    await serverBarrier(rec);

    await session.close();
    await waitFor(() => order().at(-1) === 'sessionEnd', 'teardown');
    expect(order().slice(-3)).toEqual(['contentEnd', 'promptEnd', 'sessionEnd']);
    expect(sentOf('contentEnd').at(-1)).toEqual({ promptName, contentName: audioBlock });
    expect(sentOf('promptEnd')[0]).toEqual({ promptName });
    expect(sentOf('sessionEnd')[0]).toEqual({});
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0]).toMatchObject({ source: 'vendor', inputUnits: 6 });
    await waitFor(() => fake.closedSockets === 1, 'socket closed');

    const count = fake.received.length;
    await session.close();
    session.pushAudio(tone(20));
    session.sendText('after');
    session.interrupt();
    session.commitAudio();
    await flushIo();
    expect(fake.received.length).toBe(count);
    expect(rec.usage).toHaveLength(1);
    expect(rec.errors).toEqual([]);
  });

  it('events arriving after close() are ignored', async () => {
    const { session, rec } = await open();
    await session.close();
    push({ completionStart: { completionId: 'late' } });
    await flushIo();
    expect(rec.turnStarts).toEqual([]);
  });

  it('the stream dying mid-turn reports it, ends + bills the turn as unpriced, and stops feeding the transport', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    await answer(rec, 'c1');
    fake.socket().close(1011, 'gone');
    await waitFor(() => rec.errors.length === 1, 'error');
    expect(rec.errors[0].message).toBe('Nova Sonic stream closed unexpectedly');
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0].unpricedReason).toBe('stream closed before the vendor reported usage');

    session.pushAudio(tone(20));
    session.sendText('anyone?');
    await session.close();
    expect(rec.usage).toHaveLength(1);
    expect(rec.errors).toHaveLength(1);
  });

  it('a non-JSON frame or a frame with no `event` key is ignored', async () => {
    const { session, rec } = await open();
    speakThenPause(session);
    fake.pushRaw('{{{ nope');
    fake.pushRaw(JSON.stringify({ notAnEvent: true }));
    await answer(rec, 'c1');
    push({ completionEnd: { completionId: 'c1' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.errors).toEqual([]);
  });

  it('an unserved toolUse is logged with the tool name, not ignored', async () => {
    const { rec } = await open();
    push({ toolUse: { toolName: 'getWeather', toolUseId: 't1' } });
    await waitFor(() => rec.logs.length === 1, 'log');
    expect(rec.logs[0]).toContain('getWeather');
  });
});

describe('EventQueue — the request body that must never end while the conversation lives', () => {
  it('yields queued events in order, parks when empty instead of returning, and ends only after close()', async () => {
    const q = new EventQueue();
    q.push({ a: 1 });
    q.push({ b: 2 });
    const it = q.stream()[Symbol.asyncIterator]();
    const decode = (r: IteratorResult<{ chunk?: { bytes?: Uint8Array } }>) =>
      JSON.parse(new TextDecoder().decode(r.value?.chunk?.bytes));
    expect(decode(await it.next())).toEqual({ a: 1 });
    expect(decode(await it.next())).toEqual({ b: 2 });

    let settled = false;
    const pending = it.next().then((r) => {
      settled = true;
      return r;
    });
    await flushIo();
    expect(settled).toBe(false); // parked, NOT done

    q.push({ c: 3 });
    expect(decode(await pending)).toEqual({ c: 3 });

    let drained = false;
    void q.whenDrained.then(() => (drained = true));
    q.push({ d: 4 });
    q.close();
    q.push({ dropped: true });
    expect(decode(await it.next())).toEqual({ d: 4 });
    await flushIo();
    expect(drained).toBe(false); // not until the iterator reaches its exit
    expect((await it.next()).done).toBe(true);
    await flushIo();
    expect(drained).toBe(true);
  });

  it('close() wakes a parked consumer so it can exit', async () => {
    const q = new EventQueue();
    const it = q.stream()[Symbol.asyncIterator]();
    const pending = it.next();
    await flushIo();
    q.close();
    expect((await pending).done).toBe(true);
    await q.whenDrained;
  });
});
